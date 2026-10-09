"""allow enterprise career-site providers

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW = "('greenhouse', 'ashby', 'lever', 'jsonld', 'successfactors', 'workday')"
OLD = "('greenhouse', 'ashby', 'lever', 'jsonld')"


def upgrade() -> None:
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {NEW}")


def downgrade() -> None:
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {OLD}")
