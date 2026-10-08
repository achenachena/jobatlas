"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import geoalchemy2
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "companies",
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("canonical_domain", sa.Text(), nullable=True),
        sa.Column("website_url", sa.Text(), nullable=True),
        sa.Column("identity_status", sa.String(length=16), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "identity_status IN ('unverified', 'verified')", name="ck_companies_identity_status"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "discovery_candidates",
        sa.Column("canonical_url", sa.Text(), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=True),
        sa.Column("tenant_key", sa.Text(), nullable=True),
        sa.Column("channel", sa.String(length=32), nullable=False),
        sa.Column("channel_ref", sa.Text(), nullable=True),
        sa.Column("sample_url", sa.Text(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("source_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "state IN ('new', 'accepted', 'rejected', 'deferred')",
            name="ck_discovery_candidates_state",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("canonical_url", name="uq_discovery_candidates_url"),
    )
    op.create_index(
        "ix_discovery_candidates_state",
        "discovery_candidates",
        ["state", "first_seen_at"],
        unique=False,
    )
    op.create_table(
        "discovery_runs",
        sa.Column("channel", sa.String(length=32), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("stats", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "discovery_watermarks",
        sa.Column("channel", sa.String(length=32), nullable=False),
        sa.Column("collection", sa.Text(), nullable=False),
        sa.Column("pattern", sa.Text(), nullable=False),
        sa.Column("blocks_total", sa.Integer(), nullable=True),
        sa.Column("next_block", sa.Integer(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("channel", "collection", "pattern", name="uq_discovery_watermarks"),
    )
    op.create_table(
        "evidence",
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.UUID(), nullable=False),
        sa.Column("field", sa.String(length=64), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("excerpt", sa.Text(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("method", sa.String(length=48), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_evidence_entity", "evidence", ["entity_type", "entity_id"], unique=False)
    op.create_table(
        "locations",
        sa.Column("normalized_address", sa.Text(), nullable=False),
        sa.Column("country", sa.String(length=2), nullable=True),
        sa.Column("province", sa.Text(), nullable=True),
        sa.Column("city", sa.Text(), nullable=True),
        sa.Column("postal_code", sa.Text(), nullable=True),
        sa.Column(
            "point",
            geoalchemy2.types.Geometry(
                geometry_type="POINT",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
            ),
            nullable=True,
        ),
        sa.Column("precision", sa.String(length=16), nullable=False),
        sa.Column("geocoder", sa.Text(), nullable=True),
        sa.Column("geocoded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("geocode_error", sa.Text(), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "precision IN ('rooftop', 'street', 'postal', 'city', 'region', 'unknown')",
            name="ck_locations_precision",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("normalized_address", name="uq_locations_normalized_address"),
    )
    op.create_index(
        "ix_locations_point", "locations", ["point"], unique=False, postgresql_using="gist"
    )
    op.create_table(
        "regions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("parent_id", sa.String(length=64), nullable=True),
        sa.Column("country_code", sa.String(length=2), nullable=True),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column(
            "geometry",
            geoalchemy2.types.Geometry(
                geometry_type="MULTIPOLYGON",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
            ),
            nullable=True,
        ),
        sa.Column(
            "bbox",
            geoalchemy2.types.Geometry(
                geometry_type="POLYGON",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
            ),
            nullable=True,
        ),
        sa.Column("geometry_is_approximate", sa.Boolean(), nullable=False),
        sa.Column("dataset_version", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["regions.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_regions_geometry", "regions", ["geometry"], unique=False, postgresql_using="gist"
    )
    op.create_table(
        "task_runs",
        sa.Column("task_type", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_type", "idempotency_key", name="uq_task_runs_idem"),
    )
    op.create_index("ix_task_runs_next_retry", "task_runs", ["next_retry_at"], unique=False)
    op.create_table(
        "jobs",
        sa.Column("company_id", sa.UUID(), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column(
            "title_tsv",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('simple', coalesce(title, ''))", persisted=True),
            nullable=False,
        ),
        sa.Column("description_text", sa.Text(), nullable=True),
        sa.Column("workplace_type", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("is_publishable", sa.Boolean(), nullable=False),
        sa.Column("quarantine_reason", sa.Text(), nullable=True),
        sa.Column("posted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("posted_date", sa.Date(), nullable=True),
        sa.Column("posted_precision", sa.String(length=16), nullable=False),
        sa.Column("posted_basis", sa.String(length=24), nullable=False),
        sa.Column("posted_tz_basis", sa.Text(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("close_reason", sa.Text(), nullable=True),
        sa.Column("employment_type", sa.Text(), nullable=True),
        sa.Column("salary_min", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("salary_max", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("salary_currency", sa.String(length=3), nullable=True),
        sa.Column("salary_period", sa.String(length=16), nullable=True),
        sa.Column("salary_raw", sa.Text(), nullable=True),
        sa.Column("apply_url", sa.Text(), nullable=True),
        sa.Column("location_text", sa.Text(), nullable=True),
        sa.Column("location_status", sa.String(length=24), nullable=False),
        sa.Column("remote_eligibility_text", sa.Text(), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "location_status IN ('exact_work_location', 'company_location', 'unverified')",
            name="ck_jobs_location_status",
        ),
        sa.CheckConstraint(
            "posted_basis IN ('original', 'republished_only', 'unknown')",
            name="ck_jobs_posted_basis",
        ),
        sa.CheckConstraint(
            "posted_precision IN ('datetime', 'date', 'none')", name="ck_jobs_posted_precision"
        ),
        sa.CheckConstraint(
            "status IN ('active', 'pending_verification', 'closed')", name="ck_jobs_status"
        ),
        sa.CheckConstraint(
            "workplace_type IN ('on_site', 'hybrid', 'remote', 'unknown')",
            name="ck_jobs_workplace_type",
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_jobs_last_verified_at", "jobs", ["last_verified_at"], unique=False)
    op.create_index("ix_jobs_status_posted", "jobs", ["status", "posted_at"], unique=False)
    op.create_index(
        "ix_jobs_title_trgm",
        "jobs",
        ["title"],
        unique=False,
        postgresql_using="gin",
        postgresql_ops={"title": "gin_trgm_ops"},
    )
    op.create_index(
        "ix_jobs_title_tsv", "jobs", ["title_tsv"], unique=False, postgresql_using="gin"
    )
    op.create_table(
        "sources",
        sa.Column("company_id", sa.UUID(), nullable=True),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("tenant_key", sa.Text(), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("discovered_via", sa.String(length=32), nullable=False),
        sa.Column("discovery_url", sa.Text(), nullable=True),
        sa.Column("discovery_candidate_id", sa.UUID(), nullable=True),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_count", sa.Integer(), nullable=False),
        sa.Column("policy_status", sa.String(length=48), nullable=False),
        sa.Column("policy_note", sa.Text(), nullable=True),
        sa.Column("locked_by", sa.Text(), nullable=True),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("relevant_job_count", sa.Integer(), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "provider IN ('greenhouse', 'ashby', 'lever', 'jsonld')", name="ck_sources_provider"
        ),
        sa.CheckConstraint(
            "status IN ('active', 'idle', 'failing', 'disabled')", name="ck_sources_status"
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
        ),
        sa.ForeignKeyConstraint(
            ["discovery_candidate_id"],
            ["discovery_candidates.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider", "tenant_key", name="uq_sources_provider_tenant"),
    )
    op.create_index("ix_sources_next_run_at", "sources", ["next_run_at"], unique=False)
    op.create_foreign_key(
        "fk_discovery_candidates_source_id",
        "discovery_candidates",
        "sources",
        ["source_id"],
        ["id"],
    )
    op.create_table(
        "job_eligibility_regions",
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column("region_id", sa.String(length=64), nullable=False),
        sa.Column("include_or_exclude", sa.String(length=8), nullable=False),
        sa.Column("evidence_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("include_or_exclude IN ('include', 'exclude')", name="ck_job_elig_mode"),
        sa.ForeignKeyConstraint(
            ["evidence_id"],
            ["evidence.id"],
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["jobs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["regions.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "region_id", "include_or_exclude", name="uq_job_elig"),
    )
    op.create_index(
        op.f("ix_job_eligibility_regions_job_id"),
        "job_eligibility_regions",
        ["job_id"],
        unique=False,
    )
    op.create_table(
        "job_locations",
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column("location_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.String(length=24), nullable=False),
        sa.Column("verification_status", sa.String(length=16), nullable=False),
        sa.Column("evidence_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('work_site', 'company_office', 'headquarters')", name="ck_job_locations_role"
        ),
        sa.CheckConstraint(
            "verification_status IN ('verified', 'unverified', 'invalidated')",
            name="ck_job_locations_verification",
        ),
        sa.ForeignKeyConstraint(
            ["evidence_id"],
            ["evidence.id"],
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["jobs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["location_id"],
            ["locations.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "location_id", "role", name="uq_job_locations"),
    )
    op.create_index(op.f("ix_job_locations_job_id"), "job_locations", ["job_id"], unique=False)
    op.create_table(
        "source_runs",
        sa.Column("source_id", sa.UUID(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("is_complete", sa.Boolean(), nullable=False),
        sa.Column("pages_expected", sa.Integer(), nullable=True),
        sa.Column("pages_received", sa.Integer(), nullable=False),
        sa.Column("records_seen", sa.Integer(), nullable=False),
        sa.Column("records_relevant", sa.Integer(), nullable=False),
        sa.Column("jobs_created", sa.Integer(), nullable=False),
        sa.Column("jobs_updated", sa.Integer(), nullable=False),
        sa.Column("error_class", sa.Text(), nullable=True),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("task_id", sa.Text(), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('running', 'succeeded', 'partial', 'failed')", name="ck_source_runs_status"
        ),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["sources.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_source_runs_source", "source_runs", ["source_id", "started_at"], unique=False
    )
    op.create_table(
        "job_events",
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column("from_status", sa.String(length=24), nullable=True),
        sa.Column("to_status", sa.String(length=24), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("source_run_id", sa.UUID(), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["jobs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["source_run_id"],
            ["source_runs.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_job_events_job", "job_events", ["job_id", "occurred_at"], unique=False)
    op.create_table(
        "job_source_records",
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column("source_id", sa.UUID(), nullable=False),
        sa.Column("external_id", sa.Text(), nullable=False),
        sa.Column("requisition_id", sa.Text(), nullable=True),
        sa.Column("canonical_url", sa.Text(), nullable=True),
        sa.Column("raw_hash", sa.String(length=64), nullable=False),
        sa.Column("source_posted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_republished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_run_id", sa.UUID(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consecutive_missing", sa.Integer(), nullable=False),
        sa.Column("first_missing_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["jobs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["last_seen_run_id"],
            ["source_runs.id"],
        ),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["sources.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_id", "external_id", name="uq_job_source_records_source_ext"),
    )
    op.create_index(
        op.f("ix_job_source_records_job_id"), "job_source_records", ["job_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_job_source_records_job_id"), table_name="job_source_records")
    op.drop_table("job_source_records")
    op.drop_index("ix_job_events_job", table_name="job_events")
    op.drop_table("job_events")
    op.drop_index("ix_source_runs_source", table_name="source_runs")
    op.drop_table("source_runs")
    op.drop_index(op.f("ix_job_locations_job_id"), table_name="job_locations")
    op.drop_table("job_locations")
    op.drop_index(op.f("ix_job_eligibility_regions_job_id"), table_name="job_eligibility_regions")
    op.drop_table("job_eligibility_regions")
    op.drop_constraint(
        "fk_discovery_candidates_source_id", "discovery_candidates", type_="foreignkey"
    )
    op.drop_index("ix_sources_next_run_at", table_name="sources")
    op.drop_table("sources")
    op.drop_index("ix_jobs_title_tsv", table_name="jobs", postgresql_using="gin")
    op.drop_index(
        "ix_jobs_title_trgm",
        table_name="jobs",
        postgresql_using="gin",
        postgresql_ops={"title": "gin_trgm_ops"},
    )
    op.drop_index("ix_jobs_status_posted", table_name="jobs")
    op.drop_index("ix_jobs_last_verified_at", table_name="jobs")
    op.drop_table("jobs")
    op.drop_index("ix_task_runs_next_retry", table_name="task_runs")
    op.drop_table("task_runs")
    op.drop_index("ix_regions_geometry", table_name="regions", postgresql_using="gist")
    op.drop_table("regions")
    op.drop_index("ix_locations_point", table_name="locations", postgresql_using="gist")
    op.drop_table("locations")
    op.drop_index("ix_evidence_entity", table_name="evidence")
    op.drop_table("evidence")
    op.drop_table("discovery_watermarks")
    op.drop_table("discovery_runs")
    op.drop_index("ix_discovery_candidates_state", table_name="discovery_candidates")
    op.drop_table("discovery_candidates")
    op.drop_table("companies")
