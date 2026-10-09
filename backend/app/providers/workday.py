"""Workday career sites.

Listing (verified 2026-10-09, docs/SOURCES.md §4.6): the employer's public career site loads
its job list from `/wday/cxs/{tenant}/{site}/jobs` (POST, 20 per page, `total` on the first
page). Each employer's robots.txt is checked for that path. This is the endpoint the public
page itself calls; it is not separately documented by Workday. It returns the COMPLETE list
(TD: 1,642 jobs vs. the 100-job sitemap), so presence in it is open evidence and absence can
feed the repeated-absence closure rule. If it is unavailable we fall back to the sitemap
(`{root}siteMap.xml`, newest ~100 jobs, never complete).

Details come from each job page's own schema.org JSON-LD, fetched only for new jobs whose
listed location could be in the GTA/Canada, and re-read weekly (DETAIL_RECHECK_HOURS here):

Verified on td.wd3.myworkdayjobs.com, 2026-10-08:
    job page    JSON-LD JobPosting: title, hiringOrganization, datePosted (date), validThrough,
                identifier (requisition id), jobLocation.address.addressLocality — often the
                full site, e.g. "TD Centre - TD Tower - 66 Wellington Street West, Toronto,
                Ontario"
    robots      decided per employer and per site path; e.g. TD allows /TD_Bank_Careers/,
                RBC disallows /RBCGLOBAL1/ (such sites are never fetched)

Workday emits jobLocationType=TELECOMMUTE even for jobs tied to an office tower, so on
Workday it does NOT mean fully remote: workplace stays unknown, and the stated site is used as
the job's work location.
"""

from __future__ import annotations

import re
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
)
from app.providers.jsonld import JsonLdProvider, job_postings, parse_html
from app.services.region_match import slug_may_be_relevant

HOST_RE = re.compile(r"^(?P<tenant>[a-z0-9-]+)\.(?P<dc>wd\d+)\.myworkdayjobs\.com$")
SITE_HOST_RE = re.compile(r"^(?P<dc>wd\d+)\.myworkdaysite\.com$")
LOCALE_RE = re.compile(r"^[a-z]{2}-[A-Z]{2}$")
RESERVED = {"wday", "refreshfacet", "robots.txt", "favicon.ico", "sitemap.xml"}
LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>")


def site_root(url: str) -> str | None:
    p = urlsplit(url)
    host = (p.hostname or "").lower()
    segs = [s for s in p.path.split("/") if s]
    if HOST_RE.match(host):
        if segs and LOCALE_RE.match(segs[0]):
            segs = segs[1:]
        if not segs or segs[0].lower() in RESERVED:
            return None
        return urlunsplit(("https", host, f"/{segs[0]}/", "", ""))
    if SITE_HOST_RE.match(host) and len(segs) >= 3 and segs[0] == "recruiting":
        rest = segs[3:] if len(segs) > 3 else []
        site = segs[2]
        if LOCALE_RE.match(site) and rest:
            site = rest[0]
        return urlunsplit(("https", host, f"/recruiting/{segs[1]}/{site}/", "", ""))
    return None


CXS_PAGE = 20
CXS_MAX_JOBS = 6000
# Workday's global id for the country Canada (same across tenants; facet names differ:
# "Country", "locationCountry", nested under "locationMainGroup", ...).
CANADA_ID = "a30a87ed25634629aa6c3958aa2b91ea"
COUNTRY_FACET_HINT = re.compile(r"country|locationmaingroup", re.I)


def canada_facet(facets: list[dict]) -> tuple[str | None, bool]:
    """(facet parameter to filter on Canada, tenant exposes a country facet at all)."""
    has_country = False

    def walk(items: list[dict], parent: str | None) -> str | None:
        nonlocal has_country
        for f in items:
            param = f.get("facetParameter") or parent
            if param and COUNTRY_FACET_HINT.search(param):
                has_country = True
            for v in f.get("values") or []:
                if "values" in v:  # nested group with its own parameter
                    found = walk([v], param)
                    if found:
                        return found
                elif v.get("id") == CANADA_ID or str(v.get("descriptor", "")).lower() == "canada":
                    return param
        return None

    return walk(facets, None), has_country


def cxs_url(root: str) -> str | None:
    p = urlsplit(root)
    host = (p.hostname or "").lower()
    segs = [s for s in p.path.split("/") if s]
    m = HOST_RE.match(host)
    if m and segs:
        return f"https://{host}/wday/cxs/{m['tenant']}/{segs[0]}/jobs"
    if SITE_HOST_RE.match(host) and len(segs) >= 3 and segs[0] == "recruiting":
        return f"https://{host}/wday/cxs/{segs[1]}/{segs[2]}/jobs"
    return None


class WorkdayProvider(JsonLdProvider):
    name = "workday"
    supports_fetch = True
    incremental = True
    verify_by_url = True
    detail_recheck_hours = 168  # presence in the complete listing is the daily evidence

    def _listing(self, client: SafeHttpClient, root: str) -> tuple[list[dict], bool]:
        """(postings, complete) from the career site's own listing endpoint, narrowed to
        Canadian jobs when the tenant offers a country facet."""
        url = cxs_url(root)
        if url is None or not RobotsCache(client).allowed(url):
            raise ProviderError("listing endpoint not allowed", error_class="robots")

        def page_at(offset: int, applied: dict) -> dict:
            try:
                resp = client.post_json(
                    url,
                    {
                        "appliedFacets": applied,
                        "limit": CXS_PAGE,
                        "offset": offset,
                        "searchText": "",
                    },
                )
            except UnsafeURLError as exc:
                raise ProviderError(str(exc), error_class="unsafe_url") from exc
            if resp.status_code != 200:
                raise ProviderError(
                    f"listing {resp.status_code}", error_class="http", http_status=resp.status_code
                )
            try:
                data = resp.json()
                data["jobPostings"]  # noqa: B018 - shape check
            except (ValueError, KeyError, TypeError) as exc:
                raise ProviderError(
                    "listing not json", error_class="parse", http_status=200
                ) from exc
            return data

        first = page_at(0, {})
        applied: dict[str, list[str]] = {}
        param, has_country = canada_facet(first.get("facets") or [])
        if param:
            # Global employers: only the Canadian subset (TD: 917 of 1,642 jobs).
            applied = {param: [CANADA_ID]}
            first = page_at(0, applied)
        elif has_country:
            return [], True  # a country facet without Canada: no Canadian jobs here
        total = int(first.get("total") or 0)
        postings = [
            p for p in first["jobPostings"] if isinstance(p, dict) and p.get("externalPath")
        ]
        offset = CXS_PAGE
        while offset < min(total, CXS_MAX_JOBS):
            page = page_at(offset, applied)["jobPostings"]
            if not page:
                break
            postings.extend(p for p in page if isinstance(p, dict) and p.get("externalPath"))
            offset += CXS_PAGE
        return postings, len(postings) == total

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            root = site_root(url)
        except ValueError:
            return None
        return SourceCandidate(self.name, root, root) if root else None

    def _sitemap(self, client: SafeHttpClient, root: str) -> list[str]:
        resp = self._get(client, f"{root}siteMap.xml", accept="application/xml,text/xml,*/*")
        if resp.status_code != 200:
            raise ProviderError(
                f"sitemap {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        return [u for u in LOC_RE.findall(resp.text) if "/job/" in u]

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        try:
            postings, _ = self._listing(client, source.tenant_key)
        except ProviderError as exc:
            if exc.error_class not in ("robots", "http"):
                raise
            postings = []
        if postings:
            first = source.tenant_key.rstrip("/") + postings[0]["externalPath"]
            resp = self._get(client, first)
            posts = job_postings(parse_html(resp.text)[0]) if resp.status_code == 200 else []
            org = (posts[0].get("hiringOrganization") or {}).get("name") if posts else None
            return BoardInfo(exists=True, company_name=org, http_status=200, evidence_url=first)
        try:
            jobs = self._sitemap(client, source.tenant_key)
        except ProviderError as exc:
            if exc.error_class == "robots":
                return BoardInfo(exists=False, reason="robots_disallowed")
            if exc.http_status in (404, 410, 422):
                return BoardInfo(exists=False, http_status=exc.http_status, reason="site_not_found")
            raise
        if not jobs:
            return BoardInfo(exists=False, http_status=200, reason="sitemap_empty")
        resp = self._get(client, jobs[0])
        posts = job_postings(parse_html(resp.text)[0]) if resp.status_code == 200 else []
        org = (posts[0].get("hiringOrganization") or {}).get("name") if posts else None
        return BoardInfo(exists=True, company_name=org, http_status=200, evidence_url=jobs[0])

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        try:
            postings, complete = self._listing(client, source.tenant_key)
        except ProviderError as exc:
            if exc.error_class not in ("robots", "http"):
                raise
            return self._fetch_from_sitemap(client, source)
        root = source.tenant_key.rstrip("/")
        cap = get_settings().careersite_max_detail_pages
        records: list[dict[str, Any]] = []
        listed: list[str] = []
        fetched = 0
        for posting in postings:
            url = root + posting["externalPath"]
            key = self.candidate_for(url).canonical_url
            listed.append(key)
            loc = str(posting.get("locationsText") or "")
            if not slug_may_be_relevant(loc):
                continue  # e.g. "Flourtown, Pennsylvania": never a GTA job
            if key in source.recently_verified or fetched >= cap:
                # Listed in the complete listing: open evidence for a job we already track.
                records.append({"_listing_only": True, "external_id": key, "_complete": complete})
                continue
            fetched += 1
            try:
                resp = self._get(client, url)
            except (ProviderError, FetchError):
                continue
            if resp.status_code != 200:
                continue
            for post in job_postings(parse_html(resp.text)[0]):
                records.append({**post, "url": resp.url, "_page_url": resp.url})
        return FetchPage(records, None, is_complete=complete, http_status=200, listed_only=listed)

    def _fetch_from_sitemap(self, client: SafeHttpClient, source: SourceRef) -> FetchPage:
        urls = self._sitemap(client, source.tenant_key)
        cap = get_settings().careersite_max_detail_pages
        records: list[dict[str, Any]] = []
        listed_only: list[str] = []
        for url in urls:
            key = self.candidate_for(url).canonical_url
            segs = urlsplit(url).path.split("/job/", 1)
            slug = segs[1].split("/", 1)[0] if len(segs) == 2 else ""
            if slug and not slug_may_be_relevant(slug):
                continue  # e.g. "/job/Flourtown-Pennsylvania/..." is never a GTA job
            if key in source.recently_verified or len(records) >= cap:
                listed_only.append(key)
                continue
            try:
                resp = self._get(client, url)
            except (ProviderError, FetchError):
                continue
            if resp.status_code != 200:
                continue
            for post in job_postings(parse_html(resp.text)[0]):
                # The job page URL is the stable id; JSON-LD on Workday carries no url.
                records.append({**post, "url": resp.url, "_page_url": resp.url})
        return FetchPage(records, None, is_complete=False, http_status=200, listed_only=listed_only)

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        n = super().normalize(raw)
        if n.workplace_type == "remote":
            n.workplace_type = "unknown"  # see module docstring
            n.workplace_evidence = None
            n.eligibility_texts = []
        n.structured_addresses = [
            type(a)(
                a.street,
                a.city,
                a.region,
                a.postal_code,
                a.country,
                a.label,
                "workday_jsonld_address",
            )  # fmt: skip
            for a in n.structured_addresses
        ]
        return n
