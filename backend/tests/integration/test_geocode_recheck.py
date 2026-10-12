"""Re-checking existing geocoded points removes only points the geocoder contradicts."""

import pytest
from geoalchemy2.elements import WKTElement
from sqlalchemy import func, select

from app.models import Location
from app.services.geocode import FixedGeocoder, GeocodeResult
from app.services.locations import recheck_geocoded

pytestmark = pytest.mark.integration


def _loc(session, address, lon=-79.39, lat=43.65, geocoder="nominatim-local"):
    loc = Location(
        normalized_address=address.lower(),
        display_address=address,
        point=WKTElement(f"POINT({lon} {lat})", srid=4326),
        precision="rooftop",
        geocoder=geocoder,
    )
    session.add(loc)
    session.flush()
    return loc


def test_recheck_removes_only_contradicted_points(session):
    same = _loc(session, "1 Same St, Toronto")
    moved = _loc(session, "2 Moved St, Toronto")
    wrong = _loc(session, "3 Wrong St, Toronto")
    missing = _loc(session, "4 Missing St, Toronto")
    site = _loc(session, "5 Site St, Toronto", geocoder="osm-site")
    session.commit()
    geocoder = FixedGeocoder(
        {
            "1 Same St": GeocodeResult("ok", "fixed", -79.39, 43.65, "rooftop"),
            "2 Moved St": GeocodeResult("ok", "fixed", -79.40, 43.66, "rooftop"),
            "3 Wrong St": GeocodeResult("mismatch", "fixed", detail="city"),
            # "4 Missing St" -> not_found: absence of evidence, keep the point
        }
    )
    stats = recheck_geocoded(session, geocoder)
    assert (stats.checked, stats.kept, stats.moved, stats.cleared, stats.unconfirmed) == (
        4, 1, 1, 1, 1,
    )  # fmt: skip
    for loc in (same, moved, wrong, missing, site):
        session.refresh(loc)
    assert same.point is not None and missing.point is not None and site.point is not None
    assert wrong.point is None and wrong.geocode_error.startswith("recheck mismatch")
    x = session.scalar(select(func.ST_X(Location.point)).where(Location.id == moved.id))
    assert x == pytest.approx(-79.40)  # the validated result replaced the stale point
    assert "point kept" in missing.geocode_error
