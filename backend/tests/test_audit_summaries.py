"""What an audit line says — names and old → new values, not codes and uids.

The log is read by a person reconstructing what happened. `Set exchange 3f2a1b09 amount to 0.5`
answers none of their questions: which flow, in which process, from what value? These tests pin
the readable form: process and flow NAMES (captured while both still exist, with the identifier as
the honest fallback), the previous value where the command holds it anyway for undo, and short
excerpts instead of raw payloads. And one negative pin: the prose still never names the model —
attribution lives in the `database` field, not in the sentence (D1).
"""
from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    name = "lines-" + uuid.uuid4().hex[:8]
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    return name


def _create(client, token, db, name, unit="kg") -> str:
    r = client.post("/api/v1/model/activities",
                    json={"database": db, "name": name, "unit": unit}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def _last_summary(client, token, db, action) -> str:
    r = client.get(f"/api/v1/model/audit?database={db}", headers=token)
    assert r.status_code == 200, r.text
    rows = [e for e in r.json() if e["action"] == action]
    assert rows, f"no '{action}' entry in the log"
    return rows[-1]["summary"]


def test_exchange_lines_name_the_flow_the_process_and_the_old_value(client, token, project):
    db = _fg(client, token)
    frame = _create(client, token, db, "Frame production")
    steel = _create(client, token, db, "Steel supply")
    r = client.post("/api/v1/model/exchanges",
                    json={"activity_database": db, "activity_code": frame, "input_database": db,
                          "input_code": steel, "amount": 2.5}, headers=token)
    assert r.status_code == 200, r.text
    uid = r.json()["exchange"]["uid"]
    assert _last_summary(client, token, db, "add_exchange") == \
        "Add input 'Steel supply' (2.5 kg) to 'Frame production'"

    r = client.post("/api/v1/model/exchanges/amount",
                    json={"activity_database": db, "activity_code": frame, "uid": uid, "amount": 9},
                    headers=token)
    assert r.status_code == 200, r.text
    assert _last_summary(client, token, db, "set_exchange_amount") == \
        "Set amount of 'Steel supply' in 'Frame production' to 9 kg (was 2.5)"

    r = client.post("/api/v1/model/exchanges/comment",
                    json={"activity_database": db, "activity_code": frame, "uid": uid,
                          "comment": "mass from the manufacturer's manual, see URL"}, headers=token)
    assert r.status_code == 200, r.text
    assert _last_summary(client, token, db, "set_exchange_comment") == \
        "Comment 'Steel supply' in 'Frame production': “mass from the manufacturer's manual, see URL”"

    r = client.post("/api/v1/model/exchanges/remove",
                    json={"activity_database": db, "activity_code": frame, "uid": uid}, headers=token)
    assert r.status_code == 200, r.text
    assert _last_summary(client, token, db, "remove_exchange") == \
        "Remove 'Steel supply' from 'Frame production' (9 kg)"


def test_parameter_lines_carry_old_and_new(client, token, project):
    db = _fg(client, token)
    for amount in (2.0, 3.5):
        r = client.post("/api/v1/params",
                        json={"database": db, "name": "mass", "amount": amount}, headers=token)
        assert r.status_code == 200, r.text
    assert _last_summary(client, token, db, "set_parameter") == "Set parameter 'mass' = 3.5 (was 2)"
    r = client.post("/api/v1/params/delete", json={"database": db, "name": "mass"}, headers=token)
    assert r.status_code == 200, r.text
    assert _last_summary(client, token, db, "delete_parameter") == "Delete parameter 'mass' (was 3.5)"


def test_delete_names_the_activity_not_its_code(client, token, project):
    db = _fg(client, token)
    code = _create(client, token, db, "Old packaging step")
    r = client.post("/api/v1/model/activities/delete",
                    json={"database": db, "code": code}, headers=token)
    assert r.status_code == 200, r.text
    summary = _last_summary(client, token, db, "delete_activity")
    assert summary == f"Delete process 'Old packaging step' from {db}"
    assert code not in summary  # the name is the point; the code answers nothing


def test_the_prose_still_never_names_the_model(client, token, project):
    """D1 negative pin, carried over: attribution is the field's job, not the sentence's."""
    db = _fg(client, token)
    r = client.post("/api/v1/params", json={"database": db, "name": "mass", "amount": 1}, headers=token)
    assert r.status_code == 200, r.text
    assert db not in _last_summary(client, token, db, "set_parameter")
