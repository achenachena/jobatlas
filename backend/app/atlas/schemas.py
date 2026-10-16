"""v2 atlas response models (spec §9). OpenAPI + generated TypeScript types follow these."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

DataMode = Literal["real", "demo", "not_configured"]
Quality = Literal["complete", "partial", "missing", "not_covered", "stale"]
BACKFILLED_DAYS = (
    "days of the window that are backfilled: counted only from postings still open when "
    "collection started, so the value is a lower bound (0: none). Independent of quality, "
    "which says whether days are missing."
)


class StatsMeta(BaseModel):
    dataset_id: str
    data_mode: DataMode
    release_id: str
    metric: Literal["new_postings"] = "new_postings"
    unit: str = Field("job postings first published in the window (not hires, not total vacancies)")
    reporting_timezone: str = "America/Toronto"
    window: Literal["1d", "7d", "30d"]
    window_start: str
    window_end: str = Field(description="exclusive upper bound")
    data_through: str
    generated_at: str
    source_set_id: str
    classification_version: str
    completeness: Quality
    stale: bool
    partial_day: bool = Field(description="the last day of the window is not over yet")


class CityCount(BaseModel):
    city_id: str
    count: int | None = Field(description="null when unknown (not covered, gap); 0 is a real zero")
    quality: Quality


class NationalSummary(BaseModel):
    total_unique: int | None = Field(
        description="distinct postings in the window, nationally (cities + unconfirmed + "
        "remote); null when it cannot be computed"
    )
    total_reason: str | None = None
    city_unconfirmed: int | None
    remote_canada: int | None


class FrameResponse(StatsMeta):
    date: str
    occupation: str
    cities: list[CityCount]
    national: NationalSummary
    notes: list[str]
    backfilled_days: int = Field(description=BACKFILLED_DAYS)


class TimelineFrame(BaseModel):
    date: str
    quality: Quality
    days_available: int
    counts: list[int | None] = Field(description="aligned with TimelineResponse.city_ids")
    national: int | None
    notes: list[str]
    backfilled_days: int = Field(description=BACKFILLED_DAYS)


class TimelineResponse(BaseModel):
    dataset_id: str
    data_mode: DataMode
    release_id: str
    metric: Literal["new_postings"] = "new_postings"
    occupation: str
    window: Literal["1d", "7d", "30d"]
    reporting_timezone: str = "America/Toronto"
    start: str
    end: str
    city_ids: list[str]
    frames: list[TimelineFrame]
    max_count: int = Field(description="largest count in this range, for a fixed scale")


class SeriesPoint(BaseModel):
    date: str
    count: int | None
    quality: Quality
    backfilled_days: int = Field(description=BACKFILLED_DAYS)


class SeriesResponse(BaseModel):
    dataset_id: str
    data_mode: DataMode
    release_id: str
    city_id: str
    occupation: str
    window: Literal["1d", "7d", "30d"]
    points: list[SeriesPoint]


class City(BaseModel):
    city_id: str
    name: str
    province: str
    country: str
    lat: float
    lon: float
    population: int
    aliases: list[str]
    kind: str
    evidence: str


class CitiesResponse(BaseModel):
    dataset_id: str
    data_mode: DataMode
    release_id: str
    cities: list[City]
    attribution: str


class OccupationInfo(BaseModel):
    id: str
    label: str
    note: str


class Gap(BaseModel):
    start: str
    end: str
    reason: str


class Capabilities(BaseModel):
    dataset_id: str
    data_mode: DataMode
    release_id: str | None
    reason: str | None = Field(None, description="why real data is not available")
    metrics: list[str]
    occupations: list[OccupationInfo]
    windows: list[str]
    default_window: str
    geo_levels: list[str]
    history_start: str | None
    data_through: str | None
    partial_latest_day: bool
    gaps: list[Gap]
    playback: bool
    playback_reason: str | None
    stale: bool
    publication: str
    refresh: Literal["monthly", "hourly", "on_request"] = Field(
        description="how often the data changes: monthly (Job Bank), hourly (Employer boards), "
        "on_request (demo)"
    )
    backfilled: list[Gap] = Field(
        description="days counted only from postings still open when collection started "
        "(lower bounds); empty when none"
    )
    employers: int | None = Field(
        description="employers (job boards) with at least one posting counted in this release; "
        "null when the dataset has no employer breakdown or the release predates the count"
    )
    platforms: list[str] = Field(description="job-board platforms counted in this release")
    attribution: str | None = Field(description="credit line to show with this dataset")
    reporting_timezone: str = "America/Toronto"
    quality: dict


class VersionResponse(BaseModel):
    dataset_id: str
    data_mode: DataMode
    release_id: str | None
    data_through: str | None
    published_at: str | None
    change_kind: str | None


class SourceInfo(BaseModel):
    key: str
    provider: str
    status: str
    admitted: bool
    reason: str
    licence: str | None
    terms_url: str | None
    attribution: str | None
    capabilities: dict
    verified_on: str | None


class SourcesResponse(BaseModel):
    sources: list[SourceInfo]
    definitions: dict[str, str]
    attributions: list[str]
