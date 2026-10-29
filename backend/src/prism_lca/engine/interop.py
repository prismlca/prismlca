"""Foreground-model interchange via Excel (M20 roundtrip / M21 interop base).

A foreground model is written to / read from a two-sheet workbook — ``activities`` and
``exchanges`` — that is trivial to author by hand. This is also the landing pipeline for foreign
formats (openLCA JSON-LD, SimaPro CSV): a format adapter only has to produce these two row lists,
and the same validated, atomic, undoable import applies.

**What it does and does not carry.** The docstring used to say "round-trips losslessly",
and that was true of the skeleton only: a parameterised amount came back as a bare number, and the
uncertainty distribution and the tags were dropped without a word. The sheets now carry the
``formula``, the distribution parameters and the tags as well. Still not in here, deliberately: the
report definitions, the scenarios, the canvas arrangement — a spreadsheet is the wrong shape for
those, and `engine/bundle.py` is what carries a whole model.

Import is atomic: every exchange input must resolve (to an activity being created in the same
sheet, or an existing activity/flow) *before* anything is written — otherwise the whole import
is rejected with the offending rows, so a half-linked model never lands (the bw2io failure mode).
"""
from __future__ import annotations

import io

from openpyxl import Workbook, load_workbook

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.model import _db_or_404

_ACT_HEADERS = ["code", "name", "unit", "location", "reference_product", "comment", "tags"]
#: `formula` and the four uncertainty columns are what the old sheet silently dropped. `pedigree` is
#: written as text because that is how a reviewer reads it; it is re-parsed on import.
_EXC_HEADERS = ["activity_code", "input_database", "input_code", "amount", "type", "formula",
                "comment", "uncertainty_type", "loc", "scale", "minimum", "maximum", "tags"]


def _production_row_needed(ex) -> bool:
    """Whether a production exchange has to travel in the sheet.

    The import gives every activity a production exchange of 1 on its own, so the ordinary case
    stays implicit — the sheet is meant to be authored by hand, and a row per activity saying "1"
    would be noise. What must travel is everything the import could not reinvent: an amount other
    than 1 (a process making 2 kg came back making 1 kg, with its emissions unchanged — the balance
    per unit doubled), a formula, or a distribution."""
    if float(ex.get("amount") or 0.0) != 1.0:
        return True
    return bool(ex.get("formula")) or ex.get("uncertainty type") not in (None, 0, "")


def model_to_workbook(database: str) -> bytes:
    """Serialize a foreground database's activities + non-production exchanges to XLSX bytes."""
    bd = get_bd()
    database = _db_or_404(bd, database)
    db = bd.Database(database)

    wb = Workbook()
    aws = wb.active
    aws.title = "activities"
    aws.append(_ACT_HEADERS)
    ews = wb.create_sheet("exchanges")
    ews.append(_EXC_HEADERS)

    from prism_lca.engine.tags import TagStore

    tag_store = TagStore()
    for act in db:
        # Tags as "dimension=value; dimension=value" — one cell, readable, and parseable back.
        tags = "; ".join(
            f"{t['dimension']}={t['value']}" for t in tag_store.list_for(database, act.key[1])
        )
        aws.append([act.key[1], act.get("name"), act.get("unit"), act.get("location"),
                    act.get("reference product"), act.get("comment"), tags])
        for ex in act.exchanges():
            if ex.get("type") == "production" and not _production_row_needed(ex):
                continue
            inp = ex.input
            # An input's own tags (keyed by its uid), in the same one-cell form as a process's.
            own = tag_store.list_for(database, TagStore.exchange_code(act.key[1], ex["prism_uid"])) if (
                ex.get("prism_uid")) else []
            ews.append([act.key[1], inp.key[0], inp.key[1], ex.get("amount"), ex.get("type"),
                        ex.get("formula"), ex.get("comment"), ex.get("uncertainty type"),
                        ex.get("loc"), ex.get("scale"), ex.get("minimum"), ex.get("maximum"),
                        "; ".join(f"{t['dimension']}={t['value']}" for t in own)])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def read_model_workbook(content: bytes) -> dict:
    """Parse an XLSX (activities + exchanges sheets) into row dicts.

    Columns are matched BY HEADER NAME, not position — a hand-reordered sheet must not silently
    swap fields. Unknown header cells are ignored; known headers missing from the sheet yield
    None (and the import validation reports what's actually missing)."""
    wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)

    def rows(sheet_name: str, headers: list[str]) -> list[dict]:
        if sheet_name not in wb.sheetnames:
            return []
        ws = wb[sheet_name]
        out = []
        col_of: dict[str, int] = {}
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i == 0:
                # Header row: map each known header to the column it actually occupies.
                for j, cell in enumerate(row or ()):
                    name = str(cell).strip().lower() if cell is not None else ""
                    if name in headers:
                        col_of[name] = j
                # Legacy sheets without a recognisable header row: fall back to positional.
                if not col_of:
                    col_of = {h: j for j, h in enumerate(headers)}
                continue
            if row is None or all(c is None for c in row):
                continue
            out.append({
                h: (row[col_of[h]] if h in col_of and col_of[h] < len(row) else None)
                for h in headers
            })
        return out

    return {
        "activities": rows("activities", _ACT_HEADERS),
        "exchanges": rows("exchanges", _EXC_HEADERS),
    }
