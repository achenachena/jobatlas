"""allow BambooHR and Workable providers

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-09
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW = "('greenhouse', 'ashby', 'lever', 'jsonld', 'successfactors', 'workday', 'bamboohr', 'workable')"
OLD = "('greenhouse', 'ashby', 'lever', 'jsonld', 'successfactors', 'workday')"


def upgrade() -> None:
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {NEW}")


def downgrade() -> None:
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {OLD}")
