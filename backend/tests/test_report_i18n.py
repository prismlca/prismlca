from __future__ import annotations

from prism_lca.engine import report_data as rd
from prism_lca.engine import report_i18n as i18n


def test_number_separators_follow_the_language():
    assert i18n.fmt_number(1234.56, "en", digits=2) == "1,234.56"
    assert i18n.fmt_number(1234.56, "de", digits=2) == "1.234,56"
    assert i18n.fmt_number(1234.56, "es", digits=2) == "1.234,56"
    assert i18n.fmt_number(1234.56, "pt", digits=2) == "1.234,56"
    # French uses a narrow no-break space as the thousands separator.
    assert i18n.fmt_number(1234.56, "fr", digits=2) == "1 234,56"


def test_the_two_separators_cannot_overwrite_each_other():
    """Naive chained replaces turn 1,234.56 into 1.234.56 — the bug this formatting guards against."""
    assert i18n.fmt_number(1234567.8, "de", digits=1) == "1.234.567,8"


def test_scientific_notation_keeps_only_the_decimal_mark():
    # Two mantissa digits: an LCA figure of that size does not support four, and the inventory table is
    # full of them.
    assert i18n.fmt_number(0.000012345, "de") == "1,23e-05"
    assert i18n.fmt_number(0.000012345, "en") == "1.23e-05"
    assert i18n.fmt_number(0, "de") == "0"


def test_every_language_has_every_string():
    keys = set(i18n._STRINGS["en"])
    for lang in i18n.LANGUAGES:
        missing = keys - set(i18n._STRINGS[lang])
        assert not missing, f"{lang} is missing: {sorted(missing)}"


def test_language_tags_are_normalised_and_unknown_ones_fall_back():
    assert i18n.normalise("de-DE") == "de" and i18n.normalise("PT_br") == "pt"
    assert i18n.normalise("kl") == "en" and i18n.normalise(None) == "en"
    assert i18n.t("lcia.title", "de") == "Wirkungsabschätzung"
    assert i18n.t("lcia.title", "kl") == "Life cycle impact assessment"
    assert i18n.t("no.such.key", "de") == "no.such.key"  # visible, not empty


def test_placeholders_resolve_and_localise():
    data = {"results": [{"score": 1234.5, "unit": "kg CO2-eq"}], "study": {"goal": "PCF"}}
    out, missing = rd.resolve("Total {{results.0.score}} {{results.0.unit}} for {{study.goal}}.", data, "de")
    assert missing == []
    # German gets the thousands separator too, which is the whole point of localising here. Three
    # significant digits, so 1234.5 prints as "1.234" — not "1.234,5": one precision rule for every
    # magnitude, or a table and the sentence above it disagree about how exact the study is.
    assert "1.234" in out and "kg CO2-eq" in out and "PCF" in out


def test_a_cross_reference_becomes_a_typst_label():
    out, missing = rd.resolve("See {{ref:t-lcia}} for the numbers.", {}, "en")
    assert out == "See @t-lcia for the numbers." and missing == []


def test_an_unresolved_placeholder_is_visible_and_reported():
    out, missing = rd.resolve("Value: {{results.9.score}}", {"results": []}, "en")
    assert missing == ["results.9.score"]
    assert "[missing: results.9.score]" in out


def test_resolved_text_is_escaped_so_data_cannot_inject_markup():
    data = {"study": {"goal": "Compare #A with *B*"}}
    out, _ = rd.resolve("{{study.goal}}", data, "en")
    assert out == "Compare \\#A with \\*B\\*"


def test_lookup_walks_dicts_and_lists_and_refuses_nonsense():
    data = {"a": {"b": [{"c": 5}]}}
    assert rd.lookup("a.b.0.c", data) == 5
    assert rd.lookup("a.b.7.c", data) is None
    assert rd.lookup("a.b.x.c", data) is None
    assert rd.lookup("a.b.0.c.d", data) is None


def test_build_data_sorts_contribution_by_magnitude_and_exposes_the_top_group():
    lcia = {
        "activity": {"name": "bottle", "database": "m", "code": "c"},
        "amount": 2.0,
        "results": [{"method": ["IPCC", "GWP"], "unit": "kg CO2-eq", "score": 1.5}],
    }
    contribution = {
        "meta": {"unit": "kg CO2-eq"},
        "aggregation": {"dimension": "Phase", "groups": [
            {"key": "Use", "impact": 0.2, "share": 0.13},
            {"key": "Production", "impact": 1.3, "share": 0.87},
        ]},
    }
    data = rd.build_data({"goal": "g"}, lcia, contribution)
    assert data["contribution"]["top"]["key"] == "Production"
    assert [g["key"] for g in data["contribution"]["groups"]] == ["Production", "Use"]
    assert data["first_result"]["score"] == 1.5
    assert data["amount"] == 2.0
    # Percentages are precomputed so prose can say "{{contribution.top.share_percent}} %".
    assert round(data["contribution"]["groups"][0]["share_percent"], 1) == 87.0


def test_placeholder_prose_compiles_after_resolution():
    from prism_lca.engine import report_model as rm
    from prism_lca.engine import typst_render

    text, missing = rd.resolve(
        "The total is {{results.0.score}} {{results.0.unit}}; see {{ref:t-x}}.",
        {"results": [{"score": 0.5, "unit": "kg CO2-eq"}]},
        "de",
    )
    assert missing == []
    body = rm.render_blocks([
        rm.prose(text),
        rm.table(["A", "B"], [["x", "1"]], caption="C", label="t-x"),
    ])
    sources = {
        "template.typ": typst_render.template_source(),
        "main.typ": '#import "template.typ": *\n#show: lca-report-template.with(title: "T")\n\n' + body,
    }
    assert typst_render.compile_pdf(sources).startswith(b"%PDF")


def test_the_template_does_not_hardcode_figure_supplements():
    """Typst localises "Table"/"Figure" from text(lang:) — but only if we do not pass a supplement.
    Hardcoding one silently defeated the entire language setting, producing "Table 1" in a German
    report. Guard against the regression at the source."""
    from prism_lca.engine import typst_render

    template = typst_render.template_source()
    assert "supplement:" not in template


def test_the_assembler_translates_headings_and_labels_but_not_identifiers():
    from prism_lca.engine import report_model as rm
    from prism_lca.engine import report_typst as rt

    lcia = {
        "activity": {"name": "bottle", "database": "m", "code": "c"},
        "amount": 1.0,
        "results": [{"method": ["IPCC 2021", "climate change"], "unit": "kg CO2-eq", "score": 1.0}],
    }
    de = rm.render_blocks(rt.lcia_blocks(lcia, {"functional_unit": "1 Flasche"}, "de"))
    assert "Wirkungsabschätzung" in de and "Einheit" in de
    # Method names and units are identifiers — translating them would destroy traceability.
    assert "IPCC 2021 / climate change" in de and "kg CO2-eq" in de


def test_every_supported_language_produces_a_pdf():
    from prism_lca.engine import report_i18n, report_typst, typst_render
    from prism_lca.engine import report_model as rm

    lcia = {
        "activity": {"name": "x", "database": "d", "code": "c"},
        "amount": 1.0,
        "results": [{"method": ["m"], "unit": "kg", "score": 1.5}],
    }
    for lang in report_i18n.LANGUAGES:
        blocks = report_typst.goal_scope_blocks({"goal": "g"}, lang) + report_typst.lcia_blocks(lcia, {"goal": "g"}, lang)
        blocks = blocks or [rm.heading("g")]
        pdf = typst_render.compile_pdf(report_typst.wrap_document(blocks, title="g", lang=lang))
        assert pdf.startswith(b"%PDF"), lang


def test_one_precision_rule_across_magnitudes():
    """Three significant digits whatever the size — and no slide into exponent notation on the way.

    Both halves were real defects. Six digits above 1 and four below meant a contribution table read
    "0.549" while the sentence above it read "1.16081 kg CO2-Eq", claiming a precision the inputs (typical
    masses, estimated split rates) cannot carry. And "%.3g", the obvious fix, prints 1234.5 as "1.23e+03",
    turning an ordinary four-digit number into physics.
    """
    assert i18n.fmt_number(1.16081, "en") == "1.16"
    assert i18n.fmt_number(0.549, "en") == "0.549"
    assert i18n.fmt_number(0.0023456, "en") == "0.00235"
    assert i18n.fmt_number(1234.5, "en") == "1,234"
    assert i18n.fmt_number(167.0, "en") == "167"
    assert i18n.fmt_number(0, "en") == "0"
    # Outside the fixed range the scientific branch still owns the format.
    assert "e" in i18n.fmt_number(0.000012345, "en")
    assert "e" in i18n.fmt_number(123456.0, "en")
    # An explicit `digits` still wins — callers that need a percentage with one decimal have one.
    assert i18n.fmt_number(47.3456, "en", digits=1) == "47.3"


def test_indicators_in_one_table_are_formatted_each_on_its_own():
    """The single-subject results table has one row per indicator, each in its own unit. Formatting the
    score column with shared decimals took its precision from the largest magnitude in it, so a study
    reporting climate change 1.16 kg CO2-Eq beside land use 167 points printed the climate figure as "1".
    Sharing decimals is right when a column is one unit — a contribution table — and damage when it is not.
    """
    from prism_lca.engine import report_typst as rt

    lcia = {
        "activity": {"name": "juice", "database": "m", "code": "c"},
        "amount": 1.0,
        "results": [
            {"method": ["EF v3.1", "climate change"], "unit": "kg CO2-Eq", "score": 1.16081},
            {"method": ["EF v3.1", "water use"], "unit": "m3", "score": 0.347},
            {"method": ["EF v3.1", "land use"], "unit": "points", "score": 167.0},
        ],
    }
    text = str(rt.lcia_blocks(lcia, {}, "en"))
    assert "1.16" in text
    assert "0.347" in text
    assert "167" in text


def test_two_authors_get_the_plural_label_in_every_language():
    """A cover reading "Author: Jane Doe, John Smith" is wrong in all five languages, and the four
    non-English ones are where nobody would notice."""
    from prism_lca.engine.report_i18n import LANGUAGES, t
    from prism_lca.engine.report_typst import wrap_document

    for lang in LANGUAGES:
        one = wrap_document([], title="T", study={"author": "Jane Doe"}, lang=lang)["main.typ"]
        many = wrap_document([], title="T", study={"author": "Jane Doe, John Smith"}, lang=lang)["main.typ"]
        assert f'("{t("field.author", lang)}", "Jane Doe")' in one, lang
        assert f'("{t("field.authors", lang)}", "Jane Doe, John Smith")' in many, lang
        # A language that has not been given a plural would silently fall back to English.
        assert t("field.authors", lang) != "field.authors", lang


def test_the_plural_errs_towards_one_author():
    """The field is free text, so this is a judgement call every time. A surname-first name must not
    become two people; a semicolon or a conjunction must not stay one."""
    from prism_lca.engine.report_i18n import is_plural_authors

    assert not is_plural_authors("Jane Doe")
    assert not is_plural_authors("Doe, Jane")  # one person, surname first
    assert not is_plural_authors("")
    assert not is_plural_authors("Alexander Sandell")  # the "and" inside a word must not count
    assert is_plural_authors("Jane Doe, John Smith")
    assert is_plural_authors("A. Müller; B. Schmidt")
    assert is_plural_authors("Jonas Harth und Anna Beispiel")
    assert is_plural_authors("Jane Doe & John Smith")


def test_a_column_of_small_scores_does_not_zero_out():
    """A column whose largest value sits below 1e-3 used to hit the four-decimal cap and print every cell
    as "0.0000" — an ODP column (kg CFC-11-Eq, typically 1e-7…1e-5) showed three genuinely different
    variants as three zeros. Such columns fall back to per-value scientific formatting instead."""
    texts = i18n.fmt_column([2.4e-6, 3.1e-6, 8.9e-6], "en")
    assert all("e" in t for t in texts), texts
    assert len(set(texts)) == 3, texts
    # The decade just above still fell to a single significant digit under the cap.
    texts = i18n.fmt_column([2.4e-4, 8.9e-4], "en")
    assert all("e" in t for t in texts), texts
    # From 1e-3 upwards the shared-decimals rule keeps working exactly as before.
    assert i18n.fmt_column([0.12, 0.044], "en") == ["0.120", "0.044"]


def test_a_compound_surname_is_one_author():
    """"Costa e Silva" is one Portuguese author; the conjunction only counts between two full names."""
    assert i18n.is_plural_authors("Costa e Silva") is False
    assert i18n.is_plural_authors("Maria Costa e João Silva") is True
    assert i18n.is_plural_authors("Doe & Smith") is True  # nobody writes one name with an ampersand
    assert rd.render_value(True, "de") == "ja"
    assert rd.render_value(False, "pt") == "não"


# --- V192: what a chapter is called when nobody has named it ------------------------------------


def test_an_unnamed_chapter_is_called_what_the_document_calls_it():
    """A chapter carries a title only once somebody renames it, and that is the normal case: across
    eight runs of the mass test not one chapter had its own title. Interpolating the raw field wrote
    "Section '' is frozen" into four refusals (V192), so the name falls back to the standard heading
    the kind prints in the document — never the empty string, never the internal slug."""
    assert i18n.chapter_name({"kind": "interpretation_checks", "title": ""}) == "Interpretation checks"
    assert i18n.chapter_name({"kind": "contribution"}) == "Contribution analysis"
    # `inventory` and `lci.title`: the kind and the string key are two names for the same chapter,
    # which is why this cannot be an f-string over the kind.
    assert i18n.chapter_name({"kind": "inventory", "title": ""}) == "Life cycle inventory"


def test_a_renamed_chapter_keeps_its_own_name():
    assert i18n.chapter_name({"kind": "lcia", "title": "Results"}) == "Results"
    # Whitespace is not a name: a title of blanks would put an invisible chapter in the message.
    assert i18n.chapter_name({"kind": "lcia", "title": "   "}) == "Life cycle impact assessment"
    assert i18n.chapter_name({"kind": "lcia", "title": "  Results "}) == "Results"


def test_a_kind_nobody_has_named_yet_falls_back_to_its_slug():
    """The last link of the chain says *something*: a kind this build does not know is still better
    named by its slug than by nothing at all."""
    assert i18n.chapter_name({"kind": "plan_b", "title": ""}) == "plan_b"
    assert i18n.kind_title("plan_b") == "plan_b"
    assert i18n.chapter_name({}) == ""


def test_every_shipped_chapter_kind_has_a_name_in_every_language():
    """The guard that keeps the fallback honest: a new kind added without a table entry would reach a
    user as a raw slug, and a mistyped key would print "checks.title" as a heading."""
    from prism_lca.engine.report_store import DETERMINISTIC_KINDS, PROSE_KINDS

    for kind in DETERMINISTIC_KINDS + PROSE_KINDS:
        assert kind in i18n.KIND_TITLES, kind
        for lang in i18n.LANGUAGES:
            name = i18n.kind_title(kind, lang)
            assert name and name != i18n.KIND_TITLES[kind], (kind, lang, name)


def test_the_interface_gets_english_even_for_a_german_report():
    """Two audiences, two languages: the heading is printed in the report's language, the refusal that
    names the chapter is interface text and stays English. The default is the interface one, so a
    message cannot pull the report language in by forgetting an argument."""
    section = {"kind": "provenance", "title": ""}
    assert i18n.chapter_name(section) == "Reproducibility"
    assert i18n.chapter_name(section, "de") == "Reproduzierbarkeit"


def test_a_draft_says_so_on_every_page_in_its_own_language():
    from prism_lca.engine.report_typst import wrap_document

    main = wrap_document([], title="T", lang="de", draft=True)["main.typ"]
    stamp = main.index("#set page(foreground:")
    # Before the template, so no theme has to know about it — and in the report's language.
    assert stamp < main.index("#show: lca-report-template")
    assert '"ENTWURF"' in main
    assert "foreground" not in wrap_document([], title="T", lang="de")["main.typ"]
