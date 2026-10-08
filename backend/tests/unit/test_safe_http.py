import httpx
import pytest

from app.net.safe_http import (
    FetchError,
    ResponseTooLargeError,
    UnsafeURLError,
    default_resolver,
    is_public_ip,
    resolve_public,
    validate_url,
)


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/",
        "file:///etc/passwd",
        "gopher://example.com/",
        "http://user:pw@example.com/",
        "http://localhost/",
        "http://metadata.google.internal/",
        "http://printer.local/",
        "http://example.com:6379/",
        "https://example.com:8443/",
        "http:///nohost",
        "http://[::1",
    ],
)
def test_validate_url_rejects(url):
    with pytest.raises(UnsafeURLError):
        validate_url(url)


def test_validate_url_accepts_public_https():
    assert validate_url("https://boards-api.greenhouse.io/v1/boards/x") == (
        "https",
        "boards-api.greenhouse.io",
        443,
    )


@pytest.mark.parametrize(
    "ip,public",
    [
        ("8.8.8.8", True),
        ("2606:4700:4700::1111", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),  # cloud metadata
        ("100.64.0.1", False),  # CGNAT
        ("0.0.0.0", False),
        ("224.0.0.1", False),
        ("240.0.0.1", False),
        ("::1", False),
        ("fe80::1", False),
        ("fd00:ec2::254", False),  # AWS IMDS over IPv6
        ("::ffff:127.0.0.1", False),  # IPv4-mapped loopback
        ("::ffff:169.254.169.254", False),
        ("2002:7f00:0001::", False),  # 6to4 wrapping 127.0.0.1
        ("64:ff9b::a9fe:a9fe", False),  # NAT64 of metadata
    ],
)
def test_is_public_ip(ip, public):
    assert is_public_ip(ip) is public


@pytest.mark.parametrize("host", ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "0x7f.1"])
def test_ambiguous_numeric_hosts_are_rejected(host):
    with pytest.raises(UnsafeURLError):
        validate_url(f"http://{host}/")


def test_canonical_loopback_literal_is_rejected_after_parse():
    validate_url("http://127.0.0.1/")  # syntactically fine...
    with pytest.raises(UnsafeURLError):  # ...but never connectable
        resolve_public("127.0.0.1", 80, default_resolver)


def test_ip_literal_hosts_are_checked_without_dns():
    with pytest.raises(UnsafeURLError):
        resolve_public("[::1]", 80, lambda h, p: ["8.8.8.8"])
    with pytest.raises(UnsafeURLError):
        resolve_public("169.254.169.254", 80, lambda h, p: ["8.8.8.8"])


def test_any_private_answer_blocks_host():
    with pytest.raises(UnsafeURLError):
        resolve_public("evil.example", 443, lambda h, p: ["8.8.8.8", "10.0.0.5"])


def test_connection_is_pinned_to_validated_ip(make_client, fake_web):
    fake_web.json("api.example.com", "/x", {"ok": True})
    client = make_client(resolver=lambda h, p: ["93.184.216.34"])
    resp = client.get("https://api.example.com/x")
    assert resp.status_code == 200
    sent = fake_web.requests[0]
    assert sent.url.host == "93.184.216.34"
    assert sent.headers["host"] == "api.example.com"
    assert sent.extensions["sni_hostname"] == "api.example.com"


def test_redirect_to_internal_address_is_blocked(make_client, fake_web):
    fake_web.add(
        "jobs.example.com",
        "/board",
        httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"}),
    )
    client = make_client()
    with pytest.raises(UnsafeURLError):
        client.get("https://jobs.example.com/board")


def test_redirect_to_host_resolving_private_is_blocked(make_client, fake_web):
    fake_web.add(
        "jobs.example.com",
        "/a",
        httpx.Response(301, headers={"location": "https://rebind.example/"}),
    )

    def resolver(host, port):
        return ["10.0.0.7"] if host == "rebind.example" else ["93.184.216.34"]

    client = make_client(resolver=resolver)
    with pytest.raises(UnsafeURLError):
        client.get("https://jobs.example.com/a")


def test_redirect_limit(make_client, fake_web):
    fake_web.add("loop.example", "/", httpx.Response(302, headers={"location": "/"}))
    with pytest.raises(FetchError) as exc:
        make_client().get("https://loop.example/")
    assert exc.value.error_class == "redirects"


def test_response_size_cap(make_client, fake_web, monkeypatch):
    fake_web.add("big.example", "/", httpx.Response(200, content=b"x" * 5000))
    client = make_client()
    client.max_bytes = 1000
    with pytest.raises(ResponseTooLargeError):
        client.get("https://big.example/")


def test_retries_honour_retry_after_then_return_last_status(make_client, fake_web):
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(429, headers={"retry-after": "7"})

    fake_web.add("busy.example", "/", handler)
    slept: list[float] = []
    client = make_client(max_retries=2)
    client.sleep = slept.append
    resp = client.get("https://busy.example/")
    assert resp.status_code == 429
    assert calls["n"] == 3
    assert slept == [7.0, 7.0]


def test_timeouts_raise_fetch_error_after_retries(make_client, fake_web):
    def handler(req):
        raise httpx.ReadTimeout("slow", request=req)

    fake_web.add("slow.example", "/", handler)
    with pytest.raises(FetchError) as exc:
        make_client(max_retries=1).get("https://slow.example/")
    assert exc.value.error_class == "timeout"
