"""Address text helpers: normalization (cache key) and explicit-address extraction.

Extraction from free text only accepts a street address that the text itself ties to the
job ("our office is located at ...", "this role is based at ...", "Address: ..."). A street
address merely appearing somewhere in the description (e.g. a footer) is not associated
with the job and is ignored (DEVELOPMENT.md §8, rule 1).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

SUFFIXES = {
    "street": "st", "avenue": "ave", "road": "rd", "boulevard": "blvd", "drive": "dr",
    "lane": "ln", "court": "ct", "crescent": "cres", "parkway": "pkwy", "place": "pl",
    "square": "sq", "terrace": "terr", "highway": "hwy", "circle": "cir",
}  # fmt: skip
DIRECTIONS = {"west": "w", "east": "e", "north": "n", "south": "s"}
UNIT_RE = re.compile(r"\b(suite|ste\.?|unit|floor|fl\.?|#)\s*[\w-]+,?", re.I)
STREET_TYPES = (
    r"Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Way|Lane|Ln\.?|"
    r"Court|Ct\.?|Crescent|Cres\.?|Parkway|Pkwy\.?|Place|Pl\.?|Square|Sq\.?|Quay|Terrace|"
    r"Highway|Hwy\.?|Circle|Pike|Turnpike|Line|Sideroad|Side Road|Gate|Trail|Trl\.?|Mews|"
    r"Grove|Heights|Hts\.?|Path|Row|Close|Gardens|Gdns\.?|Plaza|Mall|Promenade|Esplanade|"
    r"Concession|Conc\.?"
)
STREET_RE = (
    rf"\d{{1,6}}[A-Za-z]?\s+(?:[A-Z][\w'.-]*\s+){{1,4}}(?:{STREET_TYPES})(?![A-Za-z])"
    r"(?:\s+(?:West|East|North|South|W|E|N|S)\b\.?)?"
)
CA_POSTAL_RE = r"[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d"
ANCHOR_RE = re.compile(
    r"(?:office\s+(?:is\s+)?(?:located\s+)?at|located\s+at|based\s+(?:out\s+of\s+|in\s+)?(?:our\s+)?"
    r"(?:\w+\s+)?(?:office\s+)?at|work(?:ing)?\s+(?:from|out\s+of)\s+our\s+(?:\w+\s+)?office\s+at|"
    r"address\s*:|in[- ]office\s+at|on[- ]site\s+at|report\s+to\s+(?:our\s+)?(?:\w+\s+)?"
    r"(?:office|location|site)\s+at)\s*",
    re.I,
)
FULL_ADDRESS_RE = re.compile(
    rf"(?P<street>{STREET_RE})"
    r"(?P<rest>(?:,?\s*(?:Suite|Ste\.?|Unit|Floor|Fl\.?|#)\s*[\w-]+)?"
    r"(?:,?\s*(?!Ontario\b)[A-Z][a-z][A-Za-z.'-]*(?:\s+[A-Z][a-z][A-Za-z.'-]*){0,2})?"  # city
    r"(?:,?\s*(?:ON|Ontario))?"
    rf"(?:,?\s*{CA_POSTAL_RE})?)",
)


# Field-style statements: "Work Location: Metro Hall, 55 John St., Toronto, ON".
FIELD_RE = re.compile(
    r"\b(?:work(?:\s+site)?|job|primary|office|site|position)?\s*locations?\s*:\s*", re.I
)
FIELD_END_RE = re.compile(
    r"\n|\s(?:Job Type|Salary|Shift|Hours|Department|Division|Reports? To|Employment|"
    r"Posting|Job ID|Closing|Number of Positions|Affiliation)\b",
    re.I,
)


@dataclass(frozen=True)
class ExtractedAddress:
    display: str
    excerpt: str
    has_city: bool = True


def normalize_address(text: str) -> str:
    """Key for de-duplicating/caching geocoding. Drops unit/suite/floor (same building)."""
    t = UNIT_RE.sub(" ", text.lower())
    t = re.sub(r"[.,]", " ", t)
    words = [SUFFIXES.get(w, DIRECTIONS.get(w, w)) for w in t.split()]
    return " ".join(words)


def _has_city(display: str) -> bool:
    from app.services.region_match import match_location_text

    street = re.match(STREET_RE, display)
    rest = display[street.end() :] if street else display
    return (
        bool(re.search(CA_POSTAL_RE, display))
        or match_location_text(rest) is not None
        or bool(
            re.search(r",\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s*(?:,|\s+ON\b|\s+Ontario\b|$)", rest)
        )
    )


def _field_addresses(text: str, seen: set[str]) -> list[ExtractedAddress]:
    found = []
    for field in FIELD_RE.finditer(text):
        rest = text[field.end() : field.end() + 220]
        end = FIELD_END_RE.search(rest)
        segment = rest[: end.start()] if end else rest
        for m in FULL_ADDRESS_RE.finditer(segment):
            display = re.sub(r"\s+", " ", m.group(0)).strip(" ,.")
            key = normalize_address(display)
            if key in seen:
                continue
            seen.add(key)
            excerpt = re.sub(r"\s+", " ", text[field.start() : field.end() + len(segment)])
            found.append(ExtractedAddress(display, excerpt.strip()[:400], _has_city(display)))
    return found


def extract_explicit_addresses(text: str | None) -> list[ExtractedAddress]:
    if not text:
        return []
    seen: set[str] = set()
    found: list[ExtractedAddress] = _field_addresses(text, seen)
    for anchor in ANCHOR_RE.finditer(text):
        window = text[anchor.end() : anchor.end() + 160]
        m = FULL_ADDRESS_RE.match(window.lstrip(" \t:-"))
        if not m:
            continue
        display = re.sub(r"\s+", " ", m.group(0)).strip(" ,.")
        key = normalize_address(display)
        if key in seen:
            continue
        seen.add(key)
        start = max(0, anchor.start() - 60)
        excerpt = re.sub(r"\s+", " ", text[start : anchor.end() + len(m.group(0)) + 5]).strip()
        found.append(ExtractedAddress(display, excerpt[:400], _has_city(display)))
    return found
