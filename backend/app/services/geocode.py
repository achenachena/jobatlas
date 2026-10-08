"""Geocoding behind a replaceable interface (DEVELOPMENT.md §8).

A coordinate from a geocoder never proves where a job is; association is established first
(job_locations + evidence). This module only answers "how precisely does this address
resolve?". Only rooftop/street-number precision is usable for a map point; multiple distant
candidates or city/postal-level results stay unverified.

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
from dataclasses import dataclass
from typing import Literal, Protocol
from urllib.parse import urlencode

from app.core.config import get_settings
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError

Status = Literal["ok", "ambiguous", "low_precision", "not_found", "error", "not_configured"]
PRECISE = {"rooftop", "street"}


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


def _distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


class NominatimGeocoder:
    name = "nominatim"

    def __init__(self, client: SafeHttpClient, base_url: str):
        self.client = client
        self.base_url = base_url.rstrip("/")

    def geocode(self, address: str, country_code: str | None = "ca") -> GeocodeResult:
        params = {"q": address, "format": "jsonv2", "addressdetails": 1, "limit": 3}
        if country_code:
            params["countrycodes"] = country_code
        try:
            resp = self.client.get(f"{self.base_url}/search?{urlencode(params)}")
        except (FetchError, UnsafeURLError) as exc:
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
        points = [(float(r["lon"]), float(r["lat"])) for r in precise]
        if any(_distance_m(points[0], p) > 300 for p in points[1:]):
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
        return NominatimGeocoder(client, s.geocoder_base_url)
    return NullGeocoder()
