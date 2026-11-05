"""A workbook attached to a chat, as Markdown — converted only as far as an extract can show.

A conversion costs what the table pandas builds holds, so that table is measured before it is built. A
workbook within the budget converts exactly as markitdown converts it; a larger one converts the leading
rows that fit, through the same pandas and HTML steps. The budget is more than one extract may return, so
the model still reads the beginning of the workbook, and the extract says it was cut.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pandas as pd
from markitdown.converters import HtmlConverter
from openpyxl import load_workbook

#: Cells a conversion may touch: a table this size is already longer than `MAX_EXTRACT_CHARS`.
MAX_CELLS = 50_000


def rows_that_fit(path: Path, budget: int) -> list[tuple[str, int]] | None:
    """How many leading rows of each sheet fit the budget, or None when the whole workbook does.

    Counts what pandas will build — rows up to the last one with a value, each as wide as the widest — and
    every cell and row openpyxl yields on the way, empty or not.
    """
    book = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    try:
        plan: list[tuple[str, int]] = []
        left = budget
        for name in book.sheetnames:
            sheet = book[name]
            if not hasattr(sheet, "reset_dimensions"):
                plan.append((name, 0))  # a chart sheet holds no cells
                continue
            sheet.reset_dimensions()  # the extent the file declares is not what it holds
            seen = width = with_data = 0
            for index, row in enumerate(sheet.iter_rows(values_only=True)):
                used = len(row)
                while used and row[used - 1] in (None, ""):
                    used -= 1
                cost = seen + max(len(row), 1)
                grid = (index + 1) * max(width, used) if used else with_data * width
                if max(cost, grid) > left:
                    plan.append((name, index))
                    return plan
                seen = cost
                if used:
                    width, with_data = max(width, used), index + 1
            plan.append((name, with_data))
            left -= max(seen, with_data * width)
        return None
    finally:
        book.close()


def leading_rows(path: Path, plan: list[tuple[str, int]]) -> str:
    """The planned rows of each sheet as markitdown's xlsx converter writes a whole sheet."""
    html = HtmlConverter()
    parts: list[str] = []
    with pd.ExcelFile(path, engine="openpyxl") as book:
        for name, rows in plan:
            if rows <= 0:
                continue
            frame = book.parse(name, nrows=rows - 1)  # the first row is the header
            table = html.convert_string(frame.to_html(index=False)).markdown.strip()
            parts.append(f"## {name}\n{table}")
    return "\n\n".join(parts)


def workbook_markdown(
    path: Path, limit: int, whole: Callable[[Path, int], tuple[str, bool]]
) -> tuple[str, bool]:
    """`whole(path, limit)` for a workbook within the budget, its leading rows for any other."""
    try:
        plan = rows_that_fit(path, MAX_CELLS)
    except Exception:  # noqa: BLE001 - a workbook openpyxl cannot open fails in the converter, as before
        plan = None
    if plan is None:
        return whole(path, limit)
    return leading_rows(path, plan)[:limit], True
