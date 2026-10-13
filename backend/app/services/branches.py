"""Branch / store directories published by multi-site employers (user decision 2026-10-12).

A job whose own location label names a branch or store ("(CAN) ON BRAMPTON 01188 WM
SUPERCENTER") is linked to the address the employer itself publishes for that branch, when:
  - the employer's directory page is allowed by its robots.txt,
  - the page carries a structured (schema.org) address for that branch, and
  - the branch's city is the city the job label names.
The label names the site and the employer's own page gives its address, so the link counts
as the job's work site (like a resolved site name). Each directory is listed below with how
it was checked; see docs/SOURCES.md §4.14.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.timeutil import utcnow
from app.models import Company, Job, JobLocation, SiteResolution
from app.net.robots import RobotsCache
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.providers.base import StructuredAddress
from app.providers.jsonld import parse_html
from app.services.locations import (
    add_evidence,
    get_or_create_location,
    link_job_to_company_locations,
    refresh_location_status,
)
from app.services.region_match import match_location_text


@dataclass(frozen=True)
class BranchDirectory:
    key: str
    company_re: re.Pattern[str]  # which employer (by company name)
    label_re: re.Pattern[str]  # named groups: city, id
    url: str  # official page for one branch, {id}


DIRECTORIES = [
    # Verified 2026-10-09: walmart.ca robots.txt allows /en/store/*; each store page carries a
    # schema.org DepartmentStore with its PostalAddress.
    BranchDirectory(
        "walmart-ca",
        re.compile(r"\bwal-?mart\b", re.I),
        re.compile(r"\(CAN\)\s+ON\s+(?P<city>[A-Z][A-Z .'-]+?)\s+0*(?P<id>\d{3,5})\s+WM\b"),
        "https://www.walmart.ca/en/store/{id}",
    ),
]
STORE_TYPES = {"Store", "DepartmentStore", "GroceryStore", "LocalBusiness", "BankOrCreditUnion",
               "FinancialService", "Place"}  # fmt: skip


def branch_address(objects: list[dict]) -> StructuredAddress | None:
    for obj in objects:
        t = obj.get("@type")
        types = {t} if isinstance(t, str) else set(t or [])
        addr = obj.get("address")
        if not types & STORE_TYPES or not isinstance(addr, dict):
            continue
        street = addr.get("streetAddress")
        if isinstance(street, str) and street.strip():
            return StructuredAddress(
                street.strip(), addr.get("addressLocality") or None,
                addr.get("addressRegion") or None, addr.get("postalCode") or None,
                addr.get("addressCountry") or None, obj.get("name") or None,
                "employer_branch_directory",
            )  # fmt: skip
    return None


def _same_city(a: str | None, b: str | None) -> bool:
    ma = match_location_text(f"{a}, ON") if a else None
    mb = match_location_text(f"{b}, ON") if b else None
    return ma is not None and mb is not None and ma.region_id == mb.region_id


@dataclass
class BranchStats:
    candidates: int = 0
    cache_hits: int = 0
    fetched: int = 0
    resolved: int = 0
    city_mismatch: int = 0
    linked: int = 0
    errors: int = 0


def resolve_branches(session: Session, client: SafeHttpClient, *, limit: int = 300) -> BranchStats:
    stats = BranchStats()
    now = utcnow()
    retry_before = now - timedelta(days=get_settings().geocoder_retry_days)
    robots = RobotsCache(client)
    for directory in DIRECTORIES:
        jobs = session.execute(
            select(Job, Company.name)
            .join(Company, Company.id == Job.company_id)
            .where(Job.status == "active", Job.workplace_type != "remote")
            .where(Job.location_status == "unverified", Job.location_text.is_not(None))
        ).all()
        for job, company_name in jobs:
            if stats.candidates >= limit:
                return stats
            if not directory.company_re.search(company_name or ""):
                continue
            m = directory.label_re.search(job.location_text or "")
            if not m:
                continue
            stats.candidates += 1
            branch_id = m.group("id")
            url = directory.url.format(id=branch_id)
            key = f"branch:{directory.key}:{branch_id}"
            cached = session.scalar(select(SiteResolution).where(SiteResolution.key == key))
            if cached is not None and (
                cached.status == "resolved" or cached.resolved_at > retry_before
            ):
                stats.cache_hits += 1
            else:
                try:
                    if not robots.allowed(url):
                        stats.errors += 1
                        continue
                    resp = client.get(url)
                except (FetchError, UnsafeURLError):
                    stats.errors += 1
                    continue
                stats.fetched += 1
                addr = branch_address(parse_html(resp.text)[0]) if resp.status_code == 200 else None
                if cached is None:
                    cached = SiteResolution(key=key, status="unresolved", resolved_at=now)
                    session.add(cached)
                cached.resolved_at = now
                if addr is None:
                    cached.status, cached.location_id, cached.detail = "unresolved", None, None
                else:
                    loc = get_or_create_location(session, addr.one_line(), addr)
                    cached.status, cached.location_id = "resolved", loc.id
                    cached.detail = f"{directory.key} {branch_id}: {addr.one_line()}"
                    stats.resolved += 1
                session.flush()
            if cached.status != "resolved" or cached.location_id is None:
                session.commit()
                continue
            branch_city = (cached.detail or "").rsplit(": ", 1)[-1]
            if not _same_city(m.group("city").title(), _city_of(branch_city)):
                stats.city_mismatch += 1  # the label's city disagrees with the store's
                session.commit()
                continue
            ev = add_evidence(
                session, "job", job.id, "location",
                method="employer_branch_directory", confidence="high",
                excerpt=f"job location '{job.location_text}' names {directory.key} branch "
                f"{branch_id}; the employer's page gives {branch_city}",
                source_url=url, now=now,
            )  # fmt: skip
            session.execute(
                insert(JobLocation)
                .values(job_id=job.id, location_id=cached.location_id, role="work_site",
                        verification_status="verified", evidence_id=ev.id)
                .on_conflict_do_update(constraint="uq_job_locations",
                                       set_={"verification_status": "verified",
                                             "evidence_id": ev.id})
            )  # fmt: skip
            link_job_to_company_locations(session, job, now)
            refresh_location_status(session, job)
            stats.linked += 1
            session.commit()
    return stats


def _city_of(one_line: str) -> str | None:
    """City part of StructuredAddress.one_line(): "15 Resolution Dr, Brampton, ON, ..."."""
    parts = [p.strip() for p in one_line.split(",")]
    return parts[1] if len(parts) > 1 else None
