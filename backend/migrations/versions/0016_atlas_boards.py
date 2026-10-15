"""Employer job boards on public ATS posting APIs (the "Employer boards" dataset).

Rollback: `alembic downgrade 0015` drops atlas_boards; ATS postings stay in atlas_postings
under their own source keys and can be removed with
`DELETE FROM atlas_postings WHERE source_key LIKE 'ats-%'`.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "atlas_boards",
        sa.Column("platform", sa.String(16), primary_key=True),
        sa.Column("slug", sa.String(128), primary_key=True),
        sa.Column("company", sa.Text),
        sa.Column("status", sa.String(16), nullable=False, server_default="new"),
        sa.Column("canada_jobs", sa.Integer, nullable=False, server_default="0"),
        sa.Column("found_via", sa.Text, nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column("baseline_at", sa.DateTime(timezone=True)),
        sa.Column("ok_at", sa.DateTime(timezone=True)),
        sa.Column("next_check_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column("error", sa.Text),
        sa.CheckConstraint("status IN ('new', 'active', 'foreign', 'gone')",
                           name="ck_atlas_boards_status"),
    )  # fmt: skip
    op.create_index("ix_atlas_boards_due", "atlas_boards", ["next_check_at"])


def downgrade() -> None:
    op.drop_index("ix_atlas_boards_due", table_name="atlas_boards")
    op.drop_table("atlas_boards")
