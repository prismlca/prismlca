"""Turn a Brightway database into a vector index.

Embed text follows the MCP-server pattern: strip the "market for"/"market group for"
prefix (so markets don't sit far from production datasets for generic queries) and re-append
the type as a keyword.
"""
from __future__ import annotations

from collections.abc import Callable

import numpy as np

from prism_lca.search.embeddings import EmbeddingProvider
from prism_lca.search.index import VectorIndex

MARKET_PREFIXES = ("market group for ", "market for ")
TYPE_KEYWORD = {"P": "production", "M": "market", "G": "market group"}


def classify_type(name: str) -> str:
    """P = production, M = market, G = market group (matches MCP type filter)."""
    n = (name or "").lower()
    if n.startswith("market group for"):
        return "G"
    if n.startswith("market for"):
        return "M"
    return "P"


def build_embed_text(name: str, product: str, comment: str) -> str:
    base = name or ""
    low = base.lower()
    for prefix in MARKET_PREFIXES:
        if low.startswith(prefix):
            base = base[len(prefix):]
            break
    parts = [base]
    if product and product != name:
        parts.append(product)
    if comment:
        parts.append(comment[:300])
    parts.append(TYPE_KEYWORD[classify_type(name)])
    return " | ".join(p for p in parts if p)


def activity_meta(act, db_name: str) -> tuple[dict, str]:
    """The index row for one activity, and the text that gets embedded for it.

    Public because the service appends to an existing index (``extend``) and must produce rows the
    same way a full build does — a second recipe would embed newcomers into a slightly different
    space and quietly rank them apart.
    """
    name = act.get("name") or ""
    product = act.get("reference product") or act.get("reference_product") or ""
    comment = act.get("comment") or ""
    meta = {
        "code": act.get("code"),
        "name": name,
        "product": product,
        "geo": act.get("location"),
        "unit": act.get("unit"),
        "atype": classify_type(name),
        "database": db_name,
    }
    return meta, build_embed_text(name, product, comment)


def embed_unique(
    provider: EmbeddingProvider,
    texts: list[str],
    dim: int,
    batch_size: int = 256,
    on_progress: Callable[[int, int], None] | None = None,
) -> np.ndarray:
    """One vector per text, in the order given — each distinct text embedded once.

    A database repeats its texts: the embed text carries no geography, and a market says the same
    boilerplate comment in every region it covers, so "market for electricity, medium voltage" is one
    text 175 times. In ecoinvent 3.12 that is 37 % of the rows, among the elementary flows (whose
    compartment is not in the text either) 81 %. Embedding a repeat only computes the vector it
    already has, and on a CPU every one costs time.

    Progress is reported in rows — all of them, repeats included, because that is the number the
    user knows the database by — and advances in step with the embedding work. Counting the rows a
    finished batch happens to cover would run ahead whenever a batch holds a much-repeated text, and
    the time estimate drawn from that rate would promise too little.
    """
    slot: dict[str, int] = {}
    rows = np.fromiter((slot.setdefault(t, len(slot)) for t in texts), dtype=np.int64, count=len(texts))
    unique = list(slot)
    vectors = np.empty((len(unique), dim), dtype="float32")
    if on_progress:
        on_progress(0, len(texts))
    for start in range(0, len(unique), batch_size):
        stop = min(start + batch_size, len(unique))
        vectors[start:stop] = provider.embed(unique[start:stop])
        if on_progress:
            on_progress(len(texts) * stop // len(unique), len(texts))
    return vectors[rows]


def build_index(
    bd,
    db_name: str,
    provider: EmbeddingProvider,
    batch_size: int = 256,
    on_progress: Callable[[int, int], None] | None = None,
) -> VectorIndex:
    metas: list[dict] = []
    texts: list[str] = []
    for act in bd.Database(db_name):
        meta, text = activity_meta(act, db_name)
        metas.append(meta)
        texts.append(text)

    probe_dim = int(provider.embed(["probe"]).shape[1])
    index = VectorIndex(dim=probe_dim, provider=provider.name,
                        model=getattr(provider, "model", ""))
    index.add(embed_unique(provider, texts, probe_dim, batch_size, on_progress), metas)
    return index
