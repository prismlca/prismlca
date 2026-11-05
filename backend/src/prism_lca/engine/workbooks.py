"""Spreadsheets at PrismLCA's edge: workbooks read from a file, and text written into a workbook that leaves.

Reading: a workbook from a file is untrusted input; its size is what it holds (parts, bytes, XML elements, cells
per row, rows), measured before and while openpyxl reads it, never what it declares.
Writing: text stays text. openpyxl stores a string that starts with "=" as a formula, and one that reads like
an error value as that error.
"""
from __future__ import annotations

import io
import xml.parsers.expat
import zipfile
import zlib
from collections.abc import Iterator

from openpyxl import load_workbook
from openpyxl.cell.cell import TYPE_STRING, Cell

from prism_lca.errors import PrismError

#: Excel's own sheet size: no spreadsheet application writes a row or a cell beyond it.
MAX_ROWS = 1_048_576
MAX_COLUMNS = 16_384

#: What one workbook may unpack to.
MAX_PARTS = 1_000
MAX_PART_BYTES = 64 * 2**20
MAX_TOTAL_BYTES = 256 * 2**20
#: XML elements per part: the parts openpyxl reads row by row, every other part (it builds those whole), and
#: all parts together. An exported model of 75,000 exchanges stays within the first.
MAX_STREAMED_ELEMENTS = 2_000_000
MAX_OTHER_ELEMENTS = 200_000
MAX_TOTAL_ELEMENTS = 4_000_000

_HINT = "Split it into smaller files, or move a whole model as a .prism bundle."


def too_large(message: str, hint: str = _HINT) -> PrismError:
    return PrismError(message, code="sheet_too_large", hint=hint)


def _streamed(name: str) -> bool:
    name = name.lower()
    return (name.startswith("xl/worksheets/") and name.endswith(".xml")) or name == "xl/sharedstrings.xml"


class _Scan:
    """Counts one XML part's elements and the cells of each row, refusing the part past a bound."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.elements = 0
        self.depth = 0
        self.row_depth = 0  # depth of the open row element, 0 = none
        self.cells = 0

    def start(self, name: str, _attrs) -> None:  # noqa: ANN001 - expat attribute dict
        self.depth += 1
        self.elements += 1
        if self.elements > self.limit:
            raise too_large("This spreadsheet holds more than PrismLCA reads from one file.")
        if self.row_depth and self.depth == self.row_depth + 1:
            self.cells += 1
            if self.cells > MAX_COLUMNS:
                raise too_large(f"A row of this spreadsheet has more than {MAX_COLUMNS:,} cells.")
        elif not self.row_depth and name.rpartition(":")[2] == "row":
            self.row_depth, self.cells = self.depth, 0

    def end(self, _name: str) -> None:
        if self.depth == self.row_depth:
            self.row_depth = 0
        self.depth -= 1


def _doctype(*_args) -> None:
    raise PrismError(
        "This file is not a spreadsheet PrismLCA can read.",
        code="sheet_unreadable",
        hint="Choose an .xlsx file saved by a spreadsheet application.",
    )


def _scan_part(zf: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> int:
    scan = _Scan(limit)
    parser = xml.parsers.expat.ParserCreate()
    parser.StartElementHandler = scan.start
    parser.EndElementHandler = scan.end
    parser.StartDoctypeDeclHandler = _doctype
    try:
        with zf.open(info) as source:
            parser.ParseFile(source)
    except (xml.parsers.expat.ExpatError, zipfile.BadZipFile, zlib.error, EOFError, RuntimeError,
            NotImplementedError):
        # A part that does not parse stops here as it stops openpyxl: what came before it is counted.
        pass
    return scan.elements


def _measure(content: bytes) -> None:
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except (zipfile.BadZipFile, OSError, ValueError):
        return  # not a zip at all: openpyxl gives its own error
    with zf:
        parts = zf.infolist()
        if (
            len(parts) > MAX_PARTS
            or any(p.file_size > MAX_PART_BYTES for p in parts)
            or sum(p.file_size for p in parts) > MAX_TOTAL_BYTES
        ):
            raise too_large(
                "This spreadsheet unpacks to more than PrismLCA reads from one file.",
                hint=f"At most {MAX_PARTS:,} parts, {MAX_PART_BYTES // 2**20} MB each, "
                f"{MAX_TOTAL_BYTES // 2**20} MB in all.",
            )
        # zipfile stops every part at its declared size, so the bytes above are the bytes read. Every part
        # is scanned, whatever its name: the reader finds its parts through relationships, not extensions.
        total = 0
        for part in parts:
            if part.is_dir():
                continue
            limit = MAX_STREAMED_ELEMENTS if _streamed(part.filename) else MAX_OTHER_ELEMENTS
            total += _scan_part(zf, part, min(limit, MAX_TOTAL_ELEMENTS - total))


def open_untrusted(content: bytes):  # noqa: ANN201 - openpyxl's read-only Workbook
    """A read-only workbook from a file, after its parts were measured. The caller closes it."""
    _measure(content)
    return load_workbook(io.BytesIO(content), read_only=True, data_only=True)


def header(ws) -> tuple | None:  # noqa: ANN001 - openpyxl read-only worksheet
    """Row 1, as wide as it is; None for a sheet without any rows."""
    return next(ws.iter_rows(min_row=1, max_row=1, values_only=True), None)


def rows(ws, width: int) -> Iterator[tuple]:  # noqa: ANN001 - openpyxl read-only worksheet
    """Rows 2 onward, each exactly ``width`` values, whatever size the sheet declares."""
    numbered = ws.iter_rows(min_row=2, max_row=MAX_ROWS + 1, max_col=max(1, width), values_only=True)
    for number, row in enumerate(numbered, start=2):
        if number > MAX_ROWS:
            raise too_large(f"This spreadsheet reaches past row {MAX_ROWS:,}, the last row a sheet has.")
        yield row


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
