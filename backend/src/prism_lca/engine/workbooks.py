"""Spreadsheets at PrismLCA's edge: text written into a workbook that leaves stays text.

openpyxl stores a string that starts with "=" as a formula, and one that reads like an error value as that error.
"""
from __future__ import annotations

from openpyxl.cell.cell import TYPE_STRING, Cell


def text_cell(cell: Cell) -> Cell:
    """A string value stays a string cell, never a formula or an error value."""
    if isinstance(cell.value, str):
        cell.data_type = TYPE_STRING
    return cell


def put(ws, row: int, column: int, value) -> Cell:  # noqa: ANN001 - openpyxl worksheet, cell value
    """``ws.cell(row, column, value)`` with text kept as text."""
    return text_cell(ws.cell(row, column, value))


def append(ws, values) -> None:  # noqa: ANN001 - openpyxl worksheet, iterable of cell values
    """``ws.append(values)`` with text kept as text."""
    ws.append([text_cell(Cell(ws, value=value)) for value in values])
