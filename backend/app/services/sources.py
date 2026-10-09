"""Source registration, run locks and scheduling."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.timeutil import utcnow
from app.models import Company, Source
from app.providers.base import BoardInfo, SourceCandidate

# Why we believe automated access is acceptable, per provider. Shown in SOURCES.md.
POLICY_BY_PROVIDER = {
    "greenhouse": (
        "documented_public_api",
        "Greenhouse Job Board API is documented for public read access to published jobs; "
        "boards-api robots.txt only disallows /embed/.",
    ),
    "ashby": (
        "documented_public_api",
        "Ashby public job posting API, documented for embedding/reading published jobs.",
    ),
    "lever": ("documented_public_api", "Lever postings API; robots allows / with crawl-delay 1."),
    "successfactors": (
        "robots_allowed_official_page",
        "Employer's own SuccessFactors career site (public job pages + sitemap); every fetch "
        "checked against that host's robots.txt.",
    ),
    "workday": (
        "robots_allowed_official_page",
        "Employer's own Workday career site; only sites whose robots.txt allows the site path. "
        "Uses the JSON endpoint the public site itself calls (undocumented).",
    ),
    "bamboohr": (
        "robots_allowed_official_page",
        "Employer's own BambooHR careers page JSON (/careers/list, /careers/{id}/detail); "
        "tenant robots.txt only disallows /jobs/embed*.",
    ),
    "workable": (
        "robots_allowed_official_page",
        "Workable public job widget feed for the employer's account; apply.workable.com "
        "robots.txt allows all (content signal search=yes).",
    ),
    "jsonld": (
        "robots_allowed_official_page",
        "Employer's own careers page; every fetch checked against robots.txt.",
    ),
}

MAX_BACKOFF = timedelta(hours=24)


def register_source(
    session: Session,
    candidate: SourceCandidate,
    board: BoardInfo,
    *,
    discovered_via: str,
    discovery_url: str | None,
    discovery_candidate_id: uuid.UUID | None,
    now: datetime | None = None,
) -> tuple[Source, bool]:
    """Create company + source if new. Returns (source, created). Idempotent."""
    now = now or utcnow()
    existing = session.scalar(
        select(Source).where(
            Source.provider == candidate.provider, Source.tenant_key == candidate.tenant_key
        )
    )
    if existing is not None:
        return existing, False

    company = Company(name=board.company_name or candidate.tenant_key, identity_status="unverified")
    session.add(company)
    session.flush()
    policy_status, policy_note = POLICY_BY_PROVIDER[candidate.provider]
    stmt = (
        insert(Source)
        .values(
            company_id=company.id,
            provider=candidate.provider,
            tenant_key=candidate.tenant_key,
            base_url=candidate.canonical_url,
            status="active",
            discovered_via=discovered_via,
            discovery_url=discovery_url,
            discovery_candidate_id=discovery_candidate_id,
            next_run_at=now,
            failure_count=0,
            policy_status=policy_status,
            policy_note=policy_note,
            relevant_job_count=0,
        )
        .on_conflict_do_nothing(constraint="uq_sources_provider_tenant")
        .returning(Source.id)
    )
    new_id = session.scalar(stmt)
    if new_id is None:  # lost a race with another worker; use theirs and drop our company row
        session.delete(company)
        session.flush()
        return session.scalar(
            select(Source).where(
                Source.provider == candidate.provider, Source.tenant_key == candidate.tenant_key
            )
        ), False  # type: ignore[return-value]
    return session.get(Source, new_id), True  # type: ignore[return-value]


def acquire_lock(session: Session, source_id: uuid.UUID, owner: str) -> bool:
    """Database lock so the same source never runs twice concurrently. Expired locks
    (crashed worker) are reclaimed automatically."""
    now = utcnow()
    ttl = timedelta(minutes=get_settings().source_lock_ttl_minutes)
    got = session.execute(
        update(Source)
        .where(Source.id == source_id)
        .where(or_(Source.locked_until.is_(None), Source.locked_until < now))
        .values(locked_by=owner, locked_until=now + ttl)
        .returning(Source.id)
    ).scalar_one_or_none()
    session.commit()
    return got is not None


def release_lock(session: Session, source_id: uuid.UUID, owner: str) -> None:
    session.execute(
        update(Source)
        .where(Source.id == source_id, Source.locked_by == owner)
        .values(locked_by=None, locked_until=None)
    )
    session.commit()


def next_run_after_success(source: Source, now: datetime) -> datetime:
    s = get_settings()
    minutes = (
        s.source_active_interval_minutes
        if source.relevant_job_count > 0
        else s.source_idle_interval_minutes
    )
    return now + timedelta(minutes=minutes)


def next_run_after_failure(source: Source, now: datetime) -> datetime:
    base = timedelta(minutes=get_settings().source_active_interval_minutes)
    return now + min(base * (2 ** max(source.failure_count - 1, 0)), MAX_BACKOFF)


def due_source_ids(session: Session, limit: int = 200) -> list[uuid.UUID]:
    now = utcnow()
    rows = session.scalars(
        select(Source.id)
        .where(Source.status != "disabled")
        .where(Source.next_run_at <= now)
        .where(or_(Source.locked_until.is_(None), Source.locked_until < now))
        .order_by(Source.next_run_at)
        .limit(limit)
    )
    return list(rows)
