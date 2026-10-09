"""first-appearance bound for jobs without an original posting time

- sources.listing_ids / listing_ids_at: hashed ids of EVERY posting in the source's last
  complete listing (relevant or not) and when that listing was fetched.
- jobs.listed_after: set when a job is created from a posting absent from that previous
  complete listing — the posting first appeared in the source after this time. Not a
  posting time; the UI shows it as "first spotted". Never backfilled: older first sightings
  may stem from rule changes rather than new postings.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sources", sa.Column("listing_ids", JSONB))
    op.add_column("sources", sa.Column("listing_ids_at", sa.DateTime(timezone=True)))
    op.add_column("jobs", sa.Column("listed_after", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.drop_column("jobs", "listed_after")
    op.drop_column("sources", "listing_ids_at")
    op.drop_column("sources", "listing_ids")
