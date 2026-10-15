"""Only the licensed Job Bank atlas is scheduled."""

from celery import Celery

from app.core.config import get_settings
from app.core.logging import configure_logging

configure_logging()
celery_app = Celery("jobatlas", broker=get_settings().redis_url, include=["app.workers.tasks"])
celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_ignore_result=True,
    broker_connection_retry_on_startup=True,
    timezone="UTC",
    task_default_queue="atlas",
    task_routes={"jobatlas.atlas_sync": {"queue": "atlas"}},
    beat_schedule={
        "atlas-sync": {
            "task": "jobatlas.atlas_sync",
            "schedule": 86400.0,
            "options": {"expires": 86400.0},
        }
    },
)
app = celery_app
