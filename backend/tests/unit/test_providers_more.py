from datetime import date

import httpx

from app.providers.bamboohr import BambooHRProvider
from app.providers.base import SourceRef
from app.providers.workable import WorkableProvider
from tests.conftest import load_fixture

bamboo = BambooHRProvider()
workable = WorkableProvider()


def test_bamboohr_recognize_and_normalize_real_detail():
    assert (
        bamboo.recognize("https://gorillalogic.bamboohr.com/careers/34").tenant_key
        == "gorillalogic"
    )
    assert bamboo.recognize("https://www.bamboohr.com/pricing") is None
    opening = load_fixture("bamboohr_gorillalogic.json")["detail"]["result"]["jobOpening"]
    n = bamboo.normalize({**opening, "_id": "34", "_sub": "gorillalogic"})
    assert n.external_id == "34" and n.workplace_type == "remote"
    assert n.posted_date == date(2025, 6, 9) and n.posted_precision == "date"
    assert n.apply_url == "https://gorillalogic.bamboohr.com/careers/34"


def test_bamboohr_verify_uses_explicit_status(make_client, fake_web):
    host = "acme.bamboohr.com"
    fake_web.add(
        host, "/robots.txt", httpx.Response(200, text="User-agent: *\nDisallow: /jobs/embed.php\n")
    )
    fake_web.json(
        host, "/careers/7/detail", {"result": {"jobOpening": {"jobOpeningStatus": "Open"}}}
    )
    ref = SourceRef("bamboohr", "acme")
    assert bamboo.verify_job(make_client(), ref, "7").state == "active"
    fake_web.json(
        host, "/careers/7/detail", {"result": {"jobOpening": {"jobOpeningStatus": "Filled"}}}
    )
    assert bamboo.verify_job(make_client(), ref, "7").state == "closed"
    fake_web.add(host, "/careers/7/detail", httpx.Response(503))
    assert bamboo.verify_job(make_client(max_retries=0), ref, "7").state == "unknown"


def test_bamboohr_listing_skips_clearly_foreign_jobs(make_client, fake_web):
    host = "acme.bamboohr.com"
    fake_web.add(host, "/robots.txt", httpx.Response(200, text="User-agent: *\nAllow: /\n"))
    fake_web.add(
        host,
        "/careers/list",
        httpx.Response(
            200,
            json={
                "meta": {"totalCount": 2},
                "result": [
                    {
                        "id": "1",
                        "location": {"city": "Graz", "state": "Österreich"},
                        "atsLocation": {},
                        "locationType": "0",
                    },
                    {
                        "id": "2",
                        "location": {"city": "Toronto", "state": "Ontario"},
                        "atsLocation": {"country": "Canada"},
                        "locationType": "2",
                    },
                ],
            },
        ),
    )
    fake_web.json(
        host,
        "/careers/2/detail",
        {
            "result": {
                "jobOpening": {
                    "jobOpeningName": "Analyst",
                    "locationType": "2",
                    "location": {"city": "Toronto", "state": "Ontario"},
                    "datePosted": "2026-10-01",
                }
            }
        },
    )
    page = bamboo.fetch_jobs(make_client(), SourceRef("bamboohr", "acme"), None)
    assert page.is_complete and [r["_id"] for r in page.records] == ["2"]
    assert set(page.listed_only) == {"1", "2"}
    assert bamboo.normalize(page.records[0]).workplace_type == "hybrid"


def test_workable_real_feed():
    feed = load_fixture("workable_enexor.json")["feed"]
    n = workable.normalize(feed["jobs"][0])
    assert n.location_text == "Franklin, Tennessee, United States"
    assert n.workplace_type == "unknown"  # an office city does not prove on-site
    assert n.posted_precision == "date" and n.posted_basis == "original"
    assert n.apply_url.startswith("https://apply.workable.com/j/")
    remote = workable.normalize({**feed["jobs"][0], "telecommuting": True})
    assert remote.workplace_type == "remote"
    assert (
        workable.recognize("https://apply.workable.com/enexor/j/1C7C9F114A/").tenant_key == "enexor"
    )
    assert workable.recognize("https://apply.workable.com/j/1C7C9F114A") is None
