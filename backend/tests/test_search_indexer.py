"""Building an index embeds each distinct text once — and nothing the index holds or shows changes for it."""

from __future__ import annotations

import numpy as np

from prism_lca.search.embeddings import HashingEmbedding
from prism_lca.search.indexer import activity_meta, build_index, embed_unique


class _Counting(HashingEmbedding):
    """The hashing embedding, remembering every text it was asked for."""

    def __init__(self) -> None:
        super().__init__()
        self.seen: list[str] = []

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        self.seen.extend(texts)
        return super().embed(texts, is_query)


class _Bd:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def Database(self, name: str) -> list[dict]:  # noqa: N802 — Brightway's spelling
        return self._rows


def _market(code: str, geo: str, product: str = "electricity, medium voltage") -> dict:
    return {"code": code, "name": f"market for {product}", "reference product": product,
            "location": geo, "unit": "kWh", "comment": "This is a market activity."}


ROWS = [
    _market("m_de", "DE"),
    {"code": "steel", "name": "steel production, electric", "reference product": "steel", "location": "RER",
     "unit": "kg", "comment": "Electric arc furnace."},
    _market("m_fr", "FR"),
    _market("m_ch", "CH"),
    _market("s_glo", "GLO", product="steel"),
]


def test_a_repeated_text_is_embedded_once_and_every_row_keeps_its_vector():
    provider = _Counting()
    index = build_index(_Bd(ROWS), "db", provider, batch_size=2)

    assert sorted(provider.seen) == sorted({*provider.seen})  # nothing twice…
    assert len(provider.seen) == 1 + 3  # …the probe, then three distinct texts for five rows
    assert [m["code"] for m in index.meta] == ["m_de", "steel", "m_fr", "m_ch", "s_glo"]
    assert [m["geo"] for m in index.meta] == ["DE", "RER", "FR", "CH", "GLO"]
    # The very vectors embedding each row on its own gives: the index is what it was, only built faster.
    alone = HashingEmbedding()
    expected = alone.embed([activity_meta(r, "db")[1] for r in ROWS])
    assert index.matrix.shape == (5, alone.dim)
    assert np.array_equal(index.matrix, expected)


def test_progress_counts_every_row_and_moves_with_the_work():
    """The bar shows the database's real size, repeats included — a smaller number than the user knows
    would read as datasets gone missing. It advances per distinct text, so the time estimate holds."""
    steps: list[tuple[int, int]] = []
    build_index(_Bd(ROWS), "db", _Counting(), batch_size=1, on_progress=lambda d, t: steps.append((d, t)))

    assert {t for _, t in steps} == {5}
    assert steps[0] == (0, 5) and steps[-1] == (5, 5)
    done = [d for d, _ in steps]
    assert done == sorted(done)
    # Three distinct texts, so three equal steps of work — not "four rows at once" after the first market.
    assert done == [0, 1, 3, 5]


def test_nothing_to_embed_is_an_empty_matrix_of_the_right_width():
    provider = _Counting()
    out = embed_unique(provider, [], dim=provider.dim)
    assert out.shape == (0, provider.dim)
    assert provider.seen == []
