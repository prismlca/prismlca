"""Which places of a model name a parameter, and which of those names point at nothing.

A model names its parameters in three places: the formulas of its other parameters, the formulas on its
exchanges and the overrides of its scenarios (the parameter an override sets, and the names a formula override
reads). Deleting a parameter one of them still names leaves a model whose every parameter write fails with
"variables aren't defined", while the dependent values stay frozen and the scenarios run into nothing.

This module answers the three questions the guards against that need, exactly and without guessing: what still
uses a parameter that is about to be deleted (:func:`check_deletable`), which formula carries the name a write
failed on (:func:`undefined_reason`), and what in a model already names a parameter it does not have
(:func:`uses`, read by the health check). A formula's names are read the way
bw2data reads them: every name in the expression that is not one of the formula interpreter's own (``sqrt``,
``min``, ``pi``).
"""
from __future__ import annotations

import ast
import keyword
import re
from dataclasses import dataclass
from functools import lru_cache

from prism_lca import _log
from prism_lca.errors import PrismError


@dataclass(frozen=True)
class Use:
    """One place in a model that names parameters."""

    kind: str  # "parameter", "exchange" or "scenario"
    #: How a reader finds it: "parameter 'a'", "the amount of 'steel' in 'Bottle production'", "scenario 'High'".
    label: str
    names: frozenset[str]
    #: The parameter whose formula this is (kind "parameter").
    owner: str | None = None
    #: The process an exchange formula sits in, and the exchange's uid (kind "exchange").
    key: tuple | None = None
    uid: str | None = None


@lru_cache(maxsize=1)
def _interpreter_names() -> frozenset[str]:
    from asteval import Interpreter

    return frozenset(Interpreter().symtable)


#: Every word that could be a name — the reading of a formula that does not parse.
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def names_in(formula: str) -> frozenset[str]:
    """The names a formula reads that the interpreter does not supply itself — parameters, defined or not.

    Parsed as asteval parses it (a module, so "mass * 2;" counts), names collected as its NameFinder collects
    them. A formula that does not parse still keeps its words: read as naming nothing, it would let the
    parameter it names be deleted."""
    try:
        tree = ast.parse(str(formula))
    except (SyntaxError, ValueError):
        words = set(_WORD.findall(str(formula))) - set(keyword.kwlist)
        return frozenset(words) - _interpreter_names()
    return frozenset(n.id for n in ast.walk(tree) if isinstance(n, ast.Name)) - _interpreter_names()


def _input_name(ex) -> str:
    try:
        return str(ex.input.get("name") or "")
    except Exception as exc:  # noqa: BLE001 — an unlinked input still has a formula worth naming
        _log.swallowed(exc, "param_references._input_name")
        return "an unlinked input"


def uses(
    database: str, formulas: dict[str, str | None] | None = None, dropped: frozenset[str] = frozenset()
) -> list[Use]:
    """Every place in ``database`` that names a parameter.

    ``formulas`` are parameter formulas as a pending write leaves them (None: a plain value), and ``dropped``
    the parameters it deletes — so a write can be judged by the state it would leave, not the one it changes.
    """
    from prism_lca.engine import params
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.scenarios import ScenarioStore

    current = params.snapshot_formulas(database)
    current.update(formulas or {})
    out = [
        Use("parameter", f"parameter '{name}'", names_in(formula), owner=name)
        for name, formula in current.items()
        if formula and name not in dropped
    ]
    for act in get_bd().Database(database):
        for ex in act.exchanges():
            if ex.get("formula"):
                label = f"the amount of '{_input_name(ex)}' in '{act.get('name')}'"
                out.append(Use("exchange", label, names_in(ex["formula"]), key=act.key, uid=ex.get("prism_uid")))
    for entry in ScenarioStore().list_all(database):
        overrides = entry.get("overrides") or {}
        named = {str(k) for k in overrides}
        for value in overrides.values():
            if isinstance(value, str):
                named |= names_in(value)
        out.append(Use("scenario", f"scenario '{entry.get('name')}'", frozenset(named)))
    return out


def _listed(items: list[str], most: int = 6) -> str:
    shown = items[:most] + ([f"{len(items) - most} more"] if len(items) > most else [])
    return shown[0] if len(shown) == 1 else ", ".join(shown[:-1]) + " and " + shown[-1]


def check_deletable(database: str, names: set[str], formulas: dict[str, str | None] | None = None,
                    whole_state: bool = False) -> None:
    """Refuse deleting a parameter the model does not have, or one anything else in it still names. Raises, or
    returns quietly.

    Judged on the state the write leaves: ``formulas`` are the parameter formulas the same call sets, so a
    batch may rewrite a parameter's users and delete it beside them. Exchange formulas and scenarios are not
    written by a parameter call, so their uses have to be changed first.

    ``whole_state`` also refuses while any formula of that state names a parameter the model does not have,
    whatever the call deletes — for a batch: its rows are stored before the exchange formulas are evaluated,
    so in a model that already lost a parameter the deletion would stay while the call is reported as failed,
    with nothing to undo.
    """
    from prism_lca.engine import params

    if not names:
        return
    for name in sorted(names):
        if params.snapshot(database, name) is None:
            raise PrismError(f"Parameter '{name}' not found.", code="param_not_found", status_code=404,
                             hint="Only an existing parameter can be deleted; see list_parameters.")
    users = [u for u in uses(database, formulas, dropped=frozenset(names)) if u.names & names]
    if users:
        raise _in_use(names, users)
    dead = _dead(database, formulas or {}, frozenset(names)) if whole_state else []
    if dead:
        raise PrismError(
            "Not deleted: this model already names a parameter it does not have — "
            f"{_told(dead, formulas or {}, 'in the same call')}.",
            code="param_dead_reference",
            hint="Repair those formulas first, or in the same call; then delete.",
        )


def _in_use(names: set[str], users: list[Use]) -> PrismError:
    """The refusal of :func:`check_deletable` for parameters something still names, with the way out per kind."""
    gone = sorted(names & frozenset().union(*(u.names for u in users)))
    parts = [f"'{n}' is still used by {_listed([u.label for u in users if n in u.names])}" for n in gone]
    owners = [str(u.owner) for u in users if u.kind == "parameter"]
    hint = []
    if owners:
        it = "it" if len(gone) == 1 else "them"
        quoted = _listed([f"'{o}'" for o in owners])
        hint.append(
            f"Give {quoted} a formula or value without {it} in the same call that "
            f'deletes {it}: parameters=[{{"name": "{owners[0]}", "formula": "…"}}, '
            f'{{"name": "{gone[0]}", "action": "delete"}}].'
        )
    if any(u.kind == "exchange" for u in users):
        hint.append("Change the exchange formula first (edit_exchange).")
    if any(u.kind == "scenario" for u in users):
        hint.append("Take the override out of the scenario first (edit_scenario).")
    return PrismError(
        "Not deleted: " + "; ".join(parts) + " — they would be left naming a parameter that does not exist.",
        code="param_in_use",
        hint=" ".join(hint),
    )


def _dead(database: str, sent: dict[str, str | None], dropped: frozenset[str]) -> list[tuple[Use, list[str]]]:
    """The parameter and exchange formulas of the state a write leaves that name an undefined parameter, with
    those names. Scenarios are left out: a dead override stops no write."""
    from prism_lca.engine import params

    data, project = params.parameter_namespace(database)
    defined = (set(data) | set(sent) | set(project)) - set(dropped)
    found = [(use, sorted(use.names - defined)) for use in uses(database, sent, dropped) if use.kind != "scenario"]
    return [(use, missing) for use, missing in found if missing]


def _told(dead: list[tuple[Use, list[str]]], sent: dict[str, str | None], fix: str) -> str:
    told = []
    for use, missing in dead:
        what = _listed([f"'{m}'" for m in missing])
        which = f"which {'is not a parameter' if len(missing) == 1 else 'are not parameters'} of this model"
        if use.kind == "exchange":
            told.append(f"{use.label} still uses {what}, {which} — give it another formula (edit_exchange), "
                        "or create the parameter")
        elif use.owner in sent:
            told.append(f"the formula sent for '{use.owner}' uses {what}, {which} — check the spelling, or "
                        "create it in the same call")
        else:
            told.append(f"'{use.owner}' (not part of this call) still uses {what}, {which} — set its formula or "
                        f"value {fix}")
    return "; ".join(told)


def undefined_reason(exc: Exception, database: str, sent: dict[str, str | None],
                     dropped: frozenset[str] = frozenset(), fix: str = "in the same call") -> str | None:
    """Why a parameter write failed on a name no parameter has, told by the formula that carries it.

    bw2data says only "The following variables aren't defined: x", which reads like a typo in the call even
    when the call never mentioned x: a formula elsewhere in the model still names a deleted parameter, and
    every write recalculates every formula. ``sent`` holds the formulas of the parameters the write sets as it
    leaves them (None: a plain value), ``dropped`` the ones it deletes; ``fix`` says where a parameter outside
    the call is repaired — in the same call for a parameter write, first and by edit_parameter for an exchange
    formula. None when ``exc`` is another failure, or no formula names an undefined parameter.

    Told, not checked in advance: bw2data evaluates the parameters before the exchanges, so in a model that
    already lost a parameter the parameter formulas have to be repaired by one write before an exchange formula
    can be — a check refusing the first write over the second would leave no way out.
    """
    from bw2parameters.errors import MissingName

    if not isinstance(exc, MissingName):
        return None
    try:
        return _told(_dead(database, sent, dropped), sent, fix) or None
    except Exception as err:  # noqa: BLE001 — the plain message is still the answer
        _log.swallowed(err, "undefined_reason")
        return None
