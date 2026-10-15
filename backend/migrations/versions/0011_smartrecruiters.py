"""allow the SmartRecruiters provider

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-13
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD = "('greenhouse', 'ashby', 'lever', 'jsonld', 'successfactors', 'workday', 'bamboohr', 'workable', 'oracle')"
NEW = OLD[:-1] + ", 'smartrecruiters')"


def upgrade() -> None:
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {NEW}")


def downgrade() -> None:
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {OLD}")
