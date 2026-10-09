from datetime import UTC, date, datetime

import httpx
import pytest

from app.services.addresses import extract_explicit_addresses, normalize_address
from app.services.geocode import NominatimGeocoder
from app.services.search import (
    BBox,
    Candidate,
    SearchError,
    _time_bounds,
    build_map,
    build_tsquery,
    decode_cursor,
    encode_cursor,
    group_candidates,
)
from app.services.urls import canonical_job_url

# ------------------------------------------------------------------ addresses


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Our Toronto office is located at 123 Front Street West, Suite 400, Toronto, ON M5J 2M2.",
         "123 Front Street West, Suite 400, Toronto, ON M5J 2M2"),
        ("You will be based in our downtown office at 49 Spadina Avenue, Toronto.",
         "49 Spadina Avenue, Toronto"),
        ("Address: 2 Bloor St W, Toronto, Ontario", "2 Bloor St W, Toronto, Ontario"),
    ],
)  # fmt: skip
def test_explicit_addresses(text, expected):
    assert [a.display for a in extract_explicit_addresses(text)] == [expected]


@pytest.mark.parametrize(
    "text",
    [
        "Press inquiries: 500 King St W.",  # an address without an anchor is not the job's
        "We have 3000 Employees Worldwide.",
        "Join our team in Toronto!",
        None,
    ],
)
def test_no_unanchored_addresses(text):
    assert extract_explicit_addresses(text) == []


def test_normalize_address_ignores_unit_and_abbreviations():
    a = normalize_address("123 Front Street West, Suite 400, Toronto, ON")
    b = normalize_address("123 Front St. W, Toronto ON")
    assert a == b


# ------------------------------------------------------------------ urls


def test_canonical_job_url_strips_only_tracking():
    assert canonical_job_url("https://Stripe.com/jobs/search?gh_jid=1&utm_source=x#apply") == (
        "https://stripe.com/jobs/search?gh_jid=1"
    )
    assert canonical_job_url("https://jobs.lever.co/a/b/?lever-source=linkedin") == (
        "https://jobs.lever.co/a/b"
    )
    assert canonical_job_url("javascript:alert(1)") is None


# ------------------------------------------------------------------ geocoder


def _nominatim(make_client, fake_web, results):
    fake_web.add(
        "nominatim.example",
        "/search?q=1+Yonge+St%2C+Toronto&format=jsonv2&addressdetails=1&limit=5&countrycodes=ca",
        httpx.Response(200, json=results),
    )
    return NominatimGeocoder(make_client(), "https://nominatim.example").geocode(
        "1 Yonge St, Toronto"
    )


def test_nominatim_precise(make_client, fake_web):
    r = _nominatim(make_client, fake_web, [
        {"lon": "-79.37", "lat": "43.64", "addresstype": "building",
         "address": {"house_number": "1", "road": "Yonge Street", "city": "Toronto"},
         "display_name": "1 Yonge"}])  # fmt: skip
    assert r.status == "ok" and r.precision == "rooftop"


def test_nominatim_city_level_is_not_usable(make_client, fake_web):
    r = _nominatim(make_client, fake_web, [{"lon": "-79.38", "lat": "43.65", "addresstype": "city",
                                            "address": {}}])  # fmt: skip
    assert r.status == "low_precision"


def test_nominatim_distant_candidates_are_ambiguous(make_client, fake_web):
    r = _nominatim(make_client, fake_web, [
        {"lon": "-79.37", "lat": "43.64",
         "address": {"house_number": "1", "road": "Yonge Street", "city": "Toronto"}},
        {"lon": "-79.50", "lat": "43.80",
         "address": {"house_number": "1", "road": "Yonge Street", "city": "Toronto"}}])  # fmt: skip
    assert r.status == "ambiguous"


# ------------------------------------------------------------------ search core

PARENTS = {"worldwide": None, "north-america": "worldwide", "ca": "north-america",
           "us": "north-america", "ca-on": "ca", "gta": "ca-on", "toronto": "gta",
           "mississauga": "gta", "ca-qc": "ca"}  # fmt: skip
DOWNTOWN = BBox(-79.45, 43.62, -79.30, 43.70)
GTA = BBox(-80.25, 43.25, -78.60, 44.60)


def pt(lon, lat, role="work_site", loc="L1"):
    return {"lon": lon, "lat": lat, "role": role, "location_id": loc}


def cand(id_, wp="on_site", region=None, points=(), inc=(), exc=(), key=0):
    return Candidate(id_, wp, region, "known" if inc else "not_applicable", (key, id_),
                     list(points), set(inc), set(exc))  # fmt: skip


def test_groups_are_exclusive_and_follow_semantics():
    cands = [
        cand("exact", points=[pt(-79.38, 43.65)]),
        cand("toronto_only", region="toronto"),  # H: no fake point, listed as unverified
        cand("montreal_only", region="ca-qc"),  # not this region
        cand("outside_view", points=[pt(-79.64, 43.59)], region="mississauga"),
        # F: US HQ, open to Ontario residents -> still found
        cand("remote_us_hq", wp="remote", points=[pt(-122.4, 37.8, "headquarters")], inc={"ca-on"}),
        cand(
            "remote_ca_hq_in_view",
            wp="remote",
            points=[pt(-79.39, 43.64, "headquarters")],
            inc={"ca"},
        ),  # fmt: skip
        cand("remote_no_hq", wp="remote", inc={"ca"}),
        cand("remote_unknown", wp="remote"),  # "Remote" only: never shown as GTA-applicable
        cand("remote_us_only", wp="remote", points=[pt(-74, 40.7, "headquarters")], inc={"us"}),
        cand("remote_excluded", wp="remote", inc={"ca"}, exc={"ca-on"}),
    ]
    groups, view = group_candidates(cands, "gta", DOWNTOWN, PARENTS)
    ids = {g: [c.id for c in v] for g, v in groups.items()}
    assert ids["in_view"] == ["exact", "remote_ca_hq_in_view"]
    assert ids["remote_elsewhere"] == ["remote_us_hq"]
    assert ids["location_unverified"] == ["remote_no_hq", "toronto_only"]
    flat = [i for v in ids.values() for i in v]
    assert len(flat) == len(set(flat))


def test_multi_location_job_is_one_item_with_several_markers():
    c = cand("multi", points=[pt(-79.38, 43.65, loc="A"), pt(-79.40, 43.66, loc="B"),
                              pt(-79.64, 43.59, loc="C")])  # fmt: skip
    groups, view = group_candidates([c], "gta", DOWNTOWN, PARENTS)
    assert [x.id for x in groups["in_view"]] == ["multi"]
    assert len(view["multi"]) == 2  # only markers inside the view
    fmap, meta = build_map(groups, view, {"multi": "on_site"}, 12, 5000)
    assert meta == {"complete": True, "mode": "points", "unique_job_count": 1, "marker_count": 2}


def test_same_building_jobs_keep_identical_coordinates():
    a = cand("a", points=[pt(-79.38, 43.65)])
    b = cand("b", points=[pt(-79.38, 43.65)])
    groups, view = group_candidates([a, b], "gta", DOWNTOWN, PARENTS)
    fmap, _ = build_map(groups, view, {"a": "on_site", "b": "hybrid"}, 14, 5000)
    coords = {tuple(f["geometry"]["coordinates"]) for f in fmap["features"]}
    assert coords == {(-79.38, 43.65)}  # no fake jitter; the UI offers a picker


def test_over_limit_map_is_aggregated_from_the_full_set():
    cands = [cand(f"j{i}", points=[pt(-79.38 + i * 1e-4, 43.65)]) for i in range(50)]
    groups, view = group_candidates(cands, "gta", DOWNTOWN, PARENTS)
    fmap, meta = build_map(groups, view, {c.id: "on_site" for c in cands}, 10, max_points=10)
    assert meta["mode"] == "clusters" and meta["complete"] is True
    assert sum(f["properties"]["point_count"] for f in fmap["features"]) == 50
    assert meta["unique_job_count"] == 50


@pytest.mark.parametrize(
    "raw,code",
    [
        ("1,2,3", "INVALID_BBOX"),
        ("a,b,c,d", "INVALID_BBOX"),
        ("-79,44,-78,43", "INVALID_BBOX"),  # south >= north
        ("-200,43,-78,44", "INVALID_BBOX"),
        ("170,10,-170,20", "BBOX_CROSSES_ANTIMERIDIAN"),
        ("nan,43,-78,44", "INVALID_BBOX"),
    ],
)
def test_bbox_validation(raw, code):
    with pytest.raises(SearchError) as exc:
        BBox.parse(raw)
    assert exc.value.code == code


def test_tsquery_tokens_are_sanitized_and_expanded():
    assert build_tsquery("Backend Engineer") == (
        "(backend:* | back <-> end) & (engineer:* | developer)"
    )
    assert build_tsquery("'); DROP TABLE jobs; --") == ("(drop:*) & (table:*) & (jobs:*)")
    assert build_tsquery("!!!") is None


def test_cursor_round_trip():
    assert decode_cursor(encode_cursor("sid", "in_view", 30)) == ("sid", "in_view", 30)
    with pytest.raises(SearchError):
        decode_cursor("not-a-cursor")


@pytest.mark.parametrize(
    "as_of,expected_start,expected_date",
    [
        # EDT (UTC-4): Toronto midnight on 2026-10-08 is 04:00Z
        (datetime(2026, 10, 8, 12, 0, tzinfo=UTC), datetime(2026, 10, 8, 4, 0, tzinfo=UTC),
         date(2026, 10, 8)),
        # 02:30Z on Oct 8 is still Oct 7 in Toronto
        (datetime(2026, 10, 8, 2, 30, tzinfo=UTC), datetime(2026, 10, 7, 4, 0, tzinfo=UTC),
         date(2026, 10, 7)),
        # EST (UTC-5) after the November change
        (datetime(2026, 11, 2, 12, 0, tzinfo=UTC), datetime(2026, 11, 2, 5, 0, tzinfo=UTC),
         date(2026, 11, 2)),
        # DST end day itself (2026-11-01): midnight was still EDT
        (datetime(2026, 11, 1, 18, 0, tzinfo=UTC), datetime(2026, 11, 1, 4, 0, tzinfo=UTC),
         date(2026, 11, 1)),
    ],
)  # fmt: skip
def test_today_uses_toronto_midnight_across_dst(as_of, expected_start, expected_date):
    start, today = _time_bounds("today", as_of)
    assert start == expected_start and today == expected_date


def test_rolling_windows_are_durations():
    as_of = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)
    start, today = _time_bounds("3d", as_of)
    assert start == datetime(2026, 10, 5, 12, 0, tzinfo=UTC) and today is None
    assert _time_bounds("all", as_of) == (None, None)
