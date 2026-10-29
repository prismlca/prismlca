"""Derived placeholders: the arithmetic a comparative sentence needs, without the writer doing it.

The gap this closes was measurable. The gate forbids a literal number, and rightly — a figure typed into
prose is frozen the moment it is written. But an LCA sentence *needs* arithmetic ("half of the footprint",
"50 % higher than the baseline"), so the writer either omitted the comparison or calculated it and had the
chapter refused. DeepSeek hit this twice in one evening, both times over a sum of two shares.

Every reproducible-reporting tool lets the document compute — Quarto's inline code, Evidence's SQL. This
is that idea reduced to what a report actually needs: five named derivations over data paths, no
operators, no nesting, nothing user-defined.
"""
from __future__ import annotations

from prism_lca.engine import report_data as rd

DATA = {
    "contribution": {"groups": [{"share_percent": 51.9}, {"share_percent": 41.6}]},
    "subjects": [
        {"label": "Baseline", "results": [{"score": 0.1195}]},
        {"label": "Thicker bag", "results": [{"score": 0.179}]},
    ],
}


def only(text: str) -> str:
    resolved, missing = rd.resolve(text, DATA, "en")
    assert missing == [], missing
    return resolved


def test_a_sum_of_shares_is_a_share_and_says_so():
    """The exact sentence that was refused twice: "the two phases together account for …"."""
    assert only("{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}}") == "93.5 %"


def test_relative_change_reads_as_a_percentage():
    assert only("{{change(subjects.1.results.0.score, subjects.0.results.0.score)}}") == "49.8 %"


def test_percent_of_and_factor_and_difference():
    assert only("{{percent(contribution.groups.0.share_percent, 100)}}") == "51.9 %"
    assert only("{{factor(subjects.1.results.0.score, subjects.0.results.0.score)}}") == "1.50"
    assert only("{{diff(subjects.1.results.0.score, subjects.0.results.0.score)}}") == "0.0595"


def test_a_constant_is_a_valid_argument_only_as_a_unit_conversion():
    """A constant beside a data value used to be allowed anywhere ("X per cent of one bag"), and
    `factor(x, 0.001)` printed a 5 kg result as 5 000 under the heading of a climate impact. Now `factor` takes unit conversions only, and the gate
    checks the unit written after it."""
    assert only("{{factor(subjects.0.results.0.score, 0.001)}}") == "119.50"
    _text, error = rd.derive("factor(subjects.0.results.0.score, 2)", DATA, "en")
    assert error and "unit conversions" in error and "percent(part, whole)" in error


def test_a_derivation_of_constants_alone_is_refused():
    """{{sum(999, 0)}} resolved to 999 against an empty snapshot — a figure with nothing behind it."""
    _text, error = rd.derive("sum(999, 0)", {}, "en")
    assert error and "only constants" in error


def test_a_constant_may_join_shares_but_not_a_mass_or_an_impact():
    _text, error = rd.derive("sum(subjects.0.results.0.score, 5)", DATA, "en")
    assert error and "changes the quantity" in error
    _text, error = rd.derive("percent(subjects.0.results.0.score, 100)", DATA, "en")
    assert error and "not a constant" in error


def test_every_refusal_names_the_next_step():
    for text, expected in [
        ("{{nonsense(a, b)}}", "unknown derivation"),
        ("{{diff(subjects.0.results.0.score)}}", "needs exactly 2"),
        ("{{sum(subjects.0.results.0.score)}}", "at least two"),
        ("{{percent(subjects.0.results.0.score, subjects.0.label)}}", "is not a number"),
        # A share, because a constant beside a mass or an impact is refused earlier.
        ("{{change(contribution.groups.0.share_percent, 0)}}", "divide by zero"),
    ]:
        resolved, missing = rd.resolve(text, DATA, "en")
        assert "[missing:" in resolved
        assert any(expected in m for m in missing), (text, missing)


def test_the_gate_treats_a_derivation_as_a_placeholder_not_as_a_free_number():
    """Otherwise the feature would be unusable: the chapter would be refused for the very placeholder that
    exists to avoid a literal."""
    from prism_lca.engine import report_prompts as rp

    verdict = rp.check_proposal(
        "Together the two phases account for "
        "{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} of the score.",
        {"kind": "prose"},
        {**DATA, "study": {}, "results": []},
    )
    assert verdict["ok"], verdict["findings"]


def test_a_derivation_binds_the_ranked_members_it_reads():
    """A sum over the top two groups has to keep meaning those two groups after a recomputation."""
    text = "{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}}"
    data = {"contribution": {"groups": [{"key": "End of life", "share_percent": 51.9},
                                        {"key": "Raw materials", "share_percent": 41.6}]}}
    bindings = rd.bindings_for(text, data)
    assert bindings == {
        "contribution.groups.0": {"key": "End of life"},
        "contribution.groups.1": {"key": "Raw materials"},
    }


def test_the_writer_is_told_the_derivations_exist():
    from prism_lca.engine import report_prompts as rp

    brief = rp.build_brief({"kind": "prose"}, {"lang": "en"}, {**DATA, "study": {}, "results": []})
    assert set(brief["derivations"]) == {"sum", "diff", "percent", "change", "factor"}
    assert "derivation" in brief["invariants"].lower()


# ---- C3: no aggregation across impact categories -------------------------------------------
_MIXED = {
    "results": [
        {"method_label": "climate change", "score": 0.1195, "unit": "kg CO2-Eq"},
        {"method_label": "energy resources", "score": 1.696, "unit": "MJ-Eq"},
    ],
    "contribution": {
        "unit": "kg CO2-Eq",
        "groups": [
            {"key": "End of life", "value": 0.0619, "share_percent": 56.0},
            {"key": "Raw materials", "value": 0.0413, "share_percent": 37.4},
        ],
    },
}


def test_summing_two_indicators_is_refused_as_a_single_score():
    """The gap this closes: nothing checked the units, so "0.119 + 1.696" was a writable figure —
    a single score, which ISO 14044 does not allow for a comparative assertion."""
    from prism_lca.engine.report_data import derive

    text, error = derive("sum(results.0.score, results.1.score)", _MIXED, "en")
    assert text is None
    assert "kg CO2-Eq" in error and "MJ-Eq" in error and "single score" in error


def test_every_derivation_is_covered_not_only_sum():
    """A percentage of an unlike quantity is as meaningless as a total of one."""
    from prism_lca.engine.report_data import derive

    for name in ("diff", "percent", "change", "factor"):
        _text, error = derive(f"{name}(results.0.score, results.1.score)", _MIXED, "en")
        assert error and "mixes units" in error, name


def test_same_unit_still_works():
    from prism_lca.engine.report_data import derive

    text, error = derive("sum(contribution.groups.0.value, contribution.groups.1.value)", _MIXED, "en")
    assert error is None and text


def test_two_shares_are_dimensionless_and_may_be_added():
    """Shares carry no unit of their own; refusing their sum would break the one arithmetic a
    contribution chapter really needs."""
    from prism_lca.engine.report_data import derive

    text, error = derive(
        "sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)", _MIXED, "en"
    )
    assert error is None and text == "93.4 %"


def test_an_unknown_unit_stays_silent():
    """None means "the data does not say", never "dimensionless" — a check that guesses starts
    refusing correct sentences."""
    from prism_lca.engine.report_data import derive, unit_of

    data = {"a": {"x": 2.0}, "b": {"x": 3.0}}
    assert unit_of("a.x", data) is None
    _text, error = derive("sum(a.x, b.x)", data, "en")
    assert error is None


def test_the_unit_may_come_from_a_container():
    from prism_lca.engine.report_data import unit_of

    assert unit_of("contribution.groups.0.value", _MIXED) == "kg CO2-Eq"
    assert unit_of("results.1.score", _MIXED) == "MJ-Eq"


def test_a_sum_of_two_shares_counts_as_carrying_its_own_percent_sign():
    """The case that produced "6.6 % %" in the sample report: `sum` of two shares prints a sign, and the
    gate has to know it. Both sides now ask the same function instead of re-deriving the rule."""
    from prism_lca.engine.report_data import prints_own_unit

    assert prints_own_unit("sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)")
    assert prints_own_unit("percent(a, b)") and prints_own_unit("change(a, b)")
    assert prints_own_unit("hotspots.0.share_text")
    # A bare number does not — the sentence still owes it a unit.
    assert not prints_own_unit("results.0.score")
    assert not prints_own_unit("contribution.groups.0.share_percent")
    assert not prints_own_unit("sum(results.0.score, results.1.score)")


def test_a_difference_of_two_shares_is_percentage_points_and_prints_no_sign():
    """V168: 60.1 % minus 18.9 % is 41.2 *percentage points*, and printing "%" invited the duplication.

    The writer added the words anyway, because they are the right words, and the document read "sit only
    2.4 % percentage points apart" — twice in an apple-juice run. The bare number leaves the
    unit to the sentence, and the gate then checks that the sentence supplies one.
    """
    from prism_lca.engine.report_data import prints_own_unit

    token = "diff(contribution.groups.0.share_percent, contribution.groups.1.share_percent)"
    assert not prints_own_unit(token)
    assert "%" not in only("{{" + token + "}}")
    assert only("{{" + token + "}}") == "10.3"
    # The sum beside it is unchanged: two shares added together really are a share.
    assert only("{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}}") == "93.5 %"


_HOTSPOT = {
    "results": [{"method_label": "climate change", "score": 0.1195, "unit": "kg CO2-Eq"}],
    "hotspots": [
        {
            "name": "steam production",
            # The process's physical unit — NOT the unit of `direct`, which is an impact score.
            "unit": "kilogram",
            "direct": 0.0619,
            "direct_unit": "kg CO2-Eq",
            "inputs": [{"name": "heat", "impact": 0.03, "impact_unit": "kg CO2-Eq"}],
        }
    ],
    "inventory": {
        "unit": "kg CO2-Eq",
        "flows": [{"flow": "Carbon dioxide, fossil", "unit": "kilogram", "impact": 0.09, "impact_unit": "kg CO2-Eq"}],
    },
}


def test_a_value_with_its_own_unit_key_beats_the_container():
    """A hotspot's `unit` is the process's physical unit; `direct` is an impact score. Reading the
    container's unit refused `percent(hotspots.0.direct, results.0.score)` — same impact category —
    as an ISO single-score violation."""
    from prism_lca.engine.report_data import derive, unit_of

    assert unit_of("hotspots.0.direct", _HOTSPOT) == "kg CO2-Eq"
    assert unit_of("hotspots.0.inputs.0.impact", _HOTSPOT) == "kg CO2-Eq"
    assert unit_of("inventory.flows.0.impact", _HOTSPOT) == "kg CO2-Eq"
    _text, error = derive("percent(hotspots.0.direct, results.0.score)", _HOTSPOT, "en")
    assert error is None


def test_fraction_shares_and_percent_shares_do_not_mix():
    """`share` is 0–1, `share_percent` is 0–100. Labelling both "%" let 0.5 + 30.0 pass as "30.5"."""
    from prism_lca.engine.report_data import derive, unit_of

    data = {"g": [{"share": 0.5, "share_percent": 50.0}, {"share": 0.3, "share_percent": 30.0}]}
    assert unit_of("g.0.share", data) == "share"
    assert unit_of("g.1.share_percent", data) == "%"
    _text, error = derive("sum(g.0.share, g.1.share_percent)", data, "en")
    assert error and "mixes units" in error
    # Same scale still adds up fine.
    _text, error = derive("sum(g.0.share_percent, g.1.share_percent)", data, "en")
    assert error is None


def test_a_derivation_reads_through_the_bindings_like_a_plain_placeholder():
    """A chapter that binds `hotspots.0` keeps deriving from *that* member after the ranking flips.
    Positional lookup here let one sentence print the bound member's share (plain placeholder, bound)
    next to a percentage computed from whoever now occupies index 0 — two members in one sentence."""
    before = {
        "results": [{"score": 10.0}],
        "hotspots": [
            {"name": "incineration", "database": "db", "code": "a", "direct": 6.0},
            {"name": "granulate", "database": "db", "code": "b", "direct": 3.0},
        ],
    }
    text = "{{hotspots.0.name}} carries {{percent(hotspots.0.direct, results.0.score)}}."
    bindings = rd.bindings_for(text, before)
    # The ranking flips: granulate now occupies index 0.
    after = {
        "results": [{"score": 10.0}],
        "hotspots": [
            {"name": "granulate", "database": "db", "code": "b", "direct": 9.0},
            {"name": "incineration", "database": "db", "code": "a", "direct": 6.0},
        ],
    }
    resolved, missing = rd.resolve(text, after, "en", bindings)
    assert missing == [], missing
    assert resolved == "incineration carries 60.0 %."

    # And a bound member that vanished is reported, never replaced by position.
    gone = {"results": [{"score": 10.0}], "hotspots": [{"name": "granulate", "database": "db", "code": "b", "direct": 9.0}]}
    _resolved, missing = rd.resolve("{{percent(hotspots.0.direct, results.0.score)}}", gone, "en", bindings)
    assert missing and "no longer" in missing[0], missing


def test_a_constant_does_not_strip_the_percent_sign_from_a_sum_of_shares():
    """`prints_own_unit` judges the path arguments only; the evaluation used to count the constant too,
    so the gate waved the sentence through as unit-carrying while the document printed a naked number."""
    token = "sum(contribution.groups.0.share_percent, 5)"
    assert rd.prints_own_unit(token) is True
    text, error = rd.derive(token, DATA, "en")
    assert error is None and text is not None and text.endswith("%"), (text, error)


def test_a_preview_of_a_replacement_shows_words_not_typst():
    """V167: the correction dialog promises the sentence "as the document will read it".

    It resolved through the render path, so an italicised dataset name arrived as
    `#emph[packaging glass production, white]` — under a diff that showed the same words in italics
    two lines above. The document still needs the translation; a person reading a dialog does not.
    """
    text = "The bottle — *packaging glass production, white* — carries {{contribution.groups.0.share_percent}}."
    typeset, _ = rd.resolve(text, DATA, "en")
    assert "#emph[packaging glass production, white]" in typeset

    preview, missing = rd.resolve(text, DATA, "en", plain=True)
    assert "#emph[" not in preview
    assert "*packaging glass production, white*" in preview
    assert "51.9" in preview and missing == []


def test_a_preview_names_the_table_a_reference_points_at():
    """V183: the same dialog printed `@t-sensitivity` where the PDF prints "(Table 8)".

    The number is Typst's — counted while it sets the whole document, with a supplement word Typst
    localises itself, and for a figure not computable here at all because the charts are drawn in the
    frontend. So the preview names the table instead of guessing a number that could disagree with the
    document. The render path is the half that must not move: it still emits the label.
    """
    text = "The span is {{contribution.groups.0.share_percent}} ({{ref:t-sensitivity}}), see {{ref:f-heatmap}}."

    typeset, _ = rd.resolve(text, DATA, "en")
    assert "@t-sensitivity" in typeset and "@f-heatmap" in typeset

    preview, missing = rd.resolve(text, DATA, "en", plain=True)
    assert "@" not in preview and missing == []
    assert "the table “Range of the indicators across the computed variants”" in preview
    assert "the figure “Every indicator side by side, as a share of the highest value in its row”" in preview

    # A label nobody named still reads as words: a chapter's own figure has a caption only the
    # renderer can build, and its id is not something to show a reader.
    own, _ = rd.resolve("Drawn in {{ref:f-section-abc-0}}.", DATA, "en", plain=True)
    assert own == "Drawn in the figure."


def test_a_preview_speaks_the_report_language():
    """The dialog stands next to the chapter it corrects, and that chapter is not in English."""
    preview, _ = rd.resolve("Siehe {{ref:t-sensitivity}}.", DATA, "de", plain=True)
    assert preview == "Siehe die Tabelle „Spanne der Indikatoren über die berechneten Varianten“."


def test_a_preview_shows_names_without_the_compiler_s_backslashes():
    """The escaping is for Typst, and a person reading a dialog is not Typst.

    Same fault as the italics of V167, one layer down: `esc` protects `#`, `_` and the rest from the
    compiler, and the preview showed the protection instead of the name.
    """
    data = {"study": {"goal": "PVC_window #1"}}
    text = "{{study.goal}} and {{results.0.method_label}}"

    typeset, _ = rd.resolve(text, data, "en")
    assert "PVC\\_window \\#1" in typeset and "method\\_label" in typeset

    preview, missing = rd.resolve(text, data, "en", plain=True)
    assert "\\" not in preview
    assert "PVC_window #1" in preview
    # A gap keeps naming the path the author wrote — that is what makes it fixable.
    assert "[missing: results.0.method_label]" in preview and missing == ["results.0.method_label"]


def test_the_editor_s_number_view_is_a_preview_too():
    """`explain` feeds the same box under a different button ("Show with the numbers"), so it carries
    the same promise — one fix, not two."""
    parts = rd.explain("See {{ref:t-sensitivity}} for {{study.goal}}.", {"study": {"goal": "PVC_window"}})
    shown = "".join(str(p.get("text") or "") for p in parts)
    assert "@" not in shown and "\\" not in shown
    assert "the table “Range of the indicators across the computed variants”" in shown
    assert "PVC_window" in shown


def test_a_preview_drops_a_code_fence_because_the_page_does():
    """The rule is one sentence: the preview shows what the document will read like.

    A fenced span loses its backticks on the way to the page — so it
    loses them in the preview too. The author's emphasis markers are not the counter-example they
    look like: the page prints *those* words, in italics, which is why they stay (V167).
    """
    text = "drawn from the `{{results.0.method_label}}` family, *as declared*"
    data = {"results": [{"method_label": "EF v3.1"}]}

    typeset, _ = rd.resolve(text, data, "en")
    assert typeset == "drawn from the EF v3.1 family, #emph[as declared]"

    preview, missing = rd.resolve(text, data, "en", plain=True)
    assert "`" not in preview and missing == []
    assert preview == "drawn from the EF v3.1 family, *as declared*"

    # An unpaired backtick is the literal character it probably is — the document escapes it for the
    # compiler and prints one backtick, so the preview shows one backtick.
    loose, _ = rd.resolve("an unpaired ` backtick stays", data, "en", plain=True)
    assert loose == "an unpaired ` backtick stays"


# ---- the same unit is not the same quantity ----------------------------------
_SAME_UNIT = {
    "results": [
        {"method_label": "USEtox / human toxicity, cancer", "score": 2.0, "unit": "CTUh"},
        {"method_label": "USEtox / human toxicity, non-cancer", "score": 3.0, "unit": "CTUh"},
        {"method_label": "IPCC / GWP100", "score": 5.0, "unit": "kg CO2-Eq"},
    ],
    "contribution": {"unit": "CTUh", "groups": [{"key": "A", "value": 1.0, "share_percent": 50.0}, {"key": "B", "value": 1.0, "share_percent": 50.0}]},
    "subjects": [
        {"label": "Base", "results": [{"method_label": "IPCC / GWP100", "score": 5.0, "unit": "kg CO2-Eq"}]},
        {"label": "Alt", "results": [{"method_label": "IPCC / GWP100", "score": 4.0, "unit": "kg CO2-Eq"}]},
    ],
}


def test_two_categories_in_the_same_unit_are_refused_as_a_single_score():
    """Cancer and non-cancer toxicity both print CTUh and were summed to 5 CTUh."""
    from prism_lca.engine.report_data import derive

    _text, error = derive("sum(results.0.score, results.1.score)", _SAME_UNIT, "en")
    assert error and "two impact categories" in error and "cancer" in error
    for name in ("diff", "percent", "change", "factor"):
        _t, error = derive(f"{name}(results.0.score, results.1.score)", _SAME_UNIT, "en")
        assert error and "two impact categories" in error, name


def test_the_same_category_across_subjects_and_the_leading_indicators_views_still_combine():
    from prism_lca.engine.report_data import derive

    text, error = derive("change(subjects.1.results.0.score, subjects.0.results.0.score)", _SAME_UNIT, "en")
    assert error is None and text
    # The flat contribution view belongs to the first result; its groups combine with that result.
    text, error = derive("percent(contribution.groups.0.value, results.0.score)", _SAME_UNIT, "en")
    assert error is None and text
    # …and with another result it is a mix of categories, whatever the units say.
    _t, error = derive("percent(contribution.groups.0.value, results.1.score)", _SAME_UNIT, "en")
    assert error and "two impact categories" in error
    # Shares stay exempt, as before.
    text, error = derive("sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)", _SAME_UNIT, "en")
    assert error is None and text == "100.0 %"
