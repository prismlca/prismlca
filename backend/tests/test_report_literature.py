"""The literature in a report: which chapters may search it, and what they may quote from it.

Two chapters discuss the world outside the model — the introduction's background and the
interpretation's comparison with published studies. Their writers may search the web unless the
chapter's own switch is off, and a figure from a sourced research finding may stand in their text as a quotation: it is
somebody else's published number, and no recalculation of this model moves it.
"""
from __future__ import annotations

import json

import pytest

from prism_lca.engine import report_kinds, report_prompts, report_sources
from prism_lca.engine.report_store import check_options
from prism_lca.errors import PrismError

FINDING = "Published LCAs report 33 g CO2-eq per HDPE carrier bag (cradle to grave, EU average)."
DATA = {
    "study": {"functional_unit": "one carrier bag", "goal": "Screen the bag."},
    "results": [{"method_label": "t / gwp", "score": 0.05, "unit": "kg CO2-Eq"}],
    "web_research": [{"question": "LCAs of carrier bags", "findings": [{"text": FINDING, "sources": ["https://ex.org/2021/7"]}]}],
}
SENTENCE = "Published studies report 33 g CO2-eq per HDPE carrier bag."


def _literals(kind: str, data: dict = DATA, text: str = SENTENCE) -> list[dict]:
    verdict = report_prompts.check_proposal(text, {"kind": kind, "id": "s"}, data, "en")
    return [f for f in verdict["findings"] if f["kind"] == "literal_number"]


def test_the_two_literature_chapters_are_the_introduction_and_the_interpretation():
    assert set(report_kinds.LITERATURE_KINDS) == {"introduction", "prose"}


@pytest.mark.parametrize("kind", ["introduction", "prose"])
def test_a_literature_chapter_may_quote_a_researched_figure(kind):
    assert _literals(kind) == []


def test_a_results_chapter_may_not():
    # Not shown the research findings, and its figures have placeholders.
    assert [f["names"] for f in _literals("lcia")] == [["33"]]


def test_a_figure_no_finding_states_is_still_refused():
    assert [f["names"] for f in _literals("introduction", text="Published studies report 41 g CO2-eq per bag.")] == [["41"]]


def test_the_writers_own_research_counts_even_before_the_log_has_it():
    lookup = {"name": "research_web", "args": "{}", "result": json.dumps({"findings": [{"text": FINDING, "sources": ["x"]}]})}
    data = {**DATA, "web_research": [], "looked_up": [lookup]}
    assert _literals("introduction", data) == []


def test_a_source_address_lends_no_figure():
    # The URL carries 2021 and 7, and neither is a figure anybody stated.
    assert "2021" not in report_sources.research_text(DATA)


def test_the_brief_says_whether_the_writer_may_search():
    # On until the chapter's own box is unticked; a results chapter never searches.
    report = {"lang": "en", "sections": []}
    for kind, expected in (("introduction", True), ("prose", True), ("lcia", False)):
        brief = report_prompts.build_brief({"id": "s", "kind": kind}, report, DATA)
        assert brief["literature"] is expected, kind
    off = report_prompts.build_brief({"id": "s", "kind": "introduction", "literature_search": False}, report, DATA)
    assert off["literature"] is False


def test_both_chapters_start_in_a_new_report_and_each_carries_its_own_switch(client, token, project):
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "en", "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()
    kinds = [s["kind"] for s in rep["sections"]]
    # The background before the goal and scope; the interpretation after its checks, before the conclusions.
    assert kinds.index("abbreviations") < kinds.index("introduction") < kinds.index("goal_scope")
    assert kinds.index("interpretation_checks") < kinds.index("prose") < kinds.index("conclusions")
    intro = next(s for s in rep["sections"] if s["kind"] == "introduction")
    url = f"/api/v1/report/one/pr/{rep['id']}"
    r = client.post(f"{url}/sections/{intro['id']}", json={"kind": "introduction", "literature_search": False},
                    headers=token)
    assert r.status_code == 200, r.text
    stored = client.get(url, headers=token).json()["sections"]
    assert next(s for s in stored if s["id"] == intro["id"])["literature_search"] is False
    assert "literature_search" not in next(s for s in stored if s["kind"] == "prose")
    # No longer a report-wide option: the switch moved to the two chapters.
    with pytest.raises(PrismError):
        check_options({"literature_search": True})


def test_an_unsourced_finding_lends_no_figure():
    data = {**DATA, "web_research": [{"question": "q", "findings": [{"text": FINDING, "sources": []}]}]}
    assert [f["names"] for f in _literals("introduction", data)] == [["33"]]


def test_a_researched_figure_that_equals_a_parameter_is_never_repaired_into_it():
    # The model's own bag mass happens to be the figure a source reports: a placeholder in its place
    # would print the model's next value under the source's name.
    data = {**DATA, "parameters": [{"name": "bag_mass", "amount": 33, "unit": "g"}]}
    finding = {**DATA["web_research"][0], "findings": [{"text": "Smith reports 33 g per bag.", "sources": ["s"]}]}
    data["web_research"] = [finding]
    found = _literals("introduction", data, "Smith reports 33 g per bag.")
    assert len(found) == 1 and "repair" not in found[0]
    assert "reports what a source found" in found[0]["detail"]
    # Without the finding it is the ordinary parameter refusal, with its repair.
    plain = _literals("introduction", {**data, "web_research": []}, "The bag weighs 33 g.")
    assert "repair" in plain[0]
