"""Ashby public job posting API adapter.

Docs: https://developers.ashbyhq.com/docs/public-job-posting-api
Field mapping (verified against live responses 2026-10-08, see docs/SOURCES.md §4):

    id                         -> external_id
    title                      -> title
    jobUrl / applyUrl          -> canonical_url / apply_url
    location                   -> location_text
    secondaryLocations[]       -> extra location labels (eligibility text for remote jobs)
    address.postalAddress      -> structured address; a streetAddress is work-site evidence
    workplaceType              -> OnSite/Hybrid/Remote; null -> unknown (never defaulted)
    isRemote                   -> only used when workplaceType is null and isRemote is true
    publishedAt                -> source_republished_at. Ashby documents it as the LAST
                                  publication, so posted_basis = republished_only and posted_at
                                  stays empty. Never treated as the original posting time.
    isListed=false             -> skipped entirely (not public)
    employmentType             -> employment_type
    compensation.*Salary*      -> salary (only explicit min/max/currency/interval)

The list endpoint returns every listed job in one response; there is no single-job
endpoint, so verify_job can only confirm presence (active) and otherwise says unknown.
Closure for Ashby therefore relies on the repeated complete-listing absence rule.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from app.core.timeutil import parse_iso_datetime
from app.net.safe_http import FetchError, SafeHttpClient
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
from app.providers.text import page_title

API = "https://api.ashbyhq.com/posting-api/job-board"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
HOST = "jobs.ashbyhq.com"
RESERVED = {"api", "b", "meeting", "embed", "static", "robots.txt", "favicon.ico", "sitemap.xml"}
WORKPLACE = {"onsite": "on_site", "hybrid": "hybrid", "remote": "remote"}
INTERVALS = {
    "1 YEAR": "year",
    "1 MONTH": "month",
    "1 WEEK": "week",
    "1 DAY": "day",
    "1 HOUR": "hour",
}


class AshbyProvider:
    name = "ashby"
    supports_fetch = True

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            parts = urlsplit(url)
        except ValueError:
            return None
        host = (parts.hostname or "").lower()
        segments = [s for s in parts.path.split("/") if s]
        if host == HOST and segments:
            org = unquote(segments[0]).strip()
        elif host == "api.ashbyhq.com" and segments[:2] == ["posting-api", "job-board"]:
            org = unquote(segments[2]).strip() if len(segments) > 2 else ""
        else:
            return None
        if not org or org.lower() in RESERVED or len(org) > 100 or UUID_RE.match(org):
            return None
        key = org.lower()
        return SourceCandidate(self.name, key, f"https://{HOST}/{quote(key)}")

    def _list(self, client: SafeHttpClient, source: SourceRef):
        url = f"{API}/{quote(source.tenant_key)}?includeCompensation=true"
        return url, client.get(url)

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        url, resp = self._list(client, source)
        if resp.status_code == 404:
            return BoardInfo(exists=False, http_status=404, evidence_url=url)
        if resp.status_code != 200:
            raise ProviderError(
                f"board {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        # The posting API carries no organisation name; the public board page title does
        # ("Ramp Jobs"). Failing that, the caller falls back to the slug (unverified).
        name = None
        page = f"https://{HOST}/{quote(source.tenant_key)}"
        try:
            board_page = client.get(page)
            if board_page.status_code == 200:
                name = page_title(board_page.text, strip_suffix=" Jobs")
        except FetchError:
            pass
        return BoardInfo(exists=True, company_name=name, http_status=200, evidence_url=page)

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        _, resp = self._list(client, source)
        if resp.status_code != 200:
            raise ProviderError(
                f"jobs list {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        try:
            jobs = resp.json()["jobs"]
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderError("unexpected payload", error_class="parse", http_status=200) from exc
        if not isinstance(jobs, list):
            raise ProviderError("jobs is not a list", error_class="parse", http_status=200)
        listed = [j for j in jobs if isinstance(j, dict) and j.get("isListed", True) is not False]
        return FetchPage(listed, None, is_complete=True, pages_expected=1, http_status=200)

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        workplace_raw = (raw.get("workplaceType") or "").replace("-", "").lower()
        workplace = WORKPLACE.get(workplace_raw, "unknown")
        evidence = (
            f"ashby workplaceType={raw.get('workplaceType')!r}" if workplace != "unknown" else None
        )
        if workplace == "unknown" and raw.get("isRemote") is True:
            workplace, evidence = "remote", "ashby isRemote=true"
        location = (raw.get("location") or "").strip() or None
        secondary = [
            (s.get("location") or "").strip()
            for s in raw.get("secondaryLocations") or []
            if isinstance(s, dict) and s.get("location")
        ]
        addresses = [_address((raw.get("address") or {}).get("postalAddress"), location)]
        for s in raw.get("secondaryLocations") or []:
            if isinstance(s, dict):
                addresses.append(
                    _address((s.get("address") or {}).get("postalAddress"), s.get("location"))
                )
        republished = parse_iso_datetime(raw.get("publishedAt"))
        salary = _salary(raw.get("compensation") or {})
        apply_url = raw.get("applyUrl") or raw.get("jobUrl")
        return NormalizedJob(
            external_id=str(raw["id"]),
            title=(raw.get("title") or "").strip() or None,
            company_name=None,
            apply_url=apply_url if _http(apply_url) else None,
            canonical_url=raw.get("jobUrl"),
            description_text=(raw.get("descriptionPlain") or "").strip() or None,
            location_text=location,
            extra_location_labels=secondary,
            workplace_type=workplace,  # type: ignore[arg-type]
            workplace_evidence=evidence,
            posted_at=None,
            posted_precision="none",
            posted_basis="republished_only" if republished else "unknown",
            source_republished_at=republished,
            employment_type=raw.get("employmentType"),
            structured_addresses=[a for a in addresses if a is not None],
            **salary,
        )

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult:
        try:
            page = self.fetch_jobs(client, source, None)
        except ProviderError as exc:
            return VerifyResult("unknown", f"board fetch failed: {exc}", exc.http_status)
        if any(str(j.get("id")) == external_id for j in page.records):
            return VerifyResult("active", "listed on board", 200)
        return VerifyResult("unknown", "ashby has no single-job endpoint; absence only", 200)


def _http(url: Any) -> bool:
    return isinstance(url, str) and url.startswith(("https://", "http://"))


def _address(postal: dict | None, label: str | None) -> StructuredAddress | None:
    if not isinstance(postal, dict):
        return None
    street = (postal.get("streetAddress") or "").strip() or None
    city = (postal.get("addressLocality") or "").strip() or None
    if not street and not city:
        return None
    return StructuredAddress(
        street=street,
        city=city,
        region=(postal.get("addressRegion") or "").strip() or None,
        postal_code=(postal.get("postalCode") or "").strip() or None,
        country=(postal.get("addressCountry") or "").strip() or None,
        label=label,
        method="ashby_postal_address",
    )


def _salary(comp: dict) -> dict:
    """Structured salary only when the posting has exactly one salary component; several
    tiers usually mean different locations, and picking one would misstate pay."""
    components = [
        c
        for tier in comp.get("compensationTiers") or []
        for c in tier.get("components") or []
        if c.get("compensationType") == "Salary"
    ]
    summary = comp.get("compensationTierSummary") or comp.get("scrapeableCompensationSalarySummary")
    if len(components) == 1:
        c = components[0]
        lo, hi, cur = c.get("minValue"), c.get("maxValue"), c.get("currencyCode")
        period = INTERVALS.get(c.get("interval") or "")
        if (lo is not None or hi is not None) and cur and period:
            return {
                "salary_min": Decimal(str(lo)) if lo is not None else None,
                "salary_max": Decimal(str(hi)) if hi is not None else None,
                "salary_currency": str(cur)[:3],
                "salary_period": period,
                "salary_raw": c.get("summary"),
            }
    return {"salary_raw": summary} if summary and re.search(r"\d", summary) else {}
