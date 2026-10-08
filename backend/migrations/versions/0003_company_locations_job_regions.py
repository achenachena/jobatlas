"""company locations, job regions, more region rows

Adds the company office registry, the job's label-derived region, remote eligibility status,
and region rows needed for eligibility (North America, US, provinces) and for the region
search (GTA municipalities).

Municipality, province and country boxes are APPROXIMATE viewport boxes
(geometry_is_approximate = true), used only to move the map and for coarse grouping. They are
not administrative boundaries; see docs/SOURCES.md §5.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

VERSION = "approx-bbox-2026-10-08"

# id, name, parent, country, kind, (west, south, east, north) or None
REGIONS = [
    ("north-america", "North America", "worldwide", None, "continent", (-168.0, 7.0, -52.0, 83.5)),
    ("us", "United States", "north-america", "US", "country", (-125.0, 24.5, -66.9, 49.4)),
    ("ca-ab", "Alberta", "ca", "CA", "province", None),
    ("ca-bc", "British Columbia", "ca", "CA", "province", None),
    ("ca-mb", "Manitoba", "ca", "CA", "province", None),
    ("ca-nb", "New Brunswick", "ca", "CA", "province", None),
    ("ca-nl", "Newfoundland and Labrador", "ca", "CA", "province", None),
    ("ca-ns", "Nova Scotia", "ca", "CA", "province", None),
    ("ca-nt", "Northwest Territories", "ca", "CA", "territory", None),
    ("ca-nu", "Nunavut", "ca", "CA", "territory", None),
    ("ca-pe", "Prince Edward Island", "ca", "CA", "province", None),
    ("ca-qc", "Quebec", "ca", "CA", "province", None),
    ("ca-sk", "Saskatchewan", "ca", "CA", "province", None),
    ("ca-yt", "Yukon", "ca", "CA", "territory", None),
    ("toronto", "Toronto", "gta", "CA", "municipality", (-79.64, 43.58, -79.11, 43.86)),
    ("mississauga", "Mississauga", "gta", "CA", "municipality", (-79.81, 43.47, -79.52, 43.74)),
    ("brampton", "Brampton", "gta", "CA", "municipality", (-79.89, 43.62, -79.63, 43.85)),
    ("caledon", "Caledon", "gta", "CA", "municipality", (-80.10, 43.75, -79.62, 44.02)),
    ("oakville", "Oakville", "gta", "CA", "municipality", (-79.80, 43.38, -79.62, 43.53)),
    ("burlington", "Burlington", "gta", "CA", "municipality", (-79.93, 43.28, -79.72, 43.45)),
    ("milton", "Milton", "gta", "CA", "municipality", (-80.05, 43.43, -79.78, 43.60)),
    ("halton-hills", "Halton Hills", "gta", "CA", "municipality", (-80.05, 43.56, -79.80, 43.75)),
    ("vaughan", "Vaughan", "gta", "CA", "municipality", (-79.64, 43.75, -79.42, 43.93)),
    ("markham", "Markham", "gta", "CA", "municipality", (-79.43, 43.80, -79.17, 43.96)),
    ("richmond-hill", "Richmond Hill", "gta", "CA", "municipality", (-79.48, 43.83, -79.37, 43.98)),
    ("newmarket", "Newmarket", "gta", "CA", "municipality", (-79.51, 44.02, -79.41, 44.09)),
    ("aurora", "Aurora", "gta", "CA", "municipality", (-79.51, 43.96, -79.40, 44.03)),
    ("pickering", "Pickering", "gta", "CA", "municipality", (-79.22, 43.80, -79.00, 44.00)),
    ("ajax", "Ajax", "gta", "CA", "municipality", (-79.07, 43.81, -78.97, 43.90)),
    ("whitby", "Whitby", "gta", "CA", "municipality", (-79.00, 43.83, -78.88, 44.00)),
    ("oshawa", "Oshawa", "gta", "CA", "municipality", (-78.92, 43.84, -78.80, 44.05)),
    ("clarington", "Clarington", "gta", "CA", "municipality", (-78.84, 43.86, -78.50, 44.10)),
]
BOXES = {
    "ca": (-141.0, 41.7, -52.6, 83.1),
    "ca-on": (-95.2, 41.7, -74.3, 56.9),
}


def _envelope(box):
    w, s, e, n = box
    return f"ST_MakeEnvelope({w}, {s}, {e}, {n}, 4326)"


def upgrade() -> None:
    op.create_table(
        "company_locations",
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("location_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("evidence_id", sa.UUID(), nullable=True),
        sa.Column("invalidated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('office', 'headquarters')", name="ck_company_locations_role"),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"]),
        sa.ForeignKeyConstraint(["evidence_id"], ["evidence.id"]),
        sa.ForeignKeyConstraint(["location_id"], ["locations.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("company_id", "location_id", "role", name="uq_company_locations"),
    )
    op.create_index("ix_company_locations_company_id", "company_locations", ["company_id"])
    op.add_column("locations", sa.Column("display_address", sa.Text(), nullable=True))
    op.add_column(
        "companies", sa.Column("offices_checked_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("jobs", sa.Column("location_region_id", sa.String(length=64), nullable=True))
    op.add_column(
        "jobs",
        sa.Column(
            "eligibility_status",
            sa.String(length=16),
            nullable=False,
            server_default="not_applicable",
        ),
    )
    op.alter_column("jobs", "eligibility_status", server_default=None)
    op.create_check_constraint(
        "ck_jobs_eligibility",
        "jobs",
        "eligibility_status IN ('not_applicable', 'unknown', 'known')",
    )
    op.create_index("ix_jobs_location_region_id", "jobs", ["location_region_id"])
    op.create_foreign_key(
        "fk_jobs_location_region_id", "jobs", "regions", ["location_region_id"], ["id"]
    )

    for rid, box in BOXES.items():
        op.execute(f"UPDATE regions SET bbox = {_envelope(box)} WHERE id = '{rid}'")
    for rid, name, parent, country, kind, box in REGIONS:
        geom = f"ST_Multi({_envelope(box)})" if box else "NULL"
        bbox = _envelope(box) if box else "NULL"
        cc = f"'{country}'" if country else "NULL"
        op.execute(
            f"""INSERT INTO regions (id, name, parent_id, country_code, kind, geometry, bbox,
                                     geometry_is_approximate, dataset_version)
                VALUES ('{rid}', '{name}', '{parent}', {cc}, '{kind}', {geom}, {bbox}, true,
                        '{VERSION}')"""
        )
    # Canada sits under North America for eligibility ("Remote - North America").
    op.execute("UPDATE regions SET parent_id = 'north-america' WHERE id = 'ca'")


def downgrade() -> None:
    op.execute("UPDATE regions SET parent_id = 'worldwide' WHERE id = 'ca'")
    op.execute("UPDATE regions SET bbox = NULL WHERE id IN ('ca', 'ca-on')")
    ids = ", ".join(f"'{r[0]}'" for r in REGIONS)
    op.execute(f"DELETE FROM regions WHERE id IN ({ids})")
    op.drop_constraint("fk_jobs_location_region_id", "jobs", type_="foreignkey")
    op.drop_index("ix_jobs_location_region_id", table_name="jobs")
    op.drop_constraint("ck_jobs_eligibility", "jobs", type_="check")
    op.drop_column("jobs", "eligibility_status")
    op.drop_column("jobs", "location_region_id")
    op.drop_column("locations", "display_address")
    op.drop_column("companies", "offices_checked_at")
    op.drop_index("ix_company_locations_company_id", table_name="company_locations")
    op.drop_table("company_locations")
