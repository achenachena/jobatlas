"""Lever postings API adapter.

Docs: https://github.com/lever/postings-api
Field mapping (verified against live responses 2026-10-08, see docs/SOURCES.md §4):

    id                        -> external_id
    text                      -> title
    hostedUrl / applyUrl      -> canonical_url / apply_url
    categories.location       -> location_text; categories.allLocations -> extra labels
    categories.commitment     -> employment_type
    workplaceType             -> onsite/hybrid/remote; "unspecified"/missing -> unknown
    createdAt (epoch ms)      -> posted_at, basis=original. createdAt is when the posting was
                                 created, which is at or before publication. Using it can only
                                 make a job look OLDER than it is, so a "Past N days" filter
                                 never shows a falsely recent job; it may miss some.
    salaryRange               -> salary (explicit min/max/currency/interval only)

Pagination: skip/limit; the listing is complete when a page returns fewer than `limit`
records. Closure evidence: posting 404 "Document not found" while the site listing is 200.
EU-hosted sites use api.eu.lever.co (tenant key prefix "eu:").
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from app.core.timeutil import from_epoch_millis
from app.net.safe_http import FetchError, SafeHttpClient
from app.providers.base import (
    BoardInfo,
    FetchPage,
    NormalizedJob,
    ProviderError,
    SourceCandidate,
    SourceRef,
    VerifyResult,
)
from app.providers.text import page_title

PAGE = 100
HOSTS = {"jobs.lever.co": "", "jobs.eu.lever.co": "eu:"}
SITE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")
WORKPLACE = {"onsite": "on_site", "on-site": "on_site", "hybrid": "hybrid", "remote": "remote"}
INTERVALS = {
    "per-year-salary": "year",
    "per-month-salary": "month",
    "per-week-salary": "week",
    "per-day-wage": "day",
    "per-hour-wage": "hour",
}


def _api(tenant_key: str) -> tuple[str, str]:
    if tenant_key.startswith("eu:"):
        return "https://api.eu.lever.co/v0/postings", tenant_key[3:]
    return "https://api.lever.co/v0/postings", tenant_key


class LeverProvider:
    name = "lever"
    supports_fetch = True

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            parts = urlsplit(url)
        except ValueError:
            return None
        host = (parts.hostname or "").lower()
        if host not in HOSTS:
            return None
        segments = [s for s in parts.path.split("/") if s]
        if not segments:
            return None
        site = unquote(segments[0]).lower()
        if not SITE_RE.match(site) or site in {"robots.txt", "favicon.ico"}:
            return None
        return SourceCandidate(self.name, HOSTS[host] + site, f"https://{host}/{site}")

    def _page(self, client: SafeHttpClient, source: SourceRef, skip: int):
        base, site = _api(source.tenant_key)
        url = f"{base}/{quote(site)}?mode=json&skip={skip}&limit={PAGE}"
        return url, client.get(url)

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        url, resp = self._page(client, source, 0)
        if resp.status_code == 404:
            return BoardInfo(exists=False, http_status=404, evidence_url=url)
        if resp.status_code != 200:
            raise ProviderError(
                f"site {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        try:
            data = resp.json()
        except ValueError as exc:
            raise ProviderError("site not json", error_class="parse", http_status=200) from exc
        if not isinstance(data, list):
            return BoardInfo(exists=False, http_status=200, evidence_url=url)
        name = None
        prefix = "jobs.eu.lever.co" if source.tenant_key.startswith("eu:") else "jobs.lever.co"
        page = f"https://{prefix}/{quote(_api(source.tenant_key)[1])}"
        try:
            board_page = client.get(page)
            if board_page.status_code == 200:
                name = page_title(board_page.text)
        except FetchError:
            pass
        return BoardInfo(exists=True, company_name=name, http_status=200, evidence_url=page)

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        skip = int(cursor or 0)
        _, resp = self._page(client, source, skip)
        if resp.status_code != 200:
            raise ProviderError(
                f"postings {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        try:
            data = resp.json()
        except ValueError as exc:
            raise ProviderError("postings not json", error_class="parse", http_status=200) from exc
        if not isinstance(data, list):
            raise ProviderError("postings is not a list", error_class="parse", http_status=200)
        more = len(data) >= PAGE
        return FetchPage(
            records=data,
            next_cursor=str(skip + PAGE) if more else None,
            is_complete=True,  # the run is complete once the final short page arrives
            http_status=200,
        )

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        cats = raw.get("categories") or {}
        location = (cats.get("location") or "").strip() or None
        all_locations = [loc for loc in cats.get("allLocations") or [] if loc and loc != location]
        workplace = WORKPLACE.get((raw.get("workplaceType") or "").lower(), "unknown")
        created = from_epoch_millis(raw.get("createdAt"))
        description = "\n\n".join(
            p for p in (raw.get("descriptionPlain"), raw.get("additionalPlain")) if p
        ).strip()
        apply_url = raw.get("applyUrl") or raw.get("hostedUrl")
        return NormalizedJob(
            external_id=str(raw["id"]),
            title=(raw.get("text") or "").strip() or None,
            company_name=None,
            apply_url=apply_url if _http(apply_url) else None,
            canonical_url=raw.get("hostedUrl"),
            description_text=description or None,
            location_text=location,
            extra_location_labels=all_locations,
            workplace_type=workplace,  # type: ignore[arg-type]
            workplace_evidence=f"lever workplaceType={raw.get('workplaceType')!r}"
            if workplace != "unknown"
            else None,
            posted_at=created,
            posted_precision="datetime" if created else "none",
            posted_basis="original" if created else "unknown",
            posted_tz_basis="lever createdAt epoch ms (creation time, <= publication)"
            if created
            else None,
            employment_type=cats.get("commitment"),
            **_salary(raw),
        )

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult:
        base, site = _api(source.tenant_key)
        url = f"{base}/{quote(site)}/{quote(external_id)}?mode=json"
        resp = client.get(url)
        if resp.status_code == 200:
            return VerifyResult("active", "posting returned 200", 200)
        if resp.status_code == 404 and b"Document not found" in resp.content:
            try:
                board = self.board_info(client, source)
            except ProviderError:
                return VerifyResult("unknown", "site check failed", 404)
            if board.exists:
                return VerifyResult("closed", "posting 404 while site listing is healthy", 404)
            return VerifyResult("unknown", "site itself unavailable; not a job closure", 404)
        return VerifyResult("unknown", f"inconclusive status {resp.status_code}", resp.status_code)


def _http(url: Any) -> bool:
    return isinstance(url, str) and url.startswith(("https://", "http://"))


def _salary(raw: dict) -> dict:
    sr = raw.get("salaryRange") or {}
    period = INTERVALS.get(sr.get("interval") or "")
    lo, hi, cur = sr.get("min"), sr.get("max"), sr.get("currency")
    if (lo is not None or hi is not None) and cur and period:
        return {
            "salary_min": Decimal(str(lo)) if lo is not None else None,
            "salary_max": Decimal(str(hi)) if hi is not None else None,
            "salary_currency": str(cur)[:3],
            "salary_period": period,
            "salary_raw": raw.get("salaryDescriptionPlain"),
        }
    desc = raw.get("salaryDescriptionPlain")
    return {"salary_raw": desc} if desc and re.search(r"\d", desc) else {}
