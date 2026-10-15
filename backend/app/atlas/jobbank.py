"""Job Bank open data importer (source key "jobbank-open-data"; docs/data-source-decision.md).

Each monthly English CSV (UTF-16, tab separated) holds the postings first published on Job
Bank in that month. Import is idempotent: rows are keyed by (source, WIC snapshot id); a
re-imported month updates its rows and its coverage record, never duplicates them. A month
counts as `complete` only after the whole file parsed; failures leave it `missing` and the
previous release stays published.

Downloads go only to the fixed official hosts below (not user input), with a size cap.
"""

from __future__ import annotations

import csv
import hashlib
import re
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import httpx
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.atlas.cities import CityIndex, province_code
from app.atlas.models import AtlasCoverage, AtlasPosting
from app.atlas.occupations import CLASSIFICATION_VERSION, classify
from app.atlas.permissions import admitted, source
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.timeutil import utcnow

log = get_logger(__name__)

SOURCE_KEY = "jobbank-open-data"
DATASET = "ea639e28-c0fc-48bf-b5dd-b8899bd43072"
CKAN = f"https://open.canada.ca/data/api/action/package_show?id={DATASET}"
# open.canada.ca serves resource files from its Azure blob storage.
ALLOWED_HOSTS = {"open.canada.ca", "opencanada.blob.core.windows.net"}
MAX_BYTES = 250 * 1024 * 1024
MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september",
     "october", "november", "december"], start=1)}  # fmt: skip
BATCH = 2000  # 19 columns per row: stays under PostgreSQL's 65,535 bind parameters
POSTED_BASIS = "Job Bank 'First Posting Date' (first published on Job Bank; date only)"


class JobBankError(Exception):
    pass


@dataclass(frozen=True)
class MonthResource:
    period_start: date
    resource_id: str
    url: str
    modified: str


def period_end(start: date) -> date:
    nxt = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    return date.fromordinal(nxt.toordinal() - 1)


def _client() -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(60.0, read=120.0),
        headers={"User-Agent": get_settings().atlas_user_agent},
        follow_redirects=False,
        trust_env=False,
    )


def _check_host(url: str) -> None:
    host = httpx.URL(url).host
    if host not in ALLOWED_HOSTS:
        raise JobBankError(f"unexpected host {host}")


def list_months(client: httpx.Client | None = None) -> list[MonthResource]:
    own = client is None
    client = client or _client()
    try:
        resp = client.get(CKAN)
        resp.raise_for_status()
        result = resp.json()["result"]
    finally:
        if own:
            client.close()
    out = []
    for r in result["resources"]:
        lang = r.get("language")
        if not (lang == ["en"] or lang == "en" or "-en-" in r.get("url", "")):
            continue
        m = re.match(r"\s*([A-Za-z]+)\s+(\d{4})\b", r.get("name") or "")
        if not m or m.group(1).lower() not in MONTHS:
            continue
        start = date(int(m.group(2)), MONTHS[m.group(1).lower()], 1)
        modified = r.get("last_modified") or r.get("created") or ""
        out.append(MonthResource(start, r["id"], r["url"], modified))
    return sorted(out, key=lambda x: x.period_start)


def download(url: str, client: httpx.Client | None = None) -> tuple[Path, str]:
    """Stream to a temp file (redirects followed only within the allowed hosts)."""
    _check_host(url)
    own = client is None
    client = client or _client()
    digest = hashlib.sha256()
    tmp = tempfile.NamedTemporaryFile(prefix="jobbank-", suffix=".csv", delete=False)
    try:
        for _ in range(5):
            with client.stream("GET", url) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    url = str(resp.url.join(resp.headers["location"]))
                    _check_host(url)
                    continue
                resp.raise_for_status()
                size = 0
                for chunk in resp.iter_bytes(1 << 16):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise JobBankError("file larger than the cap")
                    digest.update(chunk)
                    tmp.write(chunk)
                break
        else:
            raise JobBankError("too many redirects")
    finally:
        tmp.close()
        if own:
            client.close()
    return Path(tmp.name), digest.hexdigest()


def _encoding(path: Path) -> str:
    """Most months are UTF-16 with a BOM; mid-2024 months are UTF-8 (or cp1252) CSV."""
    head = path.open("rb").read(4)
    if head[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return "utf-16"
    if head[:3] == b"\xef\xbb\xbf":
        return "utf-8-sig"
    try:
        with path.open(encoding="utf-8") as fh:
            for _ in fh:
                pass
        return "utf-8"
    except UnicodeDecodeError:
        return "cp1252"


def read_rows(path: Path) -> Iterator[dict[str, str]]:
    enc = _encoding(path)
    with open(path, encoding=enc, newline="") as fh:
        header = fh.readline()
        delimiter = "\t" if header.count("\t") > header.count(",") else ","
        fh.seek(0)
        yield from csv.DictReader(fh, delimiter=delimiter)


ID_COLUMN = "WIC Job Location Snapshot ID"
FINGERPRINT_COLUMNS = ("Job Title", "Original Job Title", "NOC21 Code", "First Posting Date",
                       "Province/Territory", "City", "Work Location Postal Code",
                       "External Indicator", "Vacancy Count", "Salary Minimum", "Salary Maximum",
                       "Employment Type", "Hours Minimum", "Hours Maximum")  # fmt: skip


def record_ids(rows: Iterator[dict[str, str]]) -> Iterator[tuple[str, dict[str, str], bool]]:
    """(external_id, row, repeated). Months with the publisher's snapshot id use it (a repeated
    id is the same record twice). Months published without ids use a content fingerprint plus
    its occurrence number in the file: re-importing the same file gives the same keys, and two
    identical advertisements still count as two, as published."""
    seen: dict[str, int] = {}
    for row in rows:
        ext = (row.get(ID_COLUMN) or "").strip()
        if ext:
            n = seen.get(ext, 0)
            seen[ext] = n + 1
            yield ext, row, n > 0
            continue
        fp = hashlib.sha1(
            "\x1f".join((row.get(c) or "").strip().lower() for c in FINGERPRINT_COLUMNS).encode(),
            usedforsecurity=False,
        ).hexdigest()[:20]
        n = seen.get(fp, 0)
        seen[fp] = n + 1
        yield f"fp:{fp}:{n}", row, False


def _date(value: str | None) -> date | None:
    m = re.fullmatch(r"(\d{4})[/-](\d{2})[/-](\d{2})", (value or "").strip())
    return date(int(m[1]), int(m[2]), int(m[3])) if m else None


def _na(value: str | None) -> str | None:
    v = (value or "").strip()
    return None if not v or v.upper() in ("NA", "N/A", "*NO DATA") else v


def to_posting(
    row: dict[str, str], cities: CityIndex, resource_id: str, now: datetime, external_id: str
) -> dict:
    title = _na(row.get("Original Job Title")) or _na(row.get("Job Title"))
    noc = _na(row.get("NOC21 Code"))
    occupation, evidence = classify(noc, title)
    prov = province_code(_na(row.get("Province/Territory")))
    city_raw = _na(row.get("City"))
    city_id, _why = cities.match(prov, city_raw)
    telework = _na(row.get("Employment Term Telework"))
    if city_id:
        geo = "city"
    elif telework and telework.lower() in ("yes", "oui", "1"):
        geo = "remote"
    else:
        geo = "unconfirmed"
    postal = (_na(row.get("Work Location Postal Code")) or "").replace(" ", "").upper()
    return {
        "source_key": SOURCE_KEY,
        "external_id": external_id,
        "title": title[:300] if title else None,
        "noc21": noc[:8] if noc else None,
        "posted_on": _date(row.get("First Posting Date")),
        "posted_basis": POSTED_BASIS,
        "province": prov,
        "city_raw": city_raw[:120] if city_raw else None,
        "postal_fsa": postal[:3] if re.match(r"[A-Z]\d[A-Z]", postal) else None,
        "telework": telework[:8] if telework else None,
        "external": {"1": True, "0": False}.get((row.get("External Indicator") or "").strip()),
        "city_id": city_id,
        "geo_status": geo,
        "occupation_id": occupation,
        "classification_version": CLASSIFICATION_VERSION,
        "classification_evidence": evidence[:300],
        "resource_id": resource_id,
        "observed_at": now,
    }


@dataclass
class MonthResult:
    period_start: date
    rows: int = 0
    skipped: int = 0
    removed: int = 0
    status: str = "missing"
    note: str = ""


UPDATABLE = ("title", "noc21", "posted_on", "province", "city_raw", "postal_fsa", "telework",
             "external", "city_id", "geo_status", "occupation_id", "classification_version",
             "classification_evidence", "resource_id")  # fmt: skip


def import_file(
    session: Session, path: Path, month: MonthResource, checksum: str, cities: CityIndex
) -> MonthResult:
    ok, why = admitted(source(session, SOURCE_KEY))
    if not ok:
        raise JobBankError(f"source not admitted: {why}")
    result = MonthResult(month.period_start)
    now = utcnow()
    batch: list[dict] = []
    seen: set[str] = set()

    def flush() -> None:
        if not batch:
            return
        stmt = insert(AtlasPosting).values(batch)
        session.execute(stmt.on_conflict_do_update(
            constraint="uq_atlas_postings_source_ext",
            set_={k: getattr(stmt.excluded, k) for k in UPDATABLE},
        ))  # fmt: skip
        batch.clear()

    for ext, row, repeated in record_ids(read_rows(path)):
        if repeated:
            result.skipped += 1  # the same snapshot id twice in one file counts once
            continue
        seen.add(ext)
        batch.append(to_posting(row, cities, month.resource_id, now, ext))
        result.rows += 1
        if len(batch) >= BATCH:
            flush()
    flush()
    # The publisher's current file is the truth for that month: rows it no longer contains
    # (corrections, removals) leave the dataset; the next release reflects it.
    result.removed = session.execute(
        text(
            "DELETE FROM atlas_postings WHERE source_key = :s AND resource_id = :r "
            "AND NOT (external_id = ANY(:ids))"
        ),
        {"s": SOURCE_KEY, "r": month.resource_id, "ids": list(seen)},
    ).rowcount
    result.status = "complete"
    session.execute(
        insert(AtlasCoverage)
        .values(source_key=SOURCE_KEY, period_start=month.period_start,
                period_end=period_end(month.period_start), status="complete",
                resource_id=month.resource_id, resource_modified=month.modified,
                rows=result.rows, checksum=checksum, note=None, imported_at=now)
        .on_conflict_do_update(constraint="uq_atlas_coverage_period",
                               set_={"status": "complete", "resource_id": month.resource_id,
                                     "resource_modified": month.modified, "rows": result.rows,
                                     "checksum": checksum, "imported_at": now,
                                     "note": None})
    )  # fmt: skip
    session.commit()
    return result


def record_missing(session: Session, month: MonthResource, note: str) -> None:
    existing = session.scalar(
        select(AtlasCoverage).where(
            AtlasCoverage.source_key == SOURCE_KEY, AtlasCoverage.period_start == month.period_start
        )
    )
    if existing is not None and existing.status == "complete":
        existing.note = f"last refresh failed: {note}"[:300]  # keep the good data
    elif existing is not None:
        existing.note = note[:300]
    else:
        session.add(
            AtlasCoverage(
                source_key=SOURCE_KEY,
                period_start=month.period_start,
                period_end=period_end(month.period_start),
                status="missing",
                resource_id=month.resource_id,
                rows=0,
                note=note[:300],
            )  # fmt: skip
        )
    session.commit()


def months_to_import(session: Session, months: list[MonthResource]) -> list[MonthResource]:
    rows = session.scalars(select(AtlasCoverage).where(AtlasCoverage.source_key == SOURCE_KEY))
    have = {c.period_start: c for c in rows}
    todo = []
    for m in months:
        c = have.get(m.period_start)
        changed = bool(m.modified) and c is not None and c.resource_modified != m.modified
        if c is None or c.status != "complete" or changed:
            todo.append(m)
    return todo
