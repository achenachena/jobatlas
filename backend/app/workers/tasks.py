import uuid
from datetime import timedelta

import structlog
from sqlalchemy import update

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.timeutil import utcnow
from app.db.session import sync_session
from app.discovery import pipeline
from app.models import Source
from app.net.safe_http import SafeHttpClient
from app.services.ingest import sync_source
from app.services.sources import due_source_ids
from app.workers.celery_app import celery_app

log = get_logger(__name__)


@celery_app.task(name="jobatlas.schedule_due_sources")
def schedule_due_sources() -> int:
    """Enqueue due sources. Each is given a short lease on next_run_at so the next tick does
    not enqueue it again; the sync sets the real next_run_at. A lost message simply makes the
    source due again when the lease expires."""
    lease = timedelta(minutes=get_settings().source_lock_ttl_minutes)
    with sync_session() as session:
        ids = due_source_ids(session)
        if ids:
            session.execute(
                update(Source).where(Source.id.in_(ids)).values(next_run_at=utcnow() + lease)
            )
            session.commit()
    for source_id in ids:
        sync_source_task.delay(str(source_id))
    return len(ids)


@celery_app.task(name="jobatlas.sync_source", bind=True)
def sync_source_task(self, source_id: str) -> dict:
    structlog.contextvars.bind_contextvars(task_id=self.request.id)
    with sync_session() as session, SafeHttpClient() as client:
        result = sync_source(
            session,
            uuid.UUID(source_id),
            client,
            owner=f"celery-{self.request.id}",
            task_id=self.request.id,
        )
    return {"status": result.status, "created": result.created, "updated": result.updated}


@celery_app.task(name="jobatlas.discover_commoncrawl", bind=True)
def discover_commoncrawl(self) -> dict:
    structlog.contextvars.bind_contextvars(task_id=self.request.id)
    with sync_session() as session, SafeHttpClient() as client:
        run = pipeline.start_run(session)
        try:
            harvest = pipeline.harvest_commoncrawl(session, client)
            verify = pipeline.verify_candidates(session, client)
        except Exception as exc:
            session.rollback()
            pipeline.finish_run(session, run, {}, error=f"{type(exc).__name__}: {exc}")
            raise
        stats = {"harvest": harvest.as_dict(), "verify": verify.as_dict()}
        pipeline.finish_run(session, run, stats)
    for source_id in verify.accepted_new_source:
        sync_source_task.delay(str(source_id))
    log.info("discovery_done", **stats["verify"])
    return stats


@celery_app.task(name="jobatlas.freshness_sweep")
def freshness_sweep_task() -> int:
    from app.services.lifecycle import freshness_sweep

    with sync_session() as session:
        return freshness_sweep(session)


@celery_app.task(name="jobatlas.geocode_pending")
def geocode_pending_task() -> dict:
    from app.services.geocode import build_geocoder
    from app.services.locations import geocode_pending

    with sync_session() as session, SafeHttpClient() as client:
        stats = geocode_pending(session, build_geocoder(client))
    return stats.__dict__


@celery_app.task(name="jobatlas.enrich_company_offices")
def enrich_company_offices_task() -> dict:
    from app.services.company_sites import enrich_companies

    with sync_session() as session, SafeHttpClient() as client:
        stats = enrich_companies(session, client)
    return stats.__dict__


@celery_app.task(name="jobatlas.resolve_sites")
def resolve_sites_task() -> dict:
    from app.services.locations import resolve_sites
    from app.services.site_resolver import build_site_resolver

    resolver = build_site_resolver()
    if resolver is None:
        return {"skipped": "GEOCODER_POI_URL not configured"}
    with sync_session() as session:
        return resolve_sites(session, resolver).__dict__


@celery_app.task(name="jobatlas.verify_candidates", bind=True)
def verify_candidates_task(self) -> dict:
    """Work through queued discovery candidates in small batches (new sources are due
    immediately, so the regular scheduler picks up their initial sync)."""
    structlog.contextvars.bind_contextvars(task_id=self.request.id)
    with sync_session() as session, SafeHttpClient() as client:
        stats = pipeline.verify_candidates(session, client)
    return stats.as_dict()
