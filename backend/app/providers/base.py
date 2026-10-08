"""Provider adapter contract (DEVELOPMENT.md §6.1).

recognize(url)            -> SourceCandidate | None
fetch_jobs(source, cursor)-> FetchPage
normalize(raw_record)     -> NormalizedJob
verify_job(source, ext_id)-> VerifyResult (active | closed | unknown)
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal, Protocol

from app.net.safe_http import SafeHttpClient

WorkplaceType = Literal["on_site", "hybrid", "remote", "unknown"]
VerifyState = Literal["active", "closed", "unknown"]


@dataclass(frozen=True)
class SourceCandidate:
    provider: str
    tenant_key: str
    canonical_url: str  # one canonical URL per tenant; used to dedupe discovery candidates


@dataclass(frozen=True)
class SourceRef:
    provider: str
    tenant_key: str


@dataclass
class FetchPage:
    records: list[dict[str, Any]]
    next_cursor: str | None
    # True only when the adapter can prove this page set is the full current listing.
    is_complete: bool
    pages_expected: int | None = None
    http_status: int | None = None


@dataclass
class BoardInfo:
    exists: bool
    company_name: str | None = None
    http_status: int | None = None
    evidence_url: str | None = None


@dataclass
class NormalizedJob:
    external_id: str
    title: str | None
    company_name: str | None
    apply_url: str | None
    canonical_url: str | None
    description_text: str | None
    location_text: str | None
    workplace_type: WorkplaceType = "unknown"
    workplace_evidence: str | None = None
    # Posting-time semantics are kept separate (rule 6).
    posted_at: datetime | None = None
    posted_date: date | None = None
    posted_precision: Literal["datetime", "date", "none"] = "none"
    posted_basis: Literal["original", "republished_only", "unknown"] = "unknown"
    posted_tz_basis: str | None = None
    source_updated_at: datetime | None = None
    source_republished_at: datetime | None = None
    requisition_id: str | None = None
    employment_type: str | None = None
    salary_min: Decimal | None = None
    salary_max: Decimal | None = None
    salary_currency: str | None = None
    salary_period: str | None = None
    salary_raw: str | None = None
    office_names: list[str] = field(default_factory=list)


@dataclass
class VerifyResult:
    state: VerifyState
    reason: str
    http_status: int | None = None


class ProviderError(Exception):
    def __init__(self, message: str, *, error_class: str, http_status: int | None = None):
        super().__init__(message)
        self.error_class = error_class
        self.http_status = http_status


class Provider(Protocol):
    name: str
    supports_fetch: bool

    def recognize(self, url: str) -> SourceCandidate | None: ...

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo: ...

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage: ...

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob: ...

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult: ...


def raw_hash(raw: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(raw, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
