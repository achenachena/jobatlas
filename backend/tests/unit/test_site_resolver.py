import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app.services.site_resolver import SiteResolver, brand_tokens, parse_site_label


@pytest.mark.parametrize(
    "label,muni,street,places,resolvable",
    [
        ("AMER - Canada - Ontario - Toronto - University Ave, Canada", "toronto",
         "University Ave", [], True),
        ("CAN Mississauga - Derry Road West, Canada", "mississauga", "Derry Road West", [], True),
        ("Toronto, ON, Canada (1307 - Sherway Gardens), Canada", "toronto", None,
         ["Sherway Gardens"], True),
        ("Vaughan, ON, Canada (1306 - Vaughan Mills), Canada", "vaughan", None,
         ["Vaughan Mills"], True),
        ("Vaughan, ON, Canada (DC03), Canada", "vaughan", None, [], False),
        ("Mississauga Office, Canada", "mississauga", None, [], False),
        ("Toronto, ON, Canada", "toronto", None, [], False),
        ("Hamilton, ON - Burlington St (LSC)", None, "Burlington St", [], False),
    ],
)  # fmt: skip
def test_parse_site_label(label, muni, street, places, resolvable):
    d = parse_site_label(label)
    assert (d.municipality, d.street, d.places, d.resolvable) == (muni, street, places, resolvable)


def test_brand_tokens():
    assert brand_tokens("1023 Becton Dickinson Canada Inc.") == ["becton", "dickinson"]
    assert brand_tokens(
        "United States of Aritzia Inc.", "https://aritzia.wd3.myworkdayjobs.com/x/"
    ) == ["aritzia"]
    assert "alumicor" in brand_tokens("Apogee Architectural Metals", None, ["alumicor"])


def _osm(name, lon, lat, road, city="Toronto", cls="shop", house="25", osm_id=1):
    return {"name": name, "lon": str(lon), "lat": str(lat), "category": cls, "osm_type": "way",
            "osm_id": osm_id, "address": {"road": road, "house_number": house, "city": city,
                                          "postcode": "M9C 1B8"}}  # fmt: skip


def _resolver(answers: dict[str, list]):
    def handler(req: httpx.Request):
        q = parse_qs(urlsplit(str(req.url)).query)["q"][0]
        return httpx.Response(200, content=json.dumps(answers.get(q, [])))

    return SiteResolver(httpx.Client(transport=httpx.MockTransport(handler)), "http://geo")


def test_named_place_resolves_to_the_mall():
    r = _resolver({"Sherway Gardens, Toronto": [
        _osm("Sherway Gardens", -79.557, 43.611, "The West Mall")]})  # fmt: skip
    hit = r.resolve(parse_site_label("Toronto, ON, Canada (1307 - Sherway Gardens)"), ["aritzia"])
    assert hit and hit.method == "named_place_osm" and hit.osm_ref == "way/1"
    assert "Sherway Gardens" in hit.display


def test_employer_on_street_requires_name_street_and_city():
    good = _osm("Autodesk", -79.39, 43.657, "University Avenue", cls="office", house="661")
    wrong_street = _osm("Autodesk", -79.40, 43.65, "King Street West", cls="office", osm_id=2)
    wrong_city = _osm("Autodesk", -79.6, 43.6, "University Avenue", city="Mississauga", osm_id=3)
    other_name = _osm("Some Bank", -79.39, 43.657, "University Avenue", cls="office", osm_id=4)
    r = _resolver(
        {"autodesk, University Ave, Toronto": [wrong_street, wrong_city, other_name, good]}
    )
    hit = r.resolve(
        parse_site_label("AMER - Canada - Ontario - Toronto - University Ave"), ["autodesk"]
    )
    assert hit and hit.method == "employer_on_street_osm" and hit.osm_ref == "way/1"
    assert "661 University Avenue" in hit.display


def test_two_distant_sites_are_ambiguous():
    a = _osm("Autodesk", -79.39, 43.657, "University Avenue", cls="office")
    b = _osm("Autodesk", -79.39, 43.700, "University Avenue", cls="office", osm_id=2)
    r = _resolver({"autodesk, University Ave, Toronto": [a, b]})
    assert r.resolve(parse_site_label("Toronto - University Ave"), ["autodesk"]) is None


def test_city_only_label_is_never_looked_up():
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, content="[]")

    r = SiteResolver(httpx.Client(transport=httpx.MockTransport(handler)), "http://geo")
    assert r.resolve(parse_site_label("Mississauga Office, Canada"), ["arterra"]) is None
    assert calls == []


@pytest.mark.parametrize(
    "place,name,ok",
    [
        ("Toronto Eaton Centre", "CF Toronto Eaton Centre", True),
        ("Sherway Gardens", "CF Sherway Gardens", True),
        ("Square One", "Square One Shopping Centre", True),
        ("Toronto Eaton Centre", "Eaton Centre parking", False),
        ("Markville", "Markville Ford Lincoln", False),
        (
            "Toronto Eaton Centre",
            "Sally Horsfall Eaton Centre for Studies in Community Health",
            False,
        ),
    ],
)
def test_place_name_matching(place, name, ok):
    from app.services.site_resolver import _place_name_matches

    assert _place_name_matches(place, name, "Toronto") is ok


def test_place_query_drops_leading_city_word():
    eaton = _osm("CF Toronto Eaton Centre", -79.381, 43.654, "Yonge Street", osm_id=7)
    parking = _osm("Eaton Centre parking", -79.380, 43.655, "Bay Street", cls="amenity", osm_id=8)
    r = _resolver({"Eaton Centre, Toronto": [parking, eaton]})
    hit = r.resolve(parse_site_label("Toronto, ON, Canada (1102 - Toronto Eaton Centre)"), [])
    assert hit and hit.osm_ref == "way/7"
