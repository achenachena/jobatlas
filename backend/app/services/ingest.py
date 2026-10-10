"""Sync one source: fetch → normalize → relevance filter → idempotent upsert → lifecycle.

Invariants (DEVELOPMENT.md §3, §6.3, §7):
- A failed fetch (timeout, 403, 429, 5xx, parse error, partial pages) never changes job
  status and never advances last_verified_at.
- Upserts key on (source_id, external_id); re-running the same sync creates nothing new.
- Content changes update the existing job; first_seen_at is never modified.
- A job seen in another source is merged only on strong evidence: the same canonical job URL,
  or the same requisition id within the same company. Same title/company/city never merges.
- Missing from a complete listing only increments a counter; closing is the lifecycle
  service's decision. Suspicious listings (empty or sharply shrunk) are treated as
  incomplete and quarantined rather than used as absence evidence.
"""

from __future__ import annotations

import hashlib
import html
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.timeutil import utcnow
from app.models import (
    Company,
    Job,
    JobEligibilityRegion,
    JobEvent,
    JobSourceRecord,
    Source,
    SourceRun,
)
from app.net.safe_http import FetchError, SafeHttpClient
from app.providers.base import NormalizedJob, ProviderError, SourceRef, raw_hash
from app.providers.registry import get_provider
from app.services.locations import (
    add_evidence,
    invalidate_stale_site_links,
    link_job_to_company_locations,
    refresh_location_status,
    sync_job_addresses,
)
from app.services.region_match import (
    Eligibility,
    covers,
    is_within,
    match_location_text,
    parse_eligibility,
)
from app.services.sources import (
    acquire_lock,
    next_run_after_failure,
    next_run_after_success,
    release_lock,
)
from app.services.urls import canonical_job_url

log = get_logger(__name__)
MAX_PAGES = 200
# Anomaly guard: a complete listing this much smaller than the last complete one is suspect.
SHRINK_RATIO = 0.5
SHRINK_MIN_PREVIOUS = 20
EMPTY_MIN_PREVIOUS = 5


@dataclass
class SyncResult:
    source_id: uuid.UUID
    status: str
    run_id: uuid.UUID | None = None
    records_seen: int = 0
    records_relevant: int = 0
    created: int = 0
    updated: int = 0
    merged: int = 0
    closed: int = 0
    is_complete: bool = False
    error_class: str | None = None
    skipped_reasons: dict[str, int] = field(default_factory=dict)
    # For never-complete providers: ids the source still lists this run.
    still_listed: set[str] | None = None


@dataclass
class Relevance:
    relevant: bool
    region_id: str | None
    eligibility: Eligibility | None


def assess(n: NormalizedJob) -> Relevance:
    """Target-region relevance plus the label region and (remote) eligibility."""
    labels = [n.location_text, *n.extra_location_labels]
    labels += [a.city for a in n.structured_addresses if a.city]
    matches = [m for m in (match_location_text(label) for label in labels) if m]
    gta = next((m.region_id for m in matches if is_within(m.region_id, "gta")), None)
    region_id = gta or (matches[0].region_id if matches else None)
    eligibility = None
    if n.workplace_type == "remote":
        # The title often carries the employer's own statement ("Remote - Canada").
        eligibility = parse_eligibility([*labels, *n.eligibility_texts, n.title])
    relevant = gta is not None or (
        eligibility is not None and covers(eligibility.includes, eligibility.excludes, "gta")
    )
    return Relevance(relevant, region_id, eligibility)


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


def _apply_fields(job: Job, n: NormalizedJob, rel: Relevance) -> None:
    job.title = n.title
    job.description_text = n.description_text
    job.workplace_type = n.workplace_type
    job.apply_url = n.apply_url
    job.location_text = n.location_text
    job.location_region_id = rel.region_id
    job.employment_type = n.employment_type
    job.salary_min, job.salary_max = n.salary_min, n.salary_max
    job.salary_currency, job.salary_period, job.salary_raw = (
        n.salary_currency,
        n.salary_period,
        n.salary_raw,
    )
    if n.workplace_type == "remote":
        elig = rel.eligibility or Eligibility()
        job.eligibility_status = "known" if elig.known else "unknown"
        job.remote_eligibility_text = "; ".join(dict.fromkeys(elig.evidence)) or None
    else:
        job.eligibility_status = "not_applicable"
        job.remote_eligibility_text = None
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


def _replace_eligibility(
    session: Session, job: Job, rel: Relevance, source_url: str | None, now: datetime
) -> None:
    session.execute(delete(JobEligibilityRegion).where(JobEligibilityRegion.job_id == job.id))
    elig = rel.eligibility
    if job.workplace_type != "remote" or elig is None or not (elig.includes or elig.excludes):
        return
    ev = add_evidence(
        session, "job", job.id, "eligibility",
        method="source_location_labels", confidence="medium",
        excerpt=" | ".join(elig.evidence), source_url=source_url, now=now,
    )  # fmt: skip
    for mode, regions in (("include", elig.includes), ("exclude", elig.excludes)):
        for region_id in sorted(regions):
            session.add(
                JobEligibilityRegion(
                    job_id=job.id, region_id=region_id, include_or_exclude=mode, evidence_id=ev.id
                )
            )


def _derived(session: Session, job: Job, n: NormalizedJob, rel: Relevance, now: datetime) -> None:
    """Everything recomputed when content changes: evidence, eligibility, address links."""
    if n.workplace_evidence:
        add_evidence(
            session, "job", job.id, "workplace_type",
            method="source_field", confidence="high", excerpt=n.workplace_evidence,
            source_url=n.canonical_url, now=now,
        )  # fmt: skip
    _replace_eligibility(session, job, rel, n.canonical_url, now)
    sync_job_addresses(session, job, n, n.canonical_url, now)
    invalidate_stale_site_links(session, job)
    link_job_to_company_locations(session, job, now)
    refresh_location_status(session, job)


def _event(session: Session, job: Job, to: str, reason: str, run: SourceRun, now: datetime):
    session.add(
        JobEvent(
            job_id=job.id,
            from_status=job.status if job.id else None,
            to_status=to,
            reason=reason,
            source_run_id=run.id,
            occurred_at=now,
        )
    )


def _find_merge_target(session: Session, source: Source, n: NormalizedJob) -> Job | None:
    canonical = canonical_job_url(n.canonical_url)
    if canonical:
        rec = session.scalar(
            select(JobSourceRecord)
            .where(
                JobSourceRecord.canonical_url == canonical, JobSourceRecord.source_id != source.id
            )
            .limit(1)
        )
        if rec is not None:
            return session.get(Job, rec.job_id)
    if n.requisition_id and source.company_id:
        rec = session.scalar(
            select(JobSourceRecord)
            .join(Job, Job.id == JobSourceRecord.job_id)
            .where(
                JobSourceRecord.requisition_id == n.requisition_id,
                JobSourceRecord.source_id != source.id,
                Job.company_id == source.company_id,
            )
            .limit(1)
        )
        if rec is not None:
            return session.get(Job, rec.job_id)
    return None


def listing_key(external_id: str) -> str:
    """Compact id stored in Source.listing_ids."""
    return hashlib.sha256(external_id.encode()).hexdigest()[:16]


def upsert_job(
    session: Session,
    source: Source,
    run: SourceRun,
    n: NormalizedJob,
    rel: Relevance,
    digest: str,
    now: datetime,
    listed_after: datetime | None = None,
) -> str:
    """Returns 'created' | 'merged' | 'updated' | 'unchanged' | 'closed' | 'skipped_expired'.
    `listed_after`: the posting was absent from the source's previous complete listing,
    fetched at that time; recorded on a newly created job only."""
    rec = session.scalar(
        select(JobSourceRecord)
        .where(JobSourceRecord.source_id == source.id, JobSourceRecord.external_id == n.external_id)
        .with_for_update()
    )
    expired = n.valid_through is not None and n.valid_through < now
    outcome = "unchanged"
    if rec is None:
        if expired:
            return "skipped_expired"
        job = _find_merge_target(session, source, n)
        if job is not None:
            outcome = "merged"
            if job.status == "active":
                job.last_seen_at = now
                job.last_verified_at = now
            add_evidence(
                session, "job", job.id, "merge",
                method="canonical_url_or_requisition", confidence="high",
                excerpt=f"source {source.provider}:{source.tenant_key} record {n.external_id}",
                source_url=n.canonical_url, now=now,
            )  # fmt: skip
        else:
            job = Job(
                company_id=source.company_id,
                status="active",
                first_seen_at=now,
                last_seen_at=now,
                last_verified_at=now,
                location_status="unverified",
                listed_after=listed_after,
            )
            _apply_fields(job, n, rel)
            session.add(job)
            session.flush()
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
            _derived(session, job, n, rel, now)
            outcome = "created"
        rec = JobSourceRecord(
            job_id=job.id,
            source_id=source.id,
            external_id=n.external_id,
            raw_hash=digest,
            consecutive_missing=0,
        )
        session.add(rec)
    else:
        job = session.get(Job, rec.job_id, with_for_update=True)
        assert job is not None
        # A listing row never overwrites a job built from its detail page (it would drop
        # the description and address evidence); it only confirms the job is still listed.
        if rec.raw_hash != digest and not (n.from_listing and rec.detail_fetched_at):
            _apply_fields(job, n, rel)
            _derived(session, job, n, rel, now)
            rec.raw_hash = digest
            outcome = "updated"
        if expired:
            if job.status != "closed":
                _event(session, job, "closed", "source_valid_through_passed", run, now)
                job.status, job.closed_at = "closed", now
                job.close_reason = f"validThrough {n.valid_through.isoformat()} passed"
                add_evidence(
                    session, "job", job.id, "status",
                    method="source_valid_through", confidence="high",
                    excerpt=job.close_reason, source_url=n.canonical_url, now=now,
                )  # fmt: skip
                outcome = "closed"
        else:
            if job.status != "active":
                _event(session, job, "active", "listed_again_by_source", run, now)
                job.status = "active"
                job.closed_at = None
                job.close_reason = None
            # Being listed by the original source right now is positive open evidence.
            job.last_seen_at = now
            job.last_verified_at = now

    rec.canonical_url = canonical_job_url(n.canonical_url)
    rec.requisition_id = n.requisition_id
    rec.source_posted_at = n.posted_at
    rec.source_updated_at = n.source_updated_at
    rec.source_republished_at = n.source_republished_at
    rec.last_seen_run_id = run.id
    rec.last_seen_at = now
    if not n.from_listing:
        rec.detail_fetched_at = now
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
    run_lifecycle: bool = True,
) -> SyncResult:
    owner = owner or f"sync-{uuid.uuid4()}"
    if not acquire_lock(session, source_id, owner):
        return SyncResult(source_id, status="skipped_locked")
    try:
        result = _sync_locked(session, source_id, client, task_id)
        if run_lifecycle and result.run_id is not None and result.status != "failed":
            from app.services.lifecycle import process_missing, process_unlisted

            if result.is_complete:
                result.closed += process_missing(session, source_id, result.run_id, client)
            elif result.still_listed is not None:
                result.closed += process_unlisted(
                    session, source_id, result.run_id, client, result.still_listed
                )
        return result
    finally:
        session.rollback()
        release_lock(session, source_id, owner)


def _touch_listed(
    session: Session, source: Source, run: SourceRun, external_id: str, now: datetime
) -> None:
    rec = session.scalar(
        select(JobSourceRecord).where(
            JobSourceRecord.source_id == source.id, JobSourceRecord.external_id == external_id
        )
    )
    if rec is None:
        return
    job = session.get(Job, rec.job_id)
    if job is None or job.status == "closed":
        return  # a closed job only reopens on a fresh read of its own page
    if job.status != "active":
        _event(session, job, "active", "listed_again_by_source", run, now)
        job.status = "active"
    job.last_seen_at = now
    job.last_verified_at = now
    rec.last_seen_run_id = run.id
    rec.consecutive_missing = 0
    rec.first_missing_at = None


def _adopt_company_name(session: Session, source: Source, n: NormalizedJob) -> None:
    """A company registered under its board slug/URL takes the employer name the postings
    themselves declare (hiringOrganization), once."""
    if not n.company_name or source.company_id is None:
        return
    company = session.get(Company, source.company_id)
    if company is not None and company.name in (source.tenant_key, source.base_url):
        company.name = html.unescape(n.company_name).strip()[:200]


def _previous_complete_count(
    session: Session, source_id: uuid.UUID, run_id: uuid.UUID
) -> int | None:
    return session.scalar(
        select(SourceRun.records_seen)
        .where(SourceRun.source_id == source_id, SourceRun.is_complete, SourceRun.id != run_id)
        .order_by(SourceRun.started_at.desc())
        .limit(1)
    )


def _sync_locked(
    session: Session, source_id: uuid.UUID, client: SafeHttpClient, task_id: str | None
) -> SyncResult:
    source = session.get(Source, source_id)
    if source is None:
        return SyncResult(source_id, status="missing_source")
    provider = get_provider(source.provider)
    recent: frozenset[str] = frozenset()
    if getattr(provider, "incremental", False):
        hours = (
            getattr(provider, "detail_recheck_hours", None) or get_settings().detail_recheck_hours
        )
        cutoff = utcnow() - timedelta(hours=hours)
        recent = frozenset(
            session.scalars(
                select(JobSourceRecord.external_id).where(
                    JobSourceRecord.source_id == source.id,
                    JobSourceRecord.detail_fetched_at >= cutoff,
                )
            )
        )
    ref = SourceRef(source.provider, source.tenant_key, recent)
    started = utcnow()
    run = SourceRun(source_id=source.id, started_at=started, status="running", task_id=task_id)
    session.add(run)
    session.commit()
    result = SyncResult(source.id, status="running", run_id=run.id)
    bound = log.bind(source_run_id=str(run.id), provider=source.provider, tenant=source.tenant_key)

    records: list[dict] = []
    listed_only: list[str] = []
    complete = True
    cursor: str | None = None
    try:
        for _ in range(MAX_PAGES):
            page = provider.fetch_jobs(client, ref, cursor)
            run.pages_received += 1
            run.http_status = page.http_status
            run.pages_expected = page.pages_expected
            records.extend(page.records)
            listed_only.extend(page.listed_only)
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

    if complete:
        previous = _previous_complete_count(session, source.id, run.id)
        suspicious = previous is not None and (
            (not records and previous >= EMPTY_MIN_PREVIOUS)
            or (previous >= SHRINK_MIN_PREVIOUS and len(records) < previous * SHRINK_RATIO)
        )
        if suspicious:
            complete = False
            run.error_class = "suspicious_listing"
            bound.warning("suspicious_listing", previous=previous, now_seen=len(records))

    now = utcnow()
    seen_ids: set[str] = set()
    parse_failures = 0
    # Every posting (relevant or not) of the previous complete listing: a posting outside it
    # first appeared after that listing was fetched.
    previous_listing = set(source.listing_ids) if source.listing_ids_at else None
    for raw in records:
        result.records_seen += 1
        if raw.get("_listing_only"):
            # Listed but not re-read this run (incremental). Only a COMPLETE listing is open
            # evidence; it never creates a job and never changes content.
            seen_ids.add(raw["external_id"])
            if raw.get("_complete"):
                _touch_listed(session, source, run, raw["external_id"], now)
            continue
        try:
            n = provider.normalize(raw)
        except (KeyError, TypeError, ValueError):
            parse_failures += 1
            continue
        seen_ids.add(n.external_id)
        rel = assess(n)
        if not rel.relevant:
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
        _adopt_company_name(session, source, n)
        new_since = (
            source.listing_ids_at
            if previous_listing is not None and listing_key(n.external_id) not in previous_listing
            else None
        )
        outcome = upsert_job(session, source, run, n, rel, raw_hash(raw), now, new_since)
        if outcome == "created":
            result.created += 1
        elif outcome == "updated":
            result.updated += 1
        elif outcome == "merged":
            result.merged += 1
        elif outcome == "closed":
            result.closed += 1
        elif outcome == "skipped_expired":
            result.skipped_reasons["expired"] = result.skipped_reasons.get("expired", 0) + 1

    if parse_failures:
        result.skipped_reasons["parse_failure"] = parse_failures
        complete = False
    if not complete:
        result.still_listed = seen_ids | set(listed_only)

    if complete:
        seen_ids |= set(listed_only)  # every job the complete listing shows is present
        missing = update(JobSourceRecord).where(JobSourceRecord.source_id == source.id)
        if seen_ids:
            missing = missing.where(JobSourceRecord.external_id.not_in(seen_ids))
        session.execute(
            missing.values(
                consecutive_missing=JobSourceRecord.consecutive_missing + 1,
                first_missing_at=func.coalesce(JobSourceRecord.first_missing_at, now),
            )
        )
        source.listing_ids = sorted(listing_key(i) for i in seen_ids)
        source.listing_ids_at = run.started_at

    run.records_seen = result.records_seen
    run.records_relevant = result.records_relevant
    run.jobs_created, run.jobs_updated = result.created, result.updated
    run.is_complete = complete
    run.status = "succeeded" if complete else "partial"
    run.finished_at = utcnow()
    # Count every active job this source tracks, not just records refetched this run
    # (incremental career sites refetch only part of their listing per run).
    source.relevant_job_count = (
        session.scalar(
            select(func.count(func.distinct(JobSourceRecord.job_id)))
            .join(Job, Job.id == JobSourceRecord.job_id)
            .where(JobSourceRecord.source_id == source.id, Job.status == "active")
        )
        or 0
    )
    source.failure_count = 0
    source.last_run_at = now
    source.last_success_at = now
    source.status = "active" if source.relevant_job_count else "idle"
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
        merged=result.merged,
    )
    return result
