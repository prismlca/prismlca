"""Which process of one model is which process of another — the pairing a split across two models needs.

A copy of a model gives every process a new code (``duplicate_foreground_database``), so the codes of a copy
say nothing about where its processes came from. The copy therefore records it: each copied process carries
:data:`COPIED_FROM`, the code of the process it was copied from. That pairs a copy with its original either
way round. Processes the record does not cover — a model copied before it was written, or a process rebuilt
by hand — are paired by what a person would compare: name, reference product, location and unit, and only
where that is unambiguous on both sides. Whatever stays unpaired is new in the subject or gone from it.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

#: The field a copied process keeps the code of its original in.
COPIED_FROM = "prism_copied_from"


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

    # The record, either way round — the subject copied from the reference, or the reference from the subject.
    # A record two processes share (one of them duplicated after the copy) pairs neither.
    claims = Counter(n.origin for n in sub if n.origin)
    for s in sub:
        r = ref_by_code.get(s.origin) if s.origin and claims[s.origin] == 1 else None
        if r is not None and r.id not in done_ref:
            link(s, r)
    back = Counter(n.origin for n in ref if n.origin)
    for r in ref:
        s = sub_by_code.get(r.origin) if r.origin and back[r.origin] == 1 else None
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
