"""Job ↔ location association, geocoding, and public location status (DEVELOPMENT.md §8).

Two separate questions, two separate records:
1. Association — does this address belong to THIS job (work site) or to the company the remote
   job refers to? Stored as job_locations + evidence. Established only from the job's own
   structured address, an explicitly anchored address in its own text, or (remote only) the
   company's verified headquarters/office.
2. Precision — does the address resolve to a building/street number? Stored on locations.

A job is placed on the map only when both hold:
    on_site / hybrid / unknown -> verified work_site with a precise point -> exact_work_location
                                  (only the company's single city office -> inferred_office)
    remote                     -> verified company_office/headquarters, precise -> company_location
Everything else is `unverified` and gets no map point (rules 1–4).
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from geoalchemy2.elements import WKTElement
from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.timeutil import utcnow
from app.models import Company, CompanyLocation, Evidence, Job, JobLocation, Location
from app.providers.base import NormalizedJob, StructuredAddress
from app.services.addresses import (
    DIRECTIONS,
    STREET_RE,
    SUFFIXES,
    extract_explicit_addresses,
    normalize_address,
)
from app.services.geocode import POSTAL_RE, PRECISE, Geocoder, distance_m, parse_address
from app.services.region_match import (
    GTA_ALIASES,
    MUNICIPALITIES,
    MUNICIPALITY_ALIASES_UNAMBIGUOUS,
    PROVINCES,
)

# Evidence methods that come from the job's own data; these links are rebuilt on every
# content change. Company-derived links (headquarters) are managed separately.
JOB_METHODS = {
    "ashby_postal_address",
    "jsonld_postal_address",
    "jsonld_address_text",
    "description_explicit_address",
    "workday_jsonld_address",
    "oracle_work_location",
    "label_street_address",
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


def label_street_addresses(labels: list[str]) -> list[tuple[str, str]]:
    """(display, label) for location labels that state a street address themselves:
    "180 WELLINGTON ST W:TORONTO", "CAN: Toronto (111 Richmond Street West)",
    "CAN, Ontario, Burlington, 5045 South Service Rd, Suite 101". The city must come from
    the same label (a GTA municipality); a bare street never gets a guessed city."""
    from app.services.region_match import match_location_text

    out = []
    for label in labels:
        if not label:
            continue
        text = re.sub(r"[:()]", ", ", label)
        if sum(ch.isupper() for ch in text) > sum(ch.islower() for ch in text):
            text = text.title()  # "WELLINGTON ST W" -> "Wellington St W"
        m = re.search(STREET_RE, text)
        if not m:
            continue
        rest = text[: m.start()] + " " + text[m.end() :]
        region = match_location_text(rest)
        city = _municipality_name(region.region_id if region else None)
        if city:
            out.append((f"{m.group(0)}, {city}, ON", label))
    return out


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
    for display, label in label_street_addresses([n.location_text or "", *n.extra_location_labels]):
        hint = StructuredAddress(None, None, "ON", postal_hint, None, None, "hint")
        wanted.append(_Wanted(display, hint, "label_street_address", f"location: {label}", "high"))
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
# Employer-named sites resolved via OSM (services/site_resolver.py). Job-derived, so they
# outrank company-derived links.
SITE_METHODS = {"employer_on_street_osm", "named_place_osm", "employer_branch_directory"}


# Whole place names are removed from a label before looking for site words, so "York" in
# "One York" (a building) survives while "North York" (a district) does not.
_PLACE_PHRASES = sorted(
    {*MUNICIPALITIES, *MUNICIPALITY_ALIASES_UNAMBIGUOUS, *GTA_ALIASES}
    | {a for aliases in PROVINCES.values() for a in aliases},
    key=len,
    reverse=True,
)
_GENERIC_WORDS = {
    "canada", "can", "ca", "usa", "us", "gta", "greater", "area", "region", "amer",
    "americas", "noram", "na", "hq", "office", "offices", "remote", "hybrid", "onsite",
    "location", "locations", "headquarters", "head", "corporate", "main", "the", "of", "and",
}  # fmt: skip
_NUMBER_WORDS = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
                 "seven": "7", "eight": "8", "nine": "9", "ten": "10"}  # fmt: skip


def site_words(label: str | None, company_name: str | None) -> set[str]:
    """Words in a job's location label that name a particular site, beyond city/province/
    country and the employer's own name: "Sun Life Toronto Atria" -> {"atria"}."""
    if not label:
        return set()
    company = set(re.findall(r"[a-z0-9]+", (company_name or "").lower()))
    text = label.lower()
    for phrase in _PLACE_PHRASES:
        text = re.sub(rf"(?<![a-z]){re.escape(phrase.replace('-', ' '))}(?![a-z])", " ", text)
    out = set()
    for w in re.findall(r"[a-z0-9]+", text):
        if w in _GENERIC_WORDS or w in company or re.fullmatch(r"[a-z]\d[a-z]|\d[a-z]\d", w):
            continue
        out.add(_NUMBER_WORDS.get(w, SUFFIXES.get(w, DIRECTIONS.get(w, w))))
    return out


def _office_has_site(session: Session, c: CompanyLocation, words: set[str]) -> bool:
    loc = session.get(Location, c.location_id)
    text = normalize_address((loc.display_address or loc.normalized_address) if loc else "")
    return words <= set(text.split())


def _by_building(session: Session, locs: list[CompanyLocation]) -> dict:
    """Company addresses grouped by building: "80 Spadina Ave., Toronto" (office) and
    "80 Spadina Ave, Toronto, M5V 2J4" (headquarters) are one place, not two offices.
    Per building, prefer the address that already has a precise point."""
    out: dict = {}
    for c in locs:
        loc = session.get(Location, c.location_id)
        parts = parse_address((loc.display_address or loc.normalized_address) if loc else "")
        key = (parts.house, parts.street) if parts.house and parts.street else c.location_id
        best = out.get(key)
        if best is None or (loc is not None and loc.point is not None):
            out[key] = c
    return out


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
            Evidence.method.in_(JOB_METHODS | SITE_METHODS),
        )
        .limit(1)
    )
    remote = job.workplace_type == "remote"
    company = session.get(Company, job.company_id)
    target: tuple[CompanyLocation, str, str] | None = None
    if not own:
        company_locs = session.scalars(
            select(CompanyLocation).where(
                CompanyLocation.company_id == job.company_id,
                CompanyLocation.invalidated_at.is_(None),
            )
        ).all()
        if job.location_region_id in MUNICIPALITIES:
            # A label naming a particular site ("Sun Life Toronto Atria") only takes an
            # office whose address states that site ("One York" -> "1 York Street").
            words = site_words(job.location_text, company.name if company else None)
            in_city = _by_building(
                session,
                [
                    c
                    for c in company_locs
                    if c.label == job.location_region_id
                    and (not words or _office_has_site(session, c, words))
                ],
            )
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
        where = (
            "only office mapped in OpenStreetMap"
            if source is not None and source.method == "osm_company_office"
            else "only published address"
        )
        excerpt = (
            f"job location '{job.location_text}' -> company's {where} in "
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


INFERRED_METHODS = {"company_single_city_office"}


def refresh_location_status(session: Session, job: Job) -> str:
    """exact_work_location needs a work site backed by the job itself (its own address or a
    resolved named site). A work site whose only backing is "the company publishes one address
    in this city" is shown as inferred_office: on the map, but never labelled verified."""
    rows = session.execute(
        select(JobLocation.role, Evidence.method)
        .join(Location, Location.id == JobLocation.location_id)
        .outerjoin(Evidence, Evidence.id == JobLocation.evidence_id)
        .where(
            JobLocation.job_id == job.id,
            JobLocation.verification_status == "verified",
            Location.point.is_not(None),
            Location.precision.in_(PRECISE),
        )
    ).all()
    roles = {role for role, _ in rows}
    if job.workplace_type == "remote":
        status = "company_location" if roles & {"company_office", "headquarters"} else "unverified"
    elif any(role == "work_site" and method not in INFERRED_METHODS for role, method in rows):
        status = "exact_work_location"
    elif "work_site" in roles:
        status = "inferred_office"
    else:
        status = "unverified"
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
        base = loc.display_address or loc.normalized_address
        country = (loc.country or "ca").lower()
        if loc.postal_code and not POSTAL_RE.search(base.upper()):  # never add a second one
            result = geocoder.geocode(f"{base}, {loc.postal_code}", country)
            if result.status in ("not_found", "mismatch"):
                # The hint is the job's postal code, which can belong to another site (City
                # of Toronto jobs carry City Hall's). Without it the ambiguity check still
                # refuses same-named streets that are far apart.
                result = geocoder.geocode(base, country)
        else:
            result = geocoder.geocode(base, country)
        if result.status == "error":
            # Geocoder down or unreachable: not a fact about this address. Leave it (and the
            # rest of the batch) for the next run instead of caching a failure.
            stats.unusable["error"] = stats.unusable.get("error", 0) + 1
            break
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


@dataclass
class RecheckStats:
    checked: int = 0
    kept: int = 0
    moved: int = 0  # confirmed, but the validated result replaced a point >50 m away
    cleared: int = 0  # contradicted (mismatch/ambiguous): point removed
    unconfirmed: int = 0  # not found / too vague: point kept, outcome recorded
    errors: int = 0


def recheck_geocoded(
    session: Session, geocoder: Geocoder, *, limit: int | None = None
) -> RecheckStats:
    """Re-validate points that came from the geocoder against the address-agreement rules
    (geocode.check_agreement).

    - The geocoder confirms the address (ok, precise): the point stays; if the confirmed
      result lies more than 50 m away, the validated result replaces the old point.
    - The geocoder contradicts it (mismatch: other number/street/city/postal area) or finds
      several distant matches (ambiguous): the point is removed and its jobs fall back to
      "address not yet confirmed".
    - Anything else (not found, input too vague to check, low precision, temporary error) is
      absence of evidence, not a conflict: the point is kept and the outcome recorded.
    OSM site resolutions are not geocoder output and are left alone."""
    stats = RecheckStats()
    if geocoder.name == "none":
        return stats
    now = utcnow()
    rows = session.execute(
        select(Location, func.ST_X(Location.point), func.ST_Y(Location.point))
        .where(Location.point.is_not(None))
        .where(or_(Location.geocoder.is_(None), Location.geocoder != "osm-site"))
        .order_by(Location.geocoded_at.nulls_first())
        .limit(limit)
    ).all()
    changed: list[uuid.UUID] = []
    for loc, lon, lat in rows:
        stats.checked += 1
        query = loc.display_address or loc.normalized_address
        if loc.postal_code and not POSTAL_RE.search(query.upper()):
            query = f"{query}, {loc.postal_code}"
        result = geocoder.geocode(query, (loc.country or "ca").lower())
        if result.status in ("error", "not_configured"):
            stats.errors += 1
            continue
        loc.geocoded_at = now
        if result.status == "ok" and result.precision in PRECISE:
            if distance_m((lon, lat), (result.lon, result.lat)) > 50:  # type: ignore[arg-type]
                loc.point = WKTElement(f"POINT({result.lon} {result.lat})", srid=4326)
                loc.precision = result.precision
                loc.geocoder = result.provider
                stats.moved += 1
                changed.append(loc.id)
            else:
                stats.kept += 1
            loc.geocode_error = None
        elif result.status in ("mismatch", "ambiguous"):
            loc.point = None
            loc.precision = "unknown"
            loc.geocode_error = f"recheck {result.status}: {result.detail or ''}"[:500]
            stats.cleared += 1
            changed.append(loc.id)
        else:
            loc.geocode_error = f"recheck {result.status} (point kept): {result.detail or ''}"[:500]
            stats.unconfirmed += 1
        session.commit()
    if changed:
        jobs = session.scalars(
            select(Job)
            .join(JobLocation, JobLocation.job_id == Job.id)
            .where(JobLocation.location_id.in_(changed))
        ).unique()
        for job in jobs:
            refresh_location_status(session, job)
        session.commit()
    return stats


def invalidate_stale_site_links(session: Session, job: Job) -> None:
    """A resolved site link stays valid only while the job still names the same site."""
    rows = session.execute(
        select(JobLocation, Evidence)
        .join(Evidence, Evidence.id == JobLocation.evidence_id)
        .where(
            JobLocation.job_id == job.id,
            JobLocation.verification_status == "verified",
            Evidence.method.in_(SITE_METHODS),
        )
    ).all()
    for jl, ev in rows:
        if not job.location_text or f"'{job.location_text}'" not in (ev.excerpt or ""):
            jl.verification_status = "invalidated"
    session.flush()


@dataclass
class SiteStats:
    candidates: int = 0
    cache_hits: int = 0
    queried: int = 0
    resolved: int = 0
    linked: int = 0
    errors: int = 0


def resolve_sites(session: Session, resolver, *, limit: int = 300) -> SiteStats:
    """Link unverified on-site/hybrid/unknown jobs whose label names a street or place."""
    from app.models import Company, SiteResolution, Source
    from app.services.site_resolver import brand_tokens, parse_site_label

    stats = SiteStats()
    now = utcnow()
    retry_before = now - timedelta(days=get_settings().geocoder_retry_days)
    jobs = session.scalars(
        select(Job)
        .where(Job.status == "active", Job.workplace_type != "remote")
        .where(Job.location_status == "unverified", Job.location_text.is_not(None))
        .limit(limit * 3)
    ).all()
    for job in jobs:
        if stats.candidates >= limit:
            break
        own = session.scalar(
            select(JobLocation.id)
            .join(Evidence, Evidence.id == JobLocation.evidence_id)
            .where(
                JobLocation.job_id == job.id,
                JobLocation.verification_status == "verified",
                Evidence.method.in_(JOB_METHODS),
            )  # fmt: skip
            .limit(1)
        )
        if own:
            continue
        desc = parse_site_label(job.location_text)
        if not desc.resolvable or job.company_id is None:
            continue
        stats.candidates += 1
        company = session.get(Company, job.company_id)
        source = session.scalar(select(Source).where(Source.company_id == job.company_id).limit(1))
        brands = brand_tokens(company.name if company else None,
                              source.tenant_key if source else None, desc.label_brands)  # fmt: skip
        key = desc.key(str(job.company_id))
        cached = session.scalar(select(SiteResolution).where(SiteResolution.key == key))
        if cached is not None and (
            cached.status == "resolved" or cached.resolved_at > retry_before
        ):
            stats.cache_hits += 1
        else:
            stats.queried += 1
            try:
                hit = resolver.resolve(desc, brands)
            except Exception:  # noqa: BLE001 - geocoder hiccup: try again next run
                stats.errors += 1
                continue
            if cached is None:
                cached = SiteResolution(key=key, status="unresolved", resolved_at=now)
                session.add(cached)
            cached.resolved_at = now
            if hit is None:
                cached.status, cached.location_id, cached.detail = "unresolved", None, None
            else:
                loc = session.scalar(
                    select(Location).where(Location.normalized_address == f"osm:{hit.osm_ref}")
                )
                if loc is None:
                    loc = Location(
                        normalized_address=f"osm:{hit.osm_ref}", display_address=hit.display,
                        point=WKTElement(f"POINT({hit.lon} {hit.lat})", srid=4326),
                        precision="rooftop", geocoder="osm-site", geocoded_at=now,
                    )  # fmt: skip
                    session.add(loc)
                    session.flush()
                cached.status, cached.location_id = "resolved", loc.id
                cached.osm_ref, cached.detail = hit.osm_ref, f"{hit.method}: {hit.name}"
                stats.resolved += 1
            session.flush()
        if cached.status != "resolved" or cached.location_id is None:
            session.commit()
            continue
        method = (cached.detail or "named_place_osm").split(":", 1)[0]
        osm_type, osm_id = (cached.osm_ref or "/").split("/", 1)
        ev = add_evidence(
            session, "job", job.id, "location",
            method=method, confidence="medium",
            excerpt=f"employer site label '{job.location_text}' -> OSM {cached.osm_ref} "
            f"({cached.detail}); data © OpenStreetMap contributors (ODbL)",
            source_url=f"https://www.openstreetmap.org/{osm_type}/{osm_id}", now=now,
        )  # fmt: skip
        session.execute(
            insert(JobLocation)
            .values(job_id=job.id, location_id=cached.location_id, role="work_site",
                    verification_status="verified", evidence_id=ev.id)
            .on_conflict_do_update(constraint="uq_job_locations",
                                   set_={"verification_status": "verified", "evidence_id": ev.id})
        )  # fmt: skip
        link_job_to_company_locations(session, job, now)  # drops any weaker company link
        if refresh_location_status(session, job) == "exact_work_location":
            stats.linked += 1
        session.commit()
    return stats


@dataclass
class OsmOfficeStats:
    pairs: int = 0
    cache_hits: int = 0
    queried: int = 0
    offices: int = 0
    errors: int = 0
    jobs_linked: int = 0


def find_osm_offices(session: Session, resolver, *, limit: int = 200) -> OsmOfficeStats:
    """For (company, municipality) pairs with unlocated on-site/hybrid/unknown jobs and no
    known company address in that municipality, look up the company's offices there in
    OpenStreetMap (user decision 2026-10-12). Every distinct site found becomes a
    company_location (evidence: the OSM object); the single-office rule then links jobs only
    when the municipality has exactly one building for that company."""
    from app.models import SiteResolution, Source
    from app.services.site_resolver import brand_tokens

    stats = OsmOfficeStats()
    now = utcnow()
    retry_before = now - timedelta(days=get_settings().geocoder_retry_days * 7)
    known = select(CompanyLocation.company_id, CompanyLocation.label).where(
        CompanyLocation.invalidated_at.is_(None)
    )
    pairs = session.execute(
        select(Job.company_id, Job.location_region_id, func.count().label("n"))
        .where(Job.status == "active", Job.is_publishable, Job.workplace_type != "remote")
        .where(Job.location_status == "unverified", Job.location_region_id.in_(MUNICIPALITIES))
        .where(tuple_(Job.company_id, Job.location_region_id).not_in(known))
        .group_by(Job.company_id, Job.location_region_id)
        .order_by(func.count().desc())
        .limit(limit)
    ).all()
    touched: set[uuid.UUID] = set()
    for company_id, municipality, _n in pairs:
        stats.pairs += 1
        key = f"company:{company_id}|{municipality}"
        cached = session.scalar(select(SiteResolution).where(SiteResolution.key == key))
        if cached is not None and cached.resolved_at > retry_before:
            stats.cache_hits += 1
            continue
        company = session.get(Company, company_id)
        source = session.scalar(select(Source).where(Source.company_id == company_id).limit(1))
        brands = brand_tokens(company.name if company else None,
                              source.tenant_key if source else None)  # fmt: skip
        if not brands:
            continue
        stats.queried += 1
        try:
            sites = resolver.company_offices(brands, municipality)
        except Exception:  # noqa: BLE001 - geocoder hiccup: try again next run
            stats.errors += 1
            continue
        if cached is None:
            cached = SiteResolution(key=key, status="unresolved", resolved_at=now)
            session.add(cached)
        cached.resolved_at = now
        cached.status = "resolved" if sites else "unresolved"
        cached.detail = f"{len(sites)} OSM office site(s) for {brands}"
        for site in sites:
            loc = session.scalar(
                select(Location).where(Location.normalized_address == f"osm:{site.osm_ref}")
            )
            if loc is None:
                loc = Location(
                    normalized_address=f"osm:{site.osm_ref}", display_address=site.display,
                    point=WKTElement(f"POINT({site.lon} {site.lat})", srid=4326),
                    precision="rooftop", geocoder="osm-site", geocoded_at=now,
                )  # fmt: skip
                session.add(loc)
                session.flush()
            osm_type, osm_id = site.osm_ref.split("/", 1)
            ev = add_evidence(
                session, "company", company_id, "office",
                method="osm_company_office", confidence="medium",
                excerpt=f"OSM office '{site.name}' ({site.display}) for {brands}",
                source_url=f"https://www.openstreetmap.org/{osm_type}/{osm_id}", now=now,
            )  # fmt: skip
            session.execute(
                insert(CompanyLocation)
                .values(company_id=company_id, location_id=loc.id, role="office",
                        label=municipality, evidence_id=ev.id)
                .on_conflict_do_nothing(constraint="uq_company_locations")
            )  # fmt: skip
            stats.offices += 1
        touched.add(company_id)
        session.commit()
    for job in session.scalars(
        select(Job).where(Job.status == "active", Job.company_id.in_(touched))
    ):
        link_job_to_company_locations(session, job, now)
        if refresh_location_status(session, job) in ("inferred_office", "exact_work_location"):
            stats.jobs_linked += 1
    session.commit()
    return stats
