"""SAP SuccessFactors Career Site Builder (CSB) adapter.

Used by many large employers (City of Toronto, hospitals, banks, retailers). Public job pages
are server-rendered with schema.org microdata and usually state the work location in the
posting body ("Work Location: Metro Hall, 55 John St., Toronto, ON").

Verified on jobs.toronto.ca, 2026-10-08 (docs/SOURCES.md §4.5):
    listing        GET {origin}/sitemap.xml  -> every job URL + lastmod; filtered to the
                   tenant's site path (one host can serve several sites)
    job page       {origin}/{site}/job/{slug}/{id}/
    microdata      title, hiringOrganization, jobLocation.address (locality, region,
                   postalCode, country), datePosted, validThrough
    closed         the job page says "this job posting has ended" (explicit) or validThrough
                   has passed

Field mapping:
    numeric id in URL      -> external_id
    itemprop=title         -> title
    hiringOrganization     -> company_name
    datePosted             -> posted_date, precision=date ("Wed Oct 07 00:00:00 UTC 2026" is a
                              date rendered at UTC midnight; the employer's zone is unknown)
    validThrough           -> valid_through
    address microdata      -> city-level structured address (never a map point by itself)
    "Work Location:" text  -> explicit work-site address (via description extraction)

The sitemap is not proof of a complete current listing, so listings are never complete and
absence is never closure evidence; every tracked job is instead re-checked on its own page
at least once per DETAIL_RECHECK_HOURS.

Every fetch is checked against the host's robots.txt.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.core.config import get_settings
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
from app.services.region_match import slug_may_be_relevant

JOB_PATH_RE = re.compile(r"^/(?P<site>[A-Za-z0-9_-]+)/job/[^/]+/(?P<id>\d{4,})/?$")
ENDED_RE = re.compile(r"this job posting has ended|job is no longer available", re.I)
LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>(?:\s*<lastmod>\s*([^<\s]+)\s*</lastmod>)?")


def _meta(markup: str, prop: str) -> str | None:
    m = re.search(rf'<meta\s+itemprop="{prop}"\s+content="([^"]*)"', markup)
    return m.group(1).strip() if m and m.group(1).strip() else None


def _sf_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%a %b %d %H:%M:%S UTC %Y").replace(tzinfo=UTC)
    except ValueError:
        return None


def parse_job_page(markup: str, url: str) -> dict[str, Any]:
    """Extract the fields we use from a CSB job page. Pure; unit-tested on a saved page."""
    title_m = re.search(r'itemprop="title"[^>]*>(.*?)</', markup, re.S)
    desc_m = re.search(
        r'itemprop="description"[^>]*>(.*?)</span>\s*</div>\s*</div>', markup, re.S
    ) or re.search(r'itemprop="description"[^>]*>(.*)', markup, re.S)
    return {
        "url": url,
        "title": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", title_m.group(1))).strip()
        if title_m
        else None,
        "hiring_organization": _meta(markup, "hiringOrganization"),
        "locality": _meta(markup, "addressLocality"),
        "region": _meta(markup, "addressRegion"),
        "postal_code": _meta(markup, "postalCode"),
        "country": _meta(markup, "addressCountry"),
        "date_posted": _meta(markup, "datePosted"),
        "valid_through": _meta(markup, "validThrough"),
        "description_html": desc_m.group(1)[:200_000] if desc_m else None,
        "ended": bool(ENDED_RE.search(markup)),
    }


def site_root(url: str) -> str | None:
    p = urlsplit(url)
    m = JOB_PATH_RE.match(p.path)
    if m:
        return urlunsplit(("https", p.netloc.lower(), f"/{m['site']}/", "", ""))
    segs = [s for s in p.path.split("/") if s]
    if len(segs) == 1:
        return urlunsplit(("https", p.netloc.lower(), f"/{segs[0]}/", "", ""))
    return None


class SuccessFactorsProvider:
    name = "successfactors"
    supports_fetch = True
    incremental = True  # receives recently_verified ids
    verify_by_url = True

    def recognize(self, url: str) -> SourceCandidate | None:
        """Recognizes CSB job URLs on any host by their path shape."""
        try:
            p = urlsplit(url)
        except ValueError:
            return None
        if not p.hostname or not JOB_PATH_RE.match(p.path):
            return None
        root = site_root(url)
        return SourceCandidate(self.name, root, root) if root else None

    def _get(self, client: SafeHttpClient, url: str):
        if not RobotsCache(client).allowed(url):
            raise ProviderError(f"robots.txt disallows {url}", error_class="robots")
        try:
            return client.get(url)
        except UnsafeURLError as exc:
            raise ProviderError(str(exc), error_class="unsafe_url") from exc

    def _sitemap(self, client: SafeHttpClient, root: str) -> list[tuple[str, str | None]]:
        origin = root.split("/", 3)
        resp = self._get(client, f"{origin[0]}//{origin[2]}/sitemap.xml")
        if resp.status_code != 200:
            raise ProviderError(
                f"sitemap {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        site_path = urlsplit(root).path
        out = []
        for loc, lastmod in LOC_RE.findall(resp.text):
            p = urlsplit(loc)
            if p.path.startswith(site_path) and JOB_PATH_RE.match(p.path):
                out.append((loc, lastmod or None))
        return out

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        try:
            jobs = self._sitemap(client, source.tenant_key)
        except ProviderError as exc:
            if exc.error_class == "robots":
                return BoardInfo(exists=False, reason="robots_disallowed")
            if exc.http_status in (404, 410):
                return BoardInfo(exists=False, http_status=exc.http_status, reason="site_not_found")
            raise
        if not jobs:
            return BoardInfo(exists=False, http_status=200, reason="sitemap_empty")
        org = None
        for url, _ in jobs[:5]:  # the sitemap may start with ended postings (no microdata)
            resp = self._get(client, url)
            org = _meta(resp.text, "hiringOrganization") if resp.status_code == 200 else None
            if org:
                break
        return BoardInfo(exists=True, company_name=org, http_status=200, evidence_url=jobs[0][0])

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        listed = self._sitemap(client, source.tenant_key)
        cap = get_settings().careersite_max_detail_pages
        records, listed_only = [], []
        for url, _lastmod in listed:
            path = urlsplit(url).path
            ext = JOB_PATH_RE.match(path)["id"]  # type: ignore[index]
            slug = path.split("/job/", 1)[1].split("/", 1)[0]
            if not slug_may_be_relevant(slug.split("-")[0] + " " + slug):
                continue
            if ext in source.recently_verified or len(records) >= cap:
                listed_only.append(ext)
                continue
            try:
                resp = self._get(client, url)
            except (ProviderError, FetchError):
                continue
            if resp.status_code != 200:
                continue
            page = parse_job_page(resp.text, resp.url)
            if page["ended"] or not page["title"]:
                # The sitemap lags: ended postings stay listed. Not ingested; if we track it,
                # the unlisted re-check closes it on the explicit "has ended" message.
                continue
            records.append(page)
        return FetchPage(records, None, is_complete=False, http_status=200, listed_only=listed_only)

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        m = JOB_PATH_RE.match(urlsplit(raw["url"]).path)
        if not m:
            raise ValueError("not a CSB job url")
        posted = _sf_date(raw.get("date_posted"))
        valid = _sf_date(raw.get("valid_through"))
        addr = None
        if raw.get("locality") or raw.get("postal_code"):
            addr = StructuredAddress(
                street=None,
                city=raw.get("locality"),
                region=raw.get("region"),
                postal_code=raw.get("postal_code"),
                country=raw.get("country"),
                label=None,
                method="successfactors_microdata",
            )
        location = ", ".join(p for p in (raw.get("locality"), raw.get("region")) if p) or None
        return NormalizedJob(
            external_id=m["id"],
            title=raw.get("title"),
            company_name=raw.get("hiring_organization"),
            apply_url=raw["url"],
            canonical_url=raw["url"],
            description_text=html_to_text(raw.get("description_html")),
            location_text=location,
            posted_date=posted.date() if posted else None,
            posted_precision="date" if posted else "none",
            posted_basis="original" if posted else "unknown",
            posted_tz_basis="date only; SuccessFactors renders it at UTC midnight, zone unknown"
            if posted
            else None,
            structured_addresses=[addr] if addr else [],
            valid_through=valid,
        )

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult:
        # external_id is numeric; the canonical URL is needed, so the caller passes the URL
        # when known (lifecycle uses canonical_url). Fall back to unknown otherwise.
        if not external_id.startswith("http"):
            return VerifyResult("unknown", "job url required")
        if not external_id.endswith("/"):
            external_id += "/"  # canonical URLs drop the trailing slash CSB job paths use
        try:
            resp = self._get(client, external_id)
        except (ProviderError, FetchError) as exc:
            return VerifyResult("unknown", f"fetch failed: {exc}")
        if resp.status_code != 200:
            return VerifyResult("unknown", f"status {resp.status_code}", resp.status_code)
        page = parse_job_page(resp.text, resp.url)
        if page["ended"]:
            return VerifyResult("closed", "job page states the posting has ended", 200)
        valid = _sf_date(page.get("valid_through"))
        if valid is not None and valid < datetime.now(UTC):
            return VerifyResult("closed", f"validThrough {valid.isoformat()} passed", 200)
        if page.get("title"):
            return VerifyResult("active", "job page live with title", 200)
        return VerifyResult("unknown", "page without job markup", 200)
