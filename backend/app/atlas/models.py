"""JobAtlas v2 statistics layer.

Kept apart from the v1 street-level job tables: v1 `jobs.is_publishable` is a job-detail rule;
v2 counts come only from sources whose permission record is approved (atlas/permissions.py).
Demo data is never stored here (atlas/demo.py generates it on demand with its own dataset id).
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base

SOURCE_STATUSES = ("pending", "approved", "blocked", "expired")
GEO_STATUSES = ("city", "unconfirmed", "remote")
RELEASE_STATUSES = ("building", "published", "superseded", "failed")
COVERAGE_STATUSES = ("complete", "partial", "missing")
SCOPES = ("city", "national", "unconfirmed", "remote")
BOARD_STATUSES = ("new", "active", "foreign", "gone")


def _in(column: str, values: tuple[str, ...], name: str) -> CheckConstraint:
    return CheckConstraint(f"{column} IN ({', '.join(repr(v) for v in values)})", name=name)


class AtlasSource(Base):
    """Source admission record (§3.3). Status alone is not enough: an approved source also
    needs its evidence fields, checked by atlas.permissions.admitted()."""

    __tablename__ = "atlas_sources"
    __table_args__ = (_in("status", SOURCE_STATUSES, "ck_atlas_sources_status"),)

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    official_domain: Mapped[str | None] = mapped_column(Text)
    terms_url: Mapped[str | None] = mapped_column(Text)
    licence: Mapped[str | None] = mapped_column(Text)
    evidence_ref: Mapped[str | None] = mapped_column(Text)
    verified_on: Mapped[date | None] = mapped_column(Date)
    expires_on: Mapped[date | None] = mapped_column(Date)
    permissions: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    capabilities: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    constraints: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    attribution: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    status_basis: Mapped[str] = mapped_column(Text, nullable=False)
    owner: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AtlasCity(Base):
    """Standard city entities (one layer: populated places, never metros or economic regions).
    Anchors come from GeoNames (CC BY 4.0); `evidence` names the record."""

    __tablename__ = "atlas_cities"

    id: Mapped[str] = mapped_column(String(96), primary_key=True)  # "ca-on-toronto"
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    province: Mapped[str] = mapped_column(String(2), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)  # canonical, original language
    ascii_name: Mapped[str] = mapped_column(Text, nullable=False)
    aliases: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="city")
    population: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    geonameid: Mapped[int | None] = mapped_column(Integer, unique=True)
    evidence: Mapped[str] = mapped_column(Text, nullable=False)


class AtlasGroup(Base):
    """A fixed group of cities drawn as one body in the national view (atlas/groups.py)."""

    __tablename__ = "atlas_groups"
    __table_args__ = (_in("kind", ("cma", "ca", "cluster", "single"), "ck_atlas_groups_kind"),)

    id: Mapped[str] = mapped_column(String(112), primary_key=True)  # "cma-535", "single-…"
    version: Mapped[str] = mapped_column(String(16), nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    official_name: Mapped[str | None] = mapped_column(Text)  # CMA/CA name as published
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    provinces: Mapped[list] = mapped_column(JSONB, nullable=False)  # anchor's first
    anchor_city_id: Mapped[str] = mapped_column(ForeignKey("atlas_cities.id"), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)


class AtlasCityGroup(Base):
    """Every city belongs to exactly one group."""

    __tablename__ = "atlas_city_groups"

    city_id: Mapped[str] = mapped_column(ForeignKey("atlas_cities.id"), primary_key=True)
    group_id: Mapped[str] = mapped_column(ForeignKey("atlas_groups.id"), nullable=False, index=True)


class AtlasPosting(Base):
    """One source record (posting_observations + city membership + classification, §8).
    Only the minimal fields needed to count and explain a count are kept."""

    __tablename__ = "atlas_postings"
    __table_args__ = (
        UniqueConstraint("source_key", "external_id", name="uq_atlas_postings_source_ext"),
        _in("geo_status", GEO_STATUSES, "ck_atlas_postings_geo_status"),
        Index("ix_atlas_postings_source_day", "source_key", "posted_on"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    source_key: Mapped[str] = mapped_column(ForeignKey("atlas_sources.key"), nullable=False)
    external_id: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    noc21: Mapped[str | None] = mapped_column(String(8))
    # Source's original posting date (verified semantics); date precision only.
    posted_on: Mapped[date | None] = mapped_column(Date)
    posted_basis: Mapped[str] = mapped_column(Text, nullable=False)
    province: Mapped[str | None] = mapped_column(String(2))
    city_raw: Mapped[str | None] = mapped_column(Text)
    postal_fsa: Mapped[str | None] = mapped_column(String(3))
    telework: Mapped[str | None] = mapped_column(String(8))
    external: Mapped[bool | None] = mapped_column(Boolean)
    city_id: Mapped[str | None] = mapped_column(ForeignKey("atlas_cities.id"))
    geo_status: Mapped[str] = mapped_column(String(16), nullable=False)
    occupation_id: Mapped[str] = mapped_column(String(48), nullable=False)
    classification_version: Mapped[str] = mapped_column(String(16), nullable=False)
    classification_evidence: Mapped[str | None] = mapped_column(Text)
    resource_id: Mapped[str] = mapped_column(Text, nullable=False)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AtlasCoverage(Base):
    """What a source covers, period by period (coverage_intervals, §8)."""

    __tablename__ = "atlas_coverage"
    __table_args__ = (
        UniqueConstraint("source_key", "period_start", name="uq_atlas_coverage_period"),
        _in("status", COVERAGE_STATUSES, "ck_atlas_coverage_status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    source_key: Mapped[str] = mapped_column(ForeignKey("atlas_sources.key"), nullable=False)
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)  # inclusive
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    resource_id: Mapped[str | None] = mapped_column(Text)
    resource_modified: Mapped[str | None] = mapped_column(Text)
    rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    checksum: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    imported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AtlasBoard(Base):
    """An employer job board on a public ATS posting API (atlas/ats.py). `new` boards are
    candidates not yet fetched; `active` ones list Canadian postings and are polled hourly;
    `foreign` (no Canadian postings) and `gone` (404) are rechecked monthly."""

    __tablename__ = "atlas_boards"
    __table_args__ = (
        _in("status", BOARD_STATUSES, "ck_atlas_boards_status"),
        Index("ix_atlas_boards_due", "next_check_at"),
    )

    platform: Mapped[str] = mapped_column(String(16), primary_key=True)
    slug: Mapped[str] = mapped_column(String(128), primary_key=True)
    company: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="new")
    canada_jobs: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    found_via: Mapped[str] = mapped_column(Text, nullable=False)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    baseline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ok_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_check_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    error: Mapped[str | None] = mapped_column(Text)


class AtlasRelease(Base):
    """An immutable, atomically published data version (dataset_releases, §8)."""

    __tablename__ = "atlas_releases"
    __table_args__ = (_in("status", RELEASE_STATUSES, "ck_atlas_releases_status"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    dataset_id: Mapped[str] = mapped_column(String(48), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    data_through: Mapped[date | None] = mapped_column(Date)
    history_start: Mapped[date | None] = mapped_column(Date)
    source_set_id: Mapped[str] = mapped_column(Text, nullable=False)
    classification_version: Mapped[str] = mapped_column(String(16), nullable=False)
    coverage: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    quality: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    change_kind: Mapped[str] = mapped_column(Text, nullable=False, default="update")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AtlasDailyMetric(Base):
    """Daily base counts per release (daily_city_metrics, §8). Windows are sums of these."""

    __tablename__ = "atlas_daily_metrics"
    __table_args__ = (
        _in("scope", SCOPES, "ck_atlas_daily_metrics_scope"),
        Index("ix_atlas_daily_metrics_lookup", "release_id", "metric", "occupation_id", "day"),
    )

    release_id: Mapped[str] = mapped_column(
        ForeignKey("atlas_releases.id", ondelete="CASCADE"), primary_key=True
    )
    metric: Mapped[str] = mapped_column(String(32), primary_key=True)
    occupation_id: Mapped[str] = mapped_column(String(48), primary_key=True)
    scope: Mapped[str] = mapped_column(String(16), primary_key=True)
    city_id: Mapped[str] = mapped_column(String(96), primary_key=True)  # "" unless scope=city
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    count: Mapped[int] = mapped_column(Integer, nullable=False)


class AtlasOverview(Base):
    """A release's prepared history overview for one occupation and window, gzipped JSON
    (atlas/overview.py). Built once, never changed; removed with its release."""

    __tablename__ = "atlas_overviews"

    release_id: Mapped[str] = mapped_column(
        ForeignKey("atlas_releases.id", ondelete="CASCADE"), primary_key=True
    )
    occupation: Mapped[str] = mapped_column(String(48), primary_key=True)
    window: Mapped[str] = mapped_column(String(8), primary_key=True)
    format: Mapped[int] = mapped_column(Integer, primary_key=True)
    body: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
