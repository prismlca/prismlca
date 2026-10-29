"""Tabular export of results (CSV / JSON / XLSX).

Turns the compact ``meta+lookups+tree`` result envelopes into flat tables an analyst can open
in Excel. openpyxl ships with bw2io, so XLSX needs no extra dependency. JSON returns the raw
envelope untouched (lossless); CSV/XLSX flatten it into rows.
"""
from __future__ import annotations

import csv
import io

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

_CONTRIB_HEADERS = ["depth", "code", "name", "location", "amount", "unit", "impact", "direct", "share"]
_LCIA_HEADERS = ["method", "unit", "score"]


def contribution_rows(contribution: dict) -> tuple[list[str], list[list]]:
    """Depth-first flatten of a contribution tree into one row per node."""
    rows: list[list] = []

    def walk(node: dict, depth: int) -> None:
        rows.append(
            [depth, node.get("c"), node.get("n"), node.get("g"), node.get("a"),
             node.get("u"), node.get("imp"), node.get("dir"), node.get("shr")]
        )
        for child in node.get("ch", []):
            walk(child, depth + 1)

    tree = contribution.get("tree")
    if tree:
        walk(tree, 0)
    return _CONTRIB_HEADERS, rows


def lcia_rows(lcia: dict) -> tuple[list[str], list[list]]:
    from prism_lca.engine.lca import _sig

    # ' · ' matches how methods are displayed everywhere else; scores trimmed to significant
    # figures instead of full float repr (…16 decimals) for readable CSV/XLSX cells.
    rows = [
        [" · ".join(r.get("method", [])), r.get("unit"),
         _sig(r.get("score")) if isinstance(r.get("score"), (int, float)) else r.get("score")]
        for r in lcia.get("results", [])
    ]
    return _LCIA_HEADERS, rows


def rows_to_csv(headers: list[str], rows: list[list]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    writer.writerows(rows)
    return buf.getvalue()


def compare_xlsx(columns: list[dict], subjects: list[dict], group_header: str | None = None) -> bytes:
    """Styled results matrix. ``columns`` = [{key, family, label, unit}] (already ordered, grouped
    by family); ``subjects`` = [{label, scores: {key: value}}]. Two header rows (family span +
    indicator/unit), bold subject column, banded rows, the house colours, frozen header + first column.

    With ``group_header`` the sheet is **disaggregated**: a second identity column carries the part
    of the subject each row is — a life-cycle phase, an ISIC section — and the row that sums them
    carries ``total: True`` and is set in bold above a rule. The subject name repeats on every one of
    its rows rather than being merged down the column, because a merged cell is what stops a
    spreadsheet from sorting, filtering or pivoting the sheet, which is the whole reason to want the
    rows apart.
    """
    NAVY, LIGHT, BAND = "2F4E66", "EFF4E1", "F7F7F7"
    thin = Side(style="thin", color="DDDDDD")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    right = Alignment(horizontal="right", vertical="center")
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)

    wb = Workbook()
    ws = wb.active
    ws.title = "Results"

    # Identity columns: the subject, and — disaggregated — what part of it the row is.
    id_cols = 2 if group_header else 1
    for idx, title in enumerate(["Subject"] + ([group_header] if group_header else [])):
        ws.merge_cells(start_row=1, start_column=1 + idx, end_row=2, end_column=1 + idx)
        c = ws.cell(1, 1 + idx, title)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor=NAVY)
        c.alignment = center

    # Row 1: family group headers (merged across each family's columns).
    col = 1 + id_cols
    i = 0
    while i < len(columns):
        fam = columns[i]["family"]
        span = 1
        while i + span < len(columns) and columns[i + span]["family"] == fam:
            span += 1
        cell = ws.cell(1, col, fam)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=NAVY)
        cell.alignment = center
        cell.border = border
        if span > 1:
            ws.merge_cells(start_row=1, start_column=col, end_row=1, end_column=col + span - 1)
        i += span
        col += span

    # Row 2: indicator label + unit per column.
    for j, colinfo in enumerate(columns):
        cell = ws.cell(2, 1 + id_cols + j, f"{colinfo['label']}\n[{colinfo.get('unit') or ''}]")
        cell.font = Font(bold=True, color=NAVY)
        cell.fill = PatternFill("solid", fgColor=LIGHT)
        cell.alignment = center
        cell.border = border

    # Body: one row per subject, or — disaggregated — one per part plus the row that sums them.
    top_rule = Border(left=thin, right=thin, top=Side(style="thin", color=NAVY), bottom=thin)
    for r, subj in enumerate(subjects):
        row = 3 + r
        is_total = bool(subj.get("total"))
        # Band by SUBJECT, not by row: with five phases under each subject, banding every other row
        # stripes the block and hides where one subject ends and the next begins.
        band = None
        if group_header:
            seen = {s.get("label") for s in subjects[:r]}
            band = PatternFill("solid", fgColor=BAND) if len(seen) % 2 else None
        elif r % 2:
            band = PatternFill("solid", fgColor=BAND)
        cells = [ws.cell(row, 1, subj.get("label"))]
        if group_header:
            cells.append(ws.cell(row, 2, subj.get("group") or ""))
        for cell in cells:
            cell.font = Font(bold=True) if (cell.column == 1 or is_total) else Font()
            cell.alignment = left
            cell.border = top_rule if is_total else border
            if band:
                cell.fill = band
        for j, colinfo in enumerate(columns):
            v = subj.get("scores", {}).get(colinfo["key"])
            cell = ws.cell(row, 1 + id_cols + j, v if isinstance(v, (int, float)) else None)
            cell.number_format = "0.000E+00"
            cell.alignment = right
            cell.border = top_rule if is_total else border
            if is_total:
                cell.font = Font(bold=True)
            if band:
                cell.fill = band

    # Column widths + freeze.
    ws.column_dimensions["A"].width = 34
    if group_header:
        ws.column_dimensions["B"].width = 26
    for j in range(len(columns)):
        ws.column_dimensions[get_column_letter(1 + id_cols + j)].width = 15
    ws.row_dimensions[2].height = 34
    ws.freeze_panes = f"{get_column_letter(1 + id_cols)}3"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def flows_xlsx(meta: dict, flows: list[dict]) -> bytes:
    """Elementary-flow contributions as a small styled sheet: meta rows (scope, method, total),
    then a Flow | Categories | Share | Impact table in the given (display) order."""
    NAVY, BAND = "2F4E66", "F7F7F7"
    thin = Side(style="thin", color="DDDDDD")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center")
    right = Alignment(horizontal="right", vertical="center")

    wb = Workbook()
    ws = wb.active
    ws.title = "Elementary flows"
    unit = meta.get("unit") or ""

    metas = [
        ("Scope", meta.get("scope")),
        ("Method", " · ".join(meta.get("method") or [])),
        (f"Total [{unit}]", meta.get("total")),
    ]
    for i, (label, value) in enumerate(metas, start=1):
        ws.cell(i, 1, label).font = Font(bold=True, color=NAVY)
        cell = ws.cell(i, 2, value)
        if isinstance(value, (int, float)):
            cell.number_format = "0.000E+00"

    head_row = 5
    for j, header in enumerate(["Flow", "Categories", "Share", f"Impact [{unit}]"], start=1):
        cell = ws.cell(head_row, j, header)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=NAVY)
        cell.alignment = center
        cell.border = border

    for r, flow in enumerate(flows):
        row = head_row + 1 + r
        band = PatternFill("solid", fgColor=BAND) if r % 2 else None
        cells = [
            ws.cell(row, 1, flow.get("flow")),
            ws.cell(row, 2, " / ".join(flow.get("categories") or [])),
            ws.cell(row, 3, flow.get("share")),
            ws.cell(row, 4, flow.get("impact")),
        ]
        cells[2].number_format = "0.0%"
        cells[3].number_format = "0.000E+00"
        cells[2].alignment = right
        cells[3].alignment = right
        for cell in cells:
            cell.border = border
            if band:
                cell.fill = band

    ws.column_dimensions["A"].width = 40
    ws.column_dimensions["B"].width = 34
    ws.column_dimensions["C"].width = 10
    ws.column_dimensions["D"].width = 16
    ws.freeze_panes = f"A{head_row + 1}"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def lcia_factors_xlsx(methods: list[dict], flows: list[dict]) -> bytes:
    """Characterisation-factor comparison: Flow | Categories | Unit, then one CF column per
    indicator. Cells with no factor for a method are left blank (that method doesn't cover the
    flow). ``flows`` rows carry a ``factors`` list aligned to ``methods``."""
    NAVY, BAND = "2F4E66", "F7F7F7"
    thin = Side(style="thin", color="DDDDDD")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center")
    right = Alignment(horizontal="right", vertical="center")

    wb = Workbook()
    ws = wb.active
    ws.title = "Characterization factors"

    headers = ["Flow", "Categories", "Unit"] + [
        f"{' · '.join(m.get('method', [])[1:]) or m.get('name', '')} [{m.get('unit') or ''}]"
        for m in methods
    ]
    for j, header in enumerate(headers, start=1):
        cell = ws.cell(1, j, header)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=NAVY)
        cell.alignment = center
        cell.border = border

    for r, flow in enumerate(flows):
        row = 2 + r
        band = PatternFill("solid", fgColor=BAND) if r % 2 else None
        cells = [
            ws.cell(row, 1, flow.get("flow")),
            ws.cell(row, 2, " / ".join(flow.get("categories") or [])),
            ws.cell(row, 3, flow.get("unit")),
        ]
        for k, factor in enumerate(flow.get("factors") or []):
            c = ws.cell(row, 4 + k, factor if isinstance(factor, (int, float)) else None)
            c.number_format = "0.000E+00"
            c.alignment = right
            cells.append(c)
        for cell in cells:
            cell.border = border
            if band:
                cell.fill = band

    ws.column_dimensions["A"].width = 44
    ws.column_dimensions["B"].width = 30
    ws.column_dimensions["C"].width = 8
    for k in range(len(methods)):
        ws.column_dimensions[get_column_letter(4 + k)].width = 18
    ws.freeze_panes = "D2"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def rows_to_xlsx(headers: list[str], rows: list[list], sheet_name: str = "Sheet1") -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name[:31] or "Sheet1"
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
