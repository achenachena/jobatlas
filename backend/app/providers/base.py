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
    # For per-page providers: jobs whose detail page was verified recently, so a run can
    # skip them and still re-verify every job at least once per DETAIL_RECHECK window.
    recently_verified: frozenset[str] = frozenset()


@dataclass
class FetchPage:
    records: list[dict[str, Any]]
    next_cursor: str | None
    # True only when the adapter can prove this page set is the full current listing.
    is_complete: bool
    pages_expected: int | None = None
    http_status: int | None = None
    # Jobs the source still lists (e.g. in its sitemap) whose detail was not refetched this
    # run because it was verified recently. Not positive evidence by itself; it only keeps
    # them out of the "unlisted" re-check.
    listed_only: list[str] = field(default_factory=list)


@dataclass
class BoardInfo:
    exists: bool
    company_name: str | None = None
    http_status: int | None = None
    evidence_url: str | None = None


@dataclass(frozen=True)
class StructuredAddress:
    """An address the source itself attaches to the job. Only `street` makes it a candidate
    exact work location; city-only addresses are never placed on the map."""

    street: str | None
    city: str | None
    region: str | None
    postal_code: str | None
    country: str | None
    label: str | None
    method: str

    def one_line(self) -> str:
        parts = [self.street, self.city, self.region, self.postal_code, self.country]
        return ", ".join(p for p in parts if p)


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
    extra_location_labels: list[str] = field(default_factory=list)
    structured_addresses: list[StructuredAddress] = field(default_factory=list)
    # Explicit applicant-location statements (JSON-LD applicantLocationRequirements etc.).
    eligibility_texts: list[str] = field(default_factory=list)
    # Source-declared expiry (JSON-LD validThrough); past -> closure evidence.
    valid_through: datetime | None = None


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
