from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.atlas.cities import CityIndex, city_key, parse_geonames, province_code
from app.atlas.occupations import classify
from app.atlas.permissions import REGISTRY, admitted
from app.atlas.windows import REPORTING_TZ, window
from app.workers.celery_app import celery_app

# ------------------------------------------------------------------ occupations (§6)


@pytest.mark.parametrize(
    "noc,title,expected",
    [
        ("21231", "Software Engineer", "software_development"),
        ("21232", "Développeur logiciel", "software_development"),
        (None, "Senior Software Developer", "software_development"),
        (None, "Développeuse web full-stack", "software_development"),
        (None, "SDE II, Payments", "software_development"),
        ("11200", "HR Specialist", "human_resources"),
        (None, "HR Specialist", "human_resources"),
        ("12101", "Recruiter", "human_resources"),  # policy: recruiters are HR
        (None, "Technical Recruiter", "human_resources"),
        (None, "Conseillère en ressources humaines", "human_resources"),
        ("64301", "Bartender", "bartender"),
        (None, "Barman / Barmaid", "bartender"),
        ("65201", "Barista", "barista"),
        ("64301", "Barista", "barista"),  # the title is explicit; never a bartender
        ("64301", "Barback", "unclassified"),  # a barback is not a bartender
        (None, "Bartender / Barista", "unclassified"),  # ambiguous: not forced
        ("65201", "Food counter attendant", "unclassified"),
        (None, "", "unclassified"),
        (None, None, "unclassified"),
        (None, "HR", "unclassified"),  # a bare abbreviation is not enough
        (None, "Bar manager", "unclassified"),
    ],
)
def test_classify(noc, title, expected):
    assert classify(noc, title)[0] == expected


def test_industry_never_decides():
    # A software company's barista is a barista; a bank's developer is a developer.
    assert classify("65201", "Barista (Shopify office café)")[0] == "barista"
    assert classify("21232", "Developer, Bank of Montreal")[0] == "software_development"


# ------------------------------------------------------------------ cities (§4.4)

GEONAMES = "\n".join(
    "\t".join(map(str, row))
    for row in [
        # id, name, ascii, alternates, lat, lon, class, code, country, cc2, admin1, a2, a3, a4, pop
        (6167865, "Toronto", "Toronto", "Toronto,TO", 43.70, -79.42, "P", "PPLA", "CA", "",
         "08", "", "", "", 2600000),
        (6077243, "Montréal", "Montreal", "Montreal,Montréal", 45.51, -73.59, "P", "PPL", "CA",
         "", "10", "", "", "", 1600000),
        (6325494, "Québec", "Quebec", "Quebec City,Ville de Québec", 46.81, -71.21, "P", "PPLA",
         "CA", "", "10", "", "", "", 530000),
        (6138374, "Saint John", "Saint John", "", 45.27, -66.07, "P", "PPL", "CA", "", "04",
         "", "", "", 70000),
        (6146143, "Richmond", "Richmond", "", 49.17, -123.14, "P", "PPL", "CA", "", "02", "",
         "", "", 200000),
        (1, "Richmond", "Richmond", "", 45.66, -72.15, "P", "PPL", "CA", "", "10", "", "", "",
         3000),
        (2, "Scarborough", "Scarborough", "", 43.77, -79.26, "P", "PPLX", "CA", "", "08", "",
         "", "", 600000),
    ]
)  # fmt: skip


class _Idx(CityIndex):
    pass


def _index():
    idx = _Idx()
    for p in parse_geonames(GEONAMES.splitlines()):
        cid = f"ca-{p.province.lower()}-{p.ascii_name.lower()}"
        for n in {p.name, p.ascii_name, *p.aliases}:
            idx.entries.setdefault((p.province, city_key(n)), []).append((p.population, cid))
    return idx


def test_sections_of_cities_are_not_places():
    assert {p.name for p in parse_geonames(GEONAMES.splitlines())} >= {"Toronto", "Montréal"}
    assert "Scarborough" not in {p.name for p in parse_geonames(GEONAMES.splitlines())}


@pytest.mark.parametrize(
    "prov,city,expected",
    [
        ("QC", "Montreal", "ca-qc-montreal"),
        ("QC", "MONTRÉAL", "ca-qc-montreal"),
        ("QC", "Québec", "ca-qc-quebec"),
        ("QC", "Ville de Québec", "ca-qc-quebec"),
        ("NB", "St. John", "ca-nb-saint john"),  # "St." is the usual short form of "Saint"
        ("BC", "Richmond", "ca-bc-richmond"),  # same name in QC stays in QC
        ("QC", "Richmond", "ca-qc-richmond"),
        ("ON", "Scarborough", "ca-on-toronto"),  # amalgamated into Toronto
        ("ON", "Montreal", None),  # province must agree
        ("ON", "NA", None),
        (None, "Toronto", None),
    ],
)
def test_city_matching(prov, city, expected):
    assert _index().match(prov, city)[0] == expected


def test_province_codes():
    assert province_code("Québec") == "QC"
    assert province_code("Colombie-Britannique") == "BC"
    assert province_code("ON") == "ON"
    assert province_code("Nowhere") is None


# ------------------------------------------------------------------ windows (§4.2)


def test_seven_day_window_is_calendar_days_half_open():
    w = window("7d", date(2026, 9, 30))
    assert (w.first_day, w.last_day) == (date(2026, 9, 24), date(2026, 9, 30))
    assert w.start == datetime(2026, 9, 24, tzinfo=REPORTING_TZ)
    assert w.end == datetime(2026, 10, 1, tzinfo=REPORTING_TZ)  # exclusive


def test_window_across_spring_dst_is_seven_days_not_168_hours():
    w = window("7d", date(2026, 3, 10))  # DST began 2026-03-08 in Toronto
    assert w.first_day == date(2026, 3, 4)
    elapsed = w.end.astimezone(UTC) - w.start.astimezone(UTC)
    assert elapsed == timedelta(days=7) - timedelta(hours=1)  # 7 calendar days = 167 h
    assert w.start.hour == 0 and w.end.hour == 0


def test_window_across_autumn_dst_and_month_end():
    w = window("7d", date(2026, 11, 3))  # DST ends 2026-11-01; crosses Oct -> Nov
    assert w.first_day == date(2026, 10, 28)
    assert w.end.astimezone(UTC) - w.start.astimezone(UTC) == timedelta(days=7, hours=1)


def test_partial_latest_day_ends_at_cutoff():
    cutoff = datetime(2026, 10, 14, 15, 30, tzinfo=REPORTING_TZ)
    w = window("7d", date(2026, 10, 14), cutoff=cutoff)
    assert w.partial_day and w.end == cutoff and not w.complete


def test_window_before_history_is_partial():
    w = window("30d", date(2023, 1, 10), history_start=date(2023, 1, 1))
    assert w.days_available == 10 and not w.complete


# ------------------------------------------------------------------ admission (§3.3)


def _row(**kw):
    base = dict(status="approved", status_basis="x", terms_url="https://t", licence="OGL",
                evidence_ref="https://e", verified_on=date(2026, 10, 14), expires_on=None,
                permissions={"derived_stats": True, "public_display": True})  # fmt: skip
    return SimpleNamespace(**{**base, **kw})


def test_admission_requires_evidence_not_just_a_flag():
    assert admitted(_row())[0]
    assert not admitted(_row(evidence_ref=None))[0]  # "approved=true" without evidence
    assert not admitted(_row(licence=None))[0]
    assert not admitted(_row(status="pending"))[0]
    assert not admitted(_row(status="blocked"))[0]
    assert not admitted(_row(permissions={"derived_stats": True}))[0]  # no public display
    assert not admitted(_row(expires_on=date(2026, 1, 1)), today=date(2026, 10, 14))[0]
    assert not admitted(None)[0]


def test_only_licensed_and_public_api_sources_are_registered_and_scheduled():
    assert {r["key"] for r in REGISTRY} == {
        "jobbank-open-data",
        "ats-greenhouse",
        "ats-lever",
        "ats-ashby",
    }
    assert {r["task"] for r in celery_app.conf.beat_schedule.values()} == {
        "jobatlas.atlas_sync",
        "jobatlas.ats_sweep",
        "jobatlas.ats_discover",
    }
    assert celery_app.conf.task_default_queue == "atlas"
