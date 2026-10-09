"""inferred_office location status; fair re-check schedule for unlisted jobs

- jobs.location_status gains 'inferred_office': the job's only work-site evidence is the
  company's single published address in its city (shown on the map, not labelled verified).
  Existing jobs are relabelled from their evidence.
- job_source_records.next_verify_at / verify_failures: re-checks of jobs a partial listing no
  longer shows run earliest-due first, with backoff after failures.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD = "('exact_work_location', 'company_location', 'unverified')"
NEW = "('exact_work_location', 'inferred_office', 'company_location', 'unverified')"


def upgrade() -> None:
    op.drop_constraint("ck_jobs_location_status", "jobs", type_="check")
    op.create_check_constraint("ck_jobs_location_status", "jobs", f"location_status IN {NEW}")
    # Relabel: a work site counts as verified only with job- or site-derived evidence.
    op.execute(
        """
        UPDATE jobs j SET location_status = 'inferred_office'
        WHERE j.location_status = 'exact_work_location'
          AND NOT EXISTS (
            SELECT 1 FROM job_locations jl
            JOIN evidence e ON e.id = jl.evidence_id
            JOIN locations l ON l.id = jl.location_id
            WHERE jl.job_id = j.id AND jl.role = 'work_site'
              AND jl.verification_status = 'verified'
              AND l.point IS NOT NULL AND l.precision IN ('rooftop', 'street')
              AND e.method <> 'company_single_city_office')
        """
    )
    op.add_column("job_source_records", sa.Column("next_verify_at", sa.DateTime(timezone=True)))
    op.add_column(
        "job_source_records",
        sa.Column("verify_failures", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("job_source_records", "verify_failures")
    op.drop_column("job_source_records", "next_verify_at")
    op.execute(
        "UPDATE jobs SET location_status = 'exact_work_location' "
        "WHERE location_status = 'inferred_office'"
    )
    op.drop_constraint("ck_jobs_location_status", "jobs", type_="check")
    op.create_check_constraint("ck_jobs_location_status", "jobs", f"location_status IN {OLD}")
