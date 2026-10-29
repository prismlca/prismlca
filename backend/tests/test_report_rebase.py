"""A chapter restated in today's positions: what an update's writer is handed.

The pins say which member each index meant when the sentence was written; the rebased text says the
same thing in the order the facts list today, so it prints exactly what the stored chapter prints.
"""
from __future__ import annotations

from prism_lca.engine import report_bindings
from prism_lca.engine.report_rebase import rebase, today

BOX = {"name": "box", "database": "pr", "code": "box", "share_text": "40 %"}
LORRY = {"name": "lorry", "database": "pr", "code": "lorry", "share_text": "20 %"}
BAG = {"name": "bag", "database": "pr", "code": "bag", "share_text": "10 %"}

THEN = {
    "hotspots": [BOX, LORRY, BAG],
    "contributions": [
        {"method_label": "gwp", "groups": [{"key": "Production", "share_text": "70 %"},
                                           {"key": "Transport", "share_text": "30 %"}]},
        {"method_label": "acid", "groups": [{"key": "Production", "share_text": "55 %"},
                                            {"key": "Transport", "share_text": "45 %"}]},
    ],
}


def _pins(text: str) -> dict:
    return report_bindings.bindings_for(text, THEN)


def _printed(text: str, data: dict, pins: dict | None) -> str:
    return report_bindings.resolve(text, data, "en", pins, plain=True)[0]


def test_two_members_that_swapped_places_swap_their_indices_and_print_the_same():
    text = "{{hotspots.0.name}} leads with {{hotspots.0.share_text}}; {{hotspots.1.name}} follows."
    now = {**THEN, "hotspots": [LORRY, BOX, BAG]}
    rebased = rebase(text, now, _pins(text))
    assert rebased == "{{hotspots.1.name}} leads with {{hotspots.1.share_text}}; {{hotspots.0.name}} follows."
    assert _printed(rebased, now, None) == _printed(text, now, _pins(text))


def test_every_level_of_a_nested_path_moves_with_its_own_pin():
    text = "Transport carries {{contributions.1.groups.1.share_text}} of acidification."
    pins = _pins(text)
    # The indicators re-ordered and, inside acidification, the phases too.
    acid = {"method_label": "acid", "groups": [THEN["contributions"][1]["groups"][1],
                                              THEN["contributions"][1]["groups"][0]]}
    now = {**THEN, "contributions": [acid, THEN["contributions"][0]]}
    assert today("contributions.1.groups.1.share_text", now, pins) == "contributions.0.groups.0.share_text"
    assert rebase(text, now, pins) == "Transport carries {{contributions.0.groups.0.share_text}} of acidification."


def test_declarations_and_derivations_carry_their_paths_along():
    text = "{{rank:hotspots.0}} is {{change(hotspots.0.share_text, hotspots.2.share_text)}} ahead."
    now = {**THEN, "hotspots": [BAG, LORRY, BOX]}
    assert rebase(text, now, _pins(text)) == (
        "{{rank:hotspots.2}} is {{change(hotspots.2.share_text, hotspots.0.share_text)}} ahead."
    )


def test_a_member_that_left_the_results_is_marked_gone():
    text = "{{hotspots.1.name}} adds {{hotspots.1.share_text}}. {{hotspots.0.name}} leads."
    now = {**THEN, "hotspots": [BOX, BAG]}
    assert rebase(text, now, _pins(text)) == (
        "{{gone:hotspots.1.name}} adds {{gone:hotspots.1.share_text}}. {{hotspots.0.name}} leads."
    )


def test_nothing_moves_without_pins_or_without_a_change():
    text = "{{hotspots.0.name}} leads with {{results.0.score}} and {{ref:t-sensitivity}}."
    assert rebase(text, THEN, None) == text
    assert rebase(text, THEN, _pins(text)) == text
