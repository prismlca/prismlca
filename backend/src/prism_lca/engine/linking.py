"""Provider linking (M16 / ADR).

When a technosphere exchange needs a provider, this finds and ranks candidate activities and
says *why* each is (or isn't) a good fit — the transparency openLCA lacks. Ranking combines a
lexical match on reference product / name, unit agreement, and geography as a proximity signal
(DE → RER → GLO → RoW, reused from the search ranker) rather than a hard filter. Deterministic
and index-free so it works before any embedding index is built.
"""
from __future__ import annotations

import re

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.model import _db_or_404
from prism_lca.search.ranking import geo_chain, geo_rank

_TOKEN = re.compile(r"[a-z0-9]+")


def _tokens(text: str | None) -> set[str]:
    return set(_TOKEN.findall((text or "").lower()))


def find_providers(
    product: str,
    unit: str | None = None,
    location: str | None = None,
    databases: list[str] | None = None,
    limit: int = 10,
) -> dict:
    """Rank provider candidates for a wanted product. Returns candidates with per-item reasons."""
    bd = get_bd()
    # Resolved in place, so a loosely spelled name here works exactly as it does everywhere else.
    dbs = [_db_or_404(bd, d) for d in (databases or list(bd.databases))]

    query = _tokens(product)
    chain = geo_chain(location)
    candidates: list[dict] = []

    for db_name in dbs:
        for act in bd.Database(db_name):
            if act.get("type") == "emission":
                continue
            hay = _tokens(act.get("reference product")) | _tokens(act.get("name"))
            if not query or not (query & hay):
                continue
            overlap = len(query & hay) / len(query)
            reasons: list[str] = []
            score = overlap
            reasons.append(f"matches {int(overlap * 100)}% of product terms")

            act_unit = act.get("unit")
            if unit:
                if act_unit == unit:
                    score += 0.3
                    reasons.append(f"exact unit match ({unit})")
                else:
                    score -= 0.4
                    reasons.append(f"unit mismatch: wants {unit}, provider is {act_unit}")

            loc = act.get("location")
            if location:
                rank = geo_rank(loc, location)
                if rank == 0:
                    score += 0.25
                    reasons.append(f"same location ({loc})")
                elif rank <= len(chain):
                    score += max(0.0, 0.15 - 0.03 * rank)
                    reasons.append(f"geographic proxy ({loc})")
                else:
                    score -= 0.05
                    reasons.append(f"distant location ({loc})")

            candidates.append(
                {
                    "database": act.key[0],
                    "code": act.key[1],
                    "name": act.get("name"),
                    "product": act.get("reference product"),
                    "location": loc,
                    "unit": act_unit,
                    "score": round(score, 4),
                    "reasons": reasons,
                }
            )

    candidates.sort(key=lambda c: c["score"], reverse=True)
    return {
        "product": product,
        "unit": unit,
        "location": location,
        "searched_databases": dbs,
        "count": len(candidates),
        "candidates": candidates[:limit],
    }
