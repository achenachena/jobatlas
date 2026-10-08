from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from app.net.safe_http import SafeHttpClient

FIXTURES = Path(__file__).parent / "fixtures"
PUBLIC_IP = "93.184.216.34"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


Handler = Callable[[httpx.Request], httpx.Response]


class FakeWeb:
    """Routes by (Host header, path?query). Requests arrive at the pinned IP, so the Host
    header is the only way to know which site was meant - exactly like production."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Handler] = {}
        self.requests: list[httpx.Request] = []

    def add(self, host: str, path: str, handler: Handler | httpx.Response) -> None:
        if isinstance(handler, httpx.Response):
            resp = handler
            self.routes[(host, path)] = lambda req, r=resp: httpx.Response(
                r.status_code, headers=r.headers, content=r.content
            )
        else:
            self.routes[(host, path)] = handler

    def json(self, host: str, path: str, body, status: int = 200) -> None:
        self.add(host, path, httpx.Response(status, json=body))

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        host = request.headers["host"]
        path = request.url.raw_path.decode()
        handler = self.routes.get((host, path))
        if handler is None:
            return httpx.Response(599, text=f"no route for {host}{path}")
        return handler(request)


@pytest.fixture
def fake_web() -> FakeWeb:
    return FakeWeb()


@pytest.fixture
def make_client(fake_web: FakeWeb):
    clients: list[SafeHttpClient] = []

    def _make(resolver=None, **kwargs) -> SafeHttpClient:
        client = SafeHttpClient(
            resolver=resolver or (lambda host, port: [PUBLIC_IP]),
            transport=httpx.MockTransport(fake_web),
            sleep=lambda s: None,
            **kwargs,
        )
        client.throttle.min_interval = 0
        clients.append(client)
        return client

    yield _make
    for c in clients:
        c.close()
