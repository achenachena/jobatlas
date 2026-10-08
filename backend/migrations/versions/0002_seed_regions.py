"""seed base regions

The GTA geometry here is an APPROXIMATE bounding box around Toronto + Durham, Halton, Peel
and York (geometry_is_approximate = true). It is not an administrative boundary. Replacing
it with Statistics Canada census-division polygons (Open Government Licence – Canada) is
tracked in docs/SOURCES.md.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

GTA_BBOX = (-80.25, 43.25, -78.60, 44.60)  # west, south, east, north


def upgrade() -> None:
    w, s, e, n = GTA_BBOX
    op.execute(
        """
        INSERT INTO regions (id, name, parent_id, country_code, kind, geometry_is_approximate, dataset_version)
        VALUES
          ('worldwide', 'Worldwide', NULL, NULL, 'world', false, 'jobatlas-seed-2026-10-08'),
          ('ca', 'Canada', 'worldwide', 'CA', 'country', true, 'jobatlas-seed-2026-10-08'),
          ('ca-on', 'Ontario', 'ca', 'CA', 'province', true, 'jobatlas-seed-2026-10-08')
        """
    )
    op.execute(
        f"""
        INSERT INTO regions (id, name, parent_id, country_code, kind, geometry, bbox,
                             geometry_is_approximate, dataset_version)
        VALUES ('gta', 'Greater Toronto Area', 'ca-on', 'CA', 'metro',
                ST_Multi(ST_MakeEnvelope({w}, {s}, {e}, {n}, 4326)),
                ST_MakeEnvelope({w}, {s}, {e}, {n}, 4326),
                true, 'approx-bbox-2026-10-08')
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM regions WHERE id IN ('gta', 'ca-on', 'ca', 'worldwide')")
