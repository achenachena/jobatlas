"""Job lifecycle decisions (DEVELOPMENT.md §7.2).

    Active  --no positive open evidence for FRESHNESS_HOURS-->  Pending Verification
    Active/Pending --provider closure evidence-->                Closed
    Active/Pending --absence rule (below)-->                     Closed
    Pending/Closed --listed again / detail 200-->                Active   (ingest + here)

Absence rule, for records missing from COMPLETE listings only:
- >= 2 consecutive complete misses, at least MISSING_MIN_INTERVAL_MINUTES since first miss,
  and the provider's detail check returns `closed`  -> close;
- otherwise, if detail is inconclusive: >= 3 consecutive complete misses spanning at least
  MISSING_CLOSE_WITHOUT_DETAIL_HOURS -> close (the adapter certified completeness);
- a job still listed by ANY other source is never closed by one source's absence.

Each transition writes the status change, a job_event and an evidence row in one transaction.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.timeutil import utcnow
from app.models import Job, JobEvent, JobSourceRecord, Source
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.providers.base import ProviderError, SourceRef
from app.providers.registry import get_provider
from app.services.locations import add_evidence

log = get_logger(__name__)


def transition(
    session: Session,
    job: Job,
    to_status: str,
    reason: str,
    *,
    now: datetime,
    method: str,
    source_url: str | None = None,
    source_run_id: uuid.UUID | None = None,
) -> None:
    if job.status == to_status:
        return
    session.add(
        JobEvent(
            job_id=job.id,
            from_status=job.status,
            to_status=to_status,
            reason=reason,
            source_run_id=source_run_id,
            occurred_at=now,
        )
    )
    add_evidence(
        session, "job", job.id, "status",
        method=method, confidence="high", excerpt=reason, source_url=source_url, now=now,
    )  # fmt: skip
    job.status = to_status
    if to_status == "closed":
        job.closed_at, job.close_reason = now, reason
    elif to_status == "active":
        job.closed_at, job.close_reason = None, None


def _listed_elsewhere(session: Session, rec: JobSourceRecord) -> bool:
    return (
        session.scalar(
            select(JobSourceRecord.id).where(
                JobSourceRecord.job_id == rec.job_id,
                JobSourceRecord.id != rec.id,
                JobSourceRecord.consecutive_missing == 0,
            )
        )
        is not None
    )


def process_missing(
    session: Session, source_id: uuid.UUID, run_id: uuid.UUID, client: SafeHttpClient
) -> int:
    s = get_settings()
    source = session.get(Source, source_id)
    if source is None:
        return 0
    provider = get_provider(source.provider)
    ref = SourceRef(source.provider, source.tenant_key)
    now = utcnow()
    min_gap = timedelta(minutes=s.missing_min_interval_minutes)
    long_gap = timedelta(hours=s.missing_close_without_detail_hours)
    closed = 0
    rows = session.execute(
        select(JobSourceRecord, Job)
        .join(Job, Job.id == JobSourceRecord.job_id)
        .where(
            JobSourceRecord.source_id == source_id,
            JobSourceRecord.consecutive_missing >= 2,
            Job.status != "closed",
        )
    ).all()
    for rec, job in rows:
        if rec.first_missing_at is None or now - rec.first_missing_at < min_gap:
            continue
        if _listed_elsewhere(session, rec):
            continue
        try:
            verdict = provider.verify_job(client, ref, rec.external_id)
        except (ProviderError, FetchError, UnsafeURLError) as exc:
            log.warning("verify_failed", job_id=str(job.id), error=str(exc)[:200])
            continue
        if verdict.state == "closed":
            transition(
                session, job, "closed", f"{source.provider}: {verdict.reason}",
                now=now, method=f"{source.provider}_detail_check",
                source_url=rec.canonical_url, source_run_id=run_id,
            )  # fmt: skip
            closed += 1
        elif verdict.state == "active":
            # Detail page says open although the listing omitted it: positive evidence.
            job.last_verified_at = now
            if job.status == "pending_verification":
                transition(
                    session, job, "active", f"{source.provider}: {verdict.reason}",
                    now=now, method=f"{source.provider}_detail_check", source_run_id=run_id,
                )  # fmt: skip
        elif rec.consecutive_missing >= 3 and now - rec.first_missing_at >= long_gap:
            transition(
                session, job, "closed",
                f"missing from {rec.consecutive_missing} complete listings since "
                f"{rec.first_missing_at.isoformat()}; detail inconclusive ({verdict.reason})",
                now=now, method="complete_listing_absence",
                source_url=rec.canonical_url, source_run_id=run_id,
            )  # fmt: skip
            closed += 1
        session.commit()
    return closed


def freshness_sweep(session: Session) -> int:
    """Active jobs without positive open evidence for FRESHNESS_HOURS become Pending.
    Failed fetches never advanced last_verified_at, so they naturally age into this."""
    now = utcnow()
    cutoff = now - timedelta(hours=get_settings().freshness_hours)
    stale = session.scalars(
        select(Job)
        .where(Job.status == "active")
        .where((Job.last_verified_at.is_(None)) | (Job.last_verified_at < cutoff))
        .with_for_update(skip_locked=True)
    ).all()
    for job in stale:
        transition(
            session, job, "pending_verification",
            f"no successful open verification since "
            f"{job.last_verified_at.isoformat() if job.last_verified_at else 'never'}",
            now=now, method="freshness_sweep",
        )  # fmt: skip
    session.commit()
    return len(stale)
