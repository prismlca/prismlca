"""BM25 lexical index — the sparse half of hybrid search.

Dense embeddings capture meaning ("Strom" ≈ electricity) but miss exact tokens (a specific
code, a norm like "EURO 6", a rare material name). BM25 covers that. Built in-house (no new
dependency) over each activity's name + reference product; an inverted index keeps queries fast
at ecoinvent scale (~26k docs). Deterministic → unit-testable.
"""
from __future__ import annotations

import math
import re
from collections import Counter

import numpy as np

_TOKEN = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    return _TOKEN.findall((text or "").lower())


class Bm25Index:
    def __init__(self, docs_tokens: list[list[str]], k1: float = 1.5, b: float = 0.75) -> None:
        self.k1 = k1
        self.b = b
        self.n = len(docs_tokens)
        self.doc_len = np.array([len(d) for d in docs_tokens], dtype="float32")
        self.avgdl = float(self.doc_len.mean()) if self.n else 0.0
        # inverted index: term -> list of (doc_index, term_freq)
        self.postings: dict[str, list[tuple[int, int]]] = {}
        df: Counter = Counter()
        for i, toks in enumerate(docs_tokens):
            for term, freq in Counter(toks).items():
                self.postings.setdefault(term, []).append((i, freq))
                df[term] += 1
        # BM25+ idf (always positive)
        self.idf = {t: math.log(1 + (self.n - n + 0.5) / (n + 0.5)) for t, n in df.items()}

    def scores(self, query: str) -> np.ndarray:
        """BM25 against this index's OWN corpus statistics."""
        return self.scores_with(query, self.idf, self.avgdl)

    def scores_with(self, query: str, idf: dict[str, float], avgdl: float) -> np.ndarray:
        """BM25 with statistics supplied from outside — the same postings, a different corpus.

        This is what lets several databases be searched as one without building a second index over
        their union. IDF and the average document length are the only corpus-dependent parts of
        BM25; term frequencies and document lengths belong to the document and do not change when
        the corpus around it grows. So the union's statistics (:func:`union_stats`) plus each
        index's own postings give **exactly** the scores a BM25 built over the concatenated corpus
        would give — measured against one, bit for bit, on 28 060 documents in three parts.

        Without this, merging databases means either a second posting index per ticked combination
        (2^D - 1 of them) or comparing scores whose IDF was computed over corpora of 26 533 and 50
        documents — where the same rare term is worth 9.78 in one and 3.53 in the other.
        """
        out = np.zeros(self.n, dtype="float32")
        if not self.n or avgdl <= 0:
            return out
        for term in set(tokenize(query)):
            weight = idf.get(term)
            postings = self.postings.get(term)
            # A term the union knows from ANOTHER database has no postings here — and a term this
            # index knows must still be weighted by the union, never by the local idf.
            if weight is None or not postings:
                continue
            for i, ftd in postings:
                denom = ftd + self.k1 * (1 - self.b + self.b * self.doc_len[i] / avgdl)
                out[i] += weight * (ftd * (self.k1 + 1)) / denom
        return out

    def top(self, query: str, k: int) -> list[tuple[int, float]]:
        """Return up to k (doc_index, score) with score > 0, best first."""
        scores = self.scores(query)
        nz = np.nonzero(scores)[0]
        if nz.size == 0:
            return []
        order = nz[np.argsort(-scores[nz])][:k]
        return [(int(i), float(scores[i])) for i in order]

    @property
    def length_total(self) -> float:
        """Summed document length — the numerator of a union's average (see :func:`union_stats`)."""
        return float(self.doc_len.sum()) if self.n else 0.0

    @classmethod
    def from_meta(cls, meta: list[dict]) -> Bm25Index:
        """Build from a VectorIndex's metadata (lexical view = name + reference product)."""
        docs = [tokenize(f"{m.get('name') or ''} {m.get('product') or ''}") for m in meta]
        return cls(docs)


def union_stats(indices: list[Bm25Index]) -> tuple[dict[str, float], float]:
    """The IDF and average document length of the CONCATENATION of these indices.

    Derived from what the indices already hold — ``len(postings[t])`` is the document frequency of
    ``t`` in that index, and document frequencies add up over disjoint corpora — so searching
    several databases together costs no second index and no rebuild. Pass the result to
    :meth:`Bm25Index.scores_with`.

    Preconditions, all met today because every index is built by :meth:`Bm25Index.from_meta`:
    the same tokenisation, the same notion of a document, and the same ``k1``/``b``.
    """
    total_docs = sum(idx.n for idx in indices)
    if not total_docs:
        return {}, 0.0
    avgdl = sum(idx.length_total for idx in indices) / total_docs
    df: dict[str, int] = {}
    for idx in indices:
        for term, postings in idx.postings.items():
            df[term] = df.get(term, 0) + len(postings)
    idf = {t: math.log(1 + (total_docs - n + 0.5) / (n + 0.5)) for t, n in df.items()}
    return idf, avgdl
