"""Workday career sites, read through their public sitemap and each job page's own
schema.org JSON-LD (no undocumented API).

Verified on td.wd3.myworkdayjobs.com, 2026-10-08 (docs/SOURCES.md §4.6):
    listing     {root}siteMap.xml — job URLs; observed to list at most the newest 100 jobs,
                so it is never treated as complete
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
from app.net.safe_http import FetchError, SafeHttpClient
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


class WorkdayProvider(JsonLdProvider):
    name = "workday"
    supports_fetch = True
    incremental = True
    verify_by_url = True

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
            jobs = self._sitemap(client, source.tenant_key)
        except ProviderError as exc:
            if exc.error_class == "robots" or exc.http_status in (404, 410, 422):
                return BoardInfo(exists=False, http_status=exc.http_status)
            raise
        if not jobs:
            return BoardInfo(exists=False, http_status=200)
        resp = self._get(client, jobs[0])
        posts = job_postings(parse_html(resp.text)[0]) if resp.status_code == 200 else []
        org = (posts[0].get("hiringOrganization") or {}).get("name") if posts else None
        return BoardInfo(exists=True, company_name=org, http_status=200, evidence_url=jobs[0])

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
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
