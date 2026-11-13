"""What a refused activity lookup says, and what an ambiguous method name says.

Both were measured to cost a model a round: a background dataset's code sent with the model's own
database name ("not found in 'PET bottle'" — true, and no help), and "matches 4 methods — say which"
followed by ONE candidate. The hints now name what the refusing side can see, without inviting an edit
somewhere it does not belong.
"""

import pytest

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import set_read_only
from prism_lca.engine.model import get_activity
from prism_lca.errors import PrismError


def _two_databases(bd) -> None:
    bd.Database("bg").write({("bg", "pet-granulate"): {"name": "PET granulate", "unit": "kg"}})
    bd.Database("glass").write({("glass", "transport-1"): {"name": "transport", "unit": "tkm"}})
    bd.Database("pet").write({("pet", "bottle"): {"name": "bottle", "unit": "unit"}})
    set_read_only("glass", False)
    set_read_only("pet", False)


def _hint(database: str, code: str) -> str:
    with pytest.raises(PrismError) as caught:
        get_activity(database, code)
    assert caught.value.code == "activity_not_found"
    return caught.value.hint or ""


def test_a_background_code_sent_with_the_models_name_says_where_it_lives_and_that_it_stays_put(project):
    _two_databases(get_bd())
    hint = _hint("pet", "pet-granulate")
    assert "'bg'" in hint and "read-only" in hint
    # The one use that is right in every caller: as an input. Never an invitation to edit it.
    assert "as the input's database" in hint and "cannot be changed" in hint


def test_a_code_from_another_model_is_named_as_such_without_a_suggestion_to_act_there(project):
    _two_databases(get_bd())
    hint = _hint("pet", "transport-1")
    assert hint == "That code is a process in 'glass', not in 'pet'."


def test_behind_the_fence_another_model_is_not_named_but_a_background_still_is(project):
    from prism_lca.engine.model_scope import CURRENT_MODEL_SCOPE

    _two_databases(get_bd())
    token = CURRENT_MODEL_SCOPE.set("pet")
    try:
        assert _hint("pet", "transport-1") == "Check the activity code and database."
        assert "'bg'" in _hint("pet", "pet-granulate")
    finally:
        CURRENT_MODEL_SCOPE.reset(token)
    # Unfenced (MCP, the app itself) the hint names the other model as before.
    assert _hint("pet", "transport-1") == "That code is a process in 'glass', not in 'pet'."


def test_a_code_found_nowhere_keeps_the_plain_hint_and_a_batch_keeps_its_own(project):
    _two_databases(get_bd())
    assert _hint("pet", "no-such-code") == "Check the activity code and database."
    assert '"codes"' in _hint("pet", '["a", "b"]')


SODA = "3fb7e6c01f6a6c14148bda9026e83b0b"
STEAM = "9a1c5e2d7b3f4a6c8e0d2f4b6a8c0e2d"


def _hex_background(bd) -> None:
    bd.Database("eco").write(
        {
            ("eco", SODA): {"name": "market for soda ash, light", "location": "RER", "unit": "kg"},
            ("eco", STEAM): {"name": "steam production", "location": "RER", "unit": "kg"},
        }
    )


def test_a_code_with_a_digit_too_many_names_the_dataset_it_was_meant_to_be_and_does_not_use_it(project):
    _hex_background(get_bd())
    hint = _hint("eco", SODA + "6")
    assert "33 characters" in hint and "has 32" in hint
    assert f"{SODA} ('market for soda ash, light', RER)" in hint
    assert "not used in its place" in hint
    assert STEAM not in hint


def test_a_changed_digit_behind_the_start_is_named_too_and_a_wrong_case_finds_its_code(project):
    _hex_background(get_bd())
    changed = SODA[:20] + ("0" if SODA[20] != "0" else "1") + SODA[21:]
    hint = _hint("eco", changed)
    assert SODA in hint and "characters" not in hint  # same length: nothing to say about it
    assert SODA in _hint("eco", SODA.upper())


def test_a_code_far_from_every_code_says_only_what_is_true(project):
    _hex_background(get_bd())
    # The right length, nothing near: the plain hint.
    assert _hint("eco", "f" * 32) == "Check the activity code and database."
    # A character short, nothing near: the length, and no dataset named.
    hint = _hint("eco", "f" * 31)
    assert hint.startswith("This code has 31 characters; every code in 'eco' has 32.")
    assert "Did you mean" not in hint
    # Far off the database's length: not called a slip.
    assert _hint("eco", "f" * 40) == "Check the activity code and database."


def test_a_slip_in_another_models_code_is_not_named_behind_the_fence(project):
    from prism_lca.engine.model_scope import CURRENT_MODEL_SCOPE

    bd = get_bd()
    _hex_background(bd)
    set_read_only("eco", False)  # now a user's model, not a background
    bd.Database("own").write({("own", "a" * 32): {"name": "bottle", "unit": "unit"}})
    set_read_only("own", False)
    token = CURRENT_MODEL_SCOPE.set("own")
    try:
        assert _hint("eco", SODA + "6") == "Check the activity code and database."
    finally:
        CURRENT_MODEL_SCOPE.reset(token)


def test_an_ambiguous_method_names_the_recommended_one_first_and_still_the_others(client, token, project):
    bd = get_bd()
    bd.Database("biosphere").write({("biosphere", "co2"): {"name": "Carbon dioxide", "unit": "kg"}})
    bd.Database("cfg").write({
        ("cfg", "bottle"): {
            "name": "bottle", "unit": "unit",
            "exchanges": [{"input": ("biosphere", "co2"), "amount": 1, "type": "biosphere"}],
        }
    })
    for name in (
        ("IPCC 2021", "climate change", "global warming potential (GWP100)"),
        ("IPCC 2021", "climate change: fossil", "global warming potential (GWP100)"),
        ("IPCC 2021", "climate change: biogenic (incl. CO2)", "global warming potential (GWP100)"),
    ):
        bd.Method(name).write([(("biosphere", "co2"), 1.0)])
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method": "IPCC 2021 climate change GWP100"},
        headers=token,
    )
    assert r.status_code == 404, r.text
    error = r.json()["error"]
    assert error["code"] == "method_ambiguous"
    hint = error["hint"]
    # Never picked for the user — but the recommended one leads, and the fossil variant is there to choose.
    assert hint.startswith("Recommended: IPCC 2021 · climate change · global warming potential (GWP100)")
    assert "Also matching:" in hint and "climate change: fossil" in hint


def _backgrounds(bd) -> None:
    """Two read-only backgrounds sharing one code, each with one of its own, and a model."""
    bd.Database("bg").write({
        ("bg", "pet-granulate"): {"name": "widget granulate", "unit": "kg"},
        ("bg", "shared"): {"name": "widget sheet", "unit": "kg"},
    })
    bd.Database("bg2").write({
        ("bg2", "shared"): {"name": "widget sheet, other source", "unit": "kg"},
    })
    bd.Database("pet").write({("pet", "bottle"): {"name": "bottle", "unit": "unit"}})
    set_read_only("bg", True)
    set_read_only("bg2", True)
    set_read_only("pet", False)


def test_a_read_is_answered_from_the_one_background_that_has_the_code(client, token, project):
    """A model whose `database` key arrived mangled read its model by default, was told the code lives in
    the background — and gave up without opening it (V470). The read now answers from there, and says so."""
    _backgrounds(get_bd())
    r = client.get("/api/v1/model/activities/pet/pet-granulate", params={"background_fallback": "true"},
                   headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["found_in"] == "bg" and body["activity"]["database"] == "bg"
    assert "'pet'" in body["found_in_note"] and "'bg'" in body["found_in_note"]
    # Without the switch — every other caller of the lookup — it stays a refusal: an edit must never land
    # on a dataset other than the one it named.
    r = client.get("/api/v1/model/activities/pet/pet-granulate", headers=token)
    assert r.status_code == 404 and "found_in" not in r.text


def test_a_code_in_two_backgrounds_is_not_guessed_and_the_hint_names_both(client, token, project):
    _backgrounds(get_bd())
    r = client.get("/api/v1/model/activities/pet/shared", params={"background_fallback": "true"},
                   headers=token)
    assert r.status_code == 404
    hint = r.json()["error"]["hint"]
    assert "'bg' and 'bg2'" in hint and "Give the database you mean" in hint


def test_the_fallback_reads_only_backgrounds_and_only_after_a_miss(client, token, project):
    _backgrounds(get_bd())
    get_bd().Database("glass").write({("glass", "transport-1"): {"name": "transport", "unit": "tkm"}})
    set_read_only("glass", False)
    # Another model's process is named, never read in its place.
    r = client.get("/api/v1/model/activities/pet/transport-1", params={"background_fallback": "true"},
                   headers=token)
    assert r.status_code == 404 and "'glass'" in r.json()["error"]["hint"]
    # A code the named database has is read from there, untouched by the switch.
    r = client.get("/api/v1/model/activities/pet/bottle", params={"background_fallback": "true"},
                   headers=token)
    assert r.status_code == 200 and "found_in" not in r.json()
    # A database that does not exist stays that refusal.
    r = client.get("/api/v1/model/activities/nope/pet-granulate", params={"background_fallback": "true"},
                   headers=token)
    assert r.status_code == 404 and r.json()["error"]["code"] == "database_not_found"
