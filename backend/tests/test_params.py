from __future__ import annotations

import math
import uuid

import pytest


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def _amount(client, token, db, code, uid) -> float:
    d = client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).json()
    return next(e["amount"] for e in d["exchanges"] if e["uid"] == uid)


def _exchange(client, token, db, a, b) -> str:
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db,
              "input_code": b, "amount": 0},
        headers=token,
    )
    return r.json()["exchange"]["uid"]


def _param(client, token, db, name, **body):
    return client.post("/api/v1/params", json={"database": db, "name": name, **body}, headers=token)


def _plist(client, token, db) -> list[dict]:
    return client.get("/api/v1/params", params={"database": db}, headers=token).json()


def _glist(client, token, db) -> list[dict]:
    return client.get("/api/v1/params/groups", params={"database": db}, headers=token).json()


def test_parameter_drives_exchange_and_undo(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)

    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(_amount(client, token, db, a, uid) - 6.0) < 1e-9

    assert _param(client, token, db, "mass", amount=5.0).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 15.0) < 1e-9

    client.post("/api/v1/model/undo", headers=token)  # undo mass=5 -> mass=2
    assert abs(_amount(client, token, db, a, uid) - 6.0) < 1e-9


def test_setting_a_formula_answers_with_the_evaluated_amount(client, token, project):
    """The response must carry the quantity the formula came to, not the one it replaced.

    The exchange starts at 0 (that is what an `action="add"` with a formula creates), so returning
    the pre-recalculation copy answered `"amount": 0` for a formula that had stored 6.0 perfectly
    well. An assistant that verifies its own writes reads that as a failure and redoes the work.
    """
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200

    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert abs(body["exchange"]["amount"] - 6.0) < 1e-9, body
    assert body["exchange"]["formula"] == "mass * 3"
    # Clearing it keeps the number and must still report it (no recalculation runs on this path).
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": ""},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(r.json()["exchange"]["amount"] - 6.0) < 1e-9


def test_metadata_only_update_keeps_amount_and_formula(client, token, project):
    """Updating only unit/description must NOT reset an existing parameter's amount to 0 or
    drop its formula (P10: bw2data's reformat defaults missing keys destructively)."""
    db = _fg(client, token)
    assert _param(client, token, db, "base", amount=3.0).status_code == 200
    assert _param(client, token, db, "derived", formula="base * 2").status_code == 200

    # metadata-only updates (no amount, no formula)
    _param(client, token, db, "base", unit="kg")
    _param(client, token, db, "derived", description="twice base")

    ps = {p["name"]: p for p in _plist(client, token, db)}
    assert ps["base"]["amount"] == 3.0
    assert ps["base"].get("unit") == "kg"
    assert ps["derived"]["formula"] == "base * 2"
    assert abs(ps["derived"]["amount"] - 6.0) < 1e-9


def test_list_group_and_delete(client, token, project):
    db = _fg(client, token)
    assert _param(client, token, db, "foo", amount=3.0, group="energy", unit="kWh").status_code == 200
    p = next(x for x in _plist(client, token, db) if x["name"] == "foo")
    assert p["amount"] == 3.0 and p["group"] == "energy" and p["unit"] == "kWh"

    assert client.post("/api/v1/params/delete", json={"database": db, "name": "foo"}, headers=token).status_code == 200
    assert not any(x["name"] == "foo" for x in _plist(client, token, db))


def test_direct_amount_edit_detaches_formula(client, token, project):
    """Setting a plain amount on a formula-driven exchange must remove the formula — otherwise
    the next parameter recalculation would silently revert the manual edit (Befund 11). Undo
    brings the formula back, alive."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "m11", amount=2.0).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "m11 * 3"},
        headers=token,
    ).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 6.0) < 1e-9

    r = client.post(
        "/api/v1/model/exchanges/amount",
        json={"activity_database": db, "activity_code": a, "uid": uid, "amount": 1.5},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(_amount(client, token, db, a, uid) - 1.5) < 1e-9

    # A parameter change must no longer overwrite the manual amount.
    assert _param(client, token, db, "m11", amount=7.0).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 1.5) < 1e-9

    client.post("/api/v1/model/undo", headers=token)  # undo m11=7 → m11=2 (amount stays manual)
    assert abs(_amount(client, token, db, a, uid) - 1.5) < 1e-9
    client.post("/api/v1/model/undo", headers=token)  # undo the manual amount → formula is back
    assert abs(_amount(client, token, db, a, uid) - 6.0) < 1e-9
    # ... and it responds to parameter changes again.
    assert _param(client, token, db, "m11", amount=4.0).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 12.0) < 1e-9


def test_duplicate_keeps_formulas_alive(client, token, project):
    """Duplicating an activity must register the copy's formulas in their own parameter group —
    otherwise recalc_all() (which only walks existing groups) would never update them and the
    copy would keep its static amounts forever (Befund 12)."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "m12", amount=2.0).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "m12 * 3"},
        headers=token,
    ).status_code == 200

    r = client.post("/api/v1/model/activities/duplicate", json={"database": db, "code": a}, headers=token)
    assert r.status_code == 200, r.text
    copy_code = r.json()["activity"]["code"]
    d = client.get(f"/api/v1/model/activities/{db}/{copy_code}", headers=token).json()
    copy_uid, copy_amount = next(
        (e["uid"], e["amount"]) for e in d["exchanges"] if e.get("formula") == "m12 * 3"
    )
    assert abs(copy_amount - 6.0) < 1e-9

    # The copy's formula must react to parameter changes just like the original's.
    assert _param(client, token, db, "m12", amount=5.0).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 15.0) < 1e-9
    assert abs(_amount(client, token, db, copy_code, copy_uid) - 15.0) < 1e-9


def test_fx_off_via_inspector_stops_recalculation(client, token, project):
    """Toggling fx off in the inspector (exchange-formula with formula=null) must drop the
    ParameterizedExchange mirror row too — otherwise the next parameter recalculation would
    revert the amount to the old formula result (latent bug the mirror-row cleanup fixes)."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mf", amount=2.0).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mf * 3"},
        headers=token,
    ).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 6.0) < 1e-9

    # fx off + a manual amount edit.
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": None},
        headers=token,
    ).status_code == 200
    assert client.post(
        "/api/v1/model/exchanges/amount",
        json={"activity_database": db, "activity_code": a, "uid": uid, "amount": 9.0},
        headers=token,
    ).status_code == 200

    # A later parameter change must NOT resurrect the old formula.
    assert _param(client, token, db, "mf", amount=10.0).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 9.0) < 1e-9


def test_duplicate_of_parameterized_activity_undo_is_clean(client, token, project):
    """Undo of a duplicate (activity delete) must not choke on the copy's registered parameter
    group, and the original must keep reacting to parameter changes afterwards."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mu", amount=2.0).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mu * 3"},
        headers=token,
    ).status_code == 200
    assert client.post(
        "/api/v1/model/activities/duplicate", json={"database": db, "code": a}, headers=token
    ).status_code == 200

    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    # Original still parameter-driven after the copy is gone.
    assert _param(client, token, db, "mu", amount=4.0).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 12.0) < 1e-9


def test_delete_parameterized_activity_keeps_params_working(client, token, project):
    """Deleting a parameterised foreground activity leaves an orphan Group row (bw2data cleans
    only ActivityParameter + ParameterizedExchange). recalc_all() must purge it, otherwise the
    next parameter update crashes with DoesNotExist."""
    db = _fg(client, token)
    a, b, c = _create(client, token, db, "A"), _create(client, token, db, "B"), _create(client, token, db, "C")
    uid_a = _exchange(client, token, db, a, b)
    uid_c = _exchange(client, token, db, c, b)
    assert _param(client, token, db, "md", amount=2.0).status_code == 200
    for code, uid in ((a, uid_a), (c, uid_c)):
        assert client.post(
            "/api/v1/params/exchange-formula",
            json={"activity_database": db, "activity_code": code, "uid": uid, "formula": "md * 3"},
            headers=token,
        ).status_code == 200

    # Delete A (force: B is consumed by C too, but A itself is a consumer — delete is direct).
    assert client.post(
        "/api/v1/model/activities/delete", json={"database": db, "code": a, "force": True}, headers=token
    ).status_code == 200

    # Parameter updates must still work and still drive C's formula.
    assert _param(client, token, db, "md", amount=5.0).status_code == 200
    assert abs(_amount(client, token, db, c, uid_c) - 15.0) < 1e-9


def test_parameter_group_crud_and_assignment(client, token, project):
    """Groups are first-class: create, assign a parameter, rename, and delete — deleting a group
    un-assigns its parameters but never deletes them."""
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    r = client.post("/api/v1/params/groups", json={"database": db, "name": "Bottle"}, headers=token)
    assert r.status_code == 200, r.text
    gid = r.json()["group"]["id"]
    # duplicate name (case-insensitive) rejected
    assert client.post("/api/v1/params/groups", json={"database": db, "name": "bottle"}, headers=token).status_code == 409

    # assign the parameter to the group
    assert client.post("/api/v1/params/group", json={"database": db, "name": "mass", "group_id": gid}, headers=token).status_code == 200
    p = next(x for x in _plist(client, token, db) if x["name"] == "mass")
    assert p["group_id"] == gid and p["group"] == "Bottle"

    # rename the group → the parameter still points at the same id, new name resolves
    assert client.post("/api/v1/params/groups/rename", json={"database": db, "id": gid, "name": "Packaging"}, headers=token).status_code == 200
    p = next(x for x in _plist(client, token, db) if x["name"] == "mass")
    assert p["group_id"] == gid and p["group"] == "Packaging"

    # delete the group → parameter survives, now un-grouped
    assert client.post("/api/v1/params/groups/delete", json={"database": db, "id": gid}, headers=token).status_code == 200
    names = [x["name"] for x in _plist(client, token, db)]
    assert "mass" in names
    p = next(x for x in _plist(client, token, db) if x["name"] == "mass")
    assert p["group_id"] is None and p["group"] is None
    assert _glist(client, token, db) == []


def test_delete_group_undo_reassigns(client, token, project):
    """Undo of a group deletion restores the group and re-assigns its former members."""
    db = _fg(client, token)
    _param(client, token, db, "dist", amount=100.0)
    gid = client.post("/api/v1/params/groups", json={"database": db, "name": "Logistics"}, headers=token).json()["group"]["id"]
    client.post("/api/v1/params/group", json={"database": db, "name": "dist", "group_id": gid}, headers=token)
    client.post("/api/v1/params/groups/delete", json={"database": db, "id": gid}, headers=token)
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    groups = _glist(client, token, db)
    assert any(g["id"] == gid and g["name"] == "Logistics" for g in groups)
    p = next(x for x in _plist(client, token, db) if x["name"] == "dist")
    assert p["group_id"] == gid


def test_set_param_with_group_name_resolves_to_group(client, token, project):
    """Creating a parameter with a group NAME (assistant/legacy path) finds-or-creates the group."""
    db = _fg(client, token)
    assert _param(client, token, db, "rate", amount=0.6, group="Bottle").status_code == 200
    groups = _glist(client, token, db)
    assert any(g["name"] == "Bottle" for g in groups)
    p = next(x for x in _plist(client, token, db) if x["name"] == "rate")
    assert p["group"] == "Bottle" and p["group_id"]


def test_bad_formula_rejected(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "unknown_var * 2"},
        headers=token,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "formula_error"


def test_parameters_are_model_scoped(client, token, project):
    """A parameter created in model A is invisible in model B, and B may reuse the name with its
    own value. A's exchange formula resolves A's value, not B's."""
    db_a, db_b = _fg(client, token), _fg(client, token)
    a, b = _create(client, token, db_a, "A"), _create(client, token, db_a, "B")
    uid = _exchange(client, token, db_a, a, b)
    assert _param(client, token, db_a, "mass", amount=2.0).status_code == 200
    assert _param(client, token, db_b, "mass", amount=100.0).status_code == 200

    # A's list has mass=2, B's list has mass=100 — independent.
    assert next(p for p in _plist(client, token, db_a) if p["name"] == "mass")["amount"] == 2.0
    assert next(p for p in _plist(client, token, db_b) if p["name"] == "mass")["amount"] == 100.0

    # A's formula resolves A's mass (2*3=6), unaffected by B's mass=100.
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db_a, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    ).status_code == 200
    assert abs(_amount(client, token, db_a, a, uid) - 6.0) < 1e-9


def test_duplicate_model_carries_params_groups(client, token, project):
    """Duplicating a model copies its parameters (with group assignment) and the copy is
    independent: editing the copy's parameter does not change the source's."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    gid = client.post("/api/v1/params/groups", json={"database": db, "name": "G"}, headers=token).json()["group"]["id"]
    assert _param(client, token, db, "mass", amount=2.0, group_id=gid).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    ).status_code == 200

    copy = "copy-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground/duplicate", json={"source": db, "name": copy}, headers=token).status_code == 200

    # The copy has the parameter (assigned to a copied group) and one group.
    cp = _plist(client, token, copy)
    m = next(p for p in cp if p["name"] == "mass")
    assert m["amount"] == 2.0 and m["group_id"] and m["group"] == "G"
    assert len(_glist(client, token, copy)) == 1

    # Independence: change the copy's mass, the source's stays 2.
    assert _param(client, token, copy, "mass", amount=9.0).status_code == 200
    assert next(p for p in _plist(client, token, copy) if p["name"] == "mass")["amount"] == 9.0
    assert next(p for p in _plist(client, token, db) if p["name"] == "mass")["amount"] == 2.0


def test_a_duplicated_model_is_not_frozen(client, token, project):
    """The copy's formulas must be live, not decorative.

    The copied exchanges carry their formula text, but a formula belonging to no parameter group is
    never recalculated. The copy then looked complete — parameters listed, formulas shown in the
    editor — while every parameter edit was a silent no-op and the numbers stood at whatever the
    source had when it was copied.
    """
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    ).status_code == 200

    copy = "copy-" + uuid.uuid4().hex[:6]
    assert client.post(
        "/api/v1/databases/foreground/duplicate", json={"source": db, "name": copy}, headers=token
    ).status_code == 200

    # Find "A" and its formula-bearing exchange in the copy (codes and uids are freshly minted).
    acts = client.get(f"/api/v1/model/activities/{copy}", headers=token).json()
    a2 = next(x["code"] for x in acts if x["name"] == "A")
    detail = client.get(f"/api/v1/model/activities/{copy}/{a2}", headers=token).json()
    ex = next(e for e in detail["exchanges"] if e.get("formula") == "mass * 3")
    assert abs(ex["amount"] - 6.0) < 1e-9  # copied as-is

    # …and it moves when the copy's own parameter moves.
    assert _param(client, token, copy, "mass", amount=5.0).status_code == 200
    assert abs(_amount(client, token, copy, a2, ex["uid"]) - 15.0) < 1e-9
    # The source is untouched.
    assert abs(_amount(client, token, db, a, uid) - 6.0) < 1e-9


def test_rename_and_delete_model_move_params(client, token, project):
    """Rename re-keys a model's parameters/groups to the new name AND keeps its exchange formulas
    alive; delete removes everything."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    client.post("/api/v1/params/groups", json={"database": db, "name": "G"}, headers=token)
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    ).status_code == 200
    assert abs(_amount(client, token, db, a, uid) - 6.0) < 1e-9

    new = "renamed-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground/rename", json={"database": db, "name": new}, headers=token).status_code == 200
    assert [p["name"] for p in _plist(client, token, new)] == ["mass"]
    assert _plist(client, token, db) == []  # nothing left under the old name
    assert len(_glist(client, token, new)) == 1
    # The formula survived the rename and still reacts to parameter changes under the new name.
    assert abs(_amount(client, token, new, a, uid) - 6.0) < 1e-9
    assert _param(client, token, new, "mass", amount=5.0).status_code == 200
    assert abs(_amount(client, token, new, a, uid) - 15.0) < 1e-9

    assert client.post("/api/v1/databases/foreground/delete", json={"database": new}, headers=token).status_code == 200
    assert _plist(client, token, new) == []
    assert _glist(client, token, new) == []


def test_migration_project_globals_to_models(client, token, project):
    """The one-time migration copies legacy project-global parameters into every foreground model
    and deletes the originals; it is idempotent."""
    from prism_lca.engine import params as _p
    from prism_lca.engine.bootstrap import get_bd

    db_a, db_b = _fg(client, token), _fg(client, token)

    # Seed a legacy project-global parameter directly (the pre-migration world) and clear the
    # marker the app fixture wrote for this fresh project.
    bd = get_bd()
    from bw2data.parameters import ProjectParameter, parameters
    parameters.new_project_parameters([{"name": "legacy", "amount": 7.0}], overwrite=True)
    marker = __import__("pathlib").Path(bd.projects.dir) / "prism_meta" / "param_scope_migrated.json"
    if marker.exists():
        marker.unlink()

    assert _p.migrate_project_to_models() is True
    # Copied into BOTH models, original ProjectParameter gone.
    assert next(p for p in _plist(client, token, db_a) if p["name"] == "legacy")["amount"] == 7.0
    assert next(p for p in _plist(client, token, db_b) if p["name"] == "legacy")["amount"] == 7.0
    assert ProjectParameter.select().count() == 0
    # Idempotent: a second run is a no-op.
    assert _p.migrate_project_to_models() is False


def test_a_parameter_behind_a_parameter_is_not_reported_as_unused(client, token, project):
    """A volume and a density drive a mass and no exchange. `used_by` counted exchanges only, so
    both came back empty — which the page renders as "no process" and the assistant reads as a
    leftover it may tidy away."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    _param(client, token, db, "volume_ml", amount=250.0)
    _param(client, token, db, "density_kgl", amount=1.03)
    _param(client, token, db, "mass_kg", formula="volume_ml * density_kgl / 1000")
    _param(client, token, db, "spare", amount=1.0)  # genuinely referenced by nothing
    client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass_kg"},
        headers=token,
    )

    rows = {p["name"]: p for p in client.get(
        "/api/v1/params", params={"database": db, "with_usage": True}, headers=token
    ).json()}

    # The drivers: no exchange of their own, but the mass depends on them.
    assert rows["volume_ml"]["used_by"] == []
    assert [u["name"] for u in rows["volume_ml"]["used_by_parameters"]] == ["mass_kg"]
    assert rows["volume_ml"]["used_by_count"] == 1
    assert rows["density_kgl"]["used_by_count"] == 1
    # The mass itself drives the exchange, and nothing depends on it.
    assert rows["mass_kg"]["used_by_count"] == 1
    assert rows["mass_kg"]["used_by_parameters"] == []
    # And the leftover is still a leftover.
    assert rows["spare"]["used_by_count"] == 0

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    unused = [f for f in h["findings"] if f["code"] == "unused_parameter"]
    assert [f["parameter"] for f in unused] == ["spare"]
    assert unused[0]["severity"] == "info"
    assert unused[0]["activity"] is None
    assert h["ok"] is True


def test_evaluate_formula_answers_before_anything_is_stored(client, token):
    """Trying a formula must give the number without writing it anywhere.

    Before this, the only way to learn what an expression came to was to store it and recalculate,
    so the safe move was to do the arithmetic by hand first — which is the work the parameters are
    there to remove.
    """
    db = _fg(client, token)
    _param(client, token, db, "mass_fertiliser", amount=2.5)
    _param(client, token, db, "n_content", amount=0.07)

    r = client.post(
        "/api/v1/params/evaluate",
        json={"database": db, "formula": "mass_fertiliser * n_content * 44/28"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    got = r.json()
    assert abs(got["value"] - 0.275) < 1e-9
    assert got["used"] == {"mass_fertiliser": 2.5, "n_content": 0.07}
    # Nothing was created by asking.
    assert {p["name"] for p in _plist(client, token, db)} == {"mass_fertiliser", "n_content"}


def test_evaluate_formula_overrides_do_not_touch_the_model(client, token):
    """A what-if answers the question and leaves the stored value where it was."""
    db = _fg(client, token)
    _param(client, token, db, "d_last_mile", amount=10)

    whatif = client.post(
        "/api/v1/params/evaluate",
        json={"database": db, "formula": "d_last_mile * 2", "overrides": {"d_last_mile": 20}},
        headers=token,
    ).json()
    assert whatif["value"] == 40

    plain = client.post(
        "/api/v1/params/evaluate",
        json={"database": db, "formula": "d_last_mile * 2"},
        headers=token,
    ).json()
    assert plain["value"] == 20


def test_evaluate_formula_names_the_parameter_it_does_not_know(client, token):
    """A mistyped parameter has to come back AS the typo, not as a generic failure."""
    db = _fg(client, token)
    _param(client, token, db, "mass_fertiliser", amount=2.5)

    r = client.post(
        "/api/v1/params/evaluate",
        json={"database": db, "formula": "mass_fertilizer * 2"},
        headers=token,
    )
    assert r.status_code >= 400
    assert "mass_fertilizer" in r.text


# --- V228 / V232: many parameters, one transaction, one recalculation --------------------------


def test_a_bulk_write_lets_formulas_inside_the_batch_refer_to_each_other(client, token):
    """The defect this endpoint exists for: one call per parameter has no ordering, so a formula
    naming a parameter created two rows below fails with "variables aren't defined" — which reads
    like a typo and is nothing of the sort (V232)."""
    db = _fg(client, token)

    # The old shape, item by item, in the order a person would write them down.
    one = _param(client, token, db, "total_mass", formula="unit_mass * count")
    assert one.status_code == 400, one.text
    assert one.json()["error"]["code"] == "param_error"

    r = client.post(
        "/api/v1/params/bulk",
        json={
            "database": db,
            "parameters": [
                {"name": "total_mass", "formula": "unit_mass * count", "unit": "kg"},
                {"name": "unit_mass", "amount": 2.5, "unit": "kg"},
                {"name": "count", "amount": 4},
            ],
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    by_name = {p["name"]: p for p in r.json()["parameters"]}
    assert by_name["total_mass"]["amount"] == 10.0
    assert by_name["total_mass"]["formula"] == "unit_mass * count"
    assert by_name["total_mass"]["unit"] == "kg"


def test_a_bulk_write_is_one_audit_entry_and_undoes_as_one_step(client, token):
    db = _fg(client, token)
    r = client.post(
        "/api/v1/params/bulk",
        json={
            "database": db,
            "parameters": [{"name": "a", "amount": 1}, {"name": "b", "amount": 2},
                           {"name": "c", "formula": "a + b"}],
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert {p["name"] for p in _plist(client, token, db)} == {"a", "b", "c"}

    log = client.get("/api/v1/model/audit", params={"database": db}, headers=token).json()
    mine = [e for e in log if e.get("action") == "set_parameters"]
    assert len(mine) == 1, [e.get("action") for e in log]
    assert "3 parameters" in mine[0]["summary"]

    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert _plist(client, token, db) == []


def test_a_bulk_write_refuses_the_same_name_twice(client, token):
    db = _fg(client, token)
    r = client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "x", "amount": 1}, {"name": "x", "amount": 2}]},
        headers=token,
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "duplicate_parameter"


def test_a_bulk_write_reaches_the_exchanges_it_drives(client, token):
    db = _fg(client, token)
    a, b = _create(client, token, db, "a"), _create(client, token, db, "b")
    uid = _exchange(client, token, db, a, b)
    assert client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "n", "amount": 3}, {"name": "m", "formula": "n * 2"}]},
        headers=token,
    ).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "m"},
        headers=token,
    ).status_code == 200
    assert _amount(client, token, db, a, uid) == 6.0
    # The part that was missing: the formula endpoint recalculates by itself, so the
    # line above proved nothing about the batch. A later batch must move the bound exchange too.
    assert client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "n", "amount": 4}]},
        headers=token,
    ).status_code == 200
    assert _amount(client, token, db, a, uid) == 8.0


# --- V231: a formula that moves the amount says so ---------------------------------------------


def test_setting_a_formula_reports_the_amount_it_replaced(client, token):
    db = _fg(client, token)
    a, b = _create(client, token, db, "set"), _create(client, token, db, "inverter")
    uid = _exchange(client, token, db, a, b)
    assert client.post(
        "/api/v1/model/exchanges/amount",
        json={"activity_database": db, "activity_code": a, "uid": uid, "amount": 1},
        headers=token,
    ).status_code == 200
    assert _param(client, token, db, "replacements", amount=0).status_code == 200

    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "replacements"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["amount_before"] == 1
    assert body["exchange"]["amount"] == 0
    assert "from 1 to 0" in body["amount_changed"]


def test_a_formula_that_lands_on_the_same_amount_says_nothing(client, token):
    db = _fg(client, token)
    a, b = _create(client, token, db, "a"), _create(client, token, db, "b")
    uid = _exchange(client, token, db, a, b)
    assert client.post(
        "/api/v1/model/exchanges/amount",
        json={"activity_database": db, "activity_code": a, "uid": uid, "amount": 2},
        headers=token,
    ).status_code == 200
    assert _param(client, token, db, "two", amount=2).status_code == 200
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "two"},
        headers=token,
    )
    assert r.status_code == 200
    assert "amount_changed" not in r.json()


def test_a_parameter_read_only_by_another_parameter_still_reaches_the_exchange(client, token, project):
    """Scoping the recalculation to one model (V331) must keep the chain inside the model intact: a
    parameter that no exchange names can still feed a parameter that an exchange does name.
    `base` is used by nothing but `derived`; `derived` drives the amount."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "base", amount=2).status_code == 200
    assert _param(client, token, db, "derived", formula="base * 3").status_code == 200
    assert (
        client.post(
            "/api/v1/params/exchange-formula",
            json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "derived * 2"},
            headers=token,
        ).status_code
        == 200
    )
    assert _amount(client, token, db, a, uid) == pytest.approx(12.0)
    assert _param(client, token, db, "base", amount=5).status_code == 200
    assert _amount(client, token, db, a, uid) == pytest.approx(30.0)
    assert next(p for p in _plist(client, token, db) if p["name"] == "derived")["amount"] == pytest.approx(15.0)


def test_a_parameter_edit_in_one_model_leaves_the_other_model_alone(client, token, project):
    """Two models with the same parameter name: editing one must not move the other's amounts —
    the very independence the scoped recalculation relies on."""
    one, two = _fg(client, token), _fg(client, token)
    a1, b1 = _create(client, token, one, "A"), _create(client, token, one, "B")
    a2, b2 = _create(client, token, two, "A"), _create(client, token, two, "B")
    u1, u2 = _exchange(client, token, one, a1, b1), _exchange(client, token, two, a2, b2)
    for db, u, code in ((one, u1, a1), (two, u2, a2)):
        assert _param(client, token, db, "mass", amount=1).status_code == 200
        client.post(
            "/api/v1/params/exchange-formula",
            json={"activity_database": db, "activity_code": code, "uid": u, "formula": "mass * 10"},
            headers=token,
        )
    assert _param(client, token, one, "mass", amount=4).status_code == 200
    assert _amount(client, token, one, a1, u1) == pytest.approx(40.0)
    assert _amount(client, token, two, a2, u2) == pytest.approx(10.0)


def test_setting_an_uncertainty_keeps_the_formula_driven_amount(client, token, project):
    """A lognormal states its median, and that median used to land in `amount` — replacing what the
    formula had computed until some later recalculation happened to pass (found once the
    recalculation stopped passing everywhere). The spread stays, the amount is the formula's."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mass", amount=0.5).status_code == 200
    client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 2"},
        headers=token,
    )
    assert _amount(client, token, db, a, uid) == pytest.approx(1.0)
    r = client.post(
        "/api/v1/model/exchanges/uncertainty",
        json={"activity_database": db, "activity_code": a, "uid": uid, "distribution": "lognormal",
              "params": {"median": 2.5, "gsd": 1.2}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["exchange"]["amount"] == pytest.approx(1.0)
    assert _amount(client, token, db, a, uid) == pytest.approx(1.0)
    # The distribution is reported in the review detail, under `type` — the old assertion read a field
    # that never existed and fell back to its own expected value.
    d = client.get(f"/api/v1/model/activities/{db}/{a}?detail=review", headers=token).json()
    ex = next(e for e in d["exchanges"] if e["uid"] == uid)
    assert ex["uncertainty"]["type"] == "lognormal"
    assert ex["uncertainty"]["scale"] == pytest.approx(math.log(1.2))


# --- V339: notes that still quote the value a parameter no longer has ----------------------------


def test_changing_a_value_names_the_notes_that_still_quote_the_old_one(client, token, project):
    """A model moved `heating_electricity_per_dose` from 0.047 to 0.048; the exchange
    note "0.047 kWh per event is an engineering proxy" never named the parameter, so the health
    check's stale-figure rule could not see it, and it went into the report as written."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "use phase"), _create(client, token, db, "electricity")
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b,
              "amount": 0, "comment": "0.047 kWh per event is an engineering proxy for heating 0.625 kg."},
        headers=token,
    )
    uid = r.json()["exchange"]["uid"]
    assert _param(client, token, db, "heating_kwh", amount=0.047).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "4 * heating_kwh"},
        headers=token,
    ).status_code == 200

    # A metadata-only edit changes no number: no notes.
    same = _param(client, token, db, "heating_kwh", description="engineering estimate").json()
    assert "stale_notes" not in same

    # The bulk route — one transaction — reports the same thing the single write does.
    bulk = client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "heating_kwh", "amount": 0.048}]},
        headers=token,
    ).json()
    notes = bulk["stale_notes"]
    assert len(notes) == 1
    assert notes[0]["where"] == "exchange" and notes[0]["uid"] == uid
    assert notes[0]["was"] == 0.047 and notes[0]["now"] == 0.048
    assert "0.047 kWh per event" in notes[0]["quote"]
    assert "set_comment" in bulk["hint"]

    # 0.048 → 0.05: the note still says 0.047, which is not the value just replaced — nothing to report.
    assert "stale_notes" not in _param(client, token, db, "heating_kwh", amount=0.05).json()


def test_a_refused_bulk_write_keeps_nothing_of_the_batch(client, token):
    """The rules are checked after the write; a violation put ONE parameter back and
    left the rest of the batch standing, unchecked."""
    db = _fg(client, token)
    rule = {"kind": "range", "min": 0.0, "max": 1.0}
    assert _param(client, token, db, "a", amount=0.5, rule=rule).status_code == 200
    assert _param(client, token, db, "b", amount=0.5, rule=rule).status_code == 200
    r = client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "a", "formula": "-1"}, {"name": "b", "formula": "-1"}]},
        headers=token,
    )
    assert r.status_code >= 400, r.text
    assert r.json()["error"]["code"] == "param_value_refused"
    by_name = {p["name"]: p for p in _plist(client, token, db)}
    assert by_name["a"]["amount"] == 0.5 and by_name["b"]["amount"] == 0.5
    assert not by_name["a"].get("formula") and not by_name["b"].get("formula")


def test_undoing_a_bulk_write_survives_a_cycle_between_the_old_states(client, token):
    """Undo restored the rows one at a time, recalculating after each — and the
    old states a = 1, b = "a" pass through a = "b", b = "a" on the way back, which is a cycle."""
    db = _fg(client, token)
    assert _param(client, token, db, "a", amount=1).status_code == 200
    assert _param(client, token, db, "b", formula="a").status_code == 200
    r = client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "a", "formula": "b"}, {"name": "b", "amount": 2, "formula": ""}]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    by_name = {p["name"]: p for p in _plist(client, token, db)}
    assert by_name["a"]["amount"] == 1 and not by_name["a"].get("formula")
    assert by_name["b"]["formula"] == "a" and by_name["b"]["amount"] == 1


def test_undoing_an_exchange_removal_brings_the_formula_back_alive(client, token):
    """Undo wrote the formula text back onto the recreated exchange but did not
    register it in the parameter group, so the amount never followed the parameter again."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "p", amount=1).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "p"},
        headers=token,
    ).status_code == 200
    assert _amount(client, token, db, a, uid) == 1
    assert client.post(
        "/api/v1/model/exchanges/remove",
        json={"activity_database": db, "activity_code": a, "uid": uid},
        headers=token,
    ).status_code == 200
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert _param(client, token, db, "p", amount=2).status_code == 200
    assert _amount(client, token, db, a, uid) == 2


def test_evaluate_formula_does_not_mistake_syntax_for_parameters(client, token):
    """`if` and `else` were reported as unknown parameter names, with the advice to
    define them first."""
    db = _fg(client, token)
    _param(client, token, db, "p", amount=2)
    r = client.post(
        "/api/v1/params/evaluate", json={"database": db, "formula": "p if p > 0 else 0"}, headers=token
    )
    if r.status_code != 200:
        # The preview interpreter may refuse the conditional itself; it must not blame the keywords.
        assert "'if'" not in r.text and "Unknown name(s) in the formula: else" not in r.text, r.text
    else:
        assert r.json()["value"] == 2


def test_an_empty_formula_makes_the_parameter_a_plain_value_again(client, token):
    """The editor clears the formula field and sends ""; the backend read that as
    "no formula sent" and kept the old one alive."""
    db = _fg(client, token)
    assert _param(client, token, db, "a", amount=2).status_code == 200
    assert _param(client, token, db, "b", formula="a * 3").status_code == 200
    assert _param(client, token, db, "b", formula="", amount=5).status_code == 200
    by_name = {p["name"]: p for p in _plist(client, token, db)}
    assert not by_name["b"].get("formula")
    assert by_name["b"]["amount"] == 5
    # …and a later change of `a` no longer moves it.
    assert _param(client, token, db, "a", amount=10).status_code == 200
    assert {p["name"]: p for p in _plist(client, token, db)}["b"]["amount"] == 5


def test_an_empty_formula_in_a_batch_makes_the_parameter_a_plain_value_again(client, token):
    """V456: the assistant's `clear_formula` reaches the batch as "" — which the batch wrote through as an
    empty formula instead of reading it the way the single write does."""
    db = _fg(client, token)
    assert _param(client, token, db, "a", amount=2).status_code == 200
    assert _param(client, token, db, "b", formula="a * 3").status_code == 200
    r = client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "b", "amount": 0.011, "formula": ""}]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    b = {p["name"]: p for p in _plist(client, token, db)}["b"]
    assert not b.get("formula") and b["amount"] == 0.011
    # A batch item without a formula still keeps one it has.
    assert _param(client, token, db, "c", formula="a * 4").status_code == 200
    r = client.post(
        "/api/v1/params/bulk", json={"database": db, "parameters": [{"name": "c", "unit": "kg"}]}, headers=token
    )
    assert r.status_code == 200, r.text
    assert {p["name"]: p for p in _plist(client, token, db)}["c"]["formula"] == "a * 4"


def test_setting_the_same_value_again_writes_no_audit_line_and_no_undo_step(client, token):
    """Enter then blur commit the same number twice (V413): the second one is not a change."""
    db = _fg(client, token)
    r = client.post("/api/v1/params", json={"database": db, "name": "m", "amount": 4.5, "unit": "kg"}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/params", json={"database": db, "name": "m", "amount": 4.5}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json().get("unchanged") is True
    log = client.get("/api/v1/model/audit", params={"database": db}, headers=token).json()
    assert len([e for e in log if e.get("action") == "set_parameter"]) == 1
    # Undo takes the one real write back — not a no-op first.
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert _plist(client, token, db) == []


def test_undo_never_reaches_a_renamed_model_or_a_new_one_under_its_old_name(client, token, project):
    """After a rename, undo of the model's parameter change failed with 500
    and lost the step; once the old name was reused by a copy, the next undo deleted the parameter
    from THAT copy. The renamed model's steps are dropped now, and nothing else is touched."""
    def params(db: str) -> dict:
        return {p["name"]: p["amount"] for p in client.get(f"/api/v1/params?database={db}", headers=token).json()}

    assert client.post("/api/v1/databases/foreground", json={"name": "A"}, headers=token).status_code == 200
    for amount in (2.0, 3.0):
        r = client.post("/api/v1/params", json={"database": "A", "name": "mass", "amount": amount}, headers=token)
        assert r.status_code == 200, r.text
    r = client.post("/api/v1/databases/foreground/rename", json={"database": "A", "name": "B"}, headers=token)
    assert r.status_code == 200, r.text
    undo = client.post("/api/v1/model/undo", headers=token)
    assert undo.status_code == 409, undo.text  # nothing left to undo — not a 500
    assert params("B") == {"mass": 3.0}
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": "B", "name": "A"}, headers=token)
    assert r.status_code == 200, r.text
    client.post("/api/v1/model/undo", headers=token)  # whatever the copy's own history offers
    assert params("A") == {"mass": 3.0}  # the old steps never reach the new model of that name
    assert params("B") == {"mass": 3.0}


def test_a_failed_undo_keeps_its_step(client, token, project, monkeypatch):
    """The step was popped before the undo ran and not put back when it failed."""
    from prism_lca.engine import commands as cmd

    assert client.post("/api/v1/databases/foreground", json={"name": "K"}, headers=token).status_code == 200
    client.post("/api/v1/params", json={"database": "K", "name": "mass", "amount": 2.0}, headers=token)
    before = client.get("/api/v1/model/history", headers=token).json()["next_undo"]
    monkeypatch.setattr(cmd.SetParameterCommand, "undo", lambda self: (_ for _ in ()).throw(RuntimeError("boom")))
    try:
        r = client.post("/api/v1/model/undo", headers=token)
        assert r.status_code >= 400
    except RuntimeError:
        pass  # the test client re-raises server exceptions; the point is what the stack holds after
    assert client.get("/api/v1/model/history", headers=token).json()["next_undo"] == before


def test_a_step_naming_a_renamed_model_only_in_its_snapshot_is_dropped_too(client, token, project):
    """Removing B's input from A is attributed to B, but its snapshot names A as
    the supplier. Rename A, give the old name to a copy, undo — the input came back linked to the
    copy. A step that names the model anywhere in its state is dropped with the rename."""
    def act(db: str, name: str) -> str:
        r = client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token)
        assert r.status_code == 200, r.text
        return r.json()["activity"]["code"]

    for db in ("A", "B"):
        assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    supplier, consumer = act("A", "Supplier"), act("B", "Consumer")
    r = client.post("/api/v1/model/exchanges", json={
        "activity_database": "B", "activity_code": consumer,
        "input_database": "A", "input_code": supplier, "amount": 2,
    }, headers=token)
    assert r.status_code == 200, r.text
    detail = client.get(f"/api/v1/model/activities/B/{consumer}", headers=token).json()
    uid = next(e["uid"] for e in detail["exchanges"] if e["type"] == "technosphere")
    r = client.post("/api/v1/model/exchanges/remove", json={"activity_database": "B", "activity_code": consumer, "uid": uid}, headers=token)
    assert r.status_code == 200, r.text
    assert client.post("/api/v1/databases/foreground/rename", json={"database": "A", "name": "C"}, headers=token).status_code == 200
    assert client.post("/api/v1/databases/foreground/duplicate", json={"source": "C", "name": "A"}, headers=token).status_code == 200
    before = client.get("/api/v1/model/history", headers=token).json()["next_undo"] or ""
    # Neither the removal nor the link it took back may still be on offer: both name A.
    assert "Remove" not in before and "Supplier" not in before, before
    client.post("/api/v1/model/undo", headers=token)
    copy = client.get("/api/v1/model/activities/A", headers=token).json()
    supplier_in_copy = next(a["code"] for a in copy if a["name"] == "Supplier")
    r = client.get(
        f"/api/v1/model/consumers/B?input_database=A&input_code={supplier_in_copy}", headers=token
    )
    assert r.status_code == 200, r.text
    assert "Consumer" not in r.text, r.text  # the copy under the old name gained no consumer
