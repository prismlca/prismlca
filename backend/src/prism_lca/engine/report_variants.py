"""Telling a report's variants apart: printed names, and the model context in life-cycle order.

Moved out of the HTTP router: naming policy and table order are domain rules the
pipeline applies, not web concerns.
"""

from __future__ import annotations

from prism_lca import _log
from prism_lca.engine import model as model_engine
from prism_lca.engine import tags
from prism_lca.engine.report_hotspots import best_effort
from prism_lca.engine.tag_groups import TagGroupStore
from prism_lca.engine.tags import TagStore


def reference_fields(database: str, code: str) -> dict[str, str]:
    """A process's location and reference product, for telling two same-named variants apart.

    Best-effort and read outside any scenario window on purpose: neither field can be moved by a
    parameter state, and a variant whose process cannot be read here has already been computed — so a
    failure means "no qualifier available", never a failed render.
    """
    act = best_effort(lambda: model_engine.get_activity(database, code))
    if act is None:
        return {"location": "", "product": ""}
    return {
        "location": str(act.get("location") or ""),
        "product": str(act.get("reference product") or ""),
    }


#: What a variant's printed name may be qualified with when two of them would otherwise read the
#: same, in the order they are tried. See `disambiguated_labels`.
VARIANT_QUALIFIERS: tuple[tuple[str, str], ...] = (
    # The separator the composed name has always used, so a name qualified here reads like the ones
    # a scenario comparison has printed all along.
    ("scenario_name", "{label} · {value}"),
    # A parenthesised qualifier, the way every LCA tool writes a location after a dataset name.
    ("location", "{label} ({value})"),
    ("product", "{label} ({value})"),
)


def disambiguated_labels(rows: list[dict[str, str]]) -> list[str]:
    """The variants' printed names, made tellable apart — and left untouched when they already are.

    Two variants of one process, neither carrying a label of its own and neither adding a scenario
    name, both fall back to the process name: the comparison then prints two columns called "ARON
    Basic+ Kunststofffenster 100x120" and no reader can say which is which (the half of V223 the
    identity fix deliberately left alone, because it decides what a reader sees).

    **Nothing happens without a collision.** The first thing this does is look for one, and with none
    it hands back the names byte for byte — that is the whole safety of it, because every finished
    chapter that spells a variant's name out, and every binding written on a label before the
    composite key existed, is reading these strings.

    The order is "what tells a reader *which* one":

    * the **parameter state** it was computed in — the difference the author made on purpose, and the
      reason the name is composed at all. Appended here even when the label already contains that
      word, which is the one case the ordinary composition suppresses: a repeated word reads badly,
      two identical columns read *wrong*.
    * the reference process's **location**, then its **reference product** — what separates two
      genuinely different processes that happen to share a name.

    Two candidates are deliberately absent. The process **code** is a uuid4 hex for anything the
    author modelled and appears nowhere else in the document, so it identifies the variant no better
    than a number does and costs thirty-two characters of table header. The **amount** cannot help at
    all: a report computes every variant at one functional-unit amount, so two of them can never
    differ in it.

    What is left when none of that separates them is the position in the list, and it is put on
    *every* member of the group that is still ambiguous: "widget" beside "widget (2)" reads as an
    annotation on the second one, "widget (1)" beside "widget (2)" as the enumeration it is. It says
    nothing about which is which — honest only because at that point nothing a reader could see does:
    same process, same state, same product.
    """
    labels = [str(row.get("label") or "") for row in rows]

    def collisions() -> list[list[int]]:
        groups: dict[str, list[int]] = {}
        for index, label in enumerate(labels):
            groups.setdefault(label, []).append(index)
        return [members for members in groups.values() if len(members) > 1]

    if not collisions():
        return labels
    for field, form in VARIANT_QUALIFIERS:
        for members in collisions():
            values = [str(rows[i].get(field) or "").strip() for i in members]
            # A qualifier nobody in the group differs in would lengthen every name and separate none.
            if len(set(values)) < 2:
                continue
            for index, value in zip(members, values, strict=True):
                if value:
                    labels[index] = form.format(label=labels[index], value=value)
        if not collisions():
            return labels
    for members in collisions():
        for position, index in enumerate(members, start=1):
            labels[index] = f"{labels[index]} ({position})"
    return labels


def context_in_phase_order(database: str, report: dict) -> dict:
    """The model context, with the foreground put in life-cycle order where the model is tagged for it.

    The inventory table used to be reference-process-first and then alphabetical, which is the
    database's order and not the study's. That was invisible until the naming rule put
    the phase first in a process name — and then the table read Distribution, End-of-Life, Packaging,
    Production, Use. The written chapter follows the table faithfully ("the first substantive module
    is End-of-Life — Empty Container"), so a report walked its own life cycle backwards (V249).

    The order comes from the tag group's own `values` list — the sequence the modeller created them
    in, which for a life-cycle dimension *is* the life cycle. Untagged processes keep alphabetical
    order after the tagged ones, and a report with no breakdown dimension is unchanged.
    """
    context = model_engine.report_context(database)
    dimension = str(report.get("aggregate_by") or "").removeprefix("tag:")
    if not dimension or dimension == "geo":
        return context
    # The stores are constructed OUTSIDE the guard on purpose (stateless, like everywhere else in the
    # engine); only their own file work is guarded. The first version of this guarded the store
    # *lookup* too, caught its own typo, and silently returned an unsorted table for a whole practice
    # run — a programming error has to surface, an unreadable file must not stop a render.
    tag_store = TagStore()
    group_store = TagGroupStore()
    try:
        tag_map = tag_store.load_map()
        group = next((g for g in group_store.list_groups() if g.get("name") == dimension), None)
    except Exception as exc:  # noqa: BLE001 — an order is a nicety; an unreadable file must not stop a render.
        _log.swallowed(exc, "context_in_phase_order")
        return context
    order = {str(v): i for i, v in enumerate((group or {}).get("values") or [])}
    for entry in context.get("foreground") or []:
        value = tags.TagStore.value_from(tag_map, database, str(entry.get("code") or ""), dimension)
        entry["phase"] = value or ""
        entry["phase_order"] = order.get(str(value), len(order)) if value else len(order)
    return context
