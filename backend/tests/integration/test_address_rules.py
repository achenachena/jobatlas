from datetime import date, timedelta

import httpx
import pytest
from geoalchemy2.elements import WKTElement
from sqlalchemy import select

from app.core.timeutil import utcnow
from app.models import CompanyLocation, Evidence, Job, JobLocation, JobSourceRecord, Location
from app.providers.base import BoardInfo, SourceCandidate
from app.services.ingest import sync_source
from app.services.locations import link_job_to_company_locations, refresh_location_status
from app.services.sources import register_source
from tests.conftest import FIXTURES
from tests.integration import factories as f

pytestmark = pytest.mark.integration


def _office(session, company, street, label, role="office", precise=True):
    loc = Location(
        normalized_address=f"{street.lower()} {label}",
        display_address=f"{street}, Toronto, ON",
        point=WKTElement("POINT(-79.39 43.65)", srid=4326) if precise else None,
        precision="rooftop" if precise else "unknown",
    )
    session.add(loc)
    session.flush()
    ev = Evidence(entity_type="company", entity_id=company.id, field=role,
                  source_url="https://example.test/contact", excerpt=street,
                  observed_at=utcnow(), method="official_site_text", confidence="high")  # fmt: skip
    session.add(ev)
    session.flush()
    session.add(CompanyLocation(company_id=company.id, location_id=loc.id, role=role,
                                label=label, evidence_id=ev.id))  # fmt: skip
    session.flush()
    return loc


def _links(session, job):
    return session.execute(
        select(JobLocation.role, JobLocation.verification_status, Evidence.method)
        .join(Evidence, Evidence.id == JobLocation.evidence_id)
        .where(JobLocation.job_id == job.id)
    ).all()


def test_single_city_office_is_shown_as_inferred_not_verified(session):
    # User decision 2026-10-09: the company's only office in the job's city goes on the map,
    # but is labelled inferred — the posting itself never stated that address.
    c = f.company(session)
    _office(session, c, "171 John Street", "toronto")
    job = f.job(session, c, workplace="hybrid", region="toronto")
    link_job_to_company_locations(session, job, utcnow())
    assert refresh_location_status(session, job) == "inferred_office"
    assert _links(session, job) == [("work_site", "verified", "company_single_city_office")]
    ev = session.scalar(
        select(Evidence).where(
            Evidence.entity_id == job.id, Evidence.method == "company_single_city_office"
        )
    )
    assert "only published address in toronto" in ev.excerpt
    assert ev.source_url == "https://example.test/contact"


def test_two_offices_in_city_means_no_link(session):
    c = f.company(session)
    _office(session, c, "171 John Street", "toronto")
    _office(session, c, "80 Spadina Ave", "toronto")
    job = f.job(session, c, workplace="on_site", region="toronto")
    link_job_to_company_locations(session, job, utcnow())
    assert refresh_location_status(session, job) == "unverified"
    assert _links(session, job) == []


def test_office_in_other_city_or_only_gta_label_does_not_link(session):
    c = f.company(session)
    _office(session, c, "1 Mississauga Rd", "mississauga")
    toronto_job = f.job(session, c, region="toronto")
    gta_job = f.job(session, c, region="gta")
    for j in (toronto_job, gta_job):
        link_job_to_company_locations(session, j, utcnow())
        assert refresh_location_status(session, j) == "unverified"


def test_remote_job_prefers_city_office_then_hq(session):
    c = f.company(session)
    _office(session, c, "500 Market St", "san-francisco", role="headquarters")
    remote_ca = f.job(session, c, workplace="remote", region=None, eligibility=({"ca"}, set()))
    link_job_to_company_locations(session, remote_ca, utcnow())
    assert refresh_location_status(session, remote_ca) == "company_location"
    assert _links(session, remote_ca)[0][0] == "headquarters"

    _office(session, c, "171 John Street", "toronto")
    remote_tor = f.job(session, c, workplace="remote", region="toronto",
                       eligibility=({"toronto"}, set()))  # fmt: skip
    link_job_to_company_locations(session, remote_tor, utcnow())
    assert _links(session, remote_tor) == [
        ("company_office", "verified", "company_single_city_office")
    ]


def test_explicit_job_address_is_never_replaced_by_company_office(session):
    c = f.company(session)
    _office(session, c, "171 John Street", "toronto")
    job = f.job(session, c, workplace="hybrid", region="toronto", point=(-79.38, 43.65))
    session.scalar(
        select(Evidence).where(Evidence.entity_id == job.id)
    ).method = "description_explicit_address"
    session.flush()
    link_job_to_company_locations(session, job, utcnow())
    assert [m for _, _, m in _links(session, job)] == ["description_explicit_address"]


def test_job_stated_address_outranks_inferred_office(session):
    c = f.company(session)
    _office(session, c, "171 John Street", "toronto")
    job = f.job(session, c, workplace="on_site", region="toronto")
    link_job_to_company_locations(session, job, utcnow())
    assert refresh_location_status(session, job) == "inferred_office"
    explicit = f.job(session, c, workplace="on_site", region="toronto", point=(-79.38, 43.65))
    session.scalar(
        select(Evidence).where(Evidence.entity_id == explicit.id)
    ).method = "description_explicit_address"
    session.flush()
    assert refresh_location_status(session, explicit) == "exact_work_location"


def test_second_office_later_invalidates_the_link(session):
    c = f.company(session)
    _office(session, c, "171 John Street", "toronto")
    job = f.job(session, c, workplace="on_site", region="toronto")
    link_job_to_company_locations(session, job, utcnow())
    _office(session, c, "80 Spadina Ave", "toronto")
    link_job_to_company_locations(session, job, utcnow())
    assert refresh_location_status(session, job) == "unverified"
    assert _links(session, job) == [("work_site", "invalidated", "company_single_city_office")]


# ------------------------------------------------------------------ career site lifecycle

HOST = "jobs.toronto.ca"
JOB = "/jobsatcity/job/Toronto-PROGRAM-COORDINATOR-ON-M5V-3C6/606826317/"


def _sitemap(urls):
    body = "".join(f"<url><loc>https://{HOST}{u}</loc><lastmod>2026-10-07</lastmod></url>"
                   for u in urls)  # fmt: skip
    return httpx.Response(200, text=f'<?xml version="1.0"?><urlset>{body}</urlset>')


def test_career_site_job_closes_only_on_explicit_ended_page(session, make_client, fake_web):
    fake_web.add(HOST, "/robots.txt", httpx.Response(200, text="User-agent: *\nAllow: /\n"))
    fake_web.add(HOST, "/sitemap.xml", _sitemap([JOB]))
    live = (FIXTURES / "sf_toronto_job.html").read_text(errors="ignore")
    ended = (FIXTURES / "sf_toronto_job_ended.html").read_text(errors="ignore")
    fake_web.add(HOST, JOB, httpx.Response(200, text=live))
    cand = SourceCandidate("successfactors", f"https://{HOST}/jobsatcity/",
                           f"https://{HOST}/jobsatcity/")  # fmt: skip
    src, _ = register_source(session, cand, BoardInfo(exists=True, company_name="City of Toronto"),
                             discovered_via="manual", discovery_url=None,
                             discovery_candidate_id=None)  # fmt: skip
    session.commit()
    r = sync_source(session, src.id, make_client())
    assert r.created == 1 and not r.is_complete
    job = session.scalar(select(Job))
    assert job.posted_precision == "date"
    loc = session.scalar(select(Location))
    assert loc.display_address == "55 John St., Toronto, ON"

    # Dropped from the sitemap but the page is still live: stays active, re-verified.
    fake_web.add(HOST, "/sitemap.xml", _sitemap([]))
    sync_source(session, src.id, make_client())
    session.refresh(job)
    assert job.status == "active"

    # Page now says the posting has ended: explicit closure.
    fake_web.add(HOST, JOB, httpx.Response(200, text=ended))
    r = sync_source(session, src.id, make_client())
    session.refresh(job)
    assert job.status == "closed" and "has ended" in job.close_reason

    # Recently verified jobs are not refetched (incremental), but are not treated as missing.
    rec = session.scalar(select(JobSourceRecord))
    assert rec.last_seen_at > utcnow() - timedelta(minutes=5)


def test_date_only_postings_in_rolling_window(session):
    """Integration of the conservative date floor with the search SQL is covered via API in
    test_api; here we just make sure date-only jobs are stored as such."""
    c = f.company(session)
    j = f.job(session, c)
    j.posted_precision, j.posted_date, j.posted_basis = "date", date.today(), "original"
    session.commit()
    assert session.get(Job, j.id).posted_precision == "date"
