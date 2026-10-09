"""Public API response models (DEVELOPMENT.md §9). They are the contract the web app's
generated types (packages/api-client) are built from; missing values are null, never
invented defaults."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Workplace = Literal["on_site", "hybrid", "remote", "unknown"]
LocationStatus = Literal["exact_work_location", "inferred_office", "company_location", "unverified"]
Group = Literal["in_view", "remote_elsewhere", "location_unverified"]


class Salary(BaseModel):
    min: float | None
    max: float | None
    currency: str | None
    period: str | None
    raw_text: str | None


class Marker(BaseModel):
    lon: float
    lat: float
    role: Literal["work_site", "company_office", "headquarters"]
    address: str | None


class JobCard(BaseModel):
    id: str
    title: str | None
    company: str | None
    workplace_type: Workplace
    location_status: LocationStatus
    location_label: str | None
    markers: list[Marker]
    remote_eligibility_text: str | None
    posted_at: str | None
    posted_date: str | None
    posted_precision: Literal["datetime", "date", "none"]
    posted_basis: Literal["original", "republished_only", "unknown"]
    first_seen_at: str
    listed_after: str | None = Field(
        description="The posting was absent from the source's complete listing fetched at this "
        "time, so it first appeared after it. Not a posting time."
    )
    last_verified_at: str
    employment_type: str | None
    salary: Salary | None
    apply_url: str | None


class GroupPage(BaseModel):
    items: list[JobCard]
    next_cursor: str | None


class Counts(BaseModel):
    total: int
    in_view: int
    remote_elsewhere: int
    location_unverified: int


class Groups(BaseModel):
    in_view: GroupPage
    remote_elsewhere: GroupPage
    location_unverified: GroupPage


class Filters(BaseModel):
    q: str | None
    region_id: str
    bbox: list[float]
    time_window: str
    workplace: str


class MapMeta(BaseModel):
    complete: bool
    mode: Literal["points", "clusters"]
    unique_job_count: int
    marker_count: int


class Warning(BaseModel):
    code: str
    message: str
    count: int | None = None


class FeatureCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[dict[str, Any]]


class SearchResponse(BaseModel):
    search_id: str
    as_of: str
    expires_at: str
    filters: Filters
    counts: Counts
    groups: Groups
    map: FeatureCollection
    map_meta: MapMeta
    warnings: list[Warning]


class SearchPage(BaseModel):
    search_id: str
    group: Group
    as_of: str
    items: list[JobCard]
    next_cursor: str | None


class Evidence(BaseModel):
    method: str | None
    excerpt: str | None
    source_url: str | None
    observed_at: str | None


class DetailLocation(BaseModel):
    role: Literal["work_site", "company_office", "headquarters"]
    address: str | None
    coordinates: list[float] | None
    precision: str
    evidence: Evidence


class EligibilityRegion(BaseModel):
    id: str
    name: str
    include_or_exclude: Literal["include", "exclude"]


class Eligibility(BaseModel):
    status: Literal["not_applicable", "unknown", "known"]
    text: str | None
    regions: list[EligibilityRegion]
    note: str | None


class CompanyRef(BaseModel):
    name: str | None
    website: str | None


class SourceRef(BaseModel):
    provider: str
    board_url: str | None
    job_url: str | None
    source_updated_at: str | None
    source_republished_at: str | None
    last_seen_at: str | None


class JobDetail(BaseModel):
    id: str
    title: str | None
    company: CompanyRef
    workplace_type: Workplace
    status: Literal["active", "pending_verification", "closed"]
    is_open_opportunity: bool = Field(
        description="False for Closed/Pending/stale jobs; they are never shown as open"
    )
    posted_at: str | None
    posted_date: str | None
    posted_precision: Literal["datetime", "date", "none"]
    posted_basis: Literal["original", "republished_only", "unknown"]
    first_seen_at: str | None
    listed_after: str | None = Field(
        description="The posting was absent from the source's complete listing fetched at this "
        "time, so it first appeared after it. Not a posting time."
    )
    last_verified_at: str | None
    closed_at: str | None
    close_reason: str | None
    location_status: LocationStatus
    location_label: str | None
    locations: list[DetailLocation]
    eligibility: Eligibility
    employment_type: str | None
    salary: Salary | None
    description_text: str | None
    source: SourceRef | None
    sources: list[SourceRef]
    apply_url: str | None


class Region(BaseModel):
    region_id: str
    name: str
    parent_id: str | None
    kind: str
    bbox: list[float]
    approximate: bool
    dataset_version: str | None


class RegionList(BaseModel):
    items: list[Region]


class ProviderCoverage(BaseModel):
    sources: int
    by_status: dict[str, int]


class JobCounts(BaseModel):
    open_jobs: int
    pending: int
    closed: int
    located: int


class DiscoveryRunRef(BaseModel):
    finished_at: str | None
    status: str


class Coverage(BaseModel):
    as_of: str
    sources: dict[str, ProviderCoverage]
    failing_sources: int
    last_successful_sync_at: str | None
    jobs: JobCounts
    last_discovery_run: DiscoveryRunRef | None
    limitations: list[str]
