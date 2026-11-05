"""Reading a bundle someone else wrote: what its members may unpack to, and what its report pictures may
carry into the receiver's workspace."""

from __future__ import annotations

import base64
import io
import json
import struct
import tracemalloc
import zipfile
from dataclasses import replace

import pytest
from test_bundle import _b64, _export, _repack, fill_source

from prism_lca.engine import archive_limits
from prism_lca.engine.bundle import read_bundle
from prism_lca.errors import PrismError

#: The smallest valid PNG: one transparent pixel.
PNG_1PX = base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000d49444154789c6360000002000005000155a0c13d0000000049454e44ae426082"
    )
).decode("ascii")


@pytest.fixture
def filled(client, token, project) -> str:
    del project
    return fill_source(client, token)


def _bundle(members: dict[str, bytes], sections: list[str]) -> bytes:
    manifest = {"format": 1, "model": {"name": "Limits"}, "sections": [{"file": f} for f in sections]}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        for name, raw in members.items():
            zf.writestr(name, raw)
    return buf.getvalue()


def _declare(data: bytes, member: str, size: int) -> bytes:
    """The archive with `member`'s uncompressed size in the central directory set to `size`."""
    out = bytearray(data)
    at = out.find(b"PK\x01\x02")
    while at != -1:
        name_len = struct.unpack_from("<H", out, at + 28)[0]
        if out[at + 46 : at + 46 + name_len].decode() == member:
            struct.pack_into("<I", out, at + 24, size)
            return bytes(out)
        at = out.find(b"PK\x01\x02", at + 4)
    raise AssertionError(member)


def _peak_while(call) -> int:
    tracemalloc.start()
    try:
        call()
    except PrismError:
        pass
    finally:
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
    return peak


# --- member sizes -------------------------------------------------------------------------------


def test_a_member_declared_above_the_limit_is_refused_before_it_is_inflated(monkeypatch):
    monkeypatch.setattr(archive_limits, "BUNDLE", replace(archive_limits.BUNDLE, member=1 << 20))
    data = _bundle({"extra.json": bytes(16 << 20)}, ["extra.json"])
    with pytest.raises(PrismError) as caught:
        read_bundle(data)
    assert caught.value.code == "bundle_too_large"
    assert _peak_while(lambda: read_bundle(data)) < 4 << 20


def test_a_member_is_read_no_further_than_its_declared_size():
    data = _declare(_bundle({"extra.json": bytes(64 << 20)}, ["extra.json"]), "extra.json", 1000)
    with pytest.raises(PrismError) as caught:
        read_bundle(data)
    assert caught.value.code == "bundle_corrupt"
    assert _peak_while(lambda: read_bundle(data)) < 4 << 20


def test_the_total_is_counted_across_members(monkeypatch):
    monkeypatch.setattr(archive_limits, "BUNDLE", replace(archive_limits.BUNDLE, total=3 << 20))
    data = _bundle({"a.json": bytes(2 << 20), "b.json": bytes(2 << 20)}, ["a.json", "b.json"])
    with pytest.raises(PrismError) as caught:
        read_bundle(data)
    assert caught.value.code == "bundle_too_large"


def test_a_section_declared_twice_is_refused():
    with pytest.raises(PrismError) as caught:
        read_bundle(_bundle({"x.json": b"{}"}, ["x.json", "x.json"]))
    assert caught.value.code == "bundle_corrupt"


def test_a_manifest_with_more_sections_than_the_format_has_room_for_is_refused():
    names = [f"s{i}.json" for i in range(archive_limits.BUNDLE_SECTIONS + 1)]
    with pytest.raises(PrismError) as caught:
        read_bundle(_bundle({n: b"{}" for n in names}, names))
    assert caught.value.code == "bundle_too_large"


def test_the_manifest_has_its_own_small_limit():
    big = {"format": 1, "model": {"name": "x"}, "sections": [], "pad": "x" * (2 << 20)}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(big))
    with pytest.raises(PrismError) as caught:
        read_bundle(buf.getvalue())
    assert caught.value.code == "bundle_too_large"


def test_an_export_reads_back_within_the_limits(client, token, filled):
    opened = read_bundle(_export(client, token, filled, preset="full"))
    assert {"graph", "study", "reports"} <= set(opened["sections"])


# --- report pictures ----------------------------------------------------------------------------


def _report_with_logo(client, token, db: str, logo: str) -> None:
    r = client.post("/api/v1/report/create", json={"database": db, "name": "Pictured"}, headers=token)
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    r = client.post(f"/api/v1/report/one/{db}/{rid}", json={"client_logo": logo}, headers=token)
    assert r.status_code == 200, r.text


def _imported_report(client, token, data: bytes, name: str) -> dict:
    r = client.post("/api/v1/bundle/import", json={"content": _b64(data), "name": name}, headers=token)
    assert r.status_code == 200, r.text
    rows = client.get(f"/api/v1/report/list/{name}", headers=token).json()
    rows = rows if isinstance(rows, list) else rows.get("reports", [])
    rid = next(x["id"] for x in rows if x["name"] == "Pictured")
    return client.get(f"/api/v1/report/one/{name}/{rid}", headers=token).json()


def test_a_report_picture_comes_back_unchanged(client, token, filled):
    _report_with_logo(client, token, filled, PNG_1PX)
    report = _imported_report(client, token, _export(client, token, filled), "Pictured copy")
    assert report["client_logo"] == PNG_1PX
    assert report["cover_image"] == "default"


def test_a_report_picture_that_an_upload_would_refuse_is_left_out(client, token, filled):
    _report_with_logo(client, token, filled, PNG_1PX)
    svg = base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg"/>').decode("ascii")

    def edit(section):
        for rep in section["reports"]:
            rep["client_logo"] = svg
            rep["cover_image"] = svg

    data = _repack(_export(client, token, filled), "reports.json", edit)
    report = _imported_report(client, token, data, "Unpictured copy")
    assert report["client_logo"] == ""
    assert report["cover_image"] == "default"
