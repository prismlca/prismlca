"""Reciprocal Rank Fusion — combine dense + sparse rankings without score calibration.

RRF fuses ranked lists by rank position only, so the (incomparable) cosine and BM25 score scales
don't need normalising: fused(d) = Σ_lists 1/(k + rank_of_d). k=60 is the standard damping. A doc
ranked highly by either retriever surfaces; docs ranked by both rise to the top.
"""
from __future__ import annotations

RRF_K = 60


def reciprocal_rank_fusion(ranked_lists: list[list], k: int = RRF_K) -> dict:
    """Map each item (any hashable key) to its fused score across the given ranked lists.
    Each list is ordered best-first."""
    fused: dict = {}
    for ranked in ranked_lists:
        for position, key in enumerate(ranked):
            fused[key] = fused.get(key, 0.0) + 1.0 / (k + position + 1)
    return fused
