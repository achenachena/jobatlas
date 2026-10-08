"""Company website and official office addresses (DEVELOPMENT.md §8, step 4).

Website identity: the employer's own ATS board links its jobs to that domain (e.g. Greenhouse
`absolute_url` = https://stripe.com/jobs/...). That link, made by the company's own board, is
the identity evidence. Hosts belonging to ATS vendors are never treated as company sites.

Offices: only schema.org JSON-LD on the company's own pages (homepage and a few standard
paths), each fetch allowed by robots.txt. Organization.address -> headquarters when it is a
single street address; other Place/LocalBusiness addresses -> office. These are used for
REMOTE jobs (company location) only; an on-site/hybrid job never borrows a company office
without its own explicit association (rule 3).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import timedelta
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.timeutil import utcnow
from app.models import Company, CompanyLocation, Job, JobSourceRecord, Source
from app.net.robots import RobotsCache
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.providers.base import StructuredAddress
from app.providers.jsonld import parse_html
from app.services.locations import (
    add_evidence,
    get_or_create_location,
    link_remote_job_to_company,
    refresh_location_status,
)

ATS_HOST_SUFFIXES = (
    "greenhouse.io", "ashbyhq.com", "lever.co", "workday.com", "myworkdayjobs.com",
    "smartrecruiters.com", "icims.com", "bamboohr.com", "jobvite.com", "workable.com",
)  # fmt: skip
TWO_LEVEL_SUFFIXES = ("co.uk", "com.au", "co.jp", "com.br", "co.nz", "co.in")
OFFICE_PATHS = ["/", "/contact", "/contact-us", "/about", "/about-us", "/locations", "/offices"]
ORG_TYPES = {"Organization", "Corporation", "LocalBusiness", "ProfessionalService", "NGO"}
RECHECK_DAYS = 30


def registrable_domain(host: str) -> str:
    host = host.lower().rstrip(".")
    labels = host.split(".")
    n = 3 if any(host.endswith("." + s) for s in TWO_LEVEL_SUFFIXES) else 2
    return ".".join(labels[-n:])


def is_ats_host(host: str) -> bool:
    host = host.lower()
    return any(host == s or host.endswith("." + s) for s in ATS_HOST_SUFFIXES)


def infer_website(session: Session, company: Company) -> str | None:
    """Domain the company's own ATS board links to. Requires a single consistent domain."""
    urls = session.scalars(
        select(JobSourceRecord.canonical_url)
        .join(Source, Source.id == JobSourceRecord.source_id)
        .where(Source.company_id == company.id, JobSourceRecord.canonical_url.is_not(None))
        .limit(50)
    ).all()
    domains = {
        registrable_domain(urlsplit(u).hostname or "")
        for u in urls
        if urlsplit(u).hostname and not is_ats_host(urlsplit(u).hostname or "")
    }
    if len(domains) != 1:
        return None
    return domains.pop()


def _addresses_from_objects(
    objects: list[dict],
) -> tuple[list[StructuredAddress], list[StructuredAddress]]:
    hq: list[StructuredAddress] = []
    offices: list[StructuredAddress] = []

    def parse(addr, label) -> StructuredAddress | None:
        if not isinstance(addr, dict):
            return None
        street = (
            (addr.get("streetAddress") or "").strip()
            if isinstance(addr.get("streetAddress"), str)
            else ""
        )
        if not street:
            return None
        country = addr.get("addressCountry")
        if isinstance(country, dict):
            country = country.get("name")
        return StructuredAddress(
            street=street,
            city=(addr.get("addressLocality") or None),
            region=(addr.get("addressRegion") or None),
            postal_code=(addr.get("postalCode") or None),
            country=country or None,
            label=label,
            method="official_site_jsonld",
        )

    for obj in objects:
        t = obj.get("@type")
        types = {t} if isinstance(t, str) else set(t or [])
        if not types & ORG_TYPES:
            continue
        addrs = obj.get("address")
        addrs = addrs if isinstance(addrs, list) else [addrs]
        parsed = [a for a in (parse(x, obj.get("name")) for x in addrs) if a]
        if "Organization" in types or "Corporation" in types:
            (hq if len(parsed) == 1 else offices).extend(parsed)
        else:
            offices.extend(parsed)
        locs = obj.get("location")
        locs = locs if isinstance(locs, list) else [locs]
        for loc in locs:
            if isinstance(loc, dict):
                a = parse(loc.get("address"), loc.get("name"))
                if a:
                    offices.append(a)
    return hq, offices


@dataclass
class OfficeStats:
    companies: int = 0
    websites: int = 0
    pages_fetched: int = 0
    robots_blocked: int = 0
    headquarters: int = 0
    offices: int = 0
    remote_jobs_linked: int = 0
    errors: list[str] = field(default_factory=list)


def enrich_company(
    session: Session, client: SafeHttpClient, company: Company, stats: OfficeStats
) -> None:
    now = utcnow()
    company.offices_checked_at = now
    domain = company.canonical_domain or infer_website(session, company)
    if domain is None:
        session.commit()
        return
    if company.canonical_domain is None:
        company.canonical_domain = domain
        company.website_url = f"https://{domain}"
        company.identity_status = "verified"
        add_evidence(
            session, "company", company.id, "website",
            method="ats_board_links_to_domain", confidence="high",
            excerpt=f"company's own ATS board links job postings to {domain}",
            source_url=None, now=now,
        )  # fmt: skip
    stats.websites += 1
    robots = RobotsCache(client)
    hq: list[StructuredAddress] = []
    offices: list[StructuredAddress] = []
    found_on: str | None = None
    for base in (f"https://www.{domain}", f"https://{domain}"):
        for path in OFFICE_PATHS:
            url = base + path
            if not robots.allowed(url):
                stats.robots_blocked += 1
                continue
            try:
                resp = client.get(url)
            except (FetchError, UnsafeURLError) as exc:
                stats.errors.append(f"{url}: {exc}"[:200])
                break
            stats.pages_fetched += 1
            if resp.status_code != 200:
                continue
            # Redirects must stay on the company's own domain.
            if registrable_domain(urlsplit(resp.url).hostname or "") != domain:
                continue
            h, o = _addresses_from_objects(parse_html(resp.text)[0])
            if h or o:
                hq, offices, found_on = h, o, resp.url
                break
        if found_on:
            break
    for role, items in (("headquarters", hq), ("office", offices)):
        for a in items:
            loc = get_or_create_location(session, a.one_line(), a)
            ev = add_evidence(
                session, "company", company.id, role,
                method="official_site_jsonld", confidence="high",
                excerpt=json.dumps({"name": a.label, "address": a.one_line()}),
                source_url=found_on, now=now,
            )  # fmt: skip
            session.execute(
                insert(CompanyLocation)
                .values(company_id=company.id, location_id=loc.id, role=role,
                        label=a.label, evidence_id=ev.id)
                .on_conflict_do_nothing(constraint="uq_company_locations")
            )  # fmt: skip
            stats.headquarters += role == "headquarters"
            stats.offices += role == "office"
    session.flush()
    for job in session.scalars(
        select(Job).where(Job.company_id == company.id, Job.workplace_type == "remote")
    ):
        link_remote_job_to_company(session, job, now)
        if refresh_location_status(session, job) == "company_location":
            stats.remote_jobs_linked += 1
    session.commit()


def enrich_companies(session: Session, client: SafeHttpClient, *, limit: int = 20) -> OfficeStats:
    """Companies with active remote jobs and no recent office check."""
    stats = OfficeStats()
    cutoff = utcnow() - timedelta(days=RECHECK_DAYS)
    companies = session.scalars(
        select(Company)
        .where(
            Company.id.in_(
                select(Job.company_id).where(Job.status == "active", Job.workplace_type == "remote")
            )
        )
        .where((Company.offices_checked_at.is_(None)) | (Company.offices_checked_at < cutoff))
        .limit(limit)
    ).all()
    for company in companies:
        stats.companies += 1
        try:
            enrich_company(session, client, company, stats)
        except Exception as exc:  # noqa: BLE001 - one company must not stop the batch
            session.rollback()
            stats.errors.append(f"{company.name}: {type(exc).__name__}: {exc}"[:200])
    return stats
