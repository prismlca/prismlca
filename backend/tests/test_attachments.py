"""Chat attachments: storing, deduplicating and reading back what the user hands the assistant."""

from __future__ import annotations

import base64
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _post(client: TestClient, token: dict[str, str], name: str, data: bytes) -> dict:
    r = client.post(
        "/api/v1/files/attachments",
        json={"name": name, "data_b64": base64.b64encode(data).decode("ascii")},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _text(client: TestClient, token: dict[str, str], attachment_id: str, **params: str) -> dict:
    r = client.get(f"/api/v1/files/attachments/{attachment_id}/text", params=params, headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def _xlsx(rows: int) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Bill of materials"
    ws.append(["Material", "Mass (kg)"])
    for i in range(rows):
        ws.append([f"part {i}", i * 0.5])
    second = wb.create_sheet("Transport")
    second.append(["Leg", "km"])
    second.append(["factory to port", 120])
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as fh:
        wb.save(fh.name)
        return Path(fh.name).read_bytes()


def _pdf(pages: int) -> bytes:
    import typst

    body = "\n#pagebreak()\n".join(f"= Chapter {i}\n\nThe mass of part {i} is {i} kilograms." for i in range(1, pages + 1))
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "main.typ"
        src.write_text(body, encoding="utf-8")
        return typst.compile(str(src), root=tmp)


def test_text_attachment_round_trip(client: TestClient, token: dict[str, str], project: str) -> None:
    meta = _post(client, token, "notes.md", b"# Spec\n\nThe frame weighs 2.4 kg.\n")
    assert meta["kind"] == "text"
    assert meta["name"] == "notes.md"
    assert meta["chars"] == 33
    assert meta["warning"] == ""
    assert "2.4 kg" in _text(client, token, meta["id"])["text"]


def test_same_content_is_stored_once(client: TestClient, token: dict[str, str], project: str) -> None:
    """Attaching the same specification in two chats must not store it twice."""
    first = _post(client, token, "spec.txt", b"identical bytes")
    second = _post(client, token, "spec.txt", b"identical bytes")
    assert first["id"] == second["id"]
    other = _post(client, token, "spec.txt", b"different bytes")
    assert other["id"] != first["id"], "different content under the same name must not collide"


def test_unsupported_format_is_refused_by_name(client: TestClient, token: dict[str, str], project: str) -> None:
    """Refused at the door, not at extraction — the chip can say so before anything is sent."""
    r = client.post(
        "/api/v1/files/attachments",
        json={"name": "model.zip", "data_b64": base64.b64encode(b"PK\x03\x04").decode("ascii")},
        headers=token,
    )
    assert r.status_code == 415
    assert ".zip" in r.json()["detail"]


def test_spreadsheet_becomes_markdown_with_its_true_size(
    client: TestClient, token: dict[str, str], project: str
) -> None:
    meta = _post(client, token, "bom.xlsx", _xlsx(rows=12))
    assert meta["kind"] == "sheet"
    names = [s["name"] for s in meta["sheets"]]
    assert names == ["Bill of materials", "Transport"]
    assert meta["sheets"][0]["rows"] == 13  # header + 12

    body = _text(client, token, meta["id"])
    # The counts precede the tables, so a cut-off table cannot be read as the whole workbook.
    assert "13 rows" in body["text"]
    assert "part 5" in body["text"]
    assert "factory to port" in body["text"], "every sheet travels, not just the first"

    one = _text(client, token, meta["id"], sheet="Transport")
    assert "factory to port" in one["text"]
    assert "part 5" not in one["text"]


def test_big_spreadsheet_warns_before_it_is_sent(client: TestClient, token: dict[str, str], project: str) -> None:
    meta = _post(client, token, "big.xlsx", _xlsx(rows=6_000))
    # 6 001 in the first sheet plus the 2 in "Transport": the warning counts the whole workbook,
    # because that is what the conversion has to fit.
    assert "6003 rows" in meta["warning"]


def test_pdf_is_measured_and_readable_page_by_page(
    client: TestClient, token: dict[str, str], project: str
) -> None:
    meta = _post(client, token, "datasheet.pdf", _pdf(pages=4))
    assert meta["kind"] == "pdf"
    assert meta["pages"] == 4
    # Four pages is not worth a size warning — what the chip says instead is the recipient note: a
    # PDF can pass through OpenRouter's parser at Cloudflare (privacy notice, 30.09.2026).
    assert meta["warning"].startswith("PDF:"), meta["warning"]
    assert "pages" not in meta["warning"]

    whole = _text(client, token, meta["id"])
    assert "Chapter 1" in whole["text"] and "Chapter 4" in whole["text"]

    # The point of the page range: re-reading three pages of a long PDF after the context was
    # compacted, instead of sending all of it again.
    part = _text(client, token, meta["id"], pages="2-3")
    assert "Page 2" in part["text"] and "Page 3" in part["text"]
    assert "Chapter 1" not in part["text"] and "Chapter 4" not in part["text"]


def test_long_pdf_warns(client: TestClient, token: dict[str, str], project: str) -> None:
    meta = _post(client, token, "long.pdf", _pdf(pages=55))
    assert meta["pages"] == 55
    assert "55 pages" in meta["warning"]


def test_extraction_is_capped(client: TestClient, token: dict[str, str], project: str) -> None:
    meta = _post(client, token, "huge.txt", b"x" * 250_000)
    body = _text(client, token, meta["id"], limit="5000")
    assert body["truncated"] is True
    assert len(body["text"]) == 5_000


def test_raw_bytes_come_back_for_the_native_route(
    client: TestClient, token: dict[str, str], project: str
) -> None:
    """PDFs and images are forwarded to the model as they are; main fetches them from here."""
    original = _pdf(pages=1)
    meta = _post(client, token, "one.pdf", original)
    r = client.get(f"/api/v1/files/attachments/{meta['id']}/raw", headers=token)
    assert r.status_code == 200, r.text
    assert base64.b64decode(r.json()["data_b64"]) == original


def test_unknown_id_is_a_404(client: TestClient, token: dict[str, str], project: str) -> None:
    r = client.get("/api/v1/files/attachments/nope-nothing/text", headers=token)
    assert r.status_code == 404


@pytest.mark.parametrize("name", ["../../escape.txt", "sub/dir/deep.txt"])
def test_path_traversal_in_the_name_cannot_escape_the_sources_dir(
    client: TestClient, token: dict[str, str], project: str, name: str
) -> None:
    from prism_lca.engine import attachments

    meta = _post(client, token, name, b"harmless")
    stored = attachments.path_of(meta["id"], meta).resolve()
    assert stored.parent == attachments.sources_dir().resolve()


def test_stored_path_points_at_the_file_and_says_when_it_is_gone(
    client: TestClient, token: dict[str, str], project: str
) -> None:
    """The desktop shell opens the attachment by path, so the path has to be real — and a file
    someone deleted from the project must fail by name, not by id."""
    meta = _post(client, token, "datasheet.md", b"# Datasheet\n\nDensity 0.915 kg/L.\n")

    r = client.get(f"/api/v1/files/attachments/{meta['id']}/path", headers=token)
    assert r.status_code == 200
    path = Path(r.json()["path"])
    assert path.is_file()
    assert path.read_bytes().startswith(b"# Datasheet")

    path.unlink()
    gone = client.get(f"/api/v1/files/attachments/{meta['id']}/path", headers=token)
    assert gone.status_code == 404
    assert "datasheet.md" in gone.json()["detail"]

    unknown = client.get("/api/v1/files/attachments/nope-nothing.pdf/path", headers=token)
    assert unknown.status_code == 404


# --- what a workbook may cost --------------------------------------------------------------------


def _sparse_xlsx(last_row: int) -> bytes:
    """Two cells, A1 and the last column of `last_row`, under a declared extent of A1:B2."""
    import io
    import zipfile

    sheet = (
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<dimension ref="A1:B2"/><sheetData>'
        '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>'
        f'<row r="{last_row}"><c r="XFD{last_row}" t="inlineStr"><is><t>z</t></is></c></row>'
        "</sheetData></worksheet>"
    )
    rels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    pkg = "http://schemas.openxmlformats.org/package/2006/relationships"
    members = {
        "[Content_Types].xml": (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
        ),
        "_rels/.rels": (
            f'<Relationships xmlns="{pkg}"><Relationship Id="rId1" '
            f'Type="{rels}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
        ),
        "xl/workbook.xml": (
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            f'xmlns:r="{rels}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            f'<Relationships xmlns="{pkg}"><Relationship Id="rId1" '
            f'Type="{rels}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
        ),
        "xl/worksheets/sheet1.xml": sheet,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in members.items():
            zf.writestr(name, body)
    return buf.getvalue()


def test_a_sparse_workbook_converts_only_what_fits(
    client: TestClient, token: dict[str, str], project: str, monkeypatch
) -> None:
    from prism_lca.engine import attachments

    def whole(*_args):
        raise AssertionError("the whole-workbook conversion must not run")

    monkeypatch.setattr(attachments, "_convert", whole)
    meta = _post(client, token, "sparse.xlsx", _sparse_xlsx(last_row=200))
    body = _text(client, token, meta["id"])
    assert body["truncated"] is True
    assert "| a |" in body["text"]
    assert len(body["text"]) < 10_000


def test_a_workbook_within_the_budget_converts_exactly_as_before(tmp_path) -> None:
    from prism_lca.engine import attachment_sheets, attachments

    path = tmp_path / "bom.xlsx"
    path.write_bytes(_xlsx(rows=40))
    assert attachment_sheets.rows_that_fit(path, attachment_sheets.MAX_CELLS) is None
    assert attachment_sheets.workbook_markdown(path, 100_000, attachments._convert) == attachments._convert(
        path, 100_000
    )


def test_a_workbook_over_the_budget_shows_the_same_beginning(tmp_path, monkeypatch) -> None:
    from prism_lca.engine import attachment_sheets, attachments

    monkeypatch.setattr(attachment_sheets, "MAX_CELLS", 300)
    path = tmp_path / "bom.xlsx"
    path.write_bytes(_xlsx(rows=400))
    text, truncated = attachment_sheets.workbook_markdown(path, 2_000, attachments._convert)
    assert truncated is True
    assert (text, truncated) == attachments._convert(path, 2_000)


def test_a_workbook_that_unpacks_beyond_the_limit_is_refused(
    client: TestClient, token: dict[str, str], project: str, monkeypatch
) -> None:
    from dataclasses import replace

    from prism_lca.engine import archive_limits

    monkeypatch.setattr(archive_limits, "OFFICE", replace(archive_limits.OFFICE, total=1_000))
    r = client.post(
        "/api/v1/files/attachments",
        json={"name": "bom.xlsx", "data_b64": base64.b64encode(_xlsx(rows=40)).decode("ascii")},
        headers=token,
    )
    assert r.status_code == 415
    assert "unpacks to more than" in r.json()["detail"]
