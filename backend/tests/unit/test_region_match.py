import pytest

from app.services.region_match import (
    covers,
    is_target_relevant,
    match_location_text,
    parse_eligibility,
)


@pytest.mark.parametrize(
    "label,region",
    [
        ("Toronto", "toronto"),
        ("Toronto, Canada", "toronto"),
        ("North York, Ontario", "toronto"),
        ("Mississauga, ON", "mississauga"),
        ("Milton, ON", "milton"),
        ("Burlington, Ontario, Canada", "burlington"),
        ("Richmond Hill, ON", "richmond-hill"),
        ("Hybrid - GTA", "gta"),
        ("Greater Toronto Area", "gta"),
        ("Ottawa, ON", "ca-on"),
        ("Remote - Ontario", "ca-on"),
        ("Montréal, Quebec, Canada", "ca-qc"),
        ("Vancouver, BC", "ca-bc"),
        ("US / Canada", "ca"),
        # Same names elsewhere must not match without an Ontario/Canada qualifier.
        ("Milton, MA", None),
        ("Burlington, VT", None),
        ("Aurora, IL", None),
        ("Richmond Hill, GA", None),
        ("Dublin", None),
        ("Remote", None),
        ("Hamilton, ON - Burlington St (LSC)", "ca-on"),  # street name is not a city
        ("Alumicor - Toronto - Humberline Dr", "toronto"),
        (None, None),
    ],
)
def test_match_location_text(label, region):
    m = match_location_text(label)
    assert (m.region_id if m else None) == region


@pytest.mark.parametrize(
    "texts,includes,excludes",
    [
        (["Remote (United States | Canada)"], {"us", "ca"}, set()),
        (["Remote - Canada"], {"ca"}, set()),
        (["Remote (Canada, U.S.)"], {"ca", "us"}, set()),
        (["Remote from the US"], {"us"}, set()),
        (["Remote"], set(), set()),  # unknown, NOT worldwide
        (["Remote - Worldwide"], {"worldwide"}, set()),
        (["Remote - North America"], {"north-america"}, set()),
        (["Remote in Canada, excluding Quebec"], {"ca"}, {"ca-qc"}),
        (["Remote Canada (not available in Ontario)"], {"ca"}, {"ca-on"}),
        (["Toronto", "Canada"], {"toronto", "ca"}, set()),  # separate labels
        (["Canada-British Columbia-Remote"], {"ca-bc"}, set()),
        (["Remote Global (US, EU)"], {"us"}, set()),
        (["US/Global (Remote)"], {"us"}, set()),
        (["Remote - Toronto, Canada"], {"toronto"}, set()),
        (["Remote - Americas or EU"], {"north-america"}, set()),
    ],
)
def test_parse_eligibility(texts, includes, excludes):
    e = parse_eligibility(texts)
    assert e.includes == includes
    assert e.excludes == excludes


@pytest.mark.parametrize(
    "includes,excludes,target,ok",
    [
        ({"ca"}, set(), "gta", True),  # Canada covers the GTA
        ({"ca-on"}, set(), "gta", True),
        ({"north-america"}, set(), "toronto", True),
        ({"worldwide"}, set(), "gta", True),
        ({"us"}, set(), "gta", False),  # US-only is not open to GTA residents
        ({"toronto"}, set(), "gta", True),  # Toronto-only remote is still a GTA job
        ({"toronto"}, set(), "mississauga", False),
        ({"ca"}, {"ca-on"}, "gta", False),  # explicit exclusion wins
        ({"ca"}, {"ca-qc"}, "gta", True),
        (set(), set(), "gta", False),  # unknown eligibility never qualifies
    ],
)
def test_covers(includes, excludes, target, ok):
    assert covers(includes, excludes, target) is ok


@pytest.mark.parametrize(
    "label,workplace,relevant",
    [
        ("Toronto, ON", "unknown", True),
        ("Toronto, ON", "on_site", True),
        ("Montréal, Quebec, Canada", "unknown", False),
        ("Burnaby, British Columbia, Canada", "on_site", False),
        ("Remote - Canada", "remote", True),
        ("Remote (Canada, U.S.)", "remote", True),
        ("Remote from the US", "remote", False),
        ("Remote", "remote", False),
        ("US / Canada", "unknown", False),
    ],
)
def test_is_target_relevant(label, workplace, relevant):
    assert is_target_relevant(label, workplace) is relevant


def test_remote_title_states_eligibility():
    from app.providers.base import NormalizedJob
    from app.services.ingest import assess

    n = NormalizedJob(external_id="1", title="Senior Engineer - Remote, Canada", company_name=None,
                      apply_url=None, canonical_url=None, description_text=None,
                      location_text=None, workplace_type="remote")  # fmt: skip
    assert assess(n).relevant
    n.title = "Senior Engineer - Remote: Colombia - Costa Rica"
    assert not assess(n).relevant
