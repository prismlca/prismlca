"""Foreground-model interchange endpoints (Excel export + atomic import)."""
from __future__ import annotations

import base64
import binascii

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import commands, interop, lca, model_scope
from prism_lca.errors import PrismError

router = APIRouter(prefix="/interop", tags=["interop"], dependencies=[Depends(require_token)])

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _safe(stem: str) -> str:
    """Header-safe download filename (database names are user-controlled)."""
    import re

    return re.sub(r"[^A-Za-z0-9._-]", "_", stem)[:100] or "model"


#: What a spreadsheet cannot take with it. Returned by `/interop/loses`, so the dialog offering this
#: export can name it — an export that quietly leaves half the work behind is a trap, and the list has
#: to live next to the exporter or the two drift apart.
LOSES = [
    "Parameters and their value rules",
    "Scenarios",
    "Goal & scope (the study metadata)",
    "Report definitions",
    "The canvas arrangement and its colours",
    "Assistant conversations and the change history",
]


@router.get("/loses", summary="What the Brightway/Excel export does not carry")
def loses() -> dict:
    """For the dialog: what stays behind, and what to use instead.

    In the response rather than only in the UI, so the warning cannot quietly disappear in a redesign
    of the dialog while the export keeps losing the same things.
    """
    return {
        "loses": LOSES,
        "carries": ["Processes and their flows", "Formulas on amounts", "Uncertainty distributions",
                    "Exchange comments", "Tags"],
        "instead": "Export as a .prism bundle to keep everything; this sheet is for Brightway and the "
                   "Activity Browser, which know nothing about the rest.",
    }


@router.get("/model/{database}", summary="Export a foreground model as XLSX (activities + exchanges)")
def export_model(database: str) -> Response:
    with lca._LCA_LOCK:  # see bundle export: never read a model inside a scenario window
        data = interop.model_to_workbook(database)
    return Response(
        content=data,
        media_type=_XLSX_MEDIA,
        headers={
            "Content-Disposition": f'attachment; filename="{_safe(database)}_model.xlsx"',
            # Named in the response too: a client that only ever looks at headers still sees it.
            "X-Prism-Export-Loses": "; ".join(LOSES),
        },
    )


@router.post("/model", summary="Import a foreground model from XLSX (atomic; rejects unlinked)")
async def import_model(
    request: Request,
    target_database: str = Form(...),
    source: str = Form("import"),
    file: UploadFile = File(...),
) -> dict:
    content = await file.read()
    parsed = interop.read_model_workbook(content)
    cmd = commands.ImportModelCommand(target_database, parsed["activities"], parsed["exchanges"])
    return request.app.state.command_bus.execute(cmd, source=source)


class ImportAsModelRequest(BaseModel):
    #: The new model's name; it must not exist yet.
    name: str
    #: The .xlsx file, base64 — the renderer reaches the backend over a JSON bridge (see bundle import).
    content: str


@router.post("/model/import", summary="Import a Brightway/Activity Browser spreadsheet as a new model")
async def import_as_model(request: Request, payload: ImportAsModelRequest) -> dict:
    """The app's way in for the spreadsheet `export_model` writes: a new model, filled atomically.

    The model is created first and removed again if the rows do not import — a refused sheet must not
    leave an empty model behind for the user to find and delete. Links between the sheet's own processes
    stay inside the new model; every other input must already exist (ImportModelCommand).
    """
    model_scope.assert_no_new_model("import a model")
    name = (payload.name or "").strip()
    if not name:
        raise PrismError("Give the new model a name.", code="name_required")
    try:
        content = base64.b64decode(payload.content, validate=True)
        parsed = interop.read_model_workbook(content)
    except (binascii.Error, ValueError, KeyError, OSError) as e:
        raise PrismError("This file is not a spreadsheet PrismLCA can read.", code="sheet_unreadable",
                         hint="Choose an .xlsx with the sheets 'activities' and 'exchanges', as "
                              "Export as a spreadsheet writes it.") from e
    except Exception as e:  # noqa: BLE001 - openpyxl raises its own zoo for a file that is not XLSX
        raise PrismError("This file is not a spreadsheet PrismLCA can read.", code="sheet_unreadable",
                         hint="Choose an .xlsx with the sheets 'activities' and 'exchanges'.") from e
    if not parsed["activities"]:
        raise PrismError("The spreadsheet holds no processes.", code="sheet_empty",
                         hint="PrismLCA reads the sheets 'activities' and 'exchanges'.")
    bus = request.app.state.command_bus
    repo = request.app.state.repository
    # One guard around create, import and any rollback (an RLock — the bus takes it again inside): a
    # workspace switch in between would have imported into, or rolled back in, the other workspace.
    # The birth goes into the log BEFORE the import, so the model's history
    # starts with it; a refused sheet is logged as the model's deletion right after.
    with commands.project_guard():
        repo.create_foreground_database(name)
        bus.note("user", "create_model", f"Create model '{name}' from a spreadsheet", database=name)
        try:
            result = bus.execute(
                commands.ImportModelCommand(name, parsed["activities"], parsed["exchanges"]), source="user"
            )
        except Exception:
            repo.delete_foreground_database(name)
            bus.note("user", "delete_model", f"Delete model '{name}' (spreadsheet refused)", database=name)
            raise
    return {"database": name, **(result if isinstance(result, dict) else {})}
