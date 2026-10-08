"""URL recognizers for providers whose full adapters land in stage 2 (Ashby, Lever).

Recognizing a tenant lets discovery record it now; candidates for providers without a
fetch adapter are parked as `deferred` with reason `adapter_not_implemented`, never dropped.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from app.providers.base import SourceCandidate

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class _RecognizeOnly:
    name: str
    supports_fetch = False

    def board_info(self, *args: Any, **kwargs: Any):
        raise NotImplementedError(f"{self.name} adapter lands in stage 2")

    fetch_jobs = normalize = verify_job = board_info


class AshbyRecognizer(_RecognizeOnly):
    name = "ashby"
    HOST = "jobs.ashbyhq.com"
    RESERVED = {
        "api",
        "b",
        "meeting",
        "embed",
        "static",
        "robots.txt",
        "favicon.ico",
        "sitemap.xml",
    }

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            parts = urlsplit(url)
        except ValueError:
            return None
        if (parts.hostname or "").lower() != self.HOST:
            return None
        segments = [s for s in parts.path.split("/") if s]
        if not segments:
            return None
        org = unquote(segments[0]).strip()
        if not org or org.lower() in self.RESERVED or len(org) > 100 or UUID_RE.match(org):
            return None
        key = org.lower()
        return SourceCandidate(self.name, key, f"https://{self.HOST}/{quote(key)}")


class LeverRecognizer(_RecognizeOnly):
    name = "lever"
    HOSTS = {"jobs.lever.co": "", "jobs.eu.lever.co": "eu:"}
    SITE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            parts = urlsplit(url)
        except ValueError:
            return None
        host = (parts.hostname or "").lower()
        if host not in self.HOSTS:
            return None
        segments = [s for s in parts.path.split("/") if s]
        if not segments:
            return None
        site = unquote(segments[0]).lower()
        if not self.SITE_RE.match(site) or site in {"robots.txt", "favicon.ico"}:
            return None
        return SourceCandidate(self.name, self.HOSTS[host] + site, f"https://{host}/{site}")
