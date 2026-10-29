"""Foreground modelling endpoints — all mutations go through the command bus (undo/audit)."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca.api.v1.deps import MethodRef, require_token
from prism_lca.engine import (
    background,
    commands,
    health,
    linking,
    maintenance,
    model,
    model_graph,
    model_scope,
    tag_scope,
)
from prism_lca.engine.tag_groups import TagGroupStore
from prism_lca.engine.tags import TagStore

router = APIRouter(prefix="/model", tags=["model"], dependencies=[Depends(require_token)])


def _bus(request: Request):
    return request.app.state.command_bus


def _tags() -> TagStore:
    # Stateless (reads the active project dir per call) — constructed on use, like the engine does.
    return TagStore()


def _tag_groups() -> TagGroupStore:
    return TagGroupStore()


# --- activities ------------------------------------------------------------
class CreateActivityRequest(BaseModel):
    database: str
    name: str
    product: str | None = None
    unit: str | None = None
    location: str | None = None
    source: str = "user"


class CopyRequest(BaseModel):
    source_database: str
    source_code: str
    target_database: str
    #: Localize: the target model's processes that consumed the original consume the copy afterwards.
    relink_consumers: bool = False
    #: With relink: only these inputs (one canvas box) move to the copy; omitted = every consumer.
    uids: list[str] | None = None
    source: str = "user"


@router.post("/activities", summary="Create a foreground activity")
async def create_activity(request: Request, body: CreateActivityRequest) -> dict:
    cmd = commands.CreateActivityCommand(
        body.database, body.name, body.product, body.unit, body.location
    )
    return _bus(request).execute(cmd, source=body.source)


@router.post("/activities/copy", summary="Copy an activity into a foreground database (editable)")
async def copy_activity(request: Request, body: CopyRequest) -> dict:
    cmd = commands.CopyToForegroundCommand(
        body.source_database,
        body.source_code,
        body.target_database,
        relink_consumers=body.relink_consumers,
        uids=body.uids,
    )
    return _bus(request).execute(cmd, source=body.source)


class MoveToLibraryRequest(BaseModel):
    database: str
    code: str
    source: str = "user"


@router.post("/activities/to-library", summary="Move a process into the library, leaving a link")
async def move_to_library(request: Request, body: MoveToLibraryRequest) -> dict:
    """The inverse of Localize: the process leaves the model and the model links to it instead."""
    cmd = commands.MoveToLibraryCommand(body.database, body.code)
    return _bus(request).execute(cmd, source=body.source)


class DuplicateActivityRequest(BaseModel):
    database: str
    code: str
    source: str = "user"


@router.post("/activities/duplicate", summary="Duplicate a foreground activity (undoable)")
async def duplicate_activity(request: Request, body: DuplicateActivityRequest) -> dict:
    cmd = commands.DuplicateActivityCommand(body.database, body.code)
    return _bus(request).execute(cmd, source=body.source)


class DeleteActivityRequest(BaseModel):
    database: str
    code: str
    # Deleting a CONSUMED activity cascades into the consumers' inputs (bw2data) — blocked
    # with 409 delete_blocked unless force is set (undo restores the consumer links).
    force: bool = False
    source: str = "user"


@router.post("/activities/delete", summary="Delete a foreground activity (undoable; consumed activities need force)")
async def delete_activity(request: Request, body: DeleteActivityRequest) -> dict:
    cmd = commands.DeleteActivityCommand(body.database, body.code, force=body.force)
    return _bus(request).execute(cmd, source=body.source)


@router.get("/activities/{database}", summary="List activities in a database")
def list_activities(database: str, with_exchanges: bool = False) -> list[dict]:
    """The model's activities; with ``with_exchanges`` also every exchange, amount and formula.

    A final read-through of a finished model — do the amounts and signs say what they should? — was
    one request per process, because the list carried no quantities and the detail endpoint takes a
    single code. For a seven-process study that is seven round trips to answer one question, which
    in practice means the check is skipped. Foreground models are small; reading one whole is cheap.
    """
    acts = model.list_activities(database)
    if not with_exchanges:
        return acts
    out = []
    for a in acts:
        code = a.get("code")
        if not code:
            out.append(a)
            continue
        detail = model.activity_detail(model.get_activity(database, code))
        # The comment comes along, because the amounts alone do not settle the question this endpoint
        # exists for. An agent once put the whole mass derivation and its caveat ("PVC
        # 3.95 kg is the residual of the 30 kg balance, association EPDs give higher figures") into
        # the process comment — and `review_model` builds its dossier from exactly this call, so the
        # reviewer was judging quantities whose justification it could not see. The tool description
        # promised "every process with its exchanges, amounts, formulas and comments" all along.
        # Only in THIS branch, never in `activity_info`: that one also feeds canvas nodes and search
        # hits, where an ecoinvent comment of several hundred characters would be paid for on every
        # load and read by nobody (see the note in engine/model.py:187).
        comment = (detail.get("activity") or {}).get("comment") or ""
        out.append({**a, "comment": comment, "exchanges": detail.get("exchanges", [])})
    return out


@router.get("/reference/{database}", summary="Likely reference process(es) of a model, best guess first")
def reference_candidates(database: str) -> dict:
    return {"candidates": model.reference_candidates(database)}


@router.get("/graph/{database}", summary="Foreground graph (nodes + edges) for the canvas")
def graph(database: str) -> dict:
    return model_graph.graph(database)


@router.get("/activities/{database}/{code}", summary="Read an activity with its exchanges")
def get_activity(database: str, code: str, detail: str | None = None) -> dict:
    """``detail=review`` adds the critical-review fields (system boundary, product information, synonyms,
    validity, per-exchange production volume and uncertainty) — see ``model.activity_detail``."""
    return model.activity_detail(model.get_activity(database, code), review=detail == "review")


@router.get("/consumers/{database}", summary="Which processes of a model consume a given dataset")
def consumers(database: str, input_database: str, input_code: str) -> dict:
    return model.consumers(database, input_database, input_code)


@router.get("/activities/{database}/{code}/metadata", summary="Comments + metadata of an activity")
def get_activity_metadata(database: str, code: str) -> dict:
    return model.activity_metadata(database, code)


# --- reference-product flow properties -------------------------------------
class SetPropertiesRequest(BaseModel):
    database: str
    code: str
    # {name: {amount, unit, comment?}}
    properties: dict[str, dict]
    source: str = "user"


@router.get(
    "/activities/{database}/{code}/properties",
    summary="Flow properties of an activity's reference product",
)
def get_product_properties(database: str, code: str, input: str | None = None) -> dict:
    """``input`` (a name or code of one of the activity's inputs) reads THAT exchange's properties."""
    return model.product_properties(database, code, input)


@router.get("/property-vocabulary", summary="Known ecoinvent product properties (name → unit)")
def property_vocabulary() -> dict:
    vocab = model.property_vocabulary()
    return {"properties": [{"name": k, "unit": v} for k, v in sorted(vocab.items())]}


@router.get("/unit-vocabulary", summary="Existing units (choose from these only)")
def unit_vocabulary() -> dict:
    return {"units": model.unit_vocabulary()}


@router.get("/location-vocabulary", summary="Locations used in this workspace (background and own)")
def location_vocabulary() -> dict:
    return {"locations": model.location_vocabulary()}


@router.get("/flows", summary="Search existing elementary flows to attach as an exchange")
def flows(query: str = "", direction: str | None = None, limit: int = 50) -> dict:
    return {"flows": model.search_flows(query, direction, limit)}


@router.post("/properties", summary="Set a reference product's flow properties (foreground only)")
async def set_product_properties(request: Request, body: SetPropertiesRequest) -> dict:
    cmd = commands.SetProductPropertiesCommand(body.database, body.code, body.properties)
    return _bus(request).execute(cmd, source=body.source)


# --- exchanges -------------------------------------------------------------
class AddExchangeRequest(BaseModel):
    activity_database: str
    activity_code: str
    input_database: str
    input_code: str
    amount: float
    # Whitelist: a typo'd type ("tecnosphere") would be stored silently and then ignored by
    # every matrix builder — the flow would vanish from all results without an error.
    type: Literal["technosphere", "biosphere", "production", "substitution"] = "technosphere"
    # Optional at creation so the reason for an amount can be recorded in the same call that makes
    # it — documenting afterwards means a second round trip, and in practice means not at all.
    comment: str | None = None
    #: {dimension: value} for the new input; only for inputs from outside the model (see tag_scope).
    tags: dict[str, str] | None = None
    source: str = "user"


class SetExchangeCommentRequest(BaseModel):
    activity_database: str
    activity_code: str
    uid: str
    comment: str | None = None
    source: str = "user"


class SetAmountRequest(BaseModel):
    activity_database: str
    activity_code: str
    uid: str
    amount: float
    source: str = "user"


class RemoveExchangeRequest(BaseModel):
    activity_database: str
    activity_code: str
    uid: str
    source: str = "user"


class ExchangeUncertaintyRequest(BaseModel):
    activity_database: str
    activity_code: str
    uid: str
    distribution: str
    params: dict[str, float] = {}
    source: str = "user"


class ActivityFieldsRequest(BaseModel):
    database: str
    code: str
    name: str | None = None
    location: str | None = None
    unit: str | None = None
    product: str | None = None
    comment: str | None = None
    doc: dict[str, str] | None = None  # data_source, reference_year, completeness, …
    source: str = "user"


class ExchangePedigreeRequest(BaseModel):
    activity_database: str
    activity_code: str
    uid: str
    scores: list[int]  # [reliability, completeness, temporal, geographical, technological] 1..5
    basic_gsd: float = 1.0
    source: str = "user"


class ReferenceQuantityRequest(BaseModel):
    database: str
    #: The process being divided — normally the model's current reference process.
    code: str
    #: The parameter holding the total to divide by (a lifetime output, a service life, a batch size).
    parameter: str
    #: What one of them is called in the document, e.g. "Electricity, per kWh".
    name: str
    unit: str
    product: str | None = None
    source: str = "user"


@router.get("/reference-quantity/{database}", summary="The model's reference quantity, if it has one")
def get_reference_quantity(database: str) -> dict:
    return model.find_reference_quantity(database) or {}


@router.post("/reference-quantity", summary="Make 1 <unit> the model's functional unit")
async def set_reference_quantity(request: Request, body: ReferenceQuantityRequest) -> dict:
    """Divide a process by a parameter, in the matrix — see `model.set_reference_quantity`.

    Idempotent: a second call re-points the existing node. Two dividers would divide twice, which
    is the one way this feature could quietly falsify every number in the study (V233).
    """
    cmd = commands.SetReferenceQuantityCommand(
        body.database, body.code, body.parameter, body.name, body.unit, body.product
    )
    return _bus(request).execute(cmd, source=body.source)


@router.post("/exchanges", summary="Add an exchange (edge)")
async def add_exchange(request: Request, body: AddExchangeRequest) -> dict:
    cmd = commands.AddExchangeCommand(
        body.activity_database, body.activity_code,
        body.input_database, body.input_code, body.amount, body.type, body.comment,
        tags=body.tags, tag_store=_tags(), group_store=_tag_groups(),
    )
    return _bus(request).execute(cmd, source=body.source)


@router.post("/exchanges/comment", summary="Set an exchange's comment")
async def set_exchange_comment(request: Request, body: SetExchangeCommentRequest) -> dict:
    cmd = commands.SetExchangeCommentCommand(
        body.activity_database, body.activity_code, body.uid, body.comment
    )
    return _bus(request).execute(cmd, source=body.source)


@router.post("/exchanges/amount", summary="Set an exchange amount")
async def set_exchange_amount(request: Request, body: SetAmountRequest) -> dict:
    cmd = commands.SetExchangeAmountCommand(
        body.activity_database, body.activity_code, body.uid, body.amount
    )
    return _bus(request).execute(cmd, source=body.source)


@router.post("/exchanges/remove", summary="Remove an exchange")
async def remove_exchange(request: Request, body: RemoveExchangeRequest) -> dict:
    cmd = commands.RemoveExchangeCommand(body.activity_database, body.activity_code, body.uid)
    return _bus(request).execute(cmd, source=body.source)


@router.post("/exchanges/uncertainty", summary="Set an exchange's uncertainty distribution")
async def set_exchange_uncertainty(request: Request, body: ExchangeUncertaintyRequest) -> dict:
    cmd = commands.SetExchangeUncertaintyCommand(
        body.activity_database, body.activity_code, body.uid, body.distribution, body.params
    )
    return _bus(request).execute(cmd, source=body.source)


@router.post("/activities/fields", summary="Edit activity fields (incl. ISO documentation)")
async def set_activity_fields(request: Request, body: ActivityFieldsRequest) -> dict:
    fields = body.model_dump(exclude={"database", "code", "source"}, exclude_none=True)
    cmd = commands.SetActivityFieldsCommand(body.database, body.code, fields)
    return _bus(request).execute(cmd, source=body.source)


class ClassificationRequest(BaseModel):
    database: str
    code: str
    isic: str | None = None      # ISIC Rev.4 section letter (A–U)
    cpc: str | None = None       # CPC code
    cpc_name: str | None = None  # CPC name (display only)
    source: str = "user"


@router.post("/activities/classification", summary="Set ISIC/CPC on a foreground activity (undoable)")
async def set_classification(request: Request, body: ClassificationRequest) -> dict:
    cmd = commands.SetClassificationCommand(body.database, body.code, body.isic, body.cpc, body.cpc_name)
    return _bus(request).execute(cmd, source=body.source)


@router.get("/isic-sections", summary="ISIC Rev.4 sections (A–U) for the classifier dropdown")
async def isic_sections() -> dict:
    return {"sections": model.isic_sections()}


@router.get("/cpc-vocabulary", summary="Known CPC classes (code → name) for autocomplete")
def cpc_vocabulary() -> dict:
    return {"cpc": model.cpc_vocabulary()}


@router.post("/exchanges/pedigree", summary="Set exchange uncertainty from a pedigree matrix")
async def set_exchange_pedigree(request: Request, body: ExchangePedigreeRequest) -> dict:
    cmd = commands.SetExchangePedigreeCommand(
        body.activity_database, body.activity_code, body.uid, body.scores, body.basic_gsd
    )
    return _bus(request).execute(cmd, source=body.source)


# --- tags ------------------------------------------------------------------
class TagKey(BaseModel):
    """A process (database + code) or one input of a model process (its exchange uid)."""

    database: str | None = None
    code: str | None = None
    uid: str | None = None


class TagRequest(BaseModel):
    database: str
    code: str
    dimension: str
    value: str
    source: str = "user"


class BulkTagRequest(BaseModel):
    keys: list[TagKey]
    dimension: str
    value: str
    source: str = "user"


def _require_activities(keys: list[tuple[str, str]]) -> None:
    """Refuse a tag selection that names an activity which does not exist.

    The tag store is a side table keyed by (database, code) and happily records a value for any key,
    so a mistyped code came back as ``{"set": 1}`` and left a phantom tag that no process carries
    and the phase aggregation then listed as "(untagged)" — the assistant spliced two hex codes into
    one (V425) and only noticed through that 5 % residual. The exchange routes refuse
    the same slip with a 404; the tag routes now do too, before anything is written.
    """
    for database, code in keys:
        model.get_activity(database, code)
        tag_scope.check_process_target(database, code)


@router.post("/tags", summary="Add a tag to an activity")
async def add_tag(request: Request, body: TagRequest) -> dict:
    _require_activities([(body.database, body.code)])
    cmd = commands.TagActivitiesCommand(
        _tags(), [(body.database, body.code)], body.dimension, body.value, _tag_groups()
    )
    return _bus(request).execute(cmd, source=body.source)


@router.post("/tags/bulk", summary="Tag many activities at once (canvas box tool)")
async def tag_bulk(request: Request, body: BulkTagRequest) -> dict:
    keys = tag_scope.resolve_keys([k.model_dump() for k in body.keys], inputs_allowed=False)
    cmd = commands.TagActivitiesCommand(_tags(), keys, body.dimension, body.value,
                                        _tag_groups())
    return _bus(request).execute(cmd, source=body.source)


@router.post("/tags/remove", summary="Remove a tag from an activity")
async def remove_tag(request: Request, body: TagRequest) -> dict:
    cmd = commands.RemoveTagCommand(
        _tags(), body.database, body.code, body.dimension, body.value
    )
    return _bus(request).execute(cmd, source=body.source)


@router.get("/tags/{database}/{code}", summary="List an activity's tags")
async def list_tags(request: Request, database: str, code: str) -> list[dict]:
    return _tags().list_for(database, code)


# --- tag groups (dimensions) + one-value-per-group assignment --------------
class SetTagRequest(BaseModel):
    keys: list[TagKey]  # one or many activities
    group: str
    value: str | None = None  # None/empty clears the group for those activities
    source: str = "user"


class TagGroupRequest(BaseModel):
    name: str
    color: str | None = None
    source: str = "user"


class TagValueRequest(BaseModel):
    group: str
    value: str
    source: str = "user"


@router.get("/tag-groups", summary="List tag groups (dimensions) with their allowed values")
async def list_tag_groups(request: Request) -> dict:
    """Each group also says in which databases it is actually used.

    `databases` is what lets a *split by* offer only dimensions that would produce groups: a dimension is
    project config from the moment it is created, so without this every picker offered every one of them,
    and choosing an untagged dimension drew a chart with a single "untagged" bar. Sent with the list rather
    than behind a second endpoint — every caller that draws the picker needs it, and it is one dict.
    """
    used = _tags().databases_by_dimension()
    return {
        "groups": [{**g, "databases": used.get(g["name"], [])} for g in _tag_groups().list_groups()]
    }


@router.post("/tag-groups", summary="Create a tag group (dimension)")
async def create_tag_group(request: Request, body: TagGroupRequest) -> dict:
    result = _tag_groups().create_group(body.name, body.color)
    # The source comes from the caller like it does everywhere else. Hard-coding "user" here put the
    # assistant's own tag groups in the audit log under the user's name, right beside the tag
    # assignments it was correctly credited with — which reads as the user having done half of it.
    # No `database`: a tag group is project-wide, and its cascade only reaches models when a group
    # or a value is *removed* (which is a Command, and carries `databases`). Creating one changes no
    # model, so claiming one here would be the inference this field exists to replace.
    _bus(request).note(body.source, "create_tag_group", f"Create tag group '{body.name}'")
    return result


@router.post("/tag-groups/delete", summary="Delete a tag group (removes its tags everywhere; undoable)")
async def delete_tag_group(request: Request, body: TagGroupRequest) -> dict:
    cmd = commands.DeleteTagGroupCommand(_tag_groups(), _tags(), body.name)
    # source from the caller like everywhere else — this call site and values/remove were the two
    # that hard-coded "user" and put assistant deletions under the user's name.
    return _bus(request).execute(cmd, source=body.source)


@router.post("/tag-groups/values", summary="Add an allowed value to a tag group")
async def add_tag_value(request: Request, body: TagValueRequest) -> dict:
    store = _tag_groups()
    known = any(g["name"] == body.group and body.value.strip() in g["values"] for g in store.list_groups())
    result = store.add_value(body.group, body.value)
    # The assistant's "assign" adds its value before every assignment, a no-op once it exists. Only a value
    # that is really new is an event: otherwise the audit fills with "Add value 'Production'" per process.
    if not known:
        _bus(request).note(  # project-wide, see create_tag_group
            body.source, "add_tag_value", f"Add value '{body.value}' to tag group '{body.group}'"
        )
    return result


@router.post("/tag-groups/values/remove", summary="Remove a value from a group (untags it everywhere; undoable)")
async def remove_tag_value(request: Request, body: TagValueRequest) -> dict:
    cmd = commands.RemoveTagValueCommand(_tag_groups(), _tags(), body.group, body.value)
    return _bus(request).execute(cmd, source=body.source)  # see delete_tag_group


class TagValueMergeRequest(BaseModel):
    group: str
    value: str
    into: str
    source: str = "user"


class TagGroupMergeRequest(BaseModel):
    name: str
    into: str
    source: str = "user"


@router.post("/tag-groups/values/merge", summary="Merge a value into another of the same group (retags; undoable)")
async def merge_tag_value(request: Request, body: TagValueMergeRequest) -> dict:
    cmd = commands.MergeTagValueCommand(_tag_groups(), _tags(), body.group, body.value, body.into)
    return _bus(request).execute(cmd, source=body.source)


@router.post("/tag-groups/merge", summary="Merge a tag group into another (values and tags move; undoable)")
async def merge_tag_group(request: Request, body: TagGroupMergeRequest) -> dict:
    cmd = commands.MergeTagGroupCommand(_tag_groups(), _tags(), body.name, body.into)
    return _bus(request).execute(cmd, source=body.source)


class TagPartitionRequest(BaseModel):
    database: str
    group: str


@router.post("/tag-groups/partition", summary="Split a model's processes by one tag group")
async def partition_by_tag_group(request: Request, body: TagPartitionRequest) -> dict:
    """What "group processes based on tags" on the canvas is built on. Read-only, so no command bus:
    the boxes it leads to are view state and never touch the model (see lib/groups.ts)."""
    return model.partition_by_tag_group(body.database, body.group)


@router.post("/tags/set", summary="Assign one value per group to activities (empty clears it)")
async def set_tag(request: Request, body: SetTagRequest) -> dict:
    keys = tag_scope.resolve_keys([k.model_dump() for k in body.keys])
    cmd = commands.SetTagCommand(_tags(), keys, body.group, body.value, _tag_groups())
    return _bus(request).execute(cmd, source=body.source)


# --- history ---------------------------------------------------------------
class HistoryStepRequest(BaseModel):
    """Optional body for undo/redo. `turn` asks for the WHOLE contiguous assistant turn on top of
    the stack — the id comes from `GET /model/history` (`next_undo_turn`/`next_redo_turn`),
    never from guessing. Without a body the endpoints behave exactly as before: one step, as the
    user."""

    turn: str | None = None
    source: str = "user"
    #: The model the step is taken on. Then the step must be that model's (or workspace-wide); one on
    #: top that belongs to another model is refused with 409 `undo_elsewhere`, never taken back.
    database: str | None = None


@router.post("/undo", summary="Undo the last action (or a whole assistant turn)")
async def undo(request: Request, body: HistoryStepRequest | None = None) -> dict:
    bus = _bus(request)
    db = body.database if body else None
    # A fenced request undoes in its own model only, never the workspace-wide stack.
    model_scope.assert_model_write(db)
    if body and body.turn:
        return bus.undo_turn(body.turn, source=body.source, database=db)
    return bus.undo(source=body.source if body else "user", database=db)


@router.post("/redo", summary="Redo the last undone action (or a whole assistant turn)")
async def redo(request: Request, body: HistoryStepRequest | None = None) -> dict:
    bus = _bus(request)
    db = body.database if body else None
    model_scope.assert_model_write(db)  # see undo
    if body and body.turn:
        return bus.redo_turn(body.turn, source=body.source, database=db)
    return bus.redo(source=body.source if body else "user", database=db)


@router.get("/history", summary="Undo/redo availability")
async def history(request: Request, database: str | None = None) -> dict:
    """With ``?database=``: what Undo/Redo would do on that model (see `CommandBus.history`)."""
    return _bus(request).history(database=database)


@router.get("/audit", summary="Audit log (chronological)")
async def audit(
    request: Request,
    database: str | None = None,
    source: str | None = None,
    limit: int = 200,
    client: str | None = None,
) -> list:
    """The project's history, oldest first — optionally narrowed to one model.

    **Query parameters, and the frontend has to send them as such.** Putting the filter in a JSON body
    while the route reads a query parameter is a fault that looks exactly like a broken filter, and it
    cost 72 seconds of proving a working fix was broken.

    `database` keeps that model's entries plus the ones attributed to no model (shown separately as
    earlier history, never mixed in). `limit` keeps the newest, the model's own entries first — the
    log is append-only and grows for ever, and these two pages used to fetch all of it on every
    navigation.

    The stored `database` is the model's name **at the time**, and nothing rewrites it. The name is
    therefore resolved against the timeline the lifecycle notes draw, so a renamed model keeps its
    past and a *new* model reusing a freed name does not inherit it. Three keys carry the answer and
    exist only on the wire: `current_name` (renamed since), `model_gone` (deleted — the entry stays,
    because the history outliving the model is the point) and `copied_from` (this is where the model
    asked about came from).
    """
    # `exclude_none`, so an entry that names no model has no `database` key at all — the same shape
    # on the wire as in the file, and the same shape as every line written before the field existed.
    # A reader then has one rule ("is the key there?") instead of two.
    return [
        e.model_dump(exclude_none=True)
        for e in _bus(request).audit(database=database, source=source, limit=limit, client=client)
    ]


# --- model health ----------------------------------------------------------
@router.get("/health/{database}", summary="Model-health linter (structural checks)")
def model_health(database: str) -> dict:
    return health.lint_database(database)


# --- provider linking ------------------------------------------------------
class ProviderCandidatesRequest(BaseModel):
    product: str
    unit: str | None = None
    location: str | None = None
    databases: list[str] | None = None
    limit: int = 10


@router.post("/providers/candidates", summary="Rank provider candidates for a product (with reasons)")
def provider_candidates(body: ProviderCandidatesRequest) -> dict:
    return linking.find_providers(
        body.product, body.unit, body.location, body.databases, body.limit
    )


# --- background expand + localize (M15) ------------------------------------
class ExpandRequest(BaseModel):
    database: str
    code: str
    amount: float = 1.0
    method: MethodRef | None = None
    cutoff: float = 0.0


class LocalizeRequest(BaseModel):
    target_database: str
    path: list[list[str]]  # [[db, code], ...] from FU root down to the target
    source: str = "user"


@router.post("/expand", summary="Tier-1 upstream inputs of an activity (lazy expand, optional impact)")
def expand(body: ExpandRequest) -> dict:
    return background.expand(body.database, body.code, body.amount, body.method, body.cutoff)


@router.post("/localize", summary="Copy a background path into the editable foreground")
async def localize(request: Request, body: LocalizeRequest) -> dict:
    cmd = commands.LocalizePathCommand(body.target_database, body.path)
    return _bus(request).execute(cmd, source=body.source)


@router.get("/delete-preview/{database}/{code}", summary="Dependency cascade before deleting")
def delete_preview(database: str, code: str) -> dict:
    return maintenance.delete_preview(database, code)
