"""Which subject of a comparison is split against which: the pairs "Why different?" holds for.

The split of :mod:`difference_terms` is exact only between two results of one model — the model and one of its
scenarios, two of its scenarios, or the model and a copy of it. A comparison holds whatever the user ticked, so
before anything is computed every subject is given the one subject it is split against, or none and why.

A subject's reference is:

- for a scenario, **its baseline**: the same process without a scenario. Without the baseline among the subjects a
  scenario is not split: against another scenario the split would name the differences of two sets of overrides,
  which reads as what a scenario changes and is not;
- for a model's process without a scenario, **its original**: the process it was copied from, in another model, as
  it is without a scenario. :mod:`difference_pairing` pairs the two models' processes; a copy keeps the code of its
  original, and that one of its own, which says which of two is the copy — however many copies lie between them.
  Where the two are paired by name alone, nothing says it, and the one listed first counts as the original. No
  subject is split against one that is split against it, however long the way round.

A subject nothing is split against, and that is no one's reference, is a scenario whose baseline is not among the
subjects, a dataset of a database (nobody edits the background, so nothing in it is a variant), or a process
independent of every other subject.
"""
from __future__ import annotations

from dataclasses import dataclass

from prism_lca import _log
from prism_lca.engine.difference_pairing import (
    COPIED_FROM,
    LINEAGE_DEPTH,
    Pairing,
    copied_from,
    pair,
)

#: Why a subject has no reference: the others are split against it; it is a scenario whose baseline is not among the
#: subjects; it is a dataset of a database; it is a process no other subject is a variant of.
REFERENCE, NO_BASELINE, DATASET, INDEPENDENT = "reference", "no_baseline", "dataset", "independent"


@dataclass
class Entry:
    reference: int | None = None
    #: For a copy against its original: which process of the one is which of the other.
    pairing: Pairing | None = None
    reason: str | None = None

    def answer(self) -> dict:
        return {"reference": self.reference} if self.reference is not None else {"reason": self.reason}


def plan(subjects: list[dict]) -> list[Entry]:
    """One entry per subject (``{database, code, scenario?, amount?}``), in their order."""
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.library import model_databases

    bd = get_bd()
    models = set(model_databases())
    nodes = []
    for s in subjects:
        try:
            nodes.append(bd.get_node(database=s["database"], code=s["code"]))
        except Exception as exc:  # noqa: BLE001 - a subject gone since it was picked is split against nothing
            _log.swallowed(exc, "difference plan: subject node")
            nodes.append(None)
    entries = [Entry() for _ in subjects]
    pairings: dict[tuple[str, str], Pairing] = {}

    def paired(sub: int, ref: int) -> Pairing | None:
        """The pairing of ``sub``'s model onto ``ref``'s, when it pairs the two subjects' processes."""
        key = (subjects[sub]["database"], subjects[ref]["database"])
        if key not in pairings:
            pairings[key] = pair(*key)
        found = pairings[key]
        return found if found.nodes.get(nodes[sub].id) == nodes[ref].id else None

    def same_process(i: int, j: int) -> bool:
        return (subjects[i]["database"], subjects[i]["code"]) == (subjects[j]["database"], subjects[j]["code"])

    lines: dict[int, list[str]] = {}

    def line(i: int) -> list[str]:
        if i not in lines:
            lines[i] = _lineage(nodes[i])
        return lines[i]

    def copy_of(i: int, j: int) -> bool:
        """Whether ``i`` is the copy side of the two — the one split against the other — should they pair."""
        if nodes[j].key[1] in line(i):
            return True
        if nodes[i].key[1] in line(j):
            return False
        return i > j

    def leads_to(j: int | None, i: int) -> bool:
        """Whether following the references from ``j`` comes to ``i``."""
        seen: set[int] = set()
        while j is not None and j not in seen:
            if j == i:
                return True
            seen.add(j)
            j = entries[j].reference
        return False

    for i, s in enumerate(subjects):
        if nodes[i] is None:
            continue
        if s.get("scenario"):
            # The baseline, or nothing.
            entries[i].reference = next((j for j in range(len(subjects))
                                         if same_process(i, j) and not subjects[j].get("scenario")), None)
            continue
        if s["database"] not in models:
            continue
        # The original, in another model and without a scenario: the nearest one the copy descends from — a sibling
        # copy listed earlier pairs by name as well — then in the order listed.
        ancestry = line(i)
        others = sorted((j for j in range(len(subjects)) if nodes[j] is not None and not subjects[j].get("scenario")
                         and subjects[j]["database"] != s["database"] and subjects[j]["database"] in models),
                        key=lambda j, ancestry=ancestry: (ancestry.index(nodes[j].key[1])
                                                          if nodes[j].key[1] in ancestry else len(ancestry), j))
        for j in others:
            if copy_of(i, j) and not leads_to(j, i) and (pairing := paired(i, j)) is not None:
                entries[i].reference, entries[i].pairing = j, pairing
                break

    referenced = {e.reference for e in entries if e.reference is not None}
    for i, e in enumerate(entries):
        if e.reference is None:
            e.reason = (REFERENCE if i in referenced
                        else DATASET if subjects[i]["database"] not in models
                        else NO_BASELINE if subjects[i].get("scenario") else INDEPENDENT)
    return entries


def _lineage(node) -> list[str]:
    """The codes ``node`` was copied from, nearest first: its original, the original's original, and so on. A copy
    records only the process it was made from; the line ends where an original is gone."""
    out: list[str] = []
    code = node.get(COPIED_FROM)
    while code and code not in out and len(out) < LINEAGE_DEPTH:
        out.append(code)
        code = copied_from({code}).get(code)
    return out
