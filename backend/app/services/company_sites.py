"""Company website and official office addresses (DEVELOPMENT.md §8 step 4; decision of
2026-10-08 recorded in docs/SOURCES.md §4.4).

Website identity — accepted only from the company's own channels:
  1. its ATS board page links to it (Greenhouse/Lever header link, Ashby "website" field);
  2. its ATS board sends applicants to job pages on that domain.
Hosts of ATS vendors, social networks and CDNs never count. One clear winning domain is
required; anything ambiguous leaves the company without a website.

Office addresses — only from that domain: the homepage and contact/about/locations/privacy/
legal pages (robots.txt checked for every fetch, at most MAX_PAGES pages). Sources:
schema.org Organization/Place addresses, and plain-text street addresses followed by a city.
P.O. boxes and "c/o" addresses are ignored. Each address is a company_location with evidence
(page URL + excerpt). An address next to "headquarters"/"head office" is role=headquarters.

How jobs use them (services/locations.py):
  - a job whose own ATS location/office names a GTA municipality is linked to the company's
    office in that municipality ONLY when the company publishes exactly one distinct address
    there (user decision 2026-10-08); several addresses -> the job stays unverified;
  - a remote job without such a match falls back to the single verified headquarters.
"""

from __future__ import annotations

import html as htmllib
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import timedelta
from urllib.parse import quote, urljoin, urlsplit

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.timeutil import utcnow
from app.models import Company, CompanyLocation, Job, JobSourceRecord, Source
from app.net.robots import RobotsCache
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.providers.base import StructuredAddress
from app.providers.jsonld import parse_html
from app.services.addresses import CA_POSTAL_RE, STREET_RE
from app.services.locations import (
    add_evidence,
    get_or_create_location,
    link_job_to_company_locations,
    refresh_location_status,
)
from app.services.region_match import match_location_text

ATS_HOST_SUFFIXES = (
    "greenhouse.io", "ashbyhq.com", "lever.co", "workday.com", "myworkdayjobs.com",
    "myworkdaysite.com", "smartrecruiters.com", "icims.com", "bamboohr.com", "jobvite.com",
    "workable.com", "successfactors.com", "sapsf.com", "taleo.net",
)  # fmt: skip
NOISE_HOST_RE = re.compile(
    r"(google|gstatic|googleapis|cloudflare|cloudfront|akamai|fonts\.|cdn|linkedin|twitter|"
    r"x\.com|facebook|instagram|youtube|glassdoor|tiktok|apple\.com|w3\.org|schema\.org|"
    r"onetrust|cookielaw|hubspot|segment|sentry|intercom|gravatar|wp\.com|vimeo|github)",
    re.I,
)
TWO_LEVEL_SUFFIXES = ("co.uk", "com.au", "co.jp", "com.br", "co.nz", "co.in")
PAGE_HINT_RE = re.compile(r"contact|about|office|location|privacy|legal|terms|imprint", re.I)
ORG_TYPES = {"Organization", "Corporation", "LocalBusiness", "ProfessionalService", "NGO", "Place"}
HQ_RE = re.compile(r"head\s*quarters|headquartered|head office|\bHQ\b", re.I)
POBOX_RE = re.compile(r"\bP\.?\s?O\.?\s?Box\b|\bc/o\b", re.I)
TEXT_ADDRESS_RE = re.compile(
    rf"(?P<street>{STREET_RE})"
    r"(?P<unit>,?\s*(?:Suite|Ste\.?|Unit|Floor|Fl\.?|#)\s*[\w-]+)?"
    r",?\s*(?P<city>[A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2})"
    rf"(?P<tail>(?:,?\s*(?:ON|Ontario))?(?:,?\s*Canada)?(?:,?\s*{CA_POSTAL_RE})?)"
)
MAX_PAGES = 12
RECHECK_DAYS = 30


def registrable_domain(host: str) -> str:
    host = host.lower().rstrip(".")
    labels = host.split(".")
    n = 3 if any(host.endswith("." + s) for s in TWO_LEVEL_SUFFIXES) else 2
    return ".".join(labels[-n:])


def is_ats_host(host: str) -> bool:
    host = host.lower()
    return any(host == s or host.endswith("." + s) for s in ATS_HOST_SUFFIXES)


def _candidate_hosts(markup: str) -> list[str]:
    hosts = []
    for href in re.findall(r'href="(https?://[^"]+)"', markup):
        host = (urlsplit(htmllib.unescape(href)).hostname or "").lower()
        if host and not is_ats_host(host) and not NOISE_HOST_RE.search(host):
            hosts.append(registrable_domain(host))
    m = re.search(r'"(?:website|publicWebsite|companyWebsite)"\s*:\s*"(https?://[^"]+)"', markup)
    if m:
        hosts.extend([registrable_domain(urlsplit(m.group(1)).hostname or "")] * 3)
    return [h for h in hosts if h]


def _board_page(source: Source) -> str | None:
    t = source.tenant_key
    if source.provider == "greenhouse":
        return f"https://job-boards.greenhouse.io/{quote(t)}"
    if source.provider == "lever":
        host = "jobs.eu.lever.co" if t.startswith("eu:") else "jobs.lever.co"
        return f"https://{host}/{quote(t.removeprefix('eu:'))}"
    if source.provider == "ashby":
        return f"https://jobs.ashbyhq.com/{quote(t)}"
    return None


def discover_website(
    session: Session, client: SafeHttpClient, company: Company
) -> tuple[str, str] | None:
    """(domain, evidence) from the company's own ATS channels, or None if ambiguous."""
    votes: Counter = Counter()
    evidence = ""
    for source in session.scalars(select(Source).where(Source.company_id == company.id)):
        page = _board_page(source)
        if not page:
            continue
        try:
            resp = client.get(page)
        except (FetchError, UnsafeURLError):
            continue
        if resp.status_code == 200:
            for h in _candidate_hosts(resp.text):
                votes[h] += 1
            evidence = f"company's own job board {page} links to its website"
    urls = session.scalars(
        select(JobSourceRecord.canonical_url)
        .join(Source, Source.id == JobSourceRecord.source_id)
        .where(Source.company_id == company.id, JobSourceRecord.canonical_url.is_not(None))
        .limit(50)
    ).all()
    for u in urls:
        host = urlsplit(u).hostname or ""
        if host and not is_ats_host(host):
            votes[registrable_domain(host)] += 2
            evidence = evidence or "company's ATS board sends applicants to job pages on it"
    if not votes:
        return None
    ranked = votes.most_common(2)
    if len(ranked) > 1 and ranked[1][1] >= ranked[0][1]:
        return None  # tie: ambiguous
    return ranked[0][0], evidence


@dataclass(frozen=True)
class FoundAddress:
    address: StructuredAddress
    role: str  # office | headquarters
    excerpt: str
    page: str


def _from_jsonld(objects: list[dict], page: str) -> list[FoundAddress]:
    out = []

    def parse(addr, label) -> StructuredAddress | None:
        if not isinstance(addr, dict) or not isinstance(addr.get("streetAddress"), str):
            return None
        street = addr["streetAddress"].strip()
        if not street or POBOX_RE.search(street):
            return None
        country = addr.get("addressCountry")
        country = country.get("name") if isinstance(country, dict) else country
        return StructuredAddress(street, addr.get("addressLocality") or None,
                                 addr.get("addressRegion") or None, addr.get("postalCode") or None,
                                 country or None, label, "official_site_jsonld")  # fmt: skip

    for obj in objects:
        t = obj.get("@type")
        types = {t} if isinstance(t, str) else set(t or [])
        if not types & ORG_TYPES:
            continue
        addrs = obj.get("address")
        for a in addrs if isinstance(addrs, list) else [addrs]:
            parsed = parse(a, obj.get("name"))
            if parsed:
                role = "headquarters" if types & {"Organization", "Corporation"} else "office"
                out.append(FoundAddress(parsed, role, json.dumps(a)[:400], page))
        locs = obj.get("location")
        for loc in locs if isinstance(locs, list) else [locs]:
            if isinstance(loc, dict):
                parsed = parse(loc.get("address"), loc.get("name"))
                if parsed:
                    out.append(FoundAddress(parsed, "office", json.dumps(loc)[:400], page))
    return out


def _from_text(markup: str, page: str) -> list[FoundAddress]:
    text = re.sub(r"(?s)<script.*?</script>|<style.*?</style>", " ", markup)
    text = re.sub(r"<br\s*/?>|</p>|</div>|</li>", ", ", text, flags=re.I)
    text = htmllib.unescape(re.sub(r"<[^>]+>", " ", text))
    text = re.sub(r"\s+", " ", text)
    out = []
    for m in TEXT_ADDRESS_RE.finditer(text):
        city, tail = m.group("city"), m.group("tail") or ""
        if POBOX_RE.search(text[max(0, m.start() - 30) : m.end()]):
            continue
        if match_location_text(f"{city}, {tail}") is None and not tail.strip(" ,"):
            continue  # need a recognizable Canadian city or an ON/Canada/postal qualifier
        before = text[max(0, m.start() - 80) : m.start()]
        postal = re.search(CA_POSTAL_RE, tail)
        addr = StructuredAddress(
            street=(m.group("street") + (m.group("unit") or "")).strip(" ,"),
            city=city,
            region="ON" if re.search(r"\bON\b|Ontario", tail) else None,
            postal_code=postal.group(0) if postal else None,
            # Bare "CA" is ambiguous with California, so only the full word counts.
            country="Canada" if re.search(r"Canada", tail) else None,
            label=None,
            method="official_site_text",
        )
        excerpt = text[max(0, m.start() - 60) : m.end() + 20].strip()
        role = "headquarters" if HQ_RE.search(before) else "office"
        out.append(FoundAddress(addr, role, excerpt[:400], page))
    return out


def office_region(addr: StructuredAddress):
    """Region of an office address from its own city/province/country; never assumed."""
    if not addr.city:
        return None
    parts = [addr.city, addr.region or "", addr.country or "", addr.postal_code or ""]
    m = match_location_text(", ".join(p for p in parts if p))
    # A Canadian postal code or an explicit ON/Ontario/Canada is required for GTA names that
    # also exist elsewhere; match_location_text enforces that for ambiguous names.
    return m


@dataclass
class OfficeStats:
    companies: int = 0
    websites: int = 0
    pages_fetched: int = 0
    robots_blocked: int = 0
    addresses: int = 0
    jobs_linked: int = 0
    errors: list[str] = field(default_factory=list)


def _same_site(url: str, domain: str) -> bool:
    return registrable_domain(urlsplit(url).hostname or "") == domain


def _crawl(client: SafeHttpClient, domain: str, stats: OfficeStats) -> list[FoundAddress]:
    robots = RobotsCache(client)
    home = None
    for base in (f"https://www.{domain}/", f"https://{domain}/"):
        if not robots.allowed(base):
            stats.robots_blocked += 1
            continue
        try:
            resp = client.get(base)
        except (FetchError, UnsafeURLError) as exc:
            stats.errors.append(f"{base}: {exc}"[:200])
            continue
        if resp.status_code == 200 and _same_site(resp.url, domain):
            home = resp
            break
    if home is None:
        return []
    stats.pages_fetched += 1
    found = _from_jsonld(parse_html(home.text)[0], home.url) + _from_text(home.text, home.url)
    links = [urljoin(home.url, h) for h in re.findall(r'href="([^"#]+)"', home.text)]
    links = [u for u in dict.fromkeys(links) if _same_site(u, domain) and PAGE_HINT_RE.search(u)]
    for url in links[: MAX_PAGES - 1]:
        if not robots.allowed(url):
            stats.robots_blocked += 1
            continue
        try:
            resp = client.get(url)
        except (FetchError, UnsafeURLError):
            continue
        stats.pages_fetched += 1
        if resp.status_code != 200 or not _same_site(resp.url, domain):
            continue
        found += _from_jsonld(parse_html(resp.text)[0], resp.url) + _from_text(resp.text, resp.url)
    return found


def enrich_company(
    session: Session, client: SafeHttpClient, company: Company, stats: OfficeStats
) -> None:
    now = utcnow()
    company.offices_checked_at = now
    if company.canonical_domain is None:
        site = discover_website(session, client, company)
        if site is not None:
            company.canonical_domain, evidence = site
            company.website_url = f"https://{company.canonical_domain}"
            company.identity_status = "verified"
            add_evidence(
                session, "company", company.id, "website",
                method="ats_channel_links_to_domain", confidence="high",
                excerpt=evidence, source_url=None, now=now,
            )  # fmt: skip
    if company.canonical_domain is None:
        session.commit()
        return
    stats.websites += 1
    for f in _crawl(client, company.canonical_domain, stats):
        loc = get_or_create_location(session, f.address.one_line(), f.address)
        exists = session.scalar(
            select(CompanyLocation.id).where(
                CompanyLocation.company_id == company.id,
                CompanyLocation.location_id == loc.id,
                CompanyLocation.role == f.role,
            )
        )
        if exists:
            continue
        ev = add_evidence(
            session, "company", company.id, f.role,
            method=f.address.method, confidence="high", excerpt=f.excerpt,
            source_url=f.page, now=now,
        )  # fmt: skip
        region = office_region(f.address)
        session.execute(
            insert(CompanyLocation)
            .values(company_id=company.id, location_id=loc.id, role=f.role,
                    label=region.region_id if region else f.address.city, evidence_id=ev.id)
            .on_conflict_do_nothing(constraint="uq_company_locations")
        )  # fmt: skip
        stats.addresses += 1
    session.flush()
    for job in session.scalars(select(Job).where(Job.company_id == company.id)):
        link_job_to_company_locations(session, job, now)
        if refresh_location_status(session, job) != "unverified":
            stats.jobs_linked += 1
    session.commit()


def enrich_companies(session: Session, client: SafeHttpClient, *, limit: int = 20) -> OfficeStats:
    """Companies with active jobs that still lack a verified location, not checked recently."""
    stats = OfficeStats()
    cutoff = utcnow() - timedelta(days=RECHECK_DAYS)
    companies = session.scalars(
        select(Company)
        .where(
            Company.id.in_(
                select(Job.company_id).where(
                    Job.status == "active", Job.location_status == "unverified"
                )
            )
        )
        .where((Company.offices_checked_at.is_(None)) | (Company.offices_checked_at < cutoff))
        .order_by(Company.offices_checked_at.nulls_first())
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
