"""Explicitly synthetic test records (never used outside tests)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from geoalchemy2.elements import WKTElement
from sqlalchemy.orm import Session

from app.core.timeutil import utcnow
from app.models import (
    Company,
    Evidence,
    Job,
    JobEligibilityRegion,
    JobLocation,
    JobSourceRecord,
    Location,
    Source,
)


def company(session: Session, name="Test Co") -> Company:
    c = Company(name=name, identity_status="unverified")
    session.add(c)
    session.flush()
    return c


def source(session: Session, comp: Company, provider="greenhouse", tenant=None) -> Source:
    s = Source(
        company_id=comp.id, provider=provider, tenant_key=tenant or f"t{uuid.uuid4().hex[:8]}",
        base_url="https://example.test", status="active", discovered_via="seed",
        failure_count=0, policy_status="test", relevant_job_count=0,
    )  # fmt: skip
    session.add(s)
    session.flush()
    return s


def job(
    session: Session,
    comp: Company,
    src: Source | None = None,
    *,
    title="Backend Engineer",
    workplace="on_site",
    region="toronto",
    posted_at: datetime | None = None,
    posted_basis: str | None = None,
    verified_ago=timedelta(minutes=5),
    status="active",
    point: tuple[float, float] | None = None,
    role="work_site",
    eligibility: tuple[set, set] | None = None,
    external_id: str | None = None,
) -> Job:
    now = utcnow()
    j = Job(
        company_id=comp.id, title=title, workplace_type=workplace, status=status,
        is_publishable=True, posted_at=posted_at,
        posted_precision="datetime" if posted_at else "none",
        posted_basis=posted_basis or ("original" if posted_at else "unknown"),
        first_seen_at=now - timedelta(days=40), last_seen_at=now,
        last_verified_at=now - verified_ago, apply_url="https://example.test/apply",
        location_region_id=region, location_text=region,
        location_status="unverified",
        eligibility_status="known" if eligibility else (
            "unknown" if workplace == "remote" else "not_applicable"),
    )  # fmt: skip
    session.add(j)
    session.flush()
    if src is not None:
        session.add(
            JobSourceRecord(
                job_id=j.id,
                source_id=src.id,
                external_id=external_id or str(j.id),
                raw_hash="x",
                consecutive_missing=0,
            )  # fmt: skip
        )
    if point is not None:
        loc = Location(
            normalized_address=f"addr {uuid.uuid4()}", display_address="1 Test St, Toronto",
            point=WKTElement(f"POINT({point[0]} {point[1]})", srid=4326), precision="rooftop",
        )  # fmt: skip
        session.add(loc)
        session.flush()
        ev = Evidence(entity_type="job", entity_id=j.id, field="location", observed_at=now,
                      method="test", confidence="high")  # fmt: skip
        session.add(ev)
        session.flush()
        session.add(JobLocation(job_id=j.id, location_id=loc.id, role=role,
                                verification_status="verified", evidence_id=ev.id))  # fmt: skip
        j.location_status = "company_location" if workplace == "remote" else "exact_work_location"
    if eligibility:
        inc, exc = eligibility
        for r in inc:
            session.add(
                JobEligibilityRegion(job_id=j.id, region_id=r, include_or_exclude="include")
            )
        for r in exc:
            session.add(
                JobEligibilityRegion(job_id=j.id, region_id=r, include_or_exclude="exclude")
            )
    session.flush()
    return j
