"""The system-model figure's data: what is drawn, what is folded, and the shares the nodes carry."""
from __future__ import annotations

from prism_lca.engine import report_graph


def _graph(n_bg: int) -> dict:
    """A foreground of two processes (bottle ← cap) with `n_bg` background inputs into the bottle."""
    bg_nodes = [
        {"id": f"eco/bg{i}", "name": f"market {i}", "location": "GLO", "unit": "kg", "product": f"p{i}",
         "external": True, "upstream": -1, "tags": []}
        for i in range(n_bg)
    ]
    return {
        "database": "m",
        "nodes": [
            {"id": "m/bottle", "name": "bottle", "location": "DE", "unit": "unit", "product": "bottle",
             "external": False, "upstream": 0, "tags": [{"dimension": "Stage", "value": "Production"}]},
            {"id": "m/cap", "name": "cap", "location": "DE", "unit": "unit", "product": "cap",
             "external": False, "upstream": 0, "tags": []},
        ],
        "edges": [{"uid": "e1", "type": "technosphere", "amount": 1.0, "source": "m/cap", "target": "m/bottle"}],
        "bg_edges": [
            {"uid": f"b{i}", "type": "technosphere", "amount": float(i + 1), "source": f"eco/bg{i}", "target": "m/bottle"}
            for i in range(n_bg)
        ],
        "bg_nodes": bg_nodes,
    }


def _tree(n_bg: int) -> dict:
    """Shares: bg0 the largest, descending — the opposite of the amounts, so the ranking rule is visible."""
    return {
        "db": "m", "c": "bottle", "shr": 1.0,
        "ch": [
            {"db": "m", "c": "cap", "shr": 0.1, "ch": []},
            *[{"db": "eco", "c": f"bg{i}", "shr": round(0.5 / (i + 1), 4), "ch": []} for i in range(n_bg)],
        ],
    }


def test_folds_everything_beyond_the_largest_inputs_per_process(monkeypatch):
    monkeypatch.setattr(report_graph.model_graph, "graph", lambda db: _graph(6))
    out = report_graph.system_model("m", _tree(6), per_process=4)
    external = [n for n in out["nodes"] if n["external"] and not n["folded"]]
    folded = [n for n in out["nodes"] if n["folded"]]
    # The four largest BY SHARE (bg0..bg3), not by amount (which would be bg5..bg2).
    assert sorted(n["id"] for n in external) == ["eco/bg0", "eco/bg1", "eco/bg2", "eco/bg3"]
    assert len(folded) == 1 and folded[0]["folded"] == 2
    assert abs(folded[0]["share"] - (0.5 / 5 + 0.5 / 6)) < 1e-3  # the tree's shares are rounded
    assert out["counts"] == {"processes": 2, "datasets": 6, "folded": 2, "has_shares": True}
    # Every edge points at a node that exists in the picture.
    ids = {n["id"] for n in out["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in out["edges"])


def test_without_a_tree_the_amount_ranks_and_shares_are_absent(monkeypatch):
    monkeypatch.setattr(report_graph.model_graph, "graph", lambda db: _graph(5))
    out = report_graph.system_model("m", None, per_process=2)
    external = [n for n in out["nodes"] if n["external"] and not n["folded"]]
    assert sorted(n["id"] for n in external) == ["eco/bg3", "eco/bg4"]  # the two largest amounts
    assert all(n["share"] is None for n in out["nodes"])
    assert out["counts"]["has_shares"] is False


def test_background_can_be_left_out_entirely(monkeypatch):
    monkeypatch.setattr(report_graph.model_graph, "graph", lambda db: _graph(3))
    out = report_graph.system_model("m", _tree(3), background=False)
    assert all(not n["external"] for n in out["nodes"])
    assert out["counts"]["datasets"] == 0 and out["counts"]["folded"] == 0
    # The foreground link survives, with the share the tree gives the cap.
    assert out["edges"] == [
        {"source": "m/cap", "target": "m/bottle", "amount": 1.0, "unit": "unit", "share": 0.1}
    ]


def test_a_model_without_background_inputs_is_just_its_processes(monkeypatch):
    monkeypatch.setattr(report_graph.model_graph, "graph", lambda db: _graph(0))
    out = report_graph.system_model("m", _tree(0))
    assert [n["id"] for n in out["nodes"]] == ["m/bottle", "m/cap"]
    assert out["nodes"][0]["tags"] == [{"dimension": "Stage", "value": "Production"}]


def test_per_process_is_clamped(monkeypatch):
    monkeypatch.setattr(report_graph.model_graph, "graph", lambda db: _graph(3))
    assert report_graph.system_model("m", None, per_process=999)["per_process"] == report_graph.MAX_PER_PROCESS
    assert report_graph.system_model("m", None, per_process=-3)["per_process"] == 0


def test_a_fold_of_one_is_not_folded(monkeypatch):
    """"+ 1 further dataset" costs the box the dataset itself would have cost, and says less."""
    monkeypatch.setattr(report_graph.model_graph, "graph", lambda db: _graph(5))
    out = report_graph.system_model("m", _tree(5), per_process=4)
    assert not [n for n in out["nodes"] if n["folded"]]
    assert len([n for n in out["nodes"] if n["external"]]) == 5
    assert out["counts"]["folded"] == 0

