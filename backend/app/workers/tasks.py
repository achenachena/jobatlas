"""Atlas maintenance tasks: Job Bank open data and Employer boards."""

from app.db.session import sync_session
from app.workers.celery_app import celery_app


@celery_app.task(name="jobatlas.atlas_sync")
def atlas_sync_task() -> dict:
    from app.atlas.sync import sync_jobbank

    with sync_session() as session:
        return sync_jobbank(session, max_months=3).__dict__


@celery_app.task(name="jobatlas.ats_sweep")
def ats_sweep_task() -> dict:
    from app.atlas.ats import sweep

    with sync_session() as session:
        return sweep(session).__dict__


@celery_app.task(name="jobatlas.ats_discover")
def ats_discover_task() -> dict:
    from app.atlas.commoncrawl import discover

    with sync_session() as session:
        return discover(session)
