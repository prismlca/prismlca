"""The reasons recorded on a model's exchanges, handed to the chapters that discuss data choices.

Why one dataset and not its equivalent, why a proxy geography, what a producer's dataset said, why a
waste flow has its sign: the model-building skill writes these on the exchange, and the report writers
saw them only if they looked each process up. They now come with the brief — to the inventory, the
interpretation checks and the interpretation, and to no other chapter, where they would only lengthen it.
"""
from __future__ import annotations

import uuid

from prism_lca.engine import model as model_engine
from prism_lca.engine import report_prompts, report_staleness, report_translations
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import set_read_only

PROXY = "German market as a proxy for Austria: no AT dataset; the grid mixes differ by under 10 %."
SIGN = "Negative on purpose: the treatment receives the waste."


def _data(notes: list[dict]) -> dict:
    return {
        "study": {"functional_unit": "one bottle"},
        "foreground": [{"name": "Bottle production", "product": "bottle", "description": "", "exchange_notes": notes}],
    }


def _model(client, token) -> str:
    bd = get_bd()
    bg = "bg-" + uuid.uuid4().hex[:6]
    dbobj = bd.Database(bg)
    dbobj.register()
    set_read_only(bg, True)
    for code, name in (("el", "market for electricity, low voltage"), ("waste", "treatment of waste plastic")):
        act = dbobj.new_activity(code=code, name=name, unit="kWh", location="DE")
        act["type"] = "process"
        act.save()
        act.new_edge(input=act, amount=1.0, type="production").save()
    fg = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": fg}, headers=token).status_code == 200
    code = client.post("/api/v1/model/activities", json={"database": fg, "name": "Bottle production"},
                       headers=token).json()["activity"]["code"]
    for input_code, amount, comment in (("el", 2.0, PROXY), ("waste", -0.1, SIGN), ("el", 1.0, "")):
        r = client.post(
            "/api/v1/model/exchanges",
            json={"activity_database": fg, "activity_code": code, "input_database": bg,
                  "input_code": input_code, "amount": amount, "comment": comment},
            headers=token,
        )
        assert r.status_code == 200, r.text
    return fg


def test_the_model_context_carries_every_non_empty_exchange_note(client, token, project):
    (process,) = model_engine.report_context(_model(client, token))["foreground"]
    notes = process["exchange_notes"]
    assert [n["note"] for n in notes] == [PROXY, SIGN]
    assert notes[0]["input"] == "market for electricity, low voltage" and notes[0]["location"] == "DE"
    # A background input is ecoinvent's name and is not marked as the model's own.
    assert "own" not in notes[0]


def test_only_the_chapters_about_data_choices_are_shown_them():
    data = _data([{"input": "market for electricity", "location": "DE", "note": PROXY}])
    for kind in ("inventory", "interpretation_checks", "prose"):
        (note,) = report_prompts.brief_facts(data, kind)["exchange_notes"]
        assert note == {"process": "Bottle production", "input": "market for electricity", "location": "DE",
                        "note": PROXY}
    for kind in ("summary", "introduction", "goal_scope", "methods", "lcia", "conclusions"):
        assert "exchange_notes" not in report_prompts.brief_facts(data, kind), kind


def test_they_are_capped_per_note_and_in_number():
    data = _data([{"input": f"input {i}", "note": "x" * 1000} for i in range(60)])
    notes = report_prompts.exchange_notes(data)
    assert len(notes) == 40
    # Room for a proxy's substitute, original, reason and likely bias — measured at 355 characters.
    assert len(notes[0]["note"]) == 400 and notes[0]["note"].endswith("…")


def test_a_figure_from_a_note_is_a_quotation_where_the_note_was_shown():
    data = {**_data([{"input": "market for electricity", "note": PROXY}]),
            "results": [{"method_label": "t / gwp", "score": 0.05, "unit": "kg CO2-Eq"}]}
    text = "The grid mixes of the two countries differ by under 10 %."

    def literals(kind: str) -> list:
        verdict = report_prompts.check_proposal(text, {"kind": kind, "id": "s"}, data, "en")
        return [f for f in verdict["findings"] if f["kind"] == "literal_number"]

    assert literals("inventory") == []
    assert [f["names"] for f in literals("lcia")] == [["10"]]


def test_a_note_never_vouches_for_a_figure_in_an_indicator_unit():
    # A producer's own footprint in the note, the same figure typed as this model's result: it would stay
    # 0.42 after a recalculation moved the result, so it is refused even in the inventory chapter.
    data = {**_data([{"input": "PET granulate", "note": "Producer EPD reports 0.42 kg CO2-Eq per bottle."}]),
            "results": [{"method_label": "t / gwp", "score": 0.42, "unit": "kg CO2-Eq"}]}
    verdict = report_prompts.check_proposal("The calculated result is 0.42 kg CO2-Eq per bottle.",
                                            {"kind": "inventory", "id": "s"}, data, "en")
    assert [f["names"] for f in verdict["findings"] if f["kind"] == "literal_number"] == [["0.42"]]


def test_the_guard_reads_the_unit_however_the_note_spells_it():
    # "megajoules" in the note is the "MJ" of an energy indicator: no quotation for a result in MJ.
    data = {**_data([{"input": "heat", "note": "Supplier states 250 megajoules per bottle."}]),
            "results": [{"method_label": "t / energy", "score": 250, "unit": "MJ"}]}
    verdict = report_prompts.check_proposal("The calculated result is 250 MJ per bottle.",
                                            {"kind": "inventory", "id": "s"}, data, "en")
    assert [f["names"] for f in verdict["findings"] if f["kind"] == "literal_number"] == [["250"]]


def test_a_changed_note_makes_the_chapters_that_read_it_stale_and_no_other():
    before = _data([{"input": "market for electricity", "note": PROXY}])
    after = _data([{"input": "market for electricity", "note": "German market used; Austria now has its own."}])
    report = {"lang": "en", "sections": []}
    for kind, watched in (("inventory", True), ("summary", False)):
        section = {"id": "s", "kind": kind}
        old = report_staleness.sources_of(section, report, before)
        new = report_staleness.sources_of(section, report, after)
        assert ("exchange_notes" in old["study"]) is watched, kind
        assert (old != new) is watched, kind
    stored = {"sources": report_staleness.sources_of({"id": "s", "kind": "inventory"}, report, before)}
    verdicts = report_staleness._source_verdicts({"id": "s", "kind": "inventory"}, stored, report, after)
    assert [v["path"] for v in verdicts] == ["study.exchange_notes"]
    # Written while the model had no notes at all: the first one added is a change too.
    empty = {"sources": report_staleness.sources_of({"id": "s", "kind": "inventory"}, report, _data([]))}
    verdicts = report_staleness._source_verdicts({"id": "s", "kind": "inventory"}, empty, report, before)
    assert [v["path"] for v in verdicts] == ["study.exchange_notes"]


def test_the_note_is_translated_with_the_study_and_an_own_input_with_it():
    data = _data([
        {"input": "market for electricity", "note": PROXY},
        {"input": "Granulat-Herstellung", "note": SIGN, "own": True},
    ])
    texts = {c["text"] for c in report_translations.candidates(data)}
    assert {PROXY, SIGN, "Granulat-Herstellung"} <= texts
    # An ecoinvent input keeps its name, as everywhere else in the report.
    assert "market for electricity" not in texts
