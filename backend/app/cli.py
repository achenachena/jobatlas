"""Operator CLI for the Job Bank atlas only."""

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


if __name__ == "__main__":
    app()
