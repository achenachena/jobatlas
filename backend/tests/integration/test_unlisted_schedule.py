"""Re-checks of jobs a partial listing no longer shows are scheduled fairly: every job gets a
turn even when some keep failing (review finding 2026-10-09)."""

import uuid

import pytest
from sqlalchemy import select

from app.core.timeutil import utcnow
from app.models import JobSourceRecord, SourceRun
from app.providers.base import ProviderError, VerifyResult
from app.services import lifecycle
from tests.integration import factories as f

pytestmark = pytest.mark.integration


class FlakyProvider:
    """Detail checks fail for `failing` ids and say "open" for everything else."""

    verify_by_url = False

    def __init__(self, failing: set[str]):
        self.failing = failing
        self.calls: list[str] = []

    def verify_job(self, client, ref, key):
        self.calls.append(key)
        if key in self.failing:
            raise ProviderError("timeout", error_class="timeout")
        return VerifyResult("active", "page live")


def _setup(session, n):
    c = f.company(session)
    src = f.source(session, c, provider="successfactors")
    old_run = SourceRun(source_id=src.id, started_at=utcnow())
    session.add(old_run)
    session.flush()
    jobs = [f.job(session, c, src, external_id=f"j{i:02d}") for i in range(n)]
    for rec in session.scalars(select(JobSourceRecord)):
        rec.last_seen_run_id = old_run.id  # listed before, absent from the current run
    session.commit()
    return src, jobs


def _run(session, src):
    run = SourceRun(source_id=src.id, started_at=utcnow())
    session.add(run)
    session.commit()
    lifecycle.process_unlisted(session, src.id, run.id, client=None, still_listed=set(), limit=4)


def test_failing_jobs_do_not_starve_the_rest(session, monkeypatch):
    src, _ = _setup(session, 12)
    failing = {"j00", "j01", "j02", "j03"}  # the first slots in any naive order
    provider = FlakyProvider(failing)
    monkeypatch.setattr(lifecycle, "get_provider", lambda name: provider)

    for _ in range(4):
        _run(session, src)

    checked = set(provider.calls)
    assert checked == {f"j{i:02d}" for i in range(12)}  # everyone got a turn within 3 runs
    recs = {r.external_id: r for r in session.scalars(select(JobSourceRecord))}
    assert all(recs[k].verify_failures >= 1 for k in failing)
    assert all(recs[k].verify_failures == 0 for k in recs if k not in failing)
    # failures back off further than a successful check
    worst = max(recs[k].next_verify_at for k in failing)
    assert worst > utcnow()


def test_with_spare_capacity_every_unlisted_job_is_rechecked_each_run(session, monkeypatch):
    src, _ = _setup(session, 3)
    provider = FlakyProvider(set())
    monkeypatch.setattr(lifecycle, "get_provider", lambda name: provider)
    _run(session, src)
    _run(session, src)
    assert sorted(provider.calls) == sorted(["j00", "j01", "j02"] * 2)


def test_unknown_source_is_ignored(session):
    assert lifecycle.process_unlisted(session, uuid.uuid4(), uuid.uuid4(), None, set()) == 0
