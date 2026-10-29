"""Where the burden arises: the hotspot list and the per-dataset detail a writing brief carries.

Moved out of the HTTP router: nothing here reads a request — it is LCA reasoning over a
contribution tree, and the pipeline, the gate and the tests all need it without a web layer in the
way.
"""

from __future__ import annotations

from prism_lca import _log
from prism_lca.engine import model as model_engine
from prism_lca.engine import report_data as rd


def best_effort(fn):
    """Run an optional enrichment, or give up quietly.

    The hotspot list and the inventory make a written chapter specific, but they are extras: a model with
    a single activity and no background cannot produce a contribution tree, and a report of it should
    still typeset. Errors here would otherwise surface as a failed render for a reason the author cannot
    act on.
    """
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 — deliberately broad: any failure means "no extra evidence"
        _log.swallowed(exc, "best_effort")
        return None


def hotspots(contribution: dict | None, limit: int = 10, detail: int = 5, lang: str = "en") -> list[dict]:
    """The processes where the burden arises, largest first — the top few with their dataset details.

    Taken from the contribution tree by **direct** impact, not cumulative: a parent's cumulative score is
    its children's, so ranking by it just re-lists the chain from the top. Direct impact answers the
    question a reader has — which dataset is responsible.

    The first `detail` entries also carry what the process-details window shows: the reference product,
    the dataset's own description and its classification, plus the inputs the tree attributes impact to.
    That is what "explain why this process dominates" actually needs, and it arrives *in the brief* on
    purpose — the gate judges a chapter against what was handed over, so a fact the model fetched behind
    our back would be reported as unsupported.
    """
    if not contribution or "tree" not in contribution:
        return []
    total = float((contribution.get("meta") or {}).get("total") or 0.0)
    impact_unit = str((contribution.get("meta") or {}).get("unit") or "")
    flat: list[dict] = []

    def walk(node: dict) -> None:
        flat.append(node)
        for child in node.get("ch") or []:
            walk(child)

    walk(contribution["tree"])

    # One entry per *dataset*, not per position in the tree. A dataset reached through two branches —
    # the NiMH cells built into the lamps and the same cells bought again as replacements — used to
    # appear twice with half its burden each. The report then called solar-grade silicon "the largest
    # individual process … only 3.8 %" while the true leader, dysprosium oxide, sat split across ranks
    # 5 and 6 with 4.9 %; the second-largest contributor was missing from the list entirely because its
    # pieces each fell below the cut-off; and the writing model, seeing the same name twice, explained
    # the duplication in the prose as if it were a modelling insight (V155). Merge first, then rank.
    merged: dict[tuple[str, str, str], dict] = {}
    for node in flat:
        direct = float(node.get("dir") or 0.0)
        if direct == 0.0:
            continue
        key = (str(node.get("db") or ""), str(node.get("c") or ""), str(node.get("n") or ""))
        seen = merged.get(key)
        if seen is None:
            merged[key] = {"direct": direct, "node": node}
        else:
            seen["direct"] += direct
            # The details (description, attributed inputs) come from the branch that carries most of
            # the burden — the one a reader asking "why does this dominate" would be shown.
            if abs(direct) > abs(float(seen["node"].get("dir") or 0.0)):
                seen["node"] = node

    ranked = sorted(merged.items(), key=lambda kv: abs(kv[1]["direct"]), reverse=True)
    out: list[dict] = []
    for (database, code, name), agg in ranked[:limit]:
        node, direct = agg["node"], agg["direct"]
        entry = {
            "name": name,
            "location": node.get("g") or "",
            "database": database,
            "code": code,
            # The process's physical unit. `direct` is an impact score — its own unit is stated
            # separately so the derivation checker cannot read "kilogram" for it.
            "unit": node.get("u") or "",
            "direct": direct,
            "direct_unit": impact_unit,
            "share_percent": (direct / total * 100.0) if total else 0.0,
        }
        if len(out) < detail:
            entry.update(process_detail(database, code, node, total, impact_unit, lang))
        out.append(entry)
    return out


#: A dataset description is context for one paragraph, not a document. ecoinvent comments run to several
#: kilobytes; the opening is where the process is actually described.
_DESCRIPTION_CHARS = 700


def process_detail(
    database: str, code: str, node: dict, total: float, impact_unit: str = "", lang: str = "en"
) -> dict:
    """What the process-details window shows, trimmed to what a chapter can use."""
    detail: dict = {}
    # The inputs the tree itself attributes impact to — better than listing exchanges by amount, which
    # mixes units and says nothing about which one matters.
    children = sorted(
        (node.get("ch") or []),
        key=lambda c: abs(float(c.get("imp") or 0.0)),
        reverse=True,
    )[:4]
    if children:
        detail["inputs"] = [
            {
                "name": c.get("n") or "",
                "location": c.get("g") or "",
                "impact": float(c.get("imp") or 0.0),
                "impact_unit": impact_unit,
                # Localised like every other `…_text`: it prints verbatim in the prose, so it
                # uses the one shared share rule (report_data.share_text).
                "share_text": (rd.share_text(float(c.get("imp") or 0.0) / total * 100.0, lang) if total else ""),
            }
            for c in children
        ]
    meta = best_effort(lambda: model_engine.activity_metadata(database, code))
    if not meta:
        return detail
    info = meta.get("activity") or {}
    detail["product"] = info.get("reference_product") or info.get("product") or ""
    description = (meta.get("comment") or "").strip()
    if description:
        detail["description"] = description[:_DESCRIPTION_CHARS]
    classification = [c.get("value", "") for c in (meta.get("classifications") or [])]
    if classification:
        detail["classification"] = " · ".join(classification[:3])
    return detail
