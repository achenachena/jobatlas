import random

from app.atlas.groups import City, compute, parse_areas, version


def _square(lon0, lat0, lon1, lat1, hole=None):
    ring = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
    return [ring] + ([hole] if hole else [])


def _feature(uid, name, kind, *polygons):
    geometry = (
        {"type": "Polygon", "coordinates": polygons[0]}
        if len(polygons) == 1
        else {"type": "MultiPolygon", "coordinates": list(polygons)}
    )
    return {"properties": {"CMAUID": uid, "CMANAME": name, "CMATYPE": kind}, "geometry": geometry}


# Simplified boxes around real places (the real boundaries come from Statistics Canada).
FEATURES = [
    _feature("535", "Toronto", "B", _square(-80.0, 43.4, -79.0, 44.2)),
    # one CMA in two provincial parts, as the map service returns it
    _feature("505", "Ottawa - Gatineau (Ontario part / partie de l'Ontario)", "B",
             _square(-76.4, 44.9, -75.3, 45.4)),
    _feature("505", "Ottawa - Gatineau (partie du Québec / Quebec part)", "B",
             _square(-76.4, 45.4, -75.3, 45.9)),
    _feature("825", "Calgary", "B", _square(-114.4, 50.8, -113.8, 51.3)),
    _feature("835", "Edmonton", "B", _square(-113.8, 53.3, -113.2, 53.8)),
    # a CA with a hole (a lake) and a second, separate part
    _feature("999", "Lakeside", "D",
             _square(-70.0, 47.0, -69.0, 48.0, hole=[[-69.6, 47.4], [-69.4, 47.4], [-69.4, 47.6],
                                                    [-69.6, 47.6], [-69.6, 47.4]]),
             _square(-68.0, 47.0, -67.8, 47.2)),
]  # fmt: skip
CITIES = [
    City("ca-on-toronto", "Toronto", 2_600_000, 43.70, -79.42),
    City("ca-on-mississauga", "Mississauga", 700_000, 43.58, -79.66),
    City("ca-on-brampton", "Brampton", 600_000, 43.68, -79.76),
    City("ca-on-ottawa", "Ottawa", 1_000_000, 45.41, -75.70),
    City("ca-qc-gatineau", "Gatineau", 290_000, 45.48, -75.70),
    City("ca-ab-calgary", "Calgary", 1_300_000, 51.05, -114.08),
    City("ca-ab-edmonton", "Edmonton", 1_000_000, 53.55, -113.49),
    City("ca-qc-shore", "Shore", 900, 47.5, -69.8),  # in Lakeside
    City("ca-qc-in-lake", "In Lake", 50, 47.5, -69.5),  # in the hole: not in Lakeside
    City("ca-qc-far-part", "Far Part", 10, 47.1, -67.9),  # second part of Lakeside
    # outside every area: two towns 25 km apart cluster, a third 120 km away stands alone
    City("ca-sk-bigtown", "Bigtown", 5000, 52.0, -106.0),
    City("ca-sk-smalltown", "Smalltown", 800, 52.2, -105.85),
    City("ca-sk-lonely", "Lonely", 300, 53.0, -106.5),
]


def _by_city(groups):
    return {m: g for g in groups for m in g.members}


def test_grouping_rules():
    groups = compute(CITIES, parse_areas(FEATURES))
    by = _by_city(groups)
    assert by["ca-on-toronto"] is by["ca-on-mississauga"] is by["ca-on-brampton"]
    toronto = by["ca-on-toronto"]
    assert (toronto.id, toronto.kind, toronto.name, toronto.anchor.id) == (
        "cma-535", "cma", "Toronto", "ca-on-toronto")  # fmt: skip
    # a CMA spanning two provinces stays one group, under its official name
    assert by["ca-on-ottawa"] is by["ca-qc-gatineau"]
    assert by["ca-on-ottawa"].name == "Ottawa - Gatineau"
    assert by["ca-ab-calgary"] is not by["ca-ab-edmonton"]
    lake = by["ca-qc-shore"]
    assert lake.kind == "ca" and by["ca-qc-far-part"] is lake and by["ca-qc-in-lake"] is not lake
    town = by["ca-sk-bigtown"]
    assert by["ca-sk-smalltown"] is town and town.kind == "cluster"
    assert (town.id, town.name, town.anchor.id) == ("cluster-ca-sk-bigtown", "Bigtown",
                                                    "ca-sk-bigtown")  # fmt: skip
    assert by["ca-sk-lonely"].kind == "single" and by["ca-sk-lonely"].id == "single-ca-sk-lonely"


def test_every_city_in_exactly_one_group_and_deterministic():
    groups = compute(CITIES, parse_areas(FEATURES))
    members = [m for g in groups for m in g.members]
    assert sorted(members) == sorted(c.id for c in CITIES)
    shuffled = CITIES[:]
    random.Random(7).shuffle(shuffled)
    again = compute(shuffled, parse_areas(list(reversed(FEATURES))))
    assert [(g.id, g.name, g.kind, g.anchor, g.members) for g in again] == [
        (g.id, g.name, g.kind, g.anchor, g.members) for g in groups
    ]
    assert version(again) == version(groups)
    # a different result is a different version
    assert version(compute(CITIES[:-1], parse_areas(FEATURES))) != version(groups)
