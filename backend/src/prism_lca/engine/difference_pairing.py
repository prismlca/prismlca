"""Which process of one model is which process of another — the pairing a split across two models needs.

A copy of a model gives every process a new code (``duplicate_foreground_database``), so the codes of a copy
say nothing about where its processes came from. The copy therefore records it: each copied process carries
:data:`COPIED_FROM`, the code of the process it was copied from. That pairs a copy with its original either
way round, and through copies of copies: the record is followed back, process by process, to the model asked
about, however many copies lie between. Processes the record does not cover — a model copied before it was written, or a process rebuilt
by hand — are paired by what a person would compare: name, reference product, location and unit, and only
where that is unambiguous on both sides. Whatever stays unpaired is new in the subject or gone from it.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

#: The field a copied process keeps the code of its original in.
COPIED_FROM = "prism_copied_from"
#: How many copies back a process's record is followed.
LINEAGE_DEPTH = 32


@dataclass(frozen=True)
class _Node:
    id: int
    code: str
    name: str
    product: str
    location: str
    unit: str
    origin: str | None

    @property
    def look(self) -> tuple[str, str, str, str]:
        return (self.name, self.product, self.location, self.unit)


@dataclass
class Pairing:
    nodes: dict[int, int] = field(default_factory=dict)  # subject node id → reference node id
    by_record: int = 0
    by_name: int = 0
    added: list[str] = field(default_factory=list)  # subject processes the reference does not have
    removed: list[str] = field(default_factory=list)  # reference processes the subject does not have

    def summary(self) -> dict:
        out: dict = {"paired": len(self.nodes)}
        if self.by_name:
            out["paired_by_name"] = self.by_name
        if self.added:
            out["only_in_subject"] = sorted(self.added)
        if self.removed:
            out["only_in_reference"] = sorted(self.removed)
        return out


def _nodes(database: str) -> list[_Node]:
    from bw2data.backends.schema import ActivityDataset

    out = []
    for node_id, code, data in (ActivityDataset.select(ActivityDataset.id, ActivityDataset.code, ActivityDataset.data)
                                .where(ActivityDataset.database == database).tuples()):
        data = data if isinstance(data, dict) else {}
        origin = data.get(COPIED_FROM)
        out.append(_Node(
            id=int(node_id), code=str(code), name=str(data.get("name") or code),
            # Read as a copy writes them: a missing location or unit is copied as "GLO" or "unit".
            product=str(data.get("reference product") or ""), location=str(data.get("location") or "GLO"),
            unit=str(data.get("unit") or "unit"), origin=str(origin) if origin else None,
        ))
    return out


def copied_from(codes: set[str]) -> dict[str, str]:
    """For each of ``codes`` whose process was copied from another, in any model of the workspace: that one's code."""
    from bw2data.backends.schema import ActivityDataset

    out: dict[str, str] = {}
    for code, data in (ActivityDataset.select(ActivityDataset.code, ActivityDataset.data)
                       .where(ActivityDataset.code.in_(list(codes))).tuples()):
        origin = data.get(COPIED_FROM) if isinstance(data, dict) else None
        if origin:
            out[str(code)] = str(origin)
    return out


def _reaching(nodes: list[_Node], targets: dict[str, _Node]) -> dict[int, str]:
    """For each of ``nodes`` copied from one of ``targets`` — directly, or through copies of copies — that one's
    code."""
    out: dict[int, str] = {}
    walking: dict[int, str] = {}
    for n in nodes:
        if n.origin in targets:
            out[n.id] = n.origin
        elif n.origin:
            walking[n.id] = n.origin
    for _ in range(LINEAGE_DEPTH):
        if not walking:
            break
        up = copied_from(set(walking.values()))
        walking = {node: up[code] for node, code in walking.items() if code in up}
        for node, code in list(walking.items()):
            if code in targets:
                out[node] = code
                del walking[node]
    return out


def pair(subject: str, reference: str) -> Pairing:
    """Pair the processes of model ``subject`` with those of model ``reference``."""
    sub, ref = _nodes(subject), _nodes(reference)
    result = Pairing()
    ref_by_code = {n.code: n for n in ref}
    sub_by_code = {n.code: n for n in sub}
    done_ref: set[int] = set()

    def link(s: _Node, r: _Node) -> None:
        result.nodes[s.id] = r.id
        done_ref.add(r.id)

    # The record, either way round — the subject copied from the reference, or the reference from the subject,
    # directly or through copies between. A record two processes share (one of them duplicated after the copy)
    # pairs neither.
    up = _reaching(sub, ref_by_code)
    claims = Counter(up.values())
    for s in sub:
        code = up.get(s.id)
        r = ref_by_code.get(code) if code and claims[code] == 1 else None
        if r is not None and r.id not in done_ref:
            link(s, r)
    down = _reaching(ref, sub_by_code)
    back = Counter(down.values())
    for r in ref:
        code = down.get(r.id)
        s = sub_by_code.get(code) if code and back[code] == 1 else None
        if s is not None and s.id not in result.nodes and r.id not in done_ref:
            link(s, r)
    result.by_record = len(result.nodes)

    # What is left: by name, reference product, location and unit, where each look occurs once on each side.
    open_sub = [s for s in sub if s.id not in result.nodes]
    open_ref = [r for r in ref if r.id not in done_ref]
    sub_looks = Counter(s.look for s in open_sub)
    ref_looks = {r.look: r for r in open_ref}
    ref_count = Counter(r.look for r in open_ref)
    for s in open_sub:
        if sub_looks[s.look] == 1 and ref_count[s.look] == 1:
            link(s, ref_looks[s.look])
            result.by_name += 1

    result.added = [s.name for s in sub if s.id not in result.nodes]
    result.removed = [r.name for r in ref if r.id not in done_ref]
    return result
