import httpx

from app.providers.base import SourceRef
from app.providers.oracle import OracleProvider, detail_path, listing_path
from app.services.ingest import assess

HOST = "ehkn.fa.ca2.oraclecloud.com"
ROOT = f"https://{HOST}/hcmUI/CandidateExperience/en/sites/CX_1001/"
REF = SourceRef("oracle", ROOT)
oracle = OracleProvider()


def _row(id_, title, loc, secondary=(), workplace="ORA_ON_SITE", posted="2026-10-02"):
    return {"Id": id_, "Title": title, "PrimaryLocation": loc, "PostedDate": posted,
            "WorkplaceTypeCode": workplace,
            "secondaryLocations": [{"Name": s} for s in secondary]}  # fmt: skip


def _listing(rows, total=None):
    return {"items": [{"TotalJobsCount": len(rows) if total is None else total,
                       "requisitionList": rows}]}  # fmt: skip


def _work(town, line1, line2=None, postal=None, region3=None):
    return {"LocationName": town, "AddressLine1": line1, "AddressLine2": line2,
            "TownOrCity": town, "PostalCode": postal, "Country": "CA", "Region1": None,
            "Region2": None, "Region3": region3}  # fmt: skip


def _detail(id_, work, posted="2026-10-02T18:16:46+00:00"):
    return {"items": [{"Id": id_, "ExternalPostedStartDate": posted, "RequisitionId": 77,
                       "ExternalDescriptionStr": "<p>Lead GIS work.</p>",
                       "WorkplaceTypeCode": "ORA_HYBRID", "JobSchedule": "Full time",
                       "workLocation": work, "otherWorkLocations": []}]}  # fmt: skip


def _site(fake_web):
    fake_web.add(HOST, "/robots.txt", httpx.Response(404))


def test_recognizes_candidate_experience_urls_only():
    c = oracle.recognize(
        f"https://{HOST}/hcmUI/CandidateExperience/en/sites/CX_1001/job/233085?x=1"
    )
    assert c is not None and c.tenant_key == ROOT
    assert oracle.recognize(f"https://{HOST}/hcmUI/faces/Home") is None
    assert oracle.recognize("https://evil.example/hcmUI/CandidateExperience/en/sites/CX_1/") is None


def test_listing_details_and_addresses(make_client, fake_web):
    _site(fake_web)
    rows = [
        _row("1", "GIS Lead", "Toronto, ON, Canada", ["Montreal, QC, Canada"]),
        _row("2", "Accountant", "Henderson, NV, United States"),
        _row("3", "Analyst", "Toronto, ON, Canada"),
    ]
    fake_web.json(HOST, listing_path("CX_1001", 0), _listing(rows))
    tower = _work("Toronto", "Brookfield Place, TD Canada Trust Tower",
                  "Suite 3700, 161 Bay Street", "M5J 2S1", "ON")  # fmt: skip
    fake_web.json(HOST, detail_path("CX_1001", "1"), _detail("1", [tower]))
    # A requisition whose work location is in another city than the posting says.
    elko = _work("Elko", "1655 Mountain City Highway")
    fake_web.json(HOST, detail_path("CX_1001", "3"), _detail("3", [elko]))

    page = oracle.fetch_jobs(make_client(), REF, None)
    assert page.is_complete and sorted(page.listed_only) == ["1", "2", "3"]
    jobs = {n.external_id: n for n in map(oracle.normalize, page.records)}
    assert set(jobs) == {"1", "3"}  # Henderson, NV never reaches normalize

    gis = jobs["1"]
    assert gis.apply_url == f"{ROOT}job/1"
    assert gis.location_text == "Toronto, ON, Canada"
    assert gis.extra_location_labels == ["Montreal, QC, Canada"]
    assert gis.workplace_type == "hybrid" and gis.posted_precision == "datetime"
    assert gis.posted_basis == "original" and not gis.from_listing
    [addr] = gis.structured_addresses
    assert (addr.street, addr.city, addr.region, addr.postal_code) == (
        "161 Bay Street",
        "Toronto",
        "ON",
        "M5J 2S1",
    )
    assert assess(gis).relevant
    assert jobs["3"].structured_addresses == []


def test_detail_cap_falls_back_to_listing_row(make_client, fake_web):
    _site(fake_web)
    fake_web.json(HOST, listing_path("CX_1001", 0),
                  _listing([_row("9", "Clerk", "Mississauga, ON, Canada")]))  # fmt: skip
    p = OracleProvider()
    p.detail_cap_per_run = 0
    [rec] = p.fetch_jobs(make_client(), REF, None).records
    n = p.normalize(rec)
    assert n.from_listing and n.posted_precision == "date" and str(n.posted_date) == "2026-10-02"
    assert n.description_text is None and n.structured_addresses == []


def test_incomplete_when_total_disagrees(make_client, fake_web):
    _site(fake_web)
    fake_web.json(HOST, listing_path("CX_1001", 0),
                  _listing([_row("9", "Clerk", "Remote")], total=2))  # fmt: skip
    assert not oracle.fetch_jobs(make_client(), REF, None).is_complete


def test_verify_closed_only_while_site_answers(make_client, fake_web):
    _site(fake_web)
    fake_web.json(HOST, detail_path("CX_1001", "5"), {"items": []})
    fake_web.json(HOST, listing_path("CX_1001", 0), _listing([]))
    assert oracle.verify_job(make_client(), REF, "5").state == "closed"
    fake_web.json(HOST, listing_path("CX_1001", 0), {"error": "down"}, status=503)
    assert oracle.verify_job(make_client(), REF, "5").state == "unknown"
    fake_web.json(HOST, detail_path("CX_1001", "5"), _detail("5", []))
    assert oracle.verify_job(make_client(), REF, "5").state == "active"
