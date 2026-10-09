"""Controlled schema.org JobPosting (JSON-LD) adapter for official employer pages.

"Controlled" means:
- a jsonld source is one official careers page URL registered explicitly (CLI) or found on an
  already-verified company domain; it is never inferred from arbitrary search results;
- every fetch must pass robots.txt, stays on the page's own host, and is capped
  (JSONLD_MAX_JOB_PAGES) — no general crawling;
- listings are NEVER complete: a generic page cannot prove it shows every job, so absence is
  never used for closure (DEVELOPMENT.md §6.1). Closure only from the posting's own
  `validThrough` in the past or HTTP 410 on the job URL.

Field mapping (schema.org/JobPosting):
    url / identifier       -> external_id (url preferred; identifier.value as fallback)
    title, description     -> title, description_text (HTML -> text)
    hiringOrganization     -> company_name
    datePosted             -> posted_at (datetime with offset) or posted_date (date only,
                              zone unknown -> never matches "Today")
    validThrough           -> valid_through
    jobLocationType        -> TELECOMMUTE -> remote; anything else stays unknown
    jobLocation.address    -> structured addresses (street present -> work-site candidate)
    applicantLocationRequirements -> eligibility_texts
    baseSalary             -> salary (explicit numbers + unit only)
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

from app.core.config import get_settings
from app.core.timeutil import parse_iso_datetime, utcnow
from app.net.robots import RobotsCache
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.providers.base import (
    BoardInfo,
    FetchPage,
    NormalizedJob,
    ProviderError,
    SourceCandidate,
    SourceRef,
    StructuredAddress,
    VerifyResult,
)
from app.providers.text import html_to_text
from app.services.addresses import FULL_ADDRESS_RE

UNITS = {"YEAR": "year", "MONTH": "month", "WEEK": "week", "DAY": "day", "HOUR": "hour"}
JOB_LINK_RE = re.compile(r"/(jobs?|careers?|positions?|openings?|vacanc(y|ies)|postings?)/", re.I)


class _ScriptAndLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.scripts: list[str] = []
        self.links: list[str] = []
        self._in_ld = False
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and (a.get("type") or "").lower() == "application/ld+json":
            self._in_ld, self._buf = True, []
        elif tag == "a" and a.get("href"):
            self.links.append(a["href"])

    def handle_endtag(self, tag):
        if tag == "script" and self._in_ld:
            self.scripts.append("".join(self._buf))
            self._in_ld = False

    def handle_data(self, data):
        if self._in_ld:
            self._buf.append(data)


def parse_html(html: str) -> tuple[list[dict], list[str]]:
    """All JSON-LD objects (flattened from lists and @graph) and raw link hrefs."""
    parser = _ScriptAndLinks()
    parser.feed(html)
    parser.close()
    objects: list[dict] = []
    for raw in parser.scripts:
        try:
            data = json.loads(raw.strip())
        except ValueError:
            continue
        objects.extend(_flatten(data))
    return objects, parser.links


def _flatten(data: Any) -> Iterator[dict]:
    if isinstance(data, list):
        for item in data:
            yield from _flatten(item)
    elif isinstance(data, dict):
        if "@graph" in data:
            yield from _flatten(data["@graph"])
        yield data


def _types(obj: dict) -> set[str]:
    t = obj.get("@type")
    return {t} if isinstance(t, str) else {x for x in t or [] if isinstance(x, str)}


def job_postings(objects: list[dict]) -> list[dict]:
    return [o for o in objects if "JobPosting" in _types(o)]


def _canonical(url: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or "/", p.query, ""))


class JsonLdProvider:
    name = "jsonld"
    supports_fetch = True
    verify_by_url = True  # external ids are job URLs already

    def recognize(self, url: str) -> SourceCandidate | None:
        # Never auto-recognized from discovery URLs; registered explicitly (see module doc).
        return None

    def candidate_for(self, page_url: str) -> SourceCandidate:
        c = _canonical(page_url)
        return SourceCandidate(self.name, c, c)

    def _get(
        self, client: SafeHttpClient, url: str, accept: str = "text/html,application/xhtml+xml"
    ):
        if not RobotsCache(client).allowed(url):
            raise ProviderError(f"robots.txt disallows {url}", error_class="robots")
        try:
            return client.get(url, headers={"Accept": accept})
        except UnsafeURLError as exc:
            raise ProviderError(str(exc), error_class="unsafe_url") from exc

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        resp = self._get(client, source.tenant_key)
        if resp.status_code != 200:
            return BoardInfo(exists=False, http_status=resp.status_code)
        objects, _ = parse_html(resp.text)
        posts = job_postings(objects)
        org = next(
            (
                (p.get("hiringOrganization") or {}).get("name")
                for p in posts
                if isinstance(p.get("hiringOrganization"), dict)
            ),
            None,
        )
        return BoardInfo(exists=True, company_name=org, http_status=200, evidence_url=resp.url)

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        page_url = source.tenant_key
        resp = self._get(client, page_url)
        if resp.status_code != 200:
            raise ProviderError(
                f"page {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        objects, links = parse_html(resp.text)
        records = [{**p, "_page_url": resp.url} for p in job_postings(objects)]
        host = urlsplit(resp.url).netloc.lower()
        seen = {_canonical(resp.url)}
        follow: list[str] = []
        for href in links:
            absolute = urljoin(resp.url, href)
            parts = urlsplit(absolute)
            if parts.scheme not in ("http", "https") or parts.netloc.lower() != host:
                continue
            canon = _canonical(absolute)
            if canon in seen or not JOB_LINK_RE.search(parts.path):
                continue
            seen.add(canon)
            follow.append(absolute)
        for url in follow[: get_settings().jsonld_max_job_pages]:
            try:
                job_resp = self._get(client, url)
            except (ProviderError, FetchError):
                continue
            if job_resp.status_code != 200:
                continue
            objs, _ = parse_html(job_resp.text)
            records.extend({**p, "_page_url": job_resp.url} for p in job_postings(objs))
        # Never complete: absence from a generic page proves nothing.
        return FetchPage(records, None, is_complete=False, pages_expected=None, http_status=200)

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        page = raw.get("_page_url")
        url = raw.get("url") if isinstance(raw.get("url"), str) else None
        url = urljoin(page, url) if (url and page) else (url or page)
        ident = raw.get("identifier")
        ident_value = ident.get("value") if isinstance(ident, dict) else ident
        if not url and not ident_value:
            raise ValueError("JobPosting without url or identifier")
        if url:
            external_id = _canonical(url)
        else:
            external_id = "id:" + hashlib.sha256(str(ident_value).encode()).hexdigest()[:32]

        posted_at, posted_date, precision, tz_basis = _date_posted(raw.get("datePosted"))
        org = raw.get("hiringOrganization")
        addresses = [a for a in _addresses(raw.get("jobLocation")) if a is not None]
        location_text = None
        if addresses:
            first = addresses[0]
            location_text = ", ".join(p for p in (first.city, first.region, first.country) if p)
        remote = str(raw.get("jobLocationType") or "").upper() == "TELECOMMUTE"
        apply = url if url and url.startswith(("https://", "http://")) else None
        return NormalizedJob(
            external_id=external_id,
            title=(str(raw.get("title") or "")).strip() or None,
            company_name=(org.get("name") if isinstance(org, dict) else org) or None,
            apply_url=apply,
            canonical_url=url,
            description_text=html_to_text(raw.get("description")),
            location_text=location_text,
            workplace_type="remote" if remote else "unknown",
            workplace_evidence="jsonld jobLocationType=TELECOMMUTE" if remote else None,
            posted_at=posted_at,
            posted_date=posted_date,
            posted_precision=precision,  # type: ignore[arg-type]
            posted_basis="original" if precision != "none" else "unknown",
            posted_tz_basis=tz_basis,
            requisition_id=str(ident_value) if ident_value else None,
            employment_type=_employment(raw.get("employmentType")),
            structured_addresses=addresses,
            eligibility_texts=_applicant_locations(raw.get("applicantLocationRequirements")),
            valid_through=parse_iso_datetime(raw.get("validThrough"))
            or _date_end(raw.get("validThrough")),
            **_salary(raw.get("baseSalary")),
        )

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult:
        if external_id.startswith("id:"):
            return VerifyResult("unknown", "no job url to re-check")
        try:
            resp = self._get(client, external_id)
        except (ProviderError, FetchError) as exc:
            return VerifyResult("unknown", f"fetch failed: {exc}")
        if resp.status_code == 410:
            return VerifyResult("closed", "job page returned 410 Gone", 410)
        if resp.status_code != 200:
            return VerifyResult("unknown", f"status {resp.status_code}", resp.status_code)
        posts = job_postings(parse_html(resp.text)[0])
        if not posts:
            return VerifyResult("unknown", "no JobPosting on page", 200)
        n = self.normalize({**posts[0], "_page_url": resp.url})
        if n.valid_through is not None and n.valid_through < utcnow():
            return VerifyResult("closed", f"validThrough {n.valid_through.isoformat()} passed", 200)
        return VerifyResult("active", "JobPosting present and not expired", 200)


def _date_posted(value: Any):
    if not isinstance(value, str) or not value.strip():
        return None, None, "none", None
    value = value.strip()
    dt = parse_iso_datetime(value)
    if dt is not None:
        return dt, None, "datetime", "source offset"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", value)
    if m:
        try:
            d = date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None, None, "none", None
        return None, d, "date", "date only; publisher time zone unknown"
    return None, None, "none", None


def _date_end(value: Any):
    if not isinstance(value, str):
        return None
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", value.strip())
    if not m:
        return None
    # A date-only validThrough is treated as over only once that date has ended everywhere
    # (UTC-12), so we never close a job early.
    try:
        return datetime(int(m[1]), int(m[2]), int(m[3]), tzinfo=UTC) + timedelta(days=1, hours=12)
    except ValueError:
        return None


def _text(v: Any) -> str | None:
    if isinstance(v, dict):
        v = v.get("name")
    return str(v).strip() or None if v else None


def _addresses(job_location: Any) -> Iterator[StructuredAddress | None]:
    places = job_location if isinstance(job_location, list) else [job_location]
    for place in places:
        if not isinstance(place, dict):
            continue
        addr = place.get("address")
        if isinstance(addr, str):
            yield StructuredAddress(
                addr.strip(), None, None, None, None, None, "jsonld_address_text"
            )
            continue
        if not isinstance(addr, dict):
            continue
        street, city = _text(addr.get("streetAddress")), _text(addr.get("addressLocality"))
        if not street and city:
            # Some platforms (Workday) put the whole site into addressLocality:
            # "TD Centre - TD Tower - 66 Wellington Street West, Toronto, Ontario".
            m = FULL_ADDRESS_RE.search(city)
            if m:
                street = m.group("street").strip(" ,")
                tail = city[m.end("street") :].strip(" ,")
                city = tail.split(",")[0].strip() or None
        if not street and not city:
            continue
        yield StructuredAddress(
            street=street,
            city=city,
            region=_text(addr.get("addressRegion")),
            postal_code=_text(addr.get("postalCode")),
            country=_text(addr.get("addressCountry")),
            label=_text(place.get("name")),
            method="jsonld_postal_address",
        )


def _applicant_locations(value: Any) -> list[str]:
    items = value if isinstance(value, list) else [value]
    return [t for t in (_text(i) for i in items) if t]


def _employment(value: Any) -> str | None:
    if isinstance(value, list):
        return ", ".join(str(v) for v in value) or None
    return str(value) if value else None


def _salary(base: Any) -> dict:
    if not isinstance(base, dict):
        return {}
    currency = base.get("currency")
    value = base.get("value")
    if not isinstance(value, dict) or not currency:
        return {}
    unit = UNITS.get(str(value.get("unitText") or "").upper())
    if unit is None:
        return {}

    def num(v):
        try:
            return Decimal(str(v)) if v is not None else None
        except InvalidOperation:
            return None

    lo = num(value.get("minValue")) or num(value.get("value"))
    hi = num(value.get("maxValue")) or num(value.get("value"))
    if lo is None and hi is None:
        return {}
    return {
        "salary_min": lo,
        "salary_max": hi,
        "salary_currency": str(currency)[:3],
        "salary_period": unit,
    }
