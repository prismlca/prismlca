"""Workbooks read from a file: their size is what they hold, measured before and while they are read."""
from __future__ import annotations

import asyncio
import base64
import io
import threading
import uuid
import zipfile

import httpx
import pytest
from openpyxl import Workbook
from openpyxl.utils import get_column_letter

from prism_lca.engine import interop, scenarios, workbooks
from prism_lca.errors import PrismError

_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def _row(number: int, *values) -> str:
    cells = []
    for i, value in enumerate(values):
        ref = f"{get_column_letter(i + 1)}{number}"
        if value is None:
            continue
        if isinstance(value, str):
            cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>')
        else:
            cells.append(f'<c r="{ref}"><v>{value}</v></c>')
    return f'<row r="{number}">{"".join(cells)}</row>'


def _sheet(rows: str, dimension: str | None = None) -> bytes:
    dim = f'<dimension ref="{dimension}"/>' if dimension else ""
    return f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{_NS}">{dim}<sheetData>{rows}</sheetData></worksheet>'.encode()


def _workbook(sheets: dict[str, bytes], parts: dict[str, bytes] | None = None) -> bytes:
    """A workbook openpyxl wrote, with the given sheets (in order) and any other parts put in."""
    wb = Workbook()
    for i, name in enumerate(sheets):
        ws = wb.active if i == 0 else wb.create_sheet()
        ws.title = name
    buf = io.BytesIO()
    wb.save(buf)
    replace = {f"xl/worksheets/sheet{i + 1}.xml": xml for i, xml in enumerate(sheets.values())}
    replace.update(parts or {})
    src = zipfile.ZipFile(io.BytesIO(buf.getvalue()))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in src.namelist():
            z.writestr(name, replace.pop(name, None) or src.read(name))
        for name, data in replace.items():
            z.writestr(name, data)
    return out.getvalue()


_ACTIVITIES = _row(1, "code", "name", "unit")


def _model(activity_rows: str, dimension: str | None = None) -> bytes:
    return _workbook({"activities": _sheet(activity_rows, dimension), "exchanges": _sheet("")})


def _refusal(read, content: bytes) -> str:
    with pytest.raises(PrismError) as info:
        read(content)
    return info.value.code


# --------------------------------------------------------------------------- #
# Rows and cells
# --------------------------------------------------------------------------- #


def test_rows_follow_the_content_not_the_declared_size() -> None:
    content = _model(_ACTIVITIES + _row(2, "a1", "steel", "kg") + '<row r="5000"/>', dimension="A1:XFD5000")
    parsed = interop.read_model_workbook(content)
    assert parsed["activities"] == [
        {"code": "a1", "name": "steel", "unit": "kg", "location": None, "reference_product": None,
         "comment": None, "tags": None}
    ]
    wb = workbooks.open_untrusted(content)
    try:
        widths = {len(row) for row in workbooks.rows(wb["activities"], 3)}
    finally:
        wb.close()
    assert widths == {3}


def test_rows_past_the_last_sheet_row_are_refused() -> None:
    content = _model(_ACTIVITIES + _row(2, "a1", "steel", "kg") + _row(workbooks.MAX_ROWS + 1, "a2", "x", "kg"))
    assert _refusal(interop.read_model_workbook, content) == "sheet_too_large"


def test_a_row_holds_at_most_a_sheet_width_of_cells() -> None:
    wide = '<row r="2">' + "<c/>" * (workbooks.MAX_COLUMNS + 1) + "</row>"
    assert _refusal(interop.read_model_workbook, _model(_ACTIVITIES + wide)) == "sheet_too_large"
    full = '<row r="2">' + "<c/>" * workbooks.MAX_COLUMNS + "</row>"
    assert interop.read_model_workbook(_model(_ACTIVITIES + full))["activities"] == []


# --------------------------------------------------------------------------- #
# Parts
# --------------------------------------------------------------------------- #


def test_parts_are_bounded_in_number_and_size(monkeypatch) -> None:
    content = _model(_ACTIVITIES + _row(2, "a1", "steel", "kg"))
    assert interop.read_model_workbook(content)["activities"]
    with monkeypatch.context() as m:
        m.setattr(workbooks, "MAX_PARTS", 3)
        assert _refusal(interop.read_model_workbook, content) == "sheet_too_large"
    with monkeypatch.context() as m:
        m.setattr(workbooks, "MAX_PART_BYTES", 500)
        assert _refusal(interop.read_model_workbook, content) == "sheet_too_large"
    with monkeypatch.context() as m:
        m.setattr(workbooks, "MAX_TOTAL_BYTES", 2_000)
        assert _refusal(interop.read_model_workbook, content) == "sheet_too_large"


def test_xml_parts_are_bounded_in_elements(monkeypatch) -> None:
    rows = _ACTIVITIES + "".join(_row(n, f"a{n}", "steel", "kg") for n in range(2, 40))
    content = _model(rows)
    assert len(interop.read_model_workbook(content)["activities"]) == 38
    with monkeypatch.context() as m:
        m.setattr(workbooks, "MAX_STREAMED_ELEMENTS", 100)
        assert _refusal(interop.read_model_workbook, content) == "sheet_too_large"
    with monkeypatch.context() as m:
        m.setattr(workbooks, "MAX_OTHER_ELEMENTS", 10)  # styles.xml alone has more
        assert _refusal(interop.read_model_workbook, content) == "sheet_too_large"
    with monkeypatch.context() as m:
        m.setattr(workbooks, "MAX_TOTAL_ELEMENTS", 150)
        assert _refusal(interop.read_model_workbook, content) == "sheet_too_large"


@pytest.mark.parametrize("renamed", ["xl/worksheets/sheet1.XML", "xl/worksheets/sheet1.bin", "xl/data.bin"])
def test_every_part_is_measured_whatever_its_name(renamed: str) -> None:
    wide = '<row r="2">' + "<c/>" * (workbooks.MAX_COLUMNS + 1) + "</row>"
    content = _model(_ACTIVITIES + wide)
    src = zipfile.ZipFile(io.BytesIO(content))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in src.namelist():
            data = src.read(name)
            if name == "xl/_rels/workbook.xml.rels":
                data = data.replace(b"/xl/worksheets/sheet1.xml", f"/{renamed}".encode())
            z.writestr(renamed if name == "xl/worksheets/sheet1.xml" else name, data)
    assert _refusal(interop.read_model_workbook, out.getvalue()) == "sheet_too_large"


def test_xml_parts_carry_no_document_type() -> None:
    doctype = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "x">]><x>&e;</x>'
    content = _workbook({"activities": _sheet(_ACTIVITIES), "exchanges": _sheet("")}, {"docProps/extra.xml": doctype})
    assert _refusal(interop.read_model_workbook, content) == "sheet_unreadable"


def test_a_part_that_does_not_parse_is_left_to_the_reader() -> None:
    # A broken part the reader never opens does not make the workbook unreadable.
    content = _workbook(
        {"activities": _sheet(_ACTIVITIES + _row(2, "a1", "steel", "kg")), "exchanges": _sheet("")},
        {"customXml/item1.xml": b"<a><b></a>"},
    )
    assert interop.read_model_workbook(content)["activities"][0]["code"] == "a1"


# --------------------------------------------------------------------------- #
# The model sheet
# --------------------------------------------------------------------------- #


def test_a_model_sheet_has_a_row_limit(monkeypatch) -> None:
    content = _model(_ACTIVITIES + "".join(_row(n, f"a{n}", "steel", "kg") for n in range(2, 5)))
    monkeypatch.setattr(interop, "MAX_SHEET_ROWS", 3)
    assert len(interop.read_model_workbook(content)["activities"]) == 3
    monkeypatch.setattr(interop, "MAX_SHEET_ROWS", 2)
    assert _refusal(interop.read_model_workbook, content) == "sheet_too_large"


def test_the_columns_a_model_sheet_reads_sit_within_the_column_limit() -> None:
    limit = interop.MAX_SHEET_COLUMNS
    at_edge = _row(1, "code", "name", *([None] * (limit - 3)), "unit") + _row(2, "a1", "steel", *([None] * (limit - 3)), "kg")
    assert interop.read_model_workbook(_model(at_edge))["activities"][0]["unit"] == "kg"
    beyond = _row(1, "code", "name", *([None] * (limit - 2)), "unit") + _row(2, "a1", "steel")
    assert _refusal(interop.read_model_workbook, _model(beyond)) == "sheet_too_large"


# --------------------------------------------------------------------------- #
# The scenario workbook
# --------------------------------------------------------------------------- #


def _scenario_book(rows: str) -> bytes:
    return _workbook({"scenarios": _sheet(rows)})


def test_a_scenario_workbook_reads_as_before() -> None:
    content = _scenario_book(_row(1, "parameter", "High", "Low") + _row(2, "mass", 5, 1) + _row(3, "eff", 20) + '<row r="900"/>')
    assert scenarios.parse_scenarios_workbook(content) == [
        {"name": "High", "overrides": {"mass": 5.0, "eff": 20.0}},
        {"name": "Low", "overrides": {"mass": 1.0}},
    ]
    assert _refusal(scenarios.parse_scenarios_workbook, _scenario_book("")) == "empty_import"


def test_a_scenario_workbook_has_a_column_and_a_row_limit(monkeypatch) -> None:
    limit = scenarios.MAX_SCENARIO_SHEET_COLUMNS
    assert scenarios.parse_scenarios_workbook(_scenario_book(_row(1, "parameter", *([None] * (limit - 2)), "Last")))
    assert _refusal(scenarios.parse_scenarios_workbook, _scenario_book(_row(1, "parameter", *([None] * (limit - 1)), "Beyond"))) == "sheet_too_large"
    content = _scenario_book(_row(1, "parameter", "High") + "".join(_row(n, f"p{n}", n) for n in range(2, 6)))
    monkeypatch.setattr(scenarios, "MAX_SCENARIO_SHEET_ROWS", 4)
    assert len(scenarios.parse_scenarios_workbook(content)[0]["overrides"]) == 4
    monkeypatch.setattr(scenarios, "MAX_SCENARIO_SHEET_ROWS", 3)
    assert _refusal(scenarios.parse_scenarios_workbook, content) == "sheet_too_large"


# --------------------------------------------------------------------------- #
# Through the API
# --------------------------------------------------------------------------- #


def test_the_import_routes_name_the_limit(client, token, project, monkeypatch) -> None:
    monkeypatch.setattr(workbooks, "MAX_PARTS", 3)
    content = base64.b64encode(_model(_ACTIVITIES + _row(2, "a1", "steel", "kg"))).decode("ascii")
    r = client.post("/api/v1/interop/model/import", json={"name": "Sheet", "content": content}, headers=token)
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "sheet_too_large"
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    book = base64.b64encode(_scenario_book(_row(1, "parameter", "High") + _row(2, "p", 1))).decode("ascii")
    r = client.post("/api/v1/scenarios/import", json={"database": db, "xlsx_base64": book}, headers=token)
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "sheet_too_large"


def test_reading_a_model_sheet_leaves_the_event_loop_free(client, token, project, monkeypatch) -> None:
    inside, release = threading.Event(), threading.Event()

    def slow_read(_content: bytes) -> dict:
        inside.set()
        release.wait(20)
        return {"activities": [], "exchanges": []}

    monkeypatch.setattr(interop, "read_model_workbook", slow_read)
    content = base64.b64encode(b"sheet").decode("ascii")

    async def drive() -> None:
        transport = httpx.ASGITransport(app=client.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://prism") as ac:
            slow = asyncio.create_task(
                ac.post("/api/v1/interop/model/import", json={"name": "Sheet", "content": content},
                        headers=token, timeout=60)
            )
            await asyncio.to_thread(inside.wait, 20)
            assert inside.is_set(), "the read never started"
            health = await ac.get("/api/v1/system/health")
            assert health.status_code == 200
            assert not slow.done()
            release.set()
            r = await slow
            assert r.json()["error"]["code"] == "sheet_empty"

    asyncio.run(drive())

