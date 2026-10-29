"""The system model a report draws: the foreground processes, their links, and the first tier of
background datasets — with each node's share of the leading indicator where a contribution tree exists.

Data only. The picture is drawn in the renderer (dagre layout + hand-written SVG, `lib/charts/
systemModel.ts`), like every other report figure, and handed back as ``figures["system-model"]``. What
this module decides is *what* the picture shows — which is why the folding rule lives here and the
result lands in ``data.json``: a bundle then says exactly which datasets were drawn and which were
folded, instead of that being a property of one renderer run.

Why fold at all: a foreground process on ecoinvent commonly has fifteen to forty direct inputs. Drawn
in full, the first background tier is a wallpaper pattern in which nothing can be read. Per foreground
process the ``per_process`` largest inputs (by their share of the leading indicator, falling back to the
exchange amount when no tree is available) are kept, and the rest become one node — "+ n further
datasets" — that still carries their summed share, so the picture stays honest about what it left out.
"""
from __future__ import annotations

from typing import Any

from prism_lca.engine import model_graph

#: The folding default. Four keeps a process with its typical top inputs legible; the rail lets the
#: author raise or lower it per report.
DEFAULT_PER_PROCESS = 4
MAX_PER_PROCESS = 20


def _shares(tree: dict | None) -> tuple[dict[str, float], dict[tuple[str, str], float]]:
    """Cumulative shares from the contribution tree.

    Returns two maps: ``own[node_id]`` — a node's own cumulative share of the total (used for the
    foreground processes, which appear once) — and ``via[(child_id, parent_id)]`` — the share a child's
    subtree carries INTO one parent, summed over every occurrence of that edge. The second is what a
    background dataset's node stands for: the same market may feed three foreground processes, and the
    picture shows three edges, each with its own weight.
    """
    own: dict[str, float] = {}
    via: dict[tuple[str, str], float] = {}
    if not tree:
        return own, via

    def walk(node: dict, parent: str | None) -> None:
        node_id = f"{node.get('db')}/{node.get('c')}"
        share = float(node.get("shr") or 0.0)
        own.setdefault(node_id, share)
        if parent is not None:
            via[(node_id, parent)] = via.get((node_id, parent), 0.0) + share
        for child in node.get("ch") or []:
            walk(child, node_id)

    walk(tree, None)
    return own, via


def system_model(
    database: str,
    tree: dict | None = None,
    *,
    per_process: int = DEFAULT_PER_PROCESS,
    background: bool = True,
) -> dict[str, Any]:
    """Nodes and edges for the system-model figure, folded and weighted.

    ``nodes``: ``{id, name, location, unit, product, external, share, tags, folded}`` — `external` marks
    a background dataset, `share` is None when no tree was available, `folded` is the number of datasets
    a "+ n further" node stands for (0 for a real node), `tags` is the process's tag list
    (``[{dimension, value}]``) so the renderer can colour by a family.
    ``edges``: ``{source, target, amount, unit, share}`` — `share` is the weight the link carries into the
    target, when known.
    ``counts``: how many processes, datasets and folded datasets the picture has — printed under it.
    """
    per_process = max(0, min(int(per_process), MAX_PER_PROCESS))
    graph = model_graph.graph(database)
    own, via = _shares(tree)
    fg_ids = {n["id"] for n in graph["nodes"]}

    nodes: list[dict[str, Any]] = []
    for n in graph["nodes"]:
        nodes.append(
            {
                "id": n["id"],
                "name": n.get("name") or "",
                "location": n.get("location") or "",
                "unit": n.get("unit") or "",
                "product": n.get("product") or "",
                "external": False,
                "share": own.get(n["id"]) if own else None,
                "tags": list(n.get("tags") or []),
                "folded": 0,
            }
        )
    edges: list[dict[str, Any]] = [
        {
            "source": e["source"],
            "target": e["target"],
            "amount": e.get("amount"),
            "unit": _unit_of(graph, e["source"]),
            "share": via.get((e["source"], e["target"])) if via else None,
        }
        for e in graph["edges"]
        if e["source"] in fg_ids and e["target"] in fg_ids
    ]

    folded_total = 0
    datasets: set[str] = set()
    if background and graph.get("bg_nodes"):
        # The figure draws one box per DATASET: the canvas splits a dataset into boxes per tag
        # occurrence, the report's picture of the system does not (the tree it is weighted by is per
        # dataset too).
        dataset_of = {n["id"]: n.get("dataset_id") or n["id"] for n in graph["bg_nodes"]}
        bg_by_id = {dataset_of[n["id"]]: n for n in graph["bg_nodes"]}
        kept_ids: set[str] = set()
        # Per foreground target: rank its background inputs, keep the top `per_process`, fold the rest.
        by_target: dict[str, list[dict]] = {}
        for e in graph.get("bg_edges") or []:
            e = {**e, "source": dataset_of.get(e["source"], e["source"])}
            if e["target"] in fg_ids and e["source"] in bg_by_id:
                by_target.setdefault(e["target"], []).append(e)
        for target, incoming in by_target.items():
            # One edge per source: a dataset linked twice into one process is one arrow in the picture.
            merged: dict[str, dict] = {}
            for e in incoming:
                m = merged.setdefault(
                    e["source"], {"source": e["source"], "target": target, "amount": 0.0}
                )
                m["amount"] = float(m["amount"]) + float(e.get("amount") or 0.0)
            ranked = sorted(
                merged.values(),
                key=lambda e: (
                    -abs(via.get((e["source"], target), 0.0)) if via else 0.0,
                    -abs(float(e["amount"])),
                    e["source"],
                ),
            )
            keep, fold = ranked[:per_process], ranked[per_process:]
            # A fold of one is no fold: "+ 1 further dataset" costs the same box the dataset itself would,
            # and says less. Folding starts at two.
            if len(fold) == 1:
                keep, fold = ranked, []
            for e in keep:
                kept_ids.add(e["source"])
                datasets.add(e["source"])
                edges.append(
                    {
                        "source": e["source"],
                        "target": target,
                        "amount": e["amount"],
                        "unit": bg_by_id[e["source"]].get("unit") or "",
                        "share": via.get((e["source"], target)) if via else None,
                    }
                )
            if fold:
                folded_total += len(fold)
                datasets.update(e["source"] for e in fold)
                share = sum(via.get((e["source"], target), 0.0) for e in fold) if via else None
                fid = f"folded:{target}"
                nodes.append(
                    {
                        "id": fid,
                        "name": "",
                        "location": "",
                        "unit": "",
                        "product": "",
                        "external": True,
                        "share": share,
                        "tags": [],
                        "folded": len(fold),
                    }
                )
                edges.append(
                    {"source": fid, "target": target, "amount": None, "unit": "", "share": share}
                )
        for bid in sorted(kept_ids):
            n = bg_by_id[bid]
            nodes.append(
                {
                    "id": bid,
                    "name": n.get("name") or "",
                    "location": n.get("location") or "",
                    "unit": n.get("unit") or "",
                    "product": n.get("product") or "",
                    "external": True,
                    # A dataset's own cumulative share is not one number when it feeds several
                    # processes; the edges carry the per-link weights, the node the sum of them.
                    "share": (
                        sum(e["share"] or 0.0 for e in edges if e["source"] == bid) if via else None
                    ),
                    "tags": [],
                    "folded": 0,
                }
            )

    return {
        "database": database,
        "nodes": nodes,
        "edges": edges,
        "per_process": per_process,
        "counts": {
            "processes": len(graph["nodes"]),
            "datasets": len(datasets),
            "folded": folded_total,
            "has_shares": bool(own),
        },
    }


def _unit_of(graph: dict, node_id: str) -> str:
    for n in graph["nodes"]:
        if n["id"] == node_id:
            return n.get("unit") or ""
    return ""
