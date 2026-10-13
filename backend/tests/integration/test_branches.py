import json

import httpx
import pytest
from sqlalchemy import select

from app.models import Evidence, JobLocation
from app.services.branches import DIRECTORIES, branch_address, resolve_branches
from tests.integration import factories as f

pytestmark = pytest.mark.integration

HOST = "www.walmart.ca"


def _store_page(street="15 Resolution Dr", city="Brampton"):
    ld = {"@context": "https://schema.org/", "@type": "DepartmentStore", "name": "",
          "address": {"@type": "PostalAddress", "postalCode": "L6W 0A6", "streetAddress": street,
                      "addressCountry": "Canada", "addressRegion": "ON",
                      "addressLocality": city}}  # fmt: skip
    return f'<script type="application/ld+json">{json.dumps(ld)}</script>'


def test_walmart_label_pattern():
    rx = DIRECTORIES[0].label_re
    m = rx.search("(CAN) ON BRAMPTON 01188 WM SUPERCENTER")
    assert (m.group("city"), m.group("id")) == ("BRAMPTON", "1188")
    assert rx.search("Brampton, ON") is None


def test_branch_address_needs_a_store_object():
    assert branch_address([{"@type": "BreadcrumbList"}]) is None


def _walmart_job(session, label):
    c = f.company(session, "Wal-Mart Canada Corp")
    j = f.job(session, c, workplace="on_site", region="brampton")
    j.location_text = label
    session.commit()
    return j


def test_store_number_links_to_the_store_address(session, make_client, fake_web):
    fake_web.add(HOST, "/robots.txt", httpx.Response(200, text="User-agent: *\nDisallow: /cart\n"))
    fake_web.add(HOST, "/en/store/1188", httpx.Response(200, text=_store_page()))
    job = _walmart_job(session, "(CAN) ON BRAMPTON 01188 WM SUPERCENTER")
    stats = resolve_branches(session, make_client())
    assert stats.linked == 1
    ev = session.scalar(
        select(Evidence)
        .join(JobLocation, JobLocation.evidence_id == Evidence.id)
        .where(JobLocation.job_id == job.id)
    )
    assert ev.method == "employer_branch_directory"
    assert ev.source_url == "https://www.walmart.ca/en/store/1188"
    assert "15 Resolution Dr" in ev.excerpt


def test_store_in_another_city_is_not_linked(session, make_client, fake_web):
    fake_web.add(HOST, "/robots.txt", httpx.Response(200, text="User-agent: *\nAllow: /\n"))
    fake_web.add(HOST, "/en/store/1188", httpx.Response(200, text=_store_page(city="Ottawa")))
    _walmart_job(session, "(CAN) ON BRAMPTON 01188 WM SUPERCENTER")
    stats = resolve_branches(session, make_client())
    assert stats.linked == 0 and stats.city_mismatch == 1


def test_robots_disallow_means_no_fetch(session, make_client, fake_web):
    fake_web.add(
        HOST, "/robots.txt", httpx.Response(200, text="User-agent: *\nDisallow: /en/store/\n")
    )
    _walmart_job(session, "(CAN) ON BRAMPTON 01188 WM SUPERCENTER")
    stats = resolve_branches(session, make_client())
    assert stats.fetched == 0 and stats.linked == 0
