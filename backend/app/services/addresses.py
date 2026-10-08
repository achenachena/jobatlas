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
    r"Highway|Hwy\.?|Circle"
)
STREET_RE = (
    rf"\d{{1,6}}[A-Za-z]?\s+(?:[A-Z][\w'.-]*\s+){{1,4}}(?:{STREET_TYPES})"
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


@dataclass(frozen=True)
class ExtractedAddress:
    display: str
    excerpt: str


def normalize_address(text: str) -> str:
    """Key for de-duplicating/caching geocoding. Drops unit/suite/floor (same building)."""
    t = UNIT_RE.sub(" ", text.lower())
    t = re.sub(r"[.,]", " ", t)
    words = [SUFFIXES.get(w, DIRECTIONS.get(w, w)) for w in t.split()]
    return " ".join(words)


def extract_explicit_addresses(text: str | None) -> list[ExtractedAddress]:
    if not text:
        return []
    found: list[ExtractedAddress] = []
    seen: set[str] = set()
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
        found.append(ExtractedAddress(display=display, excerpt=excerpt[:400]))
    return found
