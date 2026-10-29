"""The canvas graph of one model: its processes, the links between them, and its inputs from outside —
one box per occurrence, so the same dataset can stand on the canvas once per tag combination it serves.
Everything the Workbench draws on open comes from here; the model's data itself is edited in ``model``.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.model import _db_or_404, activity_info, node_id


def occurrence_id(dataset_id: str, tags: list[dict]) -> str:
    """The canvas id of one box of a dataset: the dataset id while the inputs carry no tags, else the
    dataset id plus a short hash of the tags. A hash rather than the text: tag values are free text, and
    "a=b;c=d" written out would collide with two tags. Same rule in the renderer (lib/occurrences.ts)."""
    if not tags:
        return dataset_id
    import hashlib
    import json

    canon = json.dumps(sorted([t["dimension"], t["value"]] for t in tags), ensure_ascii=False, separators=(",", ":"))
    return f"{dataset_id}#{hashlib.sha1(canon.encode('utf-8')).hexdigest()[:12]}"  # noqa: S324 - an id, not a secret


def _demand_roots(processes: set[str], consumers: dict[str, set[str]]) -> set[str]:
    """The processes a calculation of the model can start from: those nothing above them is independent of.
    A process nobody uses, and every process of a cycle nothing outside it uses (a strongly connected
    component without consumers) — there the root may be any member, so each of them may carry demand of
    its own, without a tag."""
    above: dict[str, set[str]] = {}

    def ancestors(pid: str) -> set[str]:
        if pid not in above:
            seen: set[str] = set()
            todo = list(consumers.get(pid, ()))
            while todo:
                user = todo.pop()
                if user not in seen:
                    seen.add(user)
                    todo.extend(consumers.get(user, ()))
            above[pid] = seen
        return above[pid]

    return {pid for pid in processes if all(pid in ancestors(a) for a in ancestors(pid))}


def inherited_values(own: dict[str, dict[str, str]], consumers: dict[str, set[str]]) -> dict[str, dict[str, str]]:
    """What every process of a model passes down without a tag of its own: per process and dimension, the
    one value the processes that use it hand down (their own tag, or what reaches them in turn), so an input
    below it falls into that value just as the calculation books it (``tag(e) or own_tag(Y) or value(X)``).

    ``own`` maps a process id to its own tags, ``consumers`` a process id to the ids of the processes of the
    model that draw on it. A process that serves two values (a helper used in two phases), or one where a
    calculation may start (:func:`_demand_roots`: untagged demand of its own), passes nothing down unless all
    of it is one value — one box can stand for one value only."""
    dims = {d for tags in own.values() for d in tags}
    reach: dict[str, dict[str, set[str | None]]] = {
        pid: {d: ({tags[d]} if d in tags else set()) for d in dims} for pid, tags in own.items()
    }
    for pid in _demand_roots(set(own), consumers):
        for d in dims:
            if d not in own[pid]:
                reach[pid][d].add(None)
    changed = True
    while changed:  # values only ever join a set, so this settles
        changed = False
        for pid, users in consumers.items():
            for d in dims:
                if d in own.get(pid, {}):
                    continue
                for user in users:
                    if not reach[user][d] <= reach[pid][d]:
                        reach[pid][d] |= reach[user][d]
                        changed = True
    return {
        pid: {d: next(iter(vals)) for d, vals in by_dim.items() if len(vals) == 1 and None not in vals}
        for pid, by_dim in reach.items()
    }


def graph(database: str) -> dict:
    """Nodes = the database's own activities only. ``edges`` = technosphere links *between* those
    nodes (foreground-to-foreground). ``bg_edges`` = links from an input outside the model into a
    foreground node; the direct (tier-1) outside inputs ship as ``bg_nodes`` and are ALWAYS drawn
    (deliberately not collapsible) — only deeper tiers hide behind a reference's expand affordance.
    Both edge lists carry the exchange uid and the input's own tags, so an edge disappears as soon as
    its exchange is removed. Node id is 'database/code'.

    An outside input is drawn as one box per OCCURRENCE: the inputs of the model that draw on the same
    dataset with the same effective tags share a box (`id` from :func:`occurrence_id`, `dataset_id`, `tags`,
    `uids`), so the same ecoinvent market can stand twice on the canvas, once per phase it serves. An
    input's effective tags follow the calculation per dimension: its own tag, else the own tag of a supplier
    in another model, else the value its process passes down (:func:`inherited_values`). A box's tag carries
    ``inherited: True`` when none of its inputs holds it itself — tagging the box writes onto the inputs, so
    only their own tags are editable there."""
    from prism_lca.engine.tag_scope import MODEL, kind_checker
    from prism_lca.engine.tags import TagStore

    bd = get_bd()
    database = _db_or_404(bd, database)
    kind = kind_checker()
    db = bd.Database(database)
    acts = list(db)
    db_keys = {a.key for a in acts}
    tag_map = TagStore().load_map()  # one read for the whole graph

    nodes: list[dict] = []
    edges: list[dict] = []
    outside: list[tuple[dict, object]] = []  # (edge, the supplying activity) of every input from outside
    own: dict[str, dict[str, str]] = {}
    consumers: dict[str, set[str]] = {}
    for act in acts:
        target = node_id(act)
        own[target] = {t["dimension"]: t["value"] for t in tag_map.get(f"{act.key[0]}/{act.key[1]}", [])}
        for ex in act.exchanges():
            if ex.get("type") != "technosphere":
                continue
            uid = ex.get("prism_uid")
            edge = {
                "uid": uid,
                "type": ex.get("type"),
                "amount": ex.get("amount"),
                "source": node_id(ex.input),
                "target": target,
                "tags": tag_map.get(f"{act.key[0]}/{TagStore.exchange_code(act.key[1], uid)}", []) if uid else [],
            }
            if tuple(ex.input.key) in db_keys:  # link to another on-canvas node → always draw it
                edges.append(edge)
                consumers.setdefault(edge["source"], set()).add(target)
            else:
                outside.append((edge, ex.input))
        info = activity_info(act)
        info["id"] = target
        info["external"] = False
        # Nothing is ever hidden behind a FOREGROUND node: its foreground links are drawn
        # directly and its tier-1 background inputs ship as always-visible bg_nodes (by design
        # not collapsible). upstream = 0 removes the expand affordance that used to sit dead
        # on every foreground process; deeper tiers unfold from the references themselves.
        info["upstream"] = 0
        info["tags"] = tag_map.get(f"{act.key[0]}/{act.key[1]}", [])
        nodes.append(info)

    passed_down = inherited_values(own, consumers)
    bg_edges: list[dict] = []
    bg_nodes: dict[str, dict] = {}  # direct (tier-1) background inputs, so the UI can always show them
    for edge, supplier in outside:  # outside input: one box per occurrence, always on the canvas
        held = {t["dimension"] for t in edge["tags"]}
        effective = [dict(t) for t in edge["tags"]]
        if kind(supplier.key[0]) == MODEL:  # a process of another model counts with its own tags
            for t in tag_map.get(f"{supplier.key[0]}/{supplier.key[1]}", []):
                if t["dimension"] not in {e["dimension"] for e in effective}:
                    effective.append({"dimension": t["dimension"], "value": t["value"]})
        effective += [
            {"dimension": d, "value": v}
            for d, v in passed_down.get(edge["target"], {}).items()
            if d not in {e["dimension"] for e in effective}
        ]
        dataset = edge["source"]
        src = edge["source"] = occurrence_id(dataset, effective)
        bg_edges.append(edge)
        box = bg_nodes.get(src)
        if box is None:
            box = bg_nodes[src] = activity_info(supplier)
            box["id"] = src
            box["dataset_id"] = dataset
            box["external"] = True
            # A box is a reference on THIS canvas, even when its process is writable where it lives
            # (the library, another model): tagging it tags the inputs, never that process.
            box["read_only"] = True
            box["upstream"] = -1  # reference: hidden-upstream count unknown until expanded
            box["tags"] = [{**t, "inherited": t["dimension"] not in held} for t in effective]
            box["uids"] = []
        else:  # an input of the box that holds a tag itself makes it the box's own
            for t in box["tags"]:
                if t["dimension"] in held:
                    t["inherited"] = False
        if edge["uid"]:
            box["uids"].append(edge["uid"])
    for box in bg_nodes.values():  # the flag only where it says something: explicit tags stay as they were
        box["tags"] = [t if t["inherited"] else {"dimension": t["dimension"], "value": t["value"]} for t in box["tags"]]
    return {
        "database": database, "nodes": nodes, "edges": edges,
        "bg_edges": bg_edges, "bg_nodes": list(bg_nodes.values()),
    }
