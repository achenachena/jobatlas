"""Unknown-employer discovery (DEVELOPMENT.md §6.2).

    Common Crawl index blocks → recognize ATS tenant URLs → discovery_candidates (deduped)
    → live verification against the provider's public API → sources (auto-registered)
    → initial sync (caller enqueues) → region relevance decided by the sync itself.

No company names are typed in by a developer anywhere in this path. Progress is kept in
discovery_watermarks (per collection + host pattern), so an interrupted run resumes.
"""

from __future__ import annotations

import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select, true, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.timeutil import utcnow
from app.discovery.commoncrawl import (
    ATS_SURT_PREFIXES,
    CommonCrawlError,
    ZipNumIndex,
    list_collections,
)
from app.models import DiscoveryCandidate, DiscoveryRun, DiscoveryWatermark, Source
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.providers.base import ProviderError, SourceCandidate, SourceRef
from app.providers.registry import PROVIDERS, get_provider, recognize
from app.services.sources import register_source

log = get_logger(__name__)
CHANNEL = "commoncrawl"
MAX_VERIFY_ATTEMPTS = 3


@dataclass
class DiscoveryStats:
    collections: list[str] = field(default_factory=list)
    blocks_read: int = 0
    urls_seen: int = 0
    candidates_new: int = 0
    candidates_new_by_provider: Counter = field(default_factory=Counter)
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "collections": self.collections,
            "blocks_read": self.blocks_read,
            "urls_seen": self.urls_seen,
            "candidates_new": self.candidates_new,
            "candidates_new_by_provider": dict(self.candidates_new_by_provider),
            "errors": self.errors[:20],
        }


@dataclass
class VerifyStats:
    checked: int = 0
    accepted_new_source: list[uuid.UUID] = field(default_factory=list)
    accepted_existing: int = 0
    rejected: int = 0
    deferred_unsupported: int = 0
    retry_later: int = 0

    def as_dict(self) -> dict:
        return {
            "checked": self.checked,
            "new_sources": len(self.accepted_new_source),
            "accepted_existing": self.accepted_existing,
            "rejected": self.rejected,
            "deferred_unsupported": self.deferred_unsupported,
            "retry_later": self.retry_later,
        }


def _watermark(session: Session, collection: str, pattern: str) -> DiscoveryWatermark:
    session.execute(
        insert(DiscoveryWatermark)
        .values(channel=CHANNEL, collection=collection, pattern=pattern, next_block=0)
        .on_conflict_do_nothing(constraint="uq_discovery_watermarks")
    )
    return session.scalar(
        select(DiscoveryWatermark)
        .where(
            DiscoveryWatermark.channel == CHANNEL,
            DiscoveryWatermark.collection == collection,
            DiscoveryWatermark.pattern == pattern,
        )
        .with_for_update()
    )  # type: ignore[return-value]


def record_candidates(
    session: Session, found: dict[str, tuple[SourceCandidate, str, str]], collection: str
) -> Counter:
    """Insert candidates keyed by canonical URL; existing ones are left untouched."""
    created: Counter = Counter()
    for canonical, (cand, sample_url, ts) in found.items():
        observed = None
        if len(ts) >= 14:
            observed = datetime.strptime(ts[:14], "%Y%m%d%H%M%S").replace(tzinfo=UTC)
        new_id = session.scalar(
            insert(DiscoveryCandidate)
            .values(
                canonical_url=canonical,
                provider=cand.provider,
                tenant_key=cand.tenant_key,
                channel=CHANNEL,
                channel_ref=collection,
                sample_url=sample_url[:2000],
                observed_at=observed,
                state="new",
                attempts=0,
            )
            .on_conflict_do_nothing(constraint="uq_discovery_candidates_url")
            .returning(DiscoveryCandidate.id)
        )
        if new_id is not None:
            created[cand.provider] += 1
    return created


def harvest_commoncrawl(
    session: Session,
    client: SafeHttpClient,
    *,
    max_blocks: int | None = None,
    collections_back: int = 1,
    patterns: list[str] | None = None,
) -> DiscoveryStats:
    max_blocks = (
        max_blocks if max_blocks is not None else get_settings().discovery_max_blocks_per_run
    )
    stats = DiscoveryStats()
    collections = list_collections(client)[:collections_back]
    stats.collections = collections
    budget = max_blocks
    for collection in collections:
        index = ZipNumIndex(client, collection)
        for pattern in patterns or list(ATS_SURT_PREFIXES):
            if budget <= 0:
                return stats
            prefix = ATS_SURT_PREFIXES[pattern]
            wm = _watermark(session, collection, pattern)
            session.commit()
            if wm.completed_at is not None:
                continue
            try:
                blocks = index.find_blocks(prefix)
            except (FetchError, CommonCrawlError) as exc:
                stats.errors.append(f"{collection}/{pattern}: {exc}")
                continue
            wm = _watermark(session, collection, pattern)
            wm.blocks_total = len(blocks)
            session.commit()
            for i in range(wm.next_block, len(blocks)):
                if budget <= 0:
                    return stats
                try:
                    records = list(index.read_block(blocks[i], prefix))
                except (FetchError, CommonCrawlError) as exc:
                    stats.errors.append(f"{collection}/{pattern}#{i}: {exc}")
                    break  # keep watermark; resume this block next run
                budget -= 1
                stats.blocks_read += 1
                found: dict[str, tuple[SourceCandidate, str, str]] = {}
                for rec in records:
                    stats.urls_seen += 1
                    cand = recognize(rec.url)
                    if cand is not None and cand.canonical_url not in found:
                        found[cand.canonical_url] = (cand, rec.url, rec.timestamp)
                created = record_candidates(session, found, collection)
                stats.candidates_new += sum(created.values())
                stats.candidates_new_by_provider.update(created)
                wm = _watermark(session, collection, pattern)
                wm.next_block = i + 1
                if wm.next_block >= len(blocks):
                    wm.completed_at = utcnow()
                session.commit()
            else:
                wm = _watermark(session, collection, pattern)
                if wm.next_block >= len(blocks) and wm.completed_at is None:
                    wm.completed_at = utcnow()
                session.commit()
    return stats


def verify_candidates(
    session: Session,
    client: SafeHttpClient,
    *,
    limit: int | None = None,
    provider: str | None = None,
) -> VerifyStats:
    limit = limit if limit is not None else get_settings().discovery_max_verifications_per_run
    stats = VerifyStats()
    now = utcnow()

    supported = [name for name, p in PROVIDERS.items() if p.supports_fetch]
    # Candidates parked before their adapter existed get another chance.
    session.execute(
        update(DiscoveryCandidate)
        .where(
            DiscoveryCandidate.state == "deferred",
            DiscoveryCandidate.rejection_reason == "adapter_not_implemented",
            DiscoveryCandidate.provider.in_(supported),
        )
        .values(state="new", rejection_reason=None)
    )
    unsupported = [name for name, p in PROVIDERS.items() if not p.supports_fetch]
    res = session.execute(
        update(DiscoveryCandidate)
        .where(DiscoveryCandidate.state == "new", DiscoveryCandidate.provider.in_(unsupported))
        .values(state="deferred", rejection_reason="adapter_not_implemented", last_attempt_at=now)
    )
    stats.deferred_unsupported = res.rowcount or 0
    session.commit()

    candidates = list(
        session.scalars(
            select(DiscoveryCandidate)
            .where(DiscoveryCandidate.state == "new")
            .where(DiscoveryCandidate.provider == provider if provider else true())
            .order_by(DiscoveryCandidate.first_seen_at, DiscoveryCandidate.canonical_url)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    )
    for cand in candidates:
        stats.checked += 1
        cand.attempts += 1
        cand.last_attempt_at = utcnow()
        existing = session.scalar(
            select(Source).where(
                Source.provider == cand.provider, Source.tenant_key == cand.tenant_key
            )
        )
        if existing is not None:
            cand.state, cand.source_id = "accepted", existing.id
            stats.accepted_existing += 1
            session.commit()
            continue
        provider = get_provider(cand.provider)  # type: ignore[arg-type]
        try:
            board = provider.board_info(client, SourceRef(cand.provider, cand.tenant_key))  # type: ignore[arg-type]
        except (ProviderError, FetchError, UnsafeURLError) as exc:
            if cand.attempts >= MAX_VERIFY_ATTEMPTS:
                cand.state = "deferred"
                cand.rejection_reason = (
                    f"verification_failed:{getattr(exc, 'error_class', 'unsafe')}"
                )
            stats.retry_later += 1
            session.commit()
            continue
        if not board.exists:
            cand.state = "rejected"
            cand.rejection_reason = f"board_not_found_live:{board.http_status}"
            stats.rejected += 1
            session.commit()
            continue
        source, created = register_source(
            session,
            SourceCandidate(cand.provider, cand.tenant_key, cand.canonical_url),  # type: ignore[arg-type]
            board,
            discovered_via=CHANNEL,
            discovery_url=cand.sample_url,
            discovery_candidate_id=cand.id,
        )
        cand.state, cand.source_id = "accepted", source.id
        if created:
            stats.accepted_new_source.append(source.id)
            log.info(
                "source_discovered",
                provider=source.provider,
                tenant=source.tenant_key,
                via=CHANNEL,
                collection=cand.channel_ref,
            )
        else:
            stats.accepted_existing += 1
        session.commit()
    session.commit()
    return stats


def start_run(session: Session) -> DiscoveryRun:
    run = DiscoveryRun(channel=CHANNEL, started_at=utcnow(), status="running", stats={})
    session.add(run)
    session.commit()
    return run


def finish_run(session: Session, run: DiscoveryRun, stats: dict, error: str | None = None) -> None:
    run.finished_at = utcnow()
    run.stats = stats
    run.status = "failed" if error else "succeeded"
    run.error = error
    session.commit()
