"""BambooHR hosted career pages ({company}.bamboohr.com/careers).

Verified 2026-10-09 (docs/SOURCES.md §4.8): tenant robots.txt only disallows /jobs/embed*.
    listing   GET /careers/list      -> {"meta": {"totalCount"}, "result": [...]} (complete)
    detail    GET /careers/{id}/detail -> jobOpening: jobOpeningName, description (HTML),
              datePosted (date), location {city, state, postalCode, addressCountry},
              atsLocation {country, state, city}, locationType, jobOpeningStatus, compensation
Field mapping:
    id -> external_id; jobOpeningName -> title; datePosted -> posted_date (date, zone unknown)
    locationType: "0" on-site, "1" remote, "2" hybrid (observed: a job titled "Remote: ..." has
    "1"); anything else -> unknown
    location / atsLocation -> location label (city-level; postal code kept as a hint)
Closure evidence: detail jobOpeningStatus != "Open", or the detail 404s while the company's
listing still answers.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any
from urllib.parse import urlsplit

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

HOST_RE = re.compile(r"^(?P<sub>[a-z0-9][a-z0-9-]{0,62})\.bamboohr\.com$")
RESERVED = {"www", "api", "app", "help", "marketplace", "partners", "status", "go"}
WORKPLACE = {"0": "on_site", "1": "remote", "2": "hybrid"}


class BambooHRProvider:
    name = "bamboohr"
    supports_fetch = True
    incremental = True
    detail_recheck_hours = 168  # the complete listing is the daily open evidence

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            host = (urlsplit(url).hostname or "").lower()
        except ValueError:
            return None
        m = HOST_RE.match(host)
        if not m or m["sub"] in RESERVED:
            return None
        return SourceCandidate(self.name, m["sub"], f"https://{m['sub']}.bamboohr.com/careers")

    def _get(self, client: SafeHttpClient, url: str):
        if not RobotsCache(client).allowed(url):
            raise ProviderError(f"robots.txt disallows {url}", error_class="robots")
        try:
            return client.get(url, headers={"Accept": "application/json"})
        except UnsafeURLError as exc:
            raise ProviderError(str(exc), error_class="unsafe_url") from exc

    def _list(self, client: SafeHttpClient, sub: str) -> tuple[list[dict], bool, int]:
        resp = self._get(client, f"https://{sub}.bamboohr.com/careers/list")
        if resp.status_code != 200 or "json" not in resp.headers.get("content-type", ""):
            raise ProviderError(
                f"list {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        try:
            data = resp.json()
            jobs = data["result"]
            total = data.get("meta", {}).get("totalCount")
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderError("list not json", error_class="parse", http_status=200) from exc
        return jobs, isinstance(total, int) and total == len(jobs), resp.status_code

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        try:
            jobs, _, _ = self._list(client, source.tenant_key)
        except ProviderError as exc:
            if exc.error_class == "robots":
                return BoardInfo(exists=False, reason="robots_disallowed")
            if exc.error_class == "http":
                return BoardInfo(exists=False, http_status=exc.http_status, reason="site_not_found")
            raise
        name = None
        try:  # the careers page's own company-info JSON carries the legal name
            info = self._get(
                client, f"https://{source.tenant_key}.bamboohr.com/careers/company-info"
            )
            name = (
                (info.json().get("result") or {}).get("name") if info.status_code == 200 else None
            )
        except (ProviderError, FetchError, ValueError, AttributeError):
            pass
        return BoardInfo(
            exists=True, company_name=name, http_status=200,
            evidence_url=f"https://{source.tenant_key}.bamboohr.com/careers",
        )  # fmt: skip

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        jobs, complete, status = self._list(client, source.tenant_key)
        cap = get_settings().careersite_max_detail_pages
        records: list[dict[str, Any]] = []
        listed: list[str] = []
        fetched = 0
        for j in jobs:
            ext = str(j.get("id"))
            listed.append(ext)
            loc = j.get("location") or {}
            ats = j.get("atsLocation") or {}
            label = ", ".join(
                str(p) for p in (loc.get("city"), loc.get("state"), ats.get("country")) if p
            )
            remote = str(j.get("locationType")) == "1"
            if label and not remote and not slug_may_be_relevant(label):
                continue  # clearly elsewhere (e.g. "Graz, Österreich")
            if ext in source.recently_verified or fetched >= cap:
                records.append({"_listing_only": True, "external_id": ext, "_complete": complete})
                continue
            fetched += 1
            try:
                resp = self._get(
                    client, f"https://{source.tenant_key}.bamboohr.com/careers/{ext}/detail"
                )
                opening = resp.json()["result"]["jobOpening"] if resp.status_code == 200 else None
            except (ProviderError, FetchError, ValueError, KeyError, TypeError):
                opening = None
            if opening:
                records.append({**opening, "_id": ext, "_sub": source.tenant_key})
        return FetchPage(
            records, None, is_complete=complete, http_status=status, listed_only=listed
        )

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        loc = raw.get("location") or {}
        ats = raw.get("atsLocation") or {}
        city = loc.get("city") or ats.get("city")
        region = loc.get("state") or ats.get("state")
        country = loc.get("addressCountry") or ats.get("country")
        label = ", ".join(str(p) for p in (city, region, country) if p) or None
        posted = None
        if isinstance(raw.get("datePosted"), str) and re.match(
            r"^\d{4}-\d{2}-\d{2}$", raw["datePosted"]
        ):
            y, m, d = map(int, raw["datePosted"].split("-"))
            posted = date(y, m, d)
        workplace = WORKPLACE.get(str(raw.get("locationType")), "unknown")
        url = (
            raw.get("jobOpeningShareUrl")
            or f"https://{raw['_sub']}.bamboohr.com/careers/{raw['_id']}"
        )
        postal = loc.get("postalCode")
        addr = []
        if city or postal:
            addr = [
                StructuredAddress(None, city, region, postal, country, None, "bamboohr_location")
            ]
        return NormalizedJob(
            external_id=str(raw["_id"]),
            title=(raw.get("jobOpeningName") or "").strip() or None,
            company_name=None,
            apply_url=url if url.startswith("https://") else None,
            canonical_url=url,
            description_text=html_to_text(raw.get("description")),
            location_text=label,
            workplace_type=workplace,  # type: ignore[arg-type]
            workplace_evidence=f"bamboohr locationType={raw.get('locationType')!r}"
            if workplace != "unknown"
            else None,
            posted_date=posted,
            posted_precision="date" if posted else "none",
            posted_basis="original" if posted else "unknown",
            posted_tz_basis="date only; BambooHR, zone unknown" if posted else None,
            employment_type=raw.get("employmentStatusLabel"),
            salary_raw=raw.get("compensation")
            if isinstance(raw.get("compensation"), str)
            else None,
            structured_addresses=addr,
            # Status other than "Open" is explicit closure evidence (handled by verify_job).
        )

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult:
        try:
            resp = self._get(
                client, f"https://{source.tenant_key}.bamboohr.com/careers/{external_id}/detail"
            )
        except (ProviderError, FetchError) as exc:
            return VerifyResult("unknown", f"fetch failed: {exc}")
        if resp.status_code == 200:
            try:
                status = resp.json()["result"]["jobOpening"].get("jobOpeningStatus")
            except (ValueError, KeyError, TypeError):
                return VerifyResult("unknown", "detail not json", 200)
            if status == "Open":
                return VerifyResult("active", "jobOpeningStatus=Open", 200)
            if status:
                return VerifyResult("closed", f"jobOpeningStatus={status}", 200)
            return VerifyResult("unknown", "no status", 200)
        if resp.status_code == 404:
            try:
                self._list(client, source.tenant_key)
            except ProviderError:
                return VerifyResult("unknown", "company listing unavailable", 404)
            return VerifyResult("closed", "detail 404 while the company listing answers", 404)
        return VerifyResult("unknown", f"status {resp.status_code}", resp.status_code)
