"""Parameter names a formula cannot read are refused with a name it can (µ, ², ₂ and friends).

Python reads names in normal form NFKC, so the micro sign µ (typed with AltGr+M) becomes the Greek mu μ inside
a formula, and m² becomes m2: a parameter named that way could never be found by a formula. The engine
underneath refused such a name, but with "Parameter update failed … not a valid Python name" and a hint to
check the formula — the wrong place to look.
"""
from __future__ import annotations

import pytest

from prism_lca.engine.bootstrap import get_bd

DB = "pn"


@pytest.fixture
def model(client, token, project):
    get_bd().Database(DB).write(
        {(DB, "p"): {"name": "p", "unit": "kilogram", "reference product": "p",
                     "exchanges": [{"input": (DB, "p"), "amount": 1, "type": "production"}]}}
    )


def _set(client, token, name, **extra):
    return client.post("/api/v1/params", json={"database": DB, "name": name, "amount": 1.0, **extra}, headers=token)


@pytest.mark.parametrize(
    ("name", "suggested"),
    [("µ_x", "μ_x"), ("fläche_m²", "fläche_m2"), ("co₂_kg", "co2_kg"), ("mass-kg", "mass_kg"), ("2nd_coat", "p_2nd_coat")],
)
def test_a_name_a_formula_cannot_read_is_refused_with_one_it_can(client, token, model, name, suggested):
    r = _set(client, token, name)
    assert r.status_code == 400, r.text
    err = r.json()["error"]
    assert err["code"] == "invalid_name", err
    assert f"'{suggested}'" in err["hint"], err


def test_letters_of_any_script_stay_allowed(client, token, model):
    assert _set(client, token, "transport_händler_km").status_code == 200
    assert _set(client, token, "μ_x").status_code == 200  # the Greek letter itself is what a formula reads


def test_the_batch_refuses_it_too(client, token, model):
    r = client.post(
        "/api/v1/params/bulk",
        json={"database": DB, "parameters": [{"name": "ok_a", "amount": 1.0}, {"name": "µ_b", "amount": 2.0}]},
        headers=token,
    )
    assert r.status_code == 400, r.text
    assert "'μ_b'" in r.json()["error"]["hint"]
