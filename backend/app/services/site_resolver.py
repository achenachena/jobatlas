"""Resolve employer-named work sites to a specific building via OpenStreetMap (decision
2026-10-08, option A; docs/SOURCES.md §4.7).

Many enterprise postings name a site instead of a full address:
    "AMER - Canada - Ontario - Toronto - University Ave"      (employer + street)
    "Alumicor - Toronto - Humberline Dr"                      (employer + street)
    "Toronto, ON, Canada (1307 - Sherway Gardens)"            (named place: a mall)

Only what the employer stated is used. Two lookups, both against the self-hosted Nominatim
(full import style, which indexes named offices/malls/buildings):
  1. employer on street: an OSM object whose NAME contains the employer's brand token, whose
     road matches the stated street, inside the stated municipality;
  2. named place: an OSM object whose name matches the stated place (mall, building,
     campus...), inside the stated municipality.
A result is accepted only when every surviving candidate lies within SAME_SITE_METRES of the
first (one site). "Employer + city" without a street or place is never looked up — that would
be choosing among offices, which rule 3 forbids. Data © OpenStreetMap contributors (ODbL).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from urllib.parse import urlencode

import httpx

from app.services.addresses import STREET_TYPES, normalize_address
from app.services.region_match import MUNICIPALITIES, match_location_text

SAME_SITE_METRES = 150
STREET_NAME_RE = re.compile(
    rf"\b((?:[A-Z][\w'.]*\s+){{1,4}}(?:{STREET_TYPES})(?![A-Za-z])(?:\s+(?:West|East|North|South|W|E|N|S)\b\.?)?)"
)
PLACE_WORD_RE = re.compile(
    r"\b(Gardens|Mills|Mall|Centre|Center|Square|Plaza|Tower|Campus|Hospital|Airport|Station|"
    r"Place|Shopping|Outlets?|Marketplace|Commons|Park)\b",
    re.I,
)
GENERIC_WORDS = {
    "amer", "americas", "canada", "can", "ontario", "on", "office", "remote", "hybrid", "corporate",
    "head", "headquarters", "hq", "store", "location", "site", "north", "america", "usa", "us",
    "inc", "ltd", "llc", "lp", "co", "corp", "corporation", "company", "group", "holdings",
    "limited", "the", "of", "and", "united", "states", "india", "global", "international",
    "services", "solutions", "technologies", "technology", "pharmaceuticals",
}  # fmt: skip
GOOD_CLASSES = {"office", "building", "shop", "amenity", "tourism", "leisure", "craft",
                "healthcare", "man_made", "industrial", "commercial", "landuse"}  # fmt: skip


@dataclass
class SiteDescriptor:
    raw: str
    municipality: str | None
    street: str | None
    places: list[str] = field(default_factory=list)
    label_brands: list[str] = field(default_factory=list)

    @property
    def resolvable(self) -> bool:
        return self.municipality is not None and bool(self.street or self.places)

    def key(self, company_key: str) -> str:
        return "|".join([company_key, self.municipality or "", self.street or "",
                         ";".join(self.places)]).lower()  # fmt: skip


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", " ", text.lower()).strip()


def parse_site_label(label: str | None) -> SiteDescriptor:
    raw = label or ""
    street_m = STREET_NAME_RE.search(raw)
    street = street_m.group(1).strip() if street_m else None
    # Detect the municipality without the street name: "Hamilton, ON - Burlington St" is in
    # Hamilton, not Burlington.
    without_street = raw.replace(street, " ") if street else raw
    m = match_location_text(without_street)
    municipality = m.region_id if m and m.region_id in MUNICIPALITIES else None
    if street and re.match(r"^\d", street):
        street = None  # a numbered street is a full address, handled elsewhere
    places = []
    for inner in re.findall(r"\(([^)]*)\)", raw):
        inner = re.sub(r"^\s*\d+\s*-\s*", "", inner).strip()
        if PLACE_WORD_RE.search(inner) and not re.fullmatch(r"[A-Z]{1,3}\d*", inner):
            places.append(inner)
    for seg in re.split(r"\s+-\s+|,", re.sub(r"\([^)]*\)", "", raw)):
        seg = seg.strip()
        if seg and PLACE_WORD_RE.search(seg) and not STREET_NAME_RE.search(seg):
            places.append(seg)
    if street and any(normalize_address(street) == normalize_address(p) for p in places):
        street = None  # "Sherway Gardens" is a named place (a mall), not a street
    label_brands = []
    first = re.split(r"\s+-\s+", raw)[0].strip()
    if first and not match_location_text(first) and _norm(first) not in GENERIC_WORDS:
        label_brands = [t for t in _norm(first).split() if len(t) >= 4 and t not in GENERIC_WORDS]
    return SiteDescriptor(raw, municipality, street, list(dict.fromkeys(places)), label_brands)


def brand_tokens(company_name: str | None, tenant_key: str | None = None,
                 extra: list[str] | None = None) -> list[str]:  # fmt: skip
    """Distinctive lowercase tokens identifying the employer: from its name (legal codes and
    suffixes removed), the platform tenant slug (e.g. "aritzia" in aritzia.wd3...), and the
    site label itself ("Alumicor - Toronto - ...")."""
    tokens: list[str] = []
    if company_name:
        name = re.sub(r"^[A-Z]*\d+[\w-]*\s+", "", company_name)  # "1023 Becton..." / "US11344-X"
        tokens += [t for t in _norm(name).split() if len(t) >= 4 and t not in GENERIC_WORDS]
    if tenant_key:
        host = re.sub(r"^https?://", "", tenant_key).split("/")[0]
        slug = host.split(".")[0]
        if len(slug) >= 4 and slug not in GENERIC_WORDS and not slug.startswith("wd"):
            tokens.append(slug)
    tokens += extra or []
    return list(dict.fromkeys(tokens))


# Words an OSM name may carry beyond the employer's place name: owner prefixes (CF =
# Cadillac Fairview) and generic place nouns.
EXTRA_NAME_WORDS = {"cf", "the", "shopping", "centre", "center", "mall", "shops", "at"}


def _place_queries(place: str, city: str) -> list[str]:
    queries = [f"{place}, {city}"]
    words = place.split()
    if words and words[0].lower() == city.lower() and len(words) > 1:
        queries.append(f"{' '.join(words[1:])}, {city}")  # "Toronto Eaton Centre" -> "Eaton Centre"
    return queries


def _place_name_matches(place: str, name: str, city: str) -> bool:
    """All words of the stated place appear in the OSM name (the city word may be absent),
    and the name adds nothing but generic words: "CF Toronto Eaton Centre" matches
    "Toronto Eaton Centre"; "Eaton Centre parking" does not."""
    want = set(_norm(place).split())
    have = set(_norm(name).split())
    required = want - {city.lower()}
    if not required or not required <= have:
        return False
    return not (have - want - EXTRA_NAME_WORDS - {city.lower()})


@dataclass(frozen=True)
class Resolution:
    lon: float
    lat: float
    display: str
    osm_ref: str
    name: str
    method: str


def _distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def _in_municipality(result: dict, municipality: str) -> bool:
    a = result.get("address") or {}
    parts = [
        a.get(k) for k in ("city", "town", "village", "municipality", "suburb", "city_district")
    ]
    m = match_location_text(", ".join(p for p in parts if p) + ", ON")
    return m is not None and m.region_id == municipality


def _streets_match(road: str | None, street: str) -> bool:
    if not road:
        return False
    a, b = normalize_address(road), normalize_address(street)
    return a == b or a.startswith(b + " ") or b.startswith(a + " ")


def _display(result: dict) -> str:
    a = result.get("address") or {}
    street = " ".join(p for p in (a.get("house_number"), a.get("road")) if p)
    city = a.get("city") or a.get("town") or a.get("village")
    parts = [result.get("name"), street, city, a.get("postcode")]
    return ", ".join(p for p in parts if p)


class SiteResolver:
    def __init__(self, client: httpx.Client, base_url: str):
        self.client = client
        self.base_url = base_url.rstrip("/")

    def _search(self, q: str, limit: int = 10) -> list[dict]:
        params = {"q": q, "format": "jsonv2", "addressdetails": 1, "namedetails": 1,
                  "limit": limit, "countrycodes": "ca"}  # fmt: skip
        resp = self.client.get(f"{self.base_url}/search?{urlencode(params)}")
        if resp.status_code != 200:
            raise httpx.HTTPStatusError("geocoder error", request=resp.request, response=resp)
        return resp.json()

    def _unique(self, results: list[dict], method: str) -> Resolution | None:
        if not results:
            return None
        pts = [(float(r["lon"]), float(r["lat"])) for r in results]
        if any(_distance_m(pts[0], p) > SAME_SITE_METRES for p in pts[1:]):
            return None  # several distinct sites: ambiguous
        r = results[0]
        return Resolution(pts[0][0], pts[0][1], _display(r), f"{r['osm_type']}/{r['osm_id']}",
                          r.get("name") or "", method)  # fmt: skip

    def company_offices(self, brands: list[str], municipality: str) -> list[Resolution]:
        """The employer's offices in one municipality as mapped in OSM: office objects whose
        name contains a brand word, one Resolution per distinct site (150 m). The caller
        decides what a single or several sites mean."""
        city = municipality.replace("-", " ").title()
        found: list[dict] = []
        for brand in brands:
            found += [
                r for r in self._search(f"{brand}, {city}", limit=40)
                if r.get("category", r.get("class")) == "office"
                and re.search(rf"\b{re.escape(brand)}\b", _norm(r.get("name") or ""))
                and _in_municipality(r, municipality)
            ]  # fmt: skip
        sites: list[list[dict]] = []
        for r in found:
            p = (float(r["lon"]), float(r["lat"]))
            for site in sites:
                q = (float(site[0]["lon"]), float(site[0]["lat"]))
                if _distance_m(p, q) <= SAME_SITE_METRES:
                    site.append(r)
                    break
            else:
                sites.append([r])
        return [
            Resolution(
                float(s[0]["lon"]),
                float(s[0]["lat"]),
                _display(s[0]),
                f"{s[0]['osm_type']}/{s[0]['osm_id']}",
                s[0].get("name") or "",
                "osm_company_office",
            )  # fmt: skip
            for s in sites
        ]

    def resolve(self, desc: SiteDescriptor, brands: list[str]) -> Resolution | None:
        if not desc.resolvable:
            return None
        city = desc.municipality.replace("-", " ").title()  # type: ignore[union-attr]
        if desc.street and brands:
            for brand in brands:
                found = [
                    r for r in self._search(f"{brand}, {desc.street}, {city}")
                    if brand in _norm(r.get("name") or "")
                    and _streets_match((r.get("address") or {}).get("road"), desc.street)
                    and _in_municipality(r, desc.municipality)  # type: ignore[arg-type]
                    and r.get("category", r.get("class")) in GOOD_CLASSES
                ]  # fmt: skip
                hit = self._unique(found, "employer_on_street_osm")
                if hit:
                    return hit
        for place in desc.places:
            found = []
            for q in _place_queries(place, city):
                found = [
                    r for r in self._search(q, limit=40)
                    if _place_name_matches(place, r.get("name") or "", city)
                    and _in_municipality(r, desc.municipality)  # type: ignore[arg-type]
                    and r.get("category", r.get("class")) in GOOD_CLASSES
                ]  # fmt: skip
                if found:
                    break
            hit = self._unique(found, "named_place_osm")
            if hit:
                return hit
        return None


def build_site_resolver() -> SiteResolver | None:
    from app.core.config import get_settings

    s = get_settings()
    if not s.geocoder_poi_url:
        return None
    # Operator-configured self-hosted service (private address): not scraped input.
    client = httpx.Client(
        timeout=httpx.Timeout(s.http_timeout_seconds),
        headers={"User-Agent": s.http_user_agent},
        trust_env=False,
    )
    return SiteResolver(client, s.geocoder_poi_url)
