"""The location field's suggestions: every location the workspace uses, own ones marked.

The location of an own process is free text, and stays so — but typing it blind
meant guessing whether ecoinvent writes "DE" or "Germany". The suggestions come from what is
installed (dynamic, whatever the user has imported) plus what the user's own models already use.
"""
from __future__ import annotations

from prism_lca.engine import model
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import set_read_only


def _seed() -> None:
    bd = get_bd()
    bd.Database("bg").write(
        {
            ("bg", "a"): {"name": "steel", "unit": "kilogram", "location": "RER", "exchanges": []},
            ("bg", "b"): {"name": "steel", "unit": "kilogram", "location": "GLO", "exchanges": []},
            ("bg", "c"): {"name": "power", "unit": "kilowatt hour", "location": "DE", "exchanges": []},
        }
    )
    set_read_only("bg", True)
    bd.Database("mine").write(
        {
            ("mine", "x"): {"name": "assembly", "unit": "unit", "location": "DE", "exchanges": []},
            ("mine", "y"): {"name": "my own site", "unit": "unit", "location": "Werk Süd", "exchanges": []},
            ("mine", "z"): {"name": "no place", "unit": "unit", "location": "", "exchanges": []},
        }
    )
    set_read_only("mine", False)


def test_background_and_own_locations_with_own_marked(project):
    _seed()
    got = {row["code"]: row["own"] for row in model.location_vocabulary()}
    # Background: offered, not marked. Own: marked — including free text nobody else uses.
    assert got["RER"] is False and got["GLO"] is False
    assert got["DE"] is True  # used in both: it counts as own
    assert got["Werk Süd"] is True
    assert "" not in got


def test_the_route_answers_and_follows_a_new_location(client, token, project):
    _seed()
    r = client.get("/api/v1/model/location-vocabulary", headers=token)
    assert r.status_code == 200, r.text
    assert {"code": "RER", "own": False} in r.json()["locations"]
    # Live, not cached: a location set a moment ago is offered on the next call.
    act = get_bd().Database("mine").get("x")
    act["location"] = "AT"
    act.save()
    codes = {row["code"] for row in client.get("/api/v1/model/location-vocabulary", headers=token).json()["locations"]}
    assert "AT" in codes
