"""Canonical job URLs for cross-source de-duplication (DEVELOPMENT.md §7.1).

Only parameters that are unambiguously tracking are removed; anything else may identify the
job (gh_jid, id, req...) and is kept.
"""

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TRACKING_PREFIXES = ("utm_",)
TRACKING_PARAMS = {
    "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "igshid", "yclid",
    "dclid", "li_fat_id", "gh_src", "lever-source", "lever-origin",
}  # fmt: skip


def canonical_job_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        p = urlsplit(url.strip())
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.hostname:
        return None
    query = [
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not k.lower().startswith(TRACKING_PREFIXES) and k.lower() not in TRACKING_PARAMS
    ]
    host = p.hostname.lower()
    if p.port and p.port not in (80, 443):
        host = f"{host}:{p.port}"
    path = p.path.rstrip("/") or "/"
    return urlunsplit(("https", host, path, urlencode(sorted(query)), ""))
