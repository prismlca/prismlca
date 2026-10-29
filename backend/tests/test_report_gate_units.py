"""The unit beside a placeholder, and the two shapes of answer the gate must never accept.

A correct placeholder prints a correct figure; the sentence then writes a unit after it, and until
recently nothing compared the two — "{{results.0.score}} tonnes CO2-Eq" over a kg value was green.
The literal-number rule guards figures typed out; this guards the unit beside a figure the data
supplied.
"""
from __future__ import annotations

from prism_lca.engine import report_prompts as rp

DATA = {
    "study": {"goal": "Compare two bottles", "functional_unit": "1 bottle"},
    "activity": {"name": "PET bottle", "database": "m", "code": "c"},
    "amount": 1.0,
    "results": [
        {"method": ["IPCC 2021", "GWP100"], "method_label": "IPCC 2021 / GWP100", "unit": "kg CO2-eq", "score": 5.0},
        {"method": ["USEtox", "HTc"], "method_label": "USEtox / HTc", "unit": "CTUh", "score": 2.0},
    ],
    "contribution": {
        "dimension": "Phase",
        "unit": "kg CO2-eq",
        "groups": [{"key": "Production", "impact": 3.0, "share": 0.6, "share_percent": 60.0}],
        "top": {"key": "Production", "impact": 3.0, "share": 0.6, "share_percent": 60.0},
    },
    "subjects": [],
    "parameters": [],
    "scenarios": [],
    "provenance": {},
}


def kinds(text: str) -> list[str]:
    return [f["kind"] for f in rp.check_proposal(text, {"kind": "prose"}, DATA)["findings"]]


def test_the_unit_written_after_a_placeholder_has_to_be_the_one_it_prints_in():
    assert kinds("The climate impact is {{results.0.score}} kg CO2-eq.") == []
    assert kinds("The climate impact is {{results.0.score}} tonnes CO2-eq.") == ["unit_mismatch"]
    assert kinds("The toxicity is {{results.1.score}} kg CO2-eq.") == ["unit_mismatch"]
    assert kinds("The toxicity is {{results.1.score}} CTUh.") == []


def test_a_share_takes_a_percent_sign_and_nothing_else():
    assert kinds("Production carries {{contribution.groups.0.share_percent}} % of the total.") == []
    assert kinds("Production carries {{contribution.groups.0.share_percent}} percent of the total.") == []
    assert kinds("Production carries {{contribution.groups.0.share_percent}} kg of the total.") == ["unit_mismatch"]


def test_a_converted_figure_has_to_write_the_converted_unit():
    """factor(x, 0.001) of a kg figure is in grams; written as kg it is a thousand times too large."""
    assert kinds("That is {{factor(results.0.score, 0.001)}} g CO2-eq.") == []
    assert kinds("That is {{factor(results.0.score, 0.001)}} kg CO2-eq.") == ["unit_mismatch"]
    assert kinds("That is {{factor(results.0.score, 1000)}} t CO2-eq.") == []


def test_no_unit_or_a_second_placeholder_after_the_figure_is_not_a_mismatch():
    assert kinds("The result of {{results.0.score}} dominates the picture.") == []
    assert kinds("The result is {{results.0.score}} {{results.0.unit}}.") == []
    assert kinds("The result is {{results.0.score}} ({{contribution.groups.0.share_percent}} %).") == []


def test_an_empty_proposal_is_refused_not_stored():
    """`check_proposal("", …)` said ok, and with store=True an empty answer replaced a chapter."""
    verdict = rp.check_proposal("", {"kind": "prose"}, DATA)
    assert not verdict["ok"] and [f["kind"] for f in verdict["findings"]] == ["empty_chapter"]
    assert not rp.check_proposal("   \n ", {"kind": "prose"}, DATA)["ok"]


def test_a_very_long_chapter_is_remarked_on_but_not_refused():
    text = ("This sentence says nothing about any figure and goes on. " * 250).strip()
    assert len(text) > rp.CHAPTER_LONG_CHARS
    verdict = rp.check_proposal(text, {"kind": "prose"}, DATA)
    assert verdict["ok"] and "chapter_long" in [f["kind"] for f in verdict["findings"]]


def test_a_quoted_figure_vouches_only_for_its_own_unit():
    """A scope's "1500 km" used to vouch for "1500 kg CO2-eq" — the figure matched, the unit never
    did. The alias table keeps "kilometres" and "km" one unit."""
    data = {**DATA, "study": {**DATA["study"], "goal": "Transport over 1500 kilometres to the customer."}}

    def k(text: str) -> list[str]:
        return [f["kind"] for f in rp.check_proposal(text, {"kind": "prose"}, data)["findings"]]

    assert k("The goods travel 1500 km to the customer.") == []
    assert k("The goods travel 1500 kilometres to the customer.") == []
    assert k("The goods travel 1500 to the customer.") == []  # bare figure, quoted
    assert k("The climate impact is 1500 kg CO2-eq.") == ["literal_number"]


def test_the_resolved_text_is_the_whole_chapter_even_beside_a_study_paragraph():
    """A `study.*` placeholder resolving to a long paragraph used to overwrite the chapter's resolved
    text in the answer — the API returned the paragraph alone."""
    data = {**DATA, "study": {**DATA["study"], "goal": "The goal of this study is " + "to compare two bottles " * 8}}
    verdict = rp.check_proposal("The result is {{results.0.score}} kg CO2-eq. Goal: {{study.goal}}", {"kind": "prose"}, data)
    assert "5" in verdict["resolved"] and "The goal of this study" in verdict["resolved"]
    assert verdict["resolved"].startswith("The result is")
