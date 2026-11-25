"""Tag groups belong to one model (engine/tag_groups.py).

A group — its name, colour and the order of its values — is the vocabulary of the model it was made in.
The same name may stand in two models with different values; nothing done to one model's groups reaches
another's; and the list a model shows follows the tags it carries, so an import that wrote tags without
declaring them, or an undo that put a tag back, never leaves a value nobody can pick.
"""
from __future__ import annotations

import base64
import json
import uuid

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.tag_groups import PHASE, TagGroupStore
from prism_lca.engine.tags import TagStore

GROUPS = "/api/v1/model/tag-groups"


def _model(client, token, name: str | None = None) -> str:
    db = name or "m-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    assert r.status_code == 200, r.text
    return db


def _process(client, token, db: str, name: str = "p") -> str:
    r = client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def _groups(client, token, db: str) -> list[dict]:
    r = client.get(f"{GROUPS}?database={db}", headers=token)
    assert r.status_code == 200, r.text
    return r.json()["groups"]


def _shape(client, token, db: str) -> list[tuple]:
    """``(name, colour, values)`` per group, in order — what a model's vocabulary is."""
    return [(g["name"], g["color"], g["values"]) for g in _groups(client, token, db)]


def _ok(r) -> dict:
    assert r.status_code == 200, r.text
    return r.json()


def _group(client, token, db: str, name: str, *values: str, color: str | None = None) -> None:
    _ok(client.post(GROUPS, json={"database": db, "name": name, "color": color}, headers=token))
    for v in values:
        _ok(client.post(f"{GROUPS}/values", json={"database": db, "group": name, "value": v}, headers=token))


def _set(client, token, keys: list[tuple[str, str]], group: str, value: str | None, headers=None):
    return client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": db, "code": code} for db, code in keys], "group": group, "value": value},
        headers=headers or token,
    )


def _tags(client, token, db: str, code: str) -> list[dict]:
    return client.get(f"/api/v1/model/tags?database={db}&code={code}", headers=token).json()


def _audit(client, token, db: str | None = None) -> list[dict]:
    q = f"?database={db}" if db else ""
    return _ok(client.get(f"/api/v1/model/audit{q}", headers=token))


def _in_use(client, token, *dbs: str) -> list[dict]:
    q = "&".join(f"database={d}" for d in dbs)
    return _ok(client.get(f"{GROUPS}/in-use?{q}", headers=token))["groups"]


def _fenced(token, model: str) -> dict:
    return {**token, "X-Prism-Model": model}


def _refused(r) -> None:
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "outside_model_scope"


# --- one model's groups are not another's ----------------------------------------------------------
def test_a_group_made_in_one_model_is_not_in_another(client, token, project):
    a, b = _model(client, token, "A"), _model(client, token, "B")
    _group(client, token, a, "Supplier", "Acme", color="#123456")
    assert _shape(client, token, a) == [("Supplier", "#123456", ["Acme"])]
    assert _groups(client, token, b) == []
    # B has no such group to add a value to.
    r = client.post(f"{GROUPS}/values", json={"database": b, "group": "Supplier", "value": "x"}, headers=token)
    assert r.status_code == 404 and r.json()["error"]["code"] == "group_not_found"

    # Making the group and its value are notes in A's history, and in A's only.
    mine = [e for e in _audit(client, token, a) if e["action"] in ("create_tag_group", "add_tag_value")]
    assert [(e["action"], e["database"]) for e in mine] == [("create_tag_group", a), ("add_tag_value", a)]
    assert all(e["undoable"] is False for e in mine)
    assert not [e for e in _audit(client, token, b) if e["action"] in ("create_tag_group", "add_tag_value")]


def test_deleting_and_merging_in_one_model_leaves_the_same_group_in_another_alone(client, token, project):
    a, b = _model(client, token, "A"), _model(client, token, "B")
    for db in (a, b):
        _group(client, token, db, "Supplier", "Acme", "ACME", "Beta")
        _group(client, token, db, "Vendor", "V1")
        p, q = _process(client, token, db, "p"), _process(client, token, db, "q")
        _ok(_set(client, token, [(db, p)], "Supplier", "Acme"))
        _ok(_set(client, token, [(db, q)], "Supplier", "Beta"))
        _ok(_set(client, token, [(db, q)], "Vendor", "V1"))
    groups_b, tags_b = _shape(client, token, b), TagStore().snapshot_database(b)

    _ok(client.post(f"{GROUPS}/values/merge", json={"database": a, "group": "Supplier", "value": "Acme", "into": "ACME"},
                    headers=token))
    _ok(client.post(f"{GROUPS}/values/remove", json={"database": a, "group": "Supplier", "value": "Beta"}, headers=token))
    _ok(client.post(f"{GROUPS}/delete", json={"database": a, "name": "Vendor"}, headers=token))
    _group(client, token, a, "Owner")
    _ok(client.post(f"{GROUPS}/merge", json={"database": a, "name": "Owner", "into": "Supplier"}, headers=token))

    assert [(g["name"], g["values"]) for g in _groups(client, token, a)] == [("Supplier", ["ACME"])]
    assert _shape(client, token, b) == groups_b
    assert TagStore().snapshot_database(b) == tags_b


def test_a_background_database_has_no_groups(client, token, project):
    bd = get_bd()
    bd.Database("bg-x").write({("bg-x", "s"): {"name": "steel", "unit": "kg", "exchanges": []}})
    bd.databases["bg-x"]["prism_read_only"] = True
    bd.databases.flush()
    r = client.get(f"{GROUPS}?database=bg-x", headers=token)
    assert r.status_code == 404 and r.json()["error"]["code"] == "database_not_found"
    r = client.post(GROUPS, json={"database": "bg-x", "name": "Supplier"}, headers=token)
    assert r.status_code == 404
    assert client.get(f"{GROUPS}?database=no-such-model", headers=token).status_code == 404


# --- the list follows the tags --------------------------------------------------------------------
def test_a_tag_written_without_registering_its_group_is_listed(client, token, project):
    """What a bundle or a spreadsheet import does: it writes tags and declares no group. The value joins
    the model's list, after the values already there, and a dimension nobody declared arrives with a
    colour of its own."""
    db = _model(client, token)
    p, q = _process(client, token, db, "p"), _process(client, token, db, "q")
    _group(client, token, db, "Supplier", "Acme", "Beta")
    _group(client, token, db, "Empty", "Prepared")
    TagStore().add(db, p, "Supplier", "Zeta")
    TagStore().add(db, q, "Material", "Steel")
    TagStore().add(db, q, "Supplier", "Beta")

    groups = {g["name"]: g for g in _groups(client, token, db)}
    assert list(groups) == ["Supplier", "Empty", "Material"]
    assert groups["Supplier"]["values"] == ["Acme", "Beta", "Zeta"]
    assert groups["Material"]["values"] == ["Steel"] and groups["Material"]["color"]
    assert groups["Material"]["color"] not in (groups["Supplier"]["color"], groups["Empty"]["color"])
    # `unused`: the values nobody carries; `used`: whether anybody carries the group at all.
    assert (groups["Supplier"]["used"], groups["Supplier"]["unused"]) == (True, ["Acme"])
    assert (groups["Material"]["used"], groups["Material"]["unused"]) == (True, [])
    assert (groups["Empty"]["used"], groups["Empty"]["unused"]) == (False, ["Prepared"])


def test_a_value_carried_by_a_deleted_process_is_no_longer_in_use(client, token, project):
    """Deleting a process leaves its tags in the file so that the undo brings them back; such a tag is
    nobody's, so it makes no value look carried. The undo makes it carried again."""
    db = _model(client, token)
    keep, gone = _process(client, token, db, "keep"), _process(client, token, db, "gone")
    _ok(_set(client, token, [(db, keep)], "Material", "Steel"))
    _ok(_set(client, token, [(db, gone)], "Supplier", "Acme"))
    assert {g["name"] for g in _in_use(client, token, db)} == {"Material", "Supplier"}

    _ok(client.post("/api/v1/model/activities/delete", json={"database": db, "code": gone, "force": True}, headers=token))
    supplier = next(g for g in _groups(client, token, db) if g["name"] == "Supplier")
    assert supplier["values"] == ["Acme"]  # prepared still, until it is removed
    assert (supplier["used"], supplier["unused"]) == (False, ["Acme"])
    assert _in_use(client, token, db) == [{"name": "Material", "databases": [db]}]

    _ok(client.post("/api/v1/model/undo", headers=token))
    supplier = next(g for g in _groups(client, token, db) if g["name"] == "Supplier")
    assert (supplier["used"], supplier["unused"]) == (True, [])
    assert {g["name"] for g in _in_use(client, token, db)} == {"Material", "Supplier"}


def test_a_value_carried_by_a_removed_input_is_no_longer_in_use(client, token, project):
    from test_exchange_tags import PHASE as PHASE_OF_WORLD
    from test_exchange_tags import _set as set_keys
    from test_exchange_tags import _world

    w = _world(client, token)  # Manufacturing is tagged with the life-cycle phase
    _ok(set_keys(client, token, [{"uid": w["u_steel"]}], "Recycled", group="Material"))
    assert {g["name"] for g in _in_use(client, token, w["db"])} == {PHASE_OF_WORLD, "Material"}

    _ok(client.post("/api/v1/model/exchanges/remove",
                    json={"activity_database": w["db"], "activity_code": w["M"], "uid": w["u_steel"]}, headers=token))
    material = next(g for g in _groups(client, token, w["db"]) if g["name"] == "Material")
    assert (material["used"], material["unused"]) == (False, ["Recycled"])
    assert _in_use(client, token, w["db"]) == [{"name": PHASE_OF_WORLD, "databases": [w["db"]]}]

    _ok(client.post("/api/v1/model/undo", headers=token))
    material = next(g for g in _groups(client, token, w["db"]) if g["name"] == "Material")
    assert (material["used"], material["unused"]) == (True, [])


# --- which groups a split by can offer ------------------------------------------------------------
def test_in_use_matches_groups_across_models_by_name(client, token, project):
    a, b, c = _model(client, token, "A"), _model(client, token, "B"), _model(client, token, "C")
    pa, pb = _process(client, token, a), _process(client, token, b)
    _ok(_set(client, token, [(a, pa)], "Supplier", "Acme"))
    _ok(_set(client, token, [(b, pb)], "Supplier", "Other value"))
    _ok(_set(client, token, [(b, pb)], "Material", "Steel"))
    _group(client, token, c, "Supplier", "Acme")  # prepared only: nothing in C carries it
    bd = get_bd()
    bd.Database("bg-y").write({("bg-y", "s"): {"name": "steel", "unit": "kg", "exchanges": []}})
    bd.databases["bg-y"]["prism_read_only"] = True
    bd.databases.flush()

    groups = _in_use(client, token, a, b, c, "bg-y", "no-such-model")
    # One entry per name, in the order of the first model that carries it; only models that carry it.
    assert groups == [{"name": "Supplier", "databases": [a, b]}, {"name": "Material", "databases": [b]}]
    assert _in_use(client, token, c) == []


# --- the life-cycle phase in each model -----------------------------------------------------------
def test_a_new_model_gets_the_phase_under_its_one_name(client, token, project):
    db = _model(client, token)
    made = _ok(client.post(GROUPS, json={"database": db, "name": "Lebenswegphase"}, headers=token))
    assert made["name"] == PHASE
    assert [g["name"] for g in _groups(client, token, db)] == [PHASE]
    assert any(e["summary"] == f"Create tag group '{PHASE}'" for e in _audit(client, token, db))


def test_a_model_that_already_calls_its_phase_otherwise_keeps_that_name(client, token, project):
    """A model whose phase group is "Phase" (as the split of an older workspace leaves it) keeps it: a tag
    under the fixed name joins "Phase", and creating the fixed name beside it is refused. Another model's
    spelling is its own business."""
    legacy, fresh = _model(client, token, "Legacy"), _model(client, token, "Fresh")
    TagGroupStore().restore_database(legacy, [{"name": "Phase", "color": "#123456", "values": ["Use"]}])
    p, q = _process(client, token, legacy), _process(client, token, fresh)

    _ok(_set(client, token, [(legacy, p)], PHASE, "Production"))
    assert _tags(client, token, legacy, p) == [{"dimension": "Phase", "value": "Production"}]
    assert _shape(client, token, legacy) == [("Phase", "#123456", ["Use", "Production"])]
    r = client.post(GROUPS, json={"database": legacy, "name": PHASE}, headers=token)
    assert r.status_code == 409 and r.json()["error"]["code"] == "group_dimension_exists"
    assert "'Phase'" in r.json()["error"]["message"]

    _ok(_set(client, token, [(fresh, q)], "Lebenswegphase", "Herstellung"))
    assert _tags(client, token, fresh, q) == [{"dimension": PHASE, "value": "Herstellung"}]
    assert [g["name"] for g in _groups(client, token, fresh)] == [PHASE]
    assert [g["name"] for g in _groups(client, token, legacy)] == ["Phase"]


def test_a_phase_that_only_the_tags_carry_is_joined_too(client, token, project):
    """An imported model carries "Phase" on its processes and has no group list yet (a bundle without the
    section, a spreadsheet). The next tag under "Phase" must join that dimension, not open a second one
    under the fixed name — the list follows the tags, and so does the lookup."""
    db = _model(client, token)
    p, q = _process(client, token, db, "p"), _process(client, token, db, "q")
    TagStore().add(db, p, "Phase", "Use")  # as an import writes it, without a group

    _ok(_set(client, token, [(db, q)], "Phase", "Production"))
    assert _tags(client, token, db, q) == [{"dimension": "Phase", "value": "Production"}]
    assert [g["name"] for g in _groups(client, token, db)] == ["Phase"]


# --- a selection across two models ----------------------------------------------------------------
def test_a_selection_across_two_models_registers_and_undoes_in_both(client, token, project):
    a, b = _model(client, token, "A"), _model(client, token, "B")
    TagGroupStore().restore_database(a, [{"name": "Phase", "color": "#123456", "values": []}])
    pa, pb = _process(client, token, a), _process(client, token, b)

    _ok(_set(client, token, [(a, pa), (b, pb)], "Supplier", "Acme"))
    for db in (a, b):
        assert [(g["name"], g["values"]) for g in _groups(client, token, db) if g["name"] == "Supplier"] == [
            ("Supplier", ["Acme"])
        ]
    entry = [e for e in _audit(client, token) if e["action"] == "set_tag"][-1]
    assert entry["databases"] == [a, b] and "database" not in entry

    # Each model resolves the name in its own vocabulary: A's phase is "Phase", B gets the fixed name.
    _ok(_set(client, token, [(a, pa), (b, pb)], "Lebenswegphase", "Use"))
    assert {"dimension": "Phase", "value": "Use"} in _tags(client, token, a, pa)
    assert {"dimension": PHASE, "value": "Use"} in _tags(client, token, b, pb)

    _ok(client.post("/api/v1/model/undo", headers=token))
    _ok(client.post("/api/v1/model/undo", headers=token))
    assert _tags(client, token, a, pa) == [] and _tags(client, token, b, pb) == []
    # The registration is not undone: a vocabulary is prepared before it is used.
    assert "Supplier" in [g["name"] for g in _groups(client, token, b)]


# --- taking over another model's groups -----------------------------------------------------------
def test_adopting_brings_what_is_missing_and_undo_takes_exactly_that_back(client, token, project):
    src, dst = _model(client, token, "Source"), _model(client, token, "Target")
    _group(client, token, src, "Supplier", "Acme", "Beta", "Gamma", color="#aa0000")
    _group(client, token, src, "Material", "Steel", color="#00aa00")
    _group(client, token, dst, "Owner", "Me", color="#0000aa")
    _group(client, token, dst, "Supplier", "Beta", "Zeta", color="#123456")
    before_src, before_dst = _shape(client, token, src), _shape(client, token, dst)

    r = _ok(client.post(f"{GROUPS}/adopt", json={"database": dst, "source_model": src}, headers=token))
    assert r == {"groups": ["Material"], "values": {"Supplier": ["Acme", "Gamma"]}}
    assert _shape(client, token, dst) == [
        ("Owner", "#0000aa", ["Me"]),
        ("Supplier", "#123456", ["Beta", "Zeta", "Acme", "Gamma"]),  # its own colour, new values appended
        ("Material", "#00aa00", ["Steel"]),
    ]
    assert _shape(client, token, src) == before_src
    entry = [e for e in _audit(client, token) if e["action"] == "adopt_tag_groups"][-1]
    assert (entry["database"], entry["related"]) == (dst, src)

    _ok(client.post("/api/v1/model/undo", json={"database": dst}, headers=token))
    assert _shape(client, token, dst) == before_dst
    _ok(client.post("/api/v1/model/redo", json={"database": dst}, headers=token))

    # Nothing new: no step, no line.
    lines = len(_audit(client, token))
    top = _ok(client.get(f"/api/v1/model/history?database={dst}", headers=token))["next_undo"]
    again = _ok(client.post(f"{GROUPS}/adopt", json={"database": dst, "source_model": src}, headers=token))
    assert again.get("unchanged") is True
    assert len(_audit(client, token)) == lines
    assert _ok(client.get(f"/api/v1/model/history?database={dst}", headers=token))["next_undo"] == top

    # A copy: the two lists go their own ways afterwards.
    _ok(client.post(f"{GROUPS}/values", json={"database": dst, "group": "Material", "value": "Iron"}, headers=token))
    assert _shape(client, token, src) == before_src


def test_undoing_an_adoption_keeps_what_was_added_to_its_groups_since(client, token, project):
    """Adding a value is no undo step, so the adoption is still the step Undo takes — and it takes back
    what it brought, not the group with everything in it."""
    src, dst = _model(client, token, "Source"), _model(client, token, "Target")
    _group(client, token, src, "Material", "Steel", "Glass", color="#00aa00")
    _ok(client.post(f"{GROUPS}/adopt", json={"database": dst, "source_model": src}, headers=token))
    _ok(client.post(f"{GROUPS}/values", json={"database": dst, "group": "Material", "value": "Cork"}, headers=token))

    _ok(client.post("/api/v1/model/undo", json={"database": dst}, headers=token))
    assert _shape(client, token, dst) == [("Material", "#00aa00", ["Cork"])]
    _ok(client.post("/api/v1/model/redo", json={"database": dst}, headers=token))
    assert _shape(client, token, dst) == [("Material", "#00aa00", ["Cork", "Steel", "Glass"])]

    # With nothing added since, the group goes with its values.
    other = _model(client, token, "Other")
    _ok(client.post(f"{GROUPS}/adopt", json={"database": other, "source_model": src}, headers=token))
    _ok(client.post("/api/v1/model/undo", json={"database": other}, headers=token))
    assert _shape(client, token, other) == []


def test_adopting_is_not_for_a_fenced_chat(client, token, project):
    """The other model's vocabulary is that model's study text, and a fenced chat reads its own model only."""
    src, dst = _model(client, token, "Source"), _model(client, token, "Target")
    _group(client, token, src, "Supplier", "Acme")
    for fence in (dst, src):
        _refused(client.post(f"{GROUPS}/adopt", json={"database": dst, "source_model": src}, headers=_fenced(token, fence)))
    assert _groups(client, token, dst) == []


# --- the chat's fence -----------------------------------------------------------------------------
def test_a_fenced_chat_shapes_the_vocabulary_of_its_own_model_only(client, token, project):
    a, b = _model(client, token, "A"), _model(client, token, "B")
    pa, pb = _process(client, token, a), _process(client, token, b)
    _ok(_set(client, token, [(b, pb)], "Supplier", "Acme"))
    chat = _fenced(token, a)

    _refused(client.post(GROUPS, json={"database": b, "name": "Owner"}, headers=chat))
    _refused(client.post(f"{GROUPS}/values", json={"database": b, "group": "Supplier", "value": "Beta"}, headers=chat))
    assert [(g["name"], g["values"]) for g in _groups(client, token, b)] == [("Supplier", ["Acme"])]

    _ok(client.post(GROUPS, json={"database": a, "name": "Owner"}, headers=chat))
    _ok(client.post(f"{GROUPS}/values", json={"database": a, "group": "Owner", "value": "Me"}, headers=chat))
    _ok(_set(client, token, [(a, pa)], "Supplier", "Acme", headers=chat))
    # B carries the same value; removing it in A is A's business.
    _ok(client.post(f"{GROUPS}/values/remove", json={"database": a, "group": "Supplier", "value": "Acme"}, headers=chat))
    assert _tags(client, token, a, pa) == []
    assert _tags(client, token, b, pb) == [{"dimension": "Supplier", "value": "Acme"}]


# --- the model's lifecycle ------------------------------------------------------------------------
def _prepared(client, token, db: str) -> str:
    """A model with a carried group and one prepared value nobody carries, plus a group nobody carries."""
    p = _process(client, token, db)
    _group(client, token, db, "Supplier", "Acme", "Not yet", color="#123456")
    _group(client, token, db, "Material", "Steel", color="#654321")
    _ok(_set(client, token, [(db, p)], "Supplier", "Acme"))
    return p


def test_a_renamed_model_takes_its_groups_along(client, token, project):
    old = _model(client, token, "Before")
    _prepared(client, token, old)
    shape = _shape(client, token, old)
    _ok(client.post("/api/v1/databases/foreground/rename", json={"database": old, "name": "After"}, headers=token))
    assert _shape(client, token, "After") == shape
    assert TagGroupStore().snapshot_database(old) == []


def test_a_deleted_model_takes_its_groups_and_a_new_one_of_its_name_starts_empty(client, token, project):
    db = _model(client, token, "Gone")
    _prepared(client, token, db)
    _ok(client.post("/api/v1/databases/foreground/delete", json={"database": db}, headers=token))
    assert TagGroupStore().snapshot_database(db) == []
    _model(client, token, db)
    assert _groups(client, token, db) == []


def test_an_undone_import_sets_the_groups_aside_and_its_redo_brings_them_back(client, token, project):
    """Undoing a bundle import deletes the model; the redo re-creates what the bundle brought and puts
    back what the model held when it was undone — a value prepared after the import included."""
    src = _model(client, token, "Exported")
    _prepared(client, token, src)
    content = _ok(client.post("/api/v1/bundle/export", json={"database": src}, headers=token))["base64"]
    landed = _ok(client.post("/api/v1/bundle/import", json={"content": content, "name": "Landed"}, headers=token))["database"]
    _ok(client.post(f"{GROUPS}/values", json={"database": landed, "group": "Material", "value": "Later"}, headers=token))
    shape = _shape(client, token, landed)
    assert ("Material", "#654321", ["Steel", "Later"]) in shape

    _ok(client.post("/api/v1/model/undo", json={"database": landed}, headers=token))
    assert landed not in get_bd().databases
    assert TagGroupStore().snapshot_database(landed) == []
    _ok(client.post("/api/v1/model/redo", json={"database": landed}, headers=token))
    assert _shape(client, token, landed) == shape


def test_a_duplicate_starts_with_the_originals_groups_and_goes_its_own_way(client, token, project):
    src = _model(client, token, "Original")
    _prepared(client, token, src)
    shape = _shape(client, token, src)
    _ok(client.post("/api/v1/databases/foreground/duplicate", json={"source": src, "name": "Copy"}, headers=token))
    assert _shape(client, token, "Copy") == shape  # colours, order and the prepared values

    _ok(client.post(f"{GROUPS}/values", json={"database": "Copy", "group": "Supplier", "value": "Only here"}, headers=token))
    _ok(client.post(f"{GROUPS}/delete", json={"database": "Copy", "name": "Material"}, headers=token))
    assert _shape(client, token, src) == shape


# --- the bundle -----------------------------------------------------------------------------------
def _export(client, token, db: str) -> bytes:
    return base64.b64decode(_ok(client.post("/api/v1/bundle/export", json={"database": db}, headers=token))["base64"])


def _member(data: bytes, name: str) -> dict:
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return json.loads(zf.read(name))


def test_a_bundle_carries_the_groups_and_brings_them_back(client, token, project):
    src = _model(client, token, "Bundled")
    _prepared(client, token, src)
    data = _export(client, token, src)
    assert _export(client, token, src) == data  # still deterministic
    assert _member(data, "tag_groups.json") == {
        "tag_groups": [
            {"name": "Supplier", "color": "#123456", "values": ["Acme", "Not yet"]},
            {"name": "Material", "color": "#654321", "values": ["Steel"]},
        ]
    }
    content = base64.b64encode(data).decode("ascii")
    landed = _ok(client.post("/api/v1/bundle/import", json={"content": content, "name": "Back"}, headers=token))["database"]
    assert _shape(client, token, landed) == _shape(client, token, src)
    supplier = next(g for g in _groups(client, token, landed) if g["name"] == "Supplier")
    assert supplier["unused"] == ["Not yet"]


def test_a_stale_group_list_in_a_bundle_still_ends_with_every_carried_value(client, token, project):
    """A bundle that went through an older PrismLCA may carry a group list older than its tags; the tags
    are the statement, and the list gains what they carry."""
    from test_bundle import _repack

    src = _model(client, token, "Stale")
    p = _prepared(client, token, src)
    _ok(_set(client, token, [(src, p)], "Material", "Steel"))

    def forget(section: dict) -> None:
        section["tag_groups"] = [g for g in section["tag_groups"] if g["name"] == "Supplier"]
        section["tag_groups"][0]["values"] = ["Not yet"]

    data = _repack(_export(client, token, src), "tag_groups.json", forget)
    content = base64.b64encode(data).decode("ascii")
    landed = _ok(client.post("/api/v1/bundle/import", json={"content": content, "name": "Fresh"}, headers=token))["database"]
    groups = {g["name"]: g for g in _groups(client, token, landed)}
    assert groups["Supplier"]["values"] == ["Not yet", "Acme"]  # the section's order, the carried value after it
    assert groups["Supplier"]["color"] == "#123456"
    assert groups["Material"]["values"] == ["Steel"] and groups["Material"]["color"]


# --- a read may write, so it stays inside one workspace -----------------------------------------
def test_reading_a_models_groups_waits_for_a_workspace_switch(client, token, project):
    """Reading completes the list from the tags and may save it. A workspace switch holds the project
    lock; a read that did not wait for it could collect one workspace's tags and save into the other's
    file."""
    import threading

    from prism_lca.engine.commands import PROJECT_LOCK
    from prism_lca.engine.tags import TagStore

    db = _model(client, token)
    code = _process(client, token, db)
    TagStore().add(db, code, "Supplier", "Acme")  # carried, not yet in the list: the read will save

    done = threading.Event()
    seen: list[list[dict]] = []

    def read() -> None:
        seen.append(TagGroupStore().list_groups(db))
        done.set()

    holder_has_it, release = threading.Event(), threading.Event()

    def hold() -> None:  # stands in for the switch: another thread holding the project lock
        with PROJECT_LOCK:
            holder_has_it.set()
            release.wait(10)

    holder = threading.Thread(target=hold)
    holder.start()
    assert holder_has_it.wait(10)
    reader = threading.Thread(target=read)
    reader.start()
    assert not done.wait(0.3), "the read went ahead while another thread held the project lock"
    release.set()
    assert done.wait(10)
    holder.join(10)
    reader.join(10)
    assert [g["name"] for g in seen[0]] == ["Supplier"]

