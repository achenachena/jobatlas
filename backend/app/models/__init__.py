"""Logical data model (DEVELOPMENT.md §5).

Enumerations are stored as text guarded by CHECK constraints so that adding a value is a
plain migration. Every timestamp is timezone-aware.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from geoalchemy2 import Geometry
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _check_in(column: str, values: tuple[str, ...], name: str) -> CheckConstraint:
    quoted = ", ".join(f"'{v}'" for v in values)
    return CheckConstraint(f"{column} IN ({quoted})", name=name)


WORKPLACE_TYPES = ("on_site", "hybrid", "remote", "unknown")
JOB_STATUSES = ("active", "pending_verification", "closed")
POSTED_PRECISION = ("datetime", "date", "none")
POSTED_BASIS = ("original", "republished_only", "unknown")
LOCATION_STATUSES = ("exact_work_location", "company_location", "unverified")
SOURCE_STATUSES = ("active", "idle", "failing", "disabled")
PROVIDERS = ("greenhouse", "ashby", "lever", "jsonld", "successfactors", "workday")
CANDIDATE_STATES = ("new", "accepted", "rejected", "deferred")
RUN_STATUSES = ("running", "succeeded", "partial", "failed")


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Company(TimestampMixin, Base):
    __tablename__ = "companies"
    __table_args__ = (
        _check_in("identity_status", ("unverified", "verified"), "ck_companies_identity_status"),
    )

    # Same name never implies the same company; identity is tied to sources/domains.
    name: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_domain: Mapped[str | None] = mapped_column(Text)
    website_url: Mapped[str | None] = mapped_column(Text)
    identity_status: Mapped[str] = mapped_column(String(16), nullable=False, default="unverified")
    offices_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Source(TimestampMixin, Base):
    __tablename__ = "sources"
    __table_args__ = (
        UniqueConstraint("provider", "tenant_key", name="uq_sources_provider_tenant"),
        _check_in("provider", PROVIDERS, "ck_sources_provider"),
        _check_in("status", SOURCE_STATUSES, "ck_sources_status"),
        Index("ix_sources_next_run_at", "next_run_at"),
    )

    company_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("companies.id"))
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    tenant_key: Mapped[str] = mapped_column(Text, nullable=False)
    base_url: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    discovered_via: Mapped[str] = mapped_column(String(32), nullable=False)
    discovery_url: Mapped[str | None] = mapped_column(Text)
    discovery_candidate_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("discovery_candidates.id")
    )
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    policy_status: Mapped[str] = mapped_column(String(48), nullable=False)
    policy_note: Mapped[str | None] = mapped_column(Text)
    # Run lock: a worker owns the source until locked_until; expired locks are reclaimable.
    locked_by: Mapped[str | None] = mapped_column(Text)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    relevant_job_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class DiscoveryCandidate(TimestampMixin, Base):
    __tablename__ = "discovery_candidates"
    __table_args__ = (
        UniqueConstraint("canonical_url", name="uq_discovery_candidates_url"),
        _check_in("state", CANDIDATE_STATES, "ck_discovery_candidates_state"),
        Index("ix_discovery_candidates_state", "state", "first_seen_at"),
    )

    canonical_url: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str | None] = mapped_column(String(32))
    tenant_key: Mapped[str | None] = mapped_column(Text)
    channel: Mapped[str] = mapped_column(String(32), nullable=False)
    channel_ref: Mapped[str | None] = mapped_column(Text)  # e.g. CC collection id
    sample_url: Mapped[str | None] = mapped_column(Text)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="new")
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    source_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sources.id", use_alter=True, name="fk_discovery_candidates_source_id")
    )


class DiscoveryWatermark(TimestampMixin, Base):
    """Per channel/collection/pattern progress so an interrupted run resumes where it left."""

    __tablename__ = "discovery_watermarks"
    __table_args__ = (
        UniqueConstraint("channel", "collection", "pattern", name="uq_discovery_watermarks"),
    )

    channel: Mapped[str] = mapped_column(String(32), nullable=False)
    collection: Mapped[str] = mapped_column(Text, nullable=False)
    pattern: Mapped[str] = mapped_column(Text, nullable=False)
    blocks_total: Mapped[int | None] = mapped_column(Integer)
    next_block: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Job(TimestampMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (
        _check_in("workplace_type", WORKPLACE_TYPES, "ck_jobs_workplace_type"),
        _check_in("status", JOB_STATUSES, "ck_jobs_status"),
        _check_in("posted_precision", POSTED_PRECISION, "ck_jobs_posted_precision"),
        _check_in("posted_basis", POSTED_BASIS, "ck_jobs_posted_basis"),
        _check_in("location_status", LOCATION_STATUSES, "ck_jobs_location_status"),
        _check_in(
            "eligibility_status", ("not_applicable", "unknown", "known"), "ck_jobs_eligibility"
        ),
        Index("ix_jobs_status_posted", "status", "posted_at"),
        Index("ix_jobs_last_verified_at", "last_verified_at"),
        Index("ix_jobs_title_tsv", "title_tsv", postgresql_using="gin"),
        Index(
            "ix_jobs_title_trgm",
            "title",
            postgresql_using="gin",
            postgresql_ops={"title": "gin_trgm_ops"},
        ),
    )

    company_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("companies.id"))
    title: Mapped[str | None] = mapped_column(Text)
    title_tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('simple', coalesce(title, ''))", persisted=True)
    )
    description_text: Mapped[str | None] = mapped_column(Text)
    workplace_type: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    # Rule 9: records lacking title/company/source/apply_url stay internal.
    is_publishable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    quarantine_reason: Mapped[str | None] = mapped_column(Text)

    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    posted_date: Mapped[date | None] = mapped_column(Date)
    posted_precision: Mapped[str] = mapped_column(String(16), nullable=False, default="none")
    posted_basis: Mapped[str] = mapped_column(String(24), nullable=False, default="unknown")
    posted_tz_basis: Mapped[str | None] = mapped_column(Text)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    close_reason: Mapped[str | None] = mapped_column(Text)

    employment_type: Mapped[str | None] = mapped_column(Text)
    salary_min: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    salary_max: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    salary_currency: Mapped[str | None] = mapped_column(String(3))
    salary_period: Mapped[str | None] = mapped_column(String(16))
    salary_raw: Mapped[str | None] = mapped_column(Text)
    apply_url: Mapped[str | None] = mapped_column(Text)

    location_text: Mapped[str | None] = mapped_column(Text)
    # Most specific region the location *label* names (city-level at best). Never a coordinate.
    location_region_id: Mapped[str | None] = mapped_column(ForeignKey("regions.id"), index=True)
    location_status: Mapped[str] = mapped_column(String(24), nullable=False, default="unverified")
    remote_eligibility_text: Mapped[str | None] = mapped_column(Text)
    # unknown = remote without a stated region; known = job_eligibility_regions rows exist;
    # not_applicable = not a remote job.
    eligibility_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="not_applicable"
    )


class JobSourceRecord(TimestampMixin, Base):
    __tablename__ = "job_source_records"
    __table_args__ = (
        UniqueConstraint("source_id", "external_id", name="uq_job_source_records_source_ext"),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), nullable=False, index=True)
    source_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sources.id"), nullable=False)
    external_id: Mapped[str] = mapped_column(Text, nullable=False)
    requisition_id: Mapped[str | None] = mapped_column(Text)
    canonical_url: Mapped[str | None] = mapped_column(Text)
    raw_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    source_posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_republished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("source_runs.id"))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consecutive_missing: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_missing_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Location(TimestampMixin, Base):
    __tablename__ = "locations"
    __table_args__ = (
        _check_in(
            "precision",
            ("rooftop", "street", "postal", "city", "region", "unknown"),
            "ck_locations_precision",
        ),
        Index("ix_locations_point", "point", postgresql_using="gist"),
        UniqueConstraint("normalized_address", name="uq_locations_normalized_address"),
    )

    normalized_address: Mapped[str] = mapped_column(Text, nullable=False)
    display_address: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(String(2))
    province: Mapped[str | None] = mapped_column(Text)
    city: Mapped[str | None] = mapped_column(Text)
    postal_code: Mapped[str | None] = mapped_column(Text)
    # A city-level point is never an exact work location (rule 2).
    point = mapped_column(Geometry("POINT", srid=4326, spatial_index=False))
    precision: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")
    geocoder: Mapped[str | None] = mapped_column(Text)
    geocoded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    geocode_error: Mapped[str | None] = mapped_column(Text)


class Evidence(TimestampMixin, Base):
    __tablename__ = "evidence"
    __table_args__ = (Index("ix_evidence_entity", "entity_type", "entity_id"),)

    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    field: Mapped[str] = mapped_column(String(64), nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text)
    excerpt: Mapped[str | None] = mapped_column(Text)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    method: Mapped[str] = mapped_column(String(48), nullable=False)
    confidence: Mapped[str] = mapped_column(String(16), nullable=False)
    content_hash: Mapped[str | None] = mapped_column(String(64))


class JobLocation(TimestampMixin, Base):
    __tablename__ = "job_locations"
    __table_args__ = (
        _check_in("role", ("work_site", "company_office", "headquarters"), "ck_job_locations_role"),
        _check_in(
            "verification_status",
            ("verified", "unverified", "invalidated"),
            "ck_job_locations_verification",
        ),
        UniqueConstraint("job_id", "location_id", "role", name="uq_job_locations"),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), nullable=False, index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(24), nullable=False)
    verification_status: Mapped[str] = mapped_column(String(16), nullable=False)
    evidence_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("evidence.id"))


class CompanyLocation(TimestampMixin, Base):
    """Official company office / HQ, each backed by evidence. Reusable across that company's
    jobs, but a job only uses it through its own explicit job_locations link."""

    __tablename__ = "company_locations"
    __table_args__ = (
        _check_in("role", ("office", "headquarters"), "ck_company_locations_role"),
        UniqueConstraint("company_id", "location_id", "role", name="uq_company_locations"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id"), nullable=False, index=True
    )
    location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("locations.id"), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str | None] = mapped_column(Text)
    evidence_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("evidence.id"))
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Region(Base):
    __tablename__ = "regions"
    __table_args__ = (Index("ix_regions_geometry", "geometry", postgresql_using="gist"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("regions.id"))
    country_code: Mapped[str | None] = mapped_column(String(2))
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    geometry = mapped_column(Geometry("MULTIPOLYGON", srid=4326, spatial_index=False))
    bbox = mapped_column(Geometry("POLYGON", srid=4326, spatial_index=False))
    geometry_is_approximate: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    dataset_version: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class JobEligibilityRegion(TimestampMixin, Base):
    __tablename__ = "job_eligibility_regions"
    __table_args__ = (
        _check_in("include_or_exclude", ("include", "exclude"), "ck_job_elig_mode"),
        UniqueConstraint("job_id", "region_id", "include_or_exclude", name="uq_job_elig"),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), nullable=False, index=True)
    # 'worldwide' is an explicit region row; absence of rows means eligibility unknown.
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"), nullable=False)
    include_or_exclude: Mapped[str] = mapped_column(String(8), nullable=False)
    evidence_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("evidence.id"))


class JobEvent(TimestampMixin, Base):
    __tablename__ = "job_events"
    __table_args__ = (Index("ix_job_events_job", "job_id", "occurred_at"),)

    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id"), nullable=False)
    from_status: Mapped[str | None] = mapped_column(String(24))
    to_status: Mapped[str] = mapped_column(String(24), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    source_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("source_runs.id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SourceRun(TimestampMixin, Base):
    __tablename__ = "source_runs"
    __table_args__ = (
        _check_in("status", RUN_STATUSES, "ck_source_runs_status"),
        Index("ix_source_runs_source", "source_id", "started_at"),
    )

    source_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sources.id"), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    is_complete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    pages_expected: Mapped[int | None] = mapped_column(Integer)
    pages_received: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    records_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    records_relevant: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    jobs_created: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    jobs_updated: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_class: Mapped[str | None] = mapped_column(Text)
    http_status: Mapped[int | None] = mapped_column(Integer)
    task_id: Mapped[str | None] = mapped_column(Text)


class DiscoveryRun(TimestampMixin, Base):
    __tablename__ = "discovery_runs"

    channel: Mapped[str] = mapped_column(String(32), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    stats: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    error: Mapped[str | None] = mapped_column(Text)


class TaskRun(TimestampMixin, Base):
    __tablename__ = "task_runs"
    __table_args__ = (
        UniqueConstraint("task_type", "idempotency_key", name="uq_task_runs_idem"),
        Index("ix_task_runs_next_retry", "next_retry_at"),
    )

    task_type: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict | None] = mapped_column(JSONB)
