"""Fixed city groups for the national view (metro areas). One grouping for every dataset; it
depends only on the city catalogue and the boundaries, never on data, dataset or date.

- A city whose coordinates fall inside a 2021 census metropolitan area (CMA) or census
  agglomeration (CA) belongs to it. A CMA/CA spanning two provinces (Ottawa - Gatineau) stays
  one group, as officially delineated.
- The other cities are clustered: in order of population (then id), each city not yet grouped
  takes every ungrouped city within CLUSTER_KM of it. A city with none stays a group of its own.
- Then a cluster (or single) whose anchor is within MERGE_KM of another group's anchor joins
  it: always a CMA/CA (an official area is never dissolved), else only a larger cluster.
- A group's anchor is its most populous member's real position. Its display name is the
  official CMA/CA name when that name contains the anchor city's name, else the anchor city's
  name (the official name is kept apart).

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
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.atlas.cities import fold
from app.atlas.models import AtlasCity, AtlasCityGroup, AtlasGroup
from app.core.config import get_settings

CMA_LAYER = (
    "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/"
    "MapServer/6/query"
)
# The licence's wording for adapted information, verbatim.
STATCAN_ATTRIBUTION = (
    "Adapted from Statistics Canada, 2021 Census – Boundary files, census metropolitan areas "
    "and census agglomerations, 2021. This does not constitute an endorsement by Statistics "
    "Canada of this product."
)
KINDS = {"B": "cma", "K": "ca", "D": "ca"}  # CMATYPE: CMA, tracted CA, non-tracted CA
PRUIDS = {"10": "NL", "11": "PE", "12": "NS", "13": "NB", "24": "QC", "35": "ON", "46": "MB",
          "47": "SK", "48": "AB", "59": "BC", "60": "YT", "61": "NT", "62": "NU"}  # fmt: skip
CLUSTER_KM = 40.0
MERGE_KM = 20.0
EARTH_KM = 6371.0
PART_RE = re.compile(r"\s*\((?:[^()]*\bpart\b[^()]*)\)\s*$", re.I)  # "(Ontario part / ...)"


@dataclass
class Area:
    """A CMA/CA's rings as flat lon,lat arrays (compact: the full boundary set is 1.4 million
    points), each with its bounding box."""

    uid: str
    name: str
    kind: str
    provinces: set[str] = field(default_factory=set)
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
        a.provinces.add(PRUIDS[p["PRUID"]])
        a.add([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"])
    return [areas[k] for k in sorted(areas)]


def _get(client: httpx.Client, params: dict) -> dict:
    """The map service answers about half of all requests with a 500 at random (measured
    2026-10-17), so each request is retried up to 20 times."""
    for attempt in range(20):
        try:
            resp = client.get(CMA_LAYER, params=params)
            if resp.status_code == 200:
                return resp.json()
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(min(1 + attempt / 2, 5))
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
                "outFields": "CMAUID,CMANAME,CMATYPE,PRUID", "outSR": "4326",
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
    province: str
    population: int
    lat: float
    lon: float


@dataclass
class Group:
    id: str
    kind: str  # cma | ca | cluster | single
    anchor: City
    members: list[City]
    official_name: str | None = None  # CMA/CA name as published
    official_provinces: set[str] = field(default_factory=set)

    @property
    def population(self) -> int:
        return sum(c.population for c in self.members)

    @property
    def display_name(self) -> str:
        """The official name when it names the anchor city ("Kitchener – Cambridge – Waterloo")
        or is the name of one of its cities ("Bathurst", anchored on Belle-Baie); else the
        anchor city's name ("Cape Breton" -> "Sydney")."""
        o = self.official_name
        if o and (f" {_words(self.anchor.name)} " in f" {_words(o)} "
                  or any(_words(c.name) == _words(o) for c in self.members)):  # fmt: skip
            return o.replace(" - ", " – ")
        return self.anchor.name

    @property
    def provinces(self) -> list[str]:
        """The anchor's province first, then the others (a CMA/CA's official ones)."""
        found = self.official_provinces or {c.province for c in self.members}
        return [self.anchor.province] + sorted(found - {self.anchor.province})


def _words(name: str) -> str:
    """Accents, case and punctuation ignored: "Thetford-Mines" names "Thetford Mines"."""
    return " ".join(re.findall(r"\w+", fold(name)))


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
            groups[gid] = Group(gid, area.kind, c, [], area.name, area.provinces)
        groups[gid].members.append(c)
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
        groups[f"{kind}-{c.id}"] = Group(f"{kind}-{c.id}", kind, c, members)
    return merge_close(list(groups.values()))


def merge_close(groups: list[Group], km: float = MERGE_KM) -> list[Group]:
    """Fold a cluster or single whose anchor is within `km` of another group's anchor into
    the nearest such group that is a CMA/CA or a larger cluster (population, then id), until
    nothing moves. CMAs/CAs never merge with each other or into a cluster."""
    chord = 2 * math.sin(km / EARTH_KM / 2)
    pos = {g.anchor.id: _unit(g.anchor) for g in groups}
    live = {g.id: g for g in groups}

    def apart(a: Group, b: Group) -> float:
        return math.dist(pos[a.anchor.id], pos[b.anchor.id])

    def rank(g: Group) -> tuple[bool, int, str]:
        return g.kind in ("cma", "ca"), g.population, g.id

    moved = True
    while moved:
        moved = False
        for g in sorted((g for g in live.values() if g.kind in ("cluster", "single")), key=rank):
            if g.id not in live:
                continue
            near = [(apart(g, o), o.id) for o in live.values()
                    if o is not g and rank(o) > rank(g) and apart(g, o) < chord]  # fmt: skip
            if not near:
                continue
            target = live[min(near)[1]]
            del live[g.id]
            target.members = sorted(target.members + g.members, key=lambda c: (-c.population, c.id))
            if target.kind == "single":  # it now holds several cities
                del live[target.id]
                target.kind, target.id = "cluster", f"cluster-{target.anchor.id}"
                live[target.id] = target
            moved = True
    return [live[k] for k in sorted(live)]


def version(groups: list[Group]) -> str:
    """Content hash: changes whenever any group, name, anchor or membership changes."""
    h = hashlib.sha256()
    for g in groups:
        members = ",".join(c.id for c in g.members)
        h.update(f"{g.id}|{g.display_name}|{g.official_name}|{g.kind}|{g.anchor.id}|"
                 f"{','.join(g.provinces)}|{members}\n".encode())  # fmt: skip
    return h.hexdigest()[:12]


def catalogue(session: Session) -> list[City]:
    rows = session.execute(select(AtlasCity.id, AtlasCity.name, AtlasCity.province,
                                  AtlasCity.population, AtlasCity.lat, AtlasCity.lon))  # fmt: skip
    return [City(*r) for r in rows]


def store(session: Session, groups: list[Group]) -> str:
    """Replace the grouping in one transaction."""
    v = version(groups)
    session.execute(delete(AtlasCityGroup))
    session.execute(delete(AtlasGroup))
    session.add_all(AtlasGroup(id=g.id, version=v, display_name=g.display_name,
                               official_name=g.official_name, kind=g.kind,
                               provinces=g.provinces, anchor_city_id=g.anchor.id,
                               lat=g.anchor.lat, lon=g.anchor.lon) for g in groups)  # fmt: skip
    session.flush()
    session.add_all(AtlasCityGroup(city_id=c.id, group_id=g.id)
                    for g in groups for c in g.members)  # fmt: skip
    session.commit()
    return v


def ungrouped(session: Session) -> int:
    """Cities without a group: a new catalogue entry, or no grouping yet."""
    return session.scalar(
        select(func.count()).select_from(AtlasCity)
        .outerjoin(AtlasCityGroup, AtlasCityGroup.city_id == AtlasCity.id)
        .where(AtlasCityGroup.city_id.is_(None))
    )  # fmt: skip


def membership(session: Session) -> dict[str, str]:
    """city id -> group id (empty before the first `atlas-groups`)."""
    return dict(session.execute(select(AtlasCityGroup.city_id, AtlasCityGroup.group_id)).all())


def stored_groups(session: Session) -> dict[str, AtlasGroup]:
    return {g.id: g for g in session.scalars(select(AtlasGroup))}
