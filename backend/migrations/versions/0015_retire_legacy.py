"""Remove retired v1 data. Irreversible: no legacy data backup is created.

Schema-only historical migrations remain to support existing databases upgrading to head.
"""

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

LEGACY_TABLES = (
    "companies",
    "company_locations",
    "discovery_candidates",
    "discovery_runs",
    "discovery_watermarks",
    "evidence",
    "intake_runs",
    "job_eligibility_regions",
    "job_events",
    "job_leads",
    "job_locations",
    "job_source_records",
    "jobs",
    "locations",
    "regions",
    "site_resolutions",
    "source_runs",
    "sources",
    "task_runs",
)


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS " + ", ".join(LEGACY_TABLES) + " CASCADE")
    # These were unused declarations, never an input to a v2 release.
    op.execute(
        "DELETE FROM atlas_sources WHERE key IN "
        "('ats-public-boards', 'linkedin', 'adzuna', 'statcan-job-vacancies')"
    )


def downgrade() -> None:
    raise RuntimeError("Legacy retirement is irreversible; deleted data is not recoverable here.")
