import json
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
import pytest

from app.providers.ashby import AshbyProvider
from app.providers.base import ProviderError, SourceRef
from app.providers.jsonld import JsonLdProvider
from app.providers.lever import LeverProvider
from tests.conftest import load_fixture

ashby = AshbyProvider()
lever = LeverProvider()
jsonld = JsonLdProvider()


def _ashby_jobs(org):
    data = load_fixture("ashby_boards.json")
    return next(b["jobs"] for b in data["boards"] if b["org"] == org)


# ------------------------------------------------------------------ Ashby


def test_ashby_published_at_is_never_original_posting_time():
    for org in ("ramp", "cohere", "wealthsimple"):
        for raw in _ashby_jobs(org):
            n = ashby.normalize(raw)
            assert n.posted_at is None
            assert n.posted_basis == "republished_only"
            assert n.source_republished_at is not None


def test_ashby_workplace_and_addresses_from_real_fixture():
    ramp = [ashby.normalize(j) for j in _ashby_jobs("ramp")]
    onsite = next(n for n in ramp if n.location_text == "Toronto, ON")
    assert onsite.workplace_type == "on_site"
    addr = onsite.structured_addresses[0]
    assert addr.city == "Toronto" and addr.street is None  # city-only: never a map point

    ws = [ashby.normalize(j) for j in _ashby_jobs("wealthsimple")]
    assert any(n.workplace_type == "unknown" for n in ws)  # workplaceType null stays unknown

    cohere = [ashby.normalize(j) for j in _ashby_jobs("cohere")]
    remote = next(
        n for n in cohere if n.location_text == "Toronto" and n.workplace_type == "remote"
    )
    assert "Canada" in remote.extra_location_labels


def test_ashby_salary_only_when_single_component():
    single = {
        "compensationTiers": [
            {"components": [{"compensationType": "Salary", "minValue": 100000, "maxValue": 120000,
                             "currencyCode": "CAD", "interval": "1 YEAR", "summary": "$100K"}]}
        ]
    }  # fmt: skip
    n = ashby.normalize({"id": "1", "title": "X", "jobUrl": "https://j", "compensation": single})
    assert (n.salary_min, n.salary_max, n.salary_currency, n.salary_period) == (
        Decimal("100000"),
        Decimal("120000"),
        "CAD",
        "year",
    )
    two = {
        "compensationTierSummary": "$100K – $150K",
        "compensationTiers": single["compensationTiers"] * 2,
    }
    n = ashby.normalize({"id": "1", "title": "X", "jobUrl": "https://j", "compensation": two})
    assert n.salary_min is None and n.salary_raw == "$100K – $150K"


def test_ashby_unlisted_jobs_are_dropped(make_client, fake_web):
    fake_web.json(
        "api.ashbyhq.com",
        "/posting-api/job-board/acme?includeCompensation=true",
        {"jobs": [{"id": "a", "isListed": True}, {"id": "b", "isListed": False}]},
    )
    page = ashby.fetch_jobs(make_client(), SourceRef("ashby", "acme"), None)
    assert [r["id"] for r in page.records] == ["a"] and page.is_complete


def test_ashby_street_address_kept():
    n = ashby.normalize(
        {
            "id": "1", "title": "X", "jobUrl": "https://j", "workplaceType": "Hybrid",
            "address": {"postalAddress": {"streetAddress": "100 King St W",
                                          "addressLocality": "Toronto", "addressRegion": "ON",
                                          "addressCountry": "Canada"}},
        }
    )  # fmt: skip
    assert n.structured_addresses[0].one_line() == "100 King St W, Toronto, ON, Canada"


# ------------------------------------------------------------------ Lever


def test_lever_real_fixture():
    postings = load_fixture("lever_wattpad.json")["postings"]
    n = lever.normalize(postings[0])
    assert n.workplace_type == "hybrid"
    assert n.location_text == "Toronto, Ontario"
    assert n.posted_basis == "original" and n.posted_precision == "datetime"
    assert n.posted_at == datetime.fromtimestamp(postings[0]["createdAt"] / 1000, tz=UTC)
    assert (n.salary_currency, n.salary_period) == ("CAD", "year")
    assert n.apply_url.startswith("https://jobs.lever.co/")


def test_lever_pagination(make_client, fake_web):
    base = "/v0/postings/acme?mode=json&limit=100&skip="
    fake_web.json("api.lever.co", "/v0/postings/acme?mode=json&skip=0&limit=100",
                  [{"id": str(i)} for i in range(100)])  # fmt: skip
    fake_web.json("api.lever.co", "/v0/postings/acme?mode=json&skip=100&limit=100", [{"id": "x"}])
    client = make_client()
    p1 = lever.fetch_jobs(client, SourceRef("lever", "acme"), None)
    assert p1.next_cursor == "100"
    p2 = lever.fetch_jobs(client, SourceRef("lever", "acme"), p1.next_cursor)
    assert p2.next_cursor is None and len(p2.records) == 1
    assert base  # documented shape


def test_lever_verify_requires_healthy_site(make_client, fake_web):
    ref = SourceRef("lever", "acme")
    fake_web.add(
        "api.lever.co",
        "/v0/postings/acme/p1?mode=json",
        httpx.Response(404, json={"ok": False, "error": "Document not found"}),
    )
    fake_web.json("api.lever.co", "/v0/postings/acme?mode=json&skip=0&limit=100", [])
    fake_web.add("jobs.lever.co", "/acme", httpx.Response(200, text="<title>Acme</title>"))
    assert lever.verify_job(make_client(), ref, "p1").state == "closed"
    fake_web.add(
        "api.lever.co",
        "/v0/postings/acme?mode=json&skip=0&limit=100",
        httpx.Response(404, json={"ok": False, "error": "Document not found"}),
    )
    assert lever.verify_job(make_client(), ref, "p1").state == "unknown"


# ------------------------------------------------------------------ JSON-LD

POSTING = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "Store Associate",
    "url": "https://careers.example.ca/jobs/42?utm_source=x",
    "identifier": {"@type": "PropertyValue", "value": "REQ-42"},
    "datePosted": "2026-10-05",
    "validThrough": "2026-12-31T23:59:00-05:00",
    "hiringOrganization": {"@type": "Organization", "name": "Example Co"},
    "jobLocation": {
        "@type": "Place",
        "address": {
            "@type": "PostalAddress",
            "streetAddress": "220 Yonge St",
            "addressLocality": "Toronto",
            "addressRegion": "ON",
            "postalCode": "M5B 2H1",
            "addressCountry": "CA",
        },
    },
    "baseSalary": {
        "@type": "MonetaryAmount",
        "currency": "CAD",
        "value": {"@type": "QuantitativeValue", "minValue": 18, "maxValue": 21, "unitText": "HOUR"},
    },
    "description": "<p>Help customers.</p><script>alert(1)</script>",
}


def _page(objs, links=""):
    scripts = "".join(
        # Pages must escape "</" inside JSON-LD, as real sites do.
        f'<script type="application/ld+json">{json.dumps(o).replace("</", "<\\/")}</script>'
        for o in objs
    )
    return f"<html><head>{scripts}</head><body>{links}</body></html>"


def test_jsonld_normalize():
    n = jsonld.normalize({**POSTING, "_page_url": "https://careers.example.ca/jobs/42"})
    assert n.title == "Store Associate" and n.company_name == "Example Co"
    assert n.posted_at is None and n.posted_date == date(2026, 10, 5)
    assert n.posted_precision == "date" and "zone unknown" in n.posted_tz_basis
    assert n.structured_addresses[0].street == "220 Yonge St"
    assert n.workplace_type == "unknown"  # a jobLocation alone does not prove on-site
    assert (n.salary_min, n.salary_max, n.salary_period) == (Decimal("18"), Decimal("21"), "hour")
    assert n.description_text == "Help customers."
    assert n.valid_through is not None


def test_jsonld_remote_and_applicant_locations():
    raw = {**POSTING, "jobLocationType": "TELECOMMUTE",
           "applicantLocationRequirements": [{"@type": "Country", "name": "Canada"}]}  # fmt: skip
    n = jsonld.normalize({**raw, "_page_url": "https://careers.example.ca/jobs/42"})
    assert n.workplace_type == "remote" and n.eligibility_texts == ["Canada"]


def _robots(fake_web, host, body="User-agent: *\nAllow: /\n", status=200):
    fake_web.add(host, "/robots.txt", httpx.Response(status, text=body))


def test_jsonld_fetch_follows_same_host_job_links_and_is_never_complete(make_client, fake_web):
    host = "careers.example.ca"
    _robots(fake_web, host)
    links = (
        '<a href="/jobs/42">a</a><a href="https://other.example.com/jobs/1">x</a>'
        '<a href="/about">b</a>'
    )
    fake_web.add(host, "/", httpx.Response(200, text=_page([], links)))
    fake_web.add(host, "/jobs/42", httpx.Response(200, text=_page([POSTING])))
    page = jsonld.fetch_jobs(
        make_client(), SourceRef("jsonld", "https://careers.example.ca/"), None
    )
    assert len(page.records) == 1
    assert page.is_complete is False
    hosts = {r.headers["host"] for r in fake_web.requests}
    assert "other.example.com" not in hosts


def test_jsonld_respects_robots(make_client, fake_web):
    host = "careers.example.ca"
    _robots(fake_web, host, "User-agent: *\nDisallow: /\n")
    with pytest.raises(ProviderError) as exc:
        jsonld.fetch_jobs(make_client(), SourceRef("jsonld", "https://careers.example.ca/"), None)
    assert exc.value.error_class == "robots"


def test_jsonld_robots_unreachable_means_no_fetch_but_is_temporary(make_client, fake_web):
    from app.net.robots import RobotsUnavailable

    host = "careers.example.ca"
    _robots(fake_web, host, "", status=503)
    with pytest.raises(RobotsUnavailable):
        jsonld.fetch_jobs(make_client(max_retries=0), SourceRef("jsonld", f"https://{host}/"), None)


def test_jsonld_verify(make_client, fake_web):
    host = "careers.example.ca"
    _robots(fake_web, host)
    ref = SourceRef("jsonld", "https://careers.example.ca/")
    url = "https://careers.example.ca/jobs/42"
    expired = {**POSTING, "validThrough": "2020-01-01T00:00:00Z"}
    fake_web.add(host, "/jobs/42", httpx.Response(200, text=_page([expired])))
    assert jsonld.verify_job(make_client(), ref, url).state == "closed"
    fake_web.add(host, "/jobs/42", httpx.Response(200, text=_page([POSTING])))
    assert jsonld.verify_job(make_client(), ref, url).state == "active"
    fake_web.add(host, "/jobs/42", httpx.Response(410))
    assert jsonld.verify_job(make_client(), ref, url).state == "closed"
    fake_web.add(host, "/jobs/42", httpx.Response(404))
    assert jsonld.verify_job(make_client(), ref, url).state == "unknown"  # could be a move
    fake_web.add(host, "/jobs/42", httpx.Response(200, text="<html>login</html>"))
    assert jsonld.verify_job(make_client(), ref, url).state == "unknown"
