"""A typed figure the document prints exactly becomes its placeholder; a near one is named (V460)."""

from __future__ import annotations

import copy

from prism_lca.engine import report_printed
from prism_lca.engine.report_numbers import apply_repairs
from prism_lca.engine.report_prompts import build_brief, check_proposal

DATA = {
    "study": {"goal": "Badreiniger", "functional_unit": "1 Flasche"},
    "results": [
        {"method_label": "EF 3.1 / climate change", "unit": "kg CO2-Eq", "score": 1.234},
        {"method_label": "EF 3.1 / acidification", "unit": "mol H+-Eq", "score": 0.00456},
        {"method_label": "EF 3.1 / water use", "unit": "m3 world eq. deprived", "score": 102795.3},
    ],
    "contribution": {
        "unit": "kg CO2-Eq",
        "groups": [
            {
                "key": "Verpackung",
                "label": "Verpackung",
                "share": 0.548,
                "share_percent": 54.8,
                "share_text": "54,8 %",
            },
            {
                "key": "Transport",
                "label": "Transport",
                "share": 0.12,
                "share_percent": 12.0,
                "share_text": "12,0 %",
            },
            {
                "key": "Rezeptur",
                "label": "Rezeptur",
                "share": 0.12,
                "share_percent": 12.0,
                "share_text": "12,0 %",
            },
        ],
    },
    "activity": {"name": "Badreiniger", "database": "m", "code": "bottle"},
    "subjects": [
        {
            "label": "Basis",
            "code": "bottle",
            "scenario": "",
            "results": [
                {"method_label": "EF 3.1 / climate change", "unit": "kg CO2-Eq", "score": 1.234}
            ],
        },
        {
            "label": "Nachfüllbeutel",
            "code": "pouch",
            "scenario": "",
            "results": [
                {"method_label": "EF 3.1 / climate change", "unit": "kg CO2-Eq", "score": 0.987}
            ],
            "change_text": "-4,2 %",
        },
    ],
    "parameters": [],
    "report": {"significance_percent": 5.0, "significance_text": "5 %"},
}

PROSE = {"kind": "prose"}


def _literals(text: str, data: dict = DATA) -> list[dict]:
    verdict = check_proposal(text, PROSE, data, "de")
    return [f for f in verdict["findings"] if f["kind"] == "literal_number"]


def test_a_result_typed_exactly_as_printed_is_replaced_by_its_placeholder():
    text = "Die Herstellung einer Flasche verursacht 1,23 kg CO2-Äq."
    found = _literals(text)
    assert found[0]["repair"]["replace"] == "{{results.0.score}} kg"
    fixed, applied = apply_repairs(text, found)
    assert fixed == "Die Herstellung einer Flasche verursacht {{results.0.score}} kg CO2-Äq."
    assert applied[0]["path"] == "results.0.score"
    assert not _literals(fixed)


def test_a_share_typed_exactly_takes_its_percent_sign_along():
    text = "Die Verpackung trägt 54,8 % bei."
    found = _literals(text)
    assert found[0]["repair"]["replace"] == "{{contribution.groups.0.share_text}}"
    fixed, _ = apply_repairs(text, found)
    assert fixed == "Die Verpackung trägt {{contribution.groups.0.share_text}} bei."
    assert not _literals(fixed)


def test_two_values_that_print_the_same_are_a_choice_not_a_repair():
    found = _literals("Transport und Rezeptur tragen je 12,0 % bei.")
    assert "repair" not in found[0]
    assert "{{contribution.groups.1.share_text}} (Transport)" in found[0]["detail"]
    assert "{{contribution.groups.2.share_text}} (Rezeptur)" in found[0]["detail"]


def test_two_paths_to_one_value_are_no_ambiguity():
    """The report's own activity assessed as a variant is `results`: one score under two paths."""
    found = _literals("Die Basis liegt bei 1,23 kg CO2-Äq.")
    assert found[0]["repair"]["path"] == "results.0.score"


def test_a_variant_that_equals_the_baseline_today_is_a_second_candidate():
    """Bound to the baseline, the variant's sentence would follow the baseline once the two part."""
    data = copy.deepcopy(DATA)
    data["subjects"][1]["results"][0]["score"] = 1.234
    found = _literals("Der Nachfüllbeutel liegt bei 1,23 kg CO2-Äq.", data)
    assert "repair" not in found[0]
    assert (
        "{{subjects.1.results.0.score}}" in found[0]["detail"]
        and "{{results.0.score}}" in found[0]["detail"]
    )


def test_only_the_whole_unit_binds_a_result():
    """A mass, or another impact, that shares the figure and the leading "kg" is not the climate result."""
    assert "repair" not in _literals("Die Flasche wiegt 1,23 kg.")[0]
    assert "repair" not in _literals("Die Emission beträgt 1,23 kg SO2-Äq.")[0]
    for written in ("1,23 kg CO2-Äq.", "1,23 kg CO₂-Äquivalente", "1,23 kg CO2e"):
        assert (
            _literals(f"Das Ergebnis sind {written} je Flasche.")[0]["repair"]["path"]
            == "results.0.score"
        )


def test_no_repair_without_the_values_own_unit():
    assert "repair" not in _literals("Der Wert liegt bei 1,23 MJ.")[0]
    no_unit = _literals("Der Wert 1,23 ist das Ergebnis.")
    assert "repair" not in no_unit[0]
    assert "{{results.0.score}}" in no_unit[0]["detail"]


def test_no_repair_inside_a_quotation_or_in_scientific_notation():
    quoted = _literals("Die Quelle schreibt „1,23 kg CO2-Äq. je Flasche“.")
    assert quoted and "repair" not in quoted[0]
    scientific = _literals("Der Wasserverbrauch beträgt 1,03e+05 m3.")
    assert "repair" not in scientific[0]
    assert "{{results.2.score}}" in scientific[0]["detail"]


def test_a_rounded_raw_or_unsigned_figure_is_named_never_replaced():
    rounded = _literals("Die Verpackung trägt rund 55 % bei.")
    assert "repair" not in rounded[0]
    assert (
        "{{contribution.groups.0.share_text}} (Verpackung) prints “54,8 %”" in rounded[0]["detail"]
    )
    raw = _literals("Der Wasserverbrauch beträgt 102795 m3.")
    assert "repair" not in raw[0] and "{{results.2.score}}" in raw[0]["detail"]
    unsigned = _literals("Der Nachfüllbeutel liegt 4,2 % niedriger.")
    assert "repair" not in unsigned[0]
    assert "{{subjects.1.change_text}} (Nachfüllbeutel) prints “-4,2 %”" in unsigned[0]["detail"]


def test_the_threshold_is_refused_with_its_own_placeholder_and_never_bound():
    found = _literals("Unterschiede unter 5 % gelten als nicht belastbar.")
    assert "repair" not in found[0]
    assert "{{report.significance_text}}" in found[0]["detail"]
    assert "significance threshold" in found[0]["detail"]
    # Written with the placeholder, the sentence passes.
    assert not _literals(
        "Unterschiede unter {{report.significance_text}} gelten als nicht belastbar."
    )


def test_a_value_two_parameters_hold_is_no_ground_for_a_substitution():
    """Two parameters at 54.8 % and a share printing 54,8 %: whichever is meant, it is a choice."""
    data = copy.deepcopy(DATA)
    assert _literals("Die Verpackung trägt 54,8 % bei.", data)[0]["repair"]
    data["parameters"] = [
        {"name": "recycling_rate", "amount": 54.8, "unit": "%"},
        {"name": "reuse_rate", "amount": 54.8, "unit": "%"},
    ]
    contested = _literals("Die Verpackung trägt 54,8 % bei.", data)
    assert contested and "repair" not in contested[0]


def test_a_figure_that_occurs_twice_is_left_to_the_writer():
    text = "Erst 54,8 % hier, dann 54,8 % dort."
    fixed, applied = apply_repairs(text, _literals(text))
    assert applied == [] and fixed == text


def test_the_index_leaves_out_parameters_and_research():
    data = {
        **DATA,
        "parameters": [{"name": "p", "amount": 0.5, "unit": "kg"}],
        "web_research": [{"x": 3.5}],
    }
    paths = {e.path for e in report_printed.index(data, "de")}
    assert "results.0.score" in paths and "report.significance_text" in paths
    assert not any(p.startswith(("parameters", "web_research")) for p in paths)


def test_the_brief_shows_figures_as_printed_and_names_the_threshold_placeholder():
    data = {**DATA, "subjects": DATA["subjects"]}
    report = {"lang": "de", "options": {"significance_percent": 5}, "sections": []}
    brief = build_brief({"id": "s", "kind": "prose"}, report, data)
    groups = brief["facts"]["contribution"]["groups"]
    assert groups[0]["share"] == "0,548" and groups[0]["share_text"] == "54,8 %"
    assert brief["facts"]["results"][2]["score"] == "1,03e+05"
    assert any("{{report.significance_text}}" in c and "“5 %”" in c for c in brief["cautions"])


def test_the_baselines_share_in_a_breakdown_per_variant_is_the_breakdowns_own():
    from prism_lca.engine.report_data import variant_key

    data = copy.deepcopy(DATA)
    groups = copy.deepcopy(DATA["contribution"]["groups"])
    data["contributions"] = [
        {
            "method_label": "EF 3.1 / climate change",
            "groups": groups,
            "subjects": [
                {
                    "label": "Basis",
                    "variant": variant_key("bottle", ""),
                    "groups": copy.deepcopy(groups),
                },
                {
                    "label": "Nachfüllbeutel",
                    "variant": variant_key("pouch", ""),
                    "groups": [
                        {**groups[1], "share": 0.3, "share_percent": 30.0, "share_text": "30,0 %"}
                    ],
                },
            ],
        }
    ]
    found = _literals("Die Verpackung trägt 54,8 % bei.", data)
    assert found[0]["repair"]["path"] == "contribution.groups.0.share_text"


def test_a_denominator_the_value_does_not_have_is_another_quantity():
    assert "repair" not in _literals("Das sind 1,23 kg CO2-Äq./kg Produkt.")[0]
