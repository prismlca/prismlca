"""The health check's double-count rules inside one activity: the same product supplied more than once.

Every per-exchange check reads one link on its own, and a link that is valid on its own can still count
twice. These rules read the inputs of one activity together, grouped by the product they deliver, and tell
four shapes apart:

* two different datasets deliver one product — the signature of a half-finished replacement, where the new
  dataset is added and the old one is never removed (``possible_double_count``, a warning);
* the same, but the amounts compose the reference product or every one carries a comment — a deliberate mix
  (``deliberate_mix``, an info);
* one dataset taken more than once — usually separate uses, two fractions to the same treatment
  (``duplicate_input``, an info);
* one dataset taken more than once with nothing that computes telling the exchanges apart — the same amount
  and no formula of their own — which is one input entered twice (``identical_duplicate_input``, a warning,
  also where the product comes from further datasets as well).

``health`` hands in an activity's resolved exchanges and turns the answers into findings.
"""
from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from prism_lca.engine.param_references import names_in

#: (severity, code, message, uid, extra fields of the finding)
Found = tuple[str, str, str, str | None, dict[str, Any]]


class _Resolved(Protocol):
    ex: Mapping[str, Any]
    key: tuple | None
    inp: Any


@dataclass(frozen=True)
class _Supply:
    key: tuple | None
    name: str
    location: str
    amount: float
    #: The parameters the exchange's formula reads; empty for a typed number or a formula that is only one.
    parameters: frozenset[str]
    uid: str | None
    commented: bool


def _parameters(formula: object) -> frozenset[str]:
    text = str(formula or "").strip()
    return names_in(text) if text else frozenset()


def _where(rows: list[_Supply]) -> str:
    return ", ".join(
        f"{r.name}{' [' + r.location + ']' if r.location else ''} = {r.amount:g}" for r in rows[:4]
    )


def _entered_twice(rows: list[_Supply]) -> list[list[_Supply]]:
    """The sets of exchanges from one dataset that nothing computing tells apart, each in exchange order.

    A different amount tells two exchanges apart. So do two formulas that read different parameters: two
    ingredients on one proxy dataset, `fill_mass * share_perfume` and `fill_mass * share_preservative`, can
    come to the same figure and are still two uses — a scenario on either share moves them apart. Nothing
    else counts. A comment does not: a model comments every exchange it writes, and an edit that added a
    second copy instead of changing the first rewrote the comment as often as it kept it. A formula that is
    only a number reads no parameter, so it tells nothing apart from the typed number it equals.

    Every member of a set is indistinguishable from every other one. That relation does not chain: a typed
    figure equal to both shares above matches each of them, but the two shares stay apart, so it makes two
    sets with one share each, never one set of three.
    """
    position = {id(r): i for i, r in enumerate(rows)}
    by_amount: list[list[_Supply]] = []
    for row in rows:
        same = next((c for c in by_amount if math.isclose(c[0].amount, row.amount, rel_tol=1e-9)), None)
        if same is None:
            by_amount.append([row])
        else:
            same.append(row)
    found: list[list[_Supply]] = []
    for equal in by_amount:
        typed = [r for r in equal if not r.parameters]
        formulas: dict[frozenset[str], list[_Supply]] = {}
        for r in equal:
            if r.parameters:
                formulas.setdefault(r.parameters, []).append(r)
        for members in [typed + f for f in formulas.values()] or [typed]:
            if len(members) > 1:
                found.append(sorted(members, key=lambda r: position[id(r)]))
    return sorted(found, key=lambda s: position[id(s[0])])


def _identical(product: str, rows: list[_Supply]) -> list[Found]:
    """A warning for every set of one dataset's exchanges that nothing tells apart."""
    # The same amount and no formula of their own is what an input entered twice looks like: a link added
    # again that was already there, an edit that added a copy instead of changing the original, a batch sent
    # twice. All copies count, and as an info it was read past while the result stood at twice and ten
    # times its value.
    out: list[Found] = []
    for twin in _entered_twice(rows):
        times = "twice" if len(twin) == 2 else f"{len(twin)} times"
        out.append(
            (
                "warning",
                "identical_duplicate_input",
                f"'{product}' is supplied by the same dataset {times} with the same amount ({_where(twin)}), "
                "and no formula tells them apart — the signature of one input entered twice. All of them "
                f"count, so the process takes {len(twin)} times what one entry says. If one is extra, delete "
                "it (their uids are under \"uids\"). If each is a separate use, they compute exactly like one "
                "exchange with the sum: merge them, or give each its own parameter.",
                twin[0].uid,
                {"uids": [r.uid for r in twin]},
            )
        )
    return out


def _one_dataset(product: str, same: list[_Supply]) -> list[Found]:
    identical = _identical(product, same)
    if identical:
        return identical
    # Two exchanges to the SAME provider compute exactly as one with their sum, and that has a perfectly
    # ordinary cause: two fractions taking the same route (corrugated board and pallet wood both to
    # municipal incineration). Reported as tidiness, not as a defect; calling it "counted twice" would train
    # people to ignore the far more dangerous cases. But the sum is only right when it is meant, so the
    # message must not promise a right result and talk the reader out of looking.
    return [
        (
            "info",
            "duplicate_input",
            f"'{product}' is supplied by the same dataset {len(same)} times ({_where(same)}). The "
            "amounts add up and all of them count: right for separate uses (two fractions to the same "
            "treatment), twice too much if one input was entered twice — then delete the extra one.",
            same[0].uid,
            {},
        )
    ]


def _several_datasets(product: str, unit: str, same: list[_Supply], ref_amount: float | None) -> Found:
    where = _where(same)
    # Different datasets delivering one product is the real risk: it is the signature of a half-finished
    # replacement, where the new dataset is added and the old one never removed. Nothing per-dataset can
    # see it, because each link is individually valid.
    #
    # But the same shape is also how a deliberate MIX looks — 33 % petrochemical glycerine and 67 % from
    # rape oil, in a process built to make that split testable. Two signals separate the two, both cheap
    # and deterministic:
    #
    #  1. the amounts add up to the reference product (0.33 + 0.67 = 1 kg), which is a composition and not
    #     a leftover; and
    #  2. every one of them carries a comment — which is exactly the remedy the old text asked for, and it
    #     asked without ever checking whether it had been done. A warning that survives its own fix is
    #     noise, and it fired on a correct model twice.
    identical = len({round(r.amount, 12) for r in same}) == 1
    total = sum(r.amount for r in same)
    composes = ref_amount not in (None, 0) and abs(total - float(ref_amount)) <= 1e-6 * max(
        1.0, abs(float(ref_amount))
    )
    in_unit = f" in {unit}" if unit else ""
    if composes or all(r.commented for r in same):
        return (
            "info",
            "deliberate_mix",
            f"{len(same)} datasets supply '{product}'{in_unit} ({where})"
            + (
                f" and their amounts add up to the reference product ({total:g}), so this reads as a "
                "deliberate mix rather than a half-finished replacement."
                if composes
                else ", each with a comment explaining it, so this reads as deliberate."
            )
            + " Nothing to do unless one of them was meant to replace another.",
            same[0].uid,
            {},
        )
    return (
        "warning",
        "possible_double_count",
        f"{len(same)} different datasets all supply '{product}'{in_unit} ({where})."
        + (
            " Their amounts are identical, which is what a replacement looks like when the old input was "
            "never removed."
            if identical
            else " If one was meant to replace another, the old one is still counted; if the split is "
            "deliberate, comment the exchanges and this becomes a note instead."
        ),
        same[0].uid,
        {},
    )


def same_product_twice(resolved: Iterable[_Resolved], production: Iterable[Mapping[str, Any]]) -> list[Found]:
    """The findings for one activity, from its resolved exchanges and its production exchanges.

    Grouped by the product rather than the dataset on purpose: the double count that happens most is a
    half-finished replacement, where two different datasets deliver the same product and every
    per-dataset check reads them as two unrelated, perfectly valid inputs.
    """
    by_product: dict[tuple[str, str], list[_Supply]] = {}
    for e in resolved:
        if e.inp is None or e.ex.get("type") != "technosphere":
            continue
        amount = e.ex.get("amount") or 0
        if not amount:
            continue
        product = (e.inp.get("reference product") or e.inp.get("name") or "").strip()
        if product:
            by_product.setdefault((product, e.inp.get("unit") or ""), []).append(
                _Supply(
                    key=e.key,
                    name=e.inp.get("name") or "",
                    location=e.inp.get("location") or "",
                    amount=float(amount),
                    parameters=_parameters(e.ex.get("formula")),
                    uid=e.ex.get("prism_uid"),
                    commented=bool((e.ex.get("comment") or "").strip()),
                )
            )

    # What the activity itself makes, so a set of inputs that adds up to it can be recognised as a
    # composition instead of a leftover.
    ref_amount = next((p.get("amount") for p in production if p.get("amount")), None)
    out: list[Found] = []
    for (product, unit), rows in by_product.items():
        # Only same-sign inputs: a positive/negative pair is a deliberate add-and-credit, not a double
        # count, and flagging it would train people to ignore these warnings.
        for sign in (1, -1):
            same = [r for r in rows if (r.amount > 0) == (sign > 0)]
            if len(same) < 2:
                continue
            by_dataset: dict[tuple | None, list[_Supply]] = {}
            for r in same:
                by_dataset.setdefault(r.key, []).append(r)
            if len(by_dataset) == 1:
                out.extend(_one_dataset(product, same))
                continue
            out.append(_several_datasets(product, unit, same, ref_amount))
            # A dataset entered twice is entered twice inside a mix as well: the mix or the replacement is
            # judged on its own, and a copy of one of its datasets still counts double.
            for rows_of_one in by_dataset.values():
                out.extend(_identical(product, rows_of_one))
    return out
