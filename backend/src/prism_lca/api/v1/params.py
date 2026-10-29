"""Parameter / variable endpoints (model-scoped; all mutations via the command bus)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import commands, lca, params
from prism_lca.engine.model import resolve_db_name

router = APIRouter(prefix="/params", tags=["parameters"], dependencies=[Depends(require_token)])


def _bus(request: Request):
    return request.app.state.command_bus


async def _write(fn, *args, **kwargs):
    """One write to the parameter store: off the event loop, and never two of them at once.

    **Off the loop**, because none of these writes is quick. Each one recalculates the model's
    formulas — seconds of SQLite and formula evaluation. Measured on a 120-activity /
    600-formula model: 1.9 s for setting a parameter, 0.6 s for a recalculation, 0.4 s for a
    deletion; on a real study the recalculation alone takes 9.8–12.9 s. Spent on the loop, that
    wait is charged to every *other* request as well — the report page's freshness check, the
    audit log and the assistant all queue behind a recalculation they have nothing to do with.

    **Never two at once**, because the parameter store is SQLite without WAL and bw2data
    recalculates a database inside a single transaction: a second writer landing in that window
    waits out the busy timeout and then raises `database is locked`. That is not hypothetical —
    it is what a second process holding the project cost a scenario restore in the field
    (`scenario_restore_failed`).

    The lock is `lca._LCA_LOCK` rather than one of this module's own, because the writers that
    have to be excluded are not only the routes in this file. The scenario, sensitivity and
    Monte-Carlo windows write parameter values too (they apply overrides and write the baseline
    back), they do it from plain threads, and they already hold that lock across their whole
    span. Sharing it is what makes "one writer at a time" true for all of them; a lock of our own
    would only order this file against itself, and an async lock could not include them at all —
    they are threads, not tasks. What `engine/lca.py` deliberately keeps off this lock is the
    *generation bump*, an atomic int; a write of the model is the opposite of that, and it must
    not run while a traversal is solving against the amounts it is rewriting.

    Acquiring `_LCA_LOCK` here means it is taken before the command bus's own lock. Nothing takes
    the two in the other order — no command reaches the LCA lock, and `test_params_threadpool.py`
    pins that — so this nesting has no partner and cannot deadlock.
    """

    def locked():
        with lca._LCA_LOCK:
            return fn(*args, **kwargs)

    return await run_in_threadpool(locked)


class ParamRequest(BaseModel):
    database: str  # the model this parameter belongs to
    name: str
    amount: float | None = None
    formula: str | None = None
    group_id: str | None = None
    group: str | None = None  # legacy convenience: a group NAME, resolved/created to a group_id
    description: str | None = None
    unit: str | None = None
    #: What this parameter's value is allowed to be — `{"kind": "positive"}`, `{"kind": "range", "min": 0,
    #: "max": 1}`, `{"kind": "list", "values": [0.25, 0.5]}`. `{}` removes the rule; omitting the field
    #: leaves whatever the parameter carries. See engine/param_rules.py.
    rule: dict | None = None
    source: str = "user"


class ParamGroupRequest(BaseModel):
    database: str
    name: str
    source: str = "user"


class ParamGroupRenameRequest(BaseModel):
    database: str
    id: str
    name: str
    source: str = "user"


class ParamGroupDeleteRequest(BaseModel):
    database: str
    id: str
    source: str = "user"


class AssignParamGroupRequest(BaseModel):
    database: str
    name: str  # parameter name
    group_id: str | None = None  # None/"" un-assigns
    source: str = "user"


class DeleteParamRequest(BaseModel):
    database: str
    name: str
    source: str = "user"


class ExchangeFormulaRequest(BaseModel):
    activity_database: str
    activity_code: str
    uid: str
    formula: str | None = None
    source: str = "user"


class ParamItem(BaseModel):
    """One parameter inside a bulk write — the same fields as ParamRequest without the model."""

    name: str
    amount: float | None = None
    formula: str | None = None
    group_id: str | None = None
    group: str | None = None
    description: str | None = None
    unit: str | None = None
    rule: dict | None = None


@router.get("", summary="List a model's parameters")
async def list_params(database: str, with_usage: bool = False) -> list[dict]:
    """``with_usage`` adds, per parameter, the exchanges whose formula references it — the blast
    radius of a change. Opt-in because it scans the model's exchanges."""
    # In the threadpool because that scan grows with the model (measured 164 ms at 120
    # activities), but deliberately NOT behind `_write`: it is a read, and the parameter panel
    # has to be able to list while a recalculation is running.
    # Spelled as the other routes accept it ("bottle-glass" for "Bottle Glass"): the lookup below is exact.
    database = resolve_db_name(database)
    return await run_in_threadpool(params.list_params, database, with_usage=with_usage)


class BulkParamRequest(BaseModel):
    database: str
    #: Each item takes the same fields as a single write: name, amount|formula, group_id|group,
    #: description, unit, rule. Formulas may name parameters created in this same call.
    parameters: list[ParamItem]
    source: str = "user"


@router.post("/bulk", summary="Create or update many parameters in one recalculation")
async def set_params_bulk(request: Request, body: BulkParamRequest) -> dict:
    """One lock, one recalculation, and formulas inside the batch may refer to each other.

    The single-parameter route is the right shape for a person editing one row; it is the wrong
    shape for the twenty a model gets built with, because each one recalculates the whole model and
    they serialise behind `_write`. See `params.set_params_bulk` for the measurement (V228/V232).
    """
    cmd = commands.SetParametersCommand(body.database, [p.model_dump() for p in body.parameters])
    return await _write(_bus(request).execute, cmd, source=body.source)


@router.post("", summary="Create or update a model parameter")
async def set_param(request: Request, body: ParamRequest) -> dict:
    cmd = commands.SetParameterCommand(
        body.database, body.name, body.amount, body.formula, body.group_id,
        body.description, body.unit, group=body.group, rule=body.rule,
    )
    return await _write(_bus(request).execute, cmd, source=body.source)


@router.get("/groups", summary="List a model's parameter groups")
async def list_param_groups(database: str) -> list[dict]:
    from prism_lca.engine import parameter_groups

    # Stays on the loop: one small JSON file, measured 3–4 ms and flat with model size, so a
    # thread hop would cost more than it saves. The file is replaced atomically, so reading it
    # while a group is being written is safe.
    return parameter_groups.list_groups(database)


@router.post("/groups", summary="Create a parameter group")
async def create_param_group(request: Request, body: ParamGroupRequest) -> dict:
    # The group catalogue is that JSON file, not the parameter store, so there is nothing here
    # for `_write`'s lock to protect. In the threadpool all the same: this goes through the
    # command bus, whose lock a parameter write may be holding for seconds, and waiting for that
    # on the loop would stall every other request instead of only this one.
    return await run_in_threadpool(
        _bus(request).execute, commands.CreateParamGroupCommand(body.database, body.name), source=body.source
    )


@router.post("/groups/rename", summary="Rename a parameter group")
async def rename_param_group(request: Request, body: ParamGroupRenameRequest) -> dict:
    return await run_in_threadpool(
        _bus(request).execute,
        commands.RenameParamGroupCommand(body.database, body.id, body.name),
        source=body.source,
    )


@router.post("/groups/delete", summary="Delete a parameter group (parameters are kept, un-grouped)")
async def delete_param_group(request: Request, body: ParamGroupDeleteRequest) -> dict:
    # Gated, unlike creating and renaming one: un-assigning the members writes the parameter rows
    # themselves.
    return await _write(
        _bus(request).execute, commands.DeleteParamGroupCommand(body.database, body.id), source=body.source
    )


@router.post("/group", summary="Assign a parameter to a group (or un-assign)")
async def assign_param_group(request: Request, body: AssignParamGroupRequest) -> dict:
    return await _write(
        _bus(request).execute,
        commands.AssignParamGroupCommand(body.database, body.name, body.group_id),
        source=body.source,
    )


@router.post("/delete", summary="Delete a model parameter")
async def delete_param(request: Request, body: DeleteParamRequest) -> dict:
    return await _write(
        _bus(request).execute, commands.DeleteParameterCommand(body.database, body.name), source=body.source
    )


@router.post("/exchange-formula", summary="Set/clear a formula on an exchange")
async def set_exchange_formula(request: Request, body: ExchangeFormulaRequest) -> dict:
    cmd = commands.SetExchangeFormulaCommand(
        body.activity_database, body.activity_code, body.uid, body.formula
    )
    return await _write(_bus(request).execute, cmd, source=body.source)


class EvaluateFormulaRequest(BaseModel):
    database: str
    formula: str
    #: Parameter values to substitute for THIS evaluation only; nothing is stored.
    overrides: dict[str, float] | None = None


@router.post("/evaluate", summary="Evaluate a formula without storing it")
async def evaluate_formula(body: EvaluateFormulaRequest) -> dict:
    """What a formula would come to, given the model's current parameters. Read-only.

    Deliberately outside the command bus: it changes nothing, so it belongs in neither the undo
    stack nor the audit log.
    """
    # Stays on the loop for the same reason as the group listing: measured 5–8 ms and flat with
    # model size, because it reads the parameters of one model and evaluates one expression.
    return params.evaluate_formula(body.database, body.formula, body.overrides)


@router.post("/recalculate", summary="Recalculate all parameters and parameterised exchanges")
async def recalculate(request: Request, database: str | None = None) -> dict:
    def work() -> list[dict]:
        # One model when the caller names it; the whole project only on the explicit, unscoped call.
        if database:
            params.recalc_database(database)
        else:
            params.recalc_all()
        # Read the parameters inside the same locked block: the answer is meant to be what the
        # model came to in THIS recalculation, and a read taken after the lock is released could
        # already show the next writer's numbers.
        return params.list_params(database) if database else []

    parameters = await _write(work)
    if database:
        # A recalculation is the one moment where a slow, unasked-for computation becomes predictable:
        # it invalidates every report snapshot of this model, and the report whose freshness check will
        # want one next is the report somebody was already reading. Started here rather than left to
        # the report page because the page has nothing to warm *with* — by the time it asks, the author
        # is waiting. Scheduling only; nothing is awaited (see report_pipeline.warm_snapshots).
        from prism_lca.engine.report_pipeline import warm_snapshots

        warm_snapshots(database)
    return {"ok": True, "parameters": parameters}
