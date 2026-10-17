"""Fixed city groups for the national view (metro areas). One grouping for every dataset; it
depends only on the city catalogue and the boundaries, never on data, dataset or date.

- A city whose coordinates fall inside a 2021 census metropolitan area (CMA) or census
  agglomeration (CA) belongs to it. A CMA/CA spanning two provinces (Ottawa - Gatineau) stays
  one group, as officially delineated.
- The other cities are clustered: in order of population (then id), each city not yet grouped
  takes every ungrouped city within CLUSTER_KM of it. A city with none stays a group of its own.
- A group's anchor is its most populous member's real position; its name is the official
  CMA/CA name, or the anchor city's name.

Boundaries: Statistics Canada, 2021 Census cartographic boundary file of CMAs and CAs (map
service layer lcma000b21s_e), read in WGS84 under the Statistics Canada Open Licence. Point in
polygon is computed here; the database has no spatial extension.
"""

from __future__ import annotations

import hashlib
import math
import re
import time
from array import array
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.atlas.models import AtlasCity, AtlasCityGroup, AtlasGroup
from app.core.config import get_settings

CMA_LAYER = (
    "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/"
    "MapServer/6/query"
)
STATCAN_ATTRIBUTION = (
    "Metro areas: adapted from Statistics Canada, 2021 Census – Boundary Files, census "
    "metropolitan areas and census agglomerations, 2021. This does not constitute an endorsement "
    "by Statistics Canada of this product."
)
KINDS = {"B": "cma", "K": "ca", "D": "ca"}  # CMATYPE: CMA, tracted CA, non-tracted CA
CLUSTER_KM = 40.0
EARTH_KM = 6371.0
PART_RE = re.compile(r"\s*\((?:[^()]*\bpart\b[^()]*)\)\s*$", re.I)  # "(Ontario part / ...)"


@dataclass
class Area:
    """A CMA/CA's rings as flat lon,lat arrays (compact: the full boundary set is 1.4 million
    points), each with its bounding box."""

    uid: str
    name: str
    kind: str
    rings: list[array] = field(default_factory=list)
    boxes: list[tuple[float, float, float]] = field(default_factory=list)  # lat min/max, lon max
    bbox: list[float] = field(default_factory=lambda: [180.0, 90.0, -180.0, -90.0])

    def add(self, polygons: list) -> None:
        for poly in polygons:
            for ring in poly:
                flat = array("d", (v for x, y, *_ in ring for v in (x, y)))
                xs, ys = flat[0::2], flat[1::2]
                self.rings.append(flat)
                self.boxes.append((min(ys), max(ys), max(xs)))
                b = self.bbox
                self.bbox = [min(b[0], min(xs)), min(b[1], min(ys)), max(b[2], max(xs)),
                             max(b[3], max(ys))]  # fmt: skip

    def contains(self, lon: float, lat: float) -> bool:
        """Even-odd rule over all rings (holes and multi-part areas need no special case),
        casting the ray towards +x: a ring left of the point or off its latitude is skipped."""
        b = self.bbox
        if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
            return False
        inside = False
        for ring, (y0, y1, x1) in zip(self.rings, self.boxes, strict=True):
            if lat < y0 or lat > y1 or lon > x1:
                continue
            xj, yj = ring[-2], ring[-1]
            for i in range(0, len(ring), 2):
                xi, yi = ring[i], ring[i + 1]
                if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                    inside = not inside
                xj, yj = xi, yi
        return inside


def parse_areas(features: Iterable[dict]) -> list[Area]:
    """GeoJSON features of the CMA/CA layer -> one Area per CMA/CA (provincial parts merged)."""
    areas: dict[str, Area] = {}
    for f in features:
        p, g = f["properties"], f["geometry"]
        a = areas.setdefault(
            p["CMAUID"], Area(p["CMAUID"], PART_RE.sub("", p["CMANAME"]), KINDS[p["CMATYPE"]])
        )
        a.add([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"])
    return [areas[k] for k in sorted(areas)]


def _get(client: httpx.Client, params: dict) -> dict:
    """The map service intermittently answers 5xx: retry a few times."""
    for attempt in range(6):
        try:
            resp = client.get(CMA_LAYER, params=params)
            if resp.status_code == 200:
                return resp.json()
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Statistics Canada map service did not answer: {params}")


def fetch_features(client: httpx.Client | None = None) -> Iterator[dict]:
    """Every CMA/CA part in WGS84 at full resolution (server-side generalisation moves cities
    across boundaries), ten at a time so only one batch is held as JSON."""
    own = client is None
    client = client or httpx.Client(
        timeout=120, trust_env=False, headers={"User-Agent": get_settings().atlas_user_agent}
    )
    try:
        ids = sorted(_get(client, {"where": "1=1", "returnIdsOnly": "true", "f": "json"})
                     ["objectIds"])  # fmt: skip
        for i in range(0, len(ids), 10):
            yield from _get(client, {
                "objectIds": ",".join(map(str, ids[i : i + 10])),
                "outFields": "CMAUID,CMANAME,CMATYPE", "outSR": "4326",
                "geometryPrecision": "5", "f": "geojson",
            })["features"]  # fmt: skip
    finally:
        if own:
            client.close()


# ------------------------------------------------------------------ grouping


@dataclass(frozen=True)
class City:
    id: str
    name: str
    population: int
    lat: float
    lon: float


@dataclass
class Group:
    id: str
    name: str
    kind: str  # cma | ca | cluster | single
    anchor: City
    members: list[str]


def _unit(c: City) -> tuple[float, float, float]:
    la, lo = math.radians(c.lat), math.radians(c.lon)
    return math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)


def compute(cities: list[City], areas: list[Area], km: float = CLUSTER_KM) -> list[Group]:
    order = sorted(cities, key=lambda c: (-c.population, c.id))
    groups: dict[str, Group] = {}
    rest: list[City] = []
    for c in order:
        area = next((a for a in areas if a.contains(c.lon, c.lat)), None)
        if area is None:
            rest.append(c)
            continue
        gid = f"{area.kind}-{area.uid}"
        if gid not in groups:  # most populous member first: it is the anchor
            groups[gid] = Group(gid, area.name, area.kind, c, [])
        groups[gid].members.append(c.id)
    # Clusters: chord length on the unit sphere grows with distance, so a 3-D grid with cells
    # of that length finds every city within `km` among the 27 cells around one.
    chord = 2 * math.sin(km / EARTH_KM / 2)
    pos = {c.id: _unit(c) for c in rest}
    grid: dict[tuple[int, int, int], list[City]] = defaultdict(list)
    for c in rest:
        grid[tuple(math.floor(v / chord) for v in pos[c.id])].append(c)
    taken: set[str] = set()
    for c in rest:
        if c.id in taken:
            continue
        cell = [math.floor(v / chord) for v in pos[c.id]]
        near = [o for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                for o in grid[(cell[0] + dx, cell[1] + dy, cell[2] + dz)]
                if o.id not in taken and math.dist(pos[c.id], pos[o.id]) <= chord]  # fmt: skip
        members = sorted(near, key=lambda o: (-o.population, o.id))
        taken.update(o.id for o in members)
        kind = "cluster" if len(members) > 1 else "single"
        gid = f"{kind}-{c.id}"
        groups[gid] = Group(gid, c.name, kind, c, [o.id for o in members])
    return [groups[k] for k in sorted(groups)]


def version(groups: list[Group]) -> str:
    """Content hash: changes whenever any group, name, anchor or membership changes."""
    h = hashlib.sha256()
    for g in groups:
        h.update(f"{g.id}|{g.name}|{g.kind}|{g.anchor.id}|{','.join(g.members)}\n".encode())
    return h.hexdigest()[:12]


def catalogue(session: Session) -> list[City]:
    rows = session.execute(select(AtlasCity.id, AtlasCity.name, AtlasCity.population,
                                  AtlasCity.lat, AtlasCity.lon))  # fmt: skip
    return [City(*r) for r in rows]


def store(session: Session, groups: list[Group]) -> str:
    """Replace the grouping in one transaction."""
    v = version(groups)
    session.execute(delete(AtlasCityGroup))
    session.execute(delete(AtlasGroup))
    session.add_all(AtlasGroup(id=g.id, version=v, name=g.name, kind=g.kind,
                               anchor_city_id=g.anchor.id, lat=g.anchor.lat, lon=g.anchor.lon)
                    for g in groups)  # fmt: skip
    session.flush()
    session.add_all(AtlasCityGroup(city_id=m, group_id=g.id) for g in groups for m in g.members)
    session.commit()
    return v


def membership(session: Session) -> dict[str, str]:
    """city id -> group id (empty before the first `atlas-groups`)."""
    return dict(session.execute(select(AtlasCityGroup.city_id, AtlasCityGroup.group_id)).all())


def stored_groups(session: Session) -> dict[str, AtlasGroup]:
    return {g.id: g for g in session.scalars(select(AtlasGroup))}
