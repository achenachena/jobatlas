"""Outbound HTTP for untrusted URLs (DEVELOPMENT.md §11).

Every request:
- allows only http/https on an allow-listed port, with no userinfo in the URL;
- resolves the host itself and rejects any non-public address (loopback, RFC1918, link-local,
  cloud metadata, CGNAT, reserved, multicast, IPv4-mapped IPv6 of those);
- connects to the *validated IP* (SNI/Host keep the real name, so TLS is still verified
  against it), which closes the DNS-rebinding gap between check and connect;
- follows redirects manually, re-validating every hop, up to a fixed limit;
- caps response size and total time;
- rate-limits per host and retries timeouts/429/5xx with exponential backoff + jitter,
  honouring Retry-After.
"""

from __future__ import annotations

import ipaddress
import json
import random
import re
import socket
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from app.core.config import get_settings

ALLOWED_SCHEMES = {"http", "https"}
DEFAULT_PORTS = {"http": 80, "https": 443}
ALLOWED_PORTS = {80, 443}
BLOCKED_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain", ".home.arpa")
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
NAT64_PREFIX = ipaddress.ip_network("64:ff9b::/96")
NUMERIC_HOST_RE = re.compile(r"^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$")

Resolver = Callable[[str, int], list[str]]


class UnsafeURLError(ValueError):
    """The URL or one of its redirect targets points somewhere we must not connect to."""


class FetchError(Exception):
    """Transport-level failure after retries. Never evidence that a job closed."""

    def __init__(self, message: str, *, error_class: str, status: int | None = None):
        super().__init__(message)
        self.error_class = error_class
        self.status = status


class ResponseTooLargeError(FetchError):
    def __init__(self, message: str):
        super().__init__(message, error_class="too_large")


def default_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({info[4][0] for info in infos})


def is_public_ip(raw: str) -> bool:
    ip = ipaddress.ip_address(raw.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return is_public_ip(str(ip.ipv4_mapped))
        if ip.sixtofour is not None:
            return is_public_ip(str(ip.sixtofour))
        if ip.teredo is not None:
            return False
        if ip in NAT64_PREFIX:  # well-known NAT64 embeds an IPv4 address in the low 32 bits
            return is_public_ip(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
    return ip.is_global and not ip.is_multicast and not ip.is_reserved


def validate_url(url: str) -> tuple[str, str, int]:
    """Static checks. Returns (scheme, host, port)."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise UnsafeURLError(f"unparseable url: {exc}") from exc
    scheme = (parts.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        raise UnsafeURLError(f"scheme not allowed: {scheme!r}")
    if parts.username is not None or parts.password is not None:
        raise UnsafeURLError("credentials in url are not allowed")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise UnsafeURLError("missing host")
    if host == "localhost" or host.endswith(BLOCKED_HOST_SUFFIXES):
        raise UnsafeURLError(f"host not allowed: {host}")
    if NUMERIC_HOST_RE.match(host):
        # Legacy forms (2130706433, 0x7f.1, 0177.0.0.1, 127.1) decode differently across
        # resolvers; only canonical dotted-quad IPv4 literals are accepted.
        try:
            ipaddress.IPv4Address(host)
        except ValueError as exc:
            raise UnsafeURLError(f"ambiguous numeric host: {host}") from exc
    port = port or DEFAULT_PORTS[scheme]
    if port not in ALLOWED_PORTS:
        raise UnsafeURLError(f"port not allowed: {port}")
    return scheme, host, port


def resolve_public(host: str, port: int, resolver: Resolver) -> str:
    """Resolve and require *every* address to be public; return one to pin the connection to."""
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
        addrs = [str(literal)]
    except ValueError:
        try:
            addrs = resolver(host, port)
        except OSError as exc:
            raise FetchError(f"dns failure for {host}", error_class="dns") from exc
    if not addrs:
        raise FetchError(f"no address for {host}", error_class="dns")
    bad = [a for a in addrs if not is_public_ip(a)]
    if bad:
        raise UnsafeURLError(f"{host} resolves to non-public address {bad[0]}")
    return addrs[0]


@dataclass
class SafeResponse:
    url: str
    status_code: int
    headers: httpx.Headers
    content: bytes
    redirects: list[str] = field(default_factory=list)

    def json(self):
        import json

        return json.loads(self.content)

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")


class _HostThrottle:
    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._next: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, host: str, interval: float | None = None) -> None:
        gap = self.min_interval if interval is None else interval
        with self._lock:
            now = time.monotonic()
            at = max(now, self._next.get(host, now))
            self._next[host] = at + gap
        if at > now:
            time.sleep(at - now)


class _RedisThrottle(_HostThrottle):
    """Shared politeness across processes (Celery workers + CLI): a key can be taken at most
    once per min_interval by anyone, via SET NX PX. Falls back to the in-process limiter if
    Redis is unreachable, so a Redis outage never stops collection."""

    MAX_WAIT_SECONDS = 120.0

    def __init__(self, min_interval: float, redis_url: str):
        super().__init__(min_interval)
        import redis

        self._redis = redis.Redis.from_url(redis_url, socket_timeout=2, socket_connect_timeout=2)
        self._ttl_ms = max(int(min_interval * 1000), 1)

    def wait(self, host: str, interval: float | None = None) -> None:
        gap = self.min_interval if interval is None else interval
        if gap <= 0:
            return
        import redis

        deadline = time.monotonic() + self.MAX_WAIT_SECONDS
        key = f"throttle:{host}"
        ttl_ms = max(int(gap * 1000), 1)
        while True:
            try:
                if self._redis.set(key, b"1", nx=True, px=ttl_ms):
                    return
                remaining = self._redis.pttl(key)
            except redis.RedisError:
                super().wait(host, gap)
                return
            if time.monotonic() > deadline:
                return  # never block a worker indefinitely; per-request deadlines still apply
            delay = remaining / 1000 if remaining and remaining > 0 else gap / 10
            time.sleep(min(max(delay, 0.01), gap) + random.uniform(0, 0.05))  # noqa: S311


class SafeHttpClient:
    def __init__(
        self,
        *,
        resolver: Resolver = default_resolver,
        transport: httpx.BaseTransport | None = None,
        max_retries: int = 3,
        backoff_base: float = 1.0,
        max_backoff: float = 60.0,
        sleep: Callable[[float], None] = time.sleep,
    ):
        s = get_settings()
        self.resolver = resolver
        self.max_bytes = s.http_max_response_bytes
        self.max_redirects = s.http_max_redirects
        self.max_total_seconds = s.http_max_total_seconds
        # Public job-board APIs built for programmatic reads may be read a little faster;
        # employers' own career sites keep the default (1 request/second).
        self.host_intervals = s.host_interval_map
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.max_backoff = max_backoff
        self.sleep = sleep
        self.throttle: _HostThrottle = (
            _RedisThrottle(s.http_per_host_min_interval_seconds, s.redis_url)
            if s.http_shared_throttle
            else _HostThrottle(s.http_per_host_min_interval_seconds)
        )
        self._client = httpx.Client(
            transport=transport,
            timeout=httpx.Timeout(s.http_timeout_seconds),
            follow_redirects=False,
            headers={"User-Agent": s.http_user_agent},
            trust_env=False,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> SafeHttpClient:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def get(self, url: str, *, headers: dict[str, str] | None = None) -> SafeResponse:
        """GET with retries on transient failures. Non-retryable statuses are returned."""
        return self._request("GET", url, headers or {}, None)

    def post_json(
        self, url: str, payload: dict, *, headers: dict[str, str] | None = None
    ) -> SafeResponse:
        """POST a JSON body (read-only search endpoints of public career sites)."""
        body = json.dumps(payload, separators=(",", ":")).encode()
        hdrs = {"Content-Type": "application/json", "Accept": "application/json", **(headers or {})}
        return self._request("POST", url, hdrs, body)

    def _request(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> SafeResponse:
        attempt = 0
        while True:
            try:
                resp = self._follow_redirects(method, url, headers, body)
            except httpx.TimeoutException as exc:
                if attempt >= self.max_retries:
                    raise FetchError(f"timeout: {url}", error_class="timeout") from exc
                self.sleep(self._backoff(attempt, None))
            except httpx.TransportError as exc:
                if attempt >= self.max_retries:
                    raise FetchError(f"transport: {exc}", error_class="transport") from exc
                self.sleep(self._backoff(attempt, None))
            else:
                if resp.status_code not in RETRYABLE_STATUS:
                    return resp
                if attempt >= self.max_retries:
                    return resp
                self.sleep(self._backoff(attempt, resp.headers.get("retry-after")))
            attempt += 1

    def _backoff(self, attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(float(retry_after), self.max_backoff)
            except ValueError:
                pass
        delay = min(self.backoff_base * (2**attempt), self.max_backoff)
        return delay + random.uniform(0, delay / 2)  # noqa: S311 - jitter, not crypto

    def _follow_redirects(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> SafeResponse:
        redirects: list[str] = []
        current = url
        for _ in range(self.max_redirects + 1):
            status, resp_headers, content = self._single(method, current, headers, body)
            if status in (301, 302, 303, 307, 308) and "location" in resp_headers:
                redirects.append(current)
                current = urljoin(current, resp_headers["location"])
                if status in (301, 302, 303):  # these downgrade to GET without a body
                    method, body = "GET", None
                continue
            return SafeResponse(current, status, resp_headers, content, redirects)
        raise FetchError(f"too many redirects from {url}", error_class="redirects")

    def _single(
        self, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> tuple[int, httpx.Headers, bytes]:
        scheme, host, port = validate_url(url)
        ip = resolve_public(host, port, self.resolver)
        parts = urlsplit(url)
        ip_host = f"[{ip}]" if ":" in ip else ip
        netloc = ip_host if port == DEFAULT_PORTS[scheme] else f"{ip_host}:{port}"
        pinned = urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))
        req_headers = {**headers, "Host": parts.netloc.rsplit("@", 1)[-1]}
        # Many tenants share one platform's servers (all *.wd3.myworkdayjobs.com resolve to the
        # same IPs), so politeness is enforced per resolved IP as well as per hostname.
        interval = self.host_intervals.get(host)
        self.throttle.wait(host, interval)
        self.throttle.wait(f"ip:{ip}", interval)
        request = self._client.build_request(
            method, pinned, headers=req_headers, content=body, extensions={"sni_hostname": host}
        )
        started = time.monotonic()
        response = self._client.send(request, stream=True)
        try:
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > self.max_bytes:
                raise ResponseTooLargeError(f"{url}: {declared} bytes")
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes():
                if time.monotonic() - started > self.max_total_seconds:
                    # A server trickling bytes can defeat per-read timeouts; cap wall time.
                    raise httpx.ReadTimeout(f"{url}: exceeded {self.max_total_seconds}s total")
                total += len(chunk)
                if total > self.max_bytes:
                    raise ResponseTooLargeError(f"{url}: exceeds {self.max_bytes} bytes")
                chunks.append(chunk)
            return response.status_code, response.headers, b"".join(chunks)
        finally:
            response.close()
