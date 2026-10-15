"""Atlas schedules: Job Bank daily; Employer boards hourly sweep, monthly discovery."""

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
    task_routes={"jobatlas.*": {"queue": "atlas"}},
    beat_schedule={
        "atlas-sync": {
            "task": "jobatlas.atlas_sync",
            "schedule": 86400.0,
            "options": {"expires": 86400.0},
        },
        # A sweep stops fetching after 50 min, so the daily Job Bank task gets its turn.
        "ats-sweep": {
            "task": "jobatlas.ats_sweep",
            "schedule": 3600.0,
            "options": {"expires": 3000.0},
        },
        "ats-discover": {
            "task": "jobatlas.ats_discover",
            "schedule": 30 * 86400.0,
            "options": {"expires": 86400.0},
        },
    },
)
app = celery_app
