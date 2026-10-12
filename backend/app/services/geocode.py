"""Geocoding behind a replaceable interface (DEVELOPMENT.md §8).

A coordinate from a geocoder never proves where a job is; association is established first
(job_locations + evidence). This module only answers "how precisely does this address
resolve?". Only rooftop/street-number precision is usable for a map point; multiple distant
candidates or city/postal-level results stay unverified.

Every candidate must AGREE with the input address before it can become a map point: same house
number, same street (abbreviations and directions normalized), same city, and the same postal
area when both sides state one. A clear conflict rejects the candidate; an input that cannot be
checked (no house number, street or city) is never resolved to a point — it stays unverified.

Providers:
- none (default): nothing is geocoded; addresses stay unverified. Honest default while no
  production provider is chosen.
- nominatim: for LOW-VOLUME development only, per the OSMF usage policy (max 1 req/s, valid
  identifying User-Agent, caching, no bulk). Results are cached in `locations`
  (one row per normalized address, failures included), so an address is never re-asked
  within GEOCODER_RETRY_DAYS.
- fixed: deterministic table for tests.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Literal, Protocol
from urllib.parse import urlencode

import httpx

from app.core.config import get_settings
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.services.addresses import DIRECTIONS, STREET_RE, SUFFIXES, UNIT_RE

Status = Literal[
    "ok",
    "ambiguous",
    "low_precision",
    "mismatch",
    "unverifiable",
    "not_found",
    "error",
    "not_configured",
]
PRECISE = {"rooftop", "street"}
POSTAL_RE = re.compile(r"\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?\d[ABCEGHJ-NPRSTV-Z]\d\b")


@dataclass(frozen=True)
class GeocodeResult:
    status: Status
    provider: str
    lon: float | None = None
    lat: float | None = None
    precision: str = "unknown"
    detail: str | None = None


class Geocoder(Protocol):
    name: str

    def geocode(self, address: str, country_code: str | None = "ca") -> GeocodeResult: ...


class NullGeocoder:
    name = "none"

    def geocode(self, address: str, country_code: str | None = "ca") -> GeocodeResult:
        return GeocodeResult("not_configured", self.name, detail="GEOCODER_PROVIDER=none")


class FixedGeocoder:
    """Test double: {normalized-ish address substring: GeocodeResult}."""

    name = "fixed"

    def __init__(self, table: dict[str, GeocodeResult]):
        self.table = table

    def geocode(self, address: str, country_code: str | None = "ca") -> GeocodeResult:
        for key, result in self.table.items():
            if key.lower() in address.lower():
                return result
        return GeocodeResult("not_found", self.name)


# ------------------------------------------------------------- address agreement

PROVINCE_WORDS = {
    "on",
    "ont",
    "ontario",
    "canada",
    "ca",
    "qc",
    "quebec",
    "bc",
    "ab",
    "ny",
    "usa",
    "us",
}
# Nominatim address keys that can name the input's city (Toronto's former boroughs appear as
# city_district/suburb, e.g. "North York").
CITY_KEYS = ("city", "town", "village", "municipality", "city_district", "borough", "suburb",
             "hamlet", "county")  # fmt: skip
ROAD_KEYS = ("road", "pedestrian", "footway", "path", "square", "place", "residential")


@dataclass(frozen=True)
class AddressParts:
    house: str | None
    street: tuple[str, ...] | None  # normalized words, e.g. ("king", "st", "w")
    city: str | None
    fsa: str | None
    postal: str | None = None  # full postal code, no space ("L4K3S2")


def _norm_words(text: str) -> tuple[str, ...]:
    t = re.sub(r"[.,']", " ", text.lower())
    return tuple(SUFFIXES.get(w, DIRECTIONS.get(w, w)) for w in t.split())


def _is_noise(word: str) -> bool:
    """Province/country words and postal-code halves are not part of a city name."""
    return word.lower().strip(".") in PROVINCE_WORDS or bool(
        re.fullmatch(r"[A-Za-z]\d[A-Za-z]|\d[A-Za-z]\d|[A-Za-z]\d[A-Za-z]\d[A-Za-z]\d", word)
    )


def _full_postal(text: str) -> str | None:
    m = POSTAL_RE.search(text.upper())
    return m.group(0).replace(" ", "") if m else None


def parse_address(address: str) -> AddressParts:
    """House number, street, city and postal area as the input states them."""
    text = re.sub(r"\s+", " ", UNIT_RE.sub(" ", address)).strip(" ,")
    fsa_m = POSTAL_RE.search(text.upper())
    m = re.search(STREET_RE, text)
    if not m:
        return AddressParts(None, None, None, fsa_m.group(1) if fsa_m else None, _full_postal(text))
    house, _, street = m.group(0).partition(" ")
    city = None
    for part in text[m.end() :].split(","):
        words = [w for w in re.split(r"\s+", part.strip()) if w and not _is_noise(w)]
        if words and not re.fullmatch(r"\d[\w ]*", " ".join(words)):
            city = " ".join(words).lower()
            break
    return AddressParts(
        house.lower(),
        _norm_words(street),
        city,
        fsa_m.group(1) if fsa_m else None,
        _full_postal(text),
    )


def _house_matches(wanted: str, given: str) -> bool:
    """'55' matches '55', '55;57' and the range '51-59'."""
    for token in re.split(r"[;,]", given.lower()):
        token = token.strip()
        if token == wanted:
            return True
        rng = re.fullmatch(r"(\d+)\s*-\s*(\d+)", token)
        if rng and wanted.isdigit() and int(rng[1]) <= int(wanted) <= int(rng[2]):
            return True
    return False


def _street_matches(wanted: tuple[str, ...], given: str) -> bool:
    """Same name and street type; a direction the input omits may be added by the result,
    but a different direction ("King St E" vs "King St W") is a different street."""
    got = _norm_words(given)
    dirs = set(DIRECTIONS.values())
    if [w for w in wanted if w not in dirs] != [w for w in got if w not in dirs]:
        return False
    want_dir = [w for w in wanted if w in dirs]
    got_dir = [w for w in got if w in dirs]
    return not want_dir or want_dir == got_dir


def check_agreement(parts: AddressParts, candidate: dict) -> str | None:
    """None when the candidate agrees with the input; otherwise the reason it does not."""
    addr = candidate.get("address") or {}
    if not parts.house or not _house_matches(parts.house, str(addr.get("house_number", ""))):
        return f"house {addr.get('house_number')!r} != {parts.house!r}"
    road = next((addr[k] for k in ROAD_KEYS if addr.get(k)), None)
    if not parts.street or not road or not _street_matches(parts.street, road):
        return f"street {road!r} != {' '.join(parts.street or ())!r}"
    if parts.city:
        names = {str(addr[k]).lower() for k in CITY_KEYS if addr.get(k)}
        # whole-word containment: "new york" is named by "City of New York"
        same_postal = (
            bool(parts.postal)
            and str(addr.get("postcode") or "").upper().replace(" ", "") == parts.postal
        )
        # A community name inside a municipality ("Concord" in Vaughan) is not a conflict when
        # the full postal code matches exactly.
        if not same_postal and not any(
            re.search(rf"\b{re.escape(parts.city)}\b", n) for n in names
        ):
            return f"city {sorted(names)} lacks {parts.city!r}"
    postcode = str(addr.get("postcode") or "").upper().replace(" ", "")
    if parts.fsa and postcode and not postcode.startswith(parts.fsa):
        return f"postcode {postcode} not in {parts.fsa}"
    return None


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


class NominatimGeocoder:
    def __init__(self, client: SafeHttpClient, base_url: str, name: str = "nominatim"):
        self.client = client
        self.base_url = base_url.rstrip("/")
        self.name = name

    def geocode(self, address: str, country_code: str | None = "ca") -> GeocodeResult:
        # Unit/suite/floor confuse the geocoder and do not change the building.
        query = re.sub(r"\s+", " ", UNIT_RE.sub(" ", address)).strip(" ,")
        params = {"q": query, "format": "jsonv2", "addressdetails": 1, "limit": 5}
        if country_code:
            params["countrycodes"] = country_code
        try:
            resp = self.client.get(f"{self.base_url}/search?{urlencode(params)}")
        except (FetchError, UnsafeURLError, httpx.HTTPError) as exc:
            return GeocodeResult("error", self.name, detail=str(exc)[:200])
        if resp.status_code != 200:
            return GeocodeResult("error", self.name, detail=f"http {resp.status_code}")
        try:
            results = resp.json()
        except ValueError:
            return GeocodeResult("error", self.name, detail="not json")
        if not results:
            return GeocodeResult("not_found", self.name)
        precise = [r for r in results if (r.get("address") or {}).get("house_number")]
        if not precise:
            return GeocodeResult(
                "low_precision", self.name, detail=f"best={results[0].get('addresstype')}"
            )
        parts = parse_address(address)
        if not parts.house or not parts.street or not (parts.city or parts.fsa):
            # Without house number, street and a city/postal area a match cannot be checked.
            return GeocodeResult("unverifiable", self.name, detail="input lacks house/street/city")
        reasons = []
        agreeing = []
        for r in precise:
            why = check_agreement(parts, r)
            if why is None:
                agreeing.append(r)
            else:
                reasons.append(why)
        if not agreeing:
            return GeocodeResult("mismatch", self.name, detail="; ".join(reasons)[:300])
        precise = agreeing
        points = [(float(r["lon"]), float(r["lat"])) for r in precise]
        if any(distance_m(points[0], p) > 300 for p in points[1:]):
            return GeocodeResult("ambiguous", self.name, detail=f"{len(points)} distant matches")
        top = precise[0]
        precision = "rooftop" if top.get("addresstype") in ("building", "house") else "street"
        return GeocodeResult(
            "ok",
            self.name,
            lon=points[0][0],
            lat=points[0][1],
            precision=precision,
            detail=(top.get("display_name") or "")[:300],
        )


def build_geocoder(client: SafeHttpClient) -> Geocoder:
    s = get_settings()
    if s.geocoder_provider == "nominatim":
        if not s.geocoder_base_url:
            raise ValueError("GEOCODER_BASE_URL is required for nominatim")
        if s.geocoder_internal:
            # Self-hosted instance on a private network address. Its URL comes from operator
            # configuration, not from scraped data, so the SSRF guard (which rightly refuses
            # private addresses for untrusted URLs) is not applied to it.
            internal = httpx.Client(
                timeout=httpx.Timeout(s.http_timeout_seconds),
                headers={"User-Agent": s.http_user_agent},
                trust_env=False,
            )
            return NominatimGeocoder(internal, s.geocoder_base_url, name="nominatim-local")  # type: ignore[arg-type]
        return NominatimGeocoder(client, s.geocoder_base_url)
    return NullGeocoder()
