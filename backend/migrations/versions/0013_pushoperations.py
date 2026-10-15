"""Enable employer-linked public Push Operations boards."""

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None
OLD = "('greenhouse','ashby','lever','jsonld','successfactors','workday','bamboohr','workable','oracle','smartrecruiters')"
NEW = OLD[:-1] + ",'pushoperations')"


def upgrade():
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {NEW}")


def downgrade():
    op.drop_constraint("ck_sources_provider", "sources", type_="check")
    op.create_check_constraint("ck_sources_provider", "sources", f"provider IN {OLD}")
