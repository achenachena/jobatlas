"""Sync one source: fetch → normalize → relevance filter → idempotent upsert.

Invariants (DEVELOPMENT.md §3, §6.3, §7):
- A failed fetch (timeout, 403, 429, 5xx, parse error, partial pages) never changes job
  status and never advances last_verified_at.
- Upserts key on (source_id, external_id); re-running the same sync creates nothing new.
- Content changes update the existing job; first_seen_at is never modified.
- Missing from a *complete* listing only increments a counter. Closing needs the
  provider-specific closure evidence handled by the lifecycle service (stage 2).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.core.timeutil import utcnow
from app.models import Job, JobEvent, JobSourceRecord, Source, SourceRun
from app.net.safe_http import FetchError, SafeHttpClient
from app.providers.base import NormalizedJob, ProviderError, SourceRef, raw_hash
from app.providers.registry import get_provider
from app.services.region_match import is_target_relevant
from app.services.sources import (
    acquire_lock,
    next_run_after_failure,
    next_run_after_success,
    release_lock,
)

log = get_logger(__name__)
MAX_PAGES = 200


@dataclass
class SyncResult:
    source_id: uuid.UUID
    status: str
    run_id: uuid.UUID | None = None
    records_seen: int = 0
    records_relevant: int = 0
    created: int = 0
    updated: int = 0
    is_complete: bool = False
    error_class: str | None = None
    skipped_reasons: dict[str, int] = field(default_factory=dict)


def publishability(job: Job) -> str | None:
    """Rule 9: return a quarantine reason, or None when the job may be public."""
    missing = [
        name
        for name, value in (
            ("title", job.title),
            ("company", job.company_id),
            ("apply_url", job.apply_url),
        )
        if not value
    ]
    if job.apply_url and not job.apply_url.startswith(("https://", "http://")):
        missing.append("apply_url_scheme")
    return ",".join(missing) or None


def _apply_fields(job: Job, n: NormalizedJob) -> None:
    job.title = n.title
    job.description_text = n.description_text
    job.workplace_type = n.workplace_type
    job.apply_url = n.apply_url
    job.location_text = n.location_text
    job.employment_type = n.employment_type
    job.salary_min, job.salary_max = n.salary_min, n.salary_max
    job.salary_currency, job.salary_period, job.salary_raw = (
        n.salary_currency,
        n.salary_period,
        n.salary_raw,
    )
    # Never replace a known original posting time with "unknown" from a later payload.
    if n.posted_basis != "unknown" or job.posted_basis in (None, "unknown"):
        job.posted_at = n.posted_at
        job.posted_date = n.posted_date
        job.posted_precision = n.posted_precision
        job.posted_basis = n.posted_basis
        job.posted_tz_basis = n.posted_tz_basis
    reason = publishability(job)
    job.is_publishable = reason is None
    job.quarantine_reason = reason


def upsert_job(
    session: Session,
    source: Source,
    run: SourceRun,
    n: NormalizedJob,
    digest: str,
    now: datetime,
) -> str:
    """Returns 'created' | 'updated' | 'unchanged'."""
    rec = session.scalar(
        select(JobSourceRecord)
        .where(JobSourceRecord.source_id == source.id, JobSourceRecord.external_id == n.external_id)
        .with_for_update()
    )
    outcome = "unchanged"
    if rec is None:
        job = Job(
            company_id=source.company_id,
            status="active",
            first_seen_at=now,
            last_seen_at=now,
            last_verified_at=now,
            location_status="unverified",
        )
        _apply_fields(job, n)
        session.add(job)
        session.flush()
        rec = JobSourceRecord(
            job_id=job.id,
            source_id=source.id,
            external_id=n.external_id,
            raw_hash=digest,
            consecutive_missing=0,
        )
        session.add(rec)
        session.add(
            JobEvent(
                job_id=job.id,
                from_status=None,
                to_status="active",
                reason="first_seen_in_source_listing",
                source_run_id=run.id,
                occurred_at=now,
            )
        )
        outcome = "created"
    else:
        job = session.get(Job, rec.job_id, with_for_update=True)
        assert job is not None
        if rec.raw_hash != digest:
            _apply_fields(job, n)
            rec.raw_hash = digest
            outcome = "updated"
        if job.status != "active":
            session.add(
                JobEvent(
                    job_id=job.id,
                    from_status=job.status,
                    to_status="active",
                    reason="listed_again_by_source",
                    source_run_id=run.id,
                    occurred_at=now,
                )
            )
            job.status = "active"
            job.closed_at = None
            job.close_reason = None
        # Being listed by the original source right now is positive open evidence.
        job.last_seen_at = now
        job.last_verified_at = now

    rec.canonical_url = n.canonical_url
    rec.requisition_id = n.requisition_id
    rec.source_posted_at = n.posted_at
    rec.source_updated_at = n.source_updated_at
    rec.source_republished_at = n.source_republished_at
    rec.last_seen_run_id = run.id
    rec.last_seen_at = now
    rec.consecutive_missing = 0
    rec.first_missing_at = None
    return outcome


def sync_source(
    session: Session,
    source_id: uuid.UUID,
    client: SafeHttpClient,
    *,
    owner: str | None = None,
    task_id: str | None = None,
) -> SyncResult:
    owner = owner or f"sync-{uuid.uuid4()}"
    if not acquire_lock(session, source_id, owner):
        return SyncResult(source_id, status="skipped_locked")
    try:
        return _sync_locked(session, source_id, client, task_id)
    finally:
        session.rollback()
        release_lock(session, source_id, owner)


def _sync_locked(
    session: Session, source_id: uuid.UUID, client: SafeHttpClient, task_id: str | None
) -> SyncResult:
    source = session.get(Source, source_id)
    if source is None:
        return SyncResult(source_id, status="missing_source")
    provider = get_provider(source.provider)
    ref = SourceRef(source.provider, source.tenant_key)
    started = utcnow()
    run = SourceRun(source_id=source.id, started_at=started, status="running", task_id=task_id)
    session.add(run)
    session.commit()
    result = SyncResult(source.id, status="running", run_id=run.id)
    bound = log.bind(source_run_id=str(run.id), provider=source.provider, tenant=source.tenant_key)

    records: list[dict] = []
    complete = True
    cursor: str | None = None
    try:
        for _ in range(MAX_PAGES):
            page = provider.fetch_jobs(client, ref, cursor)
            run.pages_received += 1
            run.http_status = page.http_status
            run.pages_expected = page.pages_expected
            records.extend(page.records)
            complete = complete and page.is_complete
            cursor = page.next_cursor
            if cursor is None:
                break
        else:
            complete = False
    except (ProviderError, FetchError) as exc:
        # Nothing about any job changes on a failed fetch.
        now = utcnow()
        source.failure_count += 1
        source.last_run_at = now
        source.status = "failing" if source.failure_count >= 3 else source.status
        source.next_run_at = next_run_after_failure(source, now)
        run.status = "failed"
        run.finished_at = now
        run.error_class = exc.error_class
        run.http_status = getattr(exc, "http_status", None) or getattr(exc, "status", None)
        session.commit()
        bound.warning(
            "source_sync_failed", error_class=exc.error_class, http_status=run.http_status
        )
        result.status, result.error_class = "failed", exc.error_class
        return result

    now = utcnow()
    seen_ids: set[str] = set()
    parse_failures = 0
    for raw in records:
        result.records_seen += 1
        try:
            n = provider.normalize(raw)
        except (KeyError, TypeError, ValueError):
            parse_failures += 1
            continue
        seen_ids.add(n.external_id)
        if not is_target_relevant(n.location_text, n.workplace_type):
            already = session.scalar(
                select(JobSourceRecord.id).where(
                    JobSourceRecord.source_id == source.id,
                    JobSourceRecord.external_id == n.external_id,
                )
            )
            if already is None:  # not in target region; keep updating ones we already track
                result.skipped_reasons["outside_target_region"] = (
                    result.skipped_reasons.get("outside_target_region", 0) + 1
                )
                continue
        result.records_relevant += 1
        outcome = upsert_job(session, source, run, n, raw_hash(raw), now)
        if outcome == "created":
            result.created += 1
        elif outcome == "updated":
            result.updated += 1

    if parse_failures:
        result.skipped_reasons["parse_failure"] = parse_failures
        complete = False

    if complete:
        missing = update(JobSourceRecord).where(JobSourceRecord.source_id == source.id)
        if seen_ids:
            missing = missing.where(JobSourceRecord.external_id.not_in(seen_ids))
        session.execute(
            missing.values(
                consecutive_missing=JobSourceRecord.consecutive_missing + 1,
                first_missing_at=func.coalesce(JobSourceRecord.first_missing_at, now),
            )
        )

    run.records_seen = result.records_seen
    run.records_relevant = result.records_relevant
    run.jobs_created, run.jobs_updated = result.created, result.updated
    run.is_complete = complete
    run.status = "succeeded" if complete else "partial"
    run.finished_at = utcnow()
    source.relevant_job_count = result.records_relevant
    source.failure_count = 0
    source.last_run_at = now
    source.last_success_at = now
    source.status = "active" if result.records_relevant else "idle"
    source.next_run_at = next_run_after_success(source, now)
    session.commit()
    result.status = run.status
    result.is_complete = complete
    bound.info(
        "source_sync_done",
        status=run.status,
        seen=result.records_seen,
        relevant=result.records_relevant,
        created=result.created,
        updated=result.updated,
    )
    return result
