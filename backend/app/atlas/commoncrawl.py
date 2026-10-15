"""Find employer job boards in the Common Crawl URL index (ZipNum CDX via range reads).

The index is published as static files on data.commoncrawl.org:

    cc-index/collections/<id>/indexes/cluster.idx   sorted "<surt> <ts>\\t<file>\\t<off>\\t<len>"
    cc-index/collections/<id>/indexes/cdx-NNNNN.gz  gzip blocks of CDX lines

A binary search over cluster.idx (64 KiB range reads) finds the few blocks under a SURT
prefix such as "co,lever,jobs)/"; only those blocks are read. Reading these index files
was accepted by the operator on 2026-10-08 (the host's robots.txt disallows crawling; its
terms of use allow automated access). A URL here only proves a board existed at crawl time:
every board is fetched from the live API before it counts (atlas/ats.py).
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Iterator

import httpx

from app.atlas.ats import add_boards, recognize
from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)

COLLINFO = "https://index.commoncrawl.org/collinfo.json"
DATA = "https://data.commoncrawl.org/cc-index/collections"
CHUNK = 64 * 1024
PREFIXES = ("io,greenhouse,job-boards)/", "io,greenhouse,boards)/", "co,lever,jobs)/",
            "com,ashbyhq,jobs)/")  # fmt: skip


def _client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(60.0), trust_env=False,
                        headers={"User-Agent": get_settings().atlas_user_agent})  # fmt: skip


def collections(client: httpx.Client, n: int) -> list[str]:
    resp = client.get(COLLINFO)
    resp.raise_for_status()
    return [c["id"] for c in resp.json() if str(c.get("id", "")).startswith("CC-MAIN-")][:n]


class Index:
    def __init__(self, client: httpx.Client, collection: str):
        self.client = client
        self.base = f"{DATA}/{collection}/indexes"
        head = self._range("cluster.idx", 0, 0)
        self.size = int(head.headers["content-range"].rsplit("/", 1)[-1])

    def _range(self, path: str, start: int, end: int) -> httpx.Response:
        resp = self.client.get(f"{self.base}/{path}", headers={"Range": f"bytes={start}-{end}"})
        resp.raise_for_status()
        return resp

    def _get(self, path: str, start: int, end: int) -> bytes:
        return self._range(path, start, end).content

    def _line_after(self, pos: int) -> bytes:
        lines = self._get("cluster.idx", pos, pos + CHUNK - 1).split(b"\n")
        return lines[1] if len(lines) > 2 else b""

    def blocks(self, prefix: bytes) -> list[tuple[str, int, int]]:
        """(file, offset, length) of every block that may hold keys starting with prefix:
        the last block starting before it, then all blocks starting inside it."""
        lo, hi = 0, self.size
        while hi - lo > CHUNK:
            mid = (lo + hi) // 2
            if self._line_after(mid).split(b"\t", 1)[0] < prefix:
                lo = mid
            else:
                hi = mid
        out: list[tuple[str, int, int]] = []
        before = None
        pos, carry, skip_first = lo, b"", lo > 0
        while pos < self.size:
            data = self._get("cluster.idx", pos, pos + CHUNK - 1)
            pos += len(data)
            lines = (carry + data).split(b"\n")
            carry = lines.pop()
            if skip_first:
                lines, skip_first = lines[1:], False
            for line in lines:
                f = line.split(b"\t")
                if len(f) < 4:
                    continue
                block = (f[1].decode(), int(f[2]), int(f[3]))
                key = f[0].split(b" ", 1)[0]
                if key < prefix:
                    before = block
                elif key.startswith(prefix):
                    out.append(block)
                else:
                    return ([before] if before else []) + out
        return ([before] if before else []) + out

    def urls(self, prefix: str) -> Iterator[str]:
        p = prefix.encode()
        for name, off, length in self.blocks(p):
            for line in gzip.decompress(self._get(name, off, off + length - 1)).split(b"\n"):
                if line.startswith(p):
                    try:
                        yield json.loads(line.split(b" ", 2)[2])["url"]
                    except (ValueError, KeyError, IndexError):
                        continue


def discover(session, n_collections: int = 6, client: httpx.Client | None = None) -> dict:
    """Add every board seen in the newest crawls as a `new` candidate. Returns counts."""
    own = client is None
    client = client or _client()
    report: dict = {"collections": [], "seen": 0, "added": 0}
    try:
        for coll in collections(client, n_collections):
            index = Index(client, coll)
            found = {b for prefix in PREFIXES for u in index.urls(prefix) if (b := recognize(u))}
            added = add_boards(session, found, f"commoncrawl:{coll}")
            report["collections"].append(coll)
            report["seen"] += len(found)
            report["added"] += added
            log.info("ats_discover", collection=coll, boards=len(found), added=added)
    finally:
        if own:
            client.close()
    return report
