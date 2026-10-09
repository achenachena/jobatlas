"""Workable hosted job boards (apply.workable.com/{account}).

Verified 2026-10-09 (docs/SOURCES.md §4.9): apply.workable.com robots.txt allows all
("Content-Signal: search=yes, ai-input=yes, ai-train=no"; we only build a search index).
    listing  GET https://apply.workable.com/api/v1/widget/accounts/{account}?details=true
             -> {name, description, jobs: [...]} — the public widget feed, complete
    job      title, shortcode, url, application_url, published_on (date), created_at (date),
             telecommuting (bool), city/state/country, locations[], employment_type,
             description (with details=true)
Field mapping: shortcode -> external_id; published_on -> posted_date (date; creation and
publication may differ, we use published_on); telecommuting=true -> remote, otherwise
unknown (an office city does not prove on-site); locations[] -> labels.
Closure: absence from the complete widget feed (repeated-absence rule); job page 404 while
the account feed answers -> closed.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any
from urllib.parse import quote, urlsplit

from app.net.robots import RobotsCache
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.providers.base import (
    BoardInfo,
    FetchPage,
    NormalizedJob,
    ProviderError,
    SourceCandidate,
    SourceRef,
    VerifyResult,
)
from app.providers.text import html_to_text

HOST = "apply.workable.com"
ACCOUNT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,99}$")
RESERVED = {"j", "api", "assets", "static", "robots.txt", "favicon.ico", "sitemap.xml"}


def _date(value: Any) -> date | None:
    if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        y, m, d = map(int, value.split("-"))
        return date(y, m, d)
    return None


class WorkableProvider:
    name = "workable"
    supports_fetch = True

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            p = urlsplit(url)
        except ValueError:
            return None
        if (p.hostname or "").lower() != HOST:
            return None
        segs = [s for s in p.path.split("/") if s]
        if not segs or segs[0].lower() in RESERVED:
            return None
        account = segs[0].lower()
        if not ACCOUNT_RE.match(account):
            return None
        return SourceCandidate(self.name, account, f"https://{HOST}/{account}/")

    def _feed(self, client: SafeHttpClient, account: str) -> dict:
        url = f"https://{HOST}/api/v1/widget/accounts/{quote(account)}?details=true"
        if not RobotsCache(client).allowed(url):
            raise ProviderError("robots.txt disallows the feed", error_class="robots")
        try:
            resp = client.get(url, headers={"Accept": "application/json"})
        except UnsafeURLError as exc:
            raise ProviderError(str(exc), error_class="unsafe_url") from exc
        if resp.status_code != 200:
            raise ProviderError(
                f"feed {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        try:
            data = resp.json()
            if not isinstance(data.get("jobs"), list):
                raise TypeError("jobs")
        except (ValueError, TypeError) as exc:
            raise ProviderError("feed not json", error_class="parse", http_status=200) from exc
        return data

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        try:
            data = self._feed(client, source.tenant_key)
        except ProviderError as exc:
            if exc.error_class == "robots":
                return BoardInfo(exists=False, reason="robots_disallowed")
            if exc.error_class == "http":
                return BoardInfo(exists=False, http_status=exc.http_status, reason="site_not_found")
            raise
        return BoardInfo(
            exists=True, company_name=(data.get("name") or "").strip() or None, http_status=200,
            evidence_url=f"https://{HOST}/{source.tenant_key}/",
        )  # fmt: skip

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        data = self._feed(client, source.tenant_key)
        return FetchPage(data["jobs"], None, is_complete=True, pages_expected=1, http_status=200)

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        labels = []
        for loc in raw.get("locations") or []:
            if isinstance(loc, dict) and not loc.get("hidden"):
                label = ", ".join(
                    str(p) for p in (loc.get("city"), loc.get("region"), loc.get("country")) if p
                )
                if label:
                    labels.append(label)
        primary = ", ".join(
            str(p) for p in (raw.get("city"), raw.get("state"), raw.get("country")) if p
        )
        location = primary or (labels[0] if labels else None)
        remote = raw.get("telecommuting") is True
        posted = _date(raw.get("published_on"))
        url = raw.get("url") or raw.get("shortlink")
        apply = raw.get("application_url") or url
        return NormalizedJob(
            external_id=str(raw["shortcode"]),
            title=(raw.get("title") or "").strip() or None,
            company_name=None,
            apply_url=apply if isinstance(apply, str) and apply.startswith("https://") else None,
            canonical_url=url,
            description_text=html_to_text(raw.get("description")),
            location_text=location,
            extra_location_labels=[x for x in labels if x != location],
            workplace_type="remote" if remote else "unknown",
            workplace_evidence="workable telecommuting=true" if remote else None,
            posted_date=posted,
            posted_precision="date" if posted else "none",
            posted_basis="original" if posted else "unknown",
            posted_tz_basis="date only; Workable published_on, zone unknown" if posted else None,
            employment_type=raw.get("employment_type"),
        )

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult:
        try:
            data = self._feed(client, source.tenant_key)
        except (ProviderError, FetchError) as exc:
            return VerifyResult("unknown", f"feed unavailable: {exc}")
        if any(str(j.get("shortcode")) == external_id for j in data["jobs"]):
            return VerifyResult("active", "listed in the account feed", 200)
        try:
            page = client.get(f"https://{HOST}/j/{quote(external_id)}")
        except (FetchError, UnsafeURLError):
            return VerifyResult("unknown", "job page unavailable")
        if page.status_code == 404:
            return VerifyResult("closed", "job page 404 while the account feed answers", 404)
        return VerifyResult("unknown", f"job page status {page.status_code}", page.status_code)
