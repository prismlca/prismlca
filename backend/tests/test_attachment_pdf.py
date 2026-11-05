"""A PDF attachment is counted and read in a worker process within a time and memory budget
(engine/attachment_pdf.py): over it, the file still attaches without a page count and reading its text is
refused with a clear error; within it, the readings are what they always were."""
from __future__ import annotations

import base64
import sys
import tempfile
import time
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism_lca.engine import attachment_pdf


@pytest.fixture
def fresh_readers():
    """Workers started for this test only, so a changed limit reaches them and leaves with them."""
    attachment_pdf.shutdown()
    yield
    attachment_pdf.shutdown()


def _post(client: TestClient, token: dict[str, str], name: str, data: bytes) -> dict:
    r = client.post(
        "/api/v1/files/attachments",
        json={"name": name, "data_b64": base64.b64encode(data).decode("ascii")},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _typeset(pages: int) -> bytes:
    import typst

    body = "\n#pagebreak()\n".join(f"= Chapter {i}\n\nThe mass of part {i} is {i} kilograms." for i in range(1, pages + 1))
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "main.typ"
        src.write_text(body, encoding="utf-8")
        return typst.compile(str(src), root=tmp)


def _slow_pdf(inflated_mb: int) -> bytes:
    """A small PDF without a cross-reference table whose one object stream inflates to `inflated_mb` MB,
    so the reader rebuilds the table from the inflated stream."""
    header = b"2 0 "
    objects = header + b"<< /Type /Pages /Kids [] /Count 0 >>" + b"\0" * (inflated_mb * 1024**2)
    stream = zlib.compress(objects, 9)
    return (
        b"%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
        + b"3 0 obj\n<< /Type /ObjStm /N 1 /First %d /Filter /FlateDecode /Length %d >>\nstream\n"
        % (len(header), len(stream))
        + stream
        + b"\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
    )


def _large_page_pdf(inflated_mb: int) -> bytes:
    """A one-page PDF whose content stream inflates to `inflated_mb` MB."""
    deflate = zlib.compressobj(9)
    content = b"".join(deflate.compress(b" " * 1024**2) for _ in range(inflated_mb)) + deflate.flush()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    table = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, table)
    return bytes(out)


def test_a_pdf_that_cannot_be_counted_in_time_still_attaches_without_a_page_count(
    client: TestClient, token: dict[str, str], project: str, monkeypatch, fresh_readers
) -> None:
    monkeypatch.setattr(attachment_pdf, "COUNT_TIME_LIMIT_S", 1.0)
    monkeypatch.setattr(attachment_pdf, "TEXT_TIME_LIMIT_S", 1.0)
    started = time.monotonic()
    meta = _post(client, token, "datasheet.pdf", _slow_pdf(16))
    assert time.monotonic() - started < 12
    assert meta["kind"] == "pdf" and "pages" not in meta
    assert meta["warning"].startswith("PDF:"), meta["warning"]

    started = time.monotonic()
    r = client.get(f"/api/v1/files/attachments/{meta['id']}/text", headers=token)
    assert time.monotonic() - started < 12
    assert r.status_code == 422
    assert "took longer than 1 seconds and was stopped" in r.json()["detail"]

    # The next reading starts a new worker and is unaffected.
    ordinary = _post(client, token, "ordinary.pdf", _typeset(pages=3))
    assert ordinary["pages"] == 3


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads its memory from /proc")
def test_reading_a_pdf_over_the_memory_limit_is_refused_and_the_next_one_works(
    client: TestClient, token: dict[str, str], project: str, monkeypatch, fresh_readers
) -> None:
    monkeypatch.setattr(attachment_pdf, "MEMORY_LIMIT", 400 * 1024**2)
    meta = _post(client, token, "drawing.pdf", _large_page_pdf(800))
    assert meta["pages"] == 1  # counting does not inflate the page
    started = time.monotonic()
    r = client.get(f"/api/v1/files/attachments/{meta['id']}/text", headers=token)
    assert time.monotonic() - started < 60
    assert r.status_code == 422
    assert "GB of memory and was stopped" in r.json()["detail"]

    ordinary = _post(client, token, "ordinary.pdf", _typeset(pages=2))
    r = client.get(f"/api/v1/files/attachments/{ordinary['id']}/text", headers=token)
    assert r.status_code == 200 and "Chapter 2" in r.json()["text"]


def test_an_ordinary_pdf_reads_in_the_worker_exactly_as_in_process(tmp_path) -> None:
    path = tmp_path / "report.pdf"
    path.write_bytes(_typeset(pages=6))
    assert attachment_pdf.page_count(path) == attachment_pdf._count(str(path)) == 6
    assert attachment_pdf.text(path, None, 100_000) == attachment_pdf._whole(str(path), 100_000)
    assert attachment_pdf.text(path, "", 100_000) == attachment_pdf._whole(str(path), 100_000)
    assert attachment_pdf.text(path, "5,2-3", 100_000) == attachment_pdf._pages(str(path), [2, 3, 5], 100_000)
    assert attachment_pdf.text(path, "2-6", 1_000) == attachment_pdf._pages(str(path), [2, 3, 4, 5, 6], 1_000)


def test_a_file_the_reader_rejects_attaches_and_reads_as_before(
    client: TestClient, token: dict[str, str], project: str
) -> None:
    meta = _post(client, token, "broken.pdf", b"%PDF-1.4\nnot really a PDF\n")
    assert "pages" not in meta
    r = client.get(f"/api/v1/files/attachments/{meta['id']}/text", headers=token)
    assert r.status_code == 422 and r.json()["detail"].startswith("Could not read the attachment:")
    assert len(r.json()["detail"]) < 2_100


def test_an_unexpected_end_of_the_reader_says_so() -> None:
    assert "stopped unexpectedly (exit code 3)" in attachment_pdf._stopped(3).message
    assert "took longer than" in attachment_pdf._stopped(None).message
