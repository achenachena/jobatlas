import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import func, select

from app.models import Evidence, JobLocation, SiteResolution
from app.services.locations import invalidate_stale_site_links, resolve_sites
from app.services.site_resolver import SiteResolver
from tests.integration import factories as f

pytestmark = pytest.mark.integration

MALL = {"name": "Sherway Gardens", "lon": "-79.557", "lat": "43.611", "category": "shop",
        "osm_type": "way", "osm_id": 42, "address": {"road": "The West Mall", "house_number": "25",
                                                      "city": "Toronto"}}  # fmt: skip


def _resolver(calls):
    def handler(req):
        q = parse_qs(urlsplit(str(req.url)).query)["q"][0]
        calls.append(q)
        return httpx.Response(200, content=json.dumps([MALL] if "Sherway" in q else []))

    return SiteResolver(httpx.Client(transport=httpx.MockTransport(handler)), "http://geo")


def test_resolve_link_cache_and_invalidate(session):
    c = f.company(session, "United States of Aritzia Inc.")
    label = "Toronto, ON, Canada (1307 - Sherway Gardens), Canada"
    j1 = f.job(session, c, title="Style Advisor", workplace="unknown", region="toronto")
    j1.location_text = label
    j2 = f.job(session, c, title="Assistant Manager", workplace="on_site", region="toronto")
    j2.location_text = label
    city_only = f.job(session, c, title="Cashier", region="toronto")  # "toronto": not resolvable
    session.commit()

    calls: list[str] = []
    stats = resolve_sites(session, _resolver(calls))
    assert stats.linked == 2 and stats.queried == 1 and stats.cache_hits == 1
    assert calls == ["Sherway Gardens, Toronto"]
    for j in (j1, j2):
        session.refresh(j)
        assert j.location_status == "exact_work_location"
    session.refresh(city_only)
    assert city_only.location_status == "unverified"
    ev = session.scalar(select(Evidence).where(Evidence.method == "named_place_osm").limit(1))
    assert ev.source_url == "https://www.openstreetmap.org/way/42" and "ODbL" in ev.excerpt
    assert session.scalar(select(func.count()).select_from(SiteResolution)) == 1

    # The job later names another site: the old link is invalidated.
    j1.location_text = "Toronto, ON, Canada (1310 - Yorkdale)"
    invalidate_stale_site_links(session, j1)
    statuses = set(session.scalars(select(JobLocation.verification_status).where(
        JobLocation.job_id == j1.id)))  # fmt: skip
    assert statuses == {"invalidated"}


def test_unresolved_labels_are_cached(session):
    c = f.company(session, "Autodesk Canada Co.")
    j = f.job(session, c, workplace="hybrid", region="toronto")
    j.location_text = "AMER - Canada - Ontario - Toronto - University Ave"
    session.commit()
    calls: list[str] = []
    resolve_sites(session, _resolver(calls))
    resolve_sites(session, _resolver(calls))
    assert len(calls) == 1  # second run uses the cached failure
    assert session.scalar(select(SiteResolution.status)) == "unresolved"
