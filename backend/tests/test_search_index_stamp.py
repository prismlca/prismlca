"""The two index files are replaced one after the other; a crash in between left a
matrix of one build beside the metadata of another, and equal row counts hid it."""

from __future__ import annotations

import json

import numpy as np
import pytest

from prism_lca.search.index import VectorIndex


def test_an_index_whose_files_come_from_different_builds_is_refused(tmp_path):
    idx = VectorIndex(dim=2, provider="p", model="m")
    idx.matrix = np.zeros((1, 2), dtype="float32")
    idx.meta = [{"code": "a"}]
    idx.save(tmp_path / "db")
    assert VectorIndex.load(tmp_path / "db").meta == [{"code": "a"}]

    cfg = json.loads((tmp_path / "db.json").read_text(encoding="utf-8"))
    cfg["stamp"], cfg["meta"] = "another-build", [{"code": "b"}]
    (tmp_path / "db.json").write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(ValueError, match="different builds"):
        VectorIndex.load(tmp_path / "db")

    # An index written before the stamp existed still loads.
    cfg.pop("stamp")
    (tmp_path / "db.json").write_text(json.dumps(cfg), encoding="utf-8")
    assert VectorIndex.load(tmp_path / "db").meta == [{"code": "b"}]
