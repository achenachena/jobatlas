"""Formal occupation classification for v2 statistics (spec §6). Server-side only; the v1
front-end `occupationFor` is decoration and is not used here.

Order of evidence:
  1. a trusted occupation code (NOC 2021) that maps to exactly one occupation;
  2. explicit title rules (English and French) when the code is missing or does not map;
  3. anything ambiguous -> "unclassified" (never forced).
Policies: recruiters / talent acquisition are Human resources (NOC 12101 "Human resources
and recruitment officers" includes them). A barback is not a bartender. A barista is never a
bartender and vice versa. The employer's industry is never used.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

CLASSIFICATION_VERSION = "2026.10.1"


@dataclass(frozen=True)
class Occupation:
    id: str
    label: str
    noc21: tuple[str, ...]
    title_patterns: tuple[str, ...]
    note: str


OCCUPATIONS: tuple[Occupation, ...] = (
    Occupation(
        "software_development",
        "Software development",
        ("21230", "21231", "21232", "21234"),
        (
            r"\bsoftware (?:engineer|developer|development engineer|programmer)\b",
            r"\b(?:full[- ]?stack|back[- ]?end|front[- ]?end|web|mobile|ios|android) "
            r"(?:software )?(?:developer|engineer)\b",
            r"\bsde(?: ?(?:i{1,3}|[1-3]))?\b",
            r"\bprogrammer\b",
            r"\bdeveloppeu(?:r|se) (?:logiciel|web|d'applications|full[- ]?stack)\b",
            r"\bprogrammeu(?:r|se)\b",
            r"\bingenieu(?:r|e) logiciel\b",
        ),
        "NOC 21230/21231/21232/21234 (computer systems / software / web developers)",
    ),  # fmt: skip
    Occupation(
        "human_resources",
        "Human resources",
        ("10011", "11200", "12101"),
        (
            r"\bhuman resources?\b",
            r"\bhr (?:generalist|specialist|advisor|adviser|manager|"
            r"business partner|coordinator|assistant|officer|administrator|director)\b",
            r"\brecruiter\b",
            r"\btalent acquisition\b",
            r"\bressources humaines\b",
            r"\brecruteu(?:r|se)\b",
            r"\bconseill(?:er|ere) en recrutement\b",
        ),
        "NOC 10011/11200/12101; recruiters included",
    ),  # fmt: skip
    Occupation(
        "bartender",
        "Bartender",
        ("64301",),
        (r"\bbartenders?\b", r"\bbarm(?:a|e)n\b", r"\bbarmaid\b", r"\bmixologist\b"),
        "NOC 64301 Bartenders; barbacks excluded",
    ),
    Occupation(
        "barista",
        "Barista",
        (),
        (r"\bbaristas?\b",),
        "No NOC of its own (inside 65201): identified by title",
    ),
    Occupation(
        "registered_nurse",
        "Registered nurse",
        ("31301",),
        (
            r"\bregistered nurse\b",
            r"\binfirmi(?:er|ere) autorise",
        ),
        "NOC 31301 Registered nurses and registered psychiatric nurses",
    ),
    Occupation(
        "cook",
        "Cook",
        ("63200",),
        (r"\bline cook\b", r"\bprep cook\b", r"\bcuisini(?:er|ere)\b"),
        "NOC 63200 Cooks",
    ),
)
BY_ID = {o.id: o for o in OCCUPATIONS}
PUBLIC_IDS = ("all", *BY_ID)
# Titles that look like an occupation but are explicitly something else.
EXCLUDE = {
    "bartender": (r"\bbar ?backs?\b", r"\bbarista\b"),
    "barista": (r"\bbartender\b", r"\bbar ?backs?\b"),
}


def normalize_title(title: str | None) -> str:
    if not title:
        return ""
    t = unicodedata.normalize("NFKD", title)
    t = "".join(ch for ch in t if not unicodedata.combining(ch)).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9'+#/ -]", " ", t)).strip()


def _title_matches(occ: Occupation, title: str) -> bool:
    if any(re.search(rx, title) for rx in EXCLUDE.get(occ.id, ())):
        return False
    return any(re.search(rx, title) for rx in occ.title_patterns)


def classify(noc21: str | None, title: str | None) -> tuple[str, str]:
    """(occupation_id, evidence). occupation_id is an OCCUPATIONS id or "unclassified"."""
    t = normalize_title(title)
    if re.search(r"\bbar ?backs?\b", t):
        return "unclassified", "title names a barback (not a bartender)"
    if any(re.search(rx, t) for rx in BY_ID["barista"].title_patterns):
        if re.search(r"\bbartender\b", t):
            return "unclassified", "title names both barista and bartender"
        return "barista", f"title rule: '{title}'"
    code = (noc21 or "").strip()
    by_code = [o for o in OCCUPATIONS if code and code in o.noc21]
    if len(by_code) == 1:
        return by_code[0].id, f"NOC 2021 {code}"
    by_title = [o for o in OCCUPATIONS if o.title_patterns and _title_matches(o, t)]
    if len(by_title) == 1:
        unmapped = f" (NOC {code} unmapped)" if code else ""
        return by_title[0].id, f"title rule: '{title}'{unmapped}"
    if len(by_title) > 1:
        return "unclassified", f"title matches several occupations: {[o.id for o in by_title]}"
    return "unclassified", "no occupation rule matched" if t else "empty title"
