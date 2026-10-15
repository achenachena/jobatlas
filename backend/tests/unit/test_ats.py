"""Employer boards: location recognition, platform payloads, board URLs."""

from datetime import UTC, datetime

import pytest

from app.atlas.ats import LocationParser, parse_ashby, parse_greenhouse, parse_lever, recognize
from app.atlas.cities import CityIndex

CITIES = {
    ("ON", "toronto"): [(2600000, "ca-on-toronto")],
    ("ON", "london"): [(400000, "ca-on-london")],
    ("ON", "waterloo"): [(120000, "ca-on-waterloo")],
    ("QC", "montreal"): [(1600000, "ca-qc-montreal")],
    ("QC", "trois rivieres"): [(140000, "ca-qc-trois-rivieres")],
    ("AB", "calgary"): [(1300000, "ca-ab-calgary")],
    ("BC", "vancouver"): [(660000, "ca-bc-vancouver")],
    ("NL", "saint john's"): [(110000, "ca-nl-st-johns")],
}


@pytest.fixture
def loc():
    return LocationParser(CityIndex(entries=CITIES))


@pytest.mark.parametrize(
    "label,expected",
    [
        ("Toronto", [("ca-on-toronto", "city")]),
        ("Toronto, Canada", [("ca-on-toronto", "city")]),
        ("Toronto, ON", [("ca-on-toronto", "city")]),
        ("Toronto, Ontario, Canada", [("ca-on-toronto", "city")]),
        ("Montréal, Québec", [("ca-qc-montreal", "city")]),
        ("Trois-Rivières, QC", [("ca-qc-trois-rivieres", "city")]),  # hyphen inside a name
        ("St. John's, Newfoundland and Labrador", [("ca-nl-st-johns", "city")]),
        ("Toronto (Hybrid)", [("ca-on-toronto", "city")]),
        ("Hybrid - Vancouver, BC", [("ca-bc-vancouver", "city")]),
        ("CA-Toronto", [("ca-on-toronto", "city")]),
        ("Toronto, CA", [("ca-on-toronto", "city")]),
        ("London, ON", [("ca-on-london", "city")]),
        ("Waterloo, Ontario", [("ca-on-waterloo", "city")]),
        ("Toronto or Montreal", [("ca-on-toronto", "city"), ("ca-qc-montreal", "city")]),
        ("US-Remote; US-Chicago; CA-Toronto; CA-Remote", [("ca-on-toronto", "city")]),
        # real Greenhouse labels (Stripe, 2026-10-15)
        ("Chicago, Toronto", [("ca-on-toronto", "city")]),
        ("SEA, SF, NY, Toronto", [("ca-on-toronto", "city")]),
        (
            "Toronto, Vancouver, Canada-Remote",
            [("ca-on-toronto", "city"), ("ca-bc-vancouver", "city")],
        ),
        (
            "US-NYC; US-Seattle; US-Remote; Canada-Toronto; Canada-Remote",
            [("ca-on-toronto", "city")],
        ),
        (
            "Toronto Canada, San Francisco, Remote in US, Remote in Canada",
            [("ca-on-toronto", "city")],
        ),
        ("New York, US - Remote, Toronto", [("ca-on-toronto", "city")]),
        ("Toronto, Remote-Canada ", [("ca-on-toronto", "city")]),
        ("Toronto (GTA)", [("ca-on-toronto", "city")]),
        ("Remote in the US, Remote in Canada", [(None, "remote")]),
        ("Chicago, US-Remote, Canada-Remote", [(None, "remote")]),
        ("Remote - Canada", [(None, "remote")]),
        ("Canada (Remote)", [(None, "remote")]),
        ("CA-Remote", [(None, "remote")]),
        ("Canada", [(None, "unconfirmed")]),
        ("US / Canada", [(None, "unconfirmed")]),
        ("Ontario", [(None, "unconfirmed")]),
        ("Greater Toronto Area", [(None, "unconfirmed")]),
        # not Canada, or not knowable
        ("San Francisco, CA", []),  # California
        ("Vancouver, WA", []),
        ("Vancouver, Washington", []),
        ("Paris, France", []),
        ("London", []),  # bare name that is not unambiguous
        ("London, UK", []),
        ("Amsterdam, NL", []),  # NL is also the Netherlands
        ("Lima, PE", []),
        ("Remote", []),
        ("US-Remote", []),
        ("New York, NY", []),
        ("", []),
    ],
)
def test_location_labels(loc, label, expected):
    assert [(p.city_id, p.geo) for p in loc.places([label])] == expected


def test_country_hint_without_a_place(loc):
    assert [(p.city_id, p.geo) for p in loc.places(["Remote"], country_ca=True, remote=True)] == [
        (None, "remote")
    ]
    assert loc.places(["Remote"], country_ca=False) == []


def test_greenhouse_payload(loc):
    data = {"jobs": [
        {"id": 1, "title": "Software Engineer", "company_name": "Acme",
         "first_published": "2026-10-10T09:00:00-04:00", "location": {"name": "Toronto, Canada"}},
        {"id": 2, "title": "AE", "company_name": "Acme",
         "first_published": "2026-10-10T09:00:00-04:00", "location": {"name": "Seattle, WA"}},
        {"id": 3, "title": "PM", "company_name": "Acme", "first_published": None,
         "location": None},
    ]}  # fmt: skip
    b = parse_greenhouse(data, loc)
    assert (b.company, b.total, [j.id for j in b.jobs]) == ("Acme", 3, ["1"])
    assert b.jobs[0].published == datetime(2026, 10, 10, 13, tzinfo=UTC)


def test_lever_payload_uses_country_and_all_locations(loc):
    data = [
        {"id": "a", "text": "Backend Developer", "country": "CA", "createdAt": 1760400000000,
         "workplaceType": "hybrid",
         "categories": {"location": "Montreal, Quebec", "allLocations": ["Montreal, Quebec"]}},
        {"id": "b", "text": "Designer", "country": "CA", "createdAt": 1760400000000,
         "workplaceType": "remote", "categories": {"location": "Remote"}},
        {"id": "c", "text": "Sales", "country": "US", "createdAt": 1760400000000,
         "categories": {"location": "El Segundo, California",
                        "allLocations": ["El Segundo, California", "Toronto, Ontario"]}},
        {"id": "d", "text": "Ops", "country": "US", "categories": {"location": "Austin, Texas"}},
    ]  # fmt: skip
    b = parse_lever(data, loc)
    got = {j.id: [(p.city_id, p.geo) for p in j.places] for j in b.jobs}
    assert got == {
        "a": [("ca-qc-montreal", "city")],
        "b": [(None, "remote")],
        "c": [("ca-on-toronto", "city")],
    }
    assert b.total == 4 and b.jobs[0].workplace == "hybrid"


def test_ashby_payload_prefers_addresses_and_keeps_publishedat_for_baseline(loc):
    data = {"jobs": [
        {"id": "x", "title": "ML Engineer", "isListed": True, "isRemote": True,
         "workplaceType": "Remote", "publishedAt": "2026-09-15T18:21:37.401+00:00",
         "location": "London",
         "address": {"postalAddress": {"addressCountry": "United Kingdom",
                                       "addressLocality": "London"}},
         "secondaryLocations": [
             {"location": "Toronto", "address": {"postalAddress": {
                 "addressCountry": "Canada", "addressRegion": "Ontario",
                 "addressLocality": "Toronto"}}},
             {"location": "Montreal", "address": {"postalAddress": {
                 "addressCountry": "Canada", "addressRegion": "Quebec ",
                 "addressLocality": "Montreal"}}}]},
        {"id": "y", "title": "Hidden", "isListed": False, "location": "Toronto"},
        {"id": "r", "title": "Remote role", "isListed": True, "isRemote": True,
         "location": "Canada", "address": {"postalAddress": {"addressCountry": "Canada"}}},
        {"id": "z", "title": "Paris role", "isListed": True, "location": "Paris",
         "address": {"postalAddress": {"addressCountry": "France"}}},
    ]}  # fmt: skip
    b = parse_ashby(data, loc)
    assert b.total == 3  # unlisted jobs are not public
    job, remote = b.jobs
    assert [(p.city_id, p.geo) for p in remote.places] == [(None, "remote")]
    assert [p.city_id for p in job.places] == ["ca-on-toronto", "ca-qc-montreal"]
    assert job.published is None  # Ashby postings are dated when first seen ...
    assert job.baseline_published == datetime(2026, 9, 15, 18, 21, 37, 401000, tzinfo=UTC)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://boards.greenhouse.io/Acme/jobs/123", ("greenhouse", "acme")),
        ("https://job-boards.greenhouse.io/acme", ("greenhouse", "acme")),
        ("https://boards.greenhouse.io/embed/job_board?for=acme", ("greenhouse", "acme")),
        ("https://jobs.lever.co/beta/0f1e2d", ("lever", "beta")),
        ("jobs.ashbyhq.com/Gamma/abc", ("ashby", "gamma")),
        ("https://boards.greenhouse.io/embed/job_app", None),
        ("https://jobs.ashbyhq.com/api/x", None),
        ("https://jobs.smartrecruiters.com/acme", None),  # not an admitted channel
        ("https://acme.wd3.myworkdayjobs.com/careers", None),
    ],
)
def test_recognize(url, expected):
    assert recognize(url) == expected
