"""Text-only region semantics.

- match_location_text(): the most specific region a job's location *label* names
  (a GTA municipality, the GTA, a province, a country). Used for coarse grouping only; it
  never produces coordinates (rule 2).
- parse_eligibility(): which regions a REMOTE job says applicants may live in, with
  exclusions. "Remote" alone is eligibility *unknown*, never worldwide (DEVELOPMENT.md §4.2).
- covers(): does an eligibility set make a job applicable to a target region?

Region ids match the `regions` table (migrations 0002/0003). Several GTA municipality names
also exist elsewhere (Milton MA, Aurora IL, Burlington VT, Richmond Hill GA, Newmarket NH...);
those only match with an Ontario/Canada qualifier.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Parent links for region ids used here (mirror of the regions table, kept small and static).
PARENT: dict[str, str | None] = {
    "worldwide": None,
    "north-america": "worldwide",
    "us": "north-america",
    "ca": "north-america",
    "ca-on": "ca",
    "gta": "ca-on",
}
MUNICIPALITIES = [
    "toronto", "mississauga", "brampton", "caledon", "oakville", "burlington", "milton",
    "halton-hills", "vaughan", "markham", "richmond-hill", "newmarket", "aurora", "pickering",
    "ajax", "whitby", "oshawa", "clarington",
]  # fmt: skip
PROVINCES = {
    "ca-ab": ["alberta", "ab"],
    "ca-bc": ["british columbia", "bc"],
    "ca-mb": ["manitoba", "mb"],
    "ca-nb": ["new brunswick", "nb"],
    "ca-nl": ["newfoundland and labrador", "newfoundland", "nl"],
    "ca-ns": ["nova scotia", "ns"],
    "ca-nt": ["northwest territories", "nt"],
    "ca-nu": ["nunavut", "nu"],
    "ca-pe": ["prince edward island", "pei", "pe"],
    "ca-qc": ["quebec", "québec", "qc"],
    "ca-sk": ["saskatchewan", "sk"],
    "ca-yt": ["yukon", "yt"],
    "ca-on": ["ontario", "on"],
}
for _m in MUNICIPALITIES:
    PARENT[_m] = "gta"
for _p in PROVINCES:
    PARENT.setdefault(_p, "ca")

# Alias -> municipality id. Toronto districts map to toronto.
MUNICIPALITY_ALIASES_UNAMBIGUOUS = {
    "toronto": "toronto", "north york": "toronto", "scarborough": "toronto",
    "etobicoke": "toronto", "east york": "toronto", "mississauga": "mississauga",
    "brampton": "brampton", "caledon": "caledon", "oakville": "oakville", "vaughan": "vaughan",
    "concord, on": "vaughan", "woodbridge, on": "vaughan", "markham": "markham",
    "pickering": "pickering", "whitby": "whitby", "oshawa": "oshawa",
    "clarington": "clarington", "bowmanville": "clarington", "halton hills": "halton-hills",
    "georgetown, on": "halton-hills", "thornhill": "vaughan",
}  # fmt: skip
MUNICIPALITY_ALIASES_QUALIFIED = {
    "milton": "milton", "burlington": "burlington", "ajax": "ajax", "aurora": "aurora",
    "newmarket": "newmarket", "richmond hill": "richmond-hill",
}  # fmt: skip
GTA_ALIASES = ["greater toronto area", "york region", "durham region", "halton region",
               "peel region"]  # fmt: skip
COUNTRY_ALIASES = {
    "ca": ["canada", "canadian"],
    "us": ["united states", "usa", "u.s.a.", "u.s.", "us"],
}
WIDE_ALIASES = {
    "worldwide": ["worldwide", "anywhere", "global", "globally", "any location"],
    "north-america": ["north america", "americas", "namer", "amer"],
}
EXCLUSION_RE = re.compile(
    r"\b(?:excluding|except(?: for)?|not (?:available|eligible|open) (?:in|to)|"
    r"outside of|no candidates from)\b([^;.)\n]*)",
    re.I,
)


@dataclass(frozen=True)
class RegionMatch:
    region_id: str
    term: str


def _has(text: str, term: str) -> bool:
    return re.search(rf"(?<![a-z]){re.escape(term)}(?![a-z])", text) is not None


def _has_abbrev(label: str, abbrev: str) -> bool:
    # Two-letter codes only count as ", ON" style suffixes or standalone uppercase tokens.
    return re.search(rf"(?:,\s*|\(|\b){abbrev.upper()}\b", label) is not None


def _qualified(text: str, label: str) -> bool:
    return _has(text, "ontario") or _has(text, "canada") or _has_abbrev(label, "on")


def ancestors(region_id: str) -> list[str]:
    out = []
    cur: str | None = region_id
    while cur is not None:
        out.append(cur)
        cur = PARENT.get(cur)
    return out


def is_within(region_id: str | None, target: str) -> bool:
    return region_id is not None and target in ancestors(region_id)


def match_location_text(label: str | None) -> RegionMatch | None:
    if not label:
        return None
    text = label.lower()
    for alias in GTA_ALIASES:  # before municipalities: "Greater Toronto Area" is not Toronto
        if _has(text, alias):
            return RegionMatch("gta", alias)
    for alias in sorted(MUNICIPALITY_ALIASES_UNAMBIGUOUS, key=len, reverse=True):
        if _has(text, alias):
            return RegionMatch(MUNICIPALITY_ALIASES_UNAMBIGUOUS[alias], alias)
    if _qualified(text, label):
        for alias, rid in MUNICIPALITY_ALIASES_QUALIFIED.items():
            if _has(text, alias):
                return RegionMatch(rid, alias)
    if re.search(r"\bGTA\b", label):
        return RegionMatch("gta", "GTA")
    for rid, aliases in PROVINCES.items():
        for alias in aliases:
            if len(alias) == 2:
                if _has_abbrev(label, alias):
                    return RegionMatch(rid, alias)
            elif _has(text, alias):
                return RegionMatch(rid, alias)
    if _has(text, "canada"):
        return RegionMatch("ca", "canada")
    return None


@dataclass
class Eligibility:
    includes: set[str] = field(default_factory=set)
    excludes: set[str] = field(default_factory=set)
    evidence: list[str] = field(default_factory=list)

    @property
    def known(self) -> bool:
        return bool(self.includes)


def _regions_in(fragment: str) -> set[str]:
    text = fragment.lower()
    found: set[str] = set()
    for rid, aliases in WIDE_ALIASES.items():
        if any(_has(text, a) for a in aliases):
            found.add(rid)
    for rid, aliases in COUNTRY_ALIASES.items():
        for a in aliases:
            if a == "us":
                if re.search(r"(?<![A-Za-z])US(?![A-Za-z])", fragment):
                    found.add(rid)
            elif _has(text, a):
                found.add(rid)
    for rid, aliases in PROVINCES.items():
        for a in aliases:
            if (len(a) == 2 and _has_abbrev(fragment, a)) or (len(a) > 2 and _has(text, a)):
                found.add(rid)
    m = match_location_text(fragment)
    if m and is_within(m.region_id, "gta"):
        found.add(m.region_id)
    return found


def parse_eligibility(texts: list[str | None]) -> Eligibility:
    """Collect explicitly named applicant regions from a remote job's own labels."""
    result = Eligibility()
    for raw in texts:
        if not raw:
            continue
        excluded_spans = []
        for m in EXCLUSION_RE.finditer(raw):
            regions = _regions_in(m.group(1))
            if regions:
                result.excludes |= regions
                excluded_spans.append(m.span())
        remaining = raw
        for start, end in reversed(excluded_spans):
            remaining = remaining[:start] + " " + remaining[end:]
        regions = _regions_in(remaining)
        if regions or excluded_spans:
            result.includes |= regions
            result.evidence.append(raw)
    result.includes -= result.excludes
    return result


def covers(includes: set[str], excludes: set[str], target: str) -> bool:
    """A remote job applies to `target` when some included region is the target, an ancestor
    (Canada covers the GTA) or a descendant (Toronto-only remote is still a GTA job), and no
    exclusion is the target or one of its ancestors."""
    target_chain = set(ancestors(target))
    if excludes & target_chain:
        return False
    return any(inc in target_chain or is_within(inc, target) for inc in includes)


def is_target_relevant(
    label: str | None, workplace_type: str, eligibility: Eligibility | None = None
) -> bool:
    """Ingest filter (DEVELOPMENT.md §6.2 step 6): GTA work sites, plus remote jobs explicitly
    open to the GTA. An on-site job elsewhere in Canada is not a GTA job."""
    match = match_location_text(label)
    if match is not None and is_within(match.region_id, "gta"):
        return True
    if workplace_type == "remote":
        elig = eligibility if eligibility is not None else parse_eligibility([label])
        return covers(elig.includes, elig.excludes, "gta")
    return False
