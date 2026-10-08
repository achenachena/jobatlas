"""ZipNum reader against a synthetic index served with real HTTP Range semantics."""

import gzip
import json

import httpx

from app.discovery import commoncrawl
from app.discovery.commoncrawl import ZipNumIndex

HOST = "data.commoncrawl.org"
BASE = "/cc-index/collections/CC-MAIN-TEST/indexes"


def _cdx_line(surt: str, url: str) -> bytes:
    return f"{surt} 20260915000000 {json.dumps({'url': url, 'status': '200'})}".encode()


def build_index(n_filler_blocks: int = 400):
    """cdx file of gzip members + cluster.idx pointing at them, sorted by SURT."""
    groups: list[list[bytes]] = []
    for i in range(n_filler_blocks):
        groups.append([_cdx_line(f"aa,filler{i:05d})/", f"https://filler{i}.aa/")])
    ashby = [
        _cdx_line(f"com,ashbyhq,jobs)/{name}", f"https://jobs.ashbyhq.com/{name}/x")
        for name in ["alpha", "beta", "gamma", "delta", "epsilon"]
    ]
    groups.append([_cdx_line("com,ashbyhq)/", "https://ashbyhq.com/"), *ashby[:2]])
    groups.append(ashby[2:])
    for i in range(n_filler_blocks):
        groups.append([_cdx_line(f"zz,filler{i:05d})/", f"https://filler{i}.zz/")])

    cdx = bytearray()
    cluster = bytearray()
    for seq, lines in enumerate(groups):
        member = gzip.compress(b"\n".join(lines) + b"\n")
        first_key = lines[0].split(b" ", 2)
        cluster += (
            first_key[0]
            + b" "
            + first_key[1]
            + f"\tcdx-00000.gz\t{len(cdx)}\t{len(member)}\t{seq}\n".encode()
        )
        cdx += member
    return bytes(cluster), bytes(cdx)


def range_handler(blob: bytes):
    def handler(request: httpx.Request) -> httpx.Response:
        start, end = request.headers["range"].removeprefix("bytes=").split("-")
        start, end = int(start), min(int(end), len(blob) - 1)
        part = blob[start : end + 1] if start < len(blob) else b""
        return httpx.Response(
            206, content=part, headers={"content-range": f"bytes {start}-{end}/{len(blob)}"}
        )

    return handler


def test_find_and_read_blocks(make_client, fake_web, monkeypatch):
    monkeypatch.setattr(commoncrawl, "CHUNK", 1024)  # force several binary-search steps
    cluster, cdx = build_index()
    fake_web.add(HOST, f"{BASE}/cluster.idx", range_handler(cluster))
    fake_web.add(HOST, f"{BASE}/cdx-00000.gz", range_handler(cdx))
    index = ZipNumIndex(make_client(), "CC-MAIN-TEST")

    prefix = "com,ashbyhq,jobs)/"
    blocks = index.find_blocks(prefix)
    assert len(blocks) >= 2
    urls = [r.url for b in blocks for r in index.read_block(b, prefix)]
    assert sorted(urls) == sorted(
        f"https://jobs.ashbyhq.com/{n}/x" for n in ["alpha", "beta", "gamma", "delta", "epsilon"]
    )
    # Logarithmic: nowhere near reading the whole cluster.idx in 1 KiB chunks.
    cluster_reads = [r for r in fake_web.requests if r.url.path.endswith("cluster.idx")]
    assert len(cluster_reads) < len(cluster) // 1024 // 2


def test_missing_prefix_returns_only_neighbour(make_client, fake_web, monkeypatch):
    monkeypatch.setattr(commoncrawl, "CHUNK", 1024)
    cluster, cdx = build_index(50)
    fake_web.add(HOST, f"{BASE}/cluster.idx", range_handler(cluster))
    fake_web.add(HOST, f"{BASE}/cdx-00000.gz", range_handler(cdx))
    index = ZipNumIndex(make_client(), "CC-MAIN-TEST")
    prefix = "co,lever,jobs)/"
    blocks = index.find_blocks(prefix)
    assert all(not list(index.read_block(b, prefix)) for b in blocks)
