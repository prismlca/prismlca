"""Why a compared scenario moved the result so little: what its overrides reach, and how much that is.

A row of a scenario comparison whose Δ stays below :data:`SMALL_DELTA_PCT` carries a note. Most of the
time the reason is the ordinary one — the override drives an exchange that is a small part of the result —
and the note says that first: the exchange, the chain of parameters it is reached through, and its share of
the baseline result for that indicator. A request to bind a quantity comes only with evidence for it: the
overrides reach no exchange at all, or an exchange carries, as a typed constant, the value of a parameter
the overrides move.

Why the order matters: a conditional "if it is still a typed constant, bind it" beside every small Δ, with
no chain named, reads as a finding against a correctly bound model. Models took it that way several times in
one run and went looking for a fault that was not there.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from functools import cached_property
from typing import Any

from prism_lca import _log
from prism_lca.engine import lca, method_lookup, param_references, params
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.model import get_activity

#: Fewer runs than this and an activity counts as outside the scored activity's supply chain.
_NOWHERE = 1e-12

#: Below this relative change a scenario row carries a note naming what its overrides reach.
#: One run created its scenarios on parameters that were still typed as constants on the
#: exchanges, compared them, read −0.1 % / +0.2 %, spent 187 s on a 16-indicator comparison of the same
#: dead variants — and only the model's own doubt caught it. Nothing said a word (V332).
SMALL_DELTA_PCT = 1.0

#: Below this summed share of the baseline result, the reached exchanges are called a small lever and a
#: small Δ the expected outcome. Above it the note states the shares and draws no conclusion.
SMALL_LEVER_PCT = 10.0

#: How many reached exchanges a note names before it counts the rest.
SHOWN = 4


@dataclass(frozen=True)
class _Exchange:
    key: str  # the exchange's uid; a positional stand-in when it has none
    activity_id: int
    activity_code: str
    activity_name: str
    kind: str  # production | technosphere | substitution | biosphere
    input_key: tuple[str, str]
    amount: float
    proxy: Any = field(compare=False, repr=False)  # the bw2data exchange, for its input

    @cached_property
    def input(self) -> tuple[int | None, str]:
        """``(node id, name)`` of what the exchange brings in — read when a note or a share needs it."""
        try:
            node = self.proxy.input
            return node.id, str(node.get("name") or node.get("code"))
        except Exception:  # noqa: BLE001 - an input the database no longer has: no share, its key as name
            return None, str(self.input_key[-1])

    @property
    def where(self) -> str:
        """The exchange as a note names it."""
        if self.kind == "production":
            return f"the production amount of '{self.activity_name}'"
        return f"'{self.input[1]}' in '{self.activity_name}'"


@dataclass(frozen=True)
class _Path:
    exchange: _Exchange
    via: tuple[str, ...]  # the parameters between the override and the exchange's formula


class Reach:
    """One comparison's explainer: the model is read once, the baseline shares once per indicator
    (:meth:`capture`, while the comparison has the baseline in the matrices), each note when a row asks."""

    def __init__(self, database: str, code: str, amount: float = 1.0) -> None:
        self.database = database
        self.code = code
        self.amount = amount
        self._model: tuple[dict[str, list[_Exchange]], list[_Exchange]] | None = None
        self._feeds: dict[str, list[str]] | None = None
        self._edges: dict[str, set[str]] = {}  # foreground activity code → the foreground codes it consumes
        self._downstream: dict[str, set[str]] = {}
        self._values: dict[str, float] | None = None
        self._shares: dict[tuple, dict[str, tuple[float, float]] | None] = {}

    # -- the model, read once ------------------------------------------------------------------------- #

    def _exchanges(self) -> tuple[dict[str, list[_Exchange]], list[_Exchange]]:
        """``(parameter name → exchanges whose formula names it, exchanges typed as a plain number)``."""
        if self._model is None:
            on_exchanges: dict[str, list[_Exchange]] = {}
            typed: list[_Exchange] = []
            for act in get_bd().Database(self.database):
                code = str(act.get("code"))
                for i, ex in enumerate(act.exchanges()):
                    kind = ex.get("type")
                    # Production too: a formula on the reference amount is a binding like any other, and the
                    # recalculation applies it.
                    if kind not in ("production", "technosphere", "substitution", "biosphere"):
                        continue
                    try:
                        amount = float(ex.get("amount") or 0.0)
                        input_key = (str(ex["input"][0]), str(ex["input"][1]))
                    except (TypeError, ValueError, KeyError, IndexError):
                        continue
                    if kind in ("technosphere", "substitution") and input_key[0] == self.database:
                        self._edges.setdefault(code, set()).add(input_key[1])
                    formula = ex.get("formula") or None
                    item = _Exchange(
                        key=str(ex.get("prism_uid") or f"{code}#{i}"),
                        activity_id=act.id,
                        activity_code=code,
                        activity_name=str(act.get("name") or code),
                        kind=kind,
                        input_key=input_key,
                        amount=amount,
                        proxy=ex,
                    )
                    if formula:
                        for token in param_references.all_names_in(formula):
                            on_exchanges.setdefault(token, []).append(item)
                    else:
                        typed.append(item)
            self._model = (on_exchanges, typed)
        return self._model

    def _paths(self, overrides: dict) -> tuple[list[_Path], list[str], set[str]]:
        """``(reached exchanges with their chain, override names that reach none, every parameter moved)``.

        Breadth first from each override, so the chain named is the shortest, through the formulas as they
        stand while the scenario is applied: an override replaces its parameter's own formula, so a number
        cuts the parameter off from what fed it, and a formula override is fed by the names it reads.
        """
        on_exchanges, _typed = self._exchanges()
        if self._feeds is None:
            self._feeds = {k: [d["name"] for d in v] for k, v in params.parameter_usage(self.database).items()}
        feeds = {k: [d for d in v if d not in overrides] for k, v in self._feeds.items()}
        for name, value in (overrides or {}).items():
            if isinstance(value, str):
                for token in param_references.all_names_in(value):
                    if token != name:
                        feeds.setdefault(token, []).append(name)
        names = sorted(overrides or {})
        reached: dict[str, _Path] = {}
        dead: list[str] = []
        moved: set[str] = set()
        for name in names:
            seen = {name}
            queue: deque[tuple[str, tuple[str, ...]]] = deque([(name, ())])
            found = False
            while queue:
                current, via = queue.popleft()
                for ex in on_exchanges.get(current, ()):
                    found = True
                    reached.setdefault(ex.key, _Path(ex, via))
                for nxt in feeds.get(current, ()):
                    if nxt in seen:
                        continue
                    seen.add(nxt)
                    queue.append((nxt, (*via, nxt)))
            moved |= seen
            if not found:
                dead.append(name)
        return list(reached.values()), dead, moved

    def _typed_matches(self, moved: set[str]) -> list[tuple[_Exchange, str]]:
        """Typed constants equal to the baseline value of a parameter the overrides move — the quantity
        somebody meant to bind and did not. The same test as the health check's
        ``constant_matches_parameter`` (0 and ±1 are skipped, they match every count-like parameter), on the
        inputs only: an emission or a reference amount that happens to equal a moved share or rate is a
        coincidence far more often than a lever, and here it would be printed as a request to bind."""
        if self._values is None:
            self._values = params.snapshot_all(self.database)
        _on, typed = self._exchanges()
        out: list[tuple[_Exchange, str]] = []
        for ex in typed:
            if ex.kind not in ("technosphere", "substitution") or ex.amount == 0 or abs(ex.amount) == 1:
                continue
            same = sorted(
                n for n in moved
                if self._values.get(n) and abs(abs(self._values[n]) - abs(ex.amount)) <= abs(self._values[n]) * 1e-9
            )
            if same:
                out.append((ex, same[0]))
        return out

    def _on_cycle(self, ex: _Exchange) -> bool:
        """Whether the exchange's input leads back, through the model's own processes, to the process that
        consumes it. On such a loop, runs × amount × cumulative impact counts the feedback again on every
        pass — a process consuming 0.9 of its own output would show 900 % — so no share is given there."""
        if ex.kind not in ("technosphere", "substitution") or ex.input_key[0] != self.database:
            return False
        start = ex.input_key[1]
        if start not in self._downstream:
            seen = {start}
            queue = deque([start])
            while queue:
                for nxt in self._edges.get(queue.popleft(), ()):
                    if nxt not in seen:
                        seen.add(nxt)
                        queue.append(nxt)
            self._downstream[start] = seen
        return ex.activity_code in self._downstream[start]

    # -- the baseline shares, once per indicator ------------------------------------------------------ #

    def capture(self, method) -> None:
        """Read the baseline share of every exchange with a formula, for one indicator.

        The comparison calls this right after it scored the baseline for that indicator, while the baseline is
        the factorised system: read later, after the scenarios, the shares would cost a factorisation of their
        own — seconds on an ecoinvent background, where the transposed solve that answers it here takes
        hundredths. A failure is swallowed: the note then leaves the shares out rather than fail the comparison.
        """
        try:
            self._shares[tuple(method)] = self._solve(method)
        except Exception as exc:  # noqa: BLE001 - an explanatory figure must never fail the comparison
            _log.swallowed(exc, "scenario_reach.capture")
            self._shares[tuple(method)] = None

    def _solve(self, method) -> dict[str, tuple[float, float]] | None:
        """Exchange key → ``(share of the baseline result in percent, runs of the consuming activity)``.

        The contribution tree's reading (lca.contribution): runs of the consumer × the exchange's amount × the
        cumulative impact of one unit of its input. A substitution enters the matrix with the other sign.
        ``None`` for a zero result, where no share can be said."""
        import numpy as np

        on_exchanges, _typed = self._exchanges()
        bound = {ex.key: ex for group in on_exchanges.values() for ex in group}
        root = get_activity(self.database, self.code)
        m = method_lookup.resolve_method(method)
        with lca._LCA_LOCK:
            system = lca.get_lca({root.id: self.amount * lca._demand_sign(root)}, m)
            total = float(system.score)
            if not total or not bound:
                return None
            cf = np.asarray(system.characterization_matrix.sum(axis=0)).ravel()
            unit = lca._adjoint_unit_impacts(system, [(m, cf)])[:, 0]
            supply = system.supply_array
            columns, products, flows = system.dicts.activity, system.dicts.product, system.dicts.biosphere
            out: dict[str, tuple[float, float]] = {}
            for key, ex in bound.items():
                if ex.kind == "production" or self._on_cycle(ex):
                    continue  # no share to give: a reference amount scales everything, a loop counts twice
                col = columns.get(ex.activity_id)
                node, _name = ex.input
                if col is None or node is None:
                    continue
                if ex.kind == "biosphere":
                    row = flows.get(node)
                    per_unit = None if row is None else float(cf[row])
                else:
                    row = products.get(node)
                    per_unit = None if row is None else float(unit[row]) * (-1.0 if ex.kind == "substitution" else 1.0)
                if per_unit is not None:
                    runs = float(supply[col])
                    out[key] = (100.0 * runs * ex.amount * per_unit / total, runs)
            return out

    # -- the note ------------------------------------------------------------------------------------- #

    def note(self, method, overrides: dict) -> str:
        names = sorted(overrides or {})
        quoted = ", ".join(f"'{n}'" for n in names)
        reached, dead, moved = self._paths(overrides)
        if not reached:
            return (
                f"Δ below {SMALL_DELTA_PCT:g} % — no exchange formula references {quoted}, directly or through "
                "other parameters; this variant cannot move the result. Bind the quantity to the parameter "
                '(edit_exchange action="set_formula") and compare again, or drop the scenario.'
            )
        captured = self._shares.get(tuple(method))
        shares = [captured.get(p.exchange.key) if captured is not None else None for p in reached]
        live = [n for n in names if n not in dead]
        listed = "; ".join(self._label(p, s) for p, s in list(zip(reached, shares, strict=True))[:SHOWN])
        more = f"; and {len(reached) - SHOWN} more" if len(reached) > SHOWN else ""
        text = (
            f"Δ below {SMALL_DELTA_PCT:g} % — {', '.join(repr(n) for n in live)} "
            f"{'reaches' if len(live) == 1 else 'reach'} {len(reached)} "
            f"exchange{'' if len(reached) == 1 else 's'}: {listed}{more}."
        )
        if dead:
            text += f" {', '.join(repr(n) for n in dead)} {'reaches' if len(dead) == 1 else 'reach'} none."
        typed = self._typed_matches(moved)
        if typed:
            ex, name = typed[0]
            others = f" ({len(typed) - 1} more like it)" if len(typed) > 1 else ""
            return text + (
                f" But {ex.where} is typed as {ex.amount:g}, the value of "
                f"'{name}', and does not follow it{others}: if they are one quantity, bind it "
                '(edit_exchange action="set_formula") and compare again.'
            )
        if shares and all(s is not None for s in shares):
            if all(abs(runs) < _NOWHERE for _pct_, runs in shares):
                return text + (
                    " None of them is in the supply chain of the scored activity, so this variant cannot move "
                    "its result: score the activity that uses them, or link their process into it."
                )
            if sum(abs(pct) for pct, _runs in shares) < SMALL_LEVER_PCT:
                return text + " A small part of the result, so a small Δ is the expected outcome."
        return text

    @staticmethod
    def _label(path: _Path, share: tuple[float, float] | None) -> str:
        ex = path.exchange
        label = ex.where
        if path.via:
            label += f" through {' → '.join(path.via)}"
        if share is not None:
            label += f", {_pct(share[0])} of the baseline result"
        return label


def _pct(value: float) -> str:
    if value == 0:
        return "0 %"
    if abs(value) < 0.01:
        return "under 0.01 %"
    if abs(value) < 10:
        return f"{value:.2g} %"
    return f"{value:.0f} %"
