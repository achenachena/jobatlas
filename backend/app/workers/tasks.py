"""Job Bank open-data maintenance tasks."""

from app.db.session import sync_session
from app.workers.celery_app import celery_app


@celery_app.task(name="jobatlas.atlas_sync")
def atlas_sync_task() -> dict:
    from app.atlas.sync import sync_jobbank

    with sync_session() as session:
        return sync_jobbank(session, max_months=3).__dict__
