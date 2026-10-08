"""Greenhouse Job Board API adapter.

Docs: https://developers.greenhouse.io/job-board.html
Field mapping (verified against live responses on 2026-10-08, see docs/SOURCES.md):

    id                 -> external_id
    title              -> title
    company_name       -> company_name (board name used as fallback)
    absolute_url       -> apply_url / canonical_url (may be the employer's own careers site)
    location.name      -> location_text (free text, often city only)
    offices[].name     -> office_names (labels, not verified addresses)
    first_published    -> posted_at, basis=original, precision=datetime
    updated_at         -> source_updated_at (never used as posted_at)
    requisition_id     -> requisition_id (ignored when a placeholder)
    content            -> description_text (HTML-escaped HTML -> plain text)

The list endpoint returns every published job in one response with meta.total, so a run is
complete only when len(jobs) == meta.total. A job 404 ("Job not found") while the board
itself answers 200 is the provider's closure signal; anything else is unknown.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from app.core.timeutil import parse_iso_datetime
from app.net.safe_http import ResponseTooLargeError, SafeHttpClient
from app.providers.base import (
    BoardInfo,
    FetchPage,
    NormalizedJob,
    ProviderError,
    SourceCandidate,
    SourceRef,
    VerifyResult,
)
from app.providers.text import html_to_text, workplace_from_location_label

API = "https://boards-api.greenhouse.io/v1/boards"
BOARD_HOSTS = {"boards.greenhouse.io", "job-boards.greenhouse.io"}
TOKEN_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,99}$")
RESERVED = {
    "embed",
    "v1",
    "jobs",
    "job_app",
    "api",
    "assets",
    "static",
    "favicon.ico",
    "robots.txt",
}
PLACEHOLDER_REQ_IDS = {"", "see opening id", "n/a", "na", "none", "tbd"}


class GreenhouseProvider:
    name = "greenhouse"
    supports_fetch = True

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            parts = urlsplit(url)
        except ValueError:
            return None
        host = (parts.hostname or "").lower()
        segments = [s for s in parts.path.split("/") if s]
        token: str | None = None
        if host in BOARD_HOSTS:
            if segments[:2] == ["embed", "job_board"] or segments[:2] == ["embed", "job_app"]:
                token = (parse_qs(parts.query).get("for") or [None])[0]
            elif segments and segments[0].lower() not in RESERVED:
                token = segments[0]
        elif host == "boards-api.greenhouse.io" and segments[:2] == ["v1", "boards"]:
            token = segments[2] if len(segments) > 2 else None
        if not token:
            return None
        token = token.lower()
        if not TOKEN_RE.match(token):
            return None
        return SourceCandidate(
            provider=self.name,
            tenant_key=token,
            canonical_url=f"https://job-boards.greenhouse.io/{token}",
        )

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        url = f"{API}/{quote(source.tenant_key)}"
        resp = client.get(url)
        if resp.status_code == 404:
            return BoardInfo(exists=False, http_status=404, evidence_url=url)
        if resp.status_code != 200:
            raise ProviderError(
                f"board info {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        data = resp.json()
        name = (data.get("name") or "").strip() or None
        return BoardInfo(exists=True, company_name=name, http_status=200, evidence_url=url)

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        url = f"{API}/{quote(source.tenant_key)}/jobs?content=true"
        try:
            resp = client.get(url)
        except ResponseTooLargeError:
            # Very large boards: the listing without descriptions is still complete; we only
            # lose description-based address extraction for this run.
            resp = client.get(f"{API}/{quote(source.tenant_key)}/jobs")
        if resp.status_code != 200:
            raise ProviderError(
                f"jobs list {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        try:
            data = resp.json()
            jobs = data["jobs"]
            total = data.get("meta", {}).get("total")
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderError(
                "unexpected jobs payload", error_class="parse", http_status=200
            ) from exc
        if not isinstance(jobs, list):
            raise ProviderError("jobs is not a list", error_class="parse", http_status=200)
        complete = isinstance(total, int) and total == len(jobs)
        return FetchPage(
            records=jobs, next_cursor=None, is_complete=complete, pages_expected=1, http_status=200
        )

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        location = (raw.get("location") or {}).get("name")
        location = location.strip() if isinstance(location, str) else None
        workplace, workplace_evidence = workplace_from_location_label(location)
        first_published = parse_iso_datetime(raw.get("first_published"))
        req = raw.get("requisition_id")
        req = req.strip() if isinstance(req, str) else None
        if req and req.lower() in PLACEHOLDER_REQ_IDS:
            req = None
        url = raw.get("absolute_url")
        return NormalizedJob(
            external_id=str(raw["id"]),
            title=(raw.get("title") or "").strip() or None,
            company_name=(raw.get("company_name") or "").strip() or None,
            apply_url=url
            if isinstance(url, str) and url.startswith(("https://", "http://"))
            else None,
            canonical_url=url,
            description_text=html_to_text(raw.get("content"), already_escaped=True),
            location_text=location or None,
            workplace_type=workplace,  # type: ignore[arg-type]
            workplace_evidence=workplace_evidence,
            posted_at=first_published,
            posted_precision="datetime" if first_published else "none",
            posted_basis="original" if first_published else "unknown",
            posted_tz_basis="source offset" if first_published else None,
            source_updated_at=parse_iso_datetime(raw.get("updated_at")),
            requisition_id=req,
            office_names=[o["name"] for o in raw.get("offices") or [] if o.get("name")],
        )

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult:
        url = f"{API}/{quote(source.tenant_key)}/jobs/{quote(external_id)}"
        resp = client.get(url)
        if resp.status_code == 200:
            return VerifyResult("active", "job detail returned 200", 200)
        if resp.status_code == 404 and b"Job not found" in resp.content:
            board = self.board_info(client, source)
            if board.exists:
                return VerifyResult("closed", "job 404 'Job not found' while board is healthy", 404)
            return VerifyResult("unknown", "board itself unavailable; not a job closure", 404)
        return VerifyResult("unknown", f"inconclusive status {resp.status_code}", resp.status_code)
