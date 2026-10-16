"""Employer boards: Canadian postings from public ATS posting APIs (dataset "ats").

Channels (admission basis in atlas/permissions.py):
    greenhouse  GET boards-api.greenhouse.io/v1/boards/{slug}/jobs
    lever       GET api.lever.co/v0/postings/{slug}?mode=json
    ashby       GET api.ashbyhq.com/posting-api/job-board/{slug}

Same metric as Job Bank: one record per (posting, Canadian work location), dated by its
first-publication day in America/Toronto. Only fact fields are kept; descriptions are
received but never stored.

Dates: Greenhouse `first_published`; Lever `createdAt`; Ashby `publishedAt` is the latest
publication, so an Ashby posting is dated when we first see it, except postings already
open when the board is first fetched (the baseline), where publishedAt is all there is.
A first-seen record keeps its date: later sweeps never move it.

History: a source's coverage starts 30 days before its first sweep. Those days are
`partial` ("backfilled": built from postings still open then, so they undercount closed
ones); later days are `complete` once over; today is `partial` until midnight. Postings
dated before coverage are stored but never counted.
"""

from __future__ import annotations

import queue
import re
import threading
import time
import urllib.robotparser
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from sqlalchemy import case, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.atlas.cities import PROVINCE_CODES, CityIndex, city_key, fold, province_code
from app.atlas.metrics import BACKFILL_NOTE, build_release, current_release, publish
from app.atlas.models import AtlasBoard, AtlasCity, AtlasCoverage, AtlasPosting
from app.atlas.occupations import CLASSIFICATION_VERSION, classify
from app.atlas.permissions import INGEST, admitted, source, sync_registry
from app.atlas.windows import REPORTING_TZ
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.timeutil import from_epoch_millis, parse_iso_datetime, utcnow

log = get_logger(__name__)

DATASET = "ats"
SOURCE_KEYS = {"greenhouse": "ats-greenhouse", "lever": "ats-lever", "ashby": "ats-ashby"}
# Display names, in the order the attribution lists them.
PLATFORM_NAMES = {"ats-greenhouse": "Greenhouse", "ats-ashby": "Ashby", "ats-lever": "Lever"}
BACKFILL_DAYS = 30
SWEEP_MINUTES = 50  # leaves the hourly schedule (and the Job Bank task) room on one worker
# Active boards and failed fetches are due again by the next hourly sweep (a sweep fetches
# for at most 50 minutes, so 5 minutes later is always before the next one starts).
RECHECK = {"active": timedelta(minutes=5), "foreign": timedelta(days=30),
           "gone": timedelta(days=30), "error": timedelta(minutes=5)}  # fmt: skip
STATUS_ORDER = {"active": 0, "new": 1, "foreign": 2, "gone": 3}

# ------------------------------------------------------------------ locations

# Bare city names accepted without a province: large Canadian cities whose name is not also a
# common city elsewhere (London, Hamilton, Victoria, Kingston, Halifax, Surrey... need one).
BARE_CITIES = {
    "toronto": "ON", "montreal": "QC", "vancouver": "BC", "calgary": "AB", "edmonton": "AB",
    "ottawa": "ON", "winnipeg": "MB", "mississauga": "ON", "brampton": "ON", "markham": "ON",
    "vaughan": "ON", "oakville": "ON", "kitchener": "ON", "saskatoon": "SK", "regina": "SK",
    "quebec city": "QC", "gatineau": "QC", "laval": "QC", "burnaby": "BC",
    "richmond hill": "ON",
}  # fmt: skip
# Region names that place a posting in a province without naming a city.
REGIONS = {"greater toronto area": "ON", "gta": "ON", "greater vancouver": "BC",
           "lower mainland": "BC", "greater montreal": "QC"}  # fmt: skip
US_STATES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
    "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
    "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
    "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
    "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota",
    "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
    "wisconsin", "wyoming",
}  # fmt: skip
# Qualifiers that make "City, X" a place outside Canada ("Vancouver, Washington").
FOREIGN = US_STATES | {
    "us", "usa", "united states", "uk", "united kingdom", "england", "scotland", "ireland",
    "france", "germany", "netherlands", "spain", "portugal", "italy", "poland", "romania",
    "india", "australia", "new zealand", "mexico", "brazil", "japan", "singapore",
    "philippines", "europe", "emea", "latam", "apac",
}  # fmt: skip
REMOTE_RE = re.compile(r"\b(remote|anywhere|distributed|work from home|wfh|teletravail|"
                       r"a distance)\b")  # fmt: skip
NOISE_RE = re.compile(r"\b(remote|hybrid|on-?site|in office|office|hq|headquarters|"
                      r"anywhere|teletravail|hybride|in|the)\b")  # fmt: skip
# Separators between locations ("and"/"&" are not: "Newfoundland and Labrador").
SPLIT_RE = re.compile(r"\s*(?:;|\||/| or |\n)\s*", re.I)
# Separators inside one location; a hyphen only when spaced ("Trois-Rivières" is one name).
PIECE_RE = re.compile(r"\s*,\s*|\s+[–-]\s+")


def _clean(piece: str) -> str:
    return re.sub(r"\s+", " ", NOISE_RE.sub(" ", piece)).strip(" ,-–")


@dataclass(frozen=True)
class Place:
    """One Canadian work location of a posting."""

    city_id: str | None
    province: str | None
    raw: str
    geo: str  # city | unconfirmed | remote


class LocationParser:
    def __init__(self, cities: CityIndex):
        self.cities = cities

    def _anywhere(self, name: str) -> tuple[str | None, str | None]:
        """Most populous Canadian place with this name, in any province."""
        key = city_key(name)
        best = max(
            ((hits[0], prov) for prov in PROVINCE_CODES
             if (hits := self.cities.entries.get((prov, key)))),
            default=None,
        )  # fmt: skip
        return (best[0][1], best[1]) if best else (None, None)

    def _city(self, prov: str | None, name: str, raw: str) -> Place | None:
        if prov:
            cid, _ = self.cities.match(prov, name)
        else:
            cid, prov = self._anywhere(name)
        return Place(cid, prov, raw, "city") if cid else None

    def _single(self, piece: str, clean: str, raw: str) -> Place | None:
        """One location of a list ("Chicago, Toronto"): only self-evidently Canadian forms."""
        remote = bool(REMOTE_RE.search(piece))
        m = re.match(r"^(?:ca|canada)\s*-\s*(.*)$", piece)  # "CA-Toronto", "Canada-Remote"
        m = m or re.match(r"^(.+?)\s+canada$", clean)  # "Toronto Canada"
        if m:
            rest = _clean(m.group(1))
            if rest:
                return self._city(None, rest, raw) or Place(None, None, raw, "unconfirmed")
            return Place(None, None, raw, "remote" if remote else "unconfirmed")
        if clean == "canada":
            return Place(None, None, raw, "remote" if remote else "unconfirmed")
        if clean in REGIONS:
            return Place(None, REGIONS[clean], raw, "unconfirmed")
        if clean in BARE_CITIES:
            return self._city(BARE_CITIES[clean], clean, raw)
        if len(clean) > 2 and (prov := province_code(clean)):
            return Place(None, prov, raw, "unconfirmed")
        return None

    def part(self, raw: str) -> list[Place]:
        """One location label -> its Canadian places (none: not Canada, or not knowable)."""
        text = re.sub(r"\(([^)]*)\)", r", \1", fold(raw).strip())
        remote = bool(REMOTE_RE.search(text))
        pieces = [(p, _clean(p)) for p in PIECE_RE.split(text)]
        cleaned = [c for _, c in pieces if c]
        if not cleaned:
            return []
        whole = " ".join(cleaned)
        if whole in REGIONS:
            return [Place(None, REGIONS[whole], raw, "unconfirmed")]
        provs = [province_code(c) for c in cleaned]
        canada = "canada" in cleaned
        named = [c for c, pc in zip(cleaned, provs, strict=True)
                 if not pc and c not in ("canada", "ca")]  # fmt: skip
        # One place qualified by a province and/or Canada: "Toronto, ON, Canada", "Ontario".
        if (any(provs) or canada) and len(named) <= 1 and not set(named) & FOREIGN:
            prov = next((pc for pc in provs if pc), None)
            if named and (hit := self._city(prov, named[0], raw)):
                return [hit]
            # a bare two-letter code is also a country code ("Amsterdam, NL", "Lima, PE")
            if not canada and all(len(c) == 2 for c, pc in zip(cleaned, provs, strict=True) if pc):
                return []
            return [Place(None, prov, raw, "remote" if remote and not named else "unconfirmed")]
        # "City, X" outside Canada: "Vancouver, WA", "London, UK", "Vancouver, Washington"
        if len(cleaned) == 2 and (cleaned[1] in FOREIGN or (len(cleaned[1]) == 2
                                                           and cleaned[1] != "ca")):  # fmt: skip
            return []
        # Otherwise a list of places, each read on its own: "SEA, SF, NY, Toronto".
        return [hit for p, c in pieces if c or REMOTE_RE.search(p)
                if (hit := self._single(p.strip(" -–"), c, raw))]  # fmt: skip

    def places(self, labels: Iterable[str], *, country_ca: bool = False,
               remote: bool = False) -> list[Place]:  # fmt: skip
        """All distinct Canadian places of a posting. A posting known to be in Canada with no
        recognisable place counts once, as remote or city-unconfirmed."""
        found: dict[str, Place] = {}
        for label in labels:
            for raw in SPLIT_RE.split(label or ""):
                for p in self.part(raw) if raw.strip() else []:
                    found.setdefault(p.city_id or p.geo, p)
        cities = [p for p in found.values() if p.geo == "city"]
        if cities:
            return cities
        if found:
            return [next(iter(found.values()))]
        if country_ca:
            return [Place(None, None, "Canada", "remote" if remote else "unconfirmed")]
        return []

    def address(self, addr: dict | None) -> Place | None | bool:
        """Ashby postalAddress -> Place; False when it says another country; None if empty."""
        pa = (addr or {}).get("postalAddress") or {}
        country = fold(str(pa.get("addressCountry") or "")).strip()
        if not country:
            return None
        if country not in ("canada", "ca"):
            return False
        raw = ", ".join(x for x in (pa.get("addressLocality"), pa.get("addressRegion")) if x)
        prov = province_code(str(pa.get("addressRegion") or ""))
        locality = str(pa.get("addressLocality") or "").strip()
        if locality:
            hit = self._city(prov, locality, raw or "Canada")
            if hit:
                return hit
        return Place(None, prov, raw or "Canada", "unconfirmed")


# ------------------------------------------------------------------ platforms


@dataclass
class Job:
    id: str
    title: str | None
    published: datetime | None  # platform's first-publication time, if trustworthy
    places: list[Place]
    workplace: str | None
    baseline_published: datetime | None = None  # Ashby publishedAt (latest publication)


@dataclass
class Board:
    company: str | None
    jobs: list[Job]  # Canadian jobs only
    total: int  # all listed jobs


def _toronto_day(ts: datetime) -> date:
    return ts.astimezone(REPORTING_TZ).date()


def parse_greenhouse(data: dict, loc: LocationParser) -> Board:
    jobs, company = [], None
    for j in data.get("jobs") or []:
        company = company or j.get("company_name")
        places = loc.places([(j.get("location") or {}).get("name") or ""])
        if places:
            published = parse_iso_datetime(j.get("first_published"))
            jobs.append(Job(str(j["id"]), j.get("title"), published, places, None))
    return Board(company, jobs, len(data.get("jobs") or []))


def parse_lever(data: list, loc: LocationParser) -> Board:
    jobs = []
    for j in data or []:
        cat = j.get("categories") or {}
        labels = cat.get("allLocations") or [cat.get("location") or ""]
        workplace = (j.get("workplaceType") or "").lower() or None
        places = loc.places(labels, country_ca=j.get("country") == "CA",
                            remote=workplace == "remote")  # fmt: skip
        if places:
            jobs.append(Job(j["id"], j.get("text"), from_epoch_millis(j.get("createdAt")), places,
                            workplace))  # fmt: skip
    return Board(None, jobs, len(data or []))


def parse_ashby(data: dict, loc: LocationParser) -> Board:
    jobs, listed = [], 0
    for j in data.get("jobs") or []:
        if j.get("isListed") is False:
            continue
        listed += 1
        remote = bool(j.get("isRemote")) or (j.get("workplaceType") or "").lower() == "remote"
        found: dict[str, Place] = {}
        unknown: list[str] = []
        for addr, label in [(j.get("address"), j.get("location"))] + [
            (s.get("address"), s.get("location")) for s in j.get("secondaryLocations") or []
        ]:
            p = loc.address(addr)
            if p is None:
                unknown.append(label or "")
            elif p:
                found.setdefault(p.city_id or p.geo, p)
        places = [p for p in found.values() if p.geo == "city"] or [
            Place(None, p.province, p.raw, "remote" if remote and not p.province else p.geo)
            for p in list(found.values())[:1]
        ]
        places = places or loc.places(unknown, remote=remote)
        if places:
            jobs.append(Job(j["id"], j.get("title"), None, places,
                            (j.get("workplaceType") or "").lower() or None,
                            parse_iso_datetime(j.get("publishedAt"))))  # fmt: skip
    return Board(None, jobs, listed)


@dataclass(frozen=True)
class Platform:
    name: str
    host: str
    url: Callable[[str], str]
    parse: Callable[..., Board]
    posted_basis: str


PLATFORMS = {
    "greenhouse": Platform(
        "greenhouse", "boards-api.greenhouse.io",
        lambda s: f"https://boards-api.greenhouse.io/v1/boards/{quote(s)}/jobs", parse_greenhouse,
        "Greenhouse first_published (first published on the employer's board)"),
    "lever": Platform(
        "lever", "api.lever.co", lambda s: f"https://api.lever.co/v0/postings/{quote(s)}?mode=json",
        parse_lever, "Lever createdAt (posting created on the employer's board)"),
    "ashby": Platform(
        "ashby", "api.ashbyhq.com",
        lambda s: f"https://api.ashbyhq.com/posting-api/job-board/{quote(s)}", parse_ashby,
        "First seen by JobAtlas (Ashby publishedAt is the latest publication)"),
}  # fmt: skip

# Board URLs found in the wild -> (platform, slug). Used by discovery and `ats-add`.
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
RESERVED = {"embed", "v1", "jobs", "job_app", "api", "assets", "static", "favicon.ico",
            "robots.txt", "sitemap.xml", "b", "meeting", "posting-api"}  # fmt: skip


def recognize(url: str) -> tuple[str, str] | None:
    try:
        parts = urlsplit(url if "//" in url else f"https://{url}")
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    seg = [s for s in parts.path.split("/") if s]
    slug = None
    if host in ("boards.greenhouse.io", "job-boards.greenhouse.io"):
        platform = "greenhouse"
        if seg[:2] in (["embed", "job_board"], ["embed", "job_app"]):
            slug = (parse_qs(parts.query).get("for") or [None])[0]
        elif seg:
            slug = seg[0]
    elif host == "jobs.lever.co":
        platform, slug = "lever", seg[0] if seg else None
    elif host == "jobs.ashbyhq.com":
        platform, slug = "ashby", seg[0] if seg else None
    else:
        return None
    if not slug or slug.lower() in RESERVED or not SLUG_RE.match(slug):
        return None
    return platform, slug.lower()


def add_boards(session: Session, pairs: Iterable[tuple[str, str]], found_via: str) -> int:
    rows = [{"platform": p, "slug": s, "found_via": found_via} for p, s in set(pairs)]
    added = 0
    for i in range(0, len(rows), 2000):
        stmt = insert(AtlasBoard).values(rows[i : i + 2000]).on_conflict_do_nothing()
        added += len(session.execute(stmt.returning(AtlasBoard.slug)).all())
    session.commit()
    return added


# ------------------------------------------------------------------ fetching


@dataclass
class Fetched:
    platform: str
    slug: str
    status: int | None  # HTTP status; None on a network error
    board: Board | None = None
    error: str | None = None


def _client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(30.0), trust_env=False, follow_redirects=False,
                        headers={"User-Agent": get_settings().atlas_user_agent})  # fmt: skip


def robots(client: httpx.Client, host: str) -> urllib.robotparser.RobotFileParser:
    """RFC 9309: a 4xx robots.txt means no rules; 5xx or no answer means do not crawl."""
    rp = urllib.robotparser.RobotFileParser()
    try:
        resp = client.get(f"https://{host}/robots.txt")
    except httpx.HTTPError:
        rp.disallow_all = True
        return rp
    if resp.status_code >= 500:
        rp.disallow_all = True
    elif resp.status_code >= 400:
        rp.allow_all = True
    else:
        rp.parse(resp.text.splitlines())
    return rp


def fetch_platform(
    platform: Platform, slugs: list[str], loc: LocationParser, out: queue.Queue,
    deadline: float, client: httpx.Client | None = None,
) -> None:  # fmt: skip
    """Fetch boards one by one, at least one second apart (or the robots crawl-delay)."""
    own = client is None
    client = client or _client()
    try:
        ua = get_settings().atlas_user_agent
        rp = robots(client, platform.host)
        delay = max(1.0, float(rp.crawl_delay(ua) or 0))
        for slug in slugs:
            if time.monotonic() > deadline:
                break
            url = platform.url(slug)
            if not rp.can_fetch(ua, url):
                out.put(Fetched(platform.name, slug, None, error="disallowed by robots.txt"))
                continue
            started = time.monotonic()
            try:
                resp = client.get(url)
                if resp.status_code == 200:
                    out.put(Fetched(platform.name, slug, 200, platform.parse(resp.json(), loc)))
                else:
                    out.put(Fetched(platform.name, slug, resp.status_code,
                                    error=f"HTTP {resp.status_code}"))  # fmt: skip
                    if resp.status_code == 429:
                        time.sleep(60)
            except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError) as exc:
                out.put(Fetched(platform.name, slug, None, error=f"{type(exc).__name__}: {exc}"))
            time.sleep(max(0.0, delay - (time.monotonic() - started)))
    finally:
        if own:
            client.close()


# ------------------------------------------------------------------ storing


def _rows(f: Fetched, board: AtlasBoard, now: datetime) -> list[dict]:
    platform = PLATFORMS[f.platform]
    baseline = board.baseline_at is None
    rows = []
    for job in f.board.jobs:
        published = job.published
        if f.platform == "ashby" and baseline:
            published = job.baseline_published
        if published is None or published > now:
            published = now
        occupation, evidence = classify(None, job.title)
        for p in job.places:
            rows.append({
                "source_key": SOURCE_KEYS[f.platform],
                "external_id": f"{f.slug}/{job.id}/{p.city_id or p.geo}",
                "title": job.title[:300] if job.title else None,
                "noc21": None,
                "posted_on": _toronto_day(published),
                "posted_basis": platform.posted_basis
                + (" — baseline: open when the board was first fetched" if baseline else ""),
                "province": p.province,
                "city_raw": p.raw[:120],
                "postal_fsa": None,
                "telework": (job.workplace or "")[:8] or None,
                "external": None,
                "city_id": p.city_id,
                "geo_status": p.geo,
                "occupation_id": occupation,
                "classification_version": CLASSIFICATION_VERSION,
                "classification_evidence": evidence[:300],
                "resource_id": f"{f.platform}:{f.slug}",
                "observed_at": now,
            })  # fmt: skip
    return rows


def store(session: Session, f: Fetched, now: datetime) -> int:
    """Record one fetch: new postings (existing ones keep their first-seen date) and the
    board's status. Returns the number of new posting records."""
    board = session.get(AtlasBoard, (f.platform, f.slug))
    inserted = 0
    if f.status == 200 and f.board is not None:
        rows = _rows(f, board, now)
        for i in range(0, len(rows), 1000):
            stmt = (
                insert(AtlasPosting)
                .values(rows[i : i + 1000])
                .on_conflict_do_nothing(constraint="uq_atlas_postings_source_ext")
            )
            inserted += len(session.execute(stmt.returning(AtlasPosting.id)).all())  # fmt: skip
        board.status = "active" if f.board.jobs else "foreign"
        board.canada_jobs = len(f.board.jobs)
        board.company = f.board.company or board.company
        board.baseline_at = board.baseline_at or now
        board.ok_at = now
        board.error = None
        board.next_check_at = now + RECHECK[board.status]
    elif f.status == 404:
        board.status, board.canada_jobs, board.error = "gone", 0, "HTTP 404"
        board.next_check_at = now + RECHECK["gone"]
    else:
        board.error = (f.error or "unknown error")[:300]
        board.next_check_at = now + RECHECK["error"]
    session.commit()
    return inserted


def update_coverage(session: Session, key: str, now: datetime) -> bool:
    """Extend a source's daily coverage to today. Returns True if any day changed state."""
    today = _toronto_day(now)
    last = session.scalar(
        select(func.max(AtlasCoverage.period_start)).where(AtlasCoverage.source_key == key)
    )
    plan: dict[date, tuple[str, str]] = {}
    if last is None:
        for i in range(BACKFILL_DAYS, 0, -1):
            plan[today - timedelta(days=i)] = (
                "partial",
                f"{BACKFILL_NOTE} on {today}: postings still open then (closed ones are missing)",
            )
    else:
        d = last
        while d < today:
            prev = session.scalar(select(AtlasCoverage).where(
                AtlasCoverage.source_key == key, AtlasCoverage.period_start == d))  # fmt: skip
            if prev is None or prev.note == "in progress":
                plan[d] = ("complete", "")
            d += timedelta(days=1)
    plan[today] = ("partial", "in progress")
    for day, (status, note) in plan.items():
        session.execute(
            insert(AtlasCoverage)
            .values(source_key=key, period_start=day, period_end=day, status=status,
                    note=note or None, rows=0)
            .on_conflict_do_update(constraint="uq_atlas_coverage_period",
                                   set_={"status": status, "note": note or None,
                                         "imported_at": now})
        )  # fmt: skip
    session.commit()
    return last != today


# ------------------------------------------------------------------ release facts

COUNTED_SQL = """
SELECT count(DISTINCT p.resource_id) AS employers, array_agg(DISTINCT p.source_key) AS keys
FROM atlas_postings p
JOIN atlas_coverage c ON c.source_key = p.source_key AND c.status IN ('complete', 'partial')
 AND p.posted_on BETWEEN c.period_start AND c.period_end
WHERE p.source_key = ANY(:keys)
"""


def counted(session: Session, keys: list[str]) -> dict:
    """Employers (boards) and sources with at least one posting counted in a release built now:
    stored with the release so they stay fixed for it."""
    r = session.execute(text(COUNTED_SQL), {"keys": keys}).mappings().one()
    return {"employers": r["employers"], "counted_sources": sorted(r["keys"] or [])}


def platforms(keys: Iterable[str]) -> list[str]:
    return [name for key, name in PLATFORM_NAMES.items() if key in set(keys)]


def attribution(names: list[str]) -> str:
    listed = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
    return (f"Counted from employers' public job boards hosted on {listed}. "
            "Not affiliated with these platforms.")  # fmt: skip


# ------------------------------------------------------------------ sweep


@dataclass
class SweepReport:
    fetched: dict[str, int] = field(default_factory=dict)
    errors: dict[str, int] = field(default_factory=dict)
    new_records: int = 0
    boards: dict[str, int] = field(default_factory=dict)
    release_id: str | None = None
    skipped_reason: str | None = None


def due_boards(session: Session, platform: str, now: datetime) -> list[str]:
    order = case(STATUS_ORDER, value=AtlasBoard.status)
    return list(session.scalars(
        select(AtlasBoard.slug)
        .where(AtlasBoard.platform == platform, AtlasBoard.next_check_at <= now)
        .order_by(order, AtlasBoard.next_check_at)
    ))  # fmt: skip


def sweep(
    session: Session,
    *,
    minutes: float = SWEEP_MINUTES,
    publish_release: bool = True,
    clients: dict[str, httpx.Client] | None = None,
    now: Callable[[], datetime] = utcnow,
) -> SweepReport:
    """Fetch every due board (active ones first) on the three platforms in parallel, one
    thread per platform; all database writes happen here, on the caller's session."""
    report = SweepReport()
    sync_registry(session)
    session.commit()
    if not session.scalar(select(func.count()).select_from(AtlasCity)):
        report.skipped_reason = "city catalogue empty: run `jobatlas atlas-cities` first"
        return report
    platforms = [p for p in PLATFORMS.values()
                 if admitted(source(session, SOURCE_KEYS[p.name]), need=INGEST)[0]]  # fmt: skip
    loc = LocationParser(CityIndex.build(session))
    out: queue.Queue = queue.Queue()
    deadline = time.monotonic() + minutes * 60
    threads = []
    for p in platforms:
        slugs = due_boards(session, p.name, now())
        if not slugs:
            continue
        t = threading.Thread(
            target=fetch_platform,
            daemon=True,
            args=(p, slugs, loc, out, deadline, (clients or {}).get(p.name)),
        )
        t.start()  # fmt: skip
        threads.append(t)
    ok: set[str] = set()
    while any(t.is_alive() for t in threads) or not out.empty():
        try:
            f = out.get(timeout=0.5)
        except queue.Empty:
            continue
        report.new_records += store(session, f, now())
        bucket = report.fetched if f.status in (200, 404) else report.errors
        bucket[f.platform] = bucket.get(f.platform, 0) + 1
        if f.status == 200:
            ok.add(f.platform)
    updated = [update_coverage(session, SOURCE_KEYS[p], now()) for p in sorted(ok)]
    changed = any(updated)
    report.boards = dict(session.execute(
        select(AtlasBoard.status, func.count()).group_by(AtlasBoard.status)).all())  # fmt: skip
    if publish_release and (report.new_records or changed or current_release(session, DATASET)
                            is None):  # fmt: skip
        keys = [k for k in SOURCE_KEYS.values() if admitted(source(session, k))[0]
                and session.scalar(select(func.count()).select_from(AtlasCoverage)
                                   .where(AtlasCoverage.source_key == k))]  # fmt: skip
        if keys:
            first = current_release(session, DATASET) is None
            release = build_release(session, DATASET, keys,
                                    change_kind="coverage" if first else "update")  # fmt: skip
            release.quality = {**release.quality, **counted(session, keys)}
            publish(session, release)
            report.release_id = release.id
    log.info("ats_sweep", **{k: v for k, v in report.__dict__.items() if v})
    return report
