"""The report module writes its own lines in the audit log.

Measured before this existed, in the development project: **1268 audit entries, 1128 of them the
assistant's model edits — and not one from the report module.** Writing a chapter, correcting it,
deleting it, translating the study texts, typesetting the PDF: the actions that cost money, and the
ones a reviewer asks about first, left no trace at all. The same project's report store holds 34
reports with 252 written chapters, so the missing half of the trail was not a corner case.

What these tests hold the new lines to:

* **the model, as a field.** Every entry carries `database`, so it appears in that model's own history
  instead of being fished out of the prose later;
* **one line per change to the deliverable.** The writer asks the gate with `store=false` up to four
  times per chapter while it revises; none of that is logged. A refused *storing* call is, because a
  paid call that produced nothing is the outcome that would otherwise be invisible;
* **no text.** No chapter prose, no prompt, no model answer — a finding's `detail` quotes the
  sentence it condemns, so only its `kind` is recorded;
* **never fatal.** A log write that fails must not fail the chapter it describes, and the loss must be
  visible rather than swallowed;
* **the list is closed.** A new `report_audit.note()` call with an action nobody decided on turns the
  suite red (`test_every_logged_action_is_on_the_list`) — the same tripwire idea as
  `test_command_attribution`, applied to hand-written notes, which no Command scan can see.

The numbers are faked at the snapshot boundary, as in `test_report_accept` and
`test_report_correction_tried`: what is under test is which lines the log gets, not bw2calc.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from prism_lca.api.v1 import report_ai
from prism_lca.engine import audit_store, report_audit, report_gate, report_pipeline, typst_render
from prism_lca.engine.report_store import ReportStore

DB = "pr"

#: A chapter that passes the gate: no figure typed out, no superlative, no placeholder to resolve.
CLEAN = (
    "This chapter describes how the assessment was carried out and which data sources it draws on. "
    "The parameters and the datasets behind each step are listed in the annex."
)

#: A chapter the gate refuses (`literal_number` — a result figure typed into the prose) which also
#: carries an advisory finding (`value_judgement`). The refusal line must name the first and not the
#: second: an advisory finding does not stop a chapter, so quoting it would send a reader after the
#: wrong sentence.
REFUSED = "Packaging accounts for 60.2 % of the total. The product is sustainable."


def _hotspot(name: str, code: str, share: float) -> dict:
    return {"name": name, "database": DB, "code": code, "share_percent": share,
            "share_text": f"{share} %"}


def _data(above: int = 0) -> dict:
    """The snapshot. `above` pushes extra processes in front of the pinned one, which moves its rank
    without touching the share the sentence prints — the drift the `review` verdict reacts to."""
    return {
        "study": {"functional_unit": "1 kg"},
        "results": [{"method_label": "t / gwp", "score": 1.0, "unit": "kg CO2-Eq"}],
        "hotspots": [
            *[_hotspot(f"big process {i}", f"big{i}", 20.0) for i in range(above)],
            _hotspot("cardboard box production", "box", 12.0),
            _hotspot("electricity, medium voltage", "elec", 9.9),
            _hotspot("treatment of waste PET, municipal incineration", "pet", 8.4),
            _hotspot("tap water production", "water", 4.0),
        ],
        "translations": {
            "candidates": [
                {"key": "goal", "text": "Ziel der Studie"},
                {"key": "scope", "text": "Systemgrenze"},
                {"key": "unit", "text": "1 kg"},
            ]
        },
    }


@pytest.fixture
def snapshot(monkeypatch):
    state = {"data": _data()}

    def fake(database, report_id, body):  # noqa: ARG001
        return ReportStore().get(database, report_id), state["data"]

    # One seam: every judging endpoint reaches the snapshot through
    # `report_pipeline.analysis_snapshot`, so one patch covers them all.
    monkeypatch.setattr(report_pipeline, "analysis_snapshot", fake)
    return state


@pytest.fixture(autouse=True)
def _no_pending_losses():
    """Module state, so it is cleared on both sides of every test: a loss left over from the failure
    test would inject a `report_audit_lost` line into an unrelated test's log."""
    report_audit.reset_for_tests()
    yield
    report_audit.reset_for_tests()


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _entries(client, token, **query) -> list[dict]:
    q = "&".join(f"{k}={v}" for k, v in query.items())
    r = client.get(f"/api/v1/model/audit{'?' + q if q else ''}", headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def _report_lines(client, token, **query) -> list[dict]:
    """Only the lines this phase adds. Every action it writes carries the word `report`, which is
    also what the tripwire below pins."""
    return [e for e in _entries(client, token, **query) if "report" in e["action"]]


def _one(entries: list[dict], action: str) -> dict:
    hits = [e for e in entries if e["action"] == action]
    assert len(hits) == 1, f"expected exactly one {action!r} among {[e['action'] for e in entries]}"
    return hits[0]


def _new_report(client, token, **body) -> dict:
    r = client.post(
        "/api/v1/report/create",
        json={"database": DB, "lang": "en", "subjects": [{"database": DB, "code": "a"}], **body},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _section(client, token, rep, kind: str = "prose") -> dict:
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": kind}, headers=token
    )
    assert r.status_code == 200, r.text
    return r.json()


def _propose(client, token, rep, sec, text: str, *, store: bool = True, model: str | None = "openrouter/x") -> dict:
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": text, "store": store, "model": model},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _patch_section(client, token, rep, sec, body: dict) -> dict:
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}", json=body, headers=token
    )
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# a chapter written — the line Phase 3 exists for
# --------------------------------------------------------------------------- #
def test_a_written_chapter_is_recorded_under_its_model_with_the_model_that_wrote_it(
    client, token, project, snapshot
):
    del project, snapshot
    rep = _new_report(client, token, name="Apple juice")
    sec = _section(client, token, rep, "methods")
    assert _propose(client, token, rep, sec, CLEAN)["stored"] is True  # the fixture really stored it

    entry = _one(_report_lines(client, token), "write_report_chapter")
    assert entry["database"] == DB  # findable in the model's own history, as a field
    assert entry["source"] == "ai"  # a model wrote it, and the log says so like the chapter does
    assert entry["undoable"] is False  # a paid call is not on the undo stack
    assert "Impact assessment methods" in entry["summary"]  # the chapter, by the name the author sees
    assert "methods" in entry["summary"] and "openrouter/x" in entry["summary"]
    assert f"{len(CLEAN)} characters" in entry["summary"]
    assert "Apple juice" in entry["summary"]  # which of the model's reports it went into


def test_the_chapter_text_itself_never_reaches_the_log(client, token, project, snapshot):
    """The log is a trail, not a transcript. Names, counts, kinds, models — no prose."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _propose(client, token, rep, sec, CLEAN)
    _propose(client, token, rep, sec, REFUSED)
    _patch_section(client, token, rep, sec, {"kind": "prose", "text": CLEAN + " Edited by hand."})
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/delete", json={}, headers=token
    )

    lines = _report_lines(client, token)
    assert len(lines) >= 4, [e["action"] for e in lines]  # all four actions really happened
    # Fragments from the beginning, the middle and the end of each text: a summary that carried a
    # prefix of the chapter would otherwise pass a sweep that only looks for its later words.
    for entry in lines:
        for fragment in ("This chapter describes", "data sources", "listed in the annex",
                         "Packaging accounts", "sustainable", "Edited by hand"):
            assert fragment not in entry["summary"], entry


def test_a_hand_written_chapter_is_not_credited_to_a_model(client, token, project, snapshot):
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _propose(client, token, rep, sec, CLEAN, model=None)
    entry = _one(_report_lines(client, token), "write_report_chapter")
    assert entry["source"] == "user"
    assert "model" not in entry["summary"]


def test_the_revision_loop_writes_nothing(client, token, project, snapshot):
    """The writer asks the same endpoint with `store=false` up to four times per chapter. Logging the
    checks would multiply every chapter by four and record documents that never existed."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    before = len(_report_lines(client, token))
    for _ in range(3):
        assert _propose(client, token, rep, sec, REFUSED, store=False)["stored"] is False
    assert _propose(client, token, rep, sec, CLEAN, store=False)["ok"] is True
    assert len(_report_lines(client, token)) == before


def test_a_refused_chapter_is_not_silently_absent(client, token, project, snapshot):
    """A paid call that produced nothing storable. The writer only asks to store once it has revised
    as far as it will go, so this is money spent and the report unchanged — and without a line the
    only trace of it would be a chapter that is still empty."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    verdict = _propose(client, token, rep, sec, REFUSED)
    assert verdict["stored"] is False and verdict["ok"] is False  # the fixture really refused it
    kinds = {f["kind"] for f in verdict["findings"]}
    assert {"literal_number", "value_judgement"} <= kinds, kinds  # …with one of each severity

    lines = _report_lines(client, token)
    assert not [e for e in lines if e["action"] == "write_report_chapter"]
    entry = _one(lines, "refuse_report_chapter")
    assert entry["database"] == DB and entry["source"] == "ai"
    assert "literal_number" in entry["summary"]
    # The advisory finding stays out: it does not stop a chapter, so it is not the reason this one
    # was refused, and naming it would send the reader after the wrong sentence.
    assert "value_judgement" not in entry["summary"]
    assert "nothing was stored" in entry["summary"]


def test_a_write_all_run_leaves_one_line_per_chapter_and_no_run_summary(
    client, token, project, snapshot
):
    """The volume decision, pinned. Nine prose chapters is what a standard structure holds (measured:
    12 sections, 9 of them written by a model), and each line names its own chapter — so the lines are
    not near-identical and cannot be collapsed into one without losing "who wrote this sentence"."""
    del project, snapshot
    rep = _new_report(client, token)
    kinds = ["goal_scope", "methods", "inventory"]
    sections = [_section(client, token, rep, kind) for kind in kinds]
    for sec in sections:
        assert _propose(client, token, rep, sec, CLEAN)["stored"] is True

    written = [e for e in _report_lines(client, token) if e["action"] == "write_report_chapter"]
    assert len(written) == len(sections)
    # One line per chapter, each about its own chapter — and no extra "the run finished" line, which
    # the backend could only take on trust from the client anyway.
    assert len({e["summary"] for e in written}) == len(sections)
    for kind in kinds:
        assert any(kind in e["summary"] for e in written), kind


# --------------------------------------------------------------------------- #
# corrections
# --------------------------------------------------------------------------- #
def test_a_stored_correction_says_how_many_replacements_landed(client, token, project, snapshot):
    """The panel retries a refused batch one replacement at a time — up to six calls for one chapter.
    Without the count the log would read as six corrections where there was one round."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _propose(client, token, rep, sec, CLEAN)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"old": "the annex", "new": "Annex A", "why": "named"}],
              "store": True, "model": "openrouter/x"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["stored"] is True, r.text  # the fixture really applied it

    entry = _one(_report_lines(client, token), "correct_report_chapter")
    assert entry["database"] == DB and entry["source"] == "ai"
    assert "1 of 1 replacement(s) applied" in entry["summary"]
    assert "openrouter/x" in entry["summary"]


def test_a_correction_that_changed_nothing_still_leaves_a_line(client, token, project, snapshot):
    """The round that produced these replacements was paid for; this refusal is the only server-side
    evidence it happened. Otherwise a chapter that kept its findings looks untouched."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _propose(client, token, rep, sec, CLEAN)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"old": "a sentence that is not in the chapter", "new": "x"}],
              "store": True, "model": "openrouter/x"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["stored"] is False  # the fixture really refused it

    entry = _one(_report_lines(client, token), "refuse_report_correction")
    assert "do not apply" in entry["summary"] and "nothing was stored" in entry["summary"]


def test_a_dry_run_correction_is_not_an_event(client, token, project, snapshot):
    """`store=false` is how the panel shows the author what *would* apply — and it is asked on every
    chapter the correction dialog opens, so neither answer may leave a line."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _propose(client, token, rep, sec, CLEAN)
    before = len(_report_lines(client, token))
    for edit, applies in (({"old": "the annex", "new": "Annex A"}, True),
                          ({"old": "a sentence the chapter does not contain", "new": "x"}, False)):
        r = client.post(
            f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/patch",
            json={"edits": [edit], "store": False}, headers=token,
        )
        assert r.status_code == 200, r.text
        # Both halves really happened: one dry run that would apply, one that was refused.
        assert r.json()["ok"] is applies and r.json()["stored"] is False
        assert len(_report_lines(client, token)) == before


def test_a_round_that_declined_the_chapter_is_recorded(client, token, project, snapshot):
    """A paid round that changed nothing and refused nothing storable — the outcome with no other
    trace. The model's reasons stay on the chapter: they quote its sentences."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _propose(client, token, rep, sec, CLEAN)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/correction-tried",
        json={"spans": 3, "model": "openrouter/x",
              "refused": [{"span": "The parameters and the datasets behind each step are listed in the annex.",
                           "why": "The passage needs author rewriting; no rewording can fix it."}]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["stored"] is True  # the fixture really kept the verdict

    entry = _one(_report_lines(client, token), "decline_report_correction")
    assert "1 of 3 passage(s) the correction round would not touch" in entry["summary"]
    assert "author rewriting" not in entry["summary"]  # the model's words are not in the log


# --------------------------------------------------------------------------- #
# the author's own actions
# --------------------------------------------------------------------------- #
def test_accepting_a_wording_is_recorded_as_the_authors_verdict(client, token, project, snapshot):
    """The only way a chapter's badge goes green without a sentence changing, so it needs a line: a
    reviewer asking "why is this current?" gets the honest answer."""
    del project
    rep = _new_report(client, token)
    sec = _section(client, token, rep, "contribution")
    _patch_section(client, token, rep, sec,
                   {"kind": "contribution",
                    "text": "The PET incineration dataset contributes {{hotspots.2.share_text}}."})
    snapshot["data"] = _data(above=3)  # the pinned process slips down the ranking
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] is True, r.text  # the fixture really produced a `review` verdict

    entry = _one(_report_lines(client, token), "accept_report_chapter")
    assert entry["database"] == DB and entry["source"] == "user"
    assert "as it stands" in entry["summary"]


def test_marking_the_report_read_is_one_line_for_the_click(client, token, project, snapshot):
    """"The author read it through on the 24th" is one event. Nine lines saying it would push the
    model edits around them off the page."""
    del project, snapshot
    rep = _new_report(client, token)
    for kind in ("goal_scope", "methods", "inventory"):
        _propose(client, token, rep, _section(client, token, rep, kind), CLEAN)
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/reviewed", json={}, headers=token)
    assert r.status_code == 200, r.text
    assert len(r.json()["marked"]) == 3  # the fixture really marked three chapters

    entry = _one(_report_lines(client, token), "mark_report_chapters_read")
    assert "3 chapter(s)" in entry["summary"]

    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/reviewed", json={"read": False}, headers=token
    )
    assert r.status_code == 200, r.text
    assert "3 chapter(s)" in _one(_report_lines(client, token), "unmark_report_chapters_read")["summary"]

    # And a call that marked nothing says nothing. `[]` means "mark none" on this endpoint, so this
    # is a real request a client makes — an entry reading "0 chapter(s)" would be noise about a
    # non-event.
    before = len(_report_lines(client, token))
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/reviewed", json={"section_ids": []}, headers=token
    )
    assert r.status_code == 200 and r.json()["marked"] == []
    assert len(_report_lines(client, token)) == before


def test_a_hand_edit_is_recorded_with_what_it_grew_or_lost(client, token, project, snapshot):
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _patch_section(client, token, rep, sec, {"kind": "prose", "text": CLEAN})
    entry = _one(_report_lines(client, token), "edit_report_chapter")
    assert entry["database"] == DB and entry["source"] == "user"
    assert f"0 characters → {len(CLEAN)} characters" in entry["summary"]


def test_clicking_into_the_text_box_and_out_again_is_not_an_edit(client, token, project, snapshot):
    """The editor saves on blur, so the identical text arrives whether or not anything was typed. An
    entry claiming the chapter was edited when it was not is worse than no entry."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _patch_section(client, token, rep, sec, {"kind": "prose", "text": CLEAN})
    before = len(_report_lines(client, token))
    _patch_section(client, token, rep, sec, {"kind": "prose", "text": CLEAN})
    assert len(_report_lines(client, token)) == before


def test_presentation_changes_stay_out_of_the_log(client, token, project, snapshot):
    """Title, layout, figures, order, and the report's own appearance. One line per toggle would bury
    the lines that matter, and options are written through with no Save button."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep, "lcia")
    other = _section(client, token, rep, "methods")
    before = len(_report_lines(client, token))
    _patch_section(client, token, rep, sec, {"kind": "lcia", "title": "Results", "table_layout": "indicators"})
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/reorder",
                    json={"order": [other["id"], sec["id"]]}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}",
                    json={"subtitle": "draft two", "palette": "steel"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["affects_staleness"] is False  # nothing here can move a chapter's verdict
    assert len(_report_lines(client, token)) == before


def test_changing_what_the_report_is_about_is_recorded(client, token, project, snapshot):
    """The mutation that stops paid chapters from being current — and the only report-level one that
    gets a line."""
    del project, snapshot
    rep = _new_report(client, token)
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}", json={"amount": 2.0}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["affects_staleness"] is True
    entry = _one(_report_lines(client, token), "set_report_basis")
    assert "amount" in entry["summary"] and entry["database"] == DB


def test_freezing_and_unfreezing_a_chapter_are_both_recorded_once(client, token, project, snapshot):
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep)
    _patch_section(client, token, rep, sec, {"locked": True})
    _patch_section(client, token, rep, sec, {"locked": True})  # already frozen: nothing happened
    _patch_section(client, token, rep, sec, {"locked": False})
    lines = _report_lines(client, token)
    assert "Lock chapter" in _one(lines, "freeze_report_chapter")["summary"]
    assert "Unlock chapter" in _one(lines, "unfreeze_report_chapter")["summary"]


# --------------------------------------------------------------------------- #
# what a deletion destroyed
# --------------------------------------------------------------------------- #
def test_a_deleted_chapter_says_what_was_destroyed(client, token, project, snapshot):
    """Counted before it is gone: afterwards nothing can say how much text there was."""
    del project, snapshot
    rep = _new_report(client, token)
    sec = _section(client, token, rep, "methods")
    _propose(client, token, rep, sec, CLEAN)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/delete", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    entry = _one(_report_lines(client, token), "delete_report_chapter")
    assert f"{len(CLEAN)} characters" in entry["summary"]
    assert "openrouter/x" in entry["summary"]  # it was paid for, and by which model


def test_a_deleted_report_says_how_much_of_it_was_written(client, token, project, snapshot):
    """The most destructive action in the module — an afternoon of written chapters — and it left no
    trace at all before this."""
    del project, snapshot
    rep = _new_report(client, token, name="Cling film", sections=[])
    _propose(client, token, rep, _section(client, token, rep, "methods"), CLEAN)
    _section(client, token, rep, "lcia")
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/delete", json={}, headers=token)
    assert r.status_code == 200, r.text
    entry = _one(_report_lines(client, token), "delete_report")
    assert "Cling film" in entry["summary"]
    assert "2 chapter(s), 1 of them written" in entry["summary"]


def test_creating_a_report_gives_the_later_chapter_lines_something_to_belong_to(
    client, token, project, snapshot
):
    del project, snapshot
    _new_report(client, token, name="Shampoo 250 ml", sections=[{"kind": "prose"}, {"kind": "lcia"}])
    entry = _one(_report_lines(client, token), "create_report")
    assert "Shampoo 250 ml" in entry["summary"] and "2 chapter(s)" in entry["summary"]
    assert entry["database"] == DB


# --------------------------------------------------------------------------- #
# the study texts, and the document going out
# --------------------------------------------------------------------------- #
def test_translating_the_study_texts_is_recorded_with_its_counts(client, token, project, snapshot):
    del project, snapshot
    rep = _new_report(client, token, lang="de")
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/translations/set",
        json={"resolved": {"goal": "Goal of the study", "scope": "System boundary", "unit": "1 kg",
                           "made-up": "dropped"}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"stored": 3, "translated": 2, "identical": 1, "dropped": ["made-up"], "rejected": []}
    entry = _one(_report_lines(client, token), "translate_report_texts")
    assert entry["source"] == "ai" and entry["database"] == DB
    assert "2 translated, 1 left unchanged, 3 stored in total" in entry["summary"]
    assert "System boundary" not in entry["summary"]  # counts, not the texts


@pytest.fixture
def document(monkeypatch):
    """A rendered document, faked at the render boundary: what is under test is which line the export
    writes, and typesetting it for real would test Typst."""
    sources = {"main.typ": "= Report\n", "template.typ": "", "values.json": "{}",
               "charts/f-1.svg": "<svg/>"}
    state = {"missing": []}

    def fake(database, report_id, body, use_token=False):  # noqa: ARG001
        report = ReportStore().get(database, report_id)
        return report, {}, dict(sources), {"missing_placeholders": list(state["missing"]), "data": {}}

    monkeypatch.setattr(report_pipeline, "document", fake)
    monkeypatch.setattr(typst_render, "compile_pdf", lambda _sources: b"%PDF-1.7" + b"x" * 4096)
    return state


def test_typesetting_the_pdf_is_recorded_with_the_file_that_went_out(
    client, token, project, snapshot, document
):
    del project, snapshot, document
    rep = _new_report(client, token, name="Bio-Apfelmus", sections=[{"kind": "prose"}])
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/pdf", json={}, headers=token)
    assert r.status_code == 200, r.text
    entry = _one(_report_lines(client, token), "typeset_report")
    assert "'Bio-Apfelmus.pdf'" in entry["summary"] and "1 chapter(s)" in entry["summary"]
    assert "gap(s)" not in entry["summary"]


def test_a_pdf_exported_over_the_gap_gate_says_so(client, token, project, snapshot, document):
    """A deliverable that went out with holes in it is the single most important thing the log can
    say about an export — and `allow_gaps` is a deliberate click, so there is somebody to ask."""
    del project, snapshot
    document["missing"] = ["{{hotspots.9.name}}", "f-section-2"]
    rep = _new_report(client, token, name="Bio-Apfelmus", sections=[{"kind": "prose"}])
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/pdf", json={}, headers=token)
    assert r.status_code == 400, r.text  # refused first, as it must be
    assert not [e for e in _report_lines(client, token) if e["action"] == "typeset_report"]

    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/pdf", json={"allow_gaps": True}, headers=token
    )
    assert r.status_code == 200, r.text
    assert "exported with 2 gap(s)" in _one(_report_lines(client, token), "typeset_report")["summary"]


def test_the_hand_off_bundle_and_the_data_hand_out_are_recorded(
    client, token, project, snapshot, document
):
    del project, snapshot, document
    rep = _new_report(client, token, name="Cling film", sections=[{"kind": "prose"}])
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/bundle", json={}, headers=token)
    assert r.status_code == 200, r.text
    bundle = _one(_report_lines(client, token), "export_report_bundle")["summary"]
    assert "Export report 'Cling film' as a Typst project" in bundle
    assert "6 file(s)" in bundle  # the four sources plus data.json and the README
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/data/archive", json={}, headers=token)
    assert r.status_code == 200, r.text
    entry = _one(_report_lines(client, token), "export_report_data")
    assert "3 file(s)" in entry["summary"]  # data.json, values.json and the one chart


def test_a_preview_is_not_an_export(client, token, project, snapshot, document):
    """`/preview` runs on every page turn and every option change, and `/sources` is the first half of
    both the preview and the PDF (the renderer draws the figures from it). Logging either would file
    dozens of exports that never left the machine."""
    del project, snapshot, document
    rep = _new_report(client, token, sections=[{"kind": "prose"}])
    before = len(_report_lines(client, token))
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/sources", json={}, headers=token)
    assert r.status_code == 200, r.text
    assert len(_report_lines(client, token)) == before


# --------------------------------------------------------------------------- #
# the log failing must not fail the report
# --------------------------------------------------------------------------- #
def test_a_chapter_survives_a_log_that_cannot_be_written(client, token, project, snapshot):
    """The chapter is already stored by the time the note is written. A full disk must not turn a
    paid, accepted chapter into a 500 — and the loss must not be silent either."""
    del project, snapshot
    rep = _new_report(client, token, sections=[])
    sec = _section(client, token, rep, "methods")

    def boom(_entry) -> None:
        raise OSError("no space left on device")

    # A context of its own, not the `monkeypatch` fixture: that one is shared with `snapshot`, so
    # undoing it would take the faked numbers away with it and the next write would 400.
    with pytest.MonkeyPatch.context() as broken:
        broken.setattr(audit_store, "append", boom)
        assert _propose(client, token, rep, sec, CLEAN)["stored"] is True  # the action stands
        stored = client.get(f"/api/v1/report/one/{DB}/{rep['id']}", headers=token).json()
        assert stored["sections"][0]["text"] == CLEAN  # …and the chapter really is in the store
        assert report_audit.pending_losses() == {"write_report_chapter": 1}

    other = _section(client, token, rep, "lcia")
    assert _propose(client, token, rep, other, CLEAN)["stored"] is True
    lines = _report_lines(client, token)
    # The log says what it lost. It cannot fill the line in — append-only — but the gap is named,
    # rather than the app reporting success over a trail that quietly stopped recording.
    lost = _one(lines, "report_audit_lost")
    assert "1 report audit entry could not be written" in lost["summary"]
    assert "write_report_chapter ×1" in lost["summary"]
    assert lost["source"] == "system"
    assert report_audit.pending_losses() == {}
    # …and the second chapter's own line is there, once.
    assert len([e for e in lines if e["action"] == "write_report_chapter"]) == 1


def test_the_loss_report_waits_until_the_log_takes_it(client, token, project, snapshot):
    """A broken store cannot record its own breakage either. The count stays pending so the first
    write that succeeds reports the lot, rather than the loss being dropped twice over."""
    del project, snapshot
    rep = _new_report(client, token, sections=[])
    sec = _section(client, token, rep, "methods")
    with pytest.MonkeyPatch.context() as broken:
        broken.setattr(audit_store, "append", lambda _e: (_ for _ in ()).throw(OSError("full")))
        _propose(client, token, rep, sec, CLEAN)
        _propose(client, token, rep, sec, CLEAN)
        assert report_audit.pending_losses() == {"write_report_chapter": 2}
    assert _propose(client, token, rep, sec, CLEAN)["stored"] is True
    lost = _one(_report_lines(client, token), "report_audit_lost")
    assert "2 report audit entries could not be written" in lost["summary"]
    assert "write_report_chapter ×2" in lost["summary"]


# --------------------------------------------------------------------------- #
# the tripwire: the list of logged actions is a decision, not an accident
# --------------------------------------------------------------------------- #
#: Every action the report module writes, and what it stands for. A note whose action is not on this
#: list turns the test below red — the same reason `test_command_attribution` exists, applied to
#: hand-written notes, which no Command scan can see.
EXPECTED_ACTIONS = {
    # the document
    "create_report",
    "delete_report",
    "set_report_basis",
    # the chapters
    "write_report_chapter",
    "refuse_report_chapter",
    "correct_report_chapter",
    "refuse_report_correction",
    "decline_report_correction",
    "rebind_report_chapter",
    "accept_report_chapter",
    "edit_report_chapter",
    "delete_report_chapter",
    "freeze_report_chapter",
    "unfreeze_report_chapter",
    "mark_report_chapters_read",
    "unmark_report_chapters_read",
    # what the author decides about the second reader's questions and points
    "answer_report_question",
    "keep_report_sentence",
    # the study texts and the outputs
    "translate_report_texts",
    "set_report_abbreviations",
    "typeset_report",
    "typeset_short_report",
    "export_report_bundle",
    "export_report_data",
}


def _logged_actions() -> set[str]:
    """The action of every `report_audit.note()` call in the two report modules, read from the source.

    Constants only, and an expression that is not one is a failure rather than a skip: an action
    assembled at runtime cannot be reviewed, and the point of the list is that somebody decided.
    """
    # The transaction moved into the engine, so the scan follows it: the closed list
    # covers every module that writes report audit lines, wherever it lives.
    sources = [
        Path(report_ai.__file__).parent / "report.py",
        Path(report_ai.__file__),
        Path(report_ai.__file__).parent / "report_review.py",
        Path(report_gate.__file__),
    ]
    found: set[str] = set()
    for path in sources:
        name = path.name
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            if node.func.attr != "note" or getattr(node.func.value, "id", "") != "report_audit":
                continue
            assert len(node.args) >= 2, f"{name}: a note without an action at line {node.lineno}"
            actions = [n for n in ast.walk(node.args[1]) if isinstance(n, ast.Constant)]
            assert actions, f"{name}: the action at line {node.lineno} is not a literal"
            found |= {str(a.value) for a in actions}
    return found


def test_every_logged_action_is_on_the_list():
    found = _logged_actions()
    assert found, "the source scan found no notes at all — it has stopped scanning"
    assert found == EXPECTED_ACTIONS, {"only in code": found - EXPECTED_ACTIONS,
                                       "only on the list": EXPECTED_ACTIONS - found}


def test_every_logged_action_names_the_report_module():
    """Every one carries the word `report`, which is what lets a reader — and the tests above — pick
    the report module's lines out of a log that grows for ever."""
    for action in EXPECTED_ACTIONS | {"report_audit_lost"}:
        assert re.search(r"report", action), action


def test_a_release_holds_only_while_wording_and_numbers_stand(client, token, project, snapshot):
    """The gate verifies figures; the author verifies meaning, and the mark is the record of that.
    It lapses when the wording moves, it never applies to a chapter the author wrote, and a
    mark from before the release flag existed records a reading, not a release."""
    del project, snapshot
    from prism_lca.engine.report_store import ReportStore

    rep = _new_report(client, token)
    written = _section(client, token, rep, "goal_scope")
    _propose(client, token, rep, written, CLEAN)
    by_hand = _section(client, token, rep, "methods")
    _propose(client, token, rep, by_hand, CLEAN, model=None)

    def review_of(section_id: str):
        out = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/staleness", json={}, headers=token).json()
        return next(c for c in out["chapters"] if c["section_id"] == section_id)["review"]

    # Unreleased: the model-written chapter waits, the hand-written one has nobody to wait for.
    assert review_of(written["id"]) == "pending"
    assert review_of(by_hand["id"]) is None

    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/reviewed", json={"section_ids": [written["id"]]}, headers=token
    )
    assert r.status_code == 200, r.text
    assert review_of(written["id"]) == "released"

    # A hand edit lapses it; releasing again restores it.
    _patch_section(client, token, rep, written, {"kind": "goal_scope", "text": CLEAN + " One more sentence."})
    assert review_of(written["id"]) == "pending"
    client.post(f"/api/v1/report/one/{DB}/{rep['id']}/reviewed", json={"section_ids": [written["id"]]}, headers=token)
    assert review_of(written["id"]) == "released"

    # A legacy mark — time and text, no flag — is a reading, not a release.
    ReportStore().update_section(
        DB, rep["id"], written["id"], {"reviewed": {"at": "2026-09-01T00:00:00+00:00", "text": CLEAN + " One more sentence."}}
    )
    assert review_of(written["id"]) == "pending"

    # Withdrawing forgets the mark altogether.
    client.post(f"/api/v1/report/one/{DB}/{rep['id']}/reviewed", json={"read": False}, headers=token)
    assert review_of(written["id"]) == "pending"


def test_brief_proposal_and_patch_are_bound_to_one_snapshot_and_one_wording(client, token, project, snapshot):
    """The brief names the snapshot its numbers come from and the wording the chapter
    had; a proposal built on another snapshot is refused before anything is judged, a store over a text
    that moved in between is refused by the store, and both leave the stored chapter untouched."""
    del project, snapshot
    from prism_lca.engine.report_store import text_version

    rep = _new_report(client, token)
    sec = _section(client, token, rep, "goal_scope")
    brief = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/brief", json={}, headers=token).json()
    assert brief["snapshot_id"] and brief["text_version"] == text_version("")

    # The snapshot the brief came from: accepted.
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": CLEAN, "store": True, "model": "m", "snapshot_id": brief["snapshot_id"],
              "expected_text_version": brief["text_version"]},
        headers=token,
    )
    assert r.status_code == 200 and r.json()["stored"], r.text

    # Another snapshot: refused with the reason, nothing judged, nothing stored.
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": CLEAN + " Changed.", "store": True, "model": "m", "snapshot_id": "000000000000"},
        headers=token,
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "report_snapshot_moved", r.text

    # The wording moved since the brief (the first store above): a write that still echoes the old
    # version is refused, one that echoes the current version lands.
    stale_version = brief["text_version"]
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": CLEAN + " Again.", "store": True, "model": "m", "expected_text_version": stale_version},
        headers=token,
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "report_text_moved", r.text
    stored = client.get(f"/api/v1/report/one/{DB}/{rep['id']}", headers=token).json()
    section = next(s for s in stored["sections"] if s["id"] == sec["id"])
    assert section["text"] == CLEAN  # untouched
    assert section["text_version"] == text_version(CLEAN)  # GET carries the version the client echoes

    # The hand edit goes the same way: blur-save with the version it read.
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "goal_scope", "text": CLEAN + " By hand.", "expected_text_version": stale_version},
        headers=token,
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "report_text_moved", r.text
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "goal_scope", "text": CLEAN + " By hand.", "expected_text_version": section["text_version"]},
        headers=token,
    )
    assert r.status_code == 200 and r.json()["text_version"] == text_version(CLEAN + " By hand."), r.text

    # A patch dry run echoes both ids for the storing call.
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"old": "By hand.", "new": "By the author."}], "store": False},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["snapshot_id"] == brief["snapshot_id"] and r.json()["text_version"] == text_version(CLEAN + " By hand.")
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"old": "By hand.", "new": "By the author."}], "store": True, "snapshot_id": "000000000000"},
        headers=token,
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "report_snapshot_moved"
