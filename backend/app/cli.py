"""Operator CLI. Internal tasks are triggered here (or by the scheduler), never via public API.

jobatlas discover [--max-blocks N] [--verify N] [--sync-new]
jobatlas sync --provider greenhouse --tenant <token> | --source-id <uuid>
jobatlas sync-due
jobatlas seed --provider greenhouse --tenant <token>     # labelled seed, not "discovered"
jobatlas stats
"""

from __future__ import annotations

import json
import uuid

import typer
from sqlalchemy import func, select

from app.core.logging import configure_logging
from app.db.session import sync_session
from app.discovery import pipeline
from app.models import DiscoveryCandidate, Job, Source, SourceRun
from app.net.safe_http import SafeHttpClient
from app.providers.base import SourceRef
from app.providers.registry import get_provider
from app.services.ingest import sync_source
from app.services.sources import due_source_ids, register_source

app = typer.Typer(no_args_is_help=True, add_completion=False)


@app.callback()
def _main(log_level: str = "WARNING") -> None:
    configure_logging(log_level)


def _echo(obj) -> None:
    typer.echo(json.dumps(obj, indent=2, default=str))


@app.command()
def discover(
    max_blocks: int = typer.Option(None, help="CC index blocks to read this run"),
    verify: int = typer.Option(None, help="candidates to verify live this run"),
    collections_back: int = typer.Option(1, help="how many newest collections to cover"),
    sync_new: bool = typer.Option(False, help="run the initial sync for new sources inline"),
    pattern: list[str] = typer.Option(None, help="restrict to host patterns (see commoncrawl.py)"),
) -> None:
    """Find previously unknown employers via the Common Crawl URL index."""
    with sync_session() as session, SafeHttpClient() as client:
        run = pipeline.start_run(session)
        harvest = pipeline.harvest_commoncrawl(
            session,
            client,
            max_blocks=max_blocks,
            collections_back=collections_back,
            patterns=pattern or None,
        )
        ver = pipeline.verify_candidates(session, client, limit=verify)
        stats = {"harvest": harvest.as_dict(), "verify": ver.as_dict()}
        synced = []
        if sync_new:
            for sid in ver.accepted_new_source:
                r = sync_source(session, sid, client)
                synced.append(
                    {
                        "source_id": sid,
                        "status": r.status,
                        "seen": r.records_seen,
                        "relevant": r.records_relevant,
                        "created": r.created,
                    }
                )
            stats["initial_sync"] = synced
        pipeline.finish_run(session, run, json.loads(json.dumps(stats, default=str)))
    _echo(stats)


@app.command()
def sync(
    provider: str = typer.Option(None),
    tenant: str = typer.Option(None),
    source_id: str = typer.Option(None),
) -> None:
    """Sync one already-registered source now."""
    with sync_session() as session, SafeHttpClient() as client:
        if source_id:
            sid = uuid.UUID(source_id)
        else:
            sid = session.scalar(
                select(Source.id).where(Source.provider == provider, Source.tenant_key == tenant)
            )
            if sid is None:
                raise typer.BadParameter("source not registered; use discover or seed")
        r = sync_source(session, sid, client)
    _echo(r.__dict__)


@app.command("sync-due")
def sync_due() -> None:
    """Sync every due source inline (useful without a running worker)."""
    out = []
    with sync_session() as session, SafeHttpClient() as client:
        for sid in due_source_ids(session):
            r = sync_source(session, sid, client)
            out.append({"source_id": sid, "status": r.status, "created": r.created})
    _echo(out)


@app.command()
def seed(provider: str = typer.Option(...), tenant: str = typer.Option(...)) -> None:
    """Register a source by hand. Marked discovered_via=seed; never counts as discovery."""
    p = get_provider(provider)
    with sync_session() as session, SafeHttpClient() as client:
        cand = (
            p.recognize(f"https://job-boards.greenhouse.io/{tenant}")
            if provider == "greenhouse"
            else None
        )
        if cand is None:
            raise typer.BadParameter("only greenhouse seeding is supported in stage 1")
        board = p.board_info(client, SourceRef(provider, cand.tenant_key))
        if not board.exists:
            raise typer.BadParameter(f"board {tenant} not found live")
        src, created = register_source(
            session,
            cand,
            board,
            discovered_via="seed",
            discovery_url=None,
            discovery_candidate_id=None,
        )
        session.commit()
    _echo({"source_id": src.id, "created": created})


@app.command()
def stats() -> None:
    """Counts that matter for SOURCES.md / VALIDATION.md."""
    with sync_session() as s:
        cands = dict(
            s.execute(
                select(DiscoveryCandidate.state, func.count()).group_by(DiscoveryCandidate.state)
            ).all()
        )
        cands_by_provider = {
            f"{p}:{st}": n
            for p, st, n in s.execute(
                select(
                    DiscoveryCandidate.provider, DiscoveryCandidate.state, func.count()
                ).group_by(DiscoveryCandidate.provider, DiscoveryCandidate.state)
            ).all()
        }
        sources = {
            f"{via}:{st}": n
            for via, st, n in s.execute(
                select(Source.discovered_via, Source.status, func.count()).group_by(
                    Source.discovered_via, Source.status
                )
            ).all()
        }
        jobs = dict(s.execute(select(Job.status, func.count()).group_by(Job.status)).all())
        posted = dict(
            s.execute(select(Job.posted_basis, func.count()).group_by(Job.posted_basis)).all()
        )
        workplace = dict(
            s.execute(select(Job.workplace_type, func.count()).group_by(Job.workplace_type)).all()
        )
        runs = dict(
            s.execute(select(SourceRun.status, func.count()).group_by(SourceRun.status)).all()
        )
    _echo(
        {
            "candidates": cands,
            "candidates_by_provider": cands_by_provider,
            "sources": sources,
            "jobs_by_status": jobs,
            "jobs_by_posted_basis": posted,
            "jobs_by_workplace": workplace,
            "source_runs": runs,
        }
    )


if __name__ == "__main__":
    app()
