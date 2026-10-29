"""Scenario endpoints: id-addressed parameter-override sets + per-scenario LCIA and comparison.

Scenario RESULTS are computed through the normal Results pipeline (``/calc/compare`` with a
per-subject ``scenario`` id); the ``/scenarios/compute`` and ``/scenarios/compare`` endpoints
below remain for single-indicator/programmatic use.
"""
from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca.api.v1.deps import MethodRef, require_token
from prism_lca.engine import commands, lca, params, scenarios
from prism_lca.engine.model import resolve_db_name
from prism_lca.engine.scenarios import ScenarioStore
from prism_lca.errors import PrismError

router = APIRouter(prefix="/scenarios", tags=["scenarios"], dependencies=[Depends(require_token)])


def _bus(request: Request):
    return request.app.state.command_bus


def _store() -> ScenarioStore:
    # Stateless — constructed on use, like the engine does since the store consolidation.
    return ScenarioStore()


class CreateScenarioRequest(BaseModel):
    database: str  # the model this scenario belongs to
    name: str
    description: str = ""
    #: A number, or a formula over the model's parameters as text — see engine/scenarios.py.
    overrides: dict[str, float | str] = {}
    source: str = "user"


class UpdateScenarioRequest(BaseModel):
    database: str
    id: str
    name: str
    description: str = ""
    #: A number, or a formula over the model's parameters as text — see engine/scenarios.py.
    overrides: dict[str, float | str] = {}
    source: str = "user"


class ScenarioIdRequest(BaseModel):
    database: str
    id: str
    source: str = "user"


class ScenarioValueRequest(BaseModel):
    id: str
    param: str
    value: float | str  # a number, or a formula as text
    source: str = "user"


class ImportScenariosRequest(BaseModel):
    database: str
    xlsx_base64: str
    source: str = "user"


class ComputeRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    scenario_id: str
    amount: float = 1.0


class CompareRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    #: Several indicators in one request — each scenario is applied once and scored for all of them
    #: (V331). When given, `method` is ignored and the answer carries one block per indicator.
    methods: list[MethodRef] | None = None
    scenario_ids: list[str]
    amount: float = 1.0


@router.get("", summary="List a model's scenarios")
def list_scenarios(request: Request, database: str) -> list[dict]:
    """Each scenario, plus which of its overrides currently change nothing.

    A scenario that sets a parameter to the value the model already has is the baseline under another
    name, and every comparison it appears in returns Δ 0. The write paths refuse to create one — but
    the *baseline* can move to meet an override that was meaningful when it was typed, and then the
    variant quietly dies. That is how an apple-juice report once came to print three bars of
    the same height with nothing saying why.

    ``no_effect`` is the same symptom by the other road: the value differs, but no exchange amount
    depends on the parameter, so the variant is the baseline anyway (V236).
    """
    database = resolve_db_name(database)  # spelled as the other routes accept it; the store matches exactly
    entries = _store().list_all(database)
    # One read of the model for the whole list: judged per scenario,
    # every row re-read and re-evaluated the model under the global calculation lock.
    judged = scenarios.judge_all(database, entries)
    dead = params.unreachable_parameters(database) if entries else {}
    out = []
    for entry in entries:
        overrides = entry.get("overrides") or {}
        verdict = judged[entry["id"]]
        out.append(
            {
                **entry,
                "ineffective": verdict["ineffective"],
                # The other way to vary nothing: a different value on a parameter the model never
                # reads. Not refused on the way in — a scenario written before the formula it will
                # move is ordinary work — so this is the only place it surfaces (V236).
                "no_effect": sorted(scenarios.unreachable_overrides(database, overrides, dead)),
                # The model cannot be evaluated under these overrides (a stored set the baseline moved
                # under): said here, since it also means `ineffective` could not be judged.
                **({"evaluation_error": verdict["evaluation_error"]} if verdict["evaluation_error"] else {}),
            }
        )
    return out


# The mutating routes are plain `def`: FastAPI runs them in the threadpool, so waiting for the
# calculation lock does not stall the event loop (an `async def` did). Each one takes
# `lca._LCA_LOCK` BEFORE it calls the command bus — the order the parameter routes use (api/v1/params.py
# `_write`) — so validation reads the baseline, never a scenario another thread holds applied, and no
# scenario command has to reach for the calculation lock from inside the bus lock, which deadlocked.


@router.post("", summary="Create a scenario")
def create_scenario(request: Request, body: CreateScenarioRequest) -> dict:
    with lca._LCA_LOCK:
        scenarios.check_overrides(body.database, body.overrides, scenario=body.name)
        scenarios.refuse_ineffective(body.database, body.overrides, scenario=body.name)
        cmd = commands.CreateScenarioCommand(_store(), body.database, body.name, body.description, body.overrides)
        return _bus(request).execute(cmd, source=body.source)


@router.post("/update", summary="Update a scenario (name, description, overrides)")
def update_scenario(request: Request, body: UpdateScenarioRequest) -> dict:
    with lca._LCA_LOCK:
        scenarios.check_overrides(body.database, body.overrides, scenario=body.name)
        scenarios.refuse_ineffective(body.database, body.overrides, scenario=body.name)
        cmd = commands.UpdateScenarioCommand(
            _store(), body.database, body.id, body.name, body.description, body.overrides
        )
        return _bus(request).execute(cmd, source=body.source)


@router.post("/duplicate", summary="Duplicate a scenario")
def duplicate_scenario(request: Request, body: ScenarioIdRequest) -> dict:
    return _bus(request).execute(commands.DuplicateScenarioCommand(_store(), body.database, body.id), source=body.source)


@router.post("/value", summary="Set a single parameter override in a scenario")
def set_value(request: Request, body: ScenarioValueRequest) -> dict:
    with lca._LCA_LOCK:
        entry = _store().get(body.id)
        scenarios.refuse_ineffective(
            str(entry.get("database") or ""),
            {**(entry.get("overrides") or {}), body.param: body.value},
            scenario=str(entry.get("name") or ""),
            only={body.param},
        )
        cmd = commands.SetScenarioValueCommand(_store(), body.id, body.param, body.value)
        return _bus(request).execute(cmd, source=body.source)


@router.post("/delete", summary="Delete a scenario")
def delete_scenario(request: Request, body: ScenarioIdRequest) -> dict:
    return _bus(request).execute(commands.DeleteScenarioCommand(_store(), body.database, body.id), source=body.source)


@router.get("/template", summary="Download an example scenario-import workbook (base64 XLSX)")
def scenarios_template(database: str) -> dict:
    data = scenarios.template_workbook(database)
    return {"filename": "prism-scenarios-template.xlsx",
            "base64": base64.b64encode(data).decode("ascii")}


@router.post("/import", summary="Import scenarios from an Excel workbook (create/overwrite)")
def import_scenarios(request: Request, body: ImportScenariosRequest) -> dict:
    try:
        content = base64.b64decode(body.xlsx_base64)
    except (ValueError, TypeError) as exc:
        raise PrismError("Could not decode the uploaded file.", code="invalid_upload",
                         hint="Re-select the .xlsx file and try again.") from exc
    columns = scenarios.parse_scenarios_workbook(content)
    # Reject unknown parameter names up front (typo protection) — overrides must target real params.
    known = set(params.snapshot_all(body.database).keys())
    used = {p for col in columns for p in col["overrides"]}
    unknown = sorted(used - known)
    if unknown:
        raise PrismError(
            f"Unknown parameter(s) for this model: {', '.join(unknown)}.",
            code="unknown_parameter",
            hint="Parameter names (first column) must match the model's parameters exactly.")
    # And every cell against the rule of the parameter it belongs to. Before anything is written, so an
    # import is all-or-nothing: half a workbook applied is worse than a refused one, and this is the path
    # where a value nobody typed would otherwise arrive unseen. The message names the cell.
    with lca._LCA_LOCK:
        for col in columns:
            scenarios.check_overrides(body.database, col["overrides"], scenario=col["name"])
        cmd = commands.ImportScenariosCommand(_store(), body.database, columns)
        return _bus(request).execute(cmd, source=body.source)


@router.post("/compute", summary="LCIA for one scenario")
def compute(request: Request, body: ComputeRequest) -> dict:
    return scenarios.compute(_store(), body.database, body.code, body.method, body.scenario_id, body.amount)


@router.post("/compare", summary="Compare baseline + scenarios (one indicator, or several via `methods`)")
def compare(request: Request, body: CompareRequest) -> dict:
    if body.methods:
        return scenarios.compare_many(
            _store(), body.database, body.code, body.methods, body.scenario_ids, body.amount
        )
    return scenarios.compare(_store(), body.database, body.code, body.method, body.scenario_ids, body.amount)
