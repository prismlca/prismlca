"""Localize one or two levels deep (``depth`` on /activities/copy).

Depth 2 copies the dataset's direct suppliers along with it and wires the copy to them, so the model holds
a connected two-level chain. Whatever the depth, the result must not move until a copy is edited, and one
undo must take all of it back.
"""
from __future__ import annotations

import uuid

import pytest

from prism_lca.engine import commands
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import set_read_only


def _seed(bd) -> str:
    """steel ← 2 kWh elec + transport (two exchanges); transport ← elec + a little steel (a loop back);
    elec ← itself (losses). Returns the background database's name."""
    bio, bg = "bio-" + uuid.uuid4().hex[:6], "bg-" + uuid.uuid4().hex[:6]
    bd.Database(bio).write(
        {(bio, "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database(bg).write(
        {
            (bg, "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity", "location": "DE",
                "exchanges": [
                    {"input": (bg, "elec"), "amount": 1, "type": "production"},
                    {"input": (bg, "elec"), "amount": 0.1, "type": "technosphere"},
                    {"input": (bio, "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            (bg, "transport"): {
                "name": "transport, lorry", "unit": "tkm", "reference product": "transport", "location": "RER",
                "exchanges": [
                    {"input": (bg, "transport"), "amount": 1, "type": "production"},
                    {"input": (bg, "elec"), "amount": 0.05, "type": "technosphere"},
                    {"input": (bg, "steel"), "amount": 0.01, "type": "technosphere"},
                    {"input": (bio, "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
            (bg, "steel"): {
                "name": "steel production", "unit": "kg", "reference product": "steel", "location": "RER",
                "exchanges": [
                    {"input": (bg, "steel"), "amount": 1, "type": "production"},
                    {"input": (bg, "elec"), "amount": 2, "type": "technosphere"},
                    {"input": (bg, "transport"), "amount": 0.3, "type": "technosphere"},
                    {"input": (bg, "transport"), "amount": 0.2, "type": "technosphere"},
                    {"input": (bio, "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            },
        }
    )
    set_read_only(bg, True)
    bd.Method(("test", "gwp")).write([((bio, "co2"), 1.0)])
    return bg


def _model_with_frame(client, token, bg) -> tuple[str, str, str]:
    """A model whose one process draws 3 kg of the background steel. Returns (model, frame, input uid)."""
    fg = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": fg}, headers=token).status_code == 200
    r = client.post("/api/v1/model/activities", json={"database": fg, "name": "Frame", "unit": "unit"}, headers=token)
    frame = r.json()["activity"]["code"]
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": fg, "activity_code": frame, "input_database": bg, "input_code": "steel",
              "amount": 3.0},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return fg, frame, r.json()["exchange"]["uid"]


def _score(client, token, db, code) -> float:
    r = client.post("/api/v1/calc/lcia", json={"database": db, "code": code, "method": ["test", "gwp"]},
                    headers=token)
    assert r.status_code == 200, r.text
    return r.json()["score"]


def _inputs(client, token, db, code) -> list[tuple[str, str, float]]:
    detail = client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).json()
    return sorted(
        (e["input"]["database"], e["input"]["code"], e["amount"]) for e in detail["exchanges"]
        if e["type"] == "technosphere"
    )


def _localize(client, token, bg, fg, code, depth, **kw):
    return client.post(
        "/api/v1/model/activities/copy",
        json={"source_database": bg, "source_code": code, "target_database": fg, "relink_consumers": True,
              "depth": depth, **kw},
        headers=token,
    )


def test_depth_two_copies_the_suppliers_and_wires_the_copy_to_them(client, token, project):
    bg = _seed(get_bd())
    fg, frame, _ = _model_with_frame(client, token, bg)
    before = _score(client, token, fg, frame)

    r = _localize(client, token, bg, fg, "steel", 2)
    assert r.status_code == 200, r.text
    out = r.json()
    steel = out["activity"]["code"]
    assert out["relinked"] == 1
    twins = {tuple(s["from"]): s["code"] for s in out["suppliers"]}
    assert set(twins) == {(bg, "elec"), (bg, "transport")}  # one copy per supplier, two exchanges or not

    # The copy draws on the supplier copies, amounts untouched; the frame draws on the copy.
    assert _inputs(client, token, fg, steel) == sorted(
        [(fg, twins[(bg, "elec")], 2.0), (fg, twins[(bg, "transport")], 0.3), (fg, twins[(bg, "transport")], 0.2)]
    )
    assert _inputs(client, token, fg, frame) == [(fg, steel, 3.0)]
    # A supplier copy keeps drawing on what its original drew on — the background steel included, which
    # the relink of the model's consumers must not reach.
    assert _inputs(client, token, fg, twins[(bg, "transport")]) == [(bg, "elec", 0.05), (bg, "steel", 0.01)]
    assert _inputs(client, token, fg, twins[(bg, "elec")]) == [(bg, "elec", 0.1)]

    assert _score(client, token, fg, frame) == pytest.approx(before)


def test_depth_two_keeps_a_dataset_drawing_on_itself_a_loop_on_the_copy(client, token, project):
    bg = _seed(get_bd())
    fg = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": fg}, headers=token).status_code == 200

    r = _localize(client, token, bg, fg, "elec", 2)
    assert r.status_code == 200, r.text
    elec = r.json()["activity"]["code"]
    assert r.json()["suppliers"] == []  # its only supplier is itself
    assert _inputs(client, token, fg, elec) == [(fg, elec, 0.1)]
    assert _score(client, token, fg, elec) == pytest.approx(_score(client, token, bg, "elec"))


def test_one_undo_takes_the_whole_chain_back_and_redo_rebuilds_it_under_the_same_codes(client, token, project):
    bg = _seed(get_bd())
    fg, frame, uid = _model_with_frame(client, token, bg)

    r = _localize(client, token, bg, fg, "steel", 2)
    made = {r.json()["activity"]["code"], *(s["code"] for s in r.json()["suppliers"])}
    listed = lambda: {a["code"] for a in client.get(f"/api/v1/model/activities/{fg}", headers=token).json()}  # noqa: E731
    assert listed() == made | {frame}

    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert listed() == {frame}
    assert _inputs(client, token, fg, frame) == [(bg, "steel", 3.0)]

    assert client.post("/api/v1/model/redo", headers=token).status_code == 200
    assert listed() == made | {frame}
    (ex,) = [e for e in client.get(f"/api/v1/model/activities/{fg}/{frame}", headers=token).json()["exchanges"]
             if e["type"] == "technosphere"]
    assert ex["uid"] == uid and ex["input"]["database"] == fg


def test_depth_one_is_unchanged_and_names_no_suppliers(client, token, project):
    bg = _seed(get_bd())
    fg, frame, _ = _model_with_frame(client, token, bg)
    r = _localize(client, token, bg, fg, "steel", 1)
    assert r.status_code == 200, r.text
    assert "suppliers" not in r.json()
    steel = r.json()["activity"]["code"]
    assert _inputs(client, token, fg, steel) == [(bg, "elec", 2.0), (bg, "transport", 0.2), (bg, "transport", 0.3)]


def test_too_many_suppliers_is_refused_before_anything_is_written(client, token, project, monkeypatch):
    bg = _seed(get_bd())
    fg, frame, _ = _model_with_frame(client, token, bg)
    monkeypatch.setattr(commands, "LOCALIZE_SUPPLIER_LIMIT", 1)

    r = _localize(client, token, bg, fg, "steel", 2)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "too_many_suppliers"
    assert "2 datasets" in r.json()["error"]["message"]
    assert [a["code"] for a in client.get(f"/api/v1/model/activities/{fg}", headers=token).json()] == [frame]


def test_a_depth_other_than_one_or_two_is_refused(client, token, project):
    bg = _seed(get_bd())
    fg, _, _ = _model_with_frame(client, token, bg)
    r = _localize(client, token, bg, fg, "steel", 3)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_value"


def test_a_failure_halfway_leaves_no_copy_behind(client, token, project, monkeypatch):
    bg = _seed(get_bd())
    fg, frame, _ = _model_with_frame(client, token, bg)
    real, calls = commands._copy_exchanges, []

    def flaky(src, new, uids=None):
        calls.append(src.key)
        if len(calls) == 3:  # the dataset, the first supplier, then this
            raise RuntimeError("disk full")
        return real(src, new, uids)

    monkeypatch.setattr(commands, "_copy_exchanges", flaky)
    with pytest.raises(RuntimeError):
        _localize(client, token, bg, fg, "steel", 2)
    assert [a["code"] for a in client.get(f"/api/v1/model/activities/{fg}", headers=token).json()] == [frame]
    assert _inputs(client, token, fg, frame) == [(bg, "steel", 3.0)]
