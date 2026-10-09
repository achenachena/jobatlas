"""Enterprise career sites, field-style addresses and company-site address extraction."""

from datetime import UTC, date, datetime

import pytest

from app.providers.successfactors import SuccessFactorsProvider, parse_job_page
from app.providers.workday import WorkdayProvider, site_root
from app.services.addresses import extract_explicit_addresses
from app.services.company_sites import _candidate_hosts, _from_text, registrable_domain
from app.services.search import date_floor
from tests.conftest import FIXTURES

sf = SuccessFactorsProvider()
wd = WorkdayProvider()

# ------------------------------------------------------------------ SuccessFactors


def test_successfactors_real_page():
    url = "https://jobs.toronto.ca/jobsatcity/job/Toronto-SPATIAL-SPECIALIST-ON-M5V-3C6/606816817/"
    page = parse_job_page((FIXTURES / "sf_toronto_job.html").read_text(errors="ignore"), url)
    assert page["hiring_organization"] == "City of Toronto"
    assert page["postal_code"] == "M5V 3C6" and not page["ended"]
    n = sf.normalize(page)
    assert n.external_id == "606816817"
    assert n.posted_precision == "date" and n.posted_at is None
    assert n.posted_date == date(2026, 10, 7)
    assert n.valid_through == datetime(2026, 10, 23, 4, 0, tzinfo=UTC)
    # Microdata is city-level only; the explicit work site comes from the posting text.
    assert all(a.street is None for a in n.structured_addresses)
    assert [a.display for a in extract_explicit_addresses(n.description_text)] == [
        "55 John St., Toronto, ON"
    ]


def test_successfactors_ended_page_is_detected():
    page = parse_job_page(
        (FIXTURES / "sf_toronto_job_ended.html").read_text(errors="ignore"),
        "https://jobs.toronto.ca/jobsatcity/job/x/556417117/",
    )
    assert page["ended"] and page["title"] is None


@pytest.mark.parametrize(
    "url,root",
    [
        ("https://jobs.toronto.ca/jobsatcity/job/Toronto-X-ON-M5V-3C6/606826317/",
         "https://jobs.toronto.ca/jobsatcity/"),
        ("https://careers.example.com/site/job/Store-Clerk/1234567/", "https://careers.example.com/site/"),
    ],
)  # fmt: skip
def test_successfactors_recognize(url, root):
    assert sf.recognize(url).tenant_key == root


def test_successfactors_does_not_claim_workday_urls():
    assert (
        sf.recognize("https://td.wd3.myworkdayjobs.com/TD/job/Toronto-Ontario/X_R_1504637") is None
    )


# ------------------------------------------------------------------ Workday


@pytest.mark.parametrize(
    "url,root",
    [
        ("https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/job/Toronto-Ontario/X_R_1",
         "https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/"),
        ("https://td.wd3.myworkdayjobs.com/en-US/TD_Bank_Careers/details/x",
         "https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/"),
        ("https://wd3.myworkdaysite.com/recruiting/magna/Magna/job/x",
         "https://wd3.myworkdaysite.com/recruiting/magna/Magna/"),
        ("https://td.wd3.myworkdayjobs.com/wday/cxs/td/x/jobs", None),
        ("https://example.com/TD_Bank_Careers/job/x", None),
    ],
)  # fmt: skip
def test_workday_site_root(url, root):
    assert site_root(url) == root


def test_workday_real_jsonld():
    from app.providers.jsonld import job_postings, parse_html

    markup = (FIXTURES / "workday_td_job.html").read_text()
    post = job_postings(parse_html(markup)[0])[0]
    url = "https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/job/Toronto-Ontario/X_R_1504637"
    n = wd.normalize({**post, "url": url, "_page_url": url})
    assert n.company_name == "The Toronto-Dominion Bank (Canada)"
    addr = n.structured_addresses[0]
    assert addr.street == "66 Wellington Street West" and addr.city == "Toronto"
    assert addr.method == "workday_jsonld_address"
    # TELECOMMUTE on Workday is not proof of a fully remote job.
    assert n.workplace_type == "unknown" and n.eligibility_texts == []
    assert n.posted_precision == "date" and n.posted_date == date(2026, 10, 6)
    assert n.requisition_id == "R_1504637"


# ------------------------------------------------------------------ field-style addresses


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Work Location: Metro Hall, 55 John St., Toronto, ON Job Type & Duration: Full-time",
         ["55 John St., Toronto, ON"]),
        ("Work Location: 18 Dyas Rd, North York, ON M3B 1V5 Job Type & Duration: Full-time",
         ["18 Dyas Rd, North York, ON M3B 1V5"]),
        ("Work Location: Metro Hall, 55 John Street, 1050 Ellesmere Road Job Type: Temp",
         ["55 John Street", "1050 Ellesmere Road"]),
        ("Job Location: Union Station, 61 Front Street West, Toronto, ON Salary Range: 1",
         ["61 Front Street West, Toronto, ON"]),
        ("Location: Toronto, ON\nWe are hiring", []),
        ("Location: 12345 Ninth Line, Markham, ON", ["12345 Ninth Line, Markham, ON"]),
    ],
)  # fmt: skip
def test_field_style_addresses(text, expected):
    assert [a.display for a in extract_explicit_addresses(text)] == expected


def test_city_less_addresses_are_flagged():
    found = extract_explicit_addresses("Work Location: 1050 Ellesmere Road Job Type: x")
    assert found[0].has_city is False


# ------------------------------------------------------------------ company sites


def test_candidate_hosts_ignore_ats_and_noise():
    markup = (
        '<a href="https://www.7shifts.com/">Home</a>'
        '<a href="https://job-boards.greenhouse.io/x">jobs</a>'
        '<a href="https://www.linkedin.com/company/x">in</a>'
        '<script>{"website":"https://cohere.com/"}</script>'
    )
    hosts = _candidate_hosts(markup)
    assert "7shifts.com" in hosts and "cohere.com" in hosts
    assert not any("greenhouse" in h or "linkedin" in h for h in hosts)
    assert registrable_domain("careers.example.co.uk") == "example.co.uk"


def test_text_addresses_from_privacy_page():
    html = (
        "<p>Contact us: Cohere Inc.<br>171 John Street, Suite 200<br>Toronto, ON Canada M5T 1X3"
        "</p><p>Our headquarters: 80 Spadina Ave., Toronto, ON.</p>"
        "<p>Mail: P.O. Box 55, 100 King St W, Toronto, ON</p>"
    )
    found = _from_text(html, "https://cohere.com/privacy")
    streets = {f.address.street: f.role for f in found}
    assert streets.get("171 John Street, Suite 200") == "office"
    assert streets.get("80 Spadina Ave.") == "headquarters"
    assert not any(s.startswith("100 King") for s in streets)  # P.O. box context skipped


# ------------------------------------------------------------------ date-only time windows


def test_date_floor_is_conservative():
    # A date of unknown zone counts only when it certainly began after the window start.
    assert date_floor(datetime(2026, 10, 5, 12, 0, tzinfo=UTC)) == date(2026, 10, 7)
    assert date_floor(datetime(2026, 10, 5, 10, 0, tzinfo=UTC)) == date(2026, 10, 6)
    assert date_floor(None) is None


def test_california_abbreviation_is_not_canada():
    found = _from_text("<p>Airbyte, 2261 Market Street #4381, San Francisco, CA 94114</p>", "x")
    assert all(f.address.country != "Canada" for f in found)
    from app.services.company_sites import office_region

    assert all(
        office_region(f.address) is None or office_region(f.address).region_id != "ca-on"
        for f in found
    )


def test_canada_facet_detection_real_shapes():
    from app.providers.workday import CANADA_ID, canada_facet

    bmo = [{"facetParameter": "Country", "values": [
        {"descriptor": "Canada", "id": CANADA_ID, "count": 508},
        {"descriptor": "United States of America", "id": "x", "count": 437}]}]  # fmt: skip
    td = [{"facetParameter": "locationMainGroup", "values": [
        {"facetParameter": "locationCountry", "values": [
            {"descriptor": "Canada", "id": CANADA_ID, "count": 917}]}]}]  # fmt: skip
    us_only = [
        {"facetParameter": "Country", "values": [{"descriptor": "United States", "id": "x"}]}
    ]
    none = [{"facetParameter": "jobFamily", "values": [{"descriptor": "Sales", "id": "y"}]}]
    assert canada_facet(bmo) == ("Country", True)
    assert canada_facet(td) == ("locationCountry", True)
    assert canada_facet(us_only) == (None, True)  # no Canadian jobs: skip the tenant cheaply
    assert canada_facet(none) == (None, False)  # no country facet: read the full listing


@pytest.mark.parametrize(
    "text,expected,has_city",
    [
        # Section words after the street are not a city (seen live on Workday detail pages).
        ("Office located at 181 Bay Street Job Family Group: Finance", "181 Bay Street", False),
        ("Location: 81 Bay Street Duration: 12 months", "81 Bay Street", False),
        ("Work Location: 55 John Street, Toronto. See the posting for hours",
         "55 John Street, Toronto", True),
        ("Location: 123 St. Clair Ave W, Toronto, ON", "123 St. Clair Ave W, Toronto, ON", True),
    ],
)  # fmt: skip
def test_trailing_words_are_not_cities(text, expected, has_city):
    [a] = extract_explicit_addresses(text)
    assert (a.display, a.has_city) == (expected, has_city)


def test_ordinal_floor_and_ont_abbreviation():
    from app.services.addresses import normalize_address
    from app.services.geocode import parse_address

    assert "floor" not in normalize_address("55 York Street, 12th Floor, Toronto")
    assert parse_address("2190 Derry Rd E Mississauga Ont. L5S 1E2").city == "mississauga"
