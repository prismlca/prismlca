"""Tags on inputs: setting them, refusing them where they do not belong, and keeping them through every
operation that copies or re-keys an exchange.

An input's tag is stored under the consumer's key plus the exchange uid. Every path that gives a copied
exchange a new uid has to carry it — these tests are the proof per path; test_uid_copy_paths.py makes sure
no new path appears unexamined.
"""
from __future__ import annotations

import base64
import uuid

import pytest

from prism_lca.engine.bootstrap import get_bd

METHOD = ["t", "gwp"]
PHASE = "Life-cycle phase"
_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _world(client, token) -> dict:
    """bg (read-only): steel emits 2 and uses 2 kWh, electricity emits 0.5. A model: R ← M ← {steel, elec}."""
    bd = get_bd()
    bd.Database("bio").write(
        {("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Method(tuple(METHOD)).write([(("bio", "co2"), 1.0)])
    bd.Database("bg").write(
        {
            ("bg", "elec"): {"name": "electricity", "unit": "kWh", "exchanges": [
                {"input": ("bg", "elec"), "amount": 1.0, "type": "production"},
                {"input": ("bio", "co2"), "amount": 0.5, "type": "biosphere"}]},
            ("bg", "steel"): {"name": "steel", "unit": "kg", "exchanges": [
                {"input": ("bg", "steel"), "amount": 1.0, "type": "production"},
                {"input": ("bg", "elec"), "amount": 2.0, "type": "technosphere"},
                {"input": ("bio", "co2"), "amount": 2.0, "type": "biosphere"}]},
        }
    )
    bd.databases["bg"]["prism_read_only"] = True
    bd.databases.flush()
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    m = _create(client, token, db, "Manufacturing")
    r = _create(client, token, db, "Water carried")
    w = {
        "db": db, "M": m, "R": r,
        "u_m": _edge(client, token, db, r, db, m),
        "u_steel": _edge(client, token, db, m, "bg", "steel"),
        "u_elec": _edge(client, token, db, m, "bg", "elec", 4.0),
    }
    _set(client, token, [{"database": db, "code": m}], "Production")
    return w


def _create(client, token, db, name) -> str:
    r = client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "unit"}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def _edge(client, token, db, consumer, input_db, input_code, amount=1.0, tags=None) -> str:
    body = {"activity_database": db, "activity_code": consumer, "input_database": input_db,
            "input_code": input_code, "amount": amount}
    if tags is not None:
        body["tags"] = tags
    r = client.post("/api/v1/model/exchanges", json=body, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["exchange"]["uid"]


def _set(client, token, keys, value, group=PHASE):
    return client.post("/api/v1/model/tags/set", json={"keys": keys, "group": group, "value": value},
                       headers=token)


def _split(client, token, db, code) -> dict[str, float]:
    r = client.post("/api/v1/calc/contribution",
                    json={"database": db, "code": code, "method": METHOD, "aggregate_by": f"tag:{PHASE}"},
                    headers=token)
    assert r.status_code == 200, r.text
    return {g["key"]: g["impact"] for g in r.json()["aggregation"]["groups"] if abs(g["impact"]) > 1e-9}


def _input_tags(client, token, db, code, uid) -> list[dict]:
    detail = client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).json()
    ex = next(e for e in detail["exchanges"] if e["uid"] == uid)
    return ex.get("tags") or []


def _undo(client, token):
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200


def _redo(client, token):
    assert client.post("/api/v1/model/redo", headers=token).status_code == 200


# ---- setting and refusing -----------------------------------------------------------------------
def test_an_input_tag_moves_its_chain_and_is_undoable(client, token, project):
    w = _world(client, token)
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 5.0})
    r = _set(client, token, [{"uid": w["u_steel"]}], "Raw materials")
    assert r.status_code == 200, r.text
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 2.0, "Raw materials": 3.0})
    assert _input_tags(client, token, w["db"], w["M"], w["u_steel"]) == [{"dimension": PHASE, "value": "Raw materials"}]
    history = client.get("/api/v1/model/history", headers=token).json()
    assert "input 'steel' in 'Manufacturing'" in str(history)
    _undo(client, token)
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 5.0})
    _redo(client, token)
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 2.0, "Raw materials": 3.0})


@pytest.mark.parametrize(
    "key_of, code",
    [
        (lambda w: {"uid": w["u_m"]}, "tag_target_same_model"),
        (lambda w: {"uid": "0" * 32}, "exchange_not_found"),
        (lambda w: {"database": "bg", "code": "steel"}, "tag_target_background"),
        (lambda w: {"uid": w["u_steel"], "database": w["db"], "code": w["M"]}, "tag_key_ambiguous"),
        (lambda w: {"database": w["db"], "code": f"{w['M']}#{w['u_steel']}"}, "tag_key_composed"),
    ],
)
def test_tags_where_they_do_not_belong_are_refused_by_name(client, token, project, key_of, code):
    w = _world(client, token)
    r = _set(client, token, [key_of(w)], "Raw materials")
    assert r.status_code >= 400, r.text
    assert code in r.text
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 5.0})


def test_a_production_exchange_is_no_input(client, token, project):
    w = _world(client, token)
    detail = client.get(f"/api/v1/model/activities/{w['db']}/{w['M']}", headers=token).json()
    prod = next(e for e in detail["exchanges"] if e["type"] == "production")
    r = _set(client, token, [{"uid": prod["uid"]}], "Raw materials")
    assert r.status_code == 400 and "tag_target_not_input" in r.text


def test_a_new_input_carries_its_tags_in_one_undo_step(client, token, project):
    w = _world(client, token)
    uid = _edge(client, token, w["db"], w["M"], "bg", "steel", 1.0, tags={PHASE: "Raw materials"})
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 5.0, "Raw materials": 3.0})
    assert _input_tags(client, token, w["db"], w["M"], uid) == [{"dimension": PHASE, "value": "Raw materials"}]
    _undo(client, token)
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 5.0})
    refused = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": w["db"], "activity_code": w["R"], "input_database": w["db"],
              "input_code": w["M"], "amount": 1.0, "tags": {PHASE: "Use"}},
        headers=token,
    )
    assert refused.status_code == 400 and "tag_target_same_model" in refused.text
    detail = client.get(f"/api/v1/model/activities/{w['db']}/{w['R']}", headers=token).json()
    assert len([e for e in detail["exchanges"] if e["type"] == "technosphere"]) == 1  # nothing half-written


def test_the_vocabulary_commands_reach_input_tags(client, token, project):
    w = _world(client, token)
    _set(client, token, [{"uid": w["u_steel"]}], "Raw material")
    client.post("/api/v1/model/tag-groups/values", json={"group": PHASE, "value": "Raw materials"}, headers=token)
    r = client.post("/api/v1/model/tag-groups/values/merge",
                    json={"group": PHASE, "value": "Raw material", "into": "Raw materials"}, headers=token)
    assert r.status_code == 200, r.text
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 2.0, "Raw materials": 3.0})
    _undo(client, token)
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 2.0, "Raw material": 3.0})


# ---- the canvas graph ---------------------------------------------------------------------------
def test_the_graph_draws_one_box_per_occurrence(client, token, project):
    w = _world(client, token)
    second = _edge(client, token, w["db"], w["R"], "bg", "elec", 0.5)  # electricity in use, say
    _set(client, token, [{"uid": second}], "Use")
    g = client.get(f"/api/v1/model/graph/{w['db']}", headers=token).json()
    boxes = {n["id"]: n for n in g["bg_nodes"]}
    elec = [n for n in boxes.values() if n["dataset_id"] == "bg/elec"]
    assert len(elec) == 2
    inherited = next(n for n in elec if n["uids"] == [w["u_elec"]])
    tagged = next(n for n in elec if n["uids"] == [second])
    # Manufacturing's electricity carries no tag of its own: it serves the phase of the process using it.
    assert inherited["id"].startswith("bg/elec#")
    assert inherited["tags"] == [{"dimension": PHASE, "value": "Production", "inherited": True}]
    assert tagged["id"].startswith("bg/elec#") and tagged["id"] != inherited["id"]
    assert tagged["tags"] == [{"dimension": PHASE, "value": "Use"}]
    edge = next(e for e in g["bg_edges"] if e["uid"] == second)
    assert edge["source"] == tagged["id"] and edge["tags"] == tagged["tags"]
    # The edge keeps the input's own tags only — nothing is written for the inherited value.
    assert next(e for e in g["bg_edges"] if e["uid"] == w["u_elec"])["tags"] == []


def _boxes(client, token, db) -> list[dict]:
    return client.get(f"/api/v1/model/graph/{db}", headers=token).json()["bg_nodes"]


def _phase_of(box: dict) -> str | None:
    return next((t["value"] for t in box["tags"] if t["dimension"] == PHASE), None)


def test_a_box_shows_the_phase_the_calculation_books_its_input_to(client, token, project):
    """Through an untagged process in between, a helper serving two phases inherits nothing, and an input of the
    untagged root stays a plain box with the dataset's own id."""
    w = _world(client, token)
    db = w["db"]
    sub = _create(client, token, db, "Sub-assembly")  # untagged, used by Manufacturing only
    _edge(client, token, db, w["M"], db, sub)
    u_sub = _edge(client, token, db, sub, "bg", "steel")
    helper = _create(client, token, db, "Shared helper")  # used by Manufacturing (Production) and by Use
    use = _create(client, token, db, "Use")
    _set(client, token, [{"database": db, "code": use}], "Use")
    _edge(client, token, db, w["R"], db, use)
    _edge(client, token, db, w["M"], db, helper)
    _edge(client, token, db, use, db, helper)
    u_helper = _edge(client, token, db, helper, "bg", "elec")
    u_root = _edge(client, token, db, w["R"], "bg", "steel", 0.1)
    u_use = _edge(client, token, db, use, "bg", "elec", 3.0)
    by_uid = {u: b for b in _boxes(client, token, db) for u in b["uids"]}
    assert _phase_of(by_uid[u_sub]) == "Production"
    assert by_uid[u_sub]["tags"][0]["inherited"] is True
    assert by_uid[u_helper]["tags"] == [] and by_uid[u_helper]["id"] == "bg/elec"
    assert by_uid[u_root]["tags"] == [] and by_uid[u_root]["id"] == "bg/steel"
    # Manufacturing's steel (direct and via the sub-assembly) share one Production box; the root's is apart.
    assert by_uid[u_sub]["id"] == by_uid[w["u_steel"]]["id"] != by_uid[u_root]["id"]
    # One dataset, two phases: two boxes, each where the calculation puts it.
    assert _phase_of(by_uid[u_use]) == "Use" and by_uid[u_use]["id"] != by_uid[w["u_elec"]]["id"]
    _set(client, token, [{"uid": u_sub}], "Raw materials")  # the input's own tag wins over the inherited one
    by_uid = {u: b for b in _boxes(client, token, db) for u in b["uids"]}
    assert by_uid[u_sub]["tags"] == [{"dimension": PHASE, "value": "Raw materials"}]


def test_a_root_inside_a_cycle_keeps_its_untagged_demand_and_another_models_process_its_own_tag(
    client, token, project
):
    """Two places where the value passed down is not the consumer's: a calculation that starts inside a cycle
    has untagged demand of its own (the box stays plain, as the split is mixed), and a process of another
    model counts with its own tag, as phase_attribution books it."""
    w = _world(client, token)
    db = "cyc-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    r = _create(client, token, db, "Root")
    p = _create(client, token, db, "Production step")
    _set(client, token, [{"database": db, "code": p}], "Production")
    _edge(client, token, db, r, db, p, 0.5)
    _edge(client, token, db, p, db, r, 0.5)
    u_root = _edge(client, token, db, r, "bg", "steel")
    u_step = _edge(client, token, db, p, "bg", "elec")
    by_uid = {u: b for b in _boxes(client, token, db) for u in b["uids"]}
    assert by_uid[u_root]["tags"] == []
    assert _phase_of(by_uid[u_step]) == "Production"
    # The split agrees: the root's steel is booked to both the untagged demand and Production.
    split = _split(client, token, db, r)
    assert split.get("(untagged)", 0) > 0 and split.get("Production", 0) > 0

    other = _create(client, token, w["db"], "Shared bottle washer")  # in the first model, tagged Use
    _set(client, token, [{"database": w["db"], "code": other}], "Use")
    u_other = _edge(client, token, db, p, w["db"], other)  # Production step draws on it from outside
    box = next(b for b in _boxes(client, token, db) if u_other in b["uids"])
    assert box["tags"] == [{"dimension": PHASE, "value": "Use", "inherited": True}]


def test_an_own_tag_with_the_inherited_value_joins_the_box_and_makes_the_tag_its_own(client, token, project):
    w = _world(client, token)
    db = w["db"]
    other = _create(client, token, db, "Assembly")
    _set(client, token, [{"database": db, "code": other}], "Production")
    _edge(client, token, db, w["R"], db, other)
    u_other = _edge(client, token, db, other, "bg", "elec")
    _set(client, token, [{"uid": u_other}], "Production")
    elec = [b for b in _boxes(client, token, db) if b["dataset_id"] == "bg/elec"]
    assert len(elec) == 1 and sorted(elec[0]["uids"]) == sorted([w["u_elec"], u_other])
    assert elec[0]["tags"] == [{"dimension": PHASE, "value": "Production"}]


# ---- operations that copy or re-key an exchange ---------------------------------------------------
def test_duplicating_a_process_copies_its_tags_and_redo_keeps_the_uids(client, token, project):
    w = _world(client, token)
    _set(client, token, [{"uid": w["u_steel"]}], "Raw materials")
    r = client.post("/api/v1/model/activities/duplicate", json={"database": w["db"], "code": w["M"]}, headers=token)
    assert r.status_code == 200, r.text
    copy = r.json()["code"] if "code" in r.json() else r.json()["activity"]["code"]
    steel_copy = next(e for e in r.json()["exchanges"] if e["input"]["code"] == "steel")
    assert steel_copy.get("tags") == [{"dimension": PHASE, "value": "Raw materials"}]
    # A follow-up step on the copied input, then both undone and redone: the uid must still be there.
    _set(client, token, [{"uid": steel_copy["uid"]}], "Packaging")
    _undo(client, token)
    _undo(client, token)
    _redo(client, token)
    _redo(client, token)
    assert _input_tags(client, token, w["db"], copy, steel_copy["uid"]) == [{"dimension": PHASE, "value": "Packaging"}]
    tags = client.get(f"/api/v1/model/tags/{w['db']}/{copy}", headers=token).json()
    assert tags == [{"dimension": PHASE, "value": "Production"}]


def test_duplicating_the_model_keeps_input_tags(client, token, project):
    w = _world(client, token)
    _set(client, token, [{"uid": w["u_steel"]}], "Raw materials")
    new = "copy-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": w["db"], "name": new}, headers=token)
    assert r.status_code == 200, r.text
    root = next(n["id"].split("/", 1)[1] for n in client.get(f"/api/v1/model/graph/{new}", headers=token).json()["nodes"]
                if n["name"] == "Water carried")
    assert _split(client, token, new, root) == pytest.approx({"Production": 2.0, "Raw materials": 3.0})


def test_a_bundle_carries_input_tags_and_stays_deterministic(client, token, project):
    w = _world(client, token)
    _set(client, token, [{"uid": w["u_steel"]}], "Raw materials")
    one = client.post("/api/v1/bundle/export", json={"database": w["db"]}, headers=token).json()["base64"]
    two = client.post("/api/v1/bundle/export", json={"database": w["db"]}, headers=token).json()["base64"]
    assert one == two
    r = client.post("/api/v1/bundle/import", json={"content": one, "name": "Imported"}, headers=token)
    assert r.status_code == 200, r.text
    assert _split(client, token, "Imported", w["R"]) == pytest.approx({"Production": 2.0, "Raw materials": 3.0})
    assert base64.b64decode(one)  # a real archive


def test_the_spreadsheet_round_trip_keeps_input_tags(client, token, project):
    w = _world(client, token)
    _set(client, token, [{"uid": w["u_steel"]}], "Raw materials")
    workbook = client.get(f"/api/v1/interop/model/{w['db']}", headers=token).content
    dst = "dst-" + uuid.uuid4().hex[:6]
    client.post("/api/v1/databases/foreground", json={"name": dst}, headers=token)
    imp = client.post("/api/v1/interop/model", data={"target_database": dst},
                      files={"file": ("model.xlsx", workbook, _XLSX)}, headers=token)
    assert imp.status_code == 200, imp.text
    assert _split(client, token, dst, w["R"]) == pytest.approx({"Production": 2.0, "Raw materials": 3.0})


def test_moving_a_process_to_the_library_moves_its_phase_onto_the_inputs(client, token, project):
    w = _world(client, token)
    r = client.post("/api/v1/model/activities/to-library", json={"database": w["db"], "code": w["M"]}, headers=token)
    assert r.status_code == 200, r.text
    # The library carries no tags; Manufacturing's Production now sits on the model input drawing on it.
    assert _input_tags(client, token, w["db"], w["R"], w["u_m"]) == [{"dimension": PHASE, "value": "Production"}]
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 5.0})
    _undo(client, token)
    assert _input_tags(client, token, w["db"], w["R"], w["u_m"]) == []
    assert _split(client, token, w["db"], w["R"]) == pytest.approx({"Production": 5.0})


def test_localizing_one_box_moves_only_its_inputs_and_keeps_the_split(client, token, project):
    w = _world(client, token)
    use = _edge(client, token, w["db"], w["R"], "bg", "elec", 0.5, tags={PHASE: "Use"})
    before = _split(client, token, w["db"], w["R"])
    r = client.post(
        "/api/v1/model/activities/copy",
        json={"source_database": "bg", "source_code": "elec", "target_database": w["db"],
              "relink_consumers": True, "uids": [use]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    local = r.json()["activity"]["code"] if "activity" in r.json() else r.json()["code"]
    assert r.json()["relinked"] == 1
    # The box's tag became the local copy's own tag and left the input.
    assert client.get(f"/api/v1/model/tags/{w['db']}/{local}", headers=token).json() == [{"dimension": PHASE, "value": "Use"}]
    assert _input_tags(client, token, w["db"], w["R"], use) == []
    # Manufacturing's electricity still draws on the background dataset.
    detail = client.get(f"/api/v1/model/activities/{w['db']}/{w['M']}", headers=token).json()
    assert next(e for e in detail["exchanges"] if e["uid"] == w["u_elec"])["input"]["database"] == "bg"
    assert _split(client, token, w["db"], w["R"]) == pytest.approx(before)
    _undo(client, token)
    assert _input_tags(client, token, w["db"], w["R"], use) == [{"dimension": PHASE, "value": "Use"}]
    assert _split(client, token, w["db"], w["R"]) == pytest.approx(before)


# ---- findings of the review of the implementation ------------------------------------------------
def test_localizing_one_box_keeps_the_other_input_of_the_same_dataset(client, token, project):
    """Manufacturing draws steel twice: once as raw material, once (say) as spare part in use. Localizing
    the first box must leave the second input standing."""
    w = _world(client, token)
    second = _edge(client, token, w["db"], w["M"], "bg", "steel", 0.5, tags={PHASE: "Use"})
    before = _split(client, token, w["db"], w["R"])
    r = client.post(
        "/api/v1/model/activities/copy",
        json={"source_database": "bg", "source_code": "steel", "target_database": w["db"],
              "relink_consumers": True, "uids": [w["u_steel"]]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    detail = client.get(f"/api/v1/model/activities/{w['db']}/{w['M']}", headers=token).json()
    kept = next(e for e in detail["exchanges"] if e["uid"] == second)
    assert kept["input"]["database"] == "bg" and kept["amount"] == pytest.approx(0.5)
    assert _split(client, token, w["db"], w["R"]) == pytest.approx(before)
    _undo(client, token)
    assert _split(client, token, w["db"], w["R"]) == pytest.approx(before)


def test_an_unconnected_copy_localized_moves_no_input(client, token, project):
    w = _world(client, token)
    r = client.post(
        "/api/v1/model/activities/copy",
        json={"source_database": "bg", "source_code": "steel", "target_database": w["db"],
              "relink_consumers": True, "uids": []},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["relinked"] == 0
    detail = client.get(f"/api/v1/model/activities/{w['db']}/{w['M']}", headers=token).json()
    assert next(e for e in detail["exchanges"] if e["uid"] == w["u_steel"])["input"]["database"] == "bg"


def test_redo_finds_the_copied_input_by_identity_not_by_position(client, token, project):
    """Duplicate, tag the copy's steel, delete the original's steel, undo all three — the undone delete
    brings steel back in another place — then redo duplicate and tag: the tag must land on steel again."""
    w = _world(client, token)
    r = client.post("/api/v1/model/activities/duplicate", json={"database": w["db"], "code": w["M"]}, headers=token)
    copy = r.json()["code"] if "code" in r.json() else r.json()["activity"]["code"]
    steel_copy = next(e for e in r.json()["exchanges"] if e["input"]["code"] == "steel")["uid"]
    assert _set(client, token, [{"uid": steel_copy}], "Raw materials").status_code == 200
    gone = client.post("/api/v1/model/exchanges/remove",
                       json={"activity_database": w["db"], "activity_code": w["M"], "uid": w["u_steel"]}, headers=token)
    assert gone.status_code == 200, gone.text
    for _ in range(3):
        _undo(client, token)
    _redo(client, token)
    _redo(client, token)
    detail = client.get(f"/api/v1/model/activities/{w['db']}/{copy}", headers=token).json()
    tagged = [e for e in detail["exchanges"] if e.get("tags")]
    assert [e["input"]["code"] for e in tagged] == ["steel"]


def test_a_blank_tag_on_a_new_input_writes_nothing(client, token, project):
    w = _world(client, token)
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": w["db"], "activity_code": w["M"], "input_database": "bg",
              "input_code": "steel", "amount": 1.0, "tags": {PHASE: "   "}},
        headers=token,
    )
    assert r.status_code == 400, r.text
    detail = client.get(f"/api/v1/model/activities/{w['db']}/{w['M']}", headers=token).json()
    assert len([e for e in detail["exchanges"] if e["type"] == "technosphere"]) == 2


def test_the_library_move_merges_tags_per_dimension_and_undo_restores_them(client, token, project):
    w = _world(client, token)
    # The model input drawing on Manufacturing cannot carry a tag while Manufacturing is in the model, so
    # give the process a second dimension instead and check both arrive, and that undo clears them.
    _set(client, token, [{"database": w["db"], "code": w["M"]}], "Lid", group="Part")
    r = client.post("/api/v1/model/activities/to-library", json={"database": w["db"], "code": w["M"]}, headers=token)
    assert r.status_code == 200, r.text
    assert sorted((t["dimension"], t["value"]) for t in _input_tags(client, token, w["db"], w["R"], w["u_m"])) == [
        (PHASE, "Production"), ("Part", "Lid")]
    # A value the input says itself in one dimension stays; the other dimension still arrives.
    _set(client, token, [{"uid": w["u_m"]}], "Use")
    assert {t["dimension"]: t["value"] for t in _input_tags(client, token, w["db"], w["R"], w["u_m"])}[PHASE] == "Use"
    _undo(client, token)
    _undo(client, token)
    assert _input_tags(client, token, w["db"], w["R"], w["u_m"]) == []


def test_a_box_of_the_library_or_another_model_is_a_reference_on_the_canvas(client, token, project):
    w = _world(client, token)
    other = "fg-" + uuid.uuid4().hex[:6]
    client.post("/api/v1/databases/foreground", json={"name": other}, headers=token)
    part = _create(client, token, other, "Part from another model")
    _edge(client, token, w["db"], w["M"], other, part, 1.0)
    g = client.get(f"/api/v1/model/graph/{w['db']}", headers=token).json()
    box = next(n for n in g["bg_nodes"] if n["dataset_id"] == f"{other}/{part}")
    assert box["read_only"] is True


def test_the_flows_of_a_background_root_are_its_flows(client, token, project):
    _world(client, token)
    r = client.post(
        "/api/v1/calc/elementary-flows",
        json={"database": "bg", "code": "steel", "method": METHOD, "top_n": 0,
              "phase": {"dimension": PHASE, "value": "(untagged)"}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == pytest.approx(3.0)
    assert sum(f["impact"] for f in body["flows"]) == pytest.approx(3.0)


def test_a_sheet_imported_into_the_library_brings_no_tags(client, token, project):
    from prism_lca.engine.library import LIBRARY_DB, ensure_library

    w = _world(client, token)
    _set(client, token, [{"uid": w["u_steel"]}], "Raw materials")
    workbook = client.get(f"/api/v1/interop/model/{w['db']}", headers=token).content
    ensure_library()
    imp = client.post("/api/v1/interop/model", data={"target_database": LIBRARY_DB},
                      files={"file": ("model.xlsx", workbook, _XLSX)}, headers=token)
    assert imp.status_code == 422 and "library carries no tags" in imp.text


def test_redo_of_a_sheet_import_keeps_the_inputs_a_later_tag_addresses(client, token, project):
    w = _world(client, token)
    workbook = client.get(f"/api/v1/interop/model/{w['db']}", headers=token).content
    dst = "dst-" + uuid.uuid4().hex[:6]
    client.post("/api/v1/databases/foreground", json={"name": dst}, headers=token)
    imp = client.post("/api/v1/interop/model", data={"target_database": dst},
                      files={"file": ("model.xlsx", workbook, _XLSX)}, headers=token)
    assert imp.status_code == 200, imp.text
    detail = client.get(f"/api/v1/model/activities/{dst}/{w['M']}", headers=token).json()
    steel = next(e for e in detail["exchanges"] if e["input"]["code"] == "steel")["uid"]
    _set(client, token, [{"uid": steel}], "Raw materials")
    _undo(client, token)
    _undo(client, token)
    _redo(client, token)
    _redo(client, token)
    assert _split(client, token, dst, w["R"]) == pytest.approx({"Production": 2.0, "Raw materials": 3.0})
