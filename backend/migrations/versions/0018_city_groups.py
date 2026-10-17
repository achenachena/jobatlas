"""City groups (metro areas) for the national view: atlas_groups, atlas_city_groups.

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "atlas_groups",
        sa.Column("id", sa.String(112), primary_key=True),
        sa.Column("version", sa.String(16), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("anchor_city_id", sa.String(96), sa.ForeignKey("atlas_cities.id"),
                  nullable=False),  # fmt: skip
        sa.Column("lat", sa.Float, nullable=False),
        sa.Column("lon", sa.Float, nullable=False),
        sa.CheckConstraint("kind IN ('cma', 'ca', 'cluster', 'single')",
                           name="ck_atlas_groups_kind"),  # fmt: skip
    )
    op.create_table(
        "atlas_city_groups",
        sa.Column("city_id", sa.String(96), sa.ForeignKey("atlas_cities.id"), primary_key=True),
        sa.Column("group_id", sa.String(112), sa.ForeignKey("atlas_groups.id"), nullable=False),
    )
    op.create_index("ix_atlas_city_groups_group_id", "atlas_city_groups", ["group_id"])


def downgrade() -> None:
    op.drop_table("atlas_city_groups")
    op.drop_table("atlas_groups")
