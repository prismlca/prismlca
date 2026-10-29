"""The linter's finding ORDER is contract, pinned before the rule-registry refactor.

The linter talks to models: `check_model_health` output goes verbatim into assistant turns and into
the review dossier, so the sequence findings arrive in is part of the observed behaviour — a stable
severity sort over the emission order, which itself is activity-major (rules interleaved per
activity, per exchange) followed by the model-wide checks in their fixed textual order. This test
builds one model that trips findings across all three scopes (per-exchange, per-activity,
model-wide) and pins the exact (severity, code) sequence the current implementation emits.
"""

from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def _edge(client, token, db, a, b, amount=1.0) -> str:
    return client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db,
              "input_code": b, "amount": amount},
        headers=token,
    ).json()["exchange"]["uid"]


def test_finding_sequence_is_stable(client, token, project):
    db = _fg(client, token)
    # Alphabetical creation order = iteration order is not guaranteed, so the model keeps every
    # trigger on ITS OWN activity and the assertion pins what the current implementation emits.
    a = _create(client, token, db, "A root")          # reference process
    b = _create(client, token, db, "B self loop")     # self_loop (warning)
    c = _create(client, token, db, "C zero prod")     # zero_production_amount (error)
    _create(client, token, db, "D twin")              # duplicate_identity with its twin (info)
    _create(client, token, db, "D twin")              # the twin

    _edge(client, token, db, a, b)
    _edge(client, token, db, b, b)                    # self-loop
    _edge(client, token, db, a, c)
    _edge(client, token, db, c, a)                    # cycle a -> c -> a

    # Zero the reference product of C -> error.
    from prism_lca.engine.model import get_activity

    act = get_activity(db, c)
    for ex in act.exchanges():
        if ex.get("type") == "production":
            ex["amount"] = 0.0
            ex.save()

    # A parameter nothing reaches -> unused_parameter (info, model-wide).
    r = client.post(
        "/api/v1/params",
        json={"database": db, "name": "dead_share", "amount": 0.3},
        headers=token,
    )
    assert r.status_code == 200, r.text

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    sequence = [(f["severity"], f["code"]) for f in h["findings"]]
    assert sequence == PINNED, sequence


#: What the pre-registry implementation emits for the model above, verbatim. If a refactor changes
#: this list, that is a behaviour change to justify, not a test to update in passing.
PINNED = [
    ("error", "zero_production_amount"),
    ("warning", "self_loop"),
    # Added with the check for processes nothing consumes: the two "D twin" processes hang on nothing
    # (A and C consume each other), so one of them is what the model is calculated from and the other
    # is outside the result.
    ("warning", "disconnected_process"),
    ("warning", "circular_reference"),
    ("info", "unrecorded_scope"),
    ("info", "unused_parameter"),
    ("info", "duplicate_identity"),
]
