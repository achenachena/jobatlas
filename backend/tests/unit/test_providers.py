from datetime import UTC, datetime

import httpx
import pytest

from app.providers.base import SourceRef
from app.providers.greenhouse import GreenhouseProvider
from app.providers.recognizers import AshbyRecognizer, LeverRecognizer
from app.providers.registry import recognize
from app.providers.text import html_to_text, workplace_from_location_label
from tests.conftest import load_fixture

gh = GreenhouseProvider()


@pytest.mark.parametrize(
    "url,tenant",
    [
        ("https://job-boards.greenhouse.io/stripe/jobs/8172510", "stripe"),
        ("https://boards.greenhouse.io/Stripe", "stripe"),
        ("https://boards.greenhouse.io/embed/job_board?for=acme&b=x", "acme"),
        ("https://boards.greenhouse.io/embed/job_app?for=acme&token=1", "acme"),
        ("https://boards-api.greenhouse.io/v1/boards/acme/jobs", "acme"),
    ],
)
def test_greenhouse_recognize(url, tenant):
    cand = gh.recognize(url)
    assert cand is not None and cand.tenant_key == tenant
    assert cand.canonical_url == f"https://job-boards.greenhouse.io/{tenant}"


@pytest.mark.parametrize(
    "url",
    [
        "https://boards.greenhouse.io/",
        "https://boards.greenhouse.io/embed/job_board",
        "https://www.greenhouse.io/careers",
        "https://boards.greenhouse.io/robots.txt",
        "https://evil.com/boards.greenhouse.io/acme",
    ],
)
def test_greenhouse_recognize_rejects(url):
    assert gh.recognize(url) is None


def test_ashby_and_lever_recognize():
    a = AshbyRecognizer().recognize("https://jobs.ashbyhq.com/1st%20Formations/abc/application")
    assert a and a.tenant_key == "1st formations"
    assert a.canonical_url == "https://jobs.ashbyhq.com/1st%20formations"
    assert AshbyRecognizer().recognize("https://jobs.ashbyhq.com/api/x") is None
    assert (
        AshbyRecognizer().recognize("https://jobs.ashbyhq.com/91b38662-e5a9-4bc3-ade7-44e29d01d343")
        is None
    )
    lv = LeverRecognizer().recognize("https://jobs.eu.lever.co/acme/123")
    assert lv and lv.tenant_key == "eu:acme"
    assert recognize("https://jobs.lever.co/palantir/6ed7")
    assert recognize("https://example.com/careers") is None


def test_greenhouse_normalize_real_fixture_time_semantics():
    data = load_fixture("greenhouse_stripe_jobs.json")
    by_id = {str(j["id"]): gh.normalize(j) for j in data["jobs"]}
    toronto = by_id["8194287"]
    assert toronto.title
    assert toronto.location_text == "Toronto"
    # first_published is the original posting time; updated_at is kept separately.
    assert toronto.posted_at == datetime(2026, 10, 1, 15, 5, 36, tzinfo=UTC)
    assert toronto.posted_basis == "original" and toronto.posted_precision == "datetime"
    assert toronto.source_updated_at == datetime(2026, 10, 7, 23, 2, 27, tzinfo=UTC)
    assert toronto.posted_at != toronto.source_updated_at
    # No explicit word in the label -> unknown, never defaulted to on_site.
    assert toronto.workplace_type == "unknown"
    assert toronto.apply_url.startswith("https://")
    assert "<" not in (toronto.description_text or "")
    assert toronto.requisition_id is None  # "See Opening ID" placeholder dropped


def test_greenhouse_normalize_missing_first_published_is_unknown():
    raw = {"id": 1, "title": "X", "absolute_url": "https://x", "updated_at": "2026-10-01T00:00:00Z"}
    n = gh.normalize(raw)
    assert n.posted_at is None and n.posted_basis == "unknown" and n.posted_precision == "none"
    assert n.source_updated_at is not None


def test_greenhouse_rejects_non_http_apply_url():
    n = gh.normalize({"id": 2, "title": "X", "absolute_url": "javascript:alert(1)"})
    assert n.apply_url is None


@pytest.mark.parametrize(
    "label,expected",
    [
        ("Remote (United States | Canada)", "remote"),
        ("Remote - Canada", "remote"),
        ("Remote from the US", "remote"),
        ("Toronto, Hybrid", "hybrid"),
        ("Toronto", "unknown"),
        ("Toronto Canada, San Francisco, Remote in US, Remote in Canada", "unknown"),
        ("Remote or Hybrid - Toronto", "unknown"),
        (None, "unknown"),
    ],
)
def test_workplace_from_label(label, expected):
    assert workplace_from_location_label(label)[0] == expected


def test_html_to_text_strips_scripts_and_tags():
    out = html_to_text(
        "&lt;p&gt;Hi&lt;script&gt;alert(1)&lt;/script&gt;&lt;/p&gt;", already_escaped=True
    )
    assert out == "Hi"


def test_greenhouse_fetch_completeness(make_client, fake_web):
    data = load_fixture("greenhouse_stripe_jobs.json")
    host = "boards-api.greenhouse.io"
    fake_web.json(host, "/v1/boards/stripe/jobs?content=true", data)
    page = gh.fetch_jobs(make_client(), SourceRef("greenhouse", "stripe"), None)
    assert page.is_complete and len(page.records) == len(data["jobs"])

    short = {**data, "meta": {"total": len(data["jobs"]) + 5}}
    fake_web.json(host, "/v1/boards/stripe/jobs?content=true", short)
    page = gh.fetch_jobs(make_client(), SourceRef("greenhouse", "stripe"), None)
    assert not page.is_complete


def test_greenhouse_verify_job_closure_requires_healthy_board(make_client, fake_web):
    host = "boards-api.greenhouse.io"
    ref = SourceRef("greenhouse", "acme")
    fake_web.add(
        host, "/v1/boards/acme/jobs/1", httpx.Response(404, json={"error": "Job not found"})
    )
    fake_web.json(host, "/v1/boards/acme", {"name": "Acme"})
    assert gh.verify_job(make_client(), ref, "1").state == "closed"

    fake_web.add(host, "/v1/boards/acme", httpx.Response(404, json={"error": "nope"}))
    assert gh.verify_job(make_client(), ref, "1").state == "unknown"

    fake_web.add(host, "/v1/boards/acme/jobs/1", httpx.Response(403, text="denied"))
    assert gh.verify_job(make_client(), ref, "1").state == "unknown"
    fake_web.add(host, "/v1/boards/acme/jobs/1", httpx.Response(404, text="<html>login</html>"))
    assert gh.verify_job(make_client(), ref, "1").state == "unknown"
