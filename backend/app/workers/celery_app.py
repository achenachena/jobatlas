"""Celery wiring. Redis only carries messages; all schedule state lives in PostgreSQL, so
losing Redis loses nothing: the next scheduler tick re-enqueues whatever is due."""

from celery import Celery

from app.core.config import get_settings
from app.core.logging import configure_logging

configure_logging()
settings = get_settings()

# Long maintenance jobs (candidate verification, discovery, geocoding, office lookups) run on
# their own single-process worker: one at a time, under the time limits below (the thread
# pool used for syncs does not enforce them), and never on the threads syncs need.
MAINTENANCE_QUEUE = "maintenance"
MAINTENANCE_TASKS = (
    "jobatlas.verify_candidates",
    "jobatlas.discover_commoncrawl",
    "jobatlas.geocode_pending",
    "jobatlas.resolve_sites",
    "jobatlas.enrich_company_offices",
)


def _every(task: str, seconds: float) -> dict:
    """A beat entry whose message expires when the next one is due, so a busy maintenance
    worker drops stale runs instead of piling them up."""
    return {"task": task, "schedule": seconds, "options": {"expires": seconds}}


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
    task_routes={name: {"queue": MAINTENANCE_QUEUE} for name in MAINTENANCE_TASKS},
    beat_schedule={
        "schedule-due-sources": {
            "task": "jobatlas.schedule_due_sources",
            "schedule": float(settings.scheduler_tick_seconds),
        },
        "verify-candidates": _every("jobatlas.verify_candidates", 7200.0),
        "freshness-sweep": _every("jobatlas.freshness_sweep", 3600.0),
        "geocode-pending": _every("jobatlas.geocode_pending", 3600.0),
        "resolve-sites": _every("jobatlas.resolve_sites", 86400.0),
        "enrich-company-offices": _every("jobatlas.enrich_company_offices", 86400.0),
        "discover-commoncrawl": _every(
            "jobatlas.discover_commoncrawl", float(settings.discovery_interval_minutes * 60)
        ),
    },
)

app = celery_app
