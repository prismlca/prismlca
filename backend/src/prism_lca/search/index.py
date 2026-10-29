"""Persisted NumPy cosine vector index.

Adequate for ecoinvent-scale (~20k activities × ~768 dims ≈ 60 MB, brute-force cosine is
fast). An ANN backend (hnsw/chroma) can slot in behind the same interface later.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import numpy as np


class VectorIndex:
    def __init__(self, dim: int, provider: str, model: str = "") -> None:
        self.dim = dim
        self.provider = provider
        #: Which model produced these vectors. Empty for older indices — those
        #: fall back to the provider+dimension check, which is all they ever had.
        self.model = model
        self.matrix = np.zeros((0, dim), dtype="float32")
        self.meta: list[dict] = []
        #: Counts the changes to the rows. What is derived from them and kept beside the index (the blended
        #: market vectors, search/market_vectors.py) is stamped with it: a drop and an add of as many rows
        #: leave the length unchanged and every row position moved.
        self.generation = 0

    def add(self, vectors: np.ndarray, metas: list[dict]) -> None:
        if vectors.shape[0] == 0:
            return
        if vectors.shape[1] != self.dim:
            raise ValueError(f"vector dim {vectors.shape[1]} != index dim {self.dim}")
        self.matrix = np.vstack([self.matrix, vectors.astype("float32")])
        self.meta.extend(metas)
        self.generation += 1

    def drop(self, codes: set[str]) -> int:
        """Forget these activities. Returns how many rows went.

        The counterpart to :meth:`add`, and the reason the index survives a deletion at all: without
        it, removing datasets means throwing the whole index away and re-embedding everything that
        stayed. A hit whose activity no longer resolves reads as corruption, so leaving them in is
        not an option either.
        """
        if not codes:
            return 0
        keep = [i for i, m in enumerate(self.meta) if m.get("code") not in codes]
        gone = len(self.meta) - len(keep)
        if not gone:
            return 0
        self.matrix = self.matrix[keep] if keep else np.zeros((0, self.dim), dtype="float32")
        self.meta = [self.meta[i] for i in keep]
        self.generation += 1
        return gone

    def __len__(self) -> int:
        return len(self.meta)

    def query(self, qvec: np.ndarray, top_k: int) -> list[tuple[float, dict]]:
        if self.matrix.shape[0] == 0:
            return []
        scores = self.matrix @ np.asarray(qvec, dtype="float32")
        k = min(top_k, scores.shape[0])
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top])]
        return [(float(scores[i]), self.meta[i]) for i in top]

    # NB: append suffixes as strings, not Path.with_suffix — database names contain dots
    # (e.g. "ecoinvent-3.12-cutoff"), and with_suffix would mangle them to "ecoinvent-3.npz"
    # (and collide "…-3.9" with "…-3.12").
    @staticmethod
    def _npz(base: Path) -> Path:
        return Path(str(base) + ".npz")

    @staticmethod
    def _json(base: Path) -> Path:
        return Path(str(base) + ".json")

    def save(self, base: Path) -> None:
        """Atomic per file (tmp + rename): a crash mid-save must not leave a half-written file.
        The two files can still be from different generations after a crash between renames —
        load() detects that via the matrix/meta consistency check."""
        base.parent.mkdir(parents=True, exist_ok=True)
        # One stamp written into both files: a crash between the two renames leaves a matrix of one
        # generation beside the metadata of another, and equal row counts hid that — vectors were
        # served for the wrong datasets. Older indexes carry no stamp and load.
        stamp = uuid.uuid4().hex
        npz_tmp = Path(str(base) + ".npz.tmp")
        with npz_tmp.open("wb") as fh:
            np.savez(fh, matrix=self.matrix, stamp=np.array(stamp))
        npz_tmp.replace(self._npz(base))
        json_tmp = Path(str(base) + ".json.tmp")
        json_tmp.write_text(
            json.dumps({"dim": self.dim, "provider": self.provider, "model": self.model,
                        "meta": self.meta, "stamp": stamp}),
            encoding="utf-8",
        )
        json_tmp.replace(self._json(base))

    @classmethod
    def load(cls, base: Path) -> VectorIndex:
        cfg = json.loads(cls._json(base).read_text(encoding="utf-8"))
        idx = cls(dim=cfg["dim"], provider=cfg["provider"], model=cfg.get("model", ""))
        loaded = np.load(cls._npz(base))
        idx.matrix = loaded["matrix"].astype("float32")
        idx.meta = cfg["meta"]
        on_disk = str(loaded["stamp"]) if "stamp" in loaded.files else None
        if on_disk and cfg.get("stamp") and on_disk != cfg["stamp"]:
            raise ValueError(
                f"Search index at {base} is inconsistent (matrix and metadata are from different "
                "builds) — likely a crashed save. Rebuild it."
            )
        if idx.matrix.shape[0] != len(idx.meta) or (len(idx.meta) and idx.matrix.shape[1] != idx.dim):
            raise ValueError(
                f"Search index at {base} is inconsistent (matrix {idx.matrix.shape} vs "
                f"{len(idx.meta)} meta rows, dim {idx.dim}) — likely a crashed save. Rebuild it."
            )
        return idx

    @staticmethod
    def exists(base: Path) -> bool:
        return VectorIndex._npz(base).exists() and VectorIndex._json(base).exists()

    @staticmethod
    def remove(base: Path) -> bool:
        """Delete both files of an index. Returns whether anything was there.

        Needed when the indexed database itself goes away: a leftover index still answers
        searches with activity ids that no longer resolve.
        """
        removed = False
        for path in (VectorIndex._npz(base), VectorIndex._json(base)):
            if path.exists():
                path.unlink()
                removed = True
        return removed
