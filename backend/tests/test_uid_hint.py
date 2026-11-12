"""A uid one character off is named, never used (V487).

A model sent a 33-character uid for a formula and was told only "not found … the exchange may have been
removed"; the formula never arrived. The refusal now says when a uid is malformed and names the uid it
probably meant — with what it is — without ever editing that one instead.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import model, tag_scope
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import set_read_only
from prism_lca.engine.uid_hint import is_near
from prism_lca.errors import PrismError

GRANULATE_UID = "378d2ed8cdfc4d60abeaea33550cba9a"
SHEET_UID = "9f0c1b2a3d4e5f60718293a4b5c6d7e8"


def _model(bd):
    bd.Database("bg").write({("bg", "granulate"): {"name": "widget granulate", "unit": "kg"},
                             ("bg", "sheet"): {"name": "widget sheet", "unit": "kg"}})
    bd.Database("m").write({("m", "bottle"): {"name": "bottle", "unit": "unit", "exchanges": [
        {"input": ("m", "bottle"), "amount": 1, "type": "production", "prism_uid": "0" * 32},
        {"input": ("bg", "granulate"), "amount": 1, "type": "technosphere", "prism_uid": GRANULATE_UID},
        {"input": ("bg", "sheet"), "amount": 2, "type": "technosphere", "prism_uid": SHEET_UID}]}})
    set_read_only("bg", True)
    set_read_only("m", False)
    return model.get_activity("m", "bottle")


def _refusal(act, uid: str) -> PrismError:
    with pytest.raises(PrismError) as caught:
        model.find_exchange(act, uid)
    assert caught.value.code == "exchange_not_found"
    return caught.value


def test_one_character_appended_is_called_malformed_and_the_meant_uid_is_named(project):
    act = _model(get_bd())
    err = _refusal(act, GRANULATE_UID + "9")
    assert "Malformed uid (33 characters)" in err.message
    assert f"Did you mean {GRANULATE_UID} (input: widget granulate)?" in err.hint
    assert "not used in its place" in err.hint
    # Only named: the exchange itself is untouched and the near one is not returned.
    assert model.find_exchange(act, GRANULATE_UID)["amount"] == 1


def test_a_well_formed_uid_one_digit_off_is_named_without_the_malformed_note(project):
    act = _model(get_bd())
    err = _refusal(act, GRANULATE_UID[:-1] + "b")
    assert "Malformed" not in err.message
    assert GRANULATE_UID in err.hint and SHEET_UID not in err.hint
    # The same first eight characters with a garbled tail count as near too.
    assert GRANULATE_UID in _refusal(act, GRANULATE_UID[:8] + "f" * 24).hint


def test_a_uid_near_nothing_keeps_the_plain_answer_and_a_short_one_is_still_called_malformed(project):
    act = _model(get_bd())
    assert _refusal(act, "f" * 32).hint == "The exchange may have been removed; reload the activity."
    short = _refusal(act, "abc")
    assert "Malformed uid (3 characters)" in short.message and "get_process_details" in short.hint


def test_an_odd_uid_that_exists_is_still_found(project):
    """Older and hand-made uids of another shape stay addressable: the shape is judged only after a miss."""
    bd = get_bd()
    bd.Database("m").write({("m", "a"): {"name": "a", "unit": "kg", "exchanges": [
        {"input": ("m", "a"), "amount": 1, "type": "production", "prism_uid": "e1"}]}})
    assert model.find_exchange(model.get_activity("m", "a"), "e1")["amount"] == 1


def test_the_model_wide_input_lookup_names_the_near_uid_too(project):
    _model(get_bd())
    with pytest.raises(PrismError) as caught:
        tag_scope.find_input(GRANULATE_UID + "9", "m")
    assert "Malformed uid (33 characters)" in caught.value.message
    assert GRANULATE_UID in caught.value.hint


def test_nearness():
    assert is_near(GRANULATE_UID, GRANULATE_UID + "9")  # one appended
    assert is_near(GRANULATE_UID, GRANULATE_UID[1:])  # one dropped
    assert is_near(GRANULATE_UID, "x" + GRANULATE_UID[1:])  # one replaced
    assert is_near(GRANULATE_UID[:8], GRANULATE_UID)  # a truncated copy
    assert not is_near(GRANULATE_UID, GRANULATE_UID)  # the same is a hit, not a near miss
    assert not is_near(GRANULATE_UID, SHEET_UID)
    assert not is_near(GRANULATE_UID, None)


def test_a_fenced_chat_is_never_shown_another_models_near_uid(client, token, project):
    """Input tags look a uid up across every model when no database is named. The near miss names a uid
    with its input, so behind the chat's model fence it is looked for in the chat's own model only."""
    bd = get_bd()
    _model(bd)  # model "m" holds GRANULATE_UID
    bd.Database("own").write({("own", "jar"): {"name": "jar", "unit": "unit", "exchanges": [
        {"input": ("own", "jar"), "amount": 1, "type": "production", "prism_uid": "1" * 32}]}})
    set_read_only("own", False)
    body = {"keys": [{"uid": GRANULATE_UID[:8] + "f" * 24}], "group": "Phase", "value": "Use"}
    fenced = client.post("/api/v1/model/tags/set", json=body, headers={**token, "X-Prism-Model": "own"})
    assert fenced.status_code == 404
    assert GRANULATE_UID not in fenced.text and "widget granulate" not in fenced.text
    # Unfenced (the app, an MCP session) the whole workspace is searched, and the near uid is named.
    open_ = client.post("/api/v1/model/tags/set", json=body, headers=token)
    assert open_.status_code == 404 and GRANULATE_UID in open_.text
