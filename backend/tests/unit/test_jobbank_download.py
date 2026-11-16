"""Downloads retain successful files and remove incomplete ones."""

import hashlib

import httpx
import pytest

from app.atlas import jobbank


@pytest.mark.parametrize("failure", ["http", "size", "redirect", "stream"])
def test_failed_download_leaves_no_file(tmp_path, monkeypatch, failure):
    monkeypatch.setattr(jobbank.tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(jobbank, "MAX_BYTES", 3 if failure == "size" else 100_000)

    class BrokenStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b"a" * 65_536
            raise httpx.ReadError("interrupted download")

    def respond(request):
        if failure == "http":
            return httpx.Response(500)
        if failure == "redirect":
            return httpx.Response(302, headers={"location": "https://example.org/file.csv"})
        if failure == "stream":
            return httpx.Response(200, stream=BrokenStream())
        return httpx.Response(200, content=b"oversized")

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises((jobbank.JobBankError, httpx.HTTPError)):
            jobbank.download("https://open.canada.ca/file.csv", client)
        assert not client.is_closed
    assert list(tmp_path.iterdir()) == []


def test_download_retains_file_and_checksum(tmp_path, monkeypatch):
    monkeypatch.setattr(jobbank.tempfile, "tempdir", str(tmp_path))
    data = b"posting data"
    transport = httpx.MockTransport(lambda r: httpx.Response(200, content=data))
    with httpx.Client(transport=transport) as c:
        path, checksum = jobbank.download("https://open.canada.ca/file.csv", c)
        assert not c.is_closed
    assert path.read_bytes() == data
    assert checksum == hashlib.sha256(data).hexdigest()
