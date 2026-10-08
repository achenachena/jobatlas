"""Celery wiring. Redis only carries messages; all schedule state lives in PostgreSQL, so
losing Redis loses nothing: the next scheduler tick re-enqueues whatever is due."""

from celery import Celery

from app.core.config import get_settings
from app.core.logging import configure_logging

configure_logging()
settings = get_settings()

celery_app = Celery("jobatlas", broker=settings.redis_url, include=["app.workers.tasks"])
celery_app.conf.update(
    task_acks_late=True,  # at-least-once; tasks are idempotent
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_time_limit=30 * 60,
    task_soft_time_limit=25 * 60,
    task_ignore_result=True,
    broker_connection_retry_on_startup=True,
    timezone="UTC",
    beat_schedule={
        "schedule-due-sources": {
            "task": "jobatlas.schedule_due_sources",
            "schedule": float(settings.scheduler_tick_seconds),
        },
        "discover-commoncrawl": {
            "task": "jobatlas.discover_commoncrawl",
            "schedule": float(settings.discovery_interval_minutes * 60),
        },
    },
)

app = celery_app
