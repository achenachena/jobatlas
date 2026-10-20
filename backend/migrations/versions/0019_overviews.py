"""Prepared history overviews per release, occupation and window: atlas_overviews.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "atlas_overviews",
        sa.Column(
            "release_id",
            sa.String(64),
            sa.ForeignKey("atlas_releases.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("occupation", sa.String(48), primary_key=True),
        sa.Column("window", sa.String(8), primary_key=True),
        sa.Column("format", sa.Integer, primary_key=True),
        sa.Column("body", sa.LargeBinary, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_table("atlas_overviews")
