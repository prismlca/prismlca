"""Command pattern with undo/redo and an audit log (ADR-004).

Every state-changing operation is a Command with ``execute()`` and ``undo()``. Identifiers
(activity codes, exchange uids) are fixed at construction so redo reproduces the exact same
result. The CommandBus keeps per-session undo/redo stacks; the audit trail itself is appended to
``prism_meta/audit.jsonl`` and therefore outlives the process (see engine/audit_store.py).
"""

from __future__ import annotations

import re
import threading
import time
from abc import ABC, abstractmethod
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from pydantic import BaseModel

from prism_lca import _log
from prism_lca.engine import audit_store, lca, model, model_scope, params
from prism_lca.engine._store import now_iso
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import assert_writable, set_read_only
from prism_lca.engine.library import LIBRARY_DB, ensure_library, is_library
from prism_lca.engine.tag_groups import TagGroupStore
from prism_lca.engine.tags import TagStore
from prism_lca.errors import PrismError

#: The assistant turn (one user message → one agent run) the current request belongs to, if any.
#: Set by the HTTP middleware from the ``X-Prism-Turn`` header the AI loop sends with every call of
#: a run; read once per executed command. A contextvar rather than a request field because the
#: alternative was threading one more field through all ~30 request models for a single consumer —
#: and unlike ``source`` it is machine-generated, so there is nothing a caller could get wrong.
CURRENT_TURN: ContextVar[str | None] = ContextVar("prism_current_turn", default=None)

#: The project an external MCP session was opened on (``X-Prism-Project``), or None for the app's
#: own requests. Checked under ``PROJECT_LOCK`` right before a mutation runs, so a switch cannot
#: fall between the middleware's check and the execution.
CURRENT_PROJECT: ContextVar[str | None] = ContextVar("prism_current_project", default=None)

#: Held by every project switch (create, activate, delete, restore) and by every mutation that
#: checks ``CURRENT_PROJECT`` — for the check AND the mutation, so the answer cannot change under
#: it. Deliberately NOT ``lca._LCA_LOCK``: that one is held for the whole of a calculation (Monte
#: Carlo included), the parameter routes take it before the bus, and the bus must never wait for it
#: (test_scenario_formula_overrides, test_params_threadpool). Lock order, where both are taken:
#: ``lca._LCA_LOCK`` → ``PROJECT_LOCK`` → the bus's own lock. Commands never take the LCA lock, so
#: holding this one across a command is milliseconds.
PROJECT_LOCK = threading.RLock()


@contextmanager
def project_guard() -> Iterator[None]:
    """The check and the mutation as one step: for repository operations outside the bus (create,
    duplicate, rename, delete a model). The bus does the same inline in execute/undo/redo."""
    with PROJECT_LOCK:
        assert_expected_project()
        yield


def project_changed_error(expected: str, current: str | None) -> PrismError:
    now = f'"{current}"' if current else "no workspace"
    return PrismError(
        f'The active workspace changed: this session was opened on "{expected}", the app now has {now}. '
        "Reconnect to continue in the current workspace.",
        code="project_changed",
        status_code=409,
    )


def assert_expected_project() -> None:
    """Raise 409 when the request names a project other than the active one. Cheap; call it under
    ``PROJECT_LOCK`` where the answer cannot change until the caller is done."""
    expected = CURRENT_PROJECT.get()
    if expected is None:
        return
    current = get_bd().projects.current
    if current != expected:
        raise project_changed_error(expected, current)

#: What a turn id may look like on the wire. Anything else is treated as absent rather than stored:
#: the header crosses a trust boundary, and the log file is append-only forever.
TURN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: The external client (MCP server: Claude Code, Cowork, …) the current request came from, if
#: it said so. Set by the same middleware from ``X-Prism-Client`` and read once per audit line, in
#: ``_record`` — so executed commands, undo/redo, turn batches and notes all carry it without any
#: command knowing about it. A **label, never an identity**: nothing checks who sent it, and nothing
#: may be decided on it.
CURRENT_CLIENT: ContextVar[str | None] = ContextVar("prism_current_client", default=None)

#: What a client label may look like: 1–80 characters of letters, digits (Unicode ``\w``, so also
#: ``_``), space and ``._-/:``. Anything else is treated as absent, for the same reason as the turn.
CLIENT_LABEL_RE = re.compile(r"^[\w .\-/:]{1,80}\Z")


# --- audit-line helpers ------------------------------------------------------
# An audit summary is read by a person reconstructing what happened, so it names things the way the
# canvas does — process and flow NAMES, old → new values — not codes and uids. The names are
# captured while the objects still exist (execute() has them in hand anyway); naming must never
# fail the operation, so every helper falls back to the identifier it was given.


def _fmt(x: object) -> str:
    """A number for an audit line: trim float noise (0.30000000000000004 → 0.3), keep it short."""
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        return f"{x:g}"
    return str(x)


def _clip(text: object, limit: int = 60) -> str:
    joined = " ".join(str(text).split())
    return joined if len(joined) <= limit else joined[: limit - 1] + "…"


def _activity_label(database: str, code: str) -> str:
    try:
        return str(model.get_activity(database, code).get("name") or code)
    except Exception as exc:  # noqa: BLE001 - see above
        _log.swallowed(exc, "_activity_label")
        return code


def _exchange_label(database: str, code: str, uid: str) -> str:
    """ "'flow' in 'process'", captured while both still exist; the uid prefix is the fallback."""
    try:
        act = model.get_activity(database, code)
        ex = model.find_exchange(act, uid)
        return f"'{_clip(ex.input.get('name'), 50)}' in '{_clip(act.get('name'), 40)}'"
    except Exception as exc:  # noqa: BLE001 - see above
        _log.swallowed(exc, "_exchange_label")
        return f"exchange {uid[:8]}"


class AuditEntry(BaseModel):
    """One line of the log.

    The three attribution fields are **optional and written, never inferred**. Optional because
    older lines have none of them and have to stay readable; written because the alternative —
    reading the model's name out of ``summary`` — is a mistake this log once made. An entry that
    names no model is not attributed, full stop; it is shown as earlier history rather than guessed
    into a model's list.

    None of the three is ever serialised as ``null`` (``exclude_none`` in the bus), so an old line and
    a new unattributed line are byte-identical in shape. Nothing downstream has to know which era a
    line came from.
    """

    index: int
    timestamp: str
    source: str  # user | ai | import
    action: str
    summary: str
    undoable: bool = (
        True  # False = audit-only note (database lifecycle etc.), not in the undo history
    )
    #: The model that changed. None for project-wide actions (tag groups, ecoinvent import, backups).
    database: str | None = None
    #: Where the change came from, for the cross-model actions: copy, localize, duplicate, bundle
    #: import. The entry then reads as a change in `database` and as provenance in `related`.
    related: str | None = None
    #: Only for a project-wide action with model-wide consequences: the models it reached into.
    #: A list here and nowhere else — `database` would be formally right and practically a lie, since
    #: the model *did* change and its own view would say nothing.
    databases: list[str] | None = None
    #: On a `rename_model` note only: the name the model had until this line. Structured, because the
    #: read side has to link the two names *by position in the log* and the sentence in `summary`
    #: ("Rename model 'A' → 'B'") is prose — model names are free text and may hold quotes or arrows,
    #: so parsing it would be a guess about identity, which is a whole family of bug.
    previous_name: str | None = None
    #: The assistant turn (one chat message → one agent run) this change belongs to. Written,
    #: never inferred — it comes from the header the AI loop sends, so grouping the log by it is a
    #: fact, not a guess over timestamps. Absent on user/import actions and on every older line.
    turn: str | None = None
    #: The external client the request came from (``X-Prism-Client``). A label the
    #: client chose, not an identity. Absent on everything the app itself did and on every older line.
    client: str | None = None

    # --- computed on read, never stored --------------------------------------
    # These three are filled in by `CommandBus.audit()` from the timeline and are absent from every
    # line on disk. They are here rather than in the route because the route serialises this model,
    # and a reader wants one shape. `exclude_none` keeps them off the wire unless there is something
    # to say — and a test asserts the log file never contains any of them.
    #: The model's name **today**, when it differs from `database` (i.e. it has been renamed since).
    current_name: str | None = None
    #: The model this entry belongs to no longer exists. True or absent, never False.
    model_gone: bool | None = None
    #: Set on the one entry that created the model being asked about, out of another model: the source
    #: it was copied from. Only ever present in a model-scoped answer.
    copied_from: str | None = None
    #: In a model-scoped answer: this line names no model because it changed none — a workspace-wide
    #: action written after entries began naming their model (a tag group, a tag value). It belongs in
    #: every model's list, in its place in time, not in the "earlier history" block. True or absent.
    workspace: bool | None = None


class Command(ABC):
    action: str = "command"

    #: On the positive list of the model-scoped Undo: this
    #: step reads and writes nothing but its own model's data — no other model, no library dataset, no
    #: shared vocabulary, and it creates or deletes no process another model could link to. Only such
    #: steps may be undone out of order, and only past other models' such steps; everything else stays a
    #: barrier. Set per class, each one checked against its execute/undo, never inferred.
    local_to_model: bool = False

    #: The assistant turn this command was executed under, stamped by the bus at execute time.
    #: Lives on the command — not only in the log — because the undo/redo stacks hold command
    #: objects, and "does the top of the stack still belong to that turn?" is the question a
    #: turn-wide undo has to answer against the stack, not against the file.
    turn: str | None = None

    #: When the command was first executed (epoch seconds), stamped by the bus. Kept through undo and redo:
    #: the canvas keeps an undo history of its own (the arrangement is view state, not a command), and the
    #: toolbar's Undo takes back whichever of the two happened last — this is what it compares.
    executed_at: float | None = None

    #: Name of the instance attribute holding the model this command changes, or None for a command
    #: whose changes belong to no single model. **Every concrete subclass must decide**, and a
    #: tripwire test (`test_command_attribution.py`) turns a new class that decided neither into a
    #: red suite — a command that quietly writes unattributed lines is the failure this field exists
    #: to prevent, and it is invisible in review.
    #:
    #: One declared attribute name rather than 35 hand-written methods: the information is already
    #: in the constructor, so the honest amount of new code is the one line that says *which*
    #: attribute it is. The five commands that cannot answer from an attribute override
    #: :meth:`audit_database` instead.
    audit_attr: str | None = None

    @abstractmethod
    def execute(self) -> dict: ...

    @abstractmethod
    def undo(self) -> None: ...

    @abstractmethod
    def summary(self) -> str: ...

    def audit_database(self) -> str | None:
        """The model this command changed, for the audit entry. None = attributed to no model.

        Asked **after** ``execute()`` (and after ``undo()``/``redo()``), which is what lets a command
        that only learns its model while running — the bundle import picks a free name — answer at
        all.
        """
        if not self.audit_attr:
            return None
        value = getattr(self, self.audit_attr, None)
        return str(value) if value else None

    def audit_related(self) -> str | None:
        """The model this change came *from*, for the four cross-model commands. Default: none."""
        return None

    def audit_databases(self) -> list[str] | None:
        """The models a project-wide command reached into. Default: none."""
        return None

    def scope_models(self) -> list[str] | None:
        """The models this command will write, known **before** it executes — what the chat's model
        fence (model_scope.py) checks. None = it writes into no model at all (workspace vocabulary).

        The audit fields cannot answer this: several are only known after the run. By default the
        model in ``audit_attr``; a command without one answers for itself, and the tripwire in
        test_model_scope.py turns one that does not into a red suite. Unanswered, the fence refuses
        it — ``""`` names no model, and a fence fails closed."""
        if not self.audit_attr:
            return [""]
        value = getattr(self, self.audit_attr, None)
        return [str(value) if value else ""]

    def scope_suppliers(self) -> list[str]:
        """The databases this command links into a model as inputs — the fence allows no other model
        there. Default: none."""
        return []


def _split_key(key: str) -> tuple[str, str]:
    """``(database, code)`` of a tag-store key (``database/code``), split from the right as the store
    does (tags.py): a code holds no slash, a model name may."""
    database, _, code = key.rpartition("/")
    return database, code


def _key_models(keys: Iterable[str]) -> list[str]:
    """The models a set of tag-store keys belongs to."""
    return sorted({_split_key(key)[0] for key in keys})


# --------------------------------------------------------------------------- #
# Foreground model commands
# --------------------------------------------------------------------------- #
def _relink(consumers: list[dict], from_key: tuple, to_activity) -> None:
    """Point every recorded consumer edge at ``to_activity`` instead of ``from_key``.

    Written as a swap rather than an edit because bw2data has no "change the input of this edge":
    the old edge goes and an identical one is created, which is why every field was recorded.
    """
    for c in consumers:
        consumer = model.get_activity(c["consumer"][0], c["consumer"][1])
        for ex in list(consumer.exchanges()):
            # The recorded exchange by its uid, when it has one: the consumer may draw on the same supplier
            # through a second input (another canvas box, another phase) that must stay where it is.
            if tuple(ex.input.key) == tuple(from_key) and (not c.get("uid") or ex.get("prism_uid") == c["uid"]):
                ex.delete()
        edge = consumer.new_edge(input=to_activity, amount=c["amount"], type=c["type"])
        for k, v in (c.get("fields") or {}).items():
            edge[k] = v
        if c.get("uid"):
            edge["prism_uid"] = c["uid"]
        edge.save()


def _copy_exchanges(src, new, uids: dict[str, str] | None = None) -> list[tuple[str | None, str]]:
    """Copy every exchange of ``src`` onto ``new`` COMPLETELY — amount/type plus formula,
    uncertainty, pedigree, comment, properties (via exchange_extra_fields). Production edges
    re-point at the copy; other inputs stay shared with the original.

    ``uids`` maps each source exchange (its uid, or its input and type for one without) to the uid its
    copy got the first time: a command passes back on redo what it got, so a later step that addresses
    a copied exchange by uid (an amount, a tag) still finds it — by identity, not by position, because
    an undone delete brings an exchange back in another place. Returns ``(source uid, copy uid)`` per
    exchange and fills ``uids`` when given."""
    has_formula = False
    pairs: list[tuple[str | None, str]] = []
    seen: dict[str, int] = {}
    for ex in src.exchanges():
        target_input = new if ex.get("type") == "production" else ex.input
        ne = new.new_edge(input=target_input, amount=ex.get("amount"), type=ex.get("type"))
        for k, v in model.exchange_extra_fields(ex).items():
            ne[k] = v
        ident = ex.get("prism_uid") or f"{ex.input.key[0]}/{ex.input.key[1]}|{ex.get('type')}"
        if not ex.get("prism_uid"):
            seen[ident] = seen.get(ident, 0) + 1
            ident = f"{ident}|{seen[ident]}"
        ne["prism_uid"] = (uids or {}).get(ident) or model.new_uid()
        if uids is not None:
            uids[ident] = ne["prism_uid"]
        ne.save()
        pairs.append((ex.get("prism_uid"), ne["prism_uid"]))
        has_formula = has_formula or bool(ne.get("formula"))
    if has_formula:
        # Copied formulas need their own parameter group, else they'd never recalculate.
        params.register_activity_group(new)
    return pairs


class CreateActivityCommand(Command):
    action = "create_activity"
    audit_attr = "database"

    def __init__(self, database, name, product=None, unit=None, location=None):
        self.database = database
        self.name = name
        self.product = product
        self.unit = unit
        self.location = location
        self._code = model.new_uid()

    def execute(self) -> dict:
        act = model.create_activity(
            self.database, self._code, self.name, self.product, self.unit, self.location
        )
        return model.activity_detail(act)

    def undo(self) -> None:
        model.get_activity(self.database, self._code).delete()

    def summary(self) -> str:
        unit = f", unit {self.unit}" if self.unit else ""
        product = (
            f", product '{self.product}'" if self.product and self.product != self.name else ""
        )
        return f"Create process '{self.name}'{product}{unit} in {self.database}"


class DeleteActivityCommand(Command):
    """Delete a foreground activity. bw2data's ``Activity.delete()`` silently cascades into
    every CONSUMER's input exchange — so deleting a consumed activity is blocked unless
    ``force`` is set, and the consumer edges are snapshotted so undo restores them too."""

    action = "delete_activity"
    audit_attr = "database"

    def __init__(self, database, code, force: bool = False):
        self.database = database
        self.code = code
        self.force = force
        self._snap: dict | None = None
        self._consumers: list[dict] = []
        self._name: str | None = None

    def execute(self) -> dict:
        act = model.get_activity(self.database, self.code)
        self._name = act.get("name")
        upstream = list(act.upstream())
        consumers = [
            {
                "consumer": list(up.output.key),
                "amount": up.get("amount"),
                "type": up.get("type"),
                "uid": up.get("prism_uid"),
                "fields": model.exchange_extra_fields(up),
            }
            for up in upstream
        ]
        if consumers and not self.force:
            names = sorted({c["consumer"][1] for c in consumers})
            # The consuming processes once each, by name and model, for the canvas's confirm dialog — it
            # cannot see consumers in other models, and the cascade reaches them too.
            by_key = {up.output.key: up.output.get("name") or up.output.key[1] for up in upstream}
            raise PrismError(
                f"'{self.code}' is consumed by {len(consumers)} exchange(s) "
                f"(activities: {', '.join(names[:6])}{'…' if len(names) > 6 else ''}) — "
                "deleting it would silently remove those inputs.",
                code="delete_blocked",
                status_code=409,
                hint="Remove the consuming exchanges first, or pass force=true to delete anyway "
                "(undo restores the consumer links).",
                details={
                    "consumers": [
                        {"database": key[0], "code": key[1], "name": name} for key, name in by_key.items()
                    ]
                },
            )
        self._snap = model.activity_snapshot(self.database, self.code)
        self._consumers = consumers
        model.delete_activity(self.database, self.code)
        return {"deleted": self.code, "database": self.database, "cascaded_inputs": len(consumers)}

    def scope_models(self) -> list[str] | None:
        """This model, and with ``force`` every model whose input the cascade removes: bw2data deletes
        the consumers' exchanges, wherever they live."""
        if not self.force:
            return [self.database]
        # Before the run from the live process; after it (an undo puts the consumers back) from the
        # snapshot the undo restores them from.
        consumers = {str(c["consumer"][0]) for c in self._consumers}
        try:
            consumers |= {up.output.key[0] for up in model.get_activity(self.database, self.code).upstream()}
        except Exception as exc:  # noqa: BLE001 - a deleted or missing process is not the fence's error
            _log.swallowed(exc, "DeleteActivityCommand.scope_models")
        return sorted({self.database, *consumers})

    def undo(self) -> None:
        if self._snap is None:
            return
        model.restore_activity(self.database, self.code, self._snap)
        restored = model.get_activity(self.database, self.code)
        # A recreated exchange carries its formula text but is not in any parameter group: bw2data
        # dropped the registration with the delete, and `new_edge` does not add one. Without this
        # the amount stands as restored and never follows the parameter again.
        if any(e.get("formula") for e in restored.exchanges()):
            params.register_activity_group(restored)
        # Re-attach the consumer→deleted edges wiped by bw2data's upstream cascade.
        for c in self._consumers:
            consumer = model.get_activity(c["consumer"][0], c["consumer"][1])
            ex = consumer.new_edge(input=restored, amount=c["amount"], type=c["type"])
            for k, v in (c.get("fields") or {}).items():
                ex[k] = v
            if c.get("uid"):
                ex["prism_uid"] = c["uid"]
            ex.save()
            if (c.get("fields") or {}).get("formula"):
                params.register_activity_group(consumer)

    def summary(self) -> str:
        extra = f" (+{len(self._consumers)} consumer link(s))" if self._consumers else ""
        return f"Delete process '{self._name or self.code}' from {self.database}{extra}"


class MoveToLibraryCommand(Command):
    """Move a process out of a model and into the library, leaving a link behind.

    The inverse of Localize. Afterwards the model no longer owns the process: its node is a
    reference into ``My processes``, read-only there the way an ecoinvent dataset is, and a change
    made in the library reaches this study and every other one drawing on it. That linking is the
    whole point — a plain copy would leave two processes that drift apart, and a correction would
    have to be made twice.

    **Formulas are refused, not frozen.** An ``fx`` formula on an exchange is driven by the
    parameters of *this* model, and parameters are per model — the library cannot resolve them. The
    quiet alternatives are both worse: freezing them turns a parameterised process into fixed
    numbers that no longer follow their driver, and carrying the text along leaves a formula
    referring to a variable that does not exist where it now lives.
    """

    action = "move_to_library"
    audit_attr = "database"

    def __init__(self, database, code):
        self.database = database
        self.code = code
        self._new_code = model.new_uid()
        self._snap: dict | None = None
        self._consumers: list[dict] = []
        self._name: str | None = None
        self._uids: dict[str, str] = {}  # the copies' uids, kept for redo (see _copy_exchanges)
        self._moved_tags: dict[str, list[dict]] = {}  # consumer input tags before the move, for undo
        self._dropped_tags = 0

    def execute(self) -> dict:
        bd = get_bd()
        assert_writable(self.database)
        if is_library(self.database):
            raise PrismError(
                "This dataset is already in the library.",
                code="already_in_library",
                status_code=409,
            )
        act = model.get_activity(self.database, self.code)
        self._name = act.get("name")

        formulas = sorted(
            {
                (ex.input.get("name") or ex.get("name") or "?")
                for ex in act.exchanges()
                if str(ex.get("formula") or "").strip()
            }
        )
        if formulas:
            shown = ", ".join(formulas[:4]) + ("…" if len(formulas) > 4 else "")
            raise PrismError(
                f"'{self._name or self.code}' has formulas on {len(formulas)} of its flows "
                f"({shown}). They are driven by this model's parameters, and the library has none — "
                "moving it would leave those numbers fixed and no longer following their driver.",
                code="has_formulas",
                status_code=409,
                hint="Replace the formulas with plain amounts first, or keep this process in the "
                "model and build a library version separately.",
            )

        ensure_library()
        target = bd.Database(LIBRARY_DB)
        new = target.new_activity(
            code=self._new_code,
            name=act.get("name"),
            unit=act.get("unit") or "unit",
            location=act.get("location") or "GLO",
        )
        if act.get("reference product"):
            new["reference product"] = act.get("reference product")
        if act.get("comment"):
            new["comment"] = act.get("comment")
        new["type"] = "process"
        new.save()
        try:
            _copy_exchanges(act, new, self._uids)
        except Exception:
            new.delete()  # never leave a half-copied orphan behind
            raise

        # Everything that consumed the process now consumes the library copy. Recorded first, so
        # undo can put every edge back exactly as it was — amount, type, comment, uid and all.
        self._consumers = [
            {
                "consumer": list(up.output.key),
                "amount": up.get("amount"),
                "type": up.get("type"),
                "uid": up.get("prism_uid"),
                "fields": model.exchange_extra_fields(up),
            }
            for up in act.upstream()
        ]
        self._snap = model.activity_snapshot(self.database, self.code)
        _relink(self._consumers, (self.database, self.code), new)
        self._carry_tags_to_consumers()
        model.delete_activity(self.database, self.code)
        out = {
            "database": LIBRARY_DB,
            "code": self._new_code,
            "was": {"database": self.database, "code": self.code},
            "relinked": len(self._consumers),
        }
        if self._dropped_tags:
            out["tags_dropped"] = self._dropped_tags
            out["note"] = (
                f"{self._dropped_tags} input tag(s) inside the process were dropped: the library carries no "
                "tags. Its inputs now count under the phase of the model input that draws on it."
            )
        return out

    def _carry_tags_to_consumers(self) -> None:
        """The library carries no tags, so the process's own tags move onto the model inputs that now
        draw on the library copy: the breakdown stays what it was. Tags on the process's own inputs cannot
        follow (the copy is in the library) — they are counted and reported."""
        store = TagStore()
        own = store.list_for(self.database, self.code)
        self._dropped_tags = sum(
            1 for key, tags in store.load_map().items()
            if tags and key.startswith(f"{self.database}/{self.code}{TagStore.EXCHANGE_SEP}")
        )
        keys = [
            f"{c['consumer'][0]}/{TagStore.exchange_code(c['consumer'][1], c['uid'])}"
            for c in self._consumers if c["consumer"][0] != LIBRARY_DB and c.get("uid")
        ]
        self._moved_tags = store.lists_for(keys) if own else {}
        for key in self._moved_tags:
            db, code = _split_key(key)
            # Per dimension: what the input already says in a dimension stays; the rest comes from the process.
            present = {t["dimension"] for t in store.list_for(db, code)}
            for tag in own:
                if tag["dimension"] not in present:
                    store.set_tag(db, code, tag["dimension"], tag["value"])

    def undo(self) -> None:
        if self._snap is None:
            return
        if self._moved_tags:
            TagStore().rewrite_lists(self._moved_tags)
        model.restore_activity(self.database, self.code, self._snap)
        restored = model.get_activity(self.database, self.code)
        _relink(self._consumers, (LIBRARY_DB, self._new_code), restored)
        model.get_activity(LIBRARY_DB, self._new_code).delete()

    def summary(self) -> str:
        extra = f", {len(self._consumers)} link(s) re-pointed" if self._consumers else ""
        return f"Move '{self._name or self.code}' from {self.database} into {LIBRARY_DB}{extra}"

    def scope_models(self) -> list[str] | None:
        """The model it leaves and the library it lands in — both are written."""
        return [self.database, LIBRARY_DB]


class CopyToForegroundCommand(Command):
    """Copy a (background) dataset into a foreground model as an editable process.

    With ``relink_consumers`` — the canvas's Localize — every process of the target model that
    consumed the original consumes the copy afterwards. The canvas re-points its arrows at the copy
    either way; without the relink the picture and the calculation disagreed.
    Only the target model's consumers move: the source's own consumers (a whole ecoinvent) stay.
    """

    action = "copy_to_foreground"
    audit_attr = "target_database"

    def __init__(self, source_database, source_code, target_database, relink_consumers: bool = False,
                 uids: list[str] | None = None):
        self.source_database = source_database
        self.source_code = source_code
        self.target_database = target_database
        self.relink_consumers = relink_consumers
        #: With relink: only these consumer inputs move to the copy (one canvas box), not every consumer.
        #: An empty list moves none (a copy on the canvas that was never connected).
        self.only_uids = set(uids) if uids is not None else None
        self._code = model.new_uid()
        self._name: str | None = None
        self._consumers: list[dict] = []
        self._uids: dict[str, str] = {}  # the copies' uids, kept for redo (see _copy_exchanges)
        self._written_tags: list[str] = []
        self._input_tags: dict[str, list[dict]] = {}  # input tags folded into the copy, for undo

    def execute(self) -> dict:
        bd = get_bd()
        assert_writable(self.target_database)
        src = model.get_activity(self.source_database, self.source_code)
        self._name = src.get("name")
        tgt = bd.Database(self.target_database)
        new = tgt.new_activity(
            code=self._code,
            name=src.get("name"),
            unit=src.get("unit") or "unit",
            location=src.get("location") or "GLO",
        )
        if src.get("reference product"):
            new["reference product"] = src.get("reference product")
        new["type"] = "process"
        new.save()
        try:
            pairs = _copy_exchanges(src, new, self._uids)
        except Exception:
            new.delete()  # never leave a half-copied orphan behind
            raise
        from prism_lca.engine.tag_scope import MODEL, copy_process_tags, tag_kind

        store = TagStore()
        self._written_tags = []
        if tag_kind(self.source_database) == MODEL:  # a process of another model keeps what it carried
            self._written_tags = copy_process_tags(
                store, (self.source_database, self.source_code), (self.target_database, self._code), pairs
            )
        if self.relink_consumers:
            # Recorded first, so undo puts every edge back exactly as it was (amount, uid, fields).
            self._consumers = [
                {
                    "consumer": list(up.output.key),
                    "amount": up.get("amount"),
                    "type": up.get("type"),
                    "uid": up.get("prism_uid"),
                    "fields": model.exchange_extra_fields(up),
                }
                for up in src.upstream()
                if up.output.key[0] == self.target_database and up.get("type") != "production"
                and (self.only_uids is None or up.get("prism_uid") in self.only_uids)
            ]
            _relink(self._consumers, (self.source_database, self.source_code), new)
            self._fold_input_tags(store)
        detail = model.activity_detail(new)
        detail["relinked"] = len(self._consumers)
        return detail

    def _fold_input_tags(self, store) -> None:
        """The relinked inputs now draw on a process of their own model, where a tag belongs on the
        process. When they all carry the same tags (one canvas box), those become the copy's own tags and
        leave the inputs; the breakdown stays exact. Differing tags stay on the inputs."""
        keys = [
            f"{c['consumer'][0]}/{TagStore.exchange_code(c['consumer'][1], c['uid'])}"
            for c in self._consumers if c.get("uid")
        ]
        lists = store.lists_for(keys)
        self._input_tags = {}
        variants = {tuple(sorted((t["dimension"], t["value"]) for t in tags)) for tags in lists.values()}
        if len(variants) != 1 or not next(iter(variants)):
            return
        self._input_tags = lists
        for dimension, value in next(iter(variants)):
            store.set_tag(self.target_database, self._code, dimension, value)
        self._written_tags = sorted(set(self._written_tags) | {f"{self.target_database}/{self._code}"})
        store.rewrite_lists({k: [] for k in keys})

    def undo(self) -> None:
        from prism_lca.engine.tag_scope import drop_keys

        store = TagStore()
        if self._input_tags:
            store.rewrite_lists(self._input_tags)
        drop_keys(store, self._written_tags)
        if self._consumers:
            src = model.get_activity(self.source_database, self.source_code)
            _relink(self._consumers, (self.target_database, self._code), src)
        model.get_activity(self.target_database, self._code).delete()

    def summary(self) -> str:
        extra = f", {len(self._consumers)} link(s) re-pointed" if self._consumers else ""
        return (
            f"Copy '{self._name or self.source_code}' from {self.source_database} "
            f"into {self.target_database} (editable){extra}"
        )

    def audit_related(self) -> str | None:
        """The entry is a change in the target and provenance in the source. Both lists show it.
        That also settles whose undo it is: the undo of this belongs to neither model alone."""
        return self.source_database or None


class DuplicateActivityCommand(Command):
    """Duplicate a foreground activity within its own database (name gets a ' (copy)' suffix).
    Off-process inputs (other activities, background, biosphere) are shared with the original."""

    action = "duplicate_activity"
    audit_attr = "database"

    def __init__(self, database, code):
        self.database = database
        self.code = code
        self._code = model.new_uid()
        self._name: str | None = None
        self._uids: dict[str, str] = {}  # the copies' uids, kept for redo (see _copy_exchanges)
        self._written_tags: list[str] = []

    def execute(self) -> dict:
        bd = get_bd()
        assert_writable(self.database)
        src = model.get_activity(self.database, self.code)
        self._name = src.get("name")
        tgt = bd.Database(self.database)
        new = tgt.new_activity(
            code=self._code,
            name=f"{src.get('name')} (copy)",
            unit=src.get("unit") or "unit",
            location=src.get("location") or "GLO",
        )
        if src.get("reference product"):
            new["reference product"] = src.get("reference product")
        new["type"] = "process"
        new.save()
        try:
            pairs = _copy_exchanges(src, new, self._uids)
        except Exception:
            new.delete()  # never leave a half-copied orphan behind
            raise
        from prism_lca.engine.tag_scope import copy_process_tags

        # The copy counts where the original counts: its phase and its inputs' phases come along.
        self._written_tags = copy_process_tags(
            TagStore(), (self.database, self.code), (self.database, self._code), pairs
        )
        return model.activity_detail(new)

    def undo(self) -> None:
        from prism_lca.engine.tag_scope import drop_keys

        drop_keys(TagStore(), self._written_tags)
        model.get_activity(self.database, self._code).delete()

    def summary(self) -> str:
        name = self._name or self.code
        return f"Duplicate '{name}' in {self.database} (as '{name} (copy)')"


class LocalizePathCommand(Command):
    """Pull a whole path (FU → … → target) out of a background database into the editable
    foreground: copy each node, then re-link consecutive copies so the path is connected in the
    foreground while every off-path input still points at the background. Impacts are unchanged
    until the user edits a copy. Builds on the same copy mechanism as CopyToForegroundCommand."""

    action = "localize_path"
    audit_attr = "target_database"

    def __init__(self, target_database, path):
        self.target_database = target_database
        self.path = [tuple(p) for p in path]
        self._codes = [model.new_uid() for _ in self.path]  # fixed so redo reproduces exactly
        self._uids: dict[str, dict[str, str]] = {}  # per copy, its exchanges' uids — the same on redo
        self._ends: tuple[str, str] | None = None  # (first name, last name), for the audit line

    def _copy(self, bd, src_db, src_code, new_code):
        src = model.get_activity(src_db, src_code)
        new = bd.Database(self.target_database).new_activity(
            code=new_code,
            name=src.get("name"),
            unit=src.get("unit") or "unit",
            location=src.get("location") or "GLO",
        )
        if src.get("reference product"):
            new["reference product"] = src.get("reference product")
        new["type"] = "process"
        new["prism_localized_from"] = [src_db, src_code]
        new.save()
        try:
            _copy_exchanges(src, new, self._uids.setdefault(new_code, {}))
        except Exception:
            new.delete()  # never leave a half-copied orphan behind
            raise
        return new

    def execute(self) -> dict:
        bd = get_bd()
        assert_writable(self.target_database)
        try:
            mapping = {
                key: self._copy(bd, key[0], key[1], code)
                for key, code in zip(self.path, self._codes, strict=True)
            }
            # re-link parent copy -> child copy for each consecutive pair on the path
            for parent_key, child_key in zip(
                self.path, self.path[1:], strict=False
            ):  # pairwise by design
                p_copy, c_copy = mapping[parent_key], mapping[child_key]
                for ex in list(p_copy.technosphere()):
                    if tuple(ex.input.key) == child_key:
                        amount, uid = ex.get("amount"), ex.get("prism_uid")
                        extra = model.exchange_extra_fields(ex)
                        ex.delete()
                        ne = p_copy.new_edge(input=c_copy, amount=amount, type="technosphere")
                        for k, v in extra.items():
                            ne[k] = v
                        ne["prism_uid"] = uid
                        ne.save()
        except Exception:
            self.undo()  # multi-activity operation: clean up everything created so far
            raise
        names = [mapping[k].get("name") or k[1] for k in self.path]
        self._ends = (str(names[0]), str(names[-1]))
        return {
            "target_database": self.target_database,
            "count": len(self.path),
            "copies": [
                {"from": list(k), "code": mapping[k].key[1], "name": mapping[k].get("name")}
                for k in self.path
            ],
        }

    def undo(self) -> None:
        for new_code in self._codes:
            try:
                model.get_activity(self.target_database, new_code).delete()
            except Exception as exc:  # noqa: BLE001 - best-effort cleanup
                _log.swallowed(exc, "undo")

    def summary(self) -> str:
        span = ""
        if self._ends:
            first, last = (_clip(n, 40) for n in self._ends)
            span = f" ('{first}' → '{last}')" if first != last else f" ('{first}')"
        return f"Localize path of {len(self.path)} processes{span} into {self.target_database}"

    def audit_related(self) -> str | None:
        """The database the path was pulled out of. The path's root, not a joined set: `related` is
        one name, and every path this command is given starts in the database being localised from —
        a path that crossed two would still be *entered* from one."""
        return (self.path[0][0] if self.path else None) or None


class ImportModelCommand(Command):
    """Atomically import a foreground model (activities + exchanges) into one database. Every
    input is resolved up front; if any exchange can't link, nothing is written and the offending
    rows are reported — no half-linked model ever lands. Undo deletes exactly what was created."""

    action = "import_model"
    audit_attr = "target_database"

    def __init__(self, target_database, activities, exchanges):
        self.target_database = target_database
        self.activities = activities
        self.exchanges = exchanges
        self._created: list[str] = []
        self._uids: dict[int, str] = {}  # per exchange row, the uid it got the first time — the same on redo

    def _validate(self, bd) -> None:
        errors: list[str] = []
        new_codes = set()
        for i, a in enumerate(self.activities):
            code, name = a.get("code"), a.get("name")
            if not code or not name:
                errors.append(f"activity row {i + 1}: code and name are required")
            elif code in new_codes:
                errors.append(f"activity row {i + 1}: duplicate code '{code}'")
            else:
                new_codes.add(code)
        if self.target_database in bd.databases:
            db = bd.Database(self.target_database)
            for code in new_codes:
                try:
                    db.get(code)
                    errors.append(f"activity '{code}' already exists in {self.target_database}")
                except Exception as exc:  # noqa: BLE001 - UnknownObject means the code is free
                    _log.swallowed(exc, "_validate")

        from prism_lca.engine.tag_scope import MODEL, tag_kind

        tags_allowed = tag_kind(self.target_database) == MODEL
        if not tags_allowed:
            for i, a in enumerate(self.activities):
                if str(a.get("tags") or "").strip():
                    errors.append(f"activity row {i + 1}: tags — the library carries no tags")
        allowed_types = {"technosphere", "biosphere", "production", "substitution"}
        for i, ex in enumerate(self.exchanges):
            if ex.get("activity_code") not in new_codes:
                errors.append(
                    f"exchange row {i + 1}: unknown activity_code '{ex.get('activity_code')}'"
                )
            # Convert/validate VALUES up front too — a text cell like "1,5" must reject the
            # import as a whole, not raise mid-write (the docstring promises atomicity).
            try:
                float(ex.get("amount") or 0.0)
            except (TypeError, ValueError):
                errors.append(f"exchange row {i + 1}: amount '{ex.get('amount')}' is not a number")
            # The distribution cells are converted the same way during the write — checked here for
            # the same reason as the amount: a text cell must reject the sheet, not stop the import
            # half-way through with activities already created.
            for cell in ("uncertainty_type", "loc", "scale", "minimum", "maximum"):
                if ex.get(cell) in (None, ""):
                    continue
                try:
                    float(ex[cell])
                except (TypeError, ValueError):
                    errors.append(f"exchange row {i + 1}: {cell} '{ex.get(cell)}' is not a number")
            etype = ex.get("type") or "technosphere"
            if etype not in allowed_types:
                errors.append(f"exchange row {i + 1}: unknown exchange type '{etype}'")
            idb, icode = ex.get("input_database"), ex.get("input_code")
            # An input's own tags (see tag_scope): only on an input from outside the imported model, and
            # only into a model — the library carries no tags.
            if str(ex.get("tags") or "").strip() and (
                etype not in ("technosphere", "substitution") or icode in new_codes or not tags_allowed
            ):
                errors.append(
                    f"exchange row {i + 1}: tags on this row — only an input from outside the model "
                    "(background, library, another model) carries tags of its own; tag the process instead"
                )
            # an input that names an imported activity links locally (self-contained model),
            # regardless of the source db recorded in the sheet; otherwise it must already exist.
            if icode not in new_codes:
                try:
                    bd.get_node(database=idb, code=icode)
                except Exception as exc:
                    _log.swallowed(exc, "_validate")
                    errors.append(
                        f"exchange row {i + 1}: input {idb}/{icode} does not link to any activity"
                    )
        if errors:
            raise PrismError(
                f"Import rejected: {len(errors)} problem(s) found; nothing was written.",
                code="import_unlinked",
                status_code=422,
                hint="; ".join(errors[:12]),
            )

    def execute(self) -> dict:
        bd = get_bd()
        assert_writable(self.target_database)
        self._validate(bd)

        self._created = []  # reset so a redo doesn't accumulate stale codes
        tag_store = TagStore()
        for a in self.activities:
            act = model.create_activity(
                self.target_database,
                a["code"],
                a["name"],
                a.get("reference_product"),
                a.get("unit"),
                a.get("location"),
            )
            if a.get("comment"):
                act["comment"] = a["comment"]
                act.save()
            # Tags come as "dimension=value; dimension=value" in one cell (see engine/interop.py).
            for part in str(a.get("tags") or "").split(";"):
                dim, _, val = part.partition("=")
                if dim.strip() and val.strip():
                    tag_store.add(self.target_database, a["code"], dim.strip(), val.strip())
            self._created.append(a["code"])
        new_codes = {a["code"] for a in self.activities}
        n_exchanges = 0
        for row_index, ex in enumerate(self.exchanges):
            act = model.get_activity(self.target_database, ex["activity_code"])
            input_db = (
                self.target_database if ex["input_code"] in new_codes else ex["input_database"]
            )
            inp = model.get_activity(input_db, ex["input_code"])
            if (ex.get("type") or "technosphere") == "production":
                # `create_activity` already gave the activity its production exchange (amount 1).
                # A production row in the sheet — written when the amount is not 1, or the exchange
                # carries a formula or a distribution — sets THAT exchange rather than adding a
                # second one. Before this the sheet dropped production rows on export and every
                # activity came back producing 1, so a process making 2 kg reimported at 1 kg with
                # its emissions unchanged.
                edge = next(iter(act.production()))
                edge["amount"] = float(ex.get("amount") or 0.0)
            else:
                edge = act.new_edge(
                    input=inp,
                    amount=float(ex.get("amount") or 0.0),
                    type=ex.get("type") or "technosphere",
                )
                edge["prism_uid"] = self._uids.setdefault(row_index, model.new_uid())
            # What the old two-column sheet dropped: the formula behind an amount, the distribution
            # around it, and the note saying where the number came from. All three are modelling
            # decisions; a round trip that loses them is not a round trip.
            if ex.get("formula"):
                edge["formula"] = str(ex["formula"])
            if ex.get("comment"):
                edge["comment"] = str(ex["comment"])
            if ex.get("uncertainty_type") not in (None, ""):
                edge["uncertainty type"] = int(float(ex["uncertainty_type"]))
                for src, dst in (
                    ("loc", "loc"),
                    ("scale", "scale"),
                    ("minimum", "minimum"),
                    ("maximum", "maximum"),
                ):
                    if ex.get(src) not in (None, ""):
                        edge[dst] = float(ex[src])
            edge.save()
            for part in str(ex.get("tags") or "").split(";"):
                dim, _, val = part.partition("=")
                if dim.strip() and val.strip():
                    tag_store.set_tag(self.target_database, TagStore.exchange_code(act.key[1], edge["prism_uid"]),
                                      dim.strip(), val.strip())
            n_exchanges += 1
        # A formula that belongs to no parameter group never recalculates — the same trap the
        # duplicate path documents a few hundred lines up.
        unresolved = ""
        if any(ex.get("formula") for ex in self.exchanges):
            for code in self._created:
                act = model.get_activity(self.target_database, code)
                if any(e.get("formula") for e in act.exchanges()):
                    params.register_activity_group(act)
            try:
                params.recalc_database(self.target_database)
            except Exception as exc:  # noqa: BLE001 - bw2parameters raises its own error types
                # The sheet carries formulas but no parameters (a spreadsheet is the wrong shape for
                # those — `engine/bundle.py` is what carries a whole model). So a formula can name
                # something this model does not have yet. The formula text is kept and the amount
                # stands as imported: throwing the formula away would be the very loss this change
                # set out to fix, and failing the import would be worse than saying what is missing.
                _log.swallowed(exc, "execute")
                unresolved = str(exc)
        out = {
            "target_database": self.target_database,
            "activities": len(self._created),
            "exchanges": n_exchanges,
        }
        if unresolved:
            out["formulas_unresolved"] = unresolved
        return out

    def undo(self) -> None:
        for code in self._created:
            try:
                model.get_activity(self.target_database, code).delete()
            except Exception as exc:  # noqa: BLE001 - best-effort cleanup
                _log.swallowed(exc, "undo")

    def summary(self) -> str:
        return (
            f"Import {len(self.activities)} processes + {len(self.exchanges)} exchanges "
            f"into {self.target_database}"
        )


class ImportBundleCommand(Command):
    """Land a whole `.prism` bundle: the graph plus every section this version understands.

    One command, so the whole import is one line in the audit log and one Undo — importing a model and
    then having to delete a database, its parameters, its tags and its scenarios by hand would be the
    kind of half-finished state the command bus exists to prevent.

    Every background reference is resolved *before* this runs (the endpoint refuses otherwise), so the
    only failures left here are real ones: a name collision, a malformed section. Undo deletes the
    model and everything that came with it, which is exactly what `delete_foreground_database` does.
    """

    action = "import_bundle"

    def __init__(
        self, opened: dict, mapping: dict, name: str | None = None, include: list[str] | None = None
    ) -> None:
        self.opened = opened
        self.mapping = mapping
        self.requested_name = name
        self.include = include
        self._database = ""
        self._unknown_files: list[str] = []
        self._library_added: list[str] = []
        self._uids: dict[int, str] = {}  # per graph row, the exchange uid — the same on redo

    def execute(self) -> dict:
        from prism_lca.engine import bundle as _bundle
        from prism_lca.engine import bundle_unknown

        sections = self.opened.get("sections") or {}
        manifest = self.opened.get("manifest") or {}
        graph = sections.get("graph")
        if not graph:
            raise PrismError("The bundle has no model in it.", code="bundle_no_graph")

        wanted = (
            self.requested_name or (manifest.get("model") or {}).get("name") or "Imported model"
        )
        self._database = _bundle.free_model_name(str(wanted))

        chosen = self.include if self.include is not None else list(sections)
        # The library before the graph: the model's links into "My processes" point at datasets the
        # bundle lands there, under the codes the landing actually used.
        mapping = dict(self.mapping)
        applied: list[str] = []
        library_result = {"added": [], "kept": 0}
        if "library" in sections and "library" in chosen:
            payload = dict(sections["library"])
            payload["_mapping"] = self.mapping
            library_result = _bundle.read_library(self._database, payload)
            self._library_added = list(library_result["added"])
            mapping.update(library_result["mapping"])
            applied.append("library")
        try:
            graph_payload = dict(graph)
            graph_payload["_mapping"] = mapping
            graph_payload["_uids"] = self._uids
            _bundle.read_graph(self._database, graph_payload)
        except Exception:
            _bundle.remove_library_datasets(self._library_added)
            self._library_added = []
            raise
        # Right here, not at the end: a freshly registered database counts as read-only until this
        # runs, so every section that writes to the model would be refused — and so would the rollback
        # below, which is how a failed import left a model standing (found in a live round trip).
        set_read_only(self._database, False)

        applied.append("graph")
        try:
            for section in _bundle.SECTIONS:
                if (
                    section.name in ("graph", "library")
                    or section.name not in sections
                    or section.name not in chosen
                ):
                    continue
                section.reader(self._database, sections[section.name])
                applied.append(section.name)
            # Sections this version cannot read are kept, not dropped — see engine/bundle_unknown.py. Inside
            # the rollback too: a file that cannot be written must not leave the model standing.
            self._unknown_files = bundle_unknown.store_unknown(
                self._database, self.opened.get("unknown") or {}, self.opened.get("unknown_entries") or {}
            )
        except Exception:
            # The graph is already written by now, so an exception here would leave a half-imported
            # model behind — which is exactly what this command promises not to do. Found by importing
            # a real export whose reports section was refused: the model stayed, minus its parameters.
            self.undo()
            self._database = ""
            raise

        lca.invalidate_lca_cache()
        return {
            "database": self._database,
            "applied": applied,
            "kept_unreadable": self._unknown_files,
            # Newer shapes of sections this version knows: not readable, so not imported (bundle.read_bundle).
            "not_imported_newer": list(self.opened.get("newer") or []),
            "activities": len(graph.get("activities") or []),
            "library": {"added": len(self._library_added), "kept": library_result["kept"]},
        }

    def undo(self) -> None:
        from prism_lca.engine import bundle as _bundle
        from prism_lca.engine.brightway_repository import BrightwayRepository

        if self._database:
            BrightwayRepository().delete_foreground_database(self._database)
        # The library datasets this import brought go with it; ones that were already here stay.
        _bundle.remove_library_datasets(self._library_added)
        self._library_added = []

    def summary(self) -> str:
        return f"Import model '{self._database or self.requested_name or 'bundle'}' from a bundle"

    def audit_database(self) -> str | None:
        """The name the import actually landed under — which only exists once `execute` has run
        (`free_model_name` resolves collisions), so this cannot be an `audit_attr` on a public field.
        The bus asks after execute for exactly this reason."""
        return self._database or None

    def audit_related(self) -> str | None:
        """What the model was called in the bundle it came from. Recorded even when it is the same
        name, because "imported from a bundle that called it this" is the provenance a reviewer asks
        for; the sender's project is not ours to name."""
        origin = ((self.opened.get("manifest") or {}).get("model") or {}).get("name")
        return str(origin) if origin else None

    def scope_models(self) -> list[str] | None:
        """A new model under a name it picks while running — never one a fenced request may write."""
        return [""]


class AddExchangeCommand(Command):
    action = "add_exchange"
    local_to_model = True
    audit_attr = "activity_database"

    def __init__(
        self,
        activity_database,
        activity_code,
        input_database,
        input_code,
        amount,
        exchange_type="technosphere",
        comment=None,
        tags=None,
        tag_store=None,
        group_store=None,
    ):
        self.activity_database = activity_database
        self.activity_code = activity_code
        self.input_database = input_database
        self.input_code = input_code
        self.amount = amount
        self.exchange_type = exchange_type
        self.comment = (comment or "").strip() or None
        #: {dimension: value} for the new input — a line drawn out of a tagged canvas box. Written in the
        #: same step, so one undo takes back input and tags together.
        self.tags = {str(d).strip(): str(v).strip() for d, v in (tags or {}).items()}
        self.tag_store = tag_store
        self.group_store = group_store
        self._uid = model.new_uid()
        self._act_name: str | None = None
        self._input_name: str | None = None
        self._unit: str | None = None

    def execute(self) -> dict:
        assert_writable(self.activity_database)
        act = model.get_activity(self.activity_database, self.activity_code)
        inp = model.get_activity(self.input_database, self.input_code)
        self._act_name, self._input_name, self._unit = (
            act.get("name"),
            inp.get("name"),
            inp.get("unit"),
        )
        if self.tags:
            # Checked before anything is written: a refused tag must not leave an untagged input behind.
            from prism_lca.engine import tag_scope

            if self.exchange_type not in ("technosphere", "substitution"):
                raise PrismError("Only inputs carry tags.", code="tag_target_not_input")
            if tag_scope.tag_kind(self.activity_database) != tag_scope.MODEL or (
                self.input_database == self.activity_database
            ):
                raise PrismError(
                    "Tags on a new input are for what a model draws from outside it (background, library, "
                    "another model).",
                    code="tag_target_same_model",
                )
            if any(not d or not v for d, v in self.tags.items()):
                raise PrismError("A tag needs a group and a value.", code="invalid_value")
            if self.group_store is not None:
                self.tags = {self.group_store.find_or_create(d)["name"]: v for d, v in self.tags.items()}
                for dimension, value in self.tags.items():
                    self.group_store.add_value(dimension, value)  # refuses a bad value before anything is saved
        ex = act.new_edge(input=inp, amount=self.amount, type=self.exchange_type)
        ex["prism_uid"] = self._uid
        if self.comment:
            ex["comment"] = self.comment
        ex.save()
        if self.tags:
            code = TagStore.exchange_code(self.activity_code, self._uid)
            try:
                for dimension, value in self.tags.items():
                    self._tags().set_tag(self.activity_database, code, dimension, value)
            except Exception:
                ex.delete()  # a failed step leaves nothing behind: it never reaches the undo stack
                self._tags().rewrite_lists({f"{self.activity_database}/{code}": []})
                raise
        return {"exchange": model.exchange_info(ex)}

    def _tags(self) -> TagStore:
        return self.tag_store if self.tag_store is not None else TagStore()

    def undo(self) -> None:
        act = model.get_activity(self.activity_database, self.activity_code)
        model.find_exchange(act, self._uid).delete()
        if self.tags:
            code = TagStore.exchange_code(self.activity_code, self._uid)
            for dimension in self.tags:
                self._tags().set_tag(self.activity_database, code, dimension, None)

    def summary(self) -> str:
        kind = {
            "technosphere": "input",
            "biosphere": "biosphere flow",
            "production": "production output",
        }.get(self.exchange_type, f"{self.exchange_type} exchange")
        flow = self._input_name or self.input_code
        act = self._act_name or self.activity_code
        unit = f" {self._unit}" if self._unit else ""
        return f"Add {kind} '{_clip(flow, 50)}' ({_fmt(self.amount)}{unit}) to '{_clip(act, 40)}'"

    def scope_suppliers(self) -> list[str]:
        return [self.input_database]


class SetProductPropertiesCommand(Command):
    action = "set_product_properties"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, code, properties):
        self.database = database
        self.code = code
        self.properties = properties
        self._old: dict | None = None
        self._name: str | None = None

    def execute(self) -> dict:
        self._name = _activity_label(self.database, self.code)
        self._old = model.product_properties_snapshot(self.database, self.code)
        return model.set_product_properties(self.database, self.code, self.properties)

    def undo(self) -> None:
        model.restore_product_properties(self.database, self.code, self._old or {})

    def summary(self) -> str:
        keys = (
            ", ".join(sorted(self.properties))
            if isinstance(self.properties, dict)
            else "properties"
        )
        return f"Edit flow properties of '{self._name or self.code}' ({_clip(keys, 60)})"


class SetExchangeAmountCommand(Command):
    action = "set_exchange_amount"
    local_to_model = True
    audit_attr = "activity_database"

    def __init__(self, activity_database, activity_code, uid, amount):
        self.activity_database = activity_database
        self.activity_code = activity_code
        self.uid = uid
        self.amount = amount
        self._before: dict | None = None
        self._label: str | None = None
        self._unit: str | None = None

    def execute(self) -> dict:
        assert_writable(self.activity_database)
        act = model.get_activity(self.activity_database, self.activity_code)
        ex = model.find_exchange(act, self.uid)
        try:  # names for the audit line — never at the operation's expense
            self._label = f"'{_clip(ex.input.get('name'), 50)}' in '{_clip(act.get('name'), 40)}'"
            self._unit = ex.input.get("unit")
        except Exception as exc:  # noqa: BLE001
            _log.swallowed(exc, "execute")
        self._before = {"formula": ex.get("formula"), "amount": ex.get("amount")}
        if ex.get("formula"):
            # A formula would win again on the next parameter recalculation and silently
            # revert this edit — a plain amount therefore detaches the formula (= fx off).
            params.clear_exchange_formula(act, ex)
        ex["amount"] = self.amount
        ex.save()
        return {"exchange": model.exchange_info(ex)}

    def undo(self) -> None:
        # Restores amount AND formula, re-registering the parameter group so a restored
        # formula responds to parameter changes again.
        params.restore_exchange_formula(
            self.activity_database, self.activity_code, self.uid, self._before or {}
        )

    def summary(self) -> str:
        where = self._label or f"exchange {self.uid[:8]}"
        unit = f" {self._unit}" if self._unit else ""
        was = ""
        if self._before:
            if self._before.get("formula"):
                was = f" (was formula {_clip(self._before['formula'], 30)})"
            elif self._before.get("amount") is not None and self._before["amount"] != self.amount:
                was = f" (was {_fmt(self._before['amount'])})"
        return f"Set amount of {where} to {_fmt(self.amount)}{unit}{was}"


class RemoveExchangeCommand(Command):
    action = "remove_exchange"
    local_to_model = True
    audit_attr = "activity_database"

    def __init__(self, activity_database, activity_code, uid):
        self.activity_database = activity_database
        self.activity_code = activity_code
        self.uid = uid
        self._data: dict | None = None
        self._label: str | None = None
        self._unit: str | None = None

    def execute(self) -> dict:
        assert_writable(self.activity_database)
        act = model.get_activity(self.activity_database, self.activity_code)
        ex = model.find_exchange(act, self.uid)
        try:  # names for the audit line — never at the operation's expense
            self._label = f"'{_clip(ex.input.get('name'), 50)}' from '{_clip(act.get('name'), 40)}'"
            self._unit = ex.input.get("unit")
        except Exception as exc:  # noqa: BLE001
            _log.swallowed(exc, "execute")
        self._data = {
            "input": ex.input.key,
            "type": ex.get("type"),
            "amount": ex.get("amount"),
            "fields": model.exchange_extra_fields(ex),  # formula/uncertainty/pedigree/comment
        }
        ex.delete()
        return {"removed": self.uid}

    def undo(self) -> None:
        act = model.get_activity(self.activity_database, self.activity_code)
        inp = model.get_activity(self._data["input"][0], self._data["input"][1])
        ex = act.new_edge(input=inp, amount=self._data["amount"], type=self._data["type"])
        for k, v in (self._data.get("fields") or {}).items():
            ex[k] = v
        ex["prism_uid"] = self.uid
        ex.save()
        # See DeleteActivityCommand.undo: the formula is back as text, the registration is not.
        if (self._data.get("fields") or {}).get("formula"):
            params.register_activity_group(act)

    def summary(self) -> str:
        where = self._label or f"exchange {self.uid[:8]}"
        amount = ""
        if self._data and self._data.get("amount") is not None:
            unit = f" {self._unit}" if self._unit else ""
            amount = f" ({_fmt(self._data['amount'])}{unit})"
        return f"Remove {where}{amount}"


class SetExchangeUncertaintyCommand(Command):
    action = "set_exchange_uncertainty"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, code, uid, distribution, params):
        self.database = database
        self.code = code
        self.uid = uid
        self.distribution = distribution
        self.params = params or {}
        self._before: dict | None = None
        self._label: str | None = None

    def execute(self) -> dict:
        self._label = _exchange_label(self.database, self.code, self.uid)
        self._before = model.exchange_uncertainty_snapshot(self.database, self.code, self.uid)
        return {
            "exchange": model.apply_exchange_uncertainty(
                self.database, self.code, self.uid, self.distribution, self.params
            )
        }

    def undo(self) -> None:
        if self._before is not None:
            model.restore_exchange_fields(self.database, self.code, self.uid, self._before)

    def summary(self) -> str:
        return f"Set {self.distribution} uncertainty on {self._label or f'exchange {self.uid[:8]}'}"


class SetExchangeCommentCommand(Command):
    action = "set_exchange_comment"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, code, uid, comment):
        self.database = database
        self.code = code
        self.uid = uid
        self.comment = comment
        self._before: str | None = None
        self._had_before = False
        self._label: str | None = None

    def execute(self) -> dict:
        self._label = _exchange_label(self.database, self.code, self.uid)
        self._before = model.exchange_comment(self.database, self.code, self.uid)
        self._had_before = True
        return {
            "exchange": model.set_exchange_comment(self.database, self.code, self.uid, self.comment)
        }

    def undo(self) -> None:
        if self._had_before:
            model.set_exchange_comment(self.database, self.code, self.uid, self._before)

    def summary(self) -> str:
        where = self._label or f"exchange {self.uid[:8]}"
        text = (self.comment or "").strip()
        if not text:
            return f"Clear comment on {where}"
        return f"Comment {where}: “{_clip(text, 50)}”"


class SetActivityFieldsCommand(Command):
    action = "set_activity_fields"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, code, fields):
        self.database = database
        self.code = code
        self.fields = fields
        self._before: dict | None = None
        self._name: str | None = None

    def execute(self) -> dict:
        self._name = _activity_label(self.database, self.code)
        self._before = model.activity_fields_snapshot(self.database, self.code)
        return model.set_activity_fields(self.database, self.code, self.fields)

    def undo(self) -> None:
        if self._before is not None:
            model.restore_activity_fields(self.database, self.code, self._before)

    def summary(self) -> str:
        keys = ", ".join(sorted(self.fields)) if isinstance(self.fields, dict) else "fields"
        # `_name` is the name BEFORE the edit; a rename says both, so the line still finds the
        # process the reader knows.
        renamed = ""
        if (
            isinstance(self.fields, dict)
            and self.fields.get("name")
            and self.fields["name"] != self._name
        ):
            renamed = f" (now '{_clip(self.fields['name'], 40)}')"
        return f"Edit activity '{self._name or self.code[:8]}': {_clip(keys, 60)}{renamed}"


class SetClassificationCommand(Command):
    action = "set_classification"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, code, isic, cpc, cpc_name=None):
        self.database = database
        self.code = code
        self.isic = isic
        self.cpc = cpc
        self.cpc_name = cpc_name
        self._before: dict | None = None
        self._name: str | None = None

    def execute(self) -> dict:
        self._name = _activity_label(self.database, self.code)
        self._before = model.classification_snapshot(self.database, self.code)
        return model.set_classification(
            self.database, self.code, self.isic, self.cpc, self.cpc_name
        )

    def undo(self) -> None:
        if self._before is not None:
            model.restore_classification(self.database, self.code, self._before)

    def summary(self) -> str:
        parts = [
            p
            for p in (
                f"ISIC {self.isic}" if self.isic else "",
                f"CPC {self.cpc}" if self.cpc else "",
            )
            if p
        ]
        what = ": " + ", ".join(parts) if parts else ""
        return f"Classify activity '{self._name or self.code[:8]}'{what}"


class SetExchangePedigreeCommand(Command):
    action = "set_exchange_pedigree"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, code, uid, scores, basic_gsd=1.0):
        self.database = database
        self.code = code
        self.uid = uid
        self.scores = scores
        self.basic_gsd = basic_gsd
        self._before: dict | None = None
        self._label: str | None = None

    def execute(self) -> dict:
        self._label = _exchange_label(self.database, self.code, self.uid)
        self._before = model.exchange_uncertainty_snapshot(self.database, self.code, self.uid)
        return {
            "exchange": model.apply_exchange_pedigree(
                self.database, self.code, self.uid, self.scores, self.basic_gsd
            )
        }

    def undo(self) -> None:
        if self._before is not None:
            model.restore_exchange_fields(self.database, self.code, self.uid, self._before)

    def summary(self) -> str:
        return f"Set pedigree {self.scores} on {self._label or f'exchange {self.uid[:8]}'}"


# --------------------------------------------------------------------------- #
# Tag commands
# --------------------------------------------------------------------------- #
def _named_selection(keys: list[tuple[str, str]]) -> str:
    """A short, readable rendering of a tag selection: names for up to three, a count beyond. A key of an
    input (code#uid, see TagStore.exchange_code) reads "input 'steel' in 'Manufacturing'"."""
    if len(keys) <= 3:
        parts = []
        for db, code in keys:
            base, uid = TagStore.split_code(code)
            parts.append(f"input {_exchange_label(db, base, uid)}" if uid
                         else f"'{_clip(_activity_label(db, code), 35)}'")
        return ", ".join(parts) or "0 activities"
    inputs = sum(1 for _db, code in keys if TagStore.split_code(code)[1])
    if inputs == len(keys):
        return f"{len(keys)} inputs"
    return f"{len(keys)} activities" if not inputs else f"{len(keys) - inputs} activities and {inputs} inputs"


def _one_database(keys: list[tuple[str, str]]) -> str | None:
    """The single model a batch of ``(database, code)`` keys belongs to, or None if it spans several.

    The tag commands take a selection, and a selection *can* in principle cross models (nothing in
    the API forbids it), so this may not assume. None then, deliberately: an entry filed under one of
    two models would be a smaller version of the same lie the whole field exists to end.
    """
    names = {k[0] for k in keys if k and k[0]}
    return next(iter(names)) if len(names) == 1 else None


class TagActivitiesCommand(Command):
    """Add one (dimension, value) tag to one or many activities (the canvas 'box' tool)."""

    action = "tag_activities"

    def __init__(
        self, tag_store: TagStore, keys: list[tuple[str, str]], dimension, value, group_store=None
    ):
        self.tag_store = tag_store
        self.group_store = group_store  # see SetTagCommand — a tag registers its dimension (V237)
        self.keys = keys
        self.dimension = dimension
        self.value = value
        self._added: list[tuple[str, str]] = []

    def execute(self) -> dict:
        if self.group_store is not None and self.value:
            # `find_or_create` may answer with the dimension under its canonical spelling (an alias
            # joins the existing group, V246); the value and the tag go under THAT name, or add_value
            # refuses the group it was just handed.
            self.dimension = self.group_store.find_or_create(self.dimension)["name"]
            self.group_store.add_value(self.dimension, self.value)
        self._added = [
            k for k in self.keys if self.tag_store.add(k[0], k[1], self.dimension, self.value)
        ]
        self._names = _named_selection(self.keys)
        return {"tagged": len(self._added), "dimension": self.dimension, "value": self.value}

    def undo(self) -> None:
        for db, code in self._added:
            self.tag_store.remove(db, code, self.dimension, self.value)

    def summary(self) -> str:
        who = getattr(self, "_names", None) or f"{len(self.keys)} process(es)"
        return f"Tag {who}: {self.dimension} = {self.value}"

    def audit_database(self) -> str | None:
        return _one_database(self.keys)

    def scope_models(self) -> list[str] | None:
        return sorted({k[0] for k in self.keys if k})

    def audit_databases(self) -> list[str] | None:
        # A selection across models names every one of them — without this the step named none and
        # counted as workspace-wide, so the model-scoped Undo offered it in an unrelated model C.
        names = sorted({k[0] for k in self.keys if k and k[0]})
        return names if len(names) > 1 else None


class SetTagCommand(Command):
    """Assign one value per group to one or many activities (empty value clears the group).
    Enforces the 'at most one value per group' rule via TagStore.set_tag."""

    action = "set_tag"

    def __init__(
        self,
        tag_store: TagStore,
        keys: list[tuple[str, str]],
        group: str,
        value: str | None,
        group_store=None,
    ):
        self.tag_store = tag_store
        #: Where the dimension is registered. Optional so the old two-store call still works, but the
        #: routes pass it: without it a tag can name a dimension no picker knows (V237).
        self.group_store = group_store
        self.keys = keys
        self.group = group
        self.value = value or None
        self._prev: list[tuple[str, str, str | None]] = []  # (db, code, old_value)

    def execute(self) -> dict:
        self._prev = []
        # Register the dimension and the value before writing the tag. NOT undone: a dimension is
        # config, the same way a parameter group created on the way to a parameter is, and taking it
        # away again would strip it from every other process that has since been tagged with it.
        if self.group_store is not None and self.value:
            self.group = self.group_store.find_or_create(self.group)["name"]  # see TagActivitiesCommand
            self.group_store.add_value(self.group, self.value)
        for db, code in self.keys:
            old = self.tag_store.set_tag(db, code, self.group, self.value)
            self._prev.append((db, code, old))
        self._names = _named_selection(self.keys)
        return {"set": len(self.keys), "group": self.group, "value": self.value}

    def undo(self) -> None:
        for db, code, old in self._prev:
            self.tag_store.set_tag(db, code, self.group, old)

    def summary(self) -> str:
        who = getattr(self, "_names", None) or f"{len(self.keys)} process(es)"
        if not self.value:
            return f"Clear tag {self.group} on {who}"
        return f"Tag {who}: {self.group} = {self.value}"

    def audit_database(self) -> str | None:
        return _one_database(self.keys)

    def scope_models(self) -> list[str] | None:
        return sorted({k[0] for k in self.keys if k})

    def audit_databases(self) -> list[str] | None:
        # A selection across models names every one of them — without this the step named none and
        # counted as workspace-wide, so the model-scoped Undo offered it in an unrelated model C.
        names = sorted({k[0] for k in self.keys if k and k[0]})
        return names if len(names) > 1 else None


class RemoveTagCommand(Command):
    action = "remove_tag"
    audit_attr = "database"

    def __init__(self, tag_store: TagStore, database, code, dimension, value):
        self.tag_store = tag_store
        self.database = database
        self.code = code
        self.dimension = dimension
        self.value = value
        self._removed = False

    def execute(self) -> dict:
        self._name = _activity_label(self.database, self.code)
        self._removed = self.tag_store.remove(self.database, self.code, self.dimension, self.value)
        return {"removed": self._removed}

    def undo(self) -> None:
        if self._removed:
            self.tag_store.add(self.database, self.code, self.dimension, self.value)

    def summary(self) -> str:
        who = getattr(self, "_name", None) or self.code
        return f"Remove tag {self.dimension} = {self.value} from '{who}'"


class DeleteTagGroupCommand(Command):
    """Delete a tag group including the cascade (untags every process carrying it). Undo restores
    the group with its colour, values, list position AND every tag assignment."""

    action = "delete_tag_group"

    def __init__(self, group_store: TagGroupStore, tag_store: TagStore, name: str):
        self.group_store = group_store
        self.tag_store = tag_store
        self.name = name
        self._group: dict | None = None
        self._index: int | None = None
        self._assignments: list[tuple[str, str, str]] = []  # (database, code, value)

    def execute(self) -> dict:
        groups = self.group_store.list_groups()
        self._index = next((i for i, g in enumerate(groups) if g["name"] == self.name), None)
        if self._index is None:
            raise PrismError(
                f"Tag group '{self.name}' does not exist.", code="group_not_found", status_code=404
            )
        self._group = groups[self._index]
        self._assignments = [
            (*_split_key(key), value) for key, value in self._carriers()
        ]
        self.group_store.delete_group(self.name)
        self.tag_store.remove_dimension(self.name)
        return {"deleted": True, "untagged": len(self._assignments)}

    def undo(self) -> None:
        if self._group is None:
            return
        self.group_store.restore_group(self._group, self._index)
        for db, code, value in self._assignments:
            self.tag_store.add(db, code, self.name, value)

    def summary(self) -> str:
        return f"Delete tag group '{self.name}' ({len(self._assignments)} tag(s) removed)"

    def _carriers(self) -> list[tuple[str, str]]:
        """``(key, value)`` of every assignment of this group — what the cascade strips."""
        return [
            (key, t["value"])
            for key, tags in self.tag_store.load_map().items()
            for t in tags
            if t["dimension"] == self.name
        ]

    def scope_models(self) -> list[str] | None:
        """The models whose assignments the cascade strips; the group itself is workspace vocabulary."""
        return _key_models(key for key, _value in self._carriers())

    def audit_databases(self) -> list[str] | None:
        """The group itself is project-wide, its cascade is not — it strips assignments from
        every model that carried one, and those models changed. Taken from the assignments the undo
        already has to keep, so the list is the removals that really happened and not a guess."""
        return sorted({db for db, _code, _value in self._assignments}) or None


class RemoveTagValueCommand(Command):
    """Remove one value from a tag group including the cascade (untags every process carrying
    it). Undo restores the value at its original position AND every tag assignment."""

    action = "remove_tag_value"

    def __init__(self, group_store: TagGroupStore, tag_store: TagStore, group: str, value: str):
        self.group_store = group_store
        self.tag_store = tag_store
        self.group = group
        self.value = value
        self._index: int | None = None
        self._assignments: list[tuple[str, str]] = []  # (database, code)

    def execute(self) -> dict:
        g = next((x for x in self.group_store.list_groups() if x["name"] == self.group), None)
        if g is None or self.value not in g["values"]:
            raise PrismError(
                f"Tag value '{self.value}' does not exist in group '{self.group}'.",
                code="value_not_found",
                status_code=404,
            )
        self._index = g["values"].index(self.value)
        self._assignments = [_split_key(key) for key in self._carriers()]
        self.group_store.remove_value(self.group, self.value)
        self.tag_store.remove_dimension_value(self.group, self.value)
        return {"removed": True, "untagged": len(self._assignments)}

    def undo(self) -> None:
        if self._index is None:
            return
        self.group_store.restore_value(self.group, self.value, self._index)
        for db, code in self._assignments:
            self.tag_store.add(db, code, self.group, self.value)

    def summary(self) -> str:
        return f"Remove tag '{self.value}' from group '{self.group}' ({len(self._assignments)} tag(s) removed)"

    def _carriers(self) -> list[str]:
        """The keys carrying this value — what the cascade untags."""
        return [
            key
            for key, tags in self.tag_store.load_map().items()
            for t in tags
            if t["dimension"] == self.group and t["value"] == self.value
        ]

    def scope_models(self) -> list[str] | None:
        """As for the whole group above."""
        return _key_models(self._carriers())

    def audit_databases(self) -> list[str] | None:
        """As for the whole group above."""
        return sorted({db for db, _code in self._assignments}) or None



class MergeTagValueCommand(Command):
    """Fold one value of a group into another: every process tagged ``source`` is retagged ``target``,
    then ``source`` leaves the allowed values. Undo puts the value back at its position and every
    affected process's tag list back exactly as it was — a snapshot per activity, not a replay,
    because an activity may carry several values of one dimension. The cleanup a
    vocabulary needs after several runs spelled the same phase four ways ("Use", "Use Phase",
    "Usage Phase"); deleting would untag them."""

    action = "merge_tag_value"

    def __init__(self, group_store: TagGroupStore, tag_store: TagStore, group: str, source: str, target: str):
        self.group_store = group_store
        self.tag_store = tag_store
        self.group = group
        self.source = source
        self.target = target
        self._index: int | None = None
        self._before: dict[str, list[dict]] = {}

    def execute(self) -> dict:
        # Rebuilt on every execution: redo runs the same instance, and stale bookkeeping from the
        # first run would undo things this run never did.
        self._index = None
        self._before = {}
        g = next((x for x in self.group_store.list_groups() if x["name"] == self.group), None)
        if g is None:
            raise PrismError(f"Tag group '{self.group}' does not exist.", code="group_not_found", status_code=404)
        for v in (self.source, self.target):
            if v not in g["values"]:
                raise PrismError(
                    f"Tag value '{v}' does not exist in group '{self.group}'.",
                    code="value_not_found", status_code=404,
                    hint=f"Values: {', '.join(g['values'])}.",
                )
        if self.source == self.target:
            raise PrismError("Source and target are the same value.", code="same_value", status_code=400)
        self._index = g["values"].index(self.source)
        keys = self._carriers()
        self._before = self.tag_store.lists_for(keys)
        after: dict[str, list[dict]] = {}
        for key, tags in self._before.items():
            out: list[dict] = []
            for t in tags:
                nt = {**t, "value": self.target} if t["dimension"] == self.group and t["value"] == self.source else t
                if nt not in out:  # source and target both present → one target entry
                    out.append(nt)
            after[key] = out
        self.tag_store.rewrite_lists(after)
        self.group_store.remove_value(self.group, self.source)
        return {"merged": True, "group": self.group, "from": self.source, "into": self.target, "retagged": len(keys)}

    def undo(self) -> None:
        if self._index is None:
            return
        self.group_store.restore_value(self.group, self.source, self._index)
        self.tag_store.rewrite_lists(self._before)

    def summary(self) -> str:
        return (
            f"Merge tag '{self.source}' into '{self.target}' in group '{self.group}' "
            f"({len(self._before)} process(es) retagged)"
        )

    def audit_databases(self) -> list[str] | None:
        return _key_models(self._before) or None

    def _carriers(self) -> list[str]:
        """The keys carrying the value that is merged away — what the merge retags."""
        return [
            key for key, tags in self.tag_store.load_map().items()
            if any(t["dimension"] == self.group and t["value"] == self.source for t in tags)
        ]

    def scope_models(self) -> list[str] | None:
        """The models whose assignments the merge rewrites; the value list is workspace vocabulary."""
        return _key_models(self._carriers())


class MergeTagGroupCommand(Command):
    """Fold one group (dimension) into another: its values join the target's vocabulary, every process
    tagged in the source carries the same value in the target, then the source group is deleted.
    Undo restores the group, every affected activity's complete tag list (snapshot, see
    MergeTagValueCommand) and removes the values this execution added to the target. Four parallel
    phase vocabularies ("Phase", "Life-cycle phase", "Life cycle phase", "Lebenswegphase") are what
    this is for."""

    action = "merge_tag_group"

    def __init__(self, group_store: TagGroupStore, tag_store: TagStore, source: str, target: str):
        self.group_store = group_store
        self.tag_store = tag_store
        self.source = source
        self.target = target
        self._group: dict | None = None
        self._index: int | None = None
        self._before: dict[str, list[dict]] = {}
        self._added_values: list[str] = []

    def execute(self) -> dict:
        self._group = None
        self._index = None
        self._before = {}
        self._added_values = []
        groups = self.group_store.list_groups()
        self._index = next((i for i, g in enumerate(groups) if g["name"] == self.source), None)
        target = next((g for g in groups if g["name"] == self.target), None)
        if self._index is None:
            raise PrismError(f"Tag group '{self.source}' does not exist.", code="group_not_found", status_code=404)
        if target is None:
            raise PrismError(f"Tag group '{self.target}' does not exist.", code="group_not_found", status_code=404)
        if self.source == self.target:
            raise PrismError("Source and target are the same group.", code="same_group", status_code=400)
        self._group = groups[self._index]
        keys = self._carriers()
        self._before = self.tag_store.lists_for(keys)
        needed = list(self._group["values"]) + [
            t["value"] for tags in self._before.values() for t in tags if t["dimension"] == self.source
        ]
        present = set(target["values"])
        for v in needed:
            if v not in present:
                self.group_store.add_value(self.target, v)
                present.add(v)
                self._added_values.append(v)
        after: dict[str, list[dict]] = {}
        for key, tags in self._before.items():
            out: list[dict] = []
            for t in tags:
                nt = {**t, "dimension": self.target} if t["dimension"] == self.source else t
                if nt not in out:
                    out.append(nt)
            after[key] = out
        self.tag_store.rewrite_lists(after)
        self.group_store.delete_group(self.source)
        return {
            "merged": True, "from": self.source, "into": self.target,
            "retagged": len(keys), "values_added": list(self._added_values),
        }

    def undo(self) -> None:
        if self._group is None:
            return
        self.group_store.restore_group(self._group, self._index)
        self.tag_store.rewrite_lists(self._before)
        for v in self._added_values:
            self.group_store.remove_value(self.target, v)

    def summary(self) -> str:
        return f"Merge tag group '{self.source}' into '{self.target}' ({len(self._before)} process(es) retagged)"

    def audit_databases(self) -> list[str] | None:
        return _key_models(self._before) or None

    def _carriers(self) -> list[str]:
        """The keys carrying any value of the group that is merged away — what the merge retags."""
        return [key for key, tags in self.tag_store.load_map().items() if any(t["dimension"] == self.source for t in tags)]

    def scope_models(self) -> list[str] | None:
        """The models whose assignments the merge rewrites; the groups are workspace vocabulary."""
        return _key_models(self._carriers())


def _with_stale_notes(out: dict, database: str, before: list[tuple[str, dict | None]]) -> dict:
    """Attach the notes that still quote a parameter's PREVIOUS value, when the write changed it.

    Only for parameters that existed and whose amount moved: a new parameter has no old figure, and a
    metadata-only edit changes no number. See params.notes_quoting_value (V339)."""
    now = {p.get("name"): p for p in out.get("parameters") or [] if isinstance(p, dict)}
    notes: list[dict] = []
    for name, snap in before:
        if not snap or snap.get("amount") is None:
            continue
        new_amount = (now.get(name) or {}).get("amount")
        try:
            was = float(snap["amount"])
            if new_amount is None or abs(float(new_amount) - was) <= abs(was) * 1e-12:
                continue
        except (TypeError, ValueError):
            continue
        for note in params.notes_quoting_value(database, name, snap["amount"]):
            notes.append({"parameter": name, "was": snap["amount"], "now": new_amount, **note})
    if notes:
        out["stale_notes"] = notes
        out["hint"] = (
            f"{len(notes)} note{'s' if len(notes) != 1 else ''} downstream of the changed parameter still "
            "quote the previous value — the report prints notes as written. Update them "
            '(edit_exchange action="set_comment", edit_process comment) or leave the figure out and let '
            "the parameter table say it."
        )
    return out


# --------------------------------------------------------------------------- #
# Parameter commands
# --------------------------------------------------------------------------- #
class SetParameterCommand(Command):
    action = "set_parameter"
    local_to_model = True
    audit_attr = "database"

    def __init__(
        self,
        database,
        name,
        amount=None,
        formula=None,
        group_id=None,
        description=None,
        unit=None,
        group=None,
        rule=None,
    ):
        self.database = database
        self.name = name
        self.amount = amount
        self.formula = formula
        self.group_id = group_id
        self.group = group  # legacy: a group NAME (resolved to a group_id by params.set_param)
        self.description = description
        self.unit = unit
        #: What the value is allowed to be. `{}` removes the rule, None leaves it alone.
        self.rule = rule
        self._before: dict | None = None

    def execute(self) -> dict:
        self._before = params.snapshot(self.database, self.name)
        # Enter and blur both commit the same value, and the second commit used to be booked as an
        # undoable "Set parameter 'm_hose' = 4.5 kg" with no "was" (V413). A set that leaves
        # every field it names where it is changes nothing: nothing is written, the bus records nothing.
        if self._before is not None and params.set_is_noop(
            self._before, self.amount, self.formula, self.group_id, self.description, self.unit,
            group=self.group, rule=self.rule,
        ):
            return {"parameters": params.list_params(self.database), "unchanged": True}
        out = {
            "parameters": params.set_param(
                self.database,
                self.name,
                self.amount,
                self.formula,
                self.group_id,
                self.description,
                self.unit,
                group=self.group,
                rule=self.rule,
            )
        }
        return _with_stale_notes(out, self.database, [(self.name, self._before)])

    def undo(self) -> None:
        if self._before is None:
            try:
                params.delete_param(self.database, self.name)
            except PrismError:
                pass
        else:
            params.restore(self._before)

    def summary(self) -> str:
        val = self.formula if self.formula else self.amount
        unit = f" {self.unit}" if self.unit and val is not None and not self.formula else ""
        if val is None:
            # No value in the call: this edit changed the metadata — say which.
            what = (
                ", ".join(
                    p
                    for p in (
                        "rule" if self.rule is not None else "",
                        "comment" if self.description is not None else "",
                        "group" if (self.group_id or self.group) else "",
                        "unit" if self.unit is not None else "",
                    )
                    if p
                )
                or "fields"
            )
            return f"Edit parameter '{self.name}' ({what})"
        was = ""
        if self._before is None:
            was = " (new)"
        else:
            old = self._before.get("formula") or self._before.get("amount")
            if old is not None and old != val:
                was = f" (was {_fmt(old)})"
        return f"Set parameter '{self.name}' = {_fmt(val)}{unit}{was}"


class SetParametersCommand(Command):
    """Many parameters, one transaction, one recalculation — see params.set_params_bulk (V228).

    Undo restores every parameter this call touched, in reverse order, so a batch behaves like the
    single write it replaced: one entry in the log, one step back.
    """

    action = "set_parameters"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, items):
        self.database = database
        self.items = list(items or [])
        self._before: list[tuple[str, dict | None]] = []

    def execute(self) -> dict:
        self._before = [
            (item.get("name"), params.snapshot(self.database, item.get("name")))
            for item in self.items
        ]
        out = {"parameters": params.set_params_bulk(self.database, self.items)}
        return _with_stale_notes(out, self.database, self._before)

    def undo(self) -> None:
        # The rows that did not exist go first, then every old state in ONE write (`restore_many`):
        # row by row, two states that are both valid can pass through one that is not (a = "b"
        # restored before b = "a" is put back is a cycle), which raised, ended the undo half-way,
        # and the command was already off the stack.
        for name, snap in reversed(self._before):
            if snap is None:
                try:
                    params.delete_param(self.database, name, recalc=False)
                except PrismError:
                    pass
        params.restore_many([snap for _name, snap in self._before if snap is not None])
        if all(snap is None for _name, snap in self._before):
            params.recalc_database(self.database)

    def summary(self) -> str:
        n = len(self.items)
        if n == 1:
            item = self.items[0]
            val = item.get("formula") if item.get("formula") else item.get("amount")
            return f"Set parameter '{item.get('name')}'" + (f" = {val}" if val is not None else "")
        names = ", ".join(f"'{i.get('name')}'" for i in self.items[:4])
        more = f" and {n - 4} more" if n > 4 else ""
        return f"Set {n} parameters: {names}{more}"


class DeleteParameterCommand(Command):
    action = "delete_parameter"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, name):
        self.database = database
        self.name = name
        self._before: dict | None = None

    def execute(self) -> dict:
        self._before = params.snapshot(self.database, self.name)
        if self._before is None:
            raise PrismError(
                f"Parameter '{self.name}' not found.",
                code="param_not_found",
                status_code=404,
                hint="List parameters via GET /api/v1/params.",
            )
        params.delete_param(self.database, self.name)
        return {"deleted": self.name}

    def undo(self) -> None:
        if self._before:
            params.restore(self._before)

    def summary(self) -> str:
        was = ""
        if self._before is not None:
            old = self._before.get("formula") or self._before.get("amount")
            if old is not None:
                was = f" (was {_fmt(old)})"
        return f"Delete parameter '{self.name}'{was}"


class SetReferenceQuantityCommand(Command):
    """Make ``1 <unit>`` the model's functional unit — see model.set_reference_quantity (V233).

    Undo has two shapes because the operation has two: the first call created a process, so undo
    deletes it; a later call re-pointed the existing one, so undo cannot delete anything and says so
    by doing nothing. Deleting a node a previous step created is the one thing it must not do.
    """

    action = "set_reference_quantity"
    audit_attr = "database"

    def __init__(self, database, code, parameter, name, unit, product=None):
        self.database = database
        self.code = code
        self.parameter = parameter
        self.name = name
        self.unit = unit
        self.product = product
        self._created: str | None = None
        #: The reference quantity this one replaced — target, divisor and labels — so that undo can
        #: put it back. Without it undo "succeeded" and left the new functional unit standing.
        self._before: dict | None = None

    def execute(self) -> dict:
        existing = model.find_reference_quantity(self.database)
        if existing:
            act = model.get_activity(self.database, existing["code"])
            self._before = {
                "of": existing.get("of"), "parameter": existing.get("parameter"),
                "name": existing.get("name"), "unit": act.get("unit"),
                "product": act.get("reference product"),
            }
        out = model.set_reference_quantity(
            self.database, self.code, self.parameter, self.name, self.unit, self.product
        )
        if not out.get("replaced"):
            self._created = out["activity"]["code"]
        return out

    def undo(self) -> None:
        if self._created:
            try:
                model.delete_activity(self.database, self._created)
            except PrismError:
                pass
            return
        b = self._before
        if b and b.get("of") and b.get("parameter"):
            # Idempotent by design: it re-points the existing divider instead of stacking a second.
            model.set_reference_quantity(
                self.database, b["of"], b["parameter"], b["name"], b["unit"], b["product"]
            )

    def summary(self) -> str:
        return f"Set reference quantity: 1 {self.unit} = 1 / {self.parameter}"


class SetExchangeFormulaCommand(Command):
    action = "set_exchange_formula"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, code, uid, formula):
        self.database = database
        self.code = code
        self.uid = uid
        self.formula = formula
        self._before: dict | None = None
        self._label: str | None = None

    def execute(self) -> dict:
        self._label = _exchange_label(self.database, self.code, self.uid)
        self._before = params.exchange_snapshot(self.database, self.code, self.uid)
        ex = params.set_exchange_formula(self.database, self.code, self.uid, self.formula)
        out: dict = {"exchange": ex, "amount_before": (self._before or {}).get("amount")}
        # A formula replaces a fixed amount silently, and the answer used to show only the new
        # state. In one run a "1" became a "0" that way — the whole inverter left the
        # product system — and the only thing that noticed, hours later, was the model's memory of
        # an earlier score (V231). Saying what the amount WAS costs one line and puts the jump in
        # front of whoever made it, while they can still undo it.
        before, after = (self._before or {}).get("amount"), (ex or {}).get("amount")
        if isinstance(before, (int, float)) and isinstance(after, (int, float)) and before != after:
            jumped = (
                after == 0
                or before == 0
                or abs(after) > abs(before) * 10
                or abs(after) * 10 < abs(before)
            )
            if jumped:
                out["amount_changed"] = (
                    f"The amount changed from {before:g} to {after:g}. If that was not intended, "
                    "check the formula — a missing base quantity such as \u201c1 + n\u201d is the "
                    "usual cause; the previous amount is restored by undo."
                )
        return out

    def undo(self) -> None:
        if self._before is not None:
            params.restore_exchange_formula(self.database, self.code, self.uid, self._before)

    def summary(self) -> str:
        where = self._label or f"exchange {self.uid[:8]}"
        if not self.formula:
            return f"Detach formula from {where}"
        return f"Set formula on {where}: {_clip(self.formula, 50)}"


# --------------------------------------------------------------------------- #
# Parameter-group commands (organisational buckets; do not affect calculation)
# --------------------------------------------------------------------------- #
class CreateParamGroupCommand(Command):
    action = "create_param_group"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, database, name):
        self.database = database
        self.name = name
        self._id: str | None = None

    def execute(self) -> dict:
        from prism_lca.engine import parameter_groups

        # The same id on a redo: a later step (assigning a parameter) names the group by it.
        g = parameter_groups.create(self.database, self.name, group_id=self._id)
        self._id = g["id"]
        return {"group": g, "groups": parameter_groups.list_groups(self.database)}

    def undo(self) -> None:
        from prism_lca.engine import parameter_groups

        if self._id:
            parameter_groups.delete(self._id)

    def summary(self) -> str:
        return f"Add parameter group '{self.name}'"


class RenameParamGroupCommand(Command):
    action = "rename_param_group"
    audit_attr = "database"

    def __init__(self, database, group_id, name):
        self.database = database
        self.group_id = group_id
        self.name = name
        self._before: str | None = None

    def execute(self) -> dict:
        from prism_lca.engine import parameter_groups

        prev = parameter_groups.snapshot(self.group_id)
        self._before = prev["name"] if prev else None
        parameter_groups.rename(self.group_id, self.name)
        return {"groups": parameter_groups.list_groups(self.database)}

    def undo(self) -> None:
        from prism_lca.engine import parameter_groups

        if self._before is not None:
            parameter_groups.rename(self.group_id, self._before)

    def summary(self) -> str:
        if self._before and self._before != self.name:
            return f"Rename parameter group '{self._before}' → '{self.name}'"
        return f"Rename parameter group to '{self.name}'"


class DeleteParamGroupCommand(Command):
    action = "delete_param_group"
    audit_attr = "database"

    def __init__(self, database, group_id):
        self.database = database
        self.group_id = group_id
        self._group: dict | None = None
        self._members: list[str] = []

    def execute(self) -> dict:
        from prism_lca.engine import parameter_groups

        self._members = params.clear_group(
            self.database, self.group_id
        )  # un-assign params (they survive)
        self._group = parameter_groups.delete(self.group_id)
        if self._group is None:
            raise PrismError("Parameter group not found.", code="group_not_found", status_code=404)
        return {"deleted": self.group_id, "groups": parameter_groups.list_groups(self.database)}

    def undo(self) -> None:
        from prism_lca.engine import parameter_groups

        if self._group:
            parameter_groups.restore(self._group)
            for name in self._members:
                params.set_group(self.database, name, self.group_id)

    def summary(self) -> str:
        return f"Delete parameter group{' ' + self._group['name'] if self._group else ''} (parameters kept)"


class AssignParamGroupCommand(Command):
    action = "assign_param_group"
    audit_attr = "database"

    def __init__(self, database, name, group_id):
        self.database = database
        self.name = name
        self.group_id = group_id  # None/"" un-assigns
        self._before: str | None = None
        self._group_name: str | None = None

    def execute(self) -> dict:
        if self.group_id:
            try:
                from prism_lca.engine import parameter_groups

                snap = parameter_groups.snapshot(self.group_id)
                self._group_name = (snap or {}).get("name")
            except Exception as exc:  # noqa: BLE001 - the audit label must never cost the move
                _log.swallowed(exc, "execute")
        self._before = params.group_of(self.database, self.name)
        params.set_group(self.database, self.name, self.group_id or None)
        return {"parameters": params.list_params(self.database)}

    def undo(self) -> None:
        params.set_group(self.database, self.name, self._before)

    def summary(self) -> str:
        if not self.group_id:
            return f"Remove parameter '{self.name}' from its group"
        target = f"'{self._group_name}'" if self._group_name else "another group"
        return f"Move parameter '{self.name}' to group {target}"


# --------------------------------------------------------------------------- #
# Scenario commands
# --------------------------------------------------------------------------- #
_MISSING = object()


def _scenario_of(store, scenario_id: str, database: str) -> dict:
    """The scenario, refused when it belongs to another model than the one the request names.

    The commands below are attributed to the request's ``database``, and the model-scoped Undo trusts
    that attribution: a scenario id of B sent with ``database: A`` changed B while its undo step said A,
    so Undo on A took back a change in B."""
    entry = store.get(scenario_id)
    owner = entry.get("database")
    if owner and owner != database:
        raise PrismError(
            f"The scenario belongs to ‘{owner}’, not to ‘{database}’.",
            code="scenario_other_model",
            status_code=409,
            hint=f"Open ‘{owner}’ to change its scenarios.",
        )
    return entry


class CreateScenarioCommand(Command):
    action = "create_scenario"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, store, database, name, description="", overrides=None):
        self.store = store
        self.database = database
        self.name = name
        self.description = description
        self.overrides = overrides or {}
        self._id: str | None = None

    def execute(self) -> dict:
        # The same id on a redo: a later step (rename, a value, a report variant) names it by that id —
        # a fresh one made "create, rename, undo both, redo both" stop at the rename.
        entry = self.store.create(
            self.database, self.name, self.description, self.overrides, scenario_id=self._id
        )
        self._id = entry["id"]
        return {"scenario": entry, "scenarios": self.store.list_all(self.database)}

    def undo(self) -> None:
        if self._id:
            self.store.delete(self._id)

    def summary(self) -> str:
        return f"Create scenario '{self.name}'"


class UpdateScenarioCommand(Command):
    action = "update_scenario"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, store, database, scenario_id, name, description="", overrides=None):
        self.store = store
        self.database = database
        self.scenario_id = scenario_id
        self.name = name
        self.description = description
        self.overrides = overrides or {}
        self._before: dict | None = None

    def execute(self) -> dict:
        self._before = dict(_scenario_of(self.store, self.scenario_id, self.database))
        entry = self.store.update(self.scenario_id, self.name, self.description, self.overrides)
        return {"scenario": entry, "scenarios": self.store.list_all(self.database)}

    def undo(self) -> None:
        if self._before is not None:
            self.store.put(self.scenario_id, self._before)

    def summary(self) -> str:
        old = (self._before or {}).get("name")
        n = len(self.overrides)
        detail = f" ({n} override{'' if n == 1 else 's'})"
        if old and old != self.name:
            return f"Rename scenario '{old}' → '{self.name}'{detail}"
        return f"Update scenario '{self.name}'{detail}"


class DuplicateScenarioCommand(Command):
    action = "duplicate_scenario"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, store, database, scenario_id):
        self.store = store
        self.database = database
        self.scenario_id = scenario_id
        self._new_id: str | None = None

    def execute(self) -> dict:
        _scenario_of(self.store, self.scenario_id, self.database)
        # The same id on a redo, like CreateScenarioCommand: later steps name the copy by it.
        entry = self.store.duplicate(self.scenario_id, new_id=self._new_id)
        self._new_id = entry["id"]
        self._new_name = entry.get("name")
        return {"scenario": entry, "scenarios": self.store.list_all(self.database)}

    def undo(self) -> None:
        if self._new_id:
            self.store.delete(self._new_id)

    def summary(self) -> str:
        name = getattr(self, "_new_name", None)
        return f"Duplicate scenario (as '{name}')" if name else "Duplicate scenario"


class DeleteScenarioCommand(Command):
    action = "delete_scenario"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, store, database, scenario_id):
        self.store = store
        self.database = database
        self.scenario_id = scenario_id
        self._before: dict | None = None

    def execute(self) -> dict:
        self._before = dict(_scenario_of(self.store, self.scenario_id, self.database))
        self.store.delete(self.scenario_id)
        return {"deleted": self.scenario_id, "scenarios": self.store.list_all(self.database)}

    def undo(self) -> None:
        if self._before is not None:
            self.store.put(self.scenario_id, self._before)

    def summary(self) -> str:
        return f"Delete scenario '{self._before['name'] if self._before else self.scenario_id}'"


class SetScenarioValueCommand(Command):
    action = "set_scenario_value"
    local_to_model = True

    def __init__(self, store, scenario_id, param, value):
        self.store = store
        self.scenario_id = scenario_id
        self.param = param
        self.value = value
        self._old = _MISSING

    def execute(self) -> dict:
        entry = self.store.get(self.scenario_id)
        self._scenario_name = entry.get("name")
        overrides = entry["overrides"]
        self._old = overrides.get(self.param, _MISSING)
        self.store.set_value(self.scenario_id, self.param, self.value)
        return {
            "scenario": self.scenario_id,
            "overrides": self.store.get(self.scenario_id)["overrides"],
        }

    def undo(self) -> None:
        if self._old is _MISSING:
            self.store.remove_value(self.scenario_id, self.param)
        else:
            self.store.set_value(self.scenario_id, self.param, self._old)

    def summary(self) -> str:
        where = (
            f"scenario '{self._scenario_name}'"
            if getattr(self, "_scenario_name", None)
            else "scenario"
        )
        was = f" (was {_fmt(self._old)})" if self._old is not _MISSING else " (new override)"
        return f"Set {self.param} = {_fmt(self.value)} in {where}{was}"

    def audit_database(self) -> str | None:
        """Via the store: a scenario knows its model, this command only knows the scenario. Silent on
        failure — a scenario deleted between execute and undo must not make the audit line unwritable,
        and an entry without the field is honest about not knowing."""
        try:
            return str(self.store.get(self.scenario_id).get("database") or "") or None
        except Exception as exc:  # noqa: BLE001 - the log must not be the thing that fails
            _log.swallowed(exc, "audit_database")
            return None

    def scope_models(self) -> list[str] | None:
        """The scenario's model, from the store as above; unknown = no model named, which the fence
        refuses."""
        return [self.audit_database() or ""]


class ImportScenariosCommand(Command):
    """Bulk create/overwrite scenarios from a parsed workbook, as ONE undoable step.

    ``columns`` is ``[{"name", "overrides"}]`` where overrides holds only the *filled* cells.
    An existing scenario (matched by name within the model) is merged — filled cells win, blank
    cells keep the existing override; a new name is created. Undo removes what was created and
    restores what was overwritten."""

    action = "import_scenarios"
    local_to_model = True
    audit_attr = "database"

    def __init__(self, store, database, columns):
        self.store = store
        self.database = database
        self.columns = columns
        self._created_ids: list[str] = []
        self._updated_before: list[dict] = []
        #: Name (casefolded) → id of what the first run created, so a redo recreates the same ids.
        self._ids: dict[str, str] = {}

    def execute(self) -> dict:
        # One write, checked as a whole before it (ScenarioStore.import_columns): a refused column must
        # leave the store exactly as it was before the import, not with the columns before it stored.
        res = self.store.import_columns(self.database, self.columns, ids=self._ids or None)
        self._created_ids = list(res["created_ids"])
        self._updated_before = list(res["updated_before"])
        created = set(self._created_ids)
        self._ids = {
            e["name"].casefold(): e["id"] for e in res["scenarios"] if e.get("id") in created
        }
        return {
            "created": res["created"],
            "overwritten": res["overwritten"],
            # From the transaction, not a second read: nothing fallible may follow the commit.
            "scenarios": res["scenarios"],
        }

    def undo(self) -> None:
        self.store.undo_import(self._created_ids, self._updated_before)

    def summary(self) -> str:
        names = [
            str(c.get("name") or "").strip() for c in self.columns if (c.get("name") or "").strip()
        ]
        listed = ", ".join(f"'{_clip(n, 30)}'" for n in names[:3])
        more = f" and {len(names) - 3} more" if len(names) > 3 else ""
        n = len(self.columns)
        return f"Import {n} scenario{'' if n == 1 else 's'}" + (
            f": {listed}{more}" if listed else ""
        )


class SetStudyMetaCommand(Command):
    action = "set_study_meta"
    # On the positive list again since the file name carries a hash of the exact model name (study.py):
    # "Model A" and "Model_A" shared one file before, and undoing out of order would have overwritten
    # the other model's newer metadata. `compared_with` is not writable through `update`; `link`/`unlink`
    # go through LinkModelsCommand, which stays a barrier.
    local_to_model = True
    audit_attr = "database"

    def __init__(self, store, database, fields):
        self.store = store
        self.database = database
        self.fields = fields
        self._before: dict | None = None
        self._changed: list[str] | None = None

    def execute(self) -> dict:
        self._before = self.store.snapshot(self.database)
        study = self.store.update(self.database, self.fields)
        # The sheet sends every field it shows, so the audit line named all fifteen after a change to
        # one of them (V342). Compared after the store has cleaned the values, so a field that came
        # back unchanged after trimming does not count as edited either.
        after = self.store.get(self.database)
        self._changed = [k for k in self.fields if (self._before or {}).get(k) != after.get(k)]
        return {"study": study}

    def undo(self) -> None:
        if self._before is not None:
            self.store.replace(self.database, self._before)

    def summary(self) -> str:
        fields = self.fields if self._changed is None else self._changed
        if not fields:
            return f"Edit study metadata for {self.database} (no change)"
        return f"Edit study metadata for {self.database} ({', '.join(fields)})"


class LinkModelsCommand(Command):
    """Make two models comparison models of each other — or stop them being so. Symmetric by
    construction (the store writes both files), undoable, and audited under the model the user was
    working in."""

    action = "link_models"
    audit_attr = "database"

    def __init__(self, store, database: str, other: str, link: bool = True):
        self.store = store
        self.database = database
        self.other = other
        self.link = link
        self._was_linked: bool | None = None

    def execute(self) -> dict:
        self._was_linked = self.other in self.store.compared_with(self.database)
        if self.link:
            self.store.link(self.database, self.other)
        else:
            self.store.unlink(self.database, self.other)
        return {"database": self.database, "compared_with": self.store.compared_with(self.database)}

    def undo(self) -> None:
        if self._was_linked is None:
            return
        if self._was_linked:
            self.store.link(self.database, self.other)
        else:
            self.store.unlink(self.database, self.other)

    def summary(self) -> str:
        verb = "Compare" if self.link else "No longer compare"
        return f"{verb} model '{self.database}' with '{self.other}'"

    def scope_models(self) -> list[str] | None:
        """Both sides: the relation is symmetric and written into both models' study records."""
        return [self.database, self.other]


# --------------------------------------------------------------------------- #
# Bus
# --------------------------------------------------------------------------- #
class CommandBus:
    def __init__(self) -> None:
        self._undo: list[Command] = []
        self._redo: list[Command] = []
        # Handlers may run in the threadpool; guard the stacks against interleaving.
        self._lock = threading.Lock()

    def _record(
        self,
        source: str,
        action: str,
        summary: str,
        undoable: bool = True,
        database: str | None = None,
        related: str | None = None,
        databases: list[str] | None = None,
        previous_name: str | None = None,
        turn: str | None = None,
    ) -> None:
        """Write one audit entry — to disk, not to a list.

        It used to be a list in memory, which made ADR-004's "append-only audit trail" a session log:
        a restart wiped it, and the support bundle showed nothing from before it. The store resolves
        its path from the active project on every call, so the log follows a project switch on its
        own — this bus is a singleton and outlives one.

        ``exclude_none`` so the attribution fields are absent rather than ``null`` when there is
        nothing to say: an unattributed line written today is then the same shape as one written
        before the fields existed, and no reader has to know the difference.
        """
        entry = AuditEntry(
            index=audit_store.next_index(),
            timestamp=now_iso(),
            source=source,
            action=action,
            summary=summary,
            undoable=undoable,
            database=database,
            related=related,
            databases=databases,
            previous_name=previous_name,
            turn=turn,
            client=CURRENT_CLIENT.get(),
        )
        audit_store.append(entry.model_dump(exclude_none=True))

    def _attribution(self, command: Command) -> dict:
        """What the command says about itself, asked once. Never fatal: a broken derivation must cost
        the attribution of one line, not the line — and certainly not the operation, which by this
        point has already happened."""
        out: dict = {}
        for key, getter in (
            ("database", command.audit_database),
            ("related", command.audit_related),
            ("databases", command.audit_databases),
        ):
            try:
                out[key] = getter()
            except Exception as exc:  # noqa: BLE001 - see above
                _log.swallowed(exc, "_attribution")
                out[key] = None
        return out

    def note(
        self,
        source: str,
        action: str,
        summary: str,
        database: str | None = None,
        related: str | None = None,
        databases: list[str] | None = None,
        previous_name: str | None = None,
    ) -> None:
        """Audit-only entry for mutations that don't go through a Command (database lifecycle) —
        they are not undoable, but they must not be invisible either.

        The attribution is passed **by hand** here, and nothing checks that a caller passed it: the
        tripwire test knows Command subclasses and cannot know a `note()` call site. Six of these
        exist for the model lifecycle plus three in the parameter-window recovery; a new one that
        names a model in its text and not in its field is a hole no test will find.

        `previous_name` is for the lifecycle notes only, and only for a rename: together with
        `database` on create/rename/delete it is the timeline the read side resolves names against
        (`audit_store.Lifecycle`). Nothing else has any business setting it.
        """
        with self._lock:
            self._record(
                source,
                action,
                summary,
                undoable=False,
                database=database,
                related=related,
                databases=databases,
                previous_name=previous_name,
            )

    def execute(self, command: Command, source: str = "user") -> dict:
        # invalidate in finally: a multi-step command that throws mid-way may already have
        # mutated the database — serving pre-mutation factorisations then would be wrong.
        # The project lock first (a switch holds it too), then the bus's own: the project check
        # below and the command are one step. Never the LCA lock here — see PROJECT_LOCK.
        with PROJECT_LOCK, self._lock:
            assert_expected_project()
            # The chat's model fence: a no-op unless the request came from the in-app chat.
            model_scope.fence_command(command)
            # Stamp the assistant turn before anything can fail: the stack and the log must
            # agree on it, so it is read exactly once and written to both.
            command.turn = CURRENT_TURN.get()
            try:
                result = command.execute()
            finally:
                lca.invalidate_lca_cache()
            # A command that found nothing to do says so (`unchanged`): no undo step for it — undoing a
            # no-op would undo the change BEFORE it — and no audit line, which would read as a change.
            if isinstance(result, dict) and result.get("unchanged"):
                return result
            command.executed_at = time.time()
            self._undo.append(command)
            self._redo.clear()
            self._record(
                source,
                command.action,
                command.summary(),
                turn=command.turn,
                **self._attribution(command),
            )
            return result

    def clear_history(self) -> dict:
        """Forget both stacks. Called when the ground moves under them — a project activated,
        created, deleted or restored.

        This is a **data-safety** fix, not tidiness. The stacks hold Command objects carrying
        database names and activity codes; the audit log follows the active project on its own, but
        these do not, so after a switch `_undo[-1]` pointed at a command of the *previous* project
        and `undo()` called its `undo()` in the new one. Where both projects hold a model of the same
        name — the normal case here, since a model gets copied into a neighbouring project to test
        something — that wrote to the wrong project with no error and no message.

        A method on the bus rather than callers reaching into the lists: the lists are guarded by
        this lock, and "clear the undo stack" is a thing the bus knows how to do safely. It writes no
        audit entry — nothing changed in the data, and the log would gain a line per project switch
        saying nothing.
        """
        with self._lock:
            dropped = len(self._undo) + len(self._redo)
            self._undo.clear()
            self._redo.clear()
            return {"dropped": dropped}

    def forget_model(self, name: str) -> int:
        """Drop every undo/redo step that belongs to model ``name`` — after it was renamed or deleted.

        The commands carry the model's name, and several carry snapshots under it. After a rename
        their undo hit a database that no longer existed (HTTP 500); once the old name was given to
        another model — a copy, a new model — the same undo changed THAT model instead. Rewriting
        names inside snapshots would be guessing at every command's internals, so the steps go, like the
        whole history does on a workspace switch (clear_history). Returns how many were dropped.
        """

        def mentions(value: object, depth: int = 0) -> bool:
            # A step may name the model only inside its snapshot — a removed input's supplier, a
            # consumer edge — while its attribution names another model (remove B's
            # input from A, rename A, reuse the name, undo relinked B to the new A). Dropping a step
            # too many costs one undo; dropping one too few changes the wrong model.
            if depth > 6:
                return False
            if isinstance(value, str):
                return value == name
            if isinstance(value, dict):
                return any(mentions(k, depth + 1) or mentions(v, depth + 1) for k, v in value.items())
            if isinstance(value, (list, tuple, set, frozenset)):
                return any(mentions(v, depth + 1) for v in value)
            return False

        def concerns(command: Command) -> bool:
            try:
                if command.audit_database() == name or name in (command.audit_databases() or []):
                    return True
                return mentions(vars(command))
            except Exception as exc:  # noqa: BLE001 - an unreadable step is kept, not guessed at
                _log.swallowed(exc, "forget_model")
                return False

        with self._lock:
            before = len(self._undo) + len(self._redo)
            self._undo[:] = [c for c in self._undo if not concerns(c)]
            self._redo[:] = [c for c in self._redo if not concerns(c)]
            return before - len(self._undo) - len(self._redo)

    def _refuse_while_a_window_is_open(self, verb: str) -> None:
        """Refuse an undo/redo while this process holds a parameter window open.

        A window applies a scenario's (or a sweep's) values by writing them into the model's
        parameters and putting the baseline back in a `finally`. An undo landing inside that span
        writes onto the overridden values, and the restore afterwards puts the pre-undo state back:
        the undo is silently reverted, and neither the log nor the UI says so. The windows last
        seconds to minutes, the marker that names them already exists, so this is a question, not
        machinery.

        Asked *before* the bus lock is taken, so the two locks never nest — `param_window.recover()`
        calls `note()` on this bus, and a fixed order in only one direction is what keeps that safe.
        """
        from prism_lca.engine import param_window

        try:
            open_window = param_window.open_now()
        except Exception as exc:  # noqa: BLE001 - never let the guard be the thing that fails
            _log.swallowed(exc, "_refuse_while_a_window_is_open")
            return
        if not open_window:
            return
        models = ", ".join(f"‘{d}’" for d in open_window["databases"] if d) or "this model"
        raise PrismError(
            f"Cannot {verb} while {open_window['label']} is applied to {models}.",
            code="param_window_open",
            status_code=409,
            hint=(
                f"That calculation has written its parameter values into the model and puts the "
                f"baseline back when it finishes, which would take your {verb} with it. It usually "
                f"takes seconds; try again once it is done."
            ),
        )

    def undo(self, source: str = "user", database: str | None = None) -> dict:
        self._refuse_while_a_window_is_open("undo")
        with PROJECT_LOCK, self._lock:
            assert_expected_project()
            if not self._undo:
                raise PrismError(
                    "Nothing to undo.",
                    code="nothing_to_undo",
                    status_code=409,
                    hint="No actions have been performed yet.",
                )
            at = self._pick(self._undo, database, "undo", source)
            # An undo writes where the step wrote: a workspace-wide step that reached into another
            # model is not the chat's to take back — nor one whose undo rewrites the library or another
            # model's inputs (moved to the library, a forced delete), which its attribution does not say.
            model_scope.fence_step(self._attribution(self._undo[at]))
            model_scope.fence_undo(self._undo[at])
            command = self._undo.pop(at)
            try:
                command.undo()
            except Exception:
                # A failed undo took nothing back, so it must not take the step off the stack either:
                # the history silently lost a line every time. It stays where it was, visibly.
                self._undo.insert(at, command)
                raise
            finally:
                lca.invalidate_lca_cache()
            self._redo.append(command)
            # The same attribution as the change it takes back: an undo *is* a change to that model,
            # and a reviewer asking why a number moved needs to find it in that model's list.
            self._record(source, "undo", f"Undo: {command.summary()}", **self._attribution(command))
            return {"undone": command.summary()}

    def redo(self, source: str = "user", database: str | None = None) -> dict:
        self._refuse_while_a_window_is_open("redo")
        with PROJECT_LOCK, self._lock:
            assert_expected_project()
            if not self._redo:
                raise PrismError(
                    "Nothing to redo.",
                    code="nothing_to_redo",
                    status_code=409,
                    hint="There is no undone action to redo.",
                )
            at = self._pick(self._redo, database, "redo", source)
            # A redo executes again: the fence asks what it will write NOW, and what it links — the
            # step may be the user's, linking a model the chat may not.
            model_scope.fence_step(self._attribution(self._redo[at]))
            model_scope.fence_command(self._redo[at])
            command = self._redo.pop(at)
            try:
                command.execute()
            except Exception:
                self._redo.insert(at, command)  # see undo()
                raise
            finally:
                lca.invalidate_lca_cache()
            self._undo.append(command)
            self._record(source, "redo", f"Redo: {command.summary()}", **self._attribution(command))
            return {"redone": command.summary()}

    def _owner(self, command: Command) -> str | None:
        """The model a step belongs to, for the model-scoped undo — None for a workspace-wide step.

        By attribution, the same three fields the log is filtered on. `related` is provenance (copied
        *from*), not a write, so a copy from A into B is B's step and only B's."""
        attr = self._attribution(command)
        return attr.get("database") or next(iter(attr.get("databases") or []), None)

    def _belongs(self, command: Command, database: str) -> bool:
        """Whether the model-scoped Undo of ``database`` may take this step back: it is that model's,
        it reached into it (`audit_databases`), or it names no model at all (workspace-wide)."""
        attr = self._attribution(command)
        own, reached = attr.get("database"), attr.get("databases") or []
        if not own and not reached:
            return True
        if own == database or database in reached:
            return True
        # A step whose model is gone — an undone bundle import, whose redo would bring it back — cannot
        # be taken from that model's page, so it may not be held there either.
        # Steps of a model deleted or renamed by the lifecycle never get here: `forget_model` drops them.
        try:
            names = set(get_bd().databases)
        except Exception as exc:  # noqa: BLE001 - when in doubt, keep the guard
            _log.swallowed(exc, "_belongs")
            return False
        return bool(own) and own not in names and not any(d in names for d in reached)

    def _local(self, command: Command) -> bool:
        """On the positive list (`local_to_model`) and attributed to exactly one model."""
        if not getattr(command, "local_to_model", False):
            return False
        attr = self._attribution(command)
        return bool(attr.get("database")) and not attr.get("databases")

    def _view(self, stack: list[Command], database: str | None) -> list[int]:
        """Positions of the steps the Undo of ``database`` cannot reach past: all but other models'
        local steps (an assistant changing parameters in B no longer holds the
        user's Undo in A). Without a model, the whole stack: the workspace Undo it always was."""
        if database is None:
            return list(range(len(stack)))
        return [
            i for i, c in enumerate(stack) if not (self._local(c) and self._owner(c) != database)
        ]

    def _target(self, stack: list[Command], database: str | None) -> int | None:
        """Where in ``stack`` the next step of ``database`` lies, or None when it cannot be taken.

        The newest step that is not another model's local step. Taken when it is on top anyway, or —
        out of order — when it is a local step of this very model: two local steps of different models
        touch disjoint data, so their order does not matter. A step of another model that is not local,
        or a non-local step of this model under other models' steps, holds the Undo here.
        """
        view = self._view(stack, database)
        if not view:
            return None
        i = view[-1]
        command = stack[i]
        if database is not None and not self._belongs(command, database):
            return None
        if i == len(stack) - 1:
            return i
        return i if self._local(command) and self._owner(command) == database else None

    def _pick(self, stack: list[Command], database: str | None, verb: str, source: str = "user") -> int:
        """The position of the step an undo/redo on ``database`` takes, or the refusal that says why
        there is none. Asked under the bus lock, so it describes exactly the stack it acts on."""
        target = self._target(stack, database)
        if target is not None:
            return target
        view = self._view(stack, database)
        if not view:
            raise PrismError(
                f"Nothing to {verb} in ‘{database}’.",
                code=f"nothing_to_{verb}",
                status_code=409,
                hint=f"The steps that can be {verb}ne belong to other models.",
            )
        newest = stack[view[-1]]
        blocker = newest if not self._belongs(newest, database) else stack[-1]
        where = self._owner(blocker) or "another model"
        # An assistant reads this too, and "open the other model and undo it there" would send it off to
        # take back somebody else's work. It may only do that with its own change.
        hint = (
            (
                f"{verb.capitalize()} only takes back changes to ‘{database}’, the model this chat works on, "
                f"and that change in ‘{where}’ is not this chat's to take back. Leave it, and tell the user if "
                f"it is in your way."
            )
            if model_scope.fence() is not None
            else (
                f"{verb.capitalize()} only takes back changes to ‘{database}’, the model this session works on. "
                f"If that change in ‘{where}’ was yours, switch the session to ‘{where}’ (canvas_view "
                f'action="open_model") and {verb} it there. If it was not yours, leave it: it is not '
                f"yours to take back — ask the user if it is in your way."
            )
            if source != "user"
            else (
                f"{verb.capitalize()} here only takes back changes to ‘{database}’, and that change in "
                f"‘{where}’ is newer and cannot be reached past. To change ‘{database}’ now, edit the value "
                f"directly. {verb.capitalize()}ing in ‘{where}’ would also free this model's {verb} — but it "
                f"takes back that newer change, perhaps an assistant's work."
            )
        )
        raise PrismError(
            f"The last change was made in ‘{where}’: {blocker.summary()}.",
            code=f"{verb}_elsewhere",
            status_code=409,
            hint=hint,
        )

    def _turn_view(self, stack: list[Command], database: str | None) -> tuple[str | None, list[int]]:
        """The contiguous assistant-turn block at the top of the model's view: its id and positions."""
        view = self._view(stack, database)
        if not view or not stack[view[-1]].turn:
            return None, []
        turn = stack[view[-1]].turn
        positions: list[int] = []
        for i in reversed(view):
            if stack[i].turn != turn:
                break
            positions.append(i)
        return turn, sorted(positions)

    def _turn_offer(self, stack: list[Command], database: str | None) -> dict | None:
        """The turn block Undo/Redo on ``database`` may take as a whole, or None. Every step must be
        the model's; and when other models' steps lie above it, every step must be local."""
        turn, positions = self._turn_view(stack, database)
        if turn is None:
            return None
        if database is not None:
            block = [stack[i] for i in positions]
            if not all(self._belongs(c, database) for c in block):
                return None
            reaches_past = positions != list(range(positions[0], len(stack)))
            if reaches_past and not all(self._local(c) and self._owner(c) == database for c in block):
                return None
        # The span the block covers, by when its steps were made: the canvas's own undo history must not
        # have a step inside it, or taking the block back whole would leave that step behind.
        made = [stack[i].executed_at for i in positions if stack[i].executed_at is not None]
        span = {"from_at": round(min(made) * 1000), "to_at": round(max(made) * 1000)} if made else {}
        return {"turn": turn, "size": len(positions), **span}

    @staticmethod
    def _turn_on_top(stack: list[Command]) -> dict | None:
        """The contiguous assistant-turn block at the top of a stack, or None.

        Contiguous is the load-bearing word: a turn whose commands have something else on
        top of them is not offered as a block, because taking it back would mean pulling from the
        middle of the stack — which is no longer an undo but an unchecked revert. (Scoped to a model,
        `_turn_offer` relaxes this for other models' local steps only.)
        """
        if not stack or not stack[-1].turn:
            return None
        turn = stack[-1].turn
        size = 0
        for command in reversed(stack):
            if command.turn != turn:
                break
            size += 1
        return {"turn": turn, "size": size}

    def _turn_batch(
        self,
        stack: list[Command],
        other: list[Command],
        turn: str,
        verb: str,
        step: str,
        source: str,
        database: str | None = None,
    ) -> dict:
        """Shared body of `undo_turn`/`redo_turn`: take the `turn` block off `stack` — the contiguous
        block on top, or on top of the model's view — applying `step` ('undo'|'execute') per command,
        newest first, pushing survivors onto `other`.

        Honesty over completeness, in both known failure shapes: a foreign command on top refuses
        up front (another chat or the user moved the model after the dialog was shown), and a step
        that throws stops the batch right there — the failed command goes BACK where it was, what
        was already taken back stays taken back, and the answer says both numbers. No rollback
        theatre: re-applying half a turn to hide a failure could itself fail, and then nobody knows
        what state the model is in. This is the "mid-batch failure" question, answered as: stop,
        keep the stacks consistent, say exactly where.
        """
        on_top, positions = self._turn_view(stack, database)
        if on_top == turn and database is not None and self._turn_offer(stack, database) is None:
            raise PrismError(
                f"That assistant turn also changed another model, so it cannot be {verb}ne from ‘{database}’.",
                code="turn_elsewhere",
                status_code=409,
                hint=(
                    f"{verb.capitalize()} its steps one by one"
                    + ("." if model_scope.fence() is not None else ", or open the other model.")
                ),
            )
        if on_top != turn:
            raise PrismError(
                f"The next {verb} step does not belong to that assistant turn.",
                code="turn_not_on_top",
                status_code=409,
                hint=(
                    f"Something else changed the model after that turn, so taking the whole turn "
                    f"back is no longer a plain {verb} — {verb} single steps instead."
                ),
            )
        block = [stack[i] for i in positions]
        # All or nothing for the fence: refused before the first step is taken back.
        for command in block:
            model_scope.fence_step(self._attribution(command))
            if step == "execute":
                model_scope.fence_command(command)  # see redo()
            else:
                model_scope.fence_undo(command)  # see undo()
        done = 0
        databases: list[str] = []
        stopped: str | None = None
        try:
            for command in reversed(block):
                at = next(i for i, c in enumerate(stack) if c is command)
                stack.pop(at)
                try:
                    getattr(command, step)()
                except Exception as e:  # noqa: BLE001 - the batch must report, not explode
                    _log.swallowed(e, "_turn_batch")
                    stack.insert(at, command)  # not taken back — it stays where it was
                    stopped = f"{command.summary()} ({e})"
                    break
                other.append(command)
                done += 1
                try:
                    db = command.audit_database()
                except Exception as exc:  # noqa: BLE001 - attribution must never cost the batch
                    _log.swallowed(exc, "_turn_batch")
                    db = None
                if db and db not in databases:
                    databases.append(db)
        finally:
            lca.invalidate_lca_cache()
        rest_turn, rest = self._turn_view(stack, database)
        left = len(rest) if rest_turn == turn else 0
        word = "Undo" if verb == "undo" else "Redo"
        summary = f"{word}: {done} change{'' if done == 1 else 's'} of one assistant turn"
        if stopped:
            summary += f" — stopped at: {stopped}"
        # One audit line for the whole batch (the ImportBundle precedent): forty "Undo: …" lines
        # would bury the log under its own cleanup. The line carries every model the batch touched.
        kw: dict = (
            {"database": databases[0]}
            if len(databases) == 1
            else ({"databases": databases} if databases else {})
        )
        self._record(source, verb, summary, **kw)
        return {
            ("undone" if verb == "undo" else "redone"): done,
            "stopped": stopped,
            "remaining_in_turn": left,
        }

    def undo_turn(self, turn: str, source: str = "user", database: str | None = None) -> dict:
        """Undo every command of one assistant turn, newest first — but only while the turn is the
        contiguous top of the stack, and, scoped to a model, only when every step is its."""
        self._refuse_while_a_window_is_open("undo")
        with PROJECT_LOCK, self._lock:
            assert_expected_project()
            return self._turn_batch(self._undo, self._redo, turn, "undo", "undo", source, database)

    def redo_turn(self, turn: str, source: str = "user", database: str | None = None) -> dict:
        """Mirror of `undo_turn` on the redo stack."""
        self._refuse_while_a_window_is_open("redo")
        with PROJECT_LOCK, self._lock:
            assert_expected_project()
            return self._turn_batch(self._redo, self._undo, turn, "redo", "execute", source, database)

    def history(self, database: str | None = None) -> dict:
        """What Undo/Redo would do. With ``database``: what they would do *on that model* — a step on
        top that belongs to another model is reported as `undo_elsewhere`/`redo_elsewhere` (its model and
        summary) instead of being offered. Single step and turn are answered separately: a turn that
        also reached another model is not offered as a block even when its top step is this model's."""
        # Not under the bus lock, as before: an import holds it for minutes, and the toolbar polls this.
        # Copies of the lists, so a step pushed meanwhile cannot shift what one answer describes.
        out: dict = {}
        for verb, stack in (("undo", list(self._undo)), ("redo", list(self._redo))):
            target = self._target(stack, database)
            ok = target is not None
            out[f"can_{verb}"] = ok
            out[f"next_{verb}"] = stack[target].summary() if ok else None
            # When that step was first made, in epoch milliseconds — see `Command.executed_at`. Also when the
            # step is held by another model's: the model's own newest step still bounds what the canvas's
            # history may take back before it, so it is reported either way.
            own = stack[target] if ok else next((c for c in reversed(stack) if database is not None and self._belongs(c, database)), None)
            at = own.executed_at if own is not None else None
            out[f"next_{verb}_at"] = round(at * 1000) if at is not None else None
            # The contiguous assistant-turn block on top of the model's view, if any — what lets the UI
            # ask "the whole turn, or just the last step?" instead of forty identical clicks.
            out[f"next_{verb}_turn"] = self._turn_offer(stack, database) if ok else None
            held = None
            view = self._view(stack, database)
            if not ok and view:
                newest = stack[view[-1]]
                blocker = newest if not self._belongs(newest, database or "") else stack[-1]
                held = {"model": self._owner(blocker), "summary": blocker.summary()}
            out[f"{verb}_elsewhere"] = held
        return out

    def audit(
        self,
        database: str | None = None,
        source: str | None = None,
        limit: int | None = None,
        client: str | None = None,
    ) -> list[AuditEntry]:
        """The history of the active project, oldest first — including previous sessions.

        Filtered on the **field**, never on the text. Reading a model's name out of `summary` is
        what made the bundle export ship an arbitrary one-to-nine-line slice of a hundreds-strong
        history and call it complete, and the same search would put `Set parameter 'tube_mass'`
        into the wrong model's list here.

        `database` keeps the entries attributed to that model **and** the ones attributed to no model:
        those from before the field existed as earlier history, the later ones marked `workspace`
        (see `field_from` below). The second half is not laxness: all 1268 lines in the development log were written
        before the field existed, and they are shown as their own collapsed block ("earlier history")
        rather than dropped, because dropping them hides that the model has a past, and mixing them in
        claims a model they never named. `audit_store.is_attributed` is how the caller tells them
        apart — the difference is in the fields, so the reader never has to guess either.

        `limit` keeps the **newest** entries (0 or less = no limit), and the model's own history has first claim on the
        budget: whatever is left over is filled with the newest unattributed lines. So a young model
        still gets its pre-field context, and a model with a long history of its own is not made to
        scroll past someone else's. No rotation, nothing deleted — the file keeps everything.

        **A name is the name at the time**, so the filter runs against the timeline the lifecycle
        notes draw (`audit_store.Lifecycle`): a renamed model keeps the entries it wrote under its old
        name, and a *new* model that happens to reuse a freed name does not inherit them. The
        timeline is built from the very list this call loaded, not from the cache, so the filter and
        the entries it filters can never be one line out of step with each other.
        """
        raw = audit_store.load()
        timeline = audit_store.Lifecycle(raw)
        # The model may descend from another one. Resolved once for the request, not per entry —
        # and only when that other model is one *this* project had, because a bundle import records
        # the name it had in the sender's project and there is no history here to send anyone to.
        origin_model = timeline.model_named(database) if database is not None else None
        origin_index = (
            origin_model.origin_index
            if origin_model
            and origin_model.origin
            and timeline.knows(origin_model.origin, origin_model)
            else None
        )
        # Where the field begins. An unattributed line *before* the first attributed one is history
        # from before entries named their model — the "earlier history" block. One *after* it was
        # written by code that names every model it changes, so it changed none: a workspace-wide
        # action (a tag group or a tag value created). It went into every model's "earlier history"
        # under a label that was wrong for it (106 tag actions); it now comes back marked `workspace`
        # and stands in its place in time — every view of the app is model-scoped,
        # so leaving it out would make it visible nowhere.
        field_from = next((i for i, e in enumerate(raw) if audit_store.is_attributed(e)), len(raw))
        out: list[AuditEntry] = []
        for position, item in enumerate(raw):
            if source is not None and item.get("source") != source:
                continue
            if client is not None and item.get("client") != client:
                continue
            if database is not None and not (
                audit_store.attributed_to(item, database, timeline)
                or not audit_store.is_attributed(item)
            ):
                continue
            try:
                entry = AuditEntry(**item)
            except (TypeError, ValueError):
                # An entry written by a future version with a field this one does not know: keep the
                # log readable rather than refusing the lot.
                continue
            self._resolve(entry, timeline, origin_model, origin_index)
            if database is not None and position >= field_from and not audit_store.is_attributed(item):
                entry.workspace = True
            out.append(entry)
        # `limit <= 0` means no limit, not "nothing": `out[-0:]` is the whole list, and a caller who
        # asked for zero entries and got all of them would be the wrong way round to be wrong.
        if limit is not None and limit > 0 and len(out) > limit:
            out = self._newest(out, limit, origin_index) if database is not None else out[-limit:]
        return out

    @staticmethod
    def _resolve(
        entry: AuditEntry,
        timeline: audit_store.Lifecycle,
        origin_model: audit_store.Model | None,
        origin_index: int | None,
    ) -> None:
        """Write the timeline's answers onto the entry — three fields the file never carries.

        The stored name is never touched (append-only); what the view needs is what that name
        means *now*, and only the read side can know it. `model_gone` is the one that has to exist:
        an entry whose model was deleted must say so rather than quietly go missing, because the
        history outliving the model is the whole point of an append-only log.
        """
        if entry.database:
            now = timeline.resolved_name(entry.database, entry.index)
            if now is None:
                entry.model_gone = True
            elif now != entry.database:
                entry.current_name = now
        if origin_model is not None and origin_index == entry.index:
            entry.copied_from = origin_model.origin

    @staticmethod
    def _newest(
        entries: list[AuditEntry], limit: int, origin_index: int | None = None
    ) -> list[AuditEntry]:
        """The newest `limit` entries, the attributed ones first in line for the budget.

        By position, not by identity: two entries can compare equal (the same action on the same
        model in the same second) and picking by value would then drop the wrong one.

        The line that says where the model came from is pinned: it is the oldest entry a
        duplicated model has, so the budget would drop it first — and it would go missing for exactly
        the models with enough history to make the question worth asking.
        """
        # Three tiers for the budget: the model's own lines, then the workspace-wide ones that stand in
        # its list (see `audit`), then the earlier history — so a run of tag actions can never push the
        # model's own changes out of its own view.
        attributed = [bool(e.database or e.related or e.databases) for e in entries]
        pinned = {
            i for i, e in enumerate(entries) if origin_index is not None and e.index == origin_index
        }
        own = [i for i, yes in enumerate(attributed) if yes and i not in pinned]
        workspace = [i for i, e in enumerate(entries) if e.workspace and not attributed[i]]
        earlier = [i for i, yes in enumerate(attributed) if not yes and not entries[i].workspace]
        # `x[-0:]` is the whole list, so an exhausted budget has to be spelled out rather than sliced.
        budget = max(limit - len(pinned), 0)
        keep = set(pinned) | (set(own[-budget:]) if budget else set())
        for tier in (workspace, earlier):
            room = limit - len(keep)
            if room > 0:
                keep |= set(tier[-room:])
        return [e for i, e in enumerate(entries) if i in keep]  # back into one chronological list
