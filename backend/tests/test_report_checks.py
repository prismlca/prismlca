"""ISO 14044 §4.5: completeness, sensitivity and consistency.

The point of these tests is not that the chapter renders — it is that each check *says what it
examined*. A check that reports "consistent" without naming the basis is worse than no check, because
a reviewer cannot tell whether anything was looked at.
"""
from __future__ import annotations

from prism_lca.engine import report_checks as rc
from prism_lca.engine.report_model import render_blocks


def _typst(blocks) -> str:
    return render_blocks(blocks)


def _subject(label: str, scenario: str | None, scores: list[tuple[str, float]]) -> dict:
    return {
        "label": label,
        "scenario": scenario,
        "results": [
            {"method_label": name, "unit": "kg CO2-eq", "score": score, "method": [name]} for name, score in scores
        ],
    }


# ---- completeness ------------------------------------------------------------
def test_a_clean_linter_is_stated_as_a_result_not_left_blank():
    health = {"activities": 7, "findings": [], "summary": {"error": 0, "warning": 0}}
    out = _typst(rc.interpretation_blocks({}, health, "en", "Checks"))
    assert "All 7 foreground processes were checked structurally." in out
    # …and no count of nothing. "0 findings require attention" is a machine counting to zero (V254);
    # the clean sentence below says the same thing in words.
    assert "findings require attention" not in out
    assert "No structural gaps were found" in out


def test_findings_are_tabulated_with_the_process_they_belong_to():
    health = {
        "activities": 3,
        "findings": [
            {"severity": "error", "message": "Activity has no production exchange.",
             "activity": {"name": "Assembly"}},
            {"severity": "info", "message": "Consider a comment.", "activity": {"name": "Assembly"}},
        ],
        "summary": {"error": 1},
    }
    out = _typst(rc.interpretation_blocks({}, health, "en", "Checks"))
    assert "Assembly" in out and "no production exchange" in out
    # `info` is style advice; carrying it here would bury the finding that matters.
    assert "Consider a comment" not in out
    # The finding count left the intro with V254 — the table below names each one, which is what the
    # reader acts on. What the sentence still has to say is how much was looked at.
    assert "All 3 foreground processes were checked structurally." in out


def test_a_missing_linter_run_says_so_rather_than_implying_a_clean_model():
    out = _typst(rc.interpretation_blocks({}, None, "en", "Checks"))
    assert "was not available" in out
    assert "No structural gaps" not in out


# ---- sensitivity -------------------------------------------------------------
def test_the_spread_across_scenarios_is_computed_from_the_subjects_already_rendered():
    data = {
        "subjects": [
            _subject("Baseline", None, [("IPCC 2021", 2.0)]),
            _subject("Recycled input", "sc-1", [("IPCC 2021", 3.0)]),
        ]
    }
    out = _typst(rc.interpretation_blocks(data, None, "en", "Checks"))
    assert "2 computed variants, of which 1 under a scenario" in out
    # 2.0 → 3.0 is +50% against the smaller magnitude.
    assert "50" in out
    assert "IPCC 2021" in out


def test_without_a_scenario_the_absence_is_stated_because_the_standard_asks_for_the_check():
    """The one place the report speaks about something absent by default. §4.5.3 requires a sensitivity
    check, so silence would let a reader assume one was done."""
    data = {"subjects": [_subject("Baseline", None, [("IPCC 2021", 2.0)])]}
    out = _typst(rc.interpretation_blocks(data, None, "en", "Checks"))
    assert "No scenarios were varied" in out
    assert "ISO 14044" in out


def test_a_zero_score_does_not_invent_a_percentage():
    data = {
        "subjects": [
            _subject("Baseline", None, [("Water use", 0.0)]),
            _subject("Variant", "sc-1", [("Water use", 0.5)]),
        ]
    }
    out = _typst(rc.interpretation_blocks(data, None, "en", "Checks"))
    assert "Water use" in out
    assert "%" not in out.split("Water use")[1].split("\n")[0]


def test_an_indicator_only_one_subject_has_is_skipped_rather_than_treated_as_zero():
    data = {
        "subjects": [
            _subject("Baseline", None, [("IPCC 2021", 2.0)]),
            _subject("Variant", "sc-1", [("IPCC 2021", 2.4), ("Water use", 9.0)]),
        ]
    }
    out = _typst(rc.interpretation_blocks(data, None, "en", "Checks"))
    assert "IPCC 2021" in out
    # Counting the missing one as 0 would report a 100% spread that nothing supports.
    assert "Water use" not in out


# ---- consistency -------------------------------------------------------------
def test_consistency_names_the_basis_of_every_verdict():
    data = {
        "subjects": [
            _subject("A", None, [("IPCC 2021", 1.0)]),
            _subject("B", "sc-1", [("IPCC 2021", 1.2)]),
        ],
        "provenance": {"background": "ecoinvent-3.12-cutoff"},
        "study": {"functional_unit": "1 kg of product"},
        "amount": 1.0,
    }
    out = _typst(rc.interpretation_blocks(data, None, "en", "Checks"))
    # The whole row, not just the verdict: "consistent" without a basis is not a check.
    assert '("Background database named", "yes", "ecoinvent-3.12-cutoff")' in out
    assert '("Functional unit defined", "yes", "1 kg of product")' in out
    assert '("Same impact indicators for every subject", "yes", "1")' in out


def test_differing_indicator_sets_between_subjects_fail_the_check():
    data = {
        "subjects": [
            _subject("A", None, [("IPCC 2021", 1.0)]),
            _subject("B", "sc-1", [("Water use", 4.0)]),
        ],
        "provenance": {},
        "study": {},
    }
    out = _typst(rc.interpretation_blocks(data, None, "en", "Checks"))
    assert '("Same impact indicators for every subject", "no", "differ between subjects")' in out
    assert '("Functional unit defined", "no", "not defined")' in out
    # No background used, nothing to name: the row is left out rather than shown as failed.
    assert "Background database named" not in out


# ---- language ---------------------------------------------------------------
def test_the_chapter_follows_the_report_language():
    health = {"activities": 2, "findings": [], "summary": {}}
    out = _typst(rc.interpretation_blocks({}, health, "de", "Prüfungen"))
    assert "Vollständigkeitsprüfung" in out
    assert "Sensitivitätsprüfung" in out
    assert "Konsistenzprüfung" in out
    assert "Completeness" not in out


# ---- the checks as numbers, and a comment that can quote them --------------------------
_TWO = {
    "study": {"functional_unit": "1 bag"},
    "provenance": {"background": "ecoinvent 3.12"},
    "health": {"activities": 7, "findings": [{"severity": "warning", "message": "x"}, {"severity": "info", "message": "y"}]},
    "subjects": [
        {"label": "Baseline", "code": "a", "results": [{"method_label": "climate change", "score": 0.10, "unit": "kg CO2-Eq"}]},
        {"label": "Thicker", "code": "b", "scenario": "s1", "results": [{"method_label": "climate change", "score": 0.15, "unit": "kg CO2-Eq"}]},
    ],
}


def test_the_checks_are_available_as_numbers_for_a_comment_to_quote():
    """ISO 14044 §4.5 asks for a judgement here, and a judgement has to quote the figures it rests on.
    Without these in the snapshot a sentence like "1 finding across 7 processes" could only be typed
    out — and the gate would rightly refuse it."""
    from prism_lca.engine.report_checks import checks_summary

    summary = checks_summary(_TWO)
    assert summary["completeness"] == {"activities": 7, "findings": 1, "clean": False}
    assert summary["sensitivity"][0]["spread_percent"] == 50.0
    # Ready to print (V338): the prose placeholder used to be the bare number, and the chapter read
    # "The range is 93.6 for climate change" under a table that said "93.6 %".
    assert summary["sensitivity"][0]["spread_text"] == "50.0 %"
    assert summary["consistency"]["varied"] == 1 and summary["consistency"]["background"] == "ecoinvent 3.12"


def test_the_table_and_the_numbers_come_from_one_computation():
    """The failure this rules out: a sentence disagreeing with the table above it. Both read
    sensitivity_rows, so they cannot drift apart."""
    from prism_lca.engine.report_checks import interpretation_blocks, sensitivity_rows

    rows = sensitivity_rows(_TWO)
    blocks = interpretation_blocks(_TWO, _TWO["health"], "en", "Interpretation")
    tables = [b for b in blocks if b.get("type") == "table"]
    sensitivity = next(t for t in tables if t.get("label") == "t-sensitivity")
    assert f"{rows[0]['spread_percent']:.1f}".rstrip("0").rstrip(".") in " ".join(sensitivity["rows"][0])


def test_a_comment_is_rendered_under_the_deterministic_tables_not_above_them():
    """Finding first, judgement second — a paragraph above its own table introduces something the
    reader has not seen yet."""
    from prism_lca.engine.report_data import build_data
    from prism_lca.engine.report_render import blocks_for

    # Through build_data, because that is what puts the check numbers into the snapshot in the first
    # place — a hand-made dict would test the renderer against data the app never produces.
    subjects = [
        {"label": s["label"], "code": s["code"], "scenario": s.get("scenario"), "lcia": {"results": [
            {"method": [r["method_label"]], "unit": r["unit"], "score": r["score"]} for r in s["results"]
        ]}}
        for s in _TWO["subjects"]
    ]
    data = build_data(
        _TWO["study"],
        {"results": [], "amount": 1.0},
        None,
        provenance=_TWO["provenance"],
        subjects=subjects,
        health=_TWO["health"],
    )
    report = {
        "lang": "en",
        "sections": [
            {
                "id": "s1",
                "kind": "interpretation_checks",
                "order": 0,
                "text": "The spread of {{checks.sensitivity.0.spread_percent}} % carries the conclusion.",
            }
        ],
    }
    blocks, missing = blocks_for(report, _TWO["study"], {"results": []}, None, data, {}, data["subjects"])
    assert not missing
    kinds = [b.get("type") for b in blocks]
    assert kinds[-1] == "prose"  # the comment sits after the tables
    assert "50" in blocks[-1]["text"]


def test_trade_offs_are_computed_where_the_ranking_turns_over():
    from prism_lca.engine.report_data import trade_offs

    data = {
        "subjects": [
            {
                "label": "A",
                "results": [
                    {"method_label": "climate", "score": 2.0, "unit": "kg"},
                    {"method_label": "water", "score": 1.0, "unit": "m3"},
                ],
            },
            {
                "label": "B",
                "results": [
                    {"method_label": "climate", "score": 1.0, "unit": "kg"},
                    {"method_label": "water", "score": 5.0, "unit": "m3"},
                ],
            },
        ]
    }
    assert trade_offs(data) == [{"method_label": "water", "highest": "B", "score": 5.0}]
    # One variant highest throughout → nothing to name.
    data["subjects"][1]["results"][1]["score"] = 0.5
    assert trade_offs(data) == []


def test_a_percent_sign_after_a_placeholder_that_prints_one_is_refused():
    """Found in the sample report's own summary: "under 6.6 % %". Some placeholders carry their unit —
    anything named `…_text`, and every percent/change derivation — so an added sign prints twice. There
    is no reading in which that is right, so it blocks and the correction loop removes it."""
    from prism_lca.engine.report_prompts import check_proposal

    data = {
        "contribution": {
            "unit": "kg CO2-Eq",
            "groups": [{"key": "Production", "value": 1.0, "share_percent": 6.6, "share_text": "6.6 %"}],
        }
    }
    bad = check_proposal("Production contributes {{contribution.groups.0.share_text}} %.", {}, data, "en")
    assert not bad["ok"]
    assert any(f["kind"] == "duplicated_unit" for f in bad["findings"])
    good = check_proposal("Production contributes {{contribution.groups.0.share_text}}.", {}, data, "en")
    assert good["ok"]


def test_a_plain_number_placeholder_may_of_course_be_followed_by_a_unit():
    """The rule is about placeholders that already print one — a bare score still needs its unit."""
    from prism_lca.engine.report_prompts import check_proposal

    data = {"results": [{"method_label": "climate change", "score": 0.12, "unit": "kg CO2-Eq"}]}
    verdict = check_proposal("The result is {{results.0.score}} kg CO2-Eq.", {}, data, "en")
    assert verdict["ok"]


# ---- markup: emphasis carried over, everything else made harmless ---------------------------
def test_a_hash_in_prose_no_longer_breaks_the_document():
    """It used to fail the whole render ("expected expression"), and `#link(...)` would have gone
    straight into a client's PDF. The author's words are escaped now."""
    from prism_lca.engine.report_data import resolve

    out, _ = resolve('Costs rose by # 3 units, see #link("x")[here].', {}, "en")
    assert out.count("\\#") == 2 and out.count("\\[") == 1  # both hashes and the bracket are escaped


def test_bold_italic_and_lists_are_translated():
    from prism_lca.engine.report_data import resolve

    out, _ = resolve("The **thicker bag** is *worse*.\n- one\n2. two", {}, "en")
    assert "#strong[thicker bag]" in out and "#emph[worse]" in out
    assert "\n- one" in out and "\n+ two" in out  # Typst numbers an enumeration itself


def test_a_code_span_loses_its_fence_and_keeps_its_words():
    """The one construct recognised in order to be removed. Writers fence things out of Markdown
    habit, nothing translated it, and a real report told a client the indicators were "drawn from
    the \\`EF v3.1\\` method family" — backticks and all. Setting them in a code face instead
    would make `mass_kg` look right and `EF v3.1` look like a filename, and which of the two was
    fenced is not knowable here."""
    from prism_lca.engine.report_data import resolve

    out, _ = resolve("drawn from the `EF v3.1` family, mass is `mass_kg`.", {}, "en")
    assert "`" not in out
    assert "EF v3.1" in out and "mass\\_kg" in out  # the underscore stays escaped for Typst

    # A run of backticks opens the span as long as the same run closes it.
    assert "`" not in resolve("double ``fence`` too", {}, "en")[0]

    # An unpaired one is the literal character it probably is, and stays escaped.
    assert "\\`" in resolve("an unpaired ` backtick", {}, "en")[0]

    # A span may not cross a line, so a stray backtick cannot swallow the paragraph after it.
    two = resolve("first line `open\nsecond line", {}, "en")[0]
    assert "\\`" in two and "second line" in two

    # Inside a span, emphasis is text — the fence wins, as it does in Markdown.
    assert "#strong" not in resolve("see `a **b** c` here", {}, "en")[0]


def test_emphasis_survives_a_placeholder_inside_it():
    from prism_lca.engine.report_data import resolve

    data = {"results": [{"score": 0.1195, "unit": "kg CO2-Eq"}]}
    out, missing = resolve("**{{results.0.score}} kg** is the result.", data, "en")
    # Three significant digits, so 0.1195 prints as "0.119" — what is under test here is that the
    # emphasis survives the substitution, not how precisely the figure is written.
    assert not missing and out.startswith("#strong[0.119 kg]")


def test_emojis_are_refused_outright():
    """A hard ban by the author's instruction — the one formatting rule with no exception."""
    from prism_lca.engine.report_prompts import check_proposal

    verdict = check_proposal("The result is good 👍 and the trend is up 📈.", {}, {}, "en")
    assert not verdict["ok"]
    assert any(f["kind"] == "emoji" for f in verdict["findings"])
    # The characters an LCA text needs are not emojis. (No digits here: with no data handed over, a
    # number would be flagged as an invention, which is a different rule.)
    clean = check_proposal("Incineration at high temperature; ±, °C, CO₂-eq, µg — all fine.", {}, {}, "en")
    assert not [f for f in clean["findings"] if f["kind"] == "emoji"]


# --- the register, counted rather than judged ---------------------------------------------------

def test_the_antithesis_habit_is_remarked_on_but_never_blocks():
    """V257: a wood-stain report built eight sentences in nine chapters on the same figure
    of speech. One is ordinary English; this many is a voice, and it is what makes a text read as
    written by a machine. Advisory, because a style rule that blocks gets switched off."""
    from prism_lca.engine.report_prompts import check_proposal

    filler = "The system boundary covers the coated surface and the empty container. " * 12
    habit = (
        "The result is not a value, but a structure. What survives the spread is the ordering; what "
        "does not survive is any absolute figure. It rests on the coverage assumption rather than on "
        "the recipe. The finding is structural rather than numerical. It is an act of measurement "
        "rather than a choice between variants. "
    )
    verdict = check_proposal(habit + filler, {}, {}, "en")
    hits = [f for f in verdict["findings"] if f["kind"] == "antithesis_habit"]
    assert len(hits) == 1, [f["kind"] for f in verdict["findings"]]
    assert verdict["ok"], "a style remark must never refuse a chapter"


def test_one_antithesis_in_a_short_chapter_is_ordinary_english_too():
    """V395: one "rather than" in 155 words is 6.5 per thousand, above the density threshold, and the
    remark fired while saying that one is ordinary. A habit needs at least two instances."""
    from prism_lca.engine.report_prompts import check_proposal

    text = "The remainder is a proxy rather than a measured formulation. " + "The container is steel. " * 36
    assert 120 <= len(text.split()) <= 160
    assert not [f for f in check_proposal(text, {}, {}, "en")["findings"] if f["kind"] == "antithesis_habit"]


def test_one_antithesis_in_a_chapter_is_ordinary_english():
    from prism_lca.engine.report_prompts import check_proposal

    text = (
        "The study reports three indicators. Manufacturing leads each of them. The use phase matters "
        "for climate change rather than for the other two. " + "The container is steel. " * 40
    )
    verdict = check_proposal(text, {}, {}, "en")
    assert not [f for f in verdict["findings"] if f["kind"] == "antithesis_habit"]


# --- the report does not describe its own making -----------------------------------------------

def test_a_chapter_that_describes_its_own_making_is_refused():
    """V253. A wood-stain report said three times that it was not a report, because the
    modelling brief ("kein Bericht schreiben") had been recorded in the study's goal field and the
    writer wove it in. The `goal_scope` prompt describes that exact case over six lines and was not
    enough — a rule needs an instance that enforces it."""
    from prism_lca.engine.report_prompts import check_proposal

    for sentence in (
        "The ambition is limited: the deliverable is a model, not a report.",
        "This was carried out as a model-only study for a private user.",
        "The study delivers a parameterised model rather than a report.",
        "An internal model review was carried out on 2026-08-26.",
        "Research showed that the recycling rate is 87 %.",
        "The health check returned no findings.",
        # The product name in every spelling it has had — PrismLCA has no word boundary
        # after "Prism", so a bare `Prism\b` would let the current name through.
        "The model was built in PrismLCA.",
        "The model was built in Prism LCA.",
        "The model was built in Prism.",
    ):
        verdict = check_proposal(sentence, {}, {}, "en")
        assert not verdict["ok"], sentence
        assert any(f["kind"] == "self_reference" for f in verdict["findings"]), sentence


def test_writing_about_the_study_and_its_model_is_left_alone():
    """Narrow on purpose: it blocks, so a false hit would cost a paid rewrite. "The study", "this
    assessment" and the product system's own "model" are what the document is about."""
    from prism_lca.engine.report_prompts import check_proposal

    for sentence in (
        "The study assesses one square metre of coated furniture wood.",
        "This assessment follows ISO 14044 and reports three indicators.",
        "The model of the product system covers five life cycle phases.",
        "No critical review as described in ISO 14044 is recorded for this study.",
    ):
        verdict = check_proposal(sentence, {}, {}, "en")
        assert not [f for f in verdict["findings"] if f["kind"] == "self_reference"], sentence


# --- a declared limitation that contradicts the method selection ---------------------------------
#
# Chapter 8.1 of a solar-lamp report printed "Ergebnis beruht auf IPCC 2021 GWP100
# (Klimawirkung)" while every figure in the document came from EF v3.1 — a leftover from an earlier
# version of the model. Declared limitations are author text and nothing checked them, although the
# report has the method list on the same page.

def _study_with(limitation: str) -> dict:
    return {
        "results": [{"method": ["EF v3.1", "climate change", "GWP100"], "method_label": "EF v3.1 / …"}],
        "study": {"limitations": [{"text": limitation}]},
    }


def test_a_limitation_naming_a_foreign_method_family_is_reported():
    found = rc.declared_method_mismatch(
        _study_with("Ergebnis beruht auf IPCC 2021 GWP100 (Klimawirkung)."), "en"
    )
    assert len(found) == 1
    assert "IPCC 2021" in found[0] and "EF v3.1" in found[0]


def test_a_limitation_naming_the_study_s_own_family_is_fine():
    assert rc.declared_method_mismatch(_study_with("Only EF v3.1 indicators were quantified."), "en") == []


def test_a_factor_source_named_alongside_the_study_s_family_is_left_alone():
    """EF's climate factors really are IPCC's — saying so is correct, and common."""
    text = "Climate factors follow IPCC 2021 as adopted by EF v3.1; other categories were not assessed."
    assert rc.declared_method_mismatch(_study_with(text), "en") == []


def test_a_limitation_about_something_else_entirely_is_not_a_method_claim():
    text = "Der Hersteller veröffentlicht weder Gewicht noch Materialaufteilung des Produkts."
    assert rc.declared_method_mismatch(_study_with(text), "en") == []


def test_without_a_computed_method_nothing_can_be_contradicted():
    assert rc.declared_method_mismatch({"study": {"limitations": [{"text": "IPCC 2021"}]}}, "en") == []


def test_the_mismatch_reaches_the_limitations_chapter():
    blocks = rc.limitations_blocks(_study_with("Ergebnis beruht auf IPCC 2021 GWP100."), "en", "Limitations")
    printed = " ".join(str(b.get("text") or "") for b in blocks)
    assert "IPCC 2021" in printed and "EF v3.1" in printed


# --- and the same contradiction in the study's other author fields --------------------------------
#
# The PVC window study declared its primary indicator under `goal` — "Treibhauspotenzial (IPCC 2021,
# GWP100)" — computed everything with EF v3.1, and the printed Goal-and-scope chapter repeated the
# claim. Chapter 8.2 said nothing, because the check read one field out of nine (V181).

def _study_field(field: str, text: str) -> dict:
    return {
        "results": [{"method": ["EF v3.1", "climate change", "GWP100"], "method_label": "EF v3.1 / …"}],
        "study": {field: text},
    }


def test_a_goal_naming_a_foreign_method_family_is_reported_with_its_field():
    found = rc.declared_method_mismatch(
        _study_field(
            "goal",
            "Primärindikator: Treibhauspotenzial (IPCC 2021, GWP100). Ergebnisse dienen der internen "
            "Einordnung; kein Bericht erforderlich.",
        ),
        "en",
    )
    assert len(found) == 1
    # Without the field the author reads "a declared limitation" and looks in the wrong chapter.
    assert found[0].startswith("Under Goal of the study,")
    assert "IPCC 2021" in found[0] and "EF v3.1" in found[0]


def test_every_iso_free_text_field_is_read_not_only_the_limitations():
    for field in ("scope", "functional_unit", "system_boundaries", "cutoff_criteria", "allocation",
                  "system_allocation", "critical_review"):
        found = rc.declared_method_mismatch(_study_field(field, "Assessed with ReCiPe 2016."), "en")
        assert len(found) == 1, field
        assert "ReCiPe 2016" in found[0], field


def test_a_field_naming_both_families_is_left_alone():
    text = "Climate factors follow IPCC 2021 within EF v3.1; no other indicator is reported."
    assert rc.declared_method_mismatch(_study_field("system_boundaries", text), "en") == []


def test_the_study_s_own_family_spelled_without_the_v_is_still_its_own_family():
    """"EF 3.1" for "EF v3.1" is a typist, and a badge that fires on it stops being read."""
    assert rc.declared_method_mismatch(_study_field("allocation", "Mass allocation, EF 3.1 default."), "en") == []


def test_a_method_named_only_as_a_contrast_is_not_a_stale_claim():
    """Saying which method was *not* used is scoping prose. The sentence, not the whole field, decides —
    the PVC goal above ends in "kein Bericht erforderlich" and must still be reported."""
    for text in (
        "Die Ergebnisse wurden nicht mit ReCiPe 2016 verglichen.",
        "Results are not comparable with CML 2001 studies.",
        "A comparison against TRACI 2.1 was out of scope.",
    ):
        assert rc.declared_method_mismatch(_study_field("scope", text), "en") == [], text


def test_a_short_abbreviation_standing_alone_is_not_a_method_claim():
    """V239: the Balkonkraftwerk report names the insulation material, not Environmental Priority
    Strategies. Three letters and nothing beside them cannot carry a method claim."""
    text = "The mounting frame is packed in EPS, which the manufacturer does not quantify."
    assert rc.declared_method_mismatch(_study_field("cutoff_criteria", text), "en") == []


def test_a_short_abbreviation_with_a_method_word_beside_it_still_is_one():
    text = "Weighting of the damage categories follows the EPS method."
    found = rc.declared_method_mismatch(_study_field("allocation", text), "en")
    assert len(found) == 1 and "EPS" in found[0]


def test_a_short_abbreviation_with_a_version_needs_no_further_support():
    found = rc.declared_method_mismatch(_study_field("scope", "Figures follow CML 2001."), "en")
    assert len(found) == 1 and "CML 2001" in found[0]


def test_a_field_without_any_method_name_is_not_a_method_claim():
    text = "Cradle to gate, including transport to the factory gate; the use phase is excluded."
    assert rc.declared_method_mismatch(_study_field("system_boundaries", text), "en") == []


def test_the_field_label_is_translated_like_every_other_report_string():
    from prism_lca.engine.report_i18n import LANGUAGES, t

    for lang in LANGUAGES:
        found = rc.declared_method_mismatch(_study_field("goal", "Primary indicator IPCC 2021 GWP100."), lang)
        assert len(found) == 1, lang
        # A language without the label would print the key itself.
        assert t("field.goal", lang) in found[0], lang
        assert t("field.limitations", lang) != "field.limitations", lang


# --- V234: a claimed internal review that never ran ---------------------------------------------


def _study(text: str) -> dict:
    return {"study": {"critical_review": text}, "review": {}}


def test_a_claimed_model_review_that_never_ran_is_named():
    from prism_lca.engine.report_checks import claimed_review_not_run

    data = _study(
        "Keine externe kritische Prüfung nach ISO 14044 erfolgt (Screening-Studie). Interne "
        "Qualitätskontrolle: strukturelle Modellprüfung (Prism Model Health Check) und "
        "automatisierte Modellreview; Ergebnisse sind als Screeningwerte zu verstehen."
    )
    lines = claimed_review_not_run(data, "de")
    assert len(lines) == 1, lines
    assert "interne Modellprüfung" in lines[0]


def test_a_review_that_did_run_says_nothing():
    from prism_lca.engine.report_checks import claimed_review_not_run

    data = _study("Interne Qualitätskontrolle: automatisierte Modellreview.")
    data["review"] = {"created": "2026-08-25T00:00:00"}
    assert claimed_review_not_run(data, "de") == []


def test_naming_the_health_check_alone_is_not_a_claim_of_a_review():
    from prism_lca.engine.report_checks import claimed_review_not_run

    data = _study("Interne Qualitätskontrolle: strukturelle Modellprüfung (Prism Model Health Check).")
    assert claimed_review_not_run(data, "de") == []


def test_denying_a_review_is_not_claiming_one():
    from prism_lca.engine.report_checks import claimed_review_not_run

    for text in (
        "Es fand keine automatisierte Modellreview statt.",
        "No internal review was carried out.",
    ):
        assert claimed_review_not_run(_study(text), "en") == [], text


# --- M1-M5: the acceptance criteria of a prose review, as a test ---------------------
#
# Five measures came out of reading a finished report end to end. Four of the five are prompt work and can
# only be judged on a real run; what CAN be held still is the machinery underneath them, and that is
# what this does. Each assertion names the sentence it keeps out of a client's PDF.

def test_no_plural_hack_survives_in_any_report_language():
    """"Results are reported for 1 unit(s) of the reference product" — the plural hack showing through
    in a delivered document (V254). At an amount of one the count says nothing and is left out."""
    from prism_lca.engine.report_i18n import LANGUAGES, t
    from prism_lca.engine.report_typst import _results_lead

    for lang in LANGUAGES:
        for key in ("lead.results", "lead.results_one", "lead.results_fu", "lead.results_one_fu"):
            assert "(s)" not in t(key, lang, amount="1", fu="x"), (lang, key)
            assert "(es)" not in t(key, lang, amount="1", fu="x"), (lang, key)
            assert "(en)" not in t(key, lang, amount="1", fu="x"), (lang, key)
    # One unit is the ordinary case: the sentence is about the functional unit and prints no count.
    one = _results_lead({"amount": 1.0}, {"functional_unit": "1 m² coated"}, "en")
    assert "1 m² coated" in one and "#strong[" not in one
    # Away from one the count IS the point, and it takes a plain plural.
    ten = _results_lead({"amount": 10.0}, {"functional_unit": "1 m² coated"}, "en")
    assert "#strong[10]" in ten and "units" in ten


def test_the_writer_is_told_what_the_other_chapters_cover():
    """M1. Seven of nine chapters are written blind, so the functional unit was defined five times in
    one document. The plan is what turns "define it again" into "point at chapter 2"."""
    from prism_lca.engine.report_prompts import document_plan

    report = {
        "sections": [
            {"id": "a", "kind": "goal_scope", "order": 0},
            {"id": "b", "kind": "lcia", "order": 1},
        ]
    }
    plan = document_plan(report["sections"][1], report, "en")
    assert [c["covers"] for c in plan["chapters"]][0].startswith("the goal")
    assert plan["chapters"][1]["this_one"] == "yes"
    assert plan["settled_elsewhere"]["functional unit"] == "Goal and scope definition"
    # A chapter is never pointed at itself for a fact it is the one to settle.
    own = document_plan(report["sections"][0], report, "en")
    assert "functional unit" not in own["settled_elsewhere"]


def test_the_brief_carries_the_plan_and_the_register():
    """M1 and M3 reach the writer or they are decoration."""
    from prism_lca.engine.report_prompts import build_brief

    brief = build_brief(
        {"id": "s", "kind": "lcia"},
        {"lang": "en", "sections": [{"id": "s", "kind": "lcia", "order": 0}]},
        {"study": {"functional_unit": "1 m² coated"}},
    )
    assert brief["document_plan"]["chapters"]
    assert "Technical prose, not an essay" in brief["invariants"]
    assert "no rank to name" in brief["invariants"]
    assert "document_plan" in brief["invariants"]


def test_a_chapter_is_not_handed_facts_it_cannot_use():
    """V259. The LCIA chapter's largest single block was the modelling run's research log — a quarter
    of everything it was shown, and useless to it. `review` sat beside it, and since M4.2 a chapter
    that mentions the internal review is refused, so every writer was being handed a trap.

    Conservative on purpose: the gate judges against the full `data`, so trimming the brief can never
    turn a true sentence into a refused one — it can only starve a writer, which is the failure worth
    guarding against. Anything not named in `_SPECIALIST_FACTS` still goes to everyone."""
    from prism_lca.engine.report_prompts import brief_facts

    data = {
        "study": {"goal": "g"},
        "results": [{"method_label": "EF", "score": 1.0}],
        "web_research": [{"question": "q", "findings": []}],
        "review": {"open": [{"finding": "f"}]},
    }
    assert "web_research" not in brief_facts(data, "lcia")
    assert "review" not in brief_facts(data, "lcia")
    # …and the chapters that print or cite them still get them.
    assert "web_research" in brief_facts(data, "references")
    assert "review" in brief_facts(data, "limitations")
    # Everything else reaches every chapter, and a caller that names no kind gets the lot.
    for kind in ("lcia", "conclusions", "inventory", ""):
        assert {"study", "results"} <= set(brief_facts(data, kind)), kind
    assert "review" in brief_facts(data)


def test_the_writer_is_told_when_to_look_something_up():
    """V258: one lookup in a nine-chapter run against an allowance of eight per chapter. The passage
    was three parts discouragement and never named an occasion."""
    import pathlib as _p

    # The writer's messages live beside it since the conversation and the messages were cut out.
    src = _p.Path(__file__).resolve().parents[2] / "frontend/src/main/ai/writer/messages.ts"
    text = src.read_text(encoding="utf-8")
    assert "Look things up before you write" in text
    assert "it is a ceiling, not a target" in text
    # The one restriction that is right stays: a figure from a lookup has no placeholder.
    assert "Do NOT take figures out of a lookup" in text


def test_the_chapters_that_gain_from_a_lookup_are_told_to_make_one():
    """V258, second half. A permission in the system prompt is not an instruction: seven chapters of
    a test run never looked anything up. The four chapters whose job is to explain now name
    the tool and the occasion in their own assignment — and the market case by name, because it is the
    lookup that most improves a report and the least obvious one.

    Evidence that it works: the run's ONE lookup was `get_process_details` on "market for dipropylene
    glycol monomethyl ether", and its `biggest_inputs` showed the whole kilogram coming from a single
    production dataset. That is the best-sourced sentence in the finished report."""
    from prism_lca.engine.report_prompts import DEFAULT_PROMPTS

    for kind in ("inventory", "lcia", "contribution", "prose"):
        prompt = DEFAULT_PROMPTS[kind]
        assert "get_process_details" in prompt or "explain_result" in prompt, kind
    # The market case is spelled out where a dataset is named for the first time, and where the
    # chapter's whole point is what sits behind a group.
    for kind in ("inventory", "contribution"):
        assert "market" in DEFAULT_PROMPTS[kind], kind
    assert "biggest_inputs" in DEFAULT_PROMPTS["inventory"]


def test_a_parameter_is_named_in_words_and_not_by_its_identifier():
    """V261. One run of a wood-stain report had none of these; a later one, with lookups encouraged, had
    eight — `mischen_kwh_pro_kg`, `reichweite_m2_pro_l`, `share_no` in a client's prose. The cause was
    a rule of ours read one word too literally: "name the thing, not the number". The thing is the
    quantity; the identifier is how the software finds it, and the annex table is where it belongs."""
    from prism_lca.engine.report_prompts import _INVARIANTS

    assert "never the parameter" in _INVARIANTS
    # The counter-examples are the part that works — a prohibition without one produced this defect.
    assert "the assumed coverage" in _INVARIANTS
    assert "reichweite_m2_pro_l" in _INVARIANTS


def test_a_long_dataset_name_does_not_turn_the_prose_after_it_into_a_phantom():
    """V262, and the worst kind of defect this gate can have: it refused a chapter for a name nobody
    wrote. The length window was part of the PATTERN, so a quoted span outside it made its pair fail —
    and the scanner then paired that span's closing mark with the next span's opening one, capturing
    the words in between. Measured: "unsaturated hydrocarbons production, steam cracking
    operation, average" is a real ecoinvent name at 70 characters, and the chapter was refused for the
    phantom "at   and the". It also silently lost the real name it was there to check."""
    from prism_lca.engine.report_prompts import check_proposal

    long_name = "unsaturated hydrocarbons production, steam cracking operation, average"
    assert len(long_name) > 60
    text = (
        f'The chain behind it runs through "{long_name}" at {{{{results.0.score}}}} and the '
        '"market for chlorine, gaseous" beside it.'
    )
    data = {
        "results": [{"method_label": "EF", "score": 1.0}],
        "hotspots": [
            {"name": long_name, "database": "e", "code": "a"},
            {"name": "market for chlorine, gaseous", "database": "e", "code": "b"},
        ],
    }
    verdict = check_proposal(text, {"kind": "prose"}, data, "en")
    invented = [f for f in verdict["findings"] if f["kind"] == "unverifiable_claim"]
    assert not invented, invented
    assert verdict["ok"], verdict["findings"]

    # And the check still does its job: a name that is genuinely not in the brief is still reported,
    # including one that sits after a long quoted name.
    made_up = text.replace("market for chlorine, gaseous", "market for unobtainium, gaseous")
    verdict = check_proposal(made_up, {"kind": "prose"}, data, "en")
    assert any("unobtainium" in f["detail"] for f in verdict["findings"]), verdict["findings"]


def test_the_invariants_carry_the_shapes_real_reports_share_and_refuse_the_two_they_must_not():
    """V263/V264, read off four published LCAs (a company's full comparative study and
    an industry association's eco-profile methodology among them).

    V264 was released as "one model paragraph per chapter kind" and is implemented as shapes instead:
    a whole paragraph is a template and would be copied, giving ten reports one sentence rhythm. What
    the real reports share is the MOVE, not the wording.

    The two refusals matter as much as the four shapes. Both appear in published reports and both need
    evidence this study does not have — an everyday equivalent needs a conversion factor nobody gave
    the writer, and a substitution argument needs market research."""
    from prism_lca.engine.report_prompts import _INVARIANTS

    for shape in ("Bound a gap", "Condition a result", "Declare a proxy", "Refuse a comparison"):
        assert shape in _INVARIANTS, shape
    for refused in ("car kilometres", "what consumers would do instead"):
        assert refused in _INVARIANTS, refused
    # And the paragraph budget, which is the other half of the same reading.
    assert "One thought per paragraph, three to six sentences" in _INVARIANTS


def test_the_chapter_prompts_ask_for_what_real_reports_actually_do():
    from prism_lca.engine.report_prompts import DEFAULT_PROMPTS

    # An inventory bounds its gaps and says what a proxy was adjusted for — naming the substitution
    # alone leaves the reader unable to tell an adapted dataset from one taken unchanged.
    assert "Bound a data gap" in DEFAULT_PROMPTS["inventory"]
    assert "ADJUSTED for" in DEFAULT_PROMPTS["inventory"]
    # A results chapter goes whole → parts → what moves it, and explains a trade-off rather than
    # reporting that one exists.
    assert "The order real studies use" in DEFAULT_PROMPTS["lcia"]
    assert "A trade-off is explained, not listed" in DEFAULT_PROMPTS["lcia"]
    # A conclusion is conditioned on what it depends on.
    assert "Condition the conclusion" in DEFAULT_PROMPTS["conclusions"]
    # And a cut-off is named with the examples that fell below it.
    assert "named with its examples" in DEFAULT_PROMPTS["goal_scope"]


def test_the_prompts_carry_what_eight_published_product_lcas_have_in_common():
    """Read off eight product LCAs published by companies and industry associations —
    aluminium cans, corrugated board, an LDPE eco-profile, bottled water, two luminaires, recycled PVC
    and an industry-funded comparative study. Their shared structure, kept only where a PrismLCA model can
    actually supply the content:

    The strongest of them gives its interpretation chapter one section per ISO 14044 data-quality axis,
    which is the element our chapter was missing entirely. The optional ones are marked optional on
    purpose — the point is to get more CONTENT written, not to add obligations that fire empty."""
    from prism_lca.engine.report_prompts import DEFAULT_PROMPTS

    checks = DEFAULT_PROMPTS["interpretation_checks"]
    for axis in ("Completeness", "Representativeness", "Consistency", "Reproducibility"):
        assert axis in checks, axis
    # …and the one thing it must never do, because nothing computed it.
    assert "Never invent a data-quality score" in checks
    assert "Optional, where the report has the evidence" in checks

    # The reference flow beside the functional unit, and coverage only as far as the data reaches.
    scope = DEFAULT_PROMPTS["goal_scope"]
    assert "reference flow" in scope
    # A year is a fact where it was read and an invention where it was not. The first version of this
    # banned years outright, which contradicted two prompts that already ask for them where a note or
    # the metadata records one (`inventory`, `appendix`) — and the writer does have them: a foreground
    # process carries its description, and an opened ecoinvent dataset carries its comment.
    assert "A year is quoted, never inferred" in scope
    assert "background database as a whole" in scope

    # And an inventory may group its background by what it supplies rather than walk the table.
    assert "group " in DEFAULT_PROMPTS["inventory"]


def test_a_writer_is_told_which_chapter_it_is_and_what_stands_around_it():
    """Two things every writer needs and one of them was missing entirely.

    `document_plan` has been built since M1 and was never put in the message — while the invariants
    told the writer that "`document_plan` lists this report's chapters". A rule pointing at a block
    that is not there is worse than no rule. And the chapter announced itself by its internal kind
    ("Chapter: lcia") whenever the section carried no title of its own, which is the normal case."""
    from prism_lca.engine.report_prompts import build_brief

    report = {
        "lang": "en",
        "sections": [
            {"id": "s1", "kind": "goal_scope", "order": 1},
            {"id": "s2", "kind": "lcia", "order": 2},
            {"id": "s3", "kind": "conclusions", "order": 3},
        ],
    }
    brief = build_brief(report["sections"][1], report, {"study": {}})

    # The name it is printed under, never the kind.
    assert brief["title"] and brief["title"] != "lcia"
    plan = brief["document_plan"]
    titles = [c["title"] for c in plan["chapters"]]
    assert brief["title"] in titles
    assert [c for c in plan["chapters"] if c.get("this_one") == "yes"][0]["title"] == brief["title"]
    # And where the framing facts are settled, so it names them instead of defining them again (V256).
    assert plan["settled_elsewhere"]["functional unit"] in titles


def test_a_cause_that_was_read_is_not_treated_like_one_that_was_guessed():
    """A chapter that opened datasets HAS read mechanisms. Telling it that the data can show what is
    large and never why suppresses exactly the sentences the lookups were paid for. What stays true
    either way is the failure mode: a cause read off a share."""
    from prism_lca.engine.report_claims import check_claims

    text = "The share is {{contribution.groups.0.share_text}} because the market has a single supplier."
    data = {
        "contribution": {"groups": [{"name": "Manufacturing", "share_text": "62.0 %", "share_percent": 62.0}]},
    }
    blind = [f for f in check_claims(text, data) if f["kind"] == "unverifiable_claim"]
    looked = [
        f
        for f in check_claims(text, {**data, "looked_up": [{"name": "get_process_details"}] * 4})
        if f["kind"] == "unverifiable_claim"
    ]
    # Both still raise the note — it is advisory and its job is the second read.
    assert blind and looked
    assert "Nothing was looked up" in blind[0]["detail"]
    assert "You opened 4 lookups" in looked[0]["detail"]
    # …and only the second one says the sentence may be legitimate.
    assert "yours to state" in looked[0]["detail"]
    assert "yours to state" not in blind[0]["detail"]


def test_the_placeholder_rule_says_why_it_outranks_the_others():
    """It is the rule this pipeline exists for, and the one that cost two of nine chapters in one run.
    The mechanism was stated in a subordinate clause; the stake was not stated at all."""
    from prism_lca.engine.report_prompts import _INVARIANTS

    assert "re-typeset every time the study is recomputed" in _INVARIANTS
    assert "is not caught, it is shipped" in _INVARIANTS


def _params(*entries):
    """A snapshot with just the parameter list the literal check reads."""
    return {"parameters": [{"name": n, "amount": a, "unit": u} for n, a, u in entries]}


def test_the_gate_repairs_a_literal_it_can_name_instead_of_refusing_the_chapter():
    """V267. The gate worked out that 250 was the value of `gebinde_volumen_l`, wrote the placeholder
    that belonged there into its own message — and threw the chapter away. Two of nine chapters of a
    run died that way, one of them 853 words that were right about everything else."""
    from prism_lca.engine.report_prompts import apply_repairs, check_proposal

    data = _params(("gebinde_volumen_l", 250, "ml"))
    text = "The study assesses the stain in the 250 ml tinplate can."
    verdict = check_proposal(text, {"kind": "goal_scope"}, data)
    assert not verdict["ok"]
    literal = [f for f in verdict["findings"] if f["kind"] == "literal_number"][0]
    assert literal["repair"]["find"] == "250 ml"
    assert literal["repair"]["replace"] == "{{parameters.0.amount}} {{parameters.0.unit}}"

    fixed, applied = apply_repairs(text, verdict["findings"])
    assert fixed == "The study assesses the stain in the {{parameters.0.amount}} {{parameters.0.unit}} tinplate can."
    assert [a["parameter"] for a in applied] == ["gebinde_volumen_l"]
    # …and the repaired text passes, which is the only thing that makes the repair worth anything.
    assert check_proposal(fixed, {"kind": "goal_scope"}, data)["ok"]


def test_no_repair_where_two_parameters_claim_the_same_value_and_unit():
    """A coin toss is not a repair. The value used to be resolved by `setdefault`, so whichever
    parameter came first in the list was named — survivable while this only produced advice."""
    from prism_lca.engine.report_prompts import apply_repairs, check_proposal

    data = _params(("can_mass_g", 42, "g"), ("label_mass_g", 42, "g"))
    text = "The container weighs 42 g."
    verdict = check_proposal(text, {"kind": "inventory"}, data)
    assert not verdict["ok"]
    literal = [f for f in verdict["findings"] if f["kind"] == "literal_number"][0]
    assert "repair" not in literal
    # The message may not name one of the two either.
    assert "is the current value of parameter" not in literal["detail"]
    assert apply_repairs(text, verdict["findings"]) == (text, [])


def test_a_repair_may_re_express_the_unit_and_says_what_it_will_print():
    """The case that motivated all of this: the package volume is stored as 0.25 l and the chapter
    wrote "250 ml". Refusing to touch any form but the stored one would have left exactly the chapter
    that was once lost. The quantity is identical; the wording becomes the parameter's, and
    the advisory finding is where that trade is stated rather than hidden."""
    from prism_lca.engine.report_prompts import apply_repairs, check_proposal

    data = _params(("gebinde_volumen_l", 0.25, "l"))
    text = "The study assesses the stain in the 250 ml tinplate can."
    verdict = check_proposal(text, {"kind": "goal_scope"}, data)
    literal = [f for f in verdict["findings"] if f["kind"] == "literal_number"][0]
    assert literal["repair"]["find"] == "250 ml"
    assert literal["repair"]["prints"] == "0.25 l"
    fixed, applied = apply_repairs(text, verdict["findings"])
    assert "{{parameters.0.amount}} {{parameters.0.unit}}" in fixed
    assert check_proposal(fixed, {"kind": "goal_scope"}, data)["ok"]
    assert applied[0]["prints"] == "0.25 l"


def test_no_repair_into_scientific_notation_or_without_a_unit():
    """A report does not print "4.2e-05 t" in a sentence, and a bare number with no unit beside it is
    not a specific enough match to rewrite on."""
    from prism_lca.engine.report_prompts import apply_repairs, check_proposal

    tiny = _params(("mass_t", 4.2e-05, "t"))
    v = check_proposal("The can weighs 42 g.", {"kind": "inventory"}, tiny)
    assert "repair" not in [f for f in v["findings"] if f["kind"] == "literal_number"][0]
    assert apply_repairs("The can weighs 42 g.", v["findings"])[1] == []

    naked = _params(("count", 250, "piece"))
    v2 = check_proposal("The batch holds 250 of them.", {"kind": "inventory"}, naked)
    for f in v2["findings"]:
        assert "repair" not in f


def test_no_repair_inside_a_quotation():
    """A quoted sentence is somebody else's wording; that is what quoting means."""
    from prism_lca.engine.report_prompts import apply_repairs, check_proposal

    data = _params(("gebinde_volumen_l", 250, "ml"))
    text = 'The data sheet says \u201cfilled to 250 ml at 20 \u00b0C\u201d.'
    verdict = check_proposal(text, {"kind": "inventory"}, data)
    assert apply_repairs(text, verdict["findings"])[1] == []


def test_a_literal_with_no_parameter_behind_it_is_still_refused():
    """The repair exists because the gate knew the answer. Where it does not, nothing changes: there
    is no placeholder to write, and a person has to decide."""
    from prism_lca.engine.report_prompts import apply_repairs, check_proposal

    verdict = check_proposal("Transport covers 450 km.", {"kind": "inventory"}, _params())
    assert not verdict["ok"]
    assert apply_repairs("Transport covers 450 km.", verdict["findings"])[1] == []


def test_a_repair_is_only_applied_where_the_string_occurs_once():
    """Two occurrences mean two sentences, and the check has to see each of them on its own."""
    from prism_lca.engine.report_prompts import apply_repairs, check_proposal

    data = _params(("gebinde_volumen_l", 250, "ml"))
    text = "The 250 ml can is filled. A 250 ml can is also the reference flow."
    verdict = check_proposal(text, {"kind": "goal_scope"}, data)
    fixed, applied = apply_repairs(text, verdict["findings"])
    assert applied == [] and fixed == text
