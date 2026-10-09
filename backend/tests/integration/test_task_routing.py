import pytest

from app.workers import tasks
from tests.integration import factories as f

pytestmark = pytest.mark.integration


def test_career_sites_sync_on_their_own_queue(session, monkeypatch):
    sent = []
    monkeypatch.setattr(
        tasks.sync_source_task, "apply_async", lambda args, queue=None: sent.append((args, queue))
    )
    c = f.company(session)
    gh = f.source(session, c, "greenhouse")
    wd = f.source(session, c, "workday")
    orc = f.source(session, c, "oracle")
    tasks.enqueue_syncs(session, [gh.id, wd.id, orc.id])
    assert sent == [
        ((str(gh.id),), None),
        ((str(wd.id),), "careersite"),
        ((str(orc.id),), "careersite"),
    ]


def test_due_sources_can_be_picked_per_queue(session):
    from app.core.timeutil import utcnow
    from app.services.sources import due_source_ids

    c = f.company(session)
    gh, wd = f.source(session, c, "greenhouse"), f.source(session, c, "workday")
    gh.next_run_at = wd.next_run_at = utcnow()
    session.flush()
    sites = tasks.CAREERSITE_PROVIDERS
    assert due_source_ids(session, exclude_providers=sites) == [gh.id]
    assert due_source_ids(session, 5, providers=sites) == [wd.id]
