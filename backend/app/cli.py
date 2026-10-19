"""Operator CLI for the atlas: Job Bank open data and Employer boards (public ATS APIs)."""

import json

import typer

from app.core.logging import configure_logging
from app.db.session import sync_session

app = typer.Typer(no_args_is_help=True, add_completion=False)


@app.callback()
def _main(log_level: str = "WARNING") -> None:
    configure_logging(log_level)


def _echo(obj) -> None:
    typer.echo(json.dumps(obj, indent=2, default=str))


@app.command("atlas-sources")
def atlas_sources() -> None:
    """Mirror the reviewed source registry into the database and show admissions."""
    from app.atlas.models import AtlasSource
    from app.atlas.permissions import admitted, sync_registry

    with sync_session() as session:
        sync_registry(session)
        session.commit()
        _echo({r.key: {"status": r.status, "admitted": admitted(r)[0], "reason": admitted(r)[1]}
               for r in session.query(AtlasSource).order_by(AtlasSource.key)})  # fmt: skip


@app.command("atlas-cities")
def atlas_cities(file: str = typer.Option(None, help="GeoNames CA.txt; downloads if omitted")):
    """Load Canadian populated places (GeoNames, CC BY 4.0) as city anchors."""
    from pathlib import Path

    from app.atlas.sync import load_geonames

    with sync_session() as session:
        _echo({"cities": load_geonames(session, Path(file) if file else None)})


@app.command("atlas-groups")
def atlas_groups(
    if_needed: bool = typer.Option(False, help="only when a city has no group (deploys)"),
) -> None:
    """Group the city catalogue by 2021 CMA/CA boundaries (Statistics Canada), clustering the
    rest; replaces the stored grouping and stores every kept release's region scale. Run after
    atlas-cities."""
    from collections import Counter

    from app.atlas import groups
    from app.atlas.metrics import store_group_scales

    with sync_session() as session:
        if if_needed and not groups.ungrouped(session):
            _echo({"skipped": "every city has a group"})
            return
        cities = groups.catalogue(session)
        result = groups.compute(cities, groups.parse_areas(groups.fetch_features()))
        version = groups.store(session, result)
        releases = store_group_scales(session)
    _echo({"grouping_version": version, "cities": len(cities),
           "groups": dict(Counter(g.kind for g in result)),
           "releases_rescaled": releases})  # fmt: skip


@app.command("atlas-sync")
def atlas_sync(
    since: str = typer.Option(None, help="YYYY-MM: only months from here"),
    max_months: int = typer.Option(None, help="import at most N months this run"),
    no_release: bool = typer.Option(False, help="import only; do not publish"),
) -> None:
    """Import new or changed Job Bank months, then publish one atomic release."""
    from datetime import date

    from app.atlas.sync import sync_jobbank

    start = date.fromisoformat(f"{since}-01") if since else None
    with sync_session() as session:
        r = sync_jobbank(session, since=start, max_months=max_months,
                         publish_release=not no_release)  # fmt: skip
    _echo(r.__dict__)


@app.command("atlas-rematch")
def atlas_rematch() -> None:
    """Re-apply city matching rules to stored postings (then run atlas-release)."""
    from app.atlas.sync import rematch_cities

    with sync_session() as session:
        _echo(rematch_cities(session))


@app.command("atlas-release")
def atlas_release() -> None:
    """Rebuild and publish a release from what is imported (e.g. after a rule change)."""
    from app.atlas.jobbank import SOURCE_KEY
    from app.atlas.metrics import REAL_DATASET, build_release, publish

    with sync_session() as session:
        r = build_release(session, REAL_DATASET, [SOURCE_KEY], change_kind="correction")
        publish(session, r)
        _echo({"release_id": r.id, "data_through": r.data_through, "quality": r.quality})


@app.command("ats-discover")
def ats_discover(collections: int = typer.Option(6, help="newest Common Crawl crawls to read")):
    """Find employer boards (Greenhouse, Lever, Ashby) in Common Crawl as candidates."""
    from app.atlas.commoncrawl import discover

    with sync_session() as session:
        _echo(discover(session, collections))


@app.command("ats-add")
def ats_add(urls: list[str]) -> None:
    """Add employer boards by URL, e.g. https://jobs.lever.co/example."""
    from app.atlas.ats import add_boards, recognize

    found = [b for u in urls if (b := recognize(u))]
    bad = [u for u in urls if not recognize(u)]
    with sync_session() as session:
        _echo({"added": add_boards(session, found, "manual"), "not_recognised": bad})


@app.command("ats-sweep")
def ats_sweep(
    minutes: float = typer.Option(50, help="stop fetching after this long"),
    no_release: bool = typer.Option(False, help="fetch only; do not publish"),
) -> None:
    """Fetch due employer boards and publish the Employer boards release."""
    from app.atlas.ats import sweep

    with sync_session() as session:
        _echo(sweep(session, minutes=minutes, publish_release=not no_release).__dict__)


if __name__ == "__main__":
    app()
