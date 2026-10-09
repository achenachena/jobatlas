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


class RobotsUnavailable(FetchError):
    """robots.txt could not be read right now (timeout, 429, 5xx). We do not fetch, but this
    is temporary and must never be recorded as a permanent refusal."""

    def __init__(self, origin: str):
        super().__init__(f"robots.txt unavailable for {origin}", error_class="robots_unavailable")


class RobotsCache:
    """Adapters create one per request, so parsed files live in a process-wide cache (one
    fetch per origin per TTL_SECONDS, shared by worker threads)."""

    _shared: dict[str, tuple[float, RobotFileParser | None, bool]] = {}

    def __init__(self, client: SafeHttpClient):
        self.client = client
        self._cache = RobotsCache._shared

    @classmethod
    def clear(cls) -> None:
        cls._shared.clear()

    def _load(self, origin: str) -> tuple[RobotFileParser | None, bool]:
        """Returns (parser, allow_all), or raises RobotsUnavailable for transient failures."""
        try:
            resp = self.client.get(f"{origin}/robots.txt")
        except UnsafeURLError:
            return None, False  # never fetch from unsafe hosts
        except FetchError as exc:
            raise RobotsUnavailable(origin) from exc
        if resp.status_code in (404, 410):
            return None, True
        if resp.status_code in (401, 403):
            return None, False  # access to robots itself refused: treat as disallowed
        if resp.status_code != 200:
            raise RobotsUnavailable(origin)  # 429 / 5xx: try again later
        parser = RobotFileParser()
        parser.parse(resp.text.splitlines())
        return parser, False

    def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        now = time.monotonic()
        hit = self._cache.get(origin)
        if hit is None or now - hit[0] > TTL_SECONDS:
            parser, allow_all = self._load(origin)  # may raise RobotsUnavailable (not cached)
            hit = (now, parser, allow_all)
            self._cache[origin] = hit
        _, parser, allow_all = hit
        if allow_all:
            return True
        if parser is None:
            return False
        return parser.can_fetch(AGENT, url)
