from __future__ import annotations

import math

import stats_arrays as sa

from prism_lca.engine import model as M
from prism_lca.engine.pedigree import gsd_from_pedigree


def _fg(client, token) -> str:
    import uuid

    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def test_pedigree_math():
    # [3,2,4,1,5] -> exp(sqrt(ln1.10^2+ln1.02^2+ln1.20^2+ln1.00^2+ln2.00^2)) ~= 2.061
    assert abs(gsd_from_pedigree([3, 2, 4, 1, 5]) - 2.0613) < 0.01


def test_activity_fields_and_undo(client, token, project):
    db = _fg(client, token)
    code = _create(client, token, db, "A")
    r = client.post(
        "/api/v1/model/activities/fields",
        json={"database": db, "code": code, "name": "Renamed", "location": "DE",
              "doc": {"data_source": "works 2025", "reference_year": "2025"}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["doc"]["data_source"] == "works 2025"

    det = client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).json()
    assert det["activity"]["name"] == "Renamed"
    assert det["activity"]["location"] == "DE"

    client.post("/api/v1/model/undo", headers=token)
    det2 = client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).json()
    assert det2["activity"]["name"] == "A"


def test_pedigree_on_exchange_and_undo(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    uid = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db,
              "input_code": b, "amount": 2.0},
        headers=token,
    ).json()["exchange"]["uid"]

    r = client.post(
        "/api/v1/model/exchanges/pedigree",
        json={"activity_database": db, "activity_code": a, "uid": uid, "scores": [3, 2, 4, 1, 5]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(r.json()["exchange"]["gsd"] - 2.0613) < 0.01

    snap = M.exchange_uncertainty_snapshot(db, a, uid)
    assert snap["uncertainty type"] == sa.LognormalUncertainty.id
    assert abs(snap["scale"] - math.log(2.0613)) < 0.01
    assert snap["pedigree"] == [3, 2, 4, 1, 5]

    client.post("/api/v1/model/undo", headers=token)
    snap2 = M.exchange_uncertainty_snapshot(db, a, uid)
    assert snap2.get("uncertainty type") in (0, None, sa.UndefinedUncertainty.id)
    assert not snap2.get("pedigree")
