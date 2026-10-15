"""Standard city entities and matching (spec §4.4).

Anchors: GeoNames populated places for Canada (CC BY 4.0, attribution "GeoNames"), class P
only, excluding sections of cities, historical, abandoned and destroyed places. One layer of
populated places; metros and economic regions are never mixed in. A record's city is matched
by (province, normalized name or alias); several places with the same name in one province
resolve to the most populous one, which is recorded as the rule. An anchor is a statistics
symbol position, never a work address.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.atlas.models import AtlasCity

GEONAMES_ATTRIBUTION = "City locations: GeoNames (geonames.org), CC BY 4.0."
# GeoNames admin1 codes for Canada -> postal abbreviation
ADMIN1 = {"01": "AB", "02": "BC", "03": "MB", "04": "NB", "05": "NL", "07": "NS", "08": "ON",
          "09": "PE", "10": "QC", "11": "SK", "12": "YT", "13": "NT", "14": "NU"}  # fmt: skip
PROVINCE_NAMES = {
    "alberta": "AB", "british columbia": "BC", "colombie-britannique": "BC", "manitoba": "MB",
    "new brunswick": "NB", "nouveau-brunswick": "NB", "newfoundland and labrador": "NL",
    "terre-neuve-et-labrador": "NL", "nova scotia": "NS", "nouvelle-ecosse": "NS",
    "ontario": "ON", "prince edward island": "PE", "ile-du-prince-edouard": "PE", "quebec": "QC",
    "saskatchewan": "SK", "yukon": "YT", "northwest territories": "NT",
    "territoires du nord-ouest": "NT", "nunavut": "NU",
}  # fmt: skip
PROVINCE_CODES = set(ADMIN1.values())
# Former municipalities amalgamated into today's city (same legal municipality, so the same
# city entity — not a metro or region). GeoNames tags them as sections of the city, which are
# not separate places here. Toronto 1998; Ottawa 2001; Hamilton 2001; Greater Sudbury 2001;
# Montréal 2002/2006 boroughs; Longueuil 2002; Québec 2002; Saguenay 2002.
AMALGAMATED = {
    ("ON", "Toronto"): ("north york", "scarborough", "etobicoke", "east york", "york"),
    ("ON", "Ottawa"): ("orleans", "orleans south", "nepean", "kanata", "gloucester", "vanier",
                       "manotick", "barrhaven", "stittsville", "cumberland"),
    ("ON", "Hamilton"): ("stoney creek", "ancaster", "dundas", "flamborough", "glanbrook",
                         "waterdown"),
    ("ON", "Greater Sudbury"): ("val caron", "valley east", "lively", "capreol", "chelmsford"),
    ("QC", "Montréal"): ("saint laurent", "saint leonard", "verdun", "outremont", "lasalle",
                         "lachine", "anjou", "montreal nord", "pierrefonds", "roxboro",
                         "rosemont", "riviere des prairies", "pointe aux trembles",
                         "ile bizard", "ahuntsic"),
    ("QC", "Longueuil"): ("saint hubert", "greenfield park"),
    ("QC", "Québec"): ("sainte foy", "beauport", "charlesbourg", "sillery", "cap rouge",
                       "val belair", "loretteville"),
    ("QC", "Saguenay"): ("chicoutimi", "jonquiere", "la baie", "laterriere"),
}  # fmt: skip
# Cities that straddle a provincial border: one entity, wherever GeoNames placed it.
BORDER_CITIES = {"lloydminster": ("AB", "SK")}
PLACE_CODES = {"PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLC", "PPLL", "PPLS", "PPLF", "PPLG"}


def fold(text: str) -> str:
    t = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in t if not unicodedata.combining(ch)).lower()


def city_key(name: str) -> str:
    """'St. John's' == 'Saint John's', 'Montréal' == 'Montreal', 'Sainte-Foy' == 'Ste Foy'."""
    t = fold(name).replace("’", "'")
    t = re.sub(r"[-–_/.,()]", " ", t)
    t = re.sub(r"\bste\b", "sainte", t)
    t = re.sub(r"\bst\b", "saint", t)
    t = re.sub(r"\bmt\b", "mount", t)
    return re.sub(r"\s+", " ", t).strip()


def province_code(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip()
    if v.upper() in PROVINCE_CODES:
        return v.upper()
    return PROVINCE_NAMES.get(fold(v).replace("–", "-").strip())


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", fold(text)).strip("-")


@dataclass
class GeoPlace:
    geonameid: int
    name: str
    ascii_name: str
    aliases: list[str]
    lat: float
    lon: float
    province: str
    population: int
    feature_code: str


def parse_geonames(lines: Iterable[str]) -> list[GeoPlace]:
    out = []
    for line in lines:
        f = line.rstrip("\n").split("\t")
        if len(f) < 15 or f[6] != "P" or f[7] not in PLACE_CODES or f[8] != "CA":
            continue
        prov = ADMIN1.get(f[10])
        if prov is None:
            continue
        alts = [a for a in f[3].split(",") if a and re.fullmatch(r"[\w .'’()-]+", a)
                and not a.isupper() and len(a) <= 60]  # fmt: skip
        out.append(GeoPlace(int(f[0]), f[1], f[2], alts[:25], float(f[4]), float(f[5]), prov,
                            int(f[14] or 0), f[7]))  # fmt: skip
    return out


def load_places(session: Session, places: list[GeoPlace]) -> int:
    """Upsert places as atlas_cities. The most populous place of a (province, name) gets the
    plain id ("ca-on-richmond-hill"); others get the GeoNames id appended."""
    taken: set[str] = set(session.scalars(select(AtlasCity.id)))
    by_geonameid = dict(session.execute(select(AtlasCity.geonameid, AtlasCity.id)).all())
    rows = []
    for p in sorted(places, key=lambda p: -p.population):
        cid = by_geonameid.get(p.geonameid)
        if cid is None:
            cid = f"ca-{p.province.lower()}-{slug(p.ascii_name) or p.geonameid}"
            if cid in taken:
                cid = f"{cid}-{p.geonameid}"
            taken.add(cid)
        rows.append({
            "id": cid, "country": "CA", "province": p.province, "name": p.name,
            "ascii_name": p.ascii_name, "aliases": p.aliases, "kind": "city",
            "population": p.population, "lat": p.lat, "lon": p.lon, "geonameid": p.geonameid,
            "evidence": f"GeoNames {p.geonameid} ({p.feature_code}), CC BY 4.0",
        })  # fmt: skip
    for i in range(0, len(rows), 2000):
        chunk = rows[i : i + 2000]
        stmt = insert(AtlasCity).values(chunk)
        session.execute(stmt.on_conflict_do_update(
            index_elements=["id"],
            set_={k: getattr(stmt.excluded, k) for k in
                  ("name", "ascii_name", "aliases", "population", "lat", "lon", "evidence")},
        ))  # fmt: skip
    session.flush()
    return len(rows)


@dataclass
class CityIndex:
    """(province, key) -> [(population, city_id)] built once per import."""

    entries: dict[tuple[str, str], list[tuple[int, str]]] = field(default_factory=dict)

    @classmethod
    def build(cls, session: Session) -> CityIndex:
        idx = cls()
        for cid, prov, name, ascii_name, aliases, pop in session.execute(
            select(AtlasCity.id, AtlasCity.province, AtlasCity.name, AtlasCity.ascii_name,
                   AtlasCity.aliases, AtlasCity.population)
        ):  # fmt: skip
            for n in {name, ascii_name, *(aliases or [])}:
                idx.entries.setdefault((prov, city_key(n)), []).append((pop or 0, cid))
        for v in idx.entries.values():
            v.sort(reverse=True)
        return idx

    def match(self, province: str | None, city: str | None) -> tuple[str | None, str]:
        if not province or not city or city.strip().upper() in ("NA", "N/A", ""):
            return None, "no city in record"
        key = city_key(city)
        # Amalgamated former municipalities first: GeoNames may also list e.g. "Etobicoke" as
        # a place of its own, but it is part of the City of Toronto.
        for (prov, parent), parts in AMALGAMATED.items():
            if prov == province and key in parts:
                parent_hits = self.entries.get((prov, city_key(parent)))
                if parent_hits:
                    return parent_hits[0][1], f"'{city}' is part of {parent} (amalgamated)"
        hits = self.entries.get((province, key))
        if not hits:
            for prov in BORDER_CITIES.get(key, ()):
                hits = self.entries.get((prov, key))
                if hits:
                    return hits[0][1], f"'{city}' straddles a border; entity in {prov}"
            return None, f"'{city}' not found in {province}"
        rule = "" if len(hits) == 1 else f" (most populous of {len(hits)} same-named places)"
        return hits[0][1], f"'{city}', {province} -> {hits[0][1]}{rule}"
