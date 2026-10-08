"""robots.txt checks for generic sites (company careers pages, office pages).

ATS APIs are covered by their documented terms (SOURCES.md); arbitrary company sites are not,
so every fetch there must be allowed by robots.txt. Unreachable or erroring robots.txt means
"do not fetch" (conservative); a 404 robots.txt means no restrictions, per the standard.
"""

from __future__ import annotations

import time
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError

AGENT = "JobAtlasBot"
TTL_SECONDS = 6 * 3600


class RobotsCache:
    def __init__(self, client: SafeHttpClient):
        self.client = client
        self._cache: dict[str, tuple[float, RobotFileParser | None, bool]] = {}

    def _load(self, origin: str) -> tuple[RobotFileParser | None, bool]:
        """Returns (parser, allow_all). parser None + allow_all False means deny all."""
        try:
            resp = self.client.get(f"{origin}/robots.txt")
        except (FetchError, UnsafeURLError):
            return None, False
        if resp.status_code in (404, 410):
            return None, True
        if resp.status_code != 200:
            return None, False
        parser = RobotFileParser()
        parser.parse(resp.text.splitlines())
        return parser, False

    def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        now = time.monotonic()
        hit = self._cache.get(origin)
        if hit is None or now - hit[0] > TTL_SECONDS:
            parser, allow_all = self._load(origin)
            hit = (now, parser, allow_all)
            self._cache[origin] = hit
        _, parser, allow_all = hit
        if allow_all:
            return True
        if parser is None:
            return False
        return parser.can_fetch(AGENT, url)
