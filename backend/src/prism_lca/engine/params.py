"""Parameters & variables (ADR-013), mapped onto Brightway's native parameter engine.

Parameters are **model-scoped**: each foreground model (database) owns its own named variables,
stored as bw2data ``DatabaseParameter`` rows on that database. Two models may reuse the same name
with independent values. Foreground exchange amounts can be driven by a ``formula`` referencing the
model's parameters — Brightway resolves them automatically because an activity group's parameter
namespace already includes ``DatabaseParameter.static(<the activity's own database>)``. Brightway
evaluates formulas (topologically, with cycle detection) and recomputes exchange amounts.

The exchange/formula half of this module (``register_activity_group``, ``set_exchange_formula`` …)
is scope-agnostic — it works off the activity's own database — so only the global-parameter half
carries a ``database`` argument.
"""
from __future__ import annotations

import keyword
import re

from prism_lca import _log
from prism_lca.engine import model, param_rules
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import assert_writable
from prism_lca.errors import PrismError


def _P():
    get_bd()  # ensure BRIGHTWAY2_DIR set + bw2data imported first
    from bw2data.parameters import ActivityParameter, Group, ProjectParameter, parameters

    return ProjectParameter, ActivityParameter, Group, parameters


def _DB():
    """DatabaseParameter + the parameters manager (model-scoped global-parameter half)."""
    get_bd()
    from bw2data.parameters import DatabaseParameter, parameters

    return DatabaseParameter, parameters


def _group_name(database: str, code: str) -> str:
    return f"prism__{database}__{code}"


def _purge_orphan_groups() -> None:
    """Drop ``Group`` rows that ``parameters.recalculate()`` would crash on.

    bw2data's ``recalculate()`` walks every non-fresh group and, for any whose name is neither a
    live database nor ``"project"``, calls ``ActivityParameter.recalculate(group)`` — which raises
    ``DoesNotExist`` when that group has no ActivityParameter rows, breaking EVERY subsequent
    parameter update (and every scenario calculation). Such orphans are left behind two ways:
    deleting a parameterised foreground activity leaves its ``prism__…`` activity group, and
    deleting a model that carried DatabaseParameters leaves a group named after the vanished
    database (bw2data names a database-parameter group after its database). Purge exactly what
    bw2data would choke on: any group that is not ``"project"``, not a live database, and backed
    by no ActivityParameter."""
    _PP, ActivityParameter, Group, _parameters = _P()
    from bw2data import databases
    from bw2data.parameters import GroupDependency

    backed = {ap.group for ap in ActivityParameter.select()}
    dbs = set(databases)
    for g in Group.select():
        if g.name == "project" or g.name in dbs or g.name in backed:
            continue
        GroupDependency.delete().where(GroupDependency.group == g.name).execute()
        g.delete_instance()


def recalc_all(model_change: bool = True) -> None:
    _PP, ActivityParameter, Group, parameters = _P()
    _purge_orphan_groups()
    parameters.recalculate()
    for g in Group.select():
        try:
            ActivityParameter.recalculate_exchanges(g.name)
        except Exception as exc:  # noqa: BLE001 - a group without formulas is fine
            _log.swallowed(exc, "recalc_all")
    # Exchange amounts changed → drop cached factorisations so scores aren't stale.
    # `model_change=False` is the reversible windows' path (see apply_values).
    from prism_lca.engine import lca

    lca.invalidate_lca_cache(model_change=model_change)


def recalc_database(database: str, model_change: bool = True, strict: bool = False) -> None:
    """Recalculate ONE model's parameters and its parameterised exchanges.

    ``recalc_all`` walks every parameter group in the project, and bw2data re-saves every parameterised
    exchange of every model and flushes the database metadata once per group — 13.5 s for a single
    parameter edit in a 56-model project (302 groups, 710 exchanges; profiled, V331).
    Parameters are model-scoped (ADR-013): a formula in model A can only name parameters of model A,
    so nothing outside the model can change when the model does. Two things are deliberately kept
    project-wide: the orphan purge (cheap, and the crash it prevents is project-wide) and the
    project-parameter group, which every database group may depend on.

    A parameter that no exchange uses can still be read by another parameter that an exchange does
    use: ``DatabaseParameter.recalculate`` evaluates the model's whole formula
    chain first, and the exchanges are recomputed from the fresh values after it.

    ``strict=True`` lets a failure of the exchange pass through instead of swallowing it — for the
    crash restore, which may only clear its marker over exchanges that were really recomputed.
    """
    ProjectParameter, ActivityParameter, Group, _parameters = _P()
    DatabaseParameter, _ = _DB()
    _purge_orphan_groups()
    if ProjectParameter.expired():
        ProjectParameter.recalculate()
    # The model's own group is forced stale: `apply_values` saves amounts row by row without expiring
    # it, and a group still marked fresh would skip the formula chain.
    if DatabaseParameter.select().where(DatabaseParameter.database == database).exists():
        Group.get_or_create(name=database)[0].expire()
        DatabaseParameter.recalculate(database)
    # The activity groups of this model: named `prism__<db>__<code>` by us, and backed by a row that
    # carries the database — both are used, so a group registered either way is found.
    prefix = _group_name(database, "")
    names = {g.name for g in Group.select().where(Group.name.startswith(prefix))}
    names |= {
        row.group
        for row in ActivityParameter.select(ActivityParameter.group)
        .where(ActivityParameter.database == database)
        .distinct()
    }
    for g in sorted(names):
        # A stale group is evaluated first and OUTSIDE the guard: a formula that names something the
        # model does not have raises here, and the callers turn that into their answer — the sheet
        # import lists it under `formulas_unresolved`, `set_param` refuses the edit. Swallowing it
        # would report success over a frozen amount. Only the exchange pass below may fail quietly,
        # for a group that carries no formulas at all.
        if ActivityParameter.expired(g):
            ActivityParameter.recalculate(g)
        try:
            ActivityParameter.recalculate_exchanges(g)
        except Exception as exc:  # noqa: BLE001 - a group without formulas is fine
            if strict:
                raise
            _log.swallowed(exc, "recalc_database")
    from prism_lca.engine import lca

    lca.invalidate_lca_cache(model_change=model_change)


def _get_row(database: str, name: str):
    DatabaseParameter, _parameters = _DB()
    return DatabaseParameter.get_or_none(
        (DatabaseParameter.database == database) & (DatabaseParameter.name == name)
    )


def snapshot_all(database: str) -> dict[str, float]:
    """Current amount of every parameter of one model (baseline for scenario apply/restore)."""
    DatabaseParameter, _parameters = _DB()
    return {
        p.name: p.amount
        for p in DatabaseParameter.select().where(DatabaseParameter.database == database)
    }


def snapshot_formulas(database: str) -> dict[str, str | None]:
    """The formula of every parameter of one model (None for a plain value) — the half of a parameter's
    state that :func:`snapshot_all` does not carry.

    A scenario that overrides a formula-driven parameter has to take the formula out for the length of
    the window, or the recalculation that follows puts the formula's result straight back and the
    override does nothing. Whatever is taken out has to be put back, so it is
    snapshotted beside the amounts."""
    DatabaseParameter, _parameters = _DB()
    return {
        p.name: (p.formula or None)
        for p in DatabaseParameter.select().where(DatabaseParameter.database == database)
    }


def parameter_namespace(database: str) -> tuple[dict[str, dict], dict]:
    """The model's parameters as :func:`evaluate_overrides` reads them, plus the project parameters —
    read once, for a caller that evaluates several override sets against the same model state."""
    ProjectParameter, _AP, _G, _parameters = _P()
    DatabaseParameter, _ = _DB()
    data: dict[str, dict] = {}
    for p in DatabaseParameter.select().where(DatabaseParameter.database == database):
        data[p.name] = {"formula": p.formula} if p.formula else {"amount": float(p.amount or 0.0)}
    return data, ProjectParameter.static()


def evaluate_overrides(
    database: str,
    overrides: dict[str, float | str],
    namespace: tuple[dict[str, dict], dict] | None = None,
) -> dict[str, float]:
    """Every parameter of the model as it would stand under ``overrides``, without writing anything.

    A number replaces the parameter's value *and* its formula (the override is the value); a string is a
    formula that replaces the parameter's own, evaluated in the model's namespace — the other parameters,
    under the same overrides, and the project parameters. This is the check a scenario's formula override
    gets before it is stored: the same evaluation the engine runs when the scenario is applied, so a
    formula that would fail there is refused here, with the reason.
    """
    import ast

    from asteval import Interpreter
    from bw2parameters import ParameterSet

    base, glo = namespace if namespace is not None else parameter_namespace(database)
    data: dict[str, dict] = {k: dict(v) for k, v in base.items()}
    for name, value in (overrides or {}).items():
        data[str(name)] = {"formula": value} if isinstance(value, str) else {"amount": float(value)}
    known = set(data) | set(glo) | set(Interpreter(minimal=True).symtable)
    for name, value in (overrides or {}).items():
        if not isinstance(value, str):
            continue
        try:
            tree = ast.parse(value, mode="eval")
        except SyntaxError as exc:
            raise PrismError(
                f"The formula for '{name}' is not valid: {value!r} ({exc.msg}).",
                code="formula_error",
                hint="Write a Python-style expression over the model's parameters, e.g. '2 * mass_kg'.",
            ) from exc
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
        missing = sorted(n for n in names if n not in known)
        if missing:
            raise PrismError(
                f"The formula for '{name}' uses unknown name(s): {', '.join(missing)}.",
                code="formula_error",
                hint="A formula may name the model's own parameters (see list_parameters); check the spelling.",
            )
        if str(name) in names:
            raise PrismError(
                f"The formula for '{name}' refers to '{name}' itself.",
                code="formula_error",
                hint=f"Write it in terms of the other parameters — the formula replaces '{name}' for this "
                "scenario, so its own value is not available to it.",
            )
    try:
        result = ParameterSet(data, glo).evaluate()
    except Exception as exc:  # noqa: BLE001 - bw2parameters: cycles, undefined names, bad expressions
        text = " ".join(str(exc).split()) or type(exc).__name__
        raise PrismError(
            f"The model's parameters cannot be evaluated with these overrides: {text}",
            code="formula_error",
            hint="Check for circular references between the overridden formulas and the model's own, "
            "and for a formula of the model that the new values break (a division by zero).",
        ) from exc
    out: dict[str, float] = {}
    for name, value in result.items():
        if name not in data:
            continue  # a project parameter
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise PrismError(
                f"The formula for '{name}' does not produce a number (got {type(value).__name__}).",
                code="formula_error",
                hint="A formula must evaluate to a single numeric value.",
            )
        out[name] = float(value)
    return out


def apply_values(
    database: str, values: dict[str, float], formulas: dict[str, str | None] | None = None
) -> None:
    """Set amounts for the named parameters of one model, then recalculate everything.

    ``formulas`` sets the named parameters' formulas as well (None: a plain value). A scenario window
    passes it — see :func:`snapshot_formulas` — and so does the restore that ends the window.

    ONLY for the reversible windows — scenario apply→restore, sensitivity sweeps, Monte Carlo,
    comparisons — which snapshot first, hold the LCA lock across the block, and restore before
    anyone else computes. The model afterwards is the model from before, so this deliberately does
    NOT move the model generation: keying the report data snapshots on a counter this path bumped
    made every scenario-bearing report rebuild ~100 s of LCIA per brief, gate and staleness check
    (V131). Real parameter edits go through set_param/delete_param/commands, which
    bump it."""
    formulas = formulas or {}
    for name in dict.fromkeys([*values, *formulas]):
        p = _get_row(database, name)
        if p is None:
            continue
        if name in values:
            p.amount = float(values[name])
        if name in formulas:
            p.formula = formulas[name] or None
        p.save()
    recalc_database(database, model_change=False)


_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")


def formula_usage(database: str) -> dict[str, list[dict]]:
    """Parameter name -> the exchanges whose formula references it.

    Answers "what breaks if I change this?" — without it, editing a parameter is a blind edit, and
    deciding whether one is still needed means reading every formula in the model by hand. Formulas
    live on the exchanges themselves, so this is a scan over the model's activities; it is opt-in on
    the endpoint for that reason.
    """
    usage: dict[str, list[dict]] = {}
    bd = get_bd()
    for act in bd.Database(database):
        for ex in act.exchanges():
            formula = ex.get("formula")
            if not formula:
                continue
            for token in set(_IDENT_RE.findall(str(formula))):
                usage.setdefault(token, []).append(
                    {
                        "activity_code": act.get("code"),
                        "activity_name": act.get("name"),
                        "uid": ex.get("prism_uid"),
                        "input": ex.input.get("name"),
                        "formula": formula,
                    }
                )
    return usage



def notes_quoting_value(database: str, name: str, value: float | None) -> list[dict]:
    """Notes downstream of parameter ``name`` that spell out ``value`` — the figure it no longer has.

    The health check's `stale_parameter_figure` (V164) finds a figure written NEXT TO the parameter's
    name. Most notes do not name the parameter: "0.047 kWh per event is an engineering proxy" sat on
    the electricity exchange whose formula is `doses_per_bottle * heating_electricity_per_dose`, the
    parameter moved to 0.048, and the note kept saying 0.047 into the report (V339). So
    this asks the narrower, answerable question at the one moment the old value is known — the write:
    which exchange comments, and which process notes, in the parameter's formula reach still quote it?

    Exact figure, digit-bounded, in the forms a person types (`0.047`, `0,047`, `4.7e-02` is not one
    of them). Returns one entry per note: where it is, and the sentence around the figure.
    """
    if value is None:
        return []
    forms = {f"{value:g}", f"{value:g}".replace(".", ","), str(value)}
    if float(value).is_integer():
        forms.add(str(int(value)))
    if not any(ch.isdigit() for form in forms for ch in form) or {f for f in forms if f} <= {"0", "1"}:
        return []
    pattern = re.compile(r"(?<![\d.,])(" + "|".join(re.escape(f) for f in sorted(forms, key=len, reverse=True)) + r")(?![\d])")
    ref = re.compile(rf"\b{re.escape(name)}\b")
    bd = get_bd()
    out: list[dict] = []
    for act in bd.Database(database):
        touched = False
        for ex in act.exchanges():
            formula = str(ex.get("formula") or "")
            if not formula or not ref.search(formula):
                continue
            touched = True
            note = str(ex.get("comment") or "")
            hit = pattern.search(note)
            if hit:
                out.append(
                    {
                        "where": "exchange",
                        "activity_code": act.get("code"),
                        "activity_name": act.get("name"),
                        "uid": ex.get("prism_uid"),
                        "input": ex.input.get("name"),
                        "quote": _around(note, hit.start(), hit.end()),
                    }
                )
        if touched:
            note = str(act.get("comment") or "")
            hit = pattern.search(note)
            if hit:
                out.append(
                    {
                        "where": "process",
                        "activity_code": act.get("code"),
                        "activity_name": act.get("name"),
                        "quote": _around(note, hit.start(), hit.end()),
                    }
                )
    return out


def _around(text: str, start: int, end: int, width: int = 60) -> str:
    a, b = max(0, start - width), min(len(text), end + width)
    return ("…" if a else "") + text[a:b].strip() + ("…" if b < len(text) else "")

def parameter_usage(database: str) -> dict[str, list[dict]]:
    """Parameter name -> the *other parameters* whose formula references it.

    The other half of "what breaks if I change this?". A parameter that drives no exchange but
    feeds another parameter — a volume and a density behind a mass — used to come back with an
    empty ``used_by``, which reads as dead in the Parameters page and reached the assistant as a
    list of parameters it could tidy away. It is used; it is just used one step earlier.
    """
    DatabaseParameter, _parameters = _DB()
    usage: dict[str, list[dict]] = {}
    for p in DatabaseParameter.select().where(DatabaseParameter.database == database):
        if not p.formula:
            continue
        for token in set(_IDENT_RE.findall(str(p.formula))):
            if token == p.name:  # a self-reference is not a use; it is a cycle, refused elsewhere
                continue
            usage.setdefault(token, []).append({"name": p.name, "formula": p.formula})
    return usage


def unreachable_parameters(database: str) -> dict[str, list[str]]:
    """Parameters from which **no exchange formula is reachable**, following the chain of parameters.

    ``used_by_count`` answers a narrower question — "does anything mention this name?" — and a
    parameter mentioned by one dead parameter counts as used. That is how a whole branch of six
    parameters stayed invisible in a balcony-solar model: yield, tilt, degradation
    and lifetime all fed ``lifetime_energy_kwh``, and *that* fed nothing, so the check named the
    single leaf and let its five feeders pass as used. Every one of them was incapable of moving a
    number, and three scenarios built on them returned the baseline (V233, V236).

    So the question has to be asked transitively: can I get from this parameter, through any chain
    of parameter formulas, to a formula on an exchange? Returns ``name -> [termini]``, where a
    terminus is the dead end the chain runs into — the parameter that nothing at all consumes. A
    parameter that is its own terminus maps to ``[]``, which keeps the two cases apart for the
    caller: nothing refers to it, versus something refers to it and that something goes nowhere.
    """
    ex_users = set(formula_usage(database))
    feeds = {k: [d["name"] for d in v] for k, v in parameter_usage(database).items()}
    DatabaseParameter, _parameters = _DB()
    names = [p.name for p in DatabaseParameter.select().where(DatabaseParameter.database == database)]

    memo: dict[str, bool] = {}

    def reaches(name: str, seen: frozenset[str] = frozenset()) -> bool:
        if name in memo:
            return memo[name]
        if name in seen:  # a cycle reaches nothing on its own; cycles are refused elsewhere anyway
            return False
        if name in ex_users:
            memo[name] = True
            return True
        out = any(reaches(n, seen | {name}) for n in feeds.get(name, ()))
        memo[name] = out
        return out

    def termini(name: str, seen: frozenset[str] = frozenset()) -> list[str]:
        """The dead ends downstream of an unreachable parameter, nearest first."""
        downstream = [n for n in feeds.get(name, ()) if n not in seen]
        if not downstream:
            return []
        out: list[str] = []
        for n in downstream:
            deeper = termini(n, seen | {name})
            out.extend(deeper or [n])
        return list(dict.fromkeys(out))

    return {n: termini(n) for n in names if not reaches(n)}


def list_params(database: str, with_usage: bool = False) -> list[dict]:
    DatabaseParameter, _parameters = _DB()
    from prism_lca.engine import parameter_groups

    names = {g["id"]: g["name"] for g in parameter_groups.list_groups(database)}
    usage = formula_usage(database) if with_usage else {}
    param_usage = parameter_usage(database) if with_usage else {}
    out = []
    for p in DatabaseParameter.select().where(DatabaseParameter.database == database):
        d = p.data or {}
        gid = d.get("group_id")
        out.append(
            {
                "name": p.name,
                "amount": p.amount,
                "formula": p.formula,
                "group_id": gid if gid in names else None,  # drop dangling refs
                "group": names.get(gid),  # resolved name for display
                "description": d.get("description"),
                "unit": d.get("unit"),
                # What this parameter's value is allowed to be — `{}` when nothing was set. The page needs
                # it to refuse a value before it is written, and to draw a list rule as chips.
                "rule": d.get("rule") or {},
                # And the same rule as the sentence a refusal uses, for whoever reads rather than parses:
                # the assistant is handed this list before it writes a value, and a phrase it can quote
                # back to the user beats a dict it has to interpret. Absent when there is no rule.
                **({"allowed": param_rules.describe(d["rule"])} if d.get("rule") else {}),
                # `used_by` stays what it has always been — the exchanges — so nothing reading it
                # has to change. The parameters that depend on this one ride alongside, and the
                # count is the total: a parameter used only by another parameter is not unused,
                # and "unused" is what the count is read as.
                **(
                    {
                        "used_by": usage.get(p.name, []),
                        "used_by_parameters": param_usage.get(p.name, []),
                        "used_by_count": len(usage.get(p.name, [])) + len(param_usage.get(p.name, [])),
                    }
                    if with_usage
                    else {}
                ),
            }
        )
    return out


def snapshot(database: str, name: str) -> dict | None:
    p = _get_row(database, name)
    if p is None:
        return None
    return {"database": database, "name": p.name, "amount": p.amount,
            "formula": p.formula, "data": dict(p.data or {})}


def set_is_noop(
    before: dict,
    amount: float | None,
    formula: str | None,
    group_id: str | None,
    description: str | None,
    unit: str | None,
    *,
    group: str | None = None,
    rule: dict | None = None,
) -> bool:
    """Would :func:`set_param` with these arguments leave the parameter as `before` describes it?

    Only the fields the call names are compared — None means "leave it", like set_param reads it. A
    formula of "" is an instruction (make this a plain value) and counts as a change while a formula
    exists; a group NAME is resolved by set_param and is treated as a change whenever it is given."""
    if group is not None or rule is not None:
        return False
    data = before.get("data") or {}
    if amount is not None and (before.get("amount") is None or abs(float(before["amount"]) - float(amount)) > 0):
        return False
    if formula is not None and (formula or None) != (before.get("formula") or None):
        return False
    if group_id is not None and group_id != (data.get("group_id") or None):
        return False
    if description is not None and description != (data.get("description") or ""):
        return False
    if unit is not None and unit != (data.get("unit") or ""):
        return False
    return True


def set_param(
    database: str,
    name: str,
    amount: float | None = None,
    formula: str | None = None,
    group_id: str | None = None,
    description: str | None = None,
    unit: str | None = None,
    group: str | None = None,  # legacy convenience: a group NAME, resolved/created to a group_id
    #: What the value is allowed to be — see engine/param_rules.py. `{}` removes the rule; None leaves
    #: whatever the parameter already carries.
    rule: dict | None = None,
) -> list[dict]:
    DatabaseParameter, parameters = _DB()
    _require_database(database)
    name = (name or "").strip()
    if not name:
        raise PrismError("Parameter name must not be empty.", code="invalid_name",
                         hint="Provide a non-empty parameter name.")
    # A group may be given by id (from the UI) or by name (assistant/legacy) — resolve to an id.
    if group_id is None and group:
        from prism_lca.engine import parameter_groups

        group_id = parameter_groups.find_or_create(database, group)["id"]
    existing = _get_row(database, name)
    prior = dict(existing.data) if (existing and existing.data) else {}
    # The rule this write has to satisfy: the one being set now, or the one already on the parameter.
    effective_rule = param_rules.check_rule(rule) if rule is not None else (prior.get("rule") or {})
    # A value typed (or sent by the assistant) is refused before anything is written. A formula's result
    # cannot be known yet — that check is below, after the recalculation.
    if amount is not None:
        param_rules.check_value(effective_rule, amount, name=name)
    # Setting a rule that the value already there breaks would leave a parameter that cannot be saved
    # again without changing two things at once, so it is refused with both numbers named.
    if rule is not None and amount is None and formula is None and existing is not None:
        param_rules.check_value(effective_rule, existing.amount, name=name)
    before = snapshot(database, name) if existing is not None else None
    entry: dict = {"name": name}
    # An EMPTY formula is an instruction — "make this a plain value" — and not an absent one: the
    # parameter editor clears the field and sends "", and carrying the old formula over anyway
    # left the parameter formula-driven.
    clear_formula = formula == ""
    if formula:
        entry["formula"] = formula
    if amount is not None:
        entry["amount"] = amount
    if not existing and amount is None and not formula:
        entry["amount"] = 0.0
    # Metadata-only update of an EXISTING parameter (e.g. just unit/description): bw2data's
    # new_database_parameters reformat would otherwise reset amount to 0 and drop the formula —
    # and recalc_all() would propagate the wiped value into every dependent exchange.
    if existing:
        if "amount" not in entry and existing.amount is not None:
            entry["amount"] = existing.amount
        if "formula" not in entry and existing.formula and not clear_formula:
            entry["formula"] = existing.formula
    try:
        parameters.new_database_parameters([entry], database, overwrite=True)
        # new_database_parameters does not persist extra metadata -> set it on the row directly.
        data = dict(prior)
        data.pop("group", None)  # legacy free-text label — superseded by group_id
        if group_id is not None:
            if group_id == "":
                data.pop("group_id", None)  # explicit un-assign
            else:
                data["group_id"] = group_id
        for k, v in (("description", description), ("unit", unit)):
            if v is not None:
                data[k] = v
        if rule is not None:
            if effective_rule:
                data["rule"] = effective_rule
            else:
                data.pop("rule", None)
        pp = _get_row(database, name)
        pp.data = data
        pp.save()
        recalc_database(database)
    except PrismError:
        raise
    except Exception as e:  # noqa: BLE001
        raise PrismError(
            f"Parameter update failed: {str(e).strip() or 'the formula could not be evaluated'}",
            code="param_error",
            hint="Check the formula: only known parameter names, no circular references.",
        ) from e
    # What a formula computed can only be checked once it has been computed. A violation is undone rather
    # than merely reported: leaving it in place would mean a parameter that breaks its own rule, and every
    # exchange that reads it would already carry the number.
    if effective_rule:
        row = _get_row(database, name)
        why = param_rules.violates(effective_rule, row.amount if row else None)
        if why is not None:
            if before is not None:
                restore(before)
            else:
                delete_param(database, name)
            raise PrismError(
                f"The formula computes {row.amount:g} for '{name}', which {why}.",
                code="param_value_refused",
                hint=f"The rule on this parameter says the value must be {param_rules.describe(effective_rule)}.",
            )
    return list_params(database)


def set_params_bulk(database: str, items: list[dict]) -> list[dict]:
    """Write many parameters as **one** transaction and **one** recalculation.

    Why this exists rather than a loop over :func:`set_param`. Every single write recalculates the
    whole model's formulas and holds the LCA lock while it does — seconds on a real study, by the
    measurement in ``api/v1/params.py``. The assistant's parameter tool fans a batch out to one
    HTTP call per item and runs them concurrently, which does not help at all: they queue on that
    one lock and each pays the full recalculation. Measured on a balcony-solar study:
    22 parameters, 183.9 s of tool time, audit timestamps 8.5–13.0 s apart in a strict line, while
    every other local tool in that run answered in 1–5 s (V228).

    It also fixes the batch's other defect for free. ``new_database_parameters`` takes the whole
    list and resolves the group together, so a formula may name a parameter created in the same
    call. One at a time, it cannot: three of those 22 items failed with "variables aren't defined"
    naming parameters that were being defined two rows below, which reads like a typo and is an
    ordering problem (V232).

    Items carry the same fields as :func:`set_param`. Rules are enforced exactly as they are there —
    a typed value before the write, a computed one after — except that a violation rolls back
    **only its own parameter**, because the rest of the batch is unrelated and already correct.
    """
    DatabaseParameter, parameters = _DB()
    _require_database(database)
    if not items:
        return list_params(database)

    from prism_lca.engine import parameter_groups

    prepared: list[dict] = []
    for item in items:
        name = (item.get("name") or "").strip()
        if not name:
            raise PrismError("Parameter name must not be empty.", code="invalid_name",
                             hint="Provide a non-empty parameter name.")
        group_id = item.get("group_id")
        if group_id is None and item.get("group"):
            group_id = parameter_groups.find_or_create(database, item["group"])["id"]
        existing = _get_row(database, name)
        prior = dict(existing.data) if (existing and existing.data) else {}
        rule = item.get("rule")
        effective_rule = param_rules.check_rule(rule) if rule is not None else (prior.get("rule") or {})
        amount, formula = item.get("amount"), item.get("formula")
        if amount is not None:
            param_rules.check_value(effective_rule, amount, name=name)
        if rule is not None and amount is None and formula is None and existing is not None:
            param_rules.check_value(effective_rule, existing.amount, name=name)

        entry: dict = {"name": name}
        if formula is not None:
            entry["formula"] = formula
        if amount is not None:
            entry["amount"] = amount
        if not existing and amount is None and formula is None:
            entry["amount"] = 0.0
        # Same guard as set_param: a metadata-only update must not let bw2data reset the amount to
        # 0 and drop the formula, because recalc_all() would then push the wiped value everywhere.
        if existing:
            if "amount" not in entry and existing.amount is not None:
                entry["amount"] = existing.amount
            if "formula" not in entry and existing.formula:
                entry["formula"] = existing.formula

        data = dict(prior)
        data.pop("group", None)  # legacy free-text label — superseded by group_id
        if group_id is not None:
            if group_id == "":
                data.pop("group_id", None)
            else:
                data["group_id"] = group_id
        for key, value in (("description", item.get("description")), ("unit", item.get("unit"))):
            if value is not None:
                data[key] = value
        if rule is not None:
            if effective_rule:
                data["rule"] = effective_rule
            else:
                data.pop("rule", None)
        prepared.append(
            {
                "name": name,
                "entry": entry,
                "data": data,
                "rule": effective_rule,
                "before": snapshot(database, name) if existing is not None else None,
            }
        )

    # A name twice in one call would make the outcome depend on dict ordering inside bw2data.
    seen = [p["name"] for p in prepared]
    if len(set(seen)) != len(seen):
        dupes = sorted({n for n in seen if seen.count(n) > 1})
        raise PrismError(
            f"The same parameter appears more than once in this call: {', '.join(dupes)}.",
            code="duplicate_parameter",
            hint="Send each parameter once; the last value would silently win otherwise.",
        )

    try:
        parameters.new_database_parameters([p["entry"] for p in prepared], database, overwrite=True)
        for p in prepared:
            row = _get_row(database, p["name"])
            row.data = p["data"]
            row.save()
        recalc_database(database)
    except PrismError:
        raise
    except Exception as e:  # noqa: BLE001
        raise PrismError(
            f"Parameter update failed: {str(e).strip() or 'the formula could not be evaluated'}",
            code="param_error",
            hint="Check the formulas: only known parameter names, no circular references. Names "
            "defined in this same call are allowed to refer to each other.",
        ) from e

    # The rules can only be checked after the batch is written and evaluated (a formula's value is
    # not known before). A violation therefore rolls the WHOLE batch back, not the one row: the call
    # is one command, and "refused" has to mean nothing of it stayed — the first version put one
    # parameter back and left the others standing, unchecked.
    refused: list[tuple[dict, float | None, str]] = []
    for p in prepared:
        if not p["rule"]:
            continue
        row = _get_row(database, p["name"])
        why = param_rules.violates(p["rule"], row.amount if row else None)
        if why is not None:
            refused.append((p, row.amount if row else None, why))
    if refused:
        for p in prepared:
            if p["before"] is None:
                delete_param(database, p["name"], recalc=False)
        restore_many([p["before"] for p in prepared if p["before"] is not None])
        if all(p["before"] is None for p in prepared):
            recalc_database(database)
        first, amount, why = refused[0]
        others = ", ".join(f"'{q['name']}'" for q, _a, _w in refused[1:])
        raise PrismError(
            f"The formula computes {amount:g} for '{first['name']}', which {why}."
            + (f" Also refused: {others}." if others else "")
            + " Nothing from this call was kept.",
            code="param_value_refused",
            hint=f"The rule on '{first['name']}' says the value must be "
            f"{param_rules.describe(first['rule'])}.",
        )
    return list_params(database)


def restore(snap: dict, recalc: bool = True) -> None:
    """Recreate a parameter from a snapshot (undo). The snapshot carries its own ``database``.

    ``recalc=False`` is for a caller putting several rows back: the formulas are evaluated once
    when all of them are in, not after each — a valid end state can pass through an invalid one."""
    DatabaseParameter, parameters = _DB()
    database = snap["database"]
    entry: dict = {"name": snap["name"]}
    if snap.get("formula") is not None:
        entry["formula"] = snap["formula"]
    if snap.get("amount") is not None:
        entry["amount"] = snap["amount"]
    parameters.new_database_parameters([entry], database, overwrite=True)
    pp = _get_row(database, snap["name"])
    pp.data = snap.get("data", {})
    pp.save()
    if recalc:
        recalc_database(database)


def restore_many(snaps: list[dict]) -> None:
    """Put several parameters back in ONE write, then recalculate once.

    bw2parameters validates the whole set's references on every write, so restoring the old states
    one at a time can trip over a cycle that exists only between an old state and a new one
    (a = 1, b = "a" going back from a = "b", b = 2: restoring b first makes a = "b", b = "a").
    Written together, the set is the valid one it was."""
    if not snaps:
        return
    DatabaseParameter, parameters = _DB()
    database = snaps[0]["database"]
    entries: list[dict] = []
    for snap in snaps:
        entry: dict = {"name": snap["name"]}
        if snap.get("formula") is not None:
            entry["formula"] = snap["formula"]
        if snap.get("amount") is not None:
            entry["amount"] = snap["amount"]
        entries.append(entry)
    parameters.new_database_parameters(entries, database, overwrite=True)
    for snap in snaps:
        pp = _get_row(database, snap["name"])
        pp.data = snap.get("data", {})
        pp.save()
    recalc_database(database)


def delete_param(database: str, name: str, recalc: bool = True) -> None:
    p = _get_row(database, name)
    if p is None:
        raise PrismError(f"Parameter '{name}' not found.", code="param_not_found",
                         status_code=404, hint="List parameters via GET /api/v1/params.")
    p.delete_instance()
    if not recalc:
        return
    try:
        recalc_database(database)
    except Exception as exc:  # noqa: BLE001
        _log.swallowed(exc, "delete_param")


def group_of(database: str, name: str) -> str | None:
    """The group_id a parameter currently belongs to (None if unassigned/missing)."""
    p = _get_row(database, name)
    return (p.data or {}).get("group_id") if p else None


def set_group(database: str, name: str, group_id: str | None) -> None:
    """Assign a parameter to a group (or un-assign with group_id None/empty). Metadata only — no
    formula recalculation needed, so this does NOT touch amounts or the LCA cache."""
    p = _get_row(database, name)
    if p is None:
        raise PrismError(f"Parameter '{name}' not found.", code="param_not_found", status_code=404)
    data = dict(p.data or {})
    data.pop("group", None)  # legacy label
    if group_id:
        data["group_id"] = group_id
    else:
        data.pop("group_id", None)
    p.data = data
    p.save()


def clear_group(database: str, group_id: str) -> list[str]:
    """Un-assign every parameter of one model from a group (used when the group is deleted).
    Returns the names that were assigned, so the deletion can be undone."""
    DatabaseParameter, _parameters = _DB()
    affected: list[str] = []
    for p in DatabaseParameter.select().where(DatabaseParameter.database == database):
        d = p.data or {}
        if d.get("group_id") == group_id:
            affected.append(p.name)
            nd = dict(d)
            nd.pop("group_id", None)
            p.data = nd
            p.save()
    return affected


# --------------------------------------------------------------------------- #
# Model lifecycle: parameters travel with the model (duplicate / rename / delete)
# --------------------------------------------------------------------------- #
def copy_params(src: str, dst: str, group_id_map: dict[str, str] | None = None) -> None:
    """Copy every parameter of model ``src`` into model ``dst`` (used when a model is duplicated).
    Names, amounts, formulas and metadata (group_id/description/unit) are copied verbatim, so the
    copy's exchange formulas resolve against the copy's own parameters. ``group_id_map`` remaps each
    parameter's ``group_id`` onto the copied groups' fresh ids."""
    DatabaseParameter, parameters = _DB()
    gmap = group_id_map or {}
    rows = list(DatabaseParameter.select().where(DatabaseParameter.database == src))
    if not rows:
        return
    entries = []
    metas: dict[str, dict] = {}
    for p in rows:
        e: dict = {"name": p.name}
        if p.formula:
            e["formula"] = p.formula
        if p.amount is not None:
            e["amount"] = p.amount
        entries.append(e)
        data = dict(p.data or {})
        gid = data.get("group_id")
        if gid:
            data["group_id"] = gmap.get(gid, gid)
        metas[p.name] = data
    parameters.new_database_parameters(entries, dst, overwrite=True)
    for name, data in metas.items():
        pp = _get_row(dst, name)
        if pp is not None:
            pp.data = data
            pp.save()


def dump_params(database: str) -> list[dict]:
    """Full snapshot of a model's parameters (name/amount/formula/data). Used to carry them across
    a bw2data ``Database.rename``, which deregisters the old database and thereby DELETES its
    DatabaseParameter rows before any re-key could run."""
    DatabaseParameter, _parameters = _DB()
    return [
        {"name": p.name, "amount": p.amount, "formula": p.formula, "data": dict(p.data or {})}
        for p in DatabaseParameter.select().where(DatabaseParameter.database == database)
    ]


def load_params(database: str, dump: list[dict]) -> None:
    """Recreate parameters from :func:`dump_params` under ``database`` (after a rename)."""
    if not dump:
        return
    DatabaseParameter, parameters = _DB()
    entries = []
    for d in dump:
        e: dict = {"name": d["name"]}
        if d.get("formula"):
            e["formula"] = d["formula"]
        if d.get("amount") is not None:
            e["amount"] = d["amount"]
        entries.append(e)
    parameters.new_database_parameters(entries, database, overwrite=True)
    for d in dump:
        pp = _get_row(database, d["name"])
        if pp is not None:
            pp.data = d.get("data", {})
            pp.save()


def reregister_database_groups(database: str) -> None:
    """Re-register the formula-bearing exchanges of every activity in a model into their parameter
    groups, then recalculate. A bw2data ``Database.rename`` drops the old ActivityParameter groups,
    so without this the renamed model's formulas would keep static amounts."""
    bd = get_bd()
    for act in bd.Database(database):
        try:
            if any(ex.get("formula") for ex in act.exchanges()):
                register_activity_group(act)
        except Exception as exc:  # noqa: BLE001 - a bad/legacy activity must not block the rename
            _log.swallowed(exc, "reregister_database_groups")
    recalc_database(database)


def rename_database(old: str, new: str) -> None:
    """Re-key any parameters still filed under the old model name. bw2data's ``Database.rename``
    already deletes them (it deregisters the old database), so this is a best-effort safety net —
    the real move is done by dump_params(old) before the rename + load_params(new) after."""
    DatabaseParameter, _parameters = _DB()
    DatabaseParameter.update(database=new).where(DatabaseParameter.database == old).execute()


def remove_database(database: str) -> None:
    """Drop all parameters belonging to a deleted model, plus its now-empty parameter ``Group``.

    bw2data names a DatabaseParameter group after its database; dropping only the parameter rows
    would leave that group behind as an orphan that later crashes ``parameters.recalculate()``
    (see ``_purge_orphan_groups``)."""
    DatabaseParameter, _parameters = _DB()
    DatabaseParameter.delete().where(DatabaseParameter.database == database).execute()
    _purge_orphan_groups()


def _require_database(database: str) -> None:
    bd = get_bd()
    if not database or database not in bd.databases:
        raise PrismError(
            f"Model '{database}' does not exist.", code="database_not_found", status_code=404,
            hint="Parameters are model-scoped — open or create a model first.",
        )


def _foreground_databases() -> list[str]:
    from prism_lca.engine.guardrails import is_read_only

    bd = get_bd()
    return [n for n in bd.databases if not is_read_only(n)]


def migrate_project_to_models() -> bool:
    """One-time migration from the old project-global scope to per-model scope.

    Copies every legacy ``ProjectParameter`` (and the legacy flat parameter-groups and scenarios)
    into EVERY foreground model as model-scoped copies, then deletes the project-global originals.
    Guarded by a marker file so it runs once — written only when something WAS migrated. A project
    with nothing legacy in it gets no file: the check is a few row counts, and a marker on every fresh
    installation would be a permanent trace of a migration that never concerned it. If no foreground
    model exists yet, it is a no-op and runs again once one does. Returns True if it actually migrated."""
    import json
    from pathlib import Path

    bd = get_bd()
    marker = Path(bd.projects.dir) / "prism_meta" / "param_scope_migrated.json"
    if marker.exists():
        return False

    ProjectParameter, _AP, _G, _params = _P()
    legacy_params = list(ProjectParameter.select())
    from prism_lca.engine import parameter_groups
    from prism_lca.engine.scenarios import ScenarioStore

    legacy_groups = parameter_groups._legacy_flat()  # untagged {id,name,order} entries
    legacy_scenarios = ScenarioStore()._legacy_untagged()  # untagged scenario entries
    if not legacy_params and not legacy_groups and not legacy_scenarios:
        return False  # nothing legacy here — and no marker to say so (see docstring)

    targets = _foreground_databases()
    if not targets:
        return False  # no model yet — leave legacy data untouched, retry later

    # Back up the raw stores before we mutate them (bw2data deletes are irreversible).
    _backup_pre_scope()

    DatabaseParameter, parameters = _DB()
    for db in targets:
        # Groups: fresh id per model, remap parameter group_id refs onto the new ids.
        id_map: dict[str, str] = {}
        for g in sorted(legacy_groups, key=lambda x: x.get("order", 0)):
            id_map[g["id"]] = parameter_groups.create(db, g["name"])["id"]
        # Parameters.
        entries = []
        metas: dict[str, dict] = {}
        for p in legacy_params:
            e: dict = {"name": p.name}
            if p.formula:
                e["formula"] = p.formula
            if p.amount is not None:
                e["amount"] = p.amount
            entries.append(e)
            data = dict(p.data or {})
            label = data.pop("group", None)  # legacy free-text label
            gid = data.get("group_id")
            if gid and gid in id_map:
                data["group_id"] = id_map[gid]
            elif label:  # resolve a free-text label to a (new) group in this model
                data["group_id"] = parameter_groups.find_or_create(db, str(label))["id"]
            metas[p.name] = data
        if entries:
            parameters.new_database_parameters(entries, db, overwrite=True)
            for name, data in metas.items():
                pp = _get_row(db, name)
                if pp is not None:
                    pp.data = data
                    pp.save()
        # Scenarios.
        store = ScenarioStore()
        for s in legacy_scenarios:
            store.create(db, s.get("name", "Scenario"), s.get("description", ""), s.get("overrides", {}))

    # Drop the project-global originals now that every model has its copy.
    for p in legacy_params:
        p.delete_instance()
    parameter_groups._drop_legacy_flat()
    ScenarioStore()._drop_legacy_untagged()

    try:
        recalc_all()
    except Exception as exc:  # noqa: BLE001 - never let a migration recalc break startup
        _log.swallowed(exc, "migrate_project_to_models")

    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"migrated": True, "models": targets}), encoding="utf-8")
    return True


def _backup_pre_scope() -> None:
    import shutil
    from pathlib import Path

    bd = get_bd()
    dest = Path(bd.projects.dir) / "prism_meta" / "backup_pre_scope"
    dest.mkdir(parents=True, exist_ok=True)
    meta = Path(bd.projects.dir) / "prism_meta"
    for fname in ("parameter_groups.json", "scenarios.json"):
        src = meta / fname
        if src.exists():
            shutil.copy2(src, dest / fname)
    # The bw2data parameters live in the project's SQLite file.
    for db_file in Path(bd.projects.dir).glob("*.db"):
        try:
            shutil.copy2(db_file, dest / db_file.name)
        except Exception as exc:  # noqa: BLE001 - best-effort backup
            _log.swallowed(exc, "_backup_pre_scope")


def recalc_activity_group(database: str, code: str) -> None:
    """Re-evaluate the parameterised exchanges of ONE activity from the current parameter values.

    For the writes that touch an exchange without touching a parameter (uncertainty, restore) and must
    not leave a formula-driven amount overwritten. Nothing else in the model can have changed, so the
    model's groups are left alone."""
    _PP, ActivityParameter, _G, _parameters = _P()
    try:
        ActivityParameter.recalculate_exchanges(_group_name(database, code))
    except Exception as exc:  # noqa: BLE001 - an activity without a registered group has nothing to redo
        _log.swallowed(exc, "recalc_activity_group")


def register_activity_group(act) -> None:
    """(Re)register an activity's formula-bearing exchanges in its parameter group and
    recalculate them. Needed after exchange copies (duplicate / localize / model copy): the
    copied ``formula`` fields would otherwise be inert — recalc_all() only walks groups that
    already exist, and a fresh copy has none."""
    _PP, ActivityParameter, _G, parameters = _P()
    group = _group_name(act.key[0], act.key[1])
    try:
        parameters.add_exchanges_to_group(group, act)
        ActivityParameter.recalculate_exchanges(group)
    except Exception as exc:  # noqa: BLE001 - e.g. formula references a deleted parameter: keep the static copy
        _log.swallowed(exc, "register_activity_group")


def exchange_snapshot(database: str, code: str, uid: str) -> dict:
    act = model.get_activity(database, code)
    ex = model.find_exchange(act, uid)
    return {"formula": ex.get("formula"), "amount": ex.get("amount")}


def _apply_formula(act, ex, formula: str | None) -> None:
    if formula:
        ex["formula"] = formula
    else:
        for field in ("formula", "original_amount"):
            try:
                del ex[field]
            except Exception as exc:  # noqa: BLE001
                _log.swallowed(exc, "_apply_formula")
                if field == "formula":
                    ex["formula"] = None
        # Also drop the ParameterizedExchange mirror row: recalculate_exchanges() reads the
        # TABLE copy of the formula, so the doc field alone coming off would leave a ghost
        # that overwrites the amount again on every parameter recalculation.
        from bw2data.parameters import ParameterizedExchange

        ParameterizedExchange.delete().where(
            ParameterizedExchange.exchange == ex._document.id
        ).execute()
    ex.save()


def clear_exchange_formula(act, ex) -> None:
    """fx off / manual amount edit: detach the formula (doc field AND mirror row) so the
    exchange keeps whatever fixed amount the caller sets."""
    _apply_formula(act, ex, None)


def set_exchange_formula(database: str, code: str, uid: str, formula: str | None) -> dict:
    _PP, ActivityParameter, _G, parameters = _P()
    assert_writable(database)
    act = model.get_activity(database, code)
    ex = model.find_exchange(act, uid)
    before = {"formula": ex.get("formula"), "amount": ex.get("amount")}
    _apply_formula(act, ex, formula)
    group = _group_name(database, code)
    try:
        if formula:
            parameters.add_exchanges_to_group(group, act)
            ActivityParameter.recalculate_exchanges(group)
    except Exception as e:  # noqa: BLE001 - roll back the exchange on a bad formula
        _apply_formula(act, ex, before["formula"])
        ex["amount"] = before["amount"]
        ex.save()
        if before["formula"]:
            # Re-sync the mirror row: add_exchanges_to_group had already stored the BAD
            # formula in ParameterizedExchange before recalculation failed.
            try:
                parameters.add_exchanges_to_group(group, act)
            except Exception as exc:  # noqa: BLE001
                _log.swallowed(exc, "set_exchange_formula")
        raise PrismError(
            f"Formula error: {e}",
            code="formula_error",
            hint="Use valid parameter names; avoid circular references.",
        ) from e
    if formula:
        # `recalculate_exchanges` wrote the evaluated amount to the database, but `ex` is the copy
        # read before that ran — returning it reports whatever the exchange held on the way IN. On a
        # freshly added exchange that is the 0 placeholder, so a perfectly good formula answered
        # "amount": 0 while the stored quantity was right. An assistant that checks its own writes
        # reads that as a silent failure and does the work again; one that does not, believes it.
        ex = model.find_exchange(model.get_activity(database, code), uid)
    info = model.exchange_info(ex)
    if formula:
        info["dimension_check"] = _dimension_check(database, formula, info)
    return info


def _dimension_check(database: str, formula: str, info: dict) -> dict:
    """The units of everything the formula touches, next to the unit the result has to be in.

    Not a checker — the parameter unit is a free-text label ("Kd", "W/m2K"), so there is nothing to
    verify against. What it removes is the round trip: to sanity-check a formula the caller previously
    had to fetch `list_parameters`, find each name, and hold the target unit from somewhere else. Both
    halves are now in the answer that reports the formula, which is where the question comes up.

    The reason it is worth the lines: in an earlier modelling session the use phase — 92 % of the whole
    result — hung on `uw * window_area * hdd * 24 * lifetime_years * 3.6 / 1000`, where the trailing
    `* 3.6 / 1000` converts kWh to the megajoules the input is billed in. That factor was derived by
    hand, unverifiable from the response, and getting it wrong is a factor of 3.6 on the headline.
    """
    used: dict[str, str] = {}
    try:
        referenced = set(_IDENT_RE.findall(formula or ""))
        for p in list_params(database):
            name = str(p.get("name") or "")
            if name in referenced:
                used[name] = str(p.get("unit") or "") or "(no unit recorded)"
    except Exception as exc:  # noqa: BLE001 - a missing unit must never fail the write that already happened
        _log.swallowed(exc, "_dimension_check")
        return {"note": "Could not read the parameter units for this formula."}
    target = (info.get("input") or {}).get("unit") or "(unknown)"
    return {
        "amount_must_be_in": target,
        "parameter_units": used,
        "note": (
            f"The amount is in {target}, per 1 unit of this process's reference product. "
            "Units are labels, not checked — confirm the expression above actually yields "
            f"{target} (a stray kWh/MJ or g/kg factor is a factor of 3.6 or 1000), and record the "
            "conversion in the exchange comment."
        ),
    }


def restore_exchange_formula(database: str, code: str, uid: str, snap: dict) -> None:
    _PP, ActivityParameter, _G, parameters = _P()
    act = model.get_activity(database, code)
    ex = model.find_exchange(act, uid)
    _apply_formula(act, ex, snap.get("formula"))
    ex["amount"] = snap.get("amount")
    ex.save()
    try:
        if snap.get("formula"):
            parameters.add_exchanges_to_group(_group_name(database, code), act)
            ActivityParameter.recalculate_exchanges(_group_name(database, code))
    except Exception as exc:  # noqa: BLE001
        _log.swallowed(exc, "restore_exchange_formula")


#: Identifiers in a formula, so the answer can say which parameters it actually leaned on.
_IDENT_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")


def evaluate_formula(
    database: str,
    formula: str,
    overrides: dict[str, float] | None = None,
) -> dict:
    """Work out what a formula would come to, without touching the model.

    Building a parameterised exchange used to be a one-way step: write the expression, store it,
    recalculate, and only then see the number. The safe move was therefore to compute it by hand
    first and check afterwards — exactly the hand-arithmetic the parameters exist to remove. This
    answers "what would this be worth?" before anything is written, using the same parameter values
    the engine would.

    ``overrides`` replaces individual parameter values for this evaluation only — nothing is saved —
    which is what a what-if question needs: "and if the distance were 20 km?".

    A name the formula uses but the model does not define is reported as such: a mistyped parameter
    is the common case, and being told which name is unknown beats a stack trace.
    """
    from asteval import Interpreter

    values: dict[str, float] = {}
    for p in list_params(database):
        amount = p.get("amount")
        if isinstance(amount, (int, float)):
            values[str(p["name"])] = float(amount)

    unknown_overrides = sorted(set(overrides or {}) - set(values))
    values.update({k: float(v) for k, v in (overrides or {}).items()})

    text = formula or ""
    referenced = set(_IDENT_RE.findall(text))
    interp = Interpreter(usersyms=dict(values), minimal=True)

    # Checked before evaluating: asteval reports an undefined name as a generic error, and the one
    # thing worth saying is WHICH name it was. Anything the interpreter already knows (min, max, abs,
    # the maths functions) is not a missing parameter — and neither is syntax: `p if p > 0 else 0`
    # used to be refused with "define 'if' and 'else' as parameters first".
    missing = sorted(n for n in referenced if n not in interp.symtable and not keyword.iskeyword(n))
    if missing:
        raise PrismError(
            f"Unknown name(s) in the formula: {', '.join(missing)}.",
            code="formula_error",
            hint="Define them as parameters first, or check the spelling against list_parameters.",
        )

    value = interp(text)
    errors = [err.get_error()[1] for err in getattr(interp, "error", [])]
    if errors:
        raise PrismError(
            f"Formula error: {errors[0]}",
            code="formula_error",
            hint="Use valid parameter names and operators.",
        )
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise PrismError(
            f"The formula did not produce a number (got {type(value).__name__}).",
            code="formula_error",
            hint="A formula must evaluate to a single numeric value.",
        )

    used = {n: values[n] for n in sorted(referenced & set(values))}
    out = {
        "formula": text,
        "value": float(value),
        "used": used,
        "overrides_applied": {k: float(v) for k, v in (overrides or {}).items()},
    }
    if unknown_overrides:
        # Overriding a name the model does not have is almost always a typo, and silently ignoring
        # it would make the answer look authoritative while it answered a different question.
        out["unknown_overrides"] = unknown_overrides
    return out
