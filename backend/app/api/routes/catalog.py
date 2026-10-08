"""GET /jobs/{id}, /regions, /coverage."""

import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import rate_limit
from app.core.config import get_settings
from app.core.timeutil import utcnow
from app.db.session import get_async_session

router = APIRouter(dependencies=[Depends(rate_limit)])

JOB_SQL = """
SELECT j.*, c.name AS company_name, c.website_url AS company_website
FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
WHERE j.id = :id AND j.is_publishable
"""
LOC_SQL = """
SELECT jl.role, jl.verification_status, l.display_address, l.precision,
       ST_X(l.point) AS lon, ST_Y(l.point) AS lat, e.method, e.excerpt, e.source_url,
       e.observed_at
FROM job_locations jl JOIN locations l ON l.id = jl.location_id
LEFT JOIN evidence e ON e.id = jl.evidence_id
WHERE jl.job_id = :id AND jl.verification_status = 'verified'
ORDER BY jl.role
"""
ELIG_SQL = """
SELECT r.id, r.name, er.include_or_exclude FROM job_eligibility_regions er
JOIN regions r ON r.id = er.region_id WHERE er.job_id = :id ORDER BY er.include_or_exclude, r.id
"""
SRC_SQL = """
SELECT s.provider, s.tenant_key, s.base_url, jsr.canonical_url, jsr.source_updated_at,
       jsr.source_republished_at, jsr.last_seen_at
FROM job_source_records jsr JOIN sources s ON s.id = jsr.source_id
WHERE jsr.job_id = :id ORDER BY jsr.last_seen_at DESC NULLS LAST
"""


def _iso(v):
    return v.isoformat() if v is not None else None


@router.get("/jobs/{job_id}", tags=["jobs"])
async def job_detail(job_id: uuid.UUID, session: AsyncSession = Depends(get_async_session)) -> dict:
    j = (await session.execute(text(JOB_SQL), {"id": job_id})).first()
    if j is None:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "job not found"})
    fresh_cutoff = utcnow() - timedelta(hours=get_settings().freshness_hours)
    is_open = (
        j.status == "active"
        and j.last_verified_at is not None
        and j.last_verified_at >= fresh_cutoff
    )
    precise = {"rooftop", "street"}
    locations = [
        {
            "role": r.role,
            "address": r.display_address,
            "coordinates": [r.lon, r.lat] if r.lon is not None and r.precision in precise else None,
            "precision": r.precision,
            "evidence": {
                "method": r.method,
                "excerpt": r.excerpt,
                "source_url": r.source_url,
                "observed_at": _iso(r.observed_at),
            },
        }
        for r in await session.execute(text(LOC_SQL), {"id": job_id})
    ]
    elig = [dict(r._mapping) for r in await session.execute(text(ELIG_SQL), {"id": job_id})]
    sources = [
        {
            "provider": r.provider,
            "board_url": r.base_url,
            "job_url": r.canonical_url,
            "source_updated_at": _iso(r.source_updated_at),
            "source_republished_at": _iso(r.source_republished_at),
            "last_seen_at": _iso(r.last_seen_at),
        }
        for r in await session.execute(text(SRC_SQL), {"id": job_id})
    ]
    return {
        "id": str(j.id),
        "title": j.title,
        "company": {"name": j.company_name, "website": j.company_website},
        "workplace_type": j.workplace_type,
        "status": j.status,
        # A Closed/Pending/stale job is never presented as an open application opportunity.
        "is_open_opportunity": is_open,
        "posted_at": _iso(j.posted_at),
        "posted_date": _iso(j.posted_date),
        "posted_precision": j.posted_precision,
        "posted_basis": j.posted_basis,
        "first_seen_at": _iso(j.first_seen_at),
        "last_verified_at": _iso(j.last_verified_at),
        "closed_at": _iso(j.closed_at),
        "close_reason": j.close_reason,
        "location_status": j.location_status,
        "location_label": j.location_text,
        "locations": locations,
        "eligibility": {
            "status": j.eligibility_status,
            "text": j.remote_eligibility_text,
            "regions": elig,
            "note": "Check the original posting for residency, time-zone and on-site requirements"
            if j.workplace_type == "remote"
            else None,
        },
        "employment_type": j.employment_type,
        "salary": None
        if j.salary_min is None and j.salary_max is None and not j.salary_raw
        else {
            "min": float(j.salary_min) if j.salary_min is not None else None,
            "max": float(j.salary_max) if j.salary_max is not None else None,
            "currency": j.salary_currency,
            "period": j.salary_period,
            "raw_text": j.salary_raw,
        },
        "description_text": j.description_text,
        "source": sources[0] if sources else None,
        "sources": sources,
        "apply_url": j.apply_url if is_open else None,
    }


@router.get("/regions", tags=["regions"])
async def regions(
    q: str | None = Query(default=None, max_length=80),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    rows = await session.execute(
        text(
            """SELECT id, name, parent_id, kind, geometry_is_approximate, dataset_version,
                      ST_XMin(bbox) w, ST_YMin(bbox) s, ST_XMax(bbox) e, ST_YMax(bbox) n
               FROM regions
               WHERE bbox IS NOT NULL AND (CAST(:q AS text) IS NULL OR name ILIKE :pattern
                                           OR id ILIKE :pattern)
               ORDER BY (kind = 'metro') DESC, (kind = 'municipality') DESC, name
               LIMIT 20"""
        ),
        {"q": q, "pattern": f"%{(q or '').replace('%', '').replace('_', '')}%"},
    )
    return {
        "items": [
            {
                "region_id": r.id,
                "name": r.name,
                "parent_id": r.parent_id,
                "kind": r.kind,
                "bbox": [r.w, r.s, r.e, r.n],
                "approximate": r.geometry_is_approximate,
                "dataset_version": r.dataset_version,
            }
            for r in rows
        ]
    }


@router.get("/coverage", tags=["coverage"])
async def coverage(session: AsyncSession = Depends(get_async_session)) -> dict:
    fresh_cutoff = utcnow() - timedelta(hours=get_settings().freshness_hours)
    src = await session.execute(
        text(
            """SELECT provider, status, count(*) n, max(last_success_at) last_success
               FROM sources GROUP BY provider, status ORDER BY provider, status"""
        )
    )
    by_provider: dict = {}
    last_success = None
    failing = 0
    for r in src:
        p = by_provider.setdefault(r.provider, {"sources": 0, "by_status": {}})
        p["sources"] += r.n
        p["by_status"][r.status] = r.n
        failing += r.n if r.status == "failing" else 0
        if r.last_success and (last_success is None or r.last_success > last_success):
            last_success = r.last_success
    jobs = (
        await session.execute(
            text(
                """SELECT
                     count(*) FILTER (WHERE status='active' AND is_publishable
                                      AND last_verified_at >= :cut) AS open_jobs,
                     count(*) FILTER (WHERE status='pending_verification') AS pending,
                     count(*) FILTER (WHERE status='closed') AS closed,
                     count(*) FILTER (WHERE status='active' AND location_status <> 'unverified')
                       AS located
                   FROM jobs"""
            ),
            {"cut": fresh_cutoff},
        )
    ).one()
    disc = (
        await session.execute(
            text(
                "SELECT finished_at, status FROM discovery_runs WHERE finished_at IS NOT NULL "
                "ORDER BY finished_at DESC LIMIT 1"
            )
        )
    ).first()
    return {
        "as_of": utcnow().isoformat(),
        "sources": by_provider,
        "failing_sources": failing,
        "last_successful_sync_at": _iso(last_success),
        "jobs": dict(jobs._mapping),
        "last_discovery_run": {"finished_at": _iso(disc.finished_at), "status": disc.status}
        if disc
        else None,
        "limitations": [
            "Coverage is limited to employers discovered so far; it is not all jobs in the GTA.",
            "Sources: Greenhouse, Ashby and Lever public job boards, plus selected employer pages.",
            "New employers are found via Common Crawl, which lags real postings by weeks.",
            "Known employers are re-checked about every 30 minutes; not real-time.",
            "Most postings give only a city; those jobs are listed without a map point.",
            "The GTA boundary is an approximate box, not the official boundary.",
        ],
    }
