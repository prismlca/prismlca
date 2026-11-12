"""A model rename rewrites the name where Brightway stores it, and the model afterwards is the one it was.

bw2data's own ``Database.rename`` copied the whole model and vacuumed the whole inventory file after it
(V469). The in-place rename (``engine/model_rename.py``) has to reach the same end state — the same rows,
parameters and scores — while keeping row ids, taking along the inputs other models draw from the model,
and leaving the model untouched when it fails half-way.
"""

from __future__ import annotations

import copy
import json
import threading
from pathlib import Path

import pytest

from prism_lca.engine.bootstrap import get_bd

GWP = ["test", "gwp"]


def _post(client, token, path: str, body: dict) -> dict:
    r = client.post(path, json=body, headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def _seed_background() -> None:
    """A biosphere flow, one background process and a method: electricity emits 0.5 kg CO2 per kWh."""
    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("bg").write(
        {
            ("bg", "elec"): {
                "name": "electricity, synthetic",
                "unit": "kWh",
                "reference product": "electricity",
                "location": "GLO",
                "exchanges": [
                    {"input": ("bg", "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(tuple(GWP)).write([(("biosphere", "co2"), 1.0)])


def _activity(client, token, db: str, name: str) -> str:
    body = {"database": db, "name": name, "unit": "kg"}
    return _post(client, token, "/api/v1/model/activities", body)["activity"]["code"]


def _edge(client, token, db, code, input_db, input_code, amount, kind="technosphere") -> str:
    body = {
        "activity_database": db, "activity_code": code, "input_database": input_db,
        "input_code": input_code, "amount": amount, "type": kind,
    }
    return _post(client, token, "/api/v1/model/exchanges", body)["exchange"]["uid"]


def _model(client, token, db: str) -> dict:
    """A bottle of six parts (``mass * 3`` with mass = 2) and 2 kWh; a part takes 1 kWh and emits 0.2 kg.
    Score of the bottle: 6 × 0.7 + 1.0 = 5.2."""
    _post(client, token, "/api/v1/databases/foreground", {"name": db})
    bottle = _activity(client, token, db, "widget bottle")
    part = _activity(client, token, db, "widget part")
    _edge(client, token, db, part, "bg", "elec", 1.0)
    co2 = _edge(client, token, db, part, "biosphere", "co2", 0.2, kind="biosphere")
    parts = _edge(client, token, db, bottle, db, part, 0.0)
    _edge(client, token, db, bottle, "bg", "elec", 2.0)
    _post(client, token, "/api/v1/params", {"database": db, "name": "mass", "amount": 2.0})
    _post(client, token, "/api/v1/params/exchange-formula", {
        "activity_database": db, "activity_code": bottle, "uid": parts, "formula": "mass * 3",
    })
    return {"bottle": bottle, "part": part, "parts": parts, "co2": co2}


def _score(client, token, db: str, code: str) -> float:
    return _post(client, token, "/api/v1/calc/lcia", {"database": db, "code": code, "method": GWP})["score"]


def _rename(client, token, old: str, new: str):
    return client.post("/api/v1/databases/foreground/rename", json={"database": old, "name": new}, headers=token)


def _state(db: str, *, ids: bool = True) -> dict:
    """What bw2data holds for model ``db``: rows, parameters, groups and the registry entry. With
    ``ids=False`` row ids and the random names of bw2data's placeholder parameters are left out, so a
    copy can be compared with the original."""
    from bw2data.backends import ActivityDataset, ExchangeDataset
    from bw2data.parameters import (
        ActivityParameter,
        DatabaseParameter,
        Group,
        GroupDependency,
        ParameterizedExchange,
    )

    bd = get_bd()
    nodes = {}
    for row in ActivityDataset.select().where(ActivityDataset.database == db):
        data = dict(row.data)
        if not ids:
            data.pop("id", None)
        nodes[row.code] = (row.id if ids else None, row.database, row.name, row.location, row.product, data)
    edges, by_id = {}, {}
    for row in ExchangeDataset.select().where(
        (ExchangeDataset.output_database == db) | (ExchangeDataset.input_database == db)
    ):
        key = (row.output_database, row.output_code, row.data.get("prism_uid"))
        by_id[row.id] = key
        edges[key] = (row.id if ids else None, row.input_database, row.input_code, row.type, dict(row.data))
    params = {
        p.name: (p.amount, p.formula, p.data) for p in DatabaseParameter.select().where(DatabaseParameter.database == db)
    }
    activity_params = sorted(
        (p.group, p.database, p.code, p.name if ids or not p.name.startswith("__dummy_") else "__dummy__",
         p.formula, p.amount, p.id if ids else None)
        for p in ActivityParameter.select().where(ActivityParameter.database == db)
    )
    groups = {p[0] for p in activity_params} | {db}
    return {
        "nodes": nodes,
        "edges": edges,
        "params": params,
        "activity_params": activity_params,
        "groups": sorted((g.name, g.fresh, list(g.order)) for g in Group.select().where(Group.name << list(groups))),
        "depends_on": sorted(
            (d.group, d.depends) for d in GroupDependency.select().where(GroupDependency.group << list(groups))
        ),
        "formulas": sorted(
            (pe.group, by_id.get(pe.exchange), pe.formula)
            for pe in ParameterizedExchange.select().where(ParameterizedExchange.group << list(groups))
        ),
        # Times, and `dirty`, which bw2data drops after a calculation and sets False after processing.
        "registry": {
            k: v for k, v in bd.databases.data.get(db, {}).items() if k not in ("modified", "processed", "dirty")
        },
    }


def _renamed(state: dict, old: str, new: str) -> dict:
    """``state`` as it reads after renaming ``old`` to ``new``: every database name and our group names
    substituted, nothing else."""
    def sub(value):
        if isinstance(value, str):
            if value == old:
                return new
            prefix = f"prism__{old}__"
            return f"prism__{new}__" + value[len(prefix):] if value.startswith(prefix) else value
        if isinstance(value, tuple):
            return tuple(sub(v) for v in value)
        if isinstance(value, list):
            return [sub(v) for v in value]
        if isinstance(value, dict):
            return {sub(k): sub(v) for k, v in value.items()}
        return value

    return sub(state)


def test_a_rename_keeps_every_row_its_id_and_its_score_and_renaming_back_restores_the_model(
    client, token, project
):
    del project
    _seed_background()
    m = _model(client, token, "Bottle A")
    before = _score(client, token, "Bottle A", m["bottle"])
    assert before == pytest.approx(5.2)
    snapshot = _state("Bottle A")

    r = _rename(client, token, "Bottle A", "Bottle C")
    assert r.status_code == 200, r.text
    after = _state("Bottle C")
    # Same rows under the same ids — the pickled copies of the name included — same parameters and groups.
    assert after == _renamed(snapshot, "Bottle A", "Bottle C")
    assert _state("Bottle A")["nodes"] == {} and _state("Bottle A")["params"] == {}
    assert _score(client, token, "Bottle C", m["bottle"]) == pytest.approx(before)
    data = get_bd().Database("Bottle C").load()  # reads the pickled rows as stored
    assert set(data) == {("Bottle C", m["bottle"]), ("Bottle C", m["part"])}
    assert all(e["output"][0] == "Bottle C" for node in data.values() for e in node["exchanges"])

    # The formula still answers to the parameter under the new name.
    _post(client, token, "/api/v1/params", {"database": "Bottle C", "name": "mass", "amount": 3.0})
    assert _score(client, token, "Bottle C", m["bottle"]) == pytest.approx(9 * 0.7 + 1.0)
    _post(client, token, "/api/v1/params", {"database": "Bottle C", "name": "mass", "amount": 2.0})

    # A rename is not a step on the undo stack; renaming back is how it is taken back, and it restores
    # the model exactly — ids included.
    assert _rename(client, token, "Bottle C", "Bottle A").status_code == 200
    assert _state("Bottle A")["nodes"] == snapshot["nodes"]
    assert _state("Bottle A")["edges"] == snapshot["edges"]
    assert _state("Bottle A")["formulas"] == snapshot["formulas"]
    assert _score(client, token, "Bottle A", m["bottle"]) == pytest.approx(before)


def test_the_result_is_the_one_bw2datas_copying_rename_gave(client, token, project):
    """The same model renamed both ways: the rows, parameters and groups agree, apart from what the copy
    could not keep — row ids and the names of bw2data's placeholder parameters — the activity type,
    which ``Database.write`` sets anew for every process with a production exchange of its own, and the
    counts ``Database.write`` keeps in the registry."""
    del project
    _seed_background()
    from prism_lca.engine import params

    m = _model(client, token, "Bottle A")
    assert _rename(client, token, "Bottle A", "Bottle C").status_code == 200
    in_place = _state("Bottle C", ids=False)
    assert _rename(client, token, "Bottle C", "Bottle A").status_code == 200

    bd = get_bd()
    dump = params.dump_params("Bottle A")
    bd.Database("Bottle A").rename("Bottle C")
    params.load_params("Bottle C", dump)
    params.reregister_database_groups("Bottle C")
    copied = _state("Bottle C", ids=False)

    for state in (in_place, copied):
        for node in state["nodes"].values():
            node[-1].pop("type", None)
        # Bookkeeping Database.write redoes from the rows and the app never reads: the in-place rename
        # leaves it as it was.
        for key in ("number", "geocollections"):
            state["registry"].pop(key, None)
    assert in_place == copied
    assert _score(client, token, "Bottle C", m["bottle"]) == pytest.approx(5.2)


def test_inputs_from_other_models_and_activity_groups_follow_the_rename(client, token, project):
    """What the copying rename lost: another model's input from this one pointed at nothing afterwards,
    and activity parameters in a group of their own were deleted with the old database."""
    del project
    _seed_background()
    from bw2data.parameters import parameters

    bd = get_bd()
    m = _model(client, token, "Bottle A")
    _post(client, token, "/api/v1/databases/foreground", {"name": "Crate"})
    crate = _activity(client, token, "Crate", "widget crate")
    _edge(client, token, "Crate", crate, "Bottle A", m["part"], 3.0)
    # The part's emission from two activity parameters in a group someone else named.
    parameters.new_activity_parameters(
        [
            {"database": "Bottle A", "code": m["part"], "name": "k1", "amount": 4.0},
            {"database": "Bottle A", "code": m["part"], "name": "k2", "formula": "k1 * 2"},
        ],
        "widget params",
    )
    part = bd.get_activity(("Bottle A", m["part"]))
    co2 = next(e for e in part.exchanges() if e.get("prism_uid") == m["co2"])
    co2["formula"] = "k2 / 40"
    co2.save()
    parameters.add_exchanges_to_group("widget params", part)
    parameters.recalculate()
    crate_before = _score(client, token, "Crate", crate)
    assert crate_before == pytest.approx(3 * 0.7)
    assert "Bottle A" in bd.databases["Crate"]["depends"]

    assert _rename(client, token, "Bottle A", "Bottle C").status_code == 200
    depends = bd.databases["Crate"]["depends"]
    assert "Bottle C" in depends and "Bottle A" not in depends
    edge = next(e for e in bd.get_activity(("Crate", crate)).technosphere())
    assert edge.input.key == ("Bottle C", m["part"])
    assert edge._document.data["input"] == ("Bottle C", m["part"])
    assert _score(client, token, "Crate", crate) == pytest.approx(crate_before)

    from bw2data.parameters import ActivityParameter, ParameterizedExchange

    from prism_lca.engine.lca import invalidate_lca_cache

    group = {(p.name, p.database) for p in ActivityParameter.select().where(ActivityParameter.group == "widget params")}
    assert group == {("k1", "Bottle C"), ("k2", "Bottle C")}
    assert ParameterizedExchange.select().where(ParameterizedExchange.group == "widget params").count() == 1
    # Still alive: a new k1 moves the part's emission (16 / 40 = 0.4 instead of 0.2).
    parameters.new_activity_parameters(
        [{"database": "Bottle C", "code": m["part"], "name": "k1", "amount": 8.0}], "widget params"
    )
    co2 = next(e for e in bd.get_activity(("Bottle C", m["part"])).exchanges() if e.get("prism_uid") == m["co2"])
    assert co2["amount"] == pytest.approx(0.4)
    invalidate_lca_cache()  # the parameter changed under bw2data, past the app's own invalidation
    assert _score(client, token, "Crate", crate) == pytest.approx(3 * 0.9)


def test_the_renamed_model_is_listed_found_and_keeps_its_stores(client, token, project):
    del project
    _seed_background()
    from prism_lca.engine.study import StudyMetaStore
    from prism_lca.engine.tags import TagStore

    m = _model(client, token, "Bottle A")
    TagStore().add("Bottle A", m["part"], "phase", "Production")
    StudyMetaStore().update("Bottle A", {"goal": "a synthetic goal"})
    assert _rename(client, token, "Bottle A", "Bottle C").status_code == 200

    names = {d["name"] for d in client.get("/api/v1/databases", headers=token).json()}
    assert "Bottle C" in names and "Bottle A" not in names
    listed = client.get("/api/v1/model/activities/Bottle C", headers=token).json()
    assert {a["name"] for a in listed} == {"widget bottle", "widget part"}
    found = client.get("/api/v1/search/list", params={"database": "Bottle C"}, headers=token).json()
    assert {h["name"] for h in found["hits"]} == {"widget bottle", "widget part"}
    assert client.get("/api/v1/search/list", params={"database": "Bottle A"}, headers=token).status_code == 404
    assert TagStore().list_for("Bottle C", m["part"]) and not TagStore().list_for("Bottle A", m["part"])
    assert StudyMetaStore().get("Bottle C").get("goal") == "a synthetic goal"


@pytest.mark.parametrize("failing", ["parameters", "registry", "after the registry"])
def test_a_failure_half_way_leaves_the_model_as_it_was(client, token, project, monkeypatch, failing):
    """A failure inside the parameter transaction rolls both back. The registry is written after the
    parameters have committed, so a failure there — or one after it, before the inventory commits — has to
    move the parameters back by hand and put the registry back, on disk too."""
    del project
    _seed_background()
    from prism_lca.engine import model_rename

    m = _model(client, token, "Bottle A")
    _post(client, token, "/api/v1/databases/foreground", {"name": "Crate"})
    crate = _activity(client, token, "Crate", "widget crate")
    _edge(client, token, "Crate", crate, "Bottle A", m["part"], 3.0)
    _score(client, token, "Crate", crate)  # processed: Crate's registry entry names Bottle A
    snapshot, crate_rows = _state("Bottle A"), _state("Crate")
    bd = get_bd()
    registry = copy.deepcopy(bd.databases.data)

    def boom(*args, **kwargs):
        raise RuntimeError("synthetic failure")

    real_move = model_rename._move_registry_entry

    def move_then_boom(*args, **kwargs):
        real_move(*args, **kwargs)
        raise RuntimeError("synthetic failure")

    replaced = {
        "parameters": ("_rename_parameters", boom),
        "registry": ("_move_registry_entry", boom),
        "after the registry": ("_move_registry_entry", move_then_boom),
    }[failing]
    monkeypatch.setattr(model_rename, *replaced)
    with pytest.raises(RuntimeError):
        _rename(client, token, "Bottle A", "Bottle C")
    monkeypatch.undo()

    assert _state("Bottle A") == snapshot
    assert _state("Crate") == crate_rows
    assert _state("Bottle C")["nodes"] == {} and _state("Bottle C")["params"] == {}
    assert bd.databases.data == registry
    assert json.loads(Path(bd.databases.filepath).read_text(encoding="utf-8")) == json.loads(json.dumps(registry))
    assert _score(client, token, "Bottle A", m["bottle"]) == pytest.approx(5.2)
    # And the rename still goes through afterwards.
    assert _rename(client, token, "Bottle A", "Bottle C").status_code == 200
    assert _score(client, token, "Crate", crate) == pytest.approx(3 * 0.7)


def test_groups_left_under_the_new_name_are_cleared(client, token, project):
    """A model once called by the new name can leave groups behind (bw2data keeps them when it deletes a
    database), and our activity groups carry the model's name: renaming back is exactly that case."""
    del project
    _seed_background()
    from bw2data.parameters import Group, GroupDependency

    from prism_lca.engine.params import _group_name

    m = _model(client, token, "Bottle A")
    left = _group_name("Bottle C", m["bottle"])
    Group.create(name="Bottle C")
    Group.create(name=left)
    GroupDependency.create(group=left, depends="Bottle C")

    assert _rename(client, token, "Bottle A", "Bottle C").status_code == 200
    params = client.get("/api/v1/params", params={"database": "Bottle C"}, headers=token).json()
    assert {p["name"]: p["amount"] for p in params} == {"mass": 2.0}
    assert _score(client, token, "Bottle C", m["bottle"]) == pytest.approx(5.2)


def test_parameters_left_under_the_new_name_stop_the_rename_and_stay(client, token, project):
    """Parameter rows under a name no database has are what a crash between the two commits leaves: they
    are somebody's values, so the rename neither drops them nor mixes them into the model."""
    del project
    _seed_background()
    from bw2data.parameters import DatabaseParameter

    _model(client, token, "Bottle A")
    DatabaseParameter.create(database="Bottle C", name="mass", amount=99.0)
    snapshot = _state("Bottle A")

    r = _rename(client, token, "Bottle A", "Bottle C")
    assert r.status_code == 409 and r.json()["error"]["code"] == "name_in_use", r.text
    assert _state("Bottle A") == snapshot
    left = DatabaseParameter.select().where(DatabaseParameter.database == "Bottle C")
    assert [(p.name, p.amount) for p in left] == [("mass", 99.0)]


def test_a_rename_waits_until_a_scenario_window_has_restored_the_baseline(client, token, project):
    """A scenario calculation writes its overrides into the model's parameters and restores them, holding
    the calculation lock. A rename in between carried the overrides off under the new name."""
    del project
    _seed_background()
    from prism_lca.engine import lca, params

    m = _model(client, token, "Bottle A")
    answers: list[int] = []
    renamed = threading.Event()

    def rename() -> None:
        answers.append(_rename(client, token, "Bottle A", "Bottle C").status_code)
        renamed.set()

    with lca._LCA_LOCK:
        params.apply_values("Bottle A", {"mass": 99.0})  # the window opens
        worker = threading.Thread(target=rename)
        worker.start()
        assert not renamed.wait(1.0), "the rename ran inside the scenario window"
        params.apply_values("Bottle A", {"mass": 2.0})  # …and restores the baseline
    worker.join(60)
    assert answers == [200]
    values = client.get("/api/v1/params", params={"database": "Bottle C"}, headers=token).json()
    assert {p["name"]: p["amount"] for p in values} == {"mass": 2.0}
    assert _score(client, token, "Bottle C", m["bottle"]) == pytest.approx(5.2)


def test_a_group_of_another_database_under_the_new_name_stops_the_rename(client, token, project):
    del project
    _seed_background()
    from bw2data.parameters import parameters

    _model(client, token, "Bottle A")
    _post(client, token, "/api/v1/databases/foreground", {"name": "Other"})
    other = _activity(client, token, "Other", "widget other")
    parameters.new_activity_parameters([{"database": "Other", "code": other, "name": "z", "amount": 1.0}], "Bottle C")
    snapshot = _state("Bottle A")

    r = _rename(client, token, "Bottle A", "Bottle C")
    assert r.status_code == 409 and r.json()["error"]["code"] == "name_in_use", r.text
    assert _state("Bottle A") == snapshot
    assert "Bottle C" not in get_bd().databases


def test_a_model_with_an_input_whose_process_is_gone_can_still_be_renamed(client, token, project):
    """Processing such a model fails (bw2data cannot place the input in the matrix), and the copying rename
    failed with it — half-way, with the rows written twice. The name is what a rename changes: it goes
    through, and the model stays marked for processing, so the next calculation reports the input."""
    del project
    _seed_background()
    from bw2data.backends import ActivityDataset

    m = _model(client, token, "Bottle A")
    ActivityDataset.delete().where((ActivityDataset.database == "bg") & (ActivityDataset.code == "elec")).execute()

    assert _rename(client, token, "Bottle A", "Bottle C").status_code == 200
    bd = get_bd()
    assert set(bd.Database("Bottle C").load()) == {("Bottle C", m["bottle"]), ("Bottle C", m["part"])}
    assert bd.databases["Bottle C"]["dirty"] is True
    assert "Bottle A" not in bd.databases


def test_a_database_that_still_keeps_bw2datas_full_text_index_has_it_under_the_new_name(
    client, token, project
):
    """The app turns bw2data's own index off (engine/hygiene.py); a database that still has it on gets the
    index rebuilt under the new name, as bw2data's rename did, and the old one emptied."""
    del project
    _seed_background()
    bd = get_bd()
    _model(client, token, "Bottle A")
    bd.databases["Bottle A"]["searchable"] = True
    bd.Database("Bottle A").make_searchable(reset=True)
    assert len(bd.Database("Bottle A").search("widget")) == 2

    assert _rename(client, token, "Bottle A", "Bottle C").status_code == 200
    found = bd.Database("Bottle C").search("widget")
    assert {act.key[0] for act in found} == {"Bottle C"} and len(found) == 2
    from bw2data.search import IndexManager

    old_index = IndexManager(bd.Database("Bottle A").filename)
    assert old_index.search("widget") == []
