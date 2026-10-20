"""Atlas sync orchestration: registry -> cities -> Job Bank months -> release (spec §10).

Only successful, explainable data enters a new release. A failed month never empties
anything: its coverage stays as it was (or `missing`), the previous release stays published.
The first import of a source (or a backfill) is published with change_kind="coverage", which
the client shows as "data updated", never as "new postings".
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.atlas import jobbank, overview
from app.atlas.cities import CityIndex, load_places, parse_geonames
from app.atlas.metrics import REAL_DATASET, build_release, current_release, publish
from app.atlas.models import AtlasCity, AtlasCoverage
from app.atlas.permissions import admitted, source, sync_registry
from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)
GEONAMES_URL = "https://download.geonames.org/export/dump/CA.zip"


def load_geonames(session: Session, path: Path | None = None) -> int:
    if path is None:
        with httpx.Client(timeout=120, headers={"User-Agent": get_settings().atlas_user_agent},
                          trust_env=False) as client:  # fmt: skip
            resp = client.get(GEONAMES_URL)
            resp.raise_for_status()
            data = resp.content
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            text = z.read("CA.txt").decode("utf-8")
    else:
        text = path.read_text(encoding="utf-8")
    n = load_places(session, parse_geonames(text.splitlines()))
    session.commit()
    return n


@dataclass
class SyncReport:
    months_listed: int = 0
    imported: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    release_id: str | None = None
    skipped_reason: str | None = None


def sync_jobbank(
    session: Session,
    *,
    since: date | None = None,
    max_months: int | None = None,
    publish_release: bool = True,
) -> SyncReport:
    report = SyncReport()
    sync_registry(session)
    session.commit()
    ok, why = admitted(source(session, jobbank.SOURCE_KEY))
    if not ok:
        report.skipped_reason = f"source not admitted: {why}"
        return report
    if not session.scalar(select(func.count()).select_from(AtlasCity)):
        report.skipped_reason = "city catalogue empty: run `jobatlas atlas-cities` first"
        return report
    first_import = not session.scalar(
        select(func.count())
        .select_from(AtlasCoverage)
        .where(AtlasCoverage.source_key == jobbank.SOURCE_KEY, AtlasCoverage.status == "complete")
    )
    months = jobbank.list_months()
    report.months_listed = len(months)
    todo = jobbank.months_to_import(session, months)
    if since is not None:
        todo = [m for m in todo if m.period_start >= since]
    todo.sort(key=lambda m: m.period_start, reverse=True)  # newest first
    if max_months is not None:
        todo = todo[:max_months]
    cities = CityIndex.build(session)
    changed: list[tuple[date, date]] = []
    for m in todo:
        label = m.period_start.strftime("%Y-%m")
        path = None
        try:
            path, checksum = jobbank.download(m.url)
            r = jobbank.import_file(session, path, m, checksum, cities)
            report.imported.append(f"{label}: {r.rows} rows ({r.removed} removed)")
            changed.append((m.period_start, jobbank.period_end(m.period_start)))
        except Exception as exc:  # noqa: BLE001 - one month must not stop the others
            session.rollback()
            jobbank.record_missing(session, m, f"{type(exc).__name__}: {exc}")
            report.failed.append(f"{label}: {type(exc).__name__}: {exc}"[:200])
            log.warning("atlas_month_failed", month=label, error=str(exc)[:200])
        finally:
            if path is not None:
                path.unlink(missing_ok=True)
    if publish_release and (report.imported or current_release(session, REAL_DATASET) is None):
        release = build_release(
            session, REAL_DATASET, [jobbank.SOURCE_KEY],
            change_kind="coverage" if first_import or len(report.imported) > 1 else "update",
            changed=None if first_import else changed,
        )  # fmt: skip
        overview.prepare(session, release)
        publish(session, release)
        report.release_id = release.id
    return report


def rematch_cities(session: Session) -> dict:
    """Re-apply city matching to stored postings after a rule change (no download): match the
    distinct (province, city) pairs in Python, then one set-based UPDATE through a temp table."""
    from sqlalchemy import text

    index = CityIndex.build(session)
    pairs = session.execute(
        text("SELECT DISTINCT province, city_raw FROM atlas_postings WHERE source_key = :s"),
        {"s": jobbank.SOURCE_KEY},
    ).all()
    session.execute(text(
        "CREATE TEMP TABLE atlas_city_map (province text, city_raw text, city_id text) "
        "ON COMMIT DROP"
    ))  # fmt: skip
    rows = [{"p": p, "c": c, "id": index.match(p, c)[0]} for p, c in pairs]
    for i in range(0, len(rows), 5000):
        session.execute(text("INSERT INTO atlas_city_map VALUES (:p, :c, :id)"), rows[i : i + 5000])
    changed = session.execute(text(
        "UPDATE atlas_postings p SET city_id = m.city_id, geo_status = CASE "
        "WHEN m.city_id IS NOT NULL THEN 'city' "
        "WHEN lower(coalesce(p.telework, '')) IN ('yes', 'oui', '1') THEN 'remote' "
        "ELSE 'unconfirmed' END "
        "FROM atlas_city_map m WHERE p.source_key = :s "
        # plain equality on coalesced keys lets PostgreSQL hash-join the map
        "AND coalesce(p.province, '') = coalesce(m.province, '') "
        "AND coalesce(p.city_raw, '') = coalesce(m.city_raw, '') "
        "AND p.city_id IS DISTINCT FROM m.city_id"
    ), {"s": jobbank.SOURCE_KEY}).rowcount  # fmt: skip
    session.commit()
    return {"pairs": len(pairs), "postings_changed": changed}
