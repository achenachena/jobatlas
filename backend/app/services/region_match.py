"""Coarse, text-only relevance check: does a job's location label refer to the GTA, Ontario
or Canada?

This only decides whether a record from a global board is worth ingesting for the GTA
product. It never produces coordinates and never asserts remote eligibility: those need
evidence (stage 2, DEVELOPMENT.md §4 and §8).

Several GTA municipality names also exist elsewhere (Milton MA, Aurora IL, Burlington VT,
Richmond Hill GA, Newmarket NH...). Those only match with an Ontario/Canada qualifier.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Toronto + the four regional municipalities (Durham, Halton, Peel, York) and their
# lower-tier municipalities, plus common Toronto district names used in job labels.
GTA_UNAMBIGUOUS = {
    "toronto",
    "mississauga",
    "brampton",
    "markham",
    "vaughan",
    "oakville",
    "pickering",
    "oshawa",
    "whitby",
    "clarington",
    "caledon",
    "etobicoke",
    "scarborough",
    "north york",
    "east york",
    "york region",
    "durham region",
    "halton region",
    "peel region",
    "whitchurch-stouffville",
    "stouffville",
    "east gwillimbury",
    "halton hills",
    "georgina",
    "uxbridge",
    "scugog",
    "concord, on",
    "woodbridge, on",
    "thornhill",
    "bolton, on",
    "greater toronto area",
    "gta",
}
GTA_NEEDS_QUALIFIER = {
    "milton",
    "burlington",
    "ajax",
    "aurora",
    "newmarket",
    "richmond hill",
    "king city",
    "brock",
    "king",
}


@dataclass(frozen=True)
class RegionMatch:
    region_id: str  # gta | ca-on | ca
    term: str


def _has_term(text: str, term: str) -> bool:
    return re.search(rf"(?<![a-z]){re.escape(term)}(?![a-z])", text) is not None


def _qualified(text: str) -> bool:
    # ", ON" / "Ontario" / "Canada" anywhere in the label.
    return (
        _has_term(text, "ontario")
        or _has_term(text, "canada")
        or re.search(r",\s*on\b", text) is not None
    )


def match_location_text(label: str | None) -> RegionMatch | None:
    if not label:
        return None
    text = label.lower()
    for term in sorted(GTA_UNAMBIGUOUS, key=len, reverse=True):
        if term == "gta":
            if re.search(r"\bGTA\b", label):
                return RegionMatch("gta", term)
            continue
        if _has_term(text, term):
            return RegionMatch("gta", term)
    if _qualified(text):
        for term in GTA_NEEDS_QUALIFIER:
            if _has_term(text, term):
                return RegionMatch("gta", term)
        if _has_term(text, "ontario") or re.search(r",\s*on\b", text):
            return RegionMatch("ca-on", "ontario")
        return RegionMatch("ca", "canada")
    return None


def is_target_relevant(label: str | None, workplace_type: str) -> bool:
    """Ingest filter (DEVELOPMENT.md §6.2 step 6): GTA work sites, plus remote jobs whose label
    names Ontario/Canada. An on-site job elsewhere in Canada is not a GTA job. Whether a remote
    job is actually open to GTA residents is decided later from eligibility evidence."""
    match = match_location_text(label)
    if match is None:
        return False
    return match.region_id == "gta" or workplace_type == "remote"
