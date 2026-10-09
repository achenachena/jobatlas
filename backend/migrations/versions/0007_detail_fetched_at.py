"""track when a job's detail page was last read

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "job_source_records",
        sa.Column("detail_fetched_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Existing records were all built from detail pages or full API payloads.
    op.execute("UPDATE job_source_records SET detail_fetched_at = last_seen_at")


def downgrade() -> None:
    op.drop_column("job_source_records", "detail_fetched_at")
