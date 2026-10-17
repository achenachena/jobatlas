import random

from app.atlas.groups import City, Group, compute, merge_close, parse_areas, version


def _square(lon0, lat0, lon1, lat1, hole=None):
    ring = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
    return [ring] + ([hole] if hole else [])


def _feature(uid, name, kind, pruid, *polygons):
    geometry = (
        {"type": "Polygon", "coordinates": polygons[0]}
        if len(polygons) == 1
        else {"type": "MultiPolygon", "coordinates": list(polygons)}
    )
    props = {"CMAUID": uid, "CMANAME": name, "CMATYPE": kind, "PRUID": pruid}
    return {"properties": props, "geometry": geometry}


# Simplified boxes around real places (the real boundaries come from Statistics Canada).
FEATURES = [
    _feature("535", "Toronto", "B", "35", _square(-80.0, 43.4, -79.0, 44.2)),
    # one CMA in two provincial parts, as the map service returns it
    _feature("505", "Ottawa - Gatineau (Ontario part / partie de l'Ontario)", "B", "35",
             _square(-76.4, 44.9, -75.3, 45.4)),
    _feature("505", "Ottawa - Gatineau (partie du Québec / Quebec part)", "B", "24",
             _square(-76.4, 45.4, -75.3, 45.9)),
    _feature("541", "Kitchener - Cambridge - Waterloo", "B", "35",
             _square(-80.7, 43.3, -80.2, 43.6)),
    _feature("825", "Calgary", "B", "48", _square(-114.4, 50.8, -113.8, 51.3)),
    _feature("835", "Edmonton", "B", "48", _square(-113.8, 53.3, -113.2, 53.8)),
    # the official name does not name the most populous place
    _feature("225", "Cape Breton", "K", "12", _square(-60.5, 45.9, -59.8, 46.4)),
    _feature("428", "Thetford Mines", "D", "24", _square(-71.4, 46.0, -71.2, 46.2)),
    # a CA with a hole (a lake) and a second, separate part
    _feature("999", "Lakeside", "D", "24",
             _square(-70.0, 47.0, -69.0, 48.0, hole=[[-69.6, 47.4], [-69.4, 47.4], [-69.4, 47.6],
                                                    [-69.6, 47.6], [-69.6, 47.4]]),
             _square(-68.0, 47.0, -67.8, 47.2)),
    # two CAs whose anchors are 9 km apart: official areas never merge
    _feature("701", "Westtown", "D", "46", _square(-98.0, 50.0, -97.95, 50.2)),
    _feature("702", "Easttown", "D", "46", _square(-97.95, 50.0, -97.9, 50.2)),
]  # fmt: skip
CITIES = [
    City("ca-on-toronto", "Toronto", "ON", 2_600_000, 43.70, -79.42),
    City("ca-on-mississauga", "Mississauga", "ON", 700_000, 43.58, -79.66),
    City("ca-on-brampton", "Brampton", "ON", 600_000, 43.68, -79.76),
    City("ca-on-ottawa", "Ottawa", "ON", 1_000_000, 45.41, -75.70),
    City("ca-qc-gatineau", "Gatineau", "QC", 290_000, 45.48, -75.70),
    City("ca-on-kitchener", "Kitchener", "ON", 260_000, 43.45, -80.49),
    City("ca-ab-calgary", "Calgary", "AB", 1_300_000, 51.05, -114.08),
    City("ca-ab-edmonton", "Edmonton", "AB", 1_000_000, 53.55, -113.49),
    City("ca-ns-sydney", "Sydney", "NS", 30_000, 46.14, -60.18),
    City("ca-qc-thetford-mines", "Thetford-Mines", "QC", 26_000, 46.09, -71.30),
    City("ca-qc-shore", "Shore", "QC", 900, 47.5, -69.8),  # in Lakeside
    City("ca-qc-in-lake", "In Lake", "QC", 50, 47.5, -69.5),  # in the hole: not in Lakeside
    City("ca-qc-far-part", "Far Part", "QC", 10, 47.1, -67.9),  # second part of Lakeside
    City("ca-mb-westtown", "Westtown", "MB", 5000, 50.1, -97.98),
    City("ca-mb-easttown", "Easttown", "MB", 4000, 50.1, -97.92),
    # outside every area: two towns 25 km apart cluster, a third 120 km away stands alone
    City("ca-sk-bigtown", "Bigtown", "SK", 5000, 52.0, -106.0),
    City("ca-sk-smalltown", "Smalltown", "SK", 800, 52.2, -105.85),
    City("ca-sk-lonely", "Lonely", "SK", 300, 53.0, -106.5),
    # 45 km from Toronto's anchor, outside the box: its own cluster, too far to merge
    City("ca-on-farville", "Farville", "ON", 3000, 44.30, -79.0),
    # a single 19 km from Kitchener's anchor, outside the CMA box: merges into the CMA
    City("ca-on-nearby", "Nearby", "ON", 9000, 43.62, -80.50),
]


def _by_city(groups):
    return {c.id: g for g in groups for c in g.members}


def test_grouping_rules():
    groups = compute(CITIES, parse_areas(FEATURES))
    by = _by_city(groups)
    assert by["ca-on-toronto"] is by["ca-on-mississauga"] is by["ca-on-brampton"]
    toronto = by["ca-on-toronto"]
    assert (toronto.id, toronto.kind, toronto.display_name, toronto.anchor.id) == (
        "cma-535", "cma", "Toronto", "ca-on-toronto")  # fmt: skip
    # a CMA spanning two provinces stays one group: official name, both provinces
    ottawa = by["ca-on-ottawa"]
    assert by["ca-qc-gatineau"] is ottawa
    assert (ottawa.display_name, ottawa.official_name, ottawa.provinces) == (
        "Ottawa – Gatineau", "Ottawa - Gatineau", ["ON", "QC"])  # fmt: skip
    assert by["ca-ab-calgary"] is not by["ca-ab-edmonton"]
    lake = by["ca-qc-shore"]
    assert lake.kind == "ca" and by["ca-qc-far-part"] is lake and by["ca-qc-in-lake"] is not lake
    town = by["ca-sk-bigtown"]
    assert by["ca-sk-smalltown"] is town and town.kind == "cluster"
    assert (town.id, town.display_name, town.anchor.id, town.official_name) == (
        "cluster-ca-sk-bigtown", "Bigtown", "ca-sk-bigtown", None)  # fmt: skip
    assert by["ca-sk-lonely"].kind == "single" and by["ca-sk-lonely"].id == "single-ca-sk-lonely"


def test_display_names():
    by = _by_city(compute(CITIES, parse_areas(FEATURES)))
    kcw = by["ca-on-kitchener"]
    assert kcw.display_name == "Kitchener – Cambridge – Waterloo"
    breton = by["ca-ns-sydney"]  # the official name does not name the anchor city
    assert (breton.display_name, breton.official_name) == ("Sydney", "Cape Breton")
    thetford = by["ca-qc-thetford-mines"]  # punctuation does not matter
    assert thetford.display_name == "Thetford Mines"


def test_close_groups_merge():
    by = _by_city(compute(CITIES, parse_areas(FEATURES)))
    # a single 19 km from a CMA's anchor joins it, whatever its size
    assert by["ca-on-nearby"] is by["ca-on-kitchener"]
    # 45 km away stays apart
    assert by["ca-on-farville"].id == "single-ca-on-farville"
    # two CAs 4 km apart stay official and separate
    assert by["ca-mb-westtown"].id == "ca-701" and by["ca-mb-easttown"].id == "ca-702"


def test_a_smaller_cluster_joins_a_larger_one():
    # The first pass leaves cluster anchors over 40 km apart, so this only arises from groups
    # built otherwise; the rule is checked on merge_close directly.
    alpha, alpha2 = (City("ca-bc-alpha", "Alpha", "BC", 6000, 50.0, -120.0),
                     City("ca-bc-alpha-2", "Alpha Two", "BC", 10, 50.0, -120.1))  # fmt: skip
    beta = City("ca-bc-beta", "Beta", "BC", 8000, 50.135, -120.0)  # 15 km north of Alpha
    out = merge_close([Group("cluster-ca-bc-alpha", "cluster", alpha, [alpha, alpha2]),
                       Group("single-ca-bc-beta", "single", beta, [beta])])  # fmt: skip
    # the single holds more people (8000 > 6010): the cluster joins it, and it becomes one
    assert [(g.id, g.kind, [c.id for c in g.members]) for g in out] == [
        ("cluster-ca-bc-beta", "cluster", ["ca-bc-beta", "ca-bc-alpha", "ca-bc-alpha-2"])
    ]


def test_every_city_in_exactly_one_group_and_deterministic():
    groups = compute(CITIES, parse_areas(FEATURES))
    members = [c.id for g in groups for c in g.members]
    assert sorted(members) == sorted(c.id for c in CITIES)
    shuffled = CITIES[:]
    random.Random(7).shuffle(shuffled)
    again = compute(shuffled, parse_areas(list(reversed(FEATURES))))
    assert [(g.id, g.display_name, g.kind, g.anchor, g.members) for g in again] == [
        (g.id, g.display_name, g.kind, g.anchor, g.members) for g in groups
    ]
    assert version(again) == version(groups)
    # a different result is a different version
    assert version(compute(CITIES[:-1], parse_areas(FEATURES))) != version(groups)
