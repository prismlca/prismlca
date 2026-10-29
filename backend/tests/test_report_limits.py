"""Statements about absent things — the author's switch, and the one exception to it.

The decision was that a report does not volunteer "this was not calculated" by default: it reads
defensively and pads the interpretation. So the Limitations chapter is opt-in, and adding it *is* the
switch — there is no second, hidden setting.

The exception is normative. ISO 14044 §7.3.3 requires a comparative assertion disclosed to the public
to have been critically reviewed by interested parties. A report that makes such a comparison, says it
is for publication and stays silent about the review claims a conformity it does not have. That note is
therefore emitted outside the section list, where deleting a chapter cannot reach it.

Which left one way to lose it anyway, and V191 found it: the note used to be suppressed by any text in
the study's `critical_review` field, on the assumption that a filled field means a review happened. The
field is free text, and the honest thing to write in it is a *negation* — so the note was switched off
by the sentence describing its absence, in one case by a sentence quoting §7.3.3 itself. The question is
answered by `critical_review_done` now, and both statements read it through one helper.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import report_checks as rc
from prism_lca.engine.report_model import render_blocks
from prism_lca.engine.report_store import DEFAULT_SECTIONS


def _subject(label: str) -> dict:
    return {"label": label, "scenario": None, "results": [{"method_label": "IPCC 2021", "unit": "kg", "score": 1.0}]}


# ---- the chapter is the switch ----------------------------------------------
def test_the_chapter_is_the_switch_and_it_starts_on():
    """There is still no flag: the chapter's presence is what decides, and deleting it is one click.

    It was once off by default, on the reasoning that a report should not volunteer negative
    sentences. What changed that is that a chapter nobody adds
    is a chapter nobody writes, and a study with nothing to declare can remove it.
    """
    kinds = [s["kind"] for s in DEFAULT_SECTIONS]
    assert "limitations" in kinds
    # Where practice puts it: with the interpretation, before the conclusions it qualifies.
    assert kinds.index("interpretation_checks") < kinds.index("limitations") < kinds.index("conclusions")


def test_the_chapter_names_what_is_actually_missing():
    out = render_blocks(rc.limitations_blocks({"study": {}}, "en", "Limitations"))
    assert "No quantitative uncertainty analysis" in out
    assert "No formal data quality assessment" in out
    assert "No critical review" in out
    assert "No scenarios were varied" in out


def test_a_recorded_critical_review_is_not_reported_as_missing():
    data = {"study": {"critical_review_done": "yes", "critical_review": "Reviewed by M. Example, 2026-06"}}
    out = render_blocks(rc.limitations_blocks(data, "en", "Limitations"))
    assert "No critical review" not in out
    assert "No quantitative uncertainty analysis" in out  # the others still hold


def test_a_description_without_the_answer_still_counts_as_missing():
    """V191: the description names a review, nobody confirmed one. The chapter says so.

    The other way round is what did the damage — but this is the direction the trade was chosen for: a
    sentence is not a confirmation, and the cost of asking again is a sentence too many in a chapter of
    caveats.
    """
    data = {"study": {"critical_review": "Reviewed by M. Example, 2026-06"}}
    assert "No critical review" in render_blocks(rc.limitations_blocks(data, "en", "Limitations"))


def test_a_scenario_removes_the_sensitivity_sentence():
    data = {"study": {}, "subjects": [{"label": "A", "scenario": "sc-1", "results": []}]}
    out = render_blocks(rc.limitations_blocks(data, "en", "Limitations"))
    assert "No scenarios were varied" not in out


def test_the_chapter_does_not_invent_absences_that_may_be_filled_later():
    """Guards against the chapter starting to lie the day uncertainty analysis ships: every sentence is
    conditional on the data, not hardcoded."""
    data = {"study": {"critical_review_done": "yes"}, "uncertainty": {"runs": 1000},
            "data_quality": {"pedigree": "..."},
            "subjects": [{"label": "A", "scenario": "sc-1", "results": []}]}
    out = render_blocks(rc.limitations_blocks(data, "en", "Limitations"))
    assert "no further limitations are declared" in out


# ---- G1: the exception ------------------------------------------------------
def test_the_iso_note_appears_for_a_public_comparison_without_a_review():
    data = {"study": {}, "subjects": [_subject("A"), _subject("B")]}
    out = render_blocks(rc.critical_review_note(data, {"options": {"intended_public": True}}, "en"))
    assert "ISO 14044 §7.3.3" in out
    assert "critical review" in out


def test_the_iso_note_stays_away_unless_all_three_conditions_hold():
    two = [_subject("A"), _subject("B")]
    public = {"options": {"intended_public": True}}
    # Not marked for publication — an internal comparison is nobody else's business.
    assert rc.critical_review_note({"study": {}, "subjects": two}, {"options": {}}, "en") == []
    # Not a comparison — §7.3.3 is about comparative assertions.
    assert rc.critical_review_note({"study": {}, "subjects": [_subject("A")]}, public, "en") == []
    # A review is confirmed, so there is nothing to disclose.
    confirmed = {"study": {"critical_review_done": "yes"}, "subjects": two}
    assert rc.critical_review_note(confirmed, public, "en") == []


def test_the_note_is_emitted_outside_the_section_list():
    """The whole point of G1: it must not be removable by deleting a chapter."""
    from prism_lca.engine.report_render import blocks_for

    report = {"lang": "en", "options": {"intended_public": True}, "sections": []}
    data = {"study": {}, "subjects": [_subject("A"), _subject("B")]}
    blocks, _ = blocks_for(report, {}, {}, None, data, None, [_subject("A"), _subject("B")])
    assert "ISO 14044 §7.3.3" in render_blocks(blocks)


def test_the_note_follows_the_report_language():
    data = {"study": {}, "subjects": [_subject("A"), _subject("B")]}
    out = render_blocks(rc.critical_review_note(data, {"options": {"intended_public": True}}, "de"))
    assert "vergleichende Aussage" in out and "interessierte Kreise" in out


# ---- V191: the note survives the sentence that describes its absence ---------
#: What authors actually write into `critical_review`, taken from the studies on record here. Every one
#: of them is a negation — the field has never once been filled affirmatively — so "field is not empty"
#: had only ever silenced the note falsely. The third is the one that proves it: it quotes the very
#: requirement the note states.
NEGATIONS = (
    "Keine kritische Prüfung (interne Screening-Studie).",
    "Kein externes kritisches Review durchgeführt (Screening-Studie ohne vergleichende Verwendung "
    "gegenüber Dritten; interner Zweit-Review durch die Review-Funktion).",
    "Keine kritische Prüfung (Screening-Studie, interne Verwendung). Für eine vergleichende "
    "öffentliche Aussage wäre eine kritische Prüfung nach ISO 14044 §7.3.3 erforderlich.",
    "None. Internal screening study, not intended for comparative assertions disclosed to the public.",
)


@pytest.mark.parametrize("said", NEGATIONS)
def test_a_field_that_denies_a_review_does_not_switch_off_the_note(said):
    data = {"study": {"critical_review": said}, "subjects": [_subject("A"), _subject("B")]}
    out = render_blocks(rc.critical_review_note(data, {"options": {"intended_public": True}}, "en"))
    assert "ISO 14044 §7.3.3" in out


def test_the_measured_case_carries_the_note_in_the_document():
    """The mould-remover run: marked for disclosure, three variants compared, "Keine kritische Prüfung
    (interne Screening-Studie)." in the field — and 29 pages with no §7.3.3 note anywhere. Asserted on
    the assembled document, not on the check, because that is where it was missing."""
    from prism_lca.engine.report_render import blocks_for

    report = {"lang": "en", "options": {"intended_public": True}, "sections": []}
    three = [_subject("A"), _subject("B"), _subject("C")]
    data = {"study": {"critical_review": "Keine kritische Prüfung (interne Screening-Studie)."},
            "subjects": three}
    blocks, _ = blocks_for(report, {}, {}, None, data, None, three)
    assert "ISO 14044 §7.3.3" in render_blocks(blocks)


@pytest.mark.parametrize(
    "study",
    [
        {},
        {"critical_review": NEGATIONS[2]},
        {"critical_review_done": "no", "critical_review": NEGATIONS[0]},
        {"critical_review_done": "", "critical_review": "Reviewed by M. Example, 2026-06"},
        {"critical_review_done": "yes"},
        {"critical_review_done": "yes", "critical_review": "Panel of three interested parties, 2026-06"},
    ],
)
def test_the_note_and_the_declared_limitation_never_disagree(study):
    """One fact, two sentences, one reading. They used to read the same field in opposite directions,
    so a study that denied a review lost both — the normative note *and* the caveat."""
    data = {"study": study, "subjects": [_subject("A"), _subject("B")]}
    noted = "ISO 14044 §7.3.3" in render_blocks(
        rc.critical_review_note(data, {"options": {"intended_public": True}}, "en")
    )
    declared = "No critical review" in render_blocks(rc.limitations_blocks(data, "en", "Limitations"))
    assert noted == declared, study


def test_only_the_stated_answer_silences_the_note():
    """Anything that is not "yes" is "not confirmed" — the direction where a mistake costs a sentence
    rather than a claim of conformity."""
    two = [_subject("A"), _subject("B")]
    public = {"options": {"intended_public": True}}
    for answer in ("", "no", "maybe", "ja", "true"):
        data = {"study": {"critical_review_done": answer}, "subjects": two}
        assert rc.critical_review_note(data, public, "en") != [], answer
    assert rc.critical_review_note({"study": {"critical_review_done": "YES "}, "subjects": two},
                                   public, "en") == []


def test_the_writers_brief_reads_the_same_answer_as_the_document():
    """The caution telling the writer not to call one variant better, and the note in the document, are
    the same rule. A brief that lifted the prohibition while the note printed would send the writer
    straight past it."""
    from prism_lca.engine.report_prompts import cautions

    report = {"options": {"intended_public": True}}
    subjects = [
        {"code": "a", "results": [{"method_label": "m", "score": 1.0, "unit": "kg"}]},
        {"code": "b", "results": [{"method_label": "m", "score": 2.0, "unit": "kg"}]},
    ]
    denied = {"study": {"critical_review": NEGATIONS[0]}, "subjects": subjects}
    assert "never write that one variant is better" in " ".join(cautions(report, denied))
    confirmed = {"study": {"critical_review_done": "yes"}, "subjects": subjects}
    assert "never write that one variant is better" not in " ".join(cautions(report, confirmed))


def test_the_review_status_is_stated_whether_or_not_there_was_one():
    """Every other goal & scope field is dropped when empty. This one is not: a report that omits the
    line lets the reader assume there was a review."""
    from prism_lca.engine.report_typst import goal_scope_blocks

    empty = render_blocks(goal_scope_blocks({"goal": "Compare two bottles"}, "en"))
    assert "Critical review" in empty and "Not recorded" in empty

    done = render_blocks(goal_scope_blocks({"critical_review": "Reviewed by M. Meier, 2026-07"}, "en"))
    assert "M. Meier" in done

    # Confirmed and left undescribed: the row states the answer rather than "Not recorded", which the
    # limitations chapter would have contradicted two chapters later.
    bare = render_blocks(goal_scope_blocks({"critical_review_done": "yes"}, "en"))
    assert "Carried out" in bare and "Not recorded" not in bare
    # Answered "no" and left undescribed: an answer as well, and the short report prints this row
    # whenever it has no written goal & scope chapter — which is always.
    denied = render_blocks(goal_scope_blocks({"critical_review_done": "no"}, "en"))
    assert "None carried out" in denied and "Not recorded" not in denied
    # And only the fact — what ISO demands of a public comparative assertion is already said by
    # `critical_review_note` and by this chapter, and a third time here would be padding.
    assert "14044" not in done and "14044" not in empty


# ---- V170: nothing an author types may cost the whole document --------------
#: Everything a real limitation puts in front of the compiler: a cut-off written as a range, a grade
#: with a hash, an emphasis, an at sign and a currency. `<0,2` is the one that did the damage — Typst
#: reads it as the start of a label, finds no closing `>`, and refuses the *document*.
HOSTILE = "Surfactants <0,2–5 % (#2 grade), *approx.* @ 20 °C, cost $3 per unit_batch"


def _typeset(blocks: list[dict]) -> bytes:
    from prism_lca.engine import report_typst, typst_render

    return typst_render.compile_pdf(report_typst.wrap_document(blocks, title="Limits", lang="en"))


def test_a_declared_limitation_written_in_typst_syntax_still_typesets():
    """V170: an AI report could not be produced at all — no PDF, no preview, no bundle export — because
    a declared limitation reached the compiler raw. Declared limitations are author text, and author
    text goes through the markup translator, exactly as the process notes do."""
    data = {"study": {"limitations": [{"text": HOSTILE}]}}
    assert _typeset(rc.limitations_blocks(data, "en", "Limitations")).startswith(b"%PDF")


def test_the_declared_limitation_keeps_the_author_s_words():
    """Escaped, not stripped: the characters have to reach the page as themselves. Only the markdown
    subset is translated — `*approx.*` is emphasis, which is what a writer meant by typing it."""
    out = render_blocks(rc.limitations_blocks({"study": {"limitations": [{"text": HOSTILE}]}}, "en", "Limitations"))
    assert "\\<0,2–5 %" in out
    assert "\\#2 grade" in out
    assert "\\@ 20 °C" in out and "\\$3" in out and "unit\\_batch" in out
    assert "#emph[approx.]" in out


def test_an_open_review_finding_written_in_typst_syntax_still_typesets():
    """The other half of the chapter that is author text: what the internal review left open."""
    data = {
        "study": {},
        "review": {
            "created": "2026-08-19T09:00:00Z",
            "open": [{"finding": "cut-off <1 % of mass", "reason": "below the #2 threshold"}],
        },
    }
    blocks = rc.limitations_blocks(data, "en", "Limitations")
    out = render_blocks(blocks)
    assert "cut-off \\<1 % of mass — below the \\#2 threshold" in out
    assert _typeset(blocks).startswith(b"%PDF")


def test_a_method_name_quoted_back_at_the_reader_cannot_break_the_document():
    """The mismatch sentence quotes two names into raw prose: one lifted out of the author's sentence,
    one out of the method list — and a method family is whatever the database calls it."""
    data = {
        "results": [{"method": ["EF v3.1 <internal>", "climate change", "GWP100"]}],
        "study": {"limitations": [{"text": "Climate figures follow IPCC 2021."}]},
    }
    blocks = rc.limitations_blocks(data, "en", "Limitations")
    out = render_blocks(blocks)
    assert "names IPCC 2021" in out and "EF v3.1 \\<internal\\>" in out
    assert _typeset(blocks).startswith(b"%PDF")
