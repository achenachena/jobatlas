import pytest

from app.services.region_match import match_location_text


@pytest.mark.parametrize(
    "label,region",
    [
        ("Toronto", "gta"),
        ("Toronto, Canada", "gta"),
        ("Mississauga, ON", "gta"),
        ("North York, Ontario", "gta"),
        ("Milton, ON", "gta"),
        ("Burlington, Ontario, Canada", "gta"),
        ("Hybrid - GTA", "gta"),
        ("Ottawa, ON", "ca-on"),
        ("Remote - Ontario", "ca-on"),
        ("US / Canada", "ca"),
        ("Vancouver, Canada", "ca"),
        # Same names elsewhere must not match without an Ontario/Canada qualifier.
        ("Milton, MA", None),
        ("Burlington, VT", None),
        ("Aurora, IL", None),
        ("Richmond Hill, GA", None),
        ("Dublin", None),
        ("Remote from the US", None),
        ("Remote", None),
        ("Kingston, Jamaica", None),
        (None, None),
    ],
)
def test_match_location_text(label, region):
    m = match_location_text(label)
    assert (m.region_id if m else None) == region


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
        ("US / Canada", "unknown", False),
    ],
)
def test_is_target_relevant(label, workplace, relevant):
    from app.services.region_match import is_target_relevant

    assert is_target_relevant(label, workplace) is relevant
