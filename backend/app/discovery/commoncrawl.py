"""Common Crawl URL index reader (ZipNum CDX) using HTTP range requests.

Why not the CDX query server (index.commoncrawl.org/CC-MAIN-*-index)? It is frequently
overloaded (504s observed 2026-10-08) and its robots.txt disallows those paths. The same
index is published as static files on data.commoncrawl.org:

    cc-index/collections/<collection>/indexes/cluster.idx   (~100 MB, sorted, plain text)
    cc-index/collections/<collection>/indexes/cdx-NNNNN.gz  (gzip members, ~3000 lines each)

cluster.idx lines: "<surt> <timestamp>\\t<cdx file>\\t<offset>\\t<length>\\t<seq>". We binary
search it with ~64 KiB range reads to find the few blocks covering a SURT prefix (e.g.
"com,ashbyhq,jobs)/"), then range-read only those gzip blocks. A full pass over one ATS
host costs a handful of small requests rather than a scan.

Common Crawl is historical: a URL here proves only that it existed at crawl time. Every
candidate is re-verified against the live provider before it becomes a source.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Iterator
from dataclasses import dataclass

from app.core.config import get_settings
from app.net.safe_http import FetchError, SafeHttpClient

CHUNK = 64 * 1024

# SURT prefixes for ATS board hosts. Order is the processing order within a collection.
ATS_SURT_PREFIXES = {
    "greenhouse-job-boards": "io,greenhouse,job-boards)/",
    "greenhouse-boards": "io,greenhouse,boards)/",
    "ashby": "com,ashbyhq,jobs)/",
    "lever": "co,lever,jobs)/",
    "workday": "com,myworkdayjobs,",
    # wd3 hosts most Canadian employers observed so far (TD, CIBC, BMO, Sun Life, Manulife).
    "workday-wd3": "com,myworkdayjobs,wd3,",
    "workday-site": "com,myworkdaysite,",
}


@dataclass(frozen=True)
class Block:
    first_key: bytes
    filename: str
    offset: int
    length: int


@dataclass(frozen=True)
class CdxRecord:
    url: str
    timestamp: str
    status: str | None


class CommonCrawlError(Exception):
    pass


def list_collections(client: SafeHttpClient) -> list[str]:
    """Newest first. collinfo.json is explicitly allowed by index.commoncrawl.org/robots.txt."""
    resp = client.get(get_settings().commoncrawl_collinfo_url)
    if resp.status_code != 200:
        raise CommonCrawlError(f"collinfo status {resp.status_code}")
    return [c["id"] for c in resp.json() if str(c.get("id", "")).startswith("CC-MAIN-")]


class ZipNumIndex:
    def __init__(self, client: SafeHttpClient, collection: str):
        self.client = client
        self.collection = collection
        base = get_settings().commoncrawl_data_base.rstrip("/")
        self.base = f"{base}/cc-index/collections/{collection}/indexes"
        self._size: int | None = None

    def _range(self, path: str, start: int, end_inclusive: int) -> bytes:
        resp = self.client.get(
            f"{self.base}/{path}", headers={"Range": f"bytes={start}-{end_inclusive}"}
        )
        if resp.status_code not in (200, 206):
            raise FetchError(
                f"range {path} {resp.status_code}", error_class="http", status=resp.status_code
            )
        if resp.status_code == 206:
            total = resp.headers.get("content-range", "").rsplit("/", 1)[-1]
            if total.isdigit() and path == "cluster.idx":
                self._size = int(total)
        return resp.content

    def cluster_size(self) -> int:
        if self._size is None:
            self._range("cluster.idx", 0, 0)
        if self._size is None:
            raise CommonCrawlError("server did not report cluster.idx size")
        return self._size

    @staticmethod
    def _parse_cluster_line(line: bytes) -> Block | None:
        parts = line.split(b"\t")
        if len(parts) < 4:
            return None
        return Block(
            first_key=parts[0],
            filename=parts[1].decode(),
            offset=int(parts[2]),
            length=int(parts[3]),
        )

    def _first_full_line_after(self, pos: int) -> bytes | None:
        data = self._range("cluster.idx", pos, pos + CHUNK - 1)
        nl = data.find(b"\n")
        if nl < 0:
            return None
        rest = data[nl + 1 :]
        end = rest.find(b"\n")
        return rest[:end] if end >= 0 else None

    def find_blocks(self, surt_prefix: str) -> list[Block]:
        """All blocks that may contain keys starting with surt_prefix, in index order."""
        prefix = surt_prefix.encode()
        lo, hi = 0, self.cluster_size()
        # Invariant: the first full line after `lo` sorts before prefix (or lo == 0).
        while hi - lo > CHUNK:
            mid = (lo + hi) // 2
            line = self._first_full_line_after(mid)
            if line is not None and line.split(b"\t", 1)[0] < prefix:
                lo = mid
            else:
                hi = mid

        blocks: list[Block] = []
        before: Block | None = None
        pos = lo
        carry = b""
        first = lo > 0
        while True:
            data = self._range("cluster.idx", pos, pos + CHUNK - 1)
            if not data:
                break
            pos += len(data)
            buf = carry + data
            lines = buf.split(b"\n")
            carry = lines.pop()  # incomplete tail
            if first:
                lines = lines[1:]  # partial line at `lo`
                first = False
            for line in lines:
                block = self._parse_cluster_line(line)
                if block is None:
                    continue
                key = block.first_key.split(b" ", 1)[0]
                if key < prefix:
                    before = block
                elif key.startswith(prefix):
                    blocks.append(block)
                else:
                    return ([before] if before else []) + blocks
            if len(data) < CHUNK:
                break
        return ([before] if before else []) + blocks

    def read_block(self, block: Block, surt_prefix: str) -> Iterator[CdxRecord]:
        raw = self._range(block.filename, block.offset, block.offset + block.length - 1)
        try:
            text = gzip.decompress(raw)
        except (OSError, EOFError) as exc:
            raise CommonCrawlError(f"bad gzip block {block.filename}@{block.offset}") from exc
        prefix = surt_prefix.encode()
        for line in text.split(b"\n"):
            if not line.startswith(prefix):
                continue
            try:
                _key, ts, payload = line.split(b" ", 2)
                meta = json.loads(payload)
            except ValueError:
                continue
            url = meta.get("url")
            if url:
                yield CdxRecord(url=url, timestamp=ts.decode(), status=meta.get("status"))
