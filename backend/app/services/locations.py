"""Job ↔ location association, geocoding, and public location status (DEVELOPMENT.md §8).

Two separate questions, two separate records:
1. Association — does this address belong to THIS job (work site) or to the company the remote
   job refers to? Stored as job_locations + evidence. Established only from the job's own
   structured address, an explicitly anchored address in its own text, or (remote only) the
   company's verified headquarters/office.
2. Precision — does the address resolve to a building/street number? Stored on locations.

A job is placed on the map only when both hold:
    on_site / hybrid / unknown -> verified work_site with a precise point -> exact_work_location
    remote                     -> verified company_office/headquarters, precise -> company_location
Everything else is `unverified` and gets no map point (rules 1–4).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from geoalchemy2.elements import WKTElement
from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.timeutil import utcnow
from app.models import CompanyLocation, Evidence, Job, JobLocation, Location
from app.providers.base import NormalizedJob, StructuredAddress
from app.services.addresses import extract_explicit_addresses, normalize_address
from app.services.geocode import POSTAL_RE, PRECISE, Geocoder
from app.services.region_match import MUNICIPALITIES

# Evidence methods that come from the job's own data; these links are rebuilt on every
# content change. Company-derived links (headquarters) are managed separately.
JOB_METHODS = {
    "ashby_postal_address",
    "jsonld_postal_address",
    "jsonld_address_text",
    "description_explicit_address",
    "workday_jsonld_address",
    "successfactors_microdata",
}
COMPANY_LINK_METHOD = "company_verified_location"


def add_evidence(
    session: Session,
    entity_type: str,
    entity_id: uuid.UUID,
    field_name: str,
    *,
    method: str,
    confidence: str,
    excerpt: str | None,
    source_url: str | None,
    now: datetime,
) -> Evidence:
    ev = Evidence(
        entity_type=entity_type,
        entity_id=entity_id,
        field=field_name,
        source_url=source_url,
        excerpt=(excerpt or "")[:1000] or None,
        observed_at=now,
        method=method,
        confidence=confidence,
    )
    session.add(ev)
    session.flush()
    return ev


def get_or_create_location(
    session: Session, display: str, addr: StructuredAddress | None = None
) -> Location:
    key = normalize_address(display)
    session.execute(
        insert(Location)
        .values(
            normalized_address=key,
            display_address=display,
            city=addr.city if addr else None,
            province=addr.region if addr else None,
            postal_code=addr.postal_code if addr else None,
            country=_country_code(addr.country) if addr else None,
            precision="unknown",
        )
        .on_conflict_do_nothing(constraint="uq_locations_normalized_address")
    )
    loc = session.scalar(select(Location).where(Location.normalized_address == key))
    if loc is not None and addr is not None and loc.point is None:
        # Fill hints learned later (postal code / city) so a failed geocode can be retried.
        changed = False
        if addr.postal_code and not loc.postal_code:
            loc.postal_code, changed = addr.postal_code, True
        if addr.city and not loc.city:
            loc.city, changed = addr.city, True
        if changed:
            loc.geocoded_at, loc.geocode_error = None, None
    return loc  # type: ignore[return-value]


def _municipality_name(region_id: str | None) -> str | None:
    if region_id in MUNICIPALITIES:
        return region_id.replace("-", " ").title()
    return None


def _country_code(country: str | None) -> str | None:
    if not country:
        return None
    c = country.strip().lower()
    return {"canada": "CA", "ca": "CA", "united states": "US", "usa": "US", "us": "US"}.get(c)


@dataclass
class _Wanted:
    display: str
    addr: StructuredAddress | None
    method: str
    excerpt: str
    confidence: str


def sync_job_addresses(
    session: Session, job: Job, n: NormalizedJob, source_url: str | None, now: datetime
) -> None:
    """Rebuild the links that come from the job's own data. Links no longer supported by the
    current content are invalidated (not deleted) so the history stays auditable."""
    role = "company_office" if job.workplace_type == "remote" else "work_site"
    wanted: list[_Wanted] = []
    for a in n.structured_addresses:
        if not a.street:  # city-only data is never an exact location
            continue
        wanted.append(
            _Wanted(a.one_line(), a, a.method, f"{a.label or ''} {a.one_line()}".strip(), "high")
        )
    city_hint = _municipality_name(job.location_region_id)
    # The job's own structured postal code (e.g. SuccessFactors microdata) disambiguates
    # same-named streets when the address text omits it.
    postal_hint = next((a.postal_code for a in n.structured_addresses if a.postal_code), None)
    for e in extract_explicit_addresses(n.description_text):
        display = e.display
        if not e.has_city:
            if city_hint is None:
                continue  # a bare street name is too ambiguous to geocode
            # The city comes from the job's own location label; the excerpt keeps the source.
            display = f"{display}, {city_hint}, ON"
        hint = StructuredAddress(None, city_hint, "ON" if city_hint else None, postal_hint,
                                 None, None, "hint")  # fmt: skip
        wanted.append(_Wanted(display, hint, "description_explicit_address", e.excerpt, "medium"))

    existing = session.execute(
        select(JobLocation, Evidence, Location)
        .join(Evidence, Evidence.id == JobLocation.evidence_id)
        .join(Location, Location.id == JobLocation.location_id)
        .where(JobLocation.job_id == job.id, Evidence.method.in_(JOB_METHODS))
    ).all()
    keep: set[tuple[str, str]] = set()
    for w in wanted:
        loc = get_or_create_location(session, w.display, w.addr)
        keep.add((str(loc.id), role))
        match = next((jl for jl, _, el in existing if el.id == loc.id and jl.role == role), None)
        if match is not None:
            if match.verification_status != "verified":
                match.verification_status = "verified"
            continue
        ev = add_evidence(
            session, "job", job.id, "location",
            method=w.method, confidence=w.confidence, excerpt=w.excerpt,
            source_url=source_url, now=now,
        )  # fmt: skip
        session.execute(
            insert(JobLocation)
            .values(
                job_id=job.id,
                location_id=loc.id,
                role=role,
                verification_status="verified",
                evidence_id=ev.id,
            )
            .on_conflict_do_update(
                constraint="uq_job_locations",
                set_={"verification_status": "verified", "evidence_id": ev.id},
            )
        )
    for jl, _, loc in existing:
        if (str(loc.id), jl.role) not in keep and jl.verification_status == "verified":
            jl.verification_status = "invalidated"
    session.flush()


COMPANY_METHODS = {COMPANY_LINK_METHOD, "company_single_city_office"}


def link_job_to_company_locations(session: Session, job: Job, now: datetime) -> None:
    """Company-derived location links (user decision 2026-10-08):

    1. The job's own location/office label names a GTA municipality and the company publishes
       exactly ONE distinct address there -> that address (work_site; company_office for
       remote jobs). Several addresses in that city -> no link.
    2. Otherwise, a remote job uses the company's single verified headquarters (rule 4).
    A job with its own explicit address never takes a company-derived one.
    """
    if job.company_id is None:
        return
    own = session.scalar(
        select(JobLocation.id)
        .join(Evidence, Evidence.id == JobLocation.evidence_id)
        .where(
            JobLocation.job_id == job.id,
            JobLocation.verification_status == "verified",
            Evidence.method.in_(JOB_METHODS),
        )
        .limit(1)
    )
    remote = job.workplace_type == "remote"
    target: tuple[CompanyLocation, str, str] | None = None
    if not own:
        company_locs = session.scalars(
            select(CompanyLocation).where(
                CompanyLocation.company_id == job.company_id,
                CompanyLocation.invalidated_at.is_(None),
            )
        ).all()
        if job.location_region_id in MUNICIPALITIES:
            in_city = {c.location_id: c for c in company_locs if c.label == job.location_region_id}
            if len(in_city) == 1:
                target = (
                    next(iter(in_city.values())),
                    "company_office" if remote else "work_site",
                    "company_single_city_office",
                )
        if target is None and remote:
            hq = {c.location_id: c for c in company_locs if c.role == "headquarters"}
            if len(hq) == 1:
                target = (next(iter(hq.values())), "headquarters", COMPANY_LINK_METHOD)

    current = session.execute(
        select(JobLocation, Evidence)
        .join(Evidence, Evidence.id == JobLocation.evidence_id)
        .where(JobLocation.job_id == job.id, Evidence.method.in_(COMPANY_METHODS))
    ).all()
    for jl, _ in current:
        if target is None or jl.location_id != target[0].location_id or jl.role != target[1]:
            jl.verification_status = "invalidated"
    if target is None:
        session.flush()
        return
    cl, role, method = target
    if any(
        jl.location_id == cl.location_id
        and jl.role == role
        and jl.verification_status == "verified"
        for jl, _ in current
    ):
        session.flush()
        return
    source = session.get(Evidence, cl.evidence_id) if cl.evidence_id else None
    if method == "company_single_city_office":
        excerpt = (
            f"job location '{job.location_text}' -> company's only published address in "
            f"{job.location_region_id}: {source.excerpt if source else ''}"
        )
    else:
        detail = source.excerpt if source else ""
        excerpt = f"remote job -> company's single verified headquarters: {detail}"
    ev = add_evidence(
        session, "job", job.id, "location",
        method=method, confidence="high", excerpt=excerpt,
        source_url=source.source_url if source else None, now=now,
    )  # fmt: skip
    session.execute(
        insert(JobLocation)
        .values(job_id=job.id, location_id=cl.location_id, role=role,
                verification_status="verified", evidence_id=ev.id)
        .on_conflict_do_update(
            constraint="uq_job_locations",
            set_={"verification_status": "verified", "evidence_id": ev.id},
        )
    )  # fmt: skip
    session.flush()


def refresh_location_status(session: Session, job: Job) -> str:
    rows = session.execute(
        select(JobLocation.role)
        .join(Location, Location.id == JobLocation.location_id)
        .where(
            JobLocation.job_id == job.id,
            JobLocation.verification_status == "verified",
            Location.point.is_not(None),
            Location.precision.in_(PRECISE),
        )
    ).scalars()
    roles = set(rows)
    if job.workplace_type == "remote":
        status = "company_location" if roles & {"company_office", "headquarters"} else "unverified"
    else:
        status = "exact_work_location" if "work_site" in roles else "unverified"
    job.location_status = status
    return status


@dataclass
class GeocodeStats:
    attempted: int = 0
    precise: int = 0
    unusable: dict[str, int] = field(default_factory=dict)
    skipped_not_configured: bool = False


def geocode_pending(
    session: Session, geocoder: Geocoder, *, limit: int | None = None
) -> GeocodeStats:
    s = get_settings()
    stats = GeocodeStats()
    if geocoder.name == "none":
        stats.skipped_not_configured = True  # don't cache "not configured" as a failure
        return stats
    now = utcnow()
    retry_before = now - timedelta(days=s.geocoder_retry_days)
    pending = session.scalars(
        select(Location)
        .where(Location.point.is_(None))
        .where(or_(Location.geocoded_at.is_(None), Location.geocoded_at < retry_before))
        .order_by(Location.created_at)
        .limit(limit or s.geocoder_batch_size)
    ).all()
    touched: list[uuid.UUID] = []
    for loc in pending:
        stats.attempted += 1
        query = loc.display_address or loc.normalized_address
        if loc.postal_code and not POSTAL_RE.search(query.upper()):  # never add a second one
            query = f"{query}, {loc.postal_code}"
        result = geocoder.geocode(query, (loc.country or "ca").lower())
        loc.geocoder = result.provider
        loc.geocoded_at = now
        if result.status == "ok" and result.precision in PRECISE:
            loc.point = WKTElement(f"POINT({result.lon} {result.lat})", srid=4326)
            loc.precision = result.precision
            loc.geocode_error = None
            stats.precise += 1
            touched.append(loc.id)
        else:
            loc.geocode_error = f"{result.status}: {result.detail or ''}"[:500]
            stats.unusable[result.status] = stats.unusable.get(result.status, 0) + 1
        session.commit()
    if touched:
        jobs = session.scalars(
            select(Job)
            .join(JobLocation, JobLocation.job_id == Job.id)
            .where(JobLocation.location_id.in_(touched))
        ).unique()
        for job in jobs:
            refresh_location_status(session, job)
        session.commit()
    return stats
