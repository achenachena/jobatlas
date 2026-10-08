"""Helpers to turn untrusted provider HTML into plain text (we never render source HTML)."""

import html
import re
from html.parser import HTMLParser

_BLOCK_TAGS = {"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr"}
_SKIP_TAGS = {"script", "style", "noscript", "template"}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._skip += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS and self._skip:
            self._skip -= 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(value: str | None, *, already_escaped: bool = False) -> str | None:
    if not value:
        return None
    if already_escaped:
        value = html.unescape(value)
    parser = _TextExtractor()
    parser.feed(value)
    parser.close()
    text = "".join(parser.parts).replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip() or None


_REMOTE_RE = re.compile(r"\bremote\b", re.I)
_HYBRID_RE = re.compile(r"\bhybrid\b", re.I)
_ONSITE_RE = re.compile(r"\b(on[- ]?site|in[- ]office)\b", re.I)


_QUALIFIER_SEGMENTS = {
    "canada",
    "ca",
    "usa",
    "us",
    "u.s.",
    "united states",
    "ontario",
    "on",
    "north america",
    "americas",
    "emea",
    "global",
    "worldwide",
    "anywhere",
}


def workplace_from_location_label(label: str | None) -> tuple[str, str | None]:
    """Only an explicit word in the source's own location label counts; otherwise unknown
    (rule 5: never default to On-site).

    Conflicting words, or a label mixing remote and non-remote places
    (e.g. "Toronto, Remote in Canada"), stay unknown.
    """
    if not label:
        return "unknown", None
    hits = [
        kind
        for kind, rx in (("remote", _REMOTE_RE), ("hybrid", _HYBRID_RE), ("on_site", _ONSITE_RE))
        if rx.search(label)
    ]
    if len(hits) != 1:
        return "unknown", None
    kind = hits[0]
    if kind == "remote":
        outside_parens = re.sub(r"\([^)]*\)", " ", label)
        segments = [seg.strip().lower() for seg in re.split(r"[,;/|]", outside_parens)]
        segments = [seg for seg in segments if re.search(r"[a-z]", seg)]
        if any(not _REMOTE_RE.search(seg) and seg not in _QUALIFIER_SEGMENTS for seg in segments):
            return "unknown", None
    return kind, f"location label: {label!r}"
