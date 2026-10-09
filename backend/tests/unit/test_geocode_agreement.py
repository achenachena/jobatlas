"""A geocoder candidate becomes a map point only if it agrees with the input address."""

from urllib.parse import urlencode

import httpx
import pytest

from app.services.geocode import NominatimGeocoder, check_agreement, parse_address


def geocode(make_client, fake_web, address, results):
    query = urlencode(
        {"q": address, "format": "jsonv2", "addressdetails": 1, "limit": 5, "countrycodes": "ca"}
    )
    fake_web.add("nominatim.example", f"/search?{query}", httpx.Response(200, json=results))
    return NominatimGeocoder(make_client(), "https://nominatim.example").geocode(address)


def hit(house, road, city, postcode=None, lon=-79.39, lat=43.65, **extra):
    address = {"house_number": house, "road": road, "city": city, **extra}
    if postcode:
        address["postcode"] = postcode
    return {
        "lon": str(lon),
        "lat": str(lat),
        "addresstype": "building",
        "address": address,
        "display_name": f"{house} {road}, {city}",
    }


def test_reviewer_case_wrong_city_and_street_is_rejected(make_client, fake_web):
    # Input: Toronto's 55 John Street. Geocoder returns another street/number in Ottawa.
    r = geocode(
        make_client,
        fake_web,
        "55 John Street, Toronto, ON",
        [hit("120", "Sparks Street", "Ottawa", "K1P 5B6", lon=-75.70, lat=45.42)],
    )
    assert r.status == "mismatch" and r.lon is None


def test_matching_candidate_wins_over_conflicting_ones(make_client, fake_web):
    r = geocode(
        make_client,
        fake_web,
        "55 John St, Toronto, ON M5V 3C6",
        [
            hit("55", "John Street", "Ottawa", "K1N 7Y2", lon=-75.70, lat=45.42),
            hit("55", "John Street", "Toronto", "M5V 3C6", lon=-79.389, lat=43.646),
        ],
    )
    assert r.status == "ok" and (r.lon, r.lat) == (-79.389, 43.646)


def test_postal_conflict_rejects_even_when_street_matches(make_client, fake_web):
    # Same number/street/city but a different postal area: a different John Street.
    r = geocode(
        make_client,
        fake_web,
        "55 John St, Toronto, ON M5V 3C6",
        [hit("55", "John Street", "Toronto", "M9N 1J9", lon=-79.51, lat=43.70)],
    )
    assert r.status == "mismatch"


def test_no_postal_fallback_to_unrelated_candidates(make_client, fake_web):
    # Old behaviour kept every candidate when none shared the postal area.
    r = geocode(
        make_client,
        fake_web,
        "55 John St, Toronto, ON M5V 3C6",
        [
            hit("55", "John Street", "Toronto", "M9N 1J9", lon=-79.51, lat=43.70),
            hit("55", "John Street", "Toronto", "M9N 1K1", lon=-79.5101, lat=43.7001),
        ],
    )
    assert r.status == "mismatch"


def test_different_house_number_is_rejected(make_client, fake_web):
    r = geocode(
        make_client, fake_web, "100 King St W, Toronto", [hit("1", "King Street West", "Toronto")]
    )
    assert r.status == "mismatch"


def test_opposite_direction_is_a_different_street(make_client, fake_web):
    r = geocode(
        make_client, fake_web, "100 King St W, Toronto", [hit("100", "King Street East", "Toronto")]
    )
    assert r.status == "mismatch"


def test_abbreviations_ranges_and_boroughs_still_match(make_client, fake_web):
    r = geocode(
        make_client,
        fake_web,
        "5100 Yonge St, North York, ON",
        [hit("5096-5110", "Yonge Street", "Toronto", city_district="North York")],
    )
    assert r.status == "ok"


def test_input_without_city_or_postal_is_not_resolved(make_client, fake_web):
    r = geocode(make_client, fake_web, "55 John Street", [hit("55", "John Street", "Ottawa")])
    assert r.status == "unverifiable"


def test_result_without_road_cannot_be_confirmed():
    parts = parse_address("55 John Street, Toronto")
    assert check_agreement(parts, {"address": {"house_number": "55", "city": "Toronto"}})


@pytest.mark.parametrize(
    ("address", "city"),
    [
        ("450 Lexington Ave, New York, NY 10017", "New York"),  # Nominatim: "City of New York"
        ("99 Yorkville Ave, Toronto, Ontario M5R 1C1", "Toronto"),
    ],
)
def test_city_named_inside_a_longer_official_name(address, city):
    parts = parse_address(address)
    official = "City of New York" if city == "New York" else city
    road = "Lexington Avenue" if "Lexington" in address else "Yorkville Avenue"
    house = parts.house
    assert (
        check_agreement(parts, {"address": {"house_number": house, "road": road, "city": official}})
        is None
    )
