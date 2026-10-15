"""JobAtlas v2 statistics layer: source admission, cities, postings, coverage, releases,
daily metrics. Additive only; v1 tables are untouched.

Rollback: `alembic downgrade 0013` drops only these tables (back up first:
`pg_dump -t 'atlas_*'`).

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "atlas_sources",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("provider", sa.Text, nullable=False),
        sa.Column("official_domain", sa.Text),
        sa.Column("terms_url", sa.Text),
        sa.Column("licence", sa.Text),
        sa.Column("evidence_ref", sa.Text),
        sa.Column("verified_on", sa.Date),
        sa.Column("expires_on", sa.Date),
        sa.Column("permissions", JSONB, nullable=False, server_default="{}"),
        sa.Column("capabilities", JSONB, nullable=False, server_default="{}"),
        sa.Column("constraints", JSONB, nullable=False, server_default="{}"),
        sa.Column("attribution", sa.Text),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("status_basis", sa.Text, nullable=False),
        sa.Column("owner", sa.Text, nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),  # fmt: skip
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'blocked', 'expired')",
            name="ck_atlas_sources_status",
        ),
    )
    op.create_table(
        "atlas_cities",
        sa.Column("id", sa.String(96), primary_key=True),
        sa.Column("country", sa.String(2), nullable=False),
        sa.Column("province", sa.String(2), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("ascii_name", sa.Text, nullable=False),
        sa.Column("aliases", JSONB, nullable=False, server_default="[]"),
        sa.Column("kind", sa.String(16), nullable=False, server_default="city"),
        sa.Column("population", sa.Integer, nullable=False, server_default="0"),
        sa.Column("lat", sa.Float, nullable=False),
        sa.Column("lon", sa.Float, nullable=False),
        sa.Column("geonameid", sa.Integer, unique=True),
        sa.Column("evidence", sa.Text, nullable=False),
    )
    op.create_table(
        "atlas_postings",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("source_key", sa.String(64), sa.ForeignKey("atlas_sources.key"), nullable=False),
        sa.Column("external_id", sa.Text, nullable=False),
        sa.Column("title", sa.Text),
        sa.Column("noc21", sa.String(8)),
        sa.Column("posted_on", sa.Date),
        sa.Column("posted_basis", sa.Text, nullable=False),
        sa.Column("province", sa.String(2)),
        sa.Column("city_raw", sa.Text),
        sa.Column("postal_fsa", sa.String(3)),
        sa.Column("telework", sa.String(8)),
        sa.Column("external", sa.Boolean),
        sa.Column("city_id", sa.String(96), sa.ForeignKey("atlas_cities.id")),
        sa.Column("geo_status", sa.String(16), nullable=False),
        sa.Column("occupation_id", sa.String(48), nullable=False),
        sa.Column("classification_version", sa.String(16), nullable=False),
        sa.Column("classification_evidence", sa.Text),
        sa.Column("resource_id", sa.Text, nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source_key", "external_id", name="uq_atlas_postings_source_ext"),
        sa.CheckConstraint(
            "geo_status IN ('city', 'unconfirmed', 'remote')", name="ck_atlas_postings_geo_status"
        ),
    )
    op.create_index("ix_atlas_postings_source_day", "atlas_postings", ["source_key", "posted_on"])
    op.create_table(
        "atlas_coverage",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("source_key", sa.String(64), sa.ForeignKey("atlas_sources.key"), nullable=False),
        sa.Column("period_start", sa.Date, nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("resource_id", sa.Text),
        sa.Column("resource_modified", sa.Text),
        sa.Column("rows", sa.Integer, nullable=False, server_default="0"),
        sa.Column("checksum", sa.Text),
        sa.Column("note", sa.Text),
        sa.Column(
            "imported_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),  # fmt: skip
        sa.UniqueConstraint("source_key", "period_start", name="uq_atlas_coverage_period"),
        sa.CheckConstraint(
            "status IN ('complete', 'partial', 'missing')", name="ck_atlas_coverage_status"
        ),
    )
    op.create_table(
        "atlas_releases",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("dataset_id", sa.String(48), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("data_through", sa.Date),
        sa.Column("history_start", sa.Date),
        sa.Column("source_set_id", sa.Text, nullable=False),
        sa.Column("classification_version", sa.String(16), nullable=False),
        sa.Column("coverage", JSONB, nullable=False, server_default="{}"),
        sa.Column("quality", JSONB, nullable=False, server_default="{}"),
        sa.Column("change_kind", sa.Text, nullable=False, server_default="update"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),  # fmt: skip
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('building', 'published', 'superseded', 'failed')",
            name="ck_atlas_releases_status",
        ),
    )
    op.create_table(
        "atlas_daily_metrics",
        sa.Column(
            "release_id",
            sa.String(64),
            sa.ForeignKey("atlas_releases.id", ondelete="CASCADE"),
            primary_key=True,
        ),  # fmt: skip
        sa.Column("metric", sa.String(32), primary_key=True),
        sa.Column("occupation_id", sa.String(48), primary_key=True),
        sa.Column("scope", sa.String(16), primary_key=True),
        sa.Column("city_id", sa.String(96), primary_key=True),
        sa.Column("day", sa.Date, primary_key=True),
        sa.Column("count", sa.Integer, nullable=False),
        sa.CheckConstraint(
            "scope IN ('city', 'national', 'unconfirmed', 'remote')",
            name="ck_atlas_daily_metrics_scope",
        ),
    )
    op.create_index(
        "ix_atlas_daily_metrics_lookup",
        "atlas_daily_metrics",
        ["release_id", "metric", "occupation_id", "day"],
    )


def downgrade() -> None:
    op.drop_table("atlas_daily_metrics")
    op.drop_table("atlas_releases")
    op.drop_table("atlas_coverage")
    op.drop_table("atlas_postings")
    op.drop_table("atlas_cities")
    op.drop_table("atlas_sources")
