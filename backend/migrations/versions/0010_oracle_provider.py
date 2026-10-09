"""allow the Oracle Recruiting Cloud provider

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-09
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD = "('greenhouse', 'ashby', 'lever', 'jsonld', 'successfactors', 'workday', 'bamboohr', 'workable')"
NEW = OLD[:-1] + ", 'oracle')"


def upgrade() -> None:
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {NEW}")


def downgrade() -> None:
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {OLD}")
