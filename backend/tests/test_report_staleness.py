"""Telling apart the ways a written chapter goes out of date."""
from __future__ import annotations

from prism_lca.engine import report_staleness as rs


def _data(
    packaging=60.0,
    raw=30.0,
    score=1.5,
    method="EF v3.1 / climate change / GWP100",
    amount=1.0,
    activity=("apple juice production", "abc"),
):
    return {
        "study": {"functional_unit": "1 L"},
        # What the numbers below were computed from and with: the reference dataset and the multiplier.
        "activity": {"name": activity[0], "code": activity[1], "database": "juice"},
        "amount": amount,
        "results": [{"method_label": method, "score": score, "unit": "kg CO2-Eq"}],
        "contribution": {
            "groups": [
                {"key": "Packaging", "share_percent": packaging},
                {"key": "Raw materials", "share_percent": raw},
            ]
        },
    }


def _report(
    methods=None,
    aggregate_by="tag:Life-cycle phase",
    lang="en",
    amount=1.0,
    code="abc",
    significance=None,
):
    report = {
        "methods": methods or [["EF v3.1", "climate change", "GWP100"]],
        "subjects": [{"label": "Baseline", "code": code}],
        "amount": amount,
        "aggregate_by": aggregate_by,
        "lang": lang,
    }
    if significance is not None:
        report["options"] = {"significance_percent": significance}
    return report


TEXT = (
    "Packaging dominates the balance with {{contribution.groups.0.share_percent}} %, "
    "against {{contribution.groups.1.share_percent}} % for raw materials. "
    "The total is {{results.0.score}} {{results.0.unit}}."
)
BINDINGS = {
    "contribution.groups.0": {"key": "Packaging"},
    "contribution.groups.1": {"key": "Raw materials"},
    "results.0": {"method_label": "EF v3.1 / climate change / GWP100"},
}


def _section(text=TEXT, bindings=None, based_on=None):
    return {"id": "s1", "kind": "prose", "text": text, "bindings": bindings or BINDINGS,
            "based_on": based_on}


def test_cited_paths_include_derivation_arguments():
    text = "{{results.0.score}} and {{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}}"
    assert rs.cited_paths(text) == [
        "contribution.groups.0.share_percent",
        "contribution.groups.1.share_percent",
        "results.0.score",
    ]


def test_a_chapter_that_cites_nothing_is_never_numerically_stale():
    """goal_scope has no placeholders — the old whole-dataset hash called it stale anyway."""
    section = _section(text="This study assesses one litre of apple juice.", bindings={})
    before = rs.components(section["text"], {}, _report(), _data())
    section["based_on"] = before

    found = rs.verdicts(section, _report(), _data(packaging=5.0, raw=80.0, score=99.0))
    assert found == []


def test_numbers_moving_alone_needs_nothing():
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    # 60.2 stays in the same band as 60.0 and keeps its sign.
    found = rs.verdicts(section, _report(), _data(packaging=60.2, raw=30.1))
    assert [f["kind"] for f in found] == ["values"]
    assert rs.worst(found) == "none"


def test_a_share_leaving_its_band_asks_for_a_look():
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    found = rs.verdicts(section, _report(), _data(packaging=12.0))
    bands = [f for f in found if f["kind"] == "bands"]
    assert bands and bands[0]["severity"] == "review"
    assert ">50 %" in bands[0]["message"] and "5–20 %" in bands[0]["message"]
    assert rs.worst(found) == "review"


def test_a_sign_flip_is_reported_even_inside_one_band():
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    found = rs.verdicts(section, _report(), _data(packaging=-60.0))
    assert any(f["kind"] == "bands" and "direction" in f["message"] for f in found)


def test_a_path_that_lost_its_band_does_not_break_the_check():
    """A stored band against a path that is no longer a share: KeyError took the whole check down."""
    based_on = rs.components(TEXT, BINDINGS, _report(), _data())
    based_on["bands"]["results.0.score"]["band"] = ">50 %"  # stored when the path still read as a share
    section = _section(based_on=based_on)
    found = rs.verdicts(section, _report(), _data())
    assert not [f for f in found if f["kind"] == "bands"]


def test_a_ranking_swap_asks_for_a_look_but_not_a_rewrite():
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    swapped = _data()
    swapped["contribution"]["groups"] = [
        {"key": "Raw materials", "share_percent": 55.0},
        {"key": "Packaging", "share_percent": 35.0},
    ]
    found = rs.verdicts(section, _report(), swapped)
    ranks = [f for f in found if f["kind"] == "ranks"]
    assert ranks, found
    assert "rank 1" in ranks[0]["message"] and "rank 2" in ranks[0]["message"]
    assert all(f["severity"] != "rewrite" for f in found)


def test_a_vanished_binding_needs_a_rewrite():
    """The sentence points at something that is not in the data any more — it renders as a hole."""
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    gone = _data(method="CML v4.8 2016 / acidification / AP")
    found = rs.verdicts(section, _report(), gone)
    members = [f for f in found if f["kind"] == "members"]
    assert members and members[0]["severity"] == "rewrite"
    assert "no longer exists" in members[0]["message"]
    assert rs.worst(found) == "rewrite"


def test_a_binding_the_text_no_longer_reads_is_not_a_finding():
    """Hand-editing does not rewrite a chapter's bindings, so orphans outlive the sentence.

    Written by the writer, then edited by the author: the sentence about the second group is gone,
    its binding is not. Without the citation filter that orphan reports "points at something that no
    longer exists" for ever — a permanent badge, and "Write all" rewriting a chapter that is fine.
    """
    edited = "The total is {{results.0.score}} {{results.0.unit}}."
    section = _section(text=edited, based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    # Both contribution groups are gone from the data; only the one the text still reads may speak.
    gone = _data()
    gone["contribution"]["groups"] = [{"key": "Transport", "share_percent": 90.0}]
    found = rs.verdicts(section, _report(), gone)
    assert [f["kind"] for f in found if f["kind"] == "members"] == []
    assert rs.worst(found) == "none"

    # …and the same binding still speaks while the sentence is there.
    still = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    assert any(f["kind"] == "members" for f in rs.verdicts(still, _report(), gone))


def test_an_orphaned_binding_is_left_out_of_the_stored_ranks():
    # Only the cited binding keeps a rank — groups.1 is orphaned. `results.0` would be cited here too,
    # but results is structure-ordered (method order), so no rank is recorded for it at all.
    edited = "Packaging carries {{contribution.groups.0.share_percent}} % of {{results.0.score}}."
    assert set(rs.components(edited, BINDINGS, _report(), _data())["ranks"]) == {"contribution.groups.0"}


def test_changing_the_impact_methods_is_a_rewrite():
    """The reported bug: the prose names a method family the study no longer uses."""
    section = _section(
        text="The assessment follows the EF v3.1 method.",
        bindings={},
        based_on=rs.components("The assessment follows the EF v3.1 method.", {}, _report(), _data()),
    )
    cml = _report(methods=[["CML v4.8 2016 no LT", "climate change", "GWP100"]])
    found = rs.verdicts(section, cml, _data(), known_families=["EF v3.1", "CML v4.8 2016 no LT"])
    assert [f["kind"] for f in found] == ["selection"]
    assert found[0]["severity"] == "rewrite"
    assert "EF v3.1" in found[0]["message"]


def test_naming_your_own_method_is_not_naming_a_foreign_one():
    """A real report hit this: every chapter came back "out of date" the moment it was written.

    ecoinvent ships "CML v4.8 2016" and "CML v4.8 2016 no LT" as two families, and the word boundary
    after "2016" is a space — so prose naming the selected long variant contains the short one whole.
    A report on the long variant condemned every chapter that named its own method, permanently.
    """
    known = ["CML v4.8 2016", "CML v4.8 2016 no LT", "EF v3.1"]
    cml = _report(methods=[["CML v4.8 2016 no LT", "climate change", "GWP100"]])
    text = "Impacts are assessed with CML v4.8 2016 no LT, the family this study uses throughout."
    assert rs.method_families_in_prose(text, cml, known) == []

    section = _section(text=text, bindings={}, based_on=rs.components(text, {}, cml, _data()))
    assert rs.verdicts(section, cml, _data(), known_families=known) == []

    # And the real case still fires: a family the report genuinely does not use.
    stray = "Impacts are assessed with CML v4.8 2016 no LT; earlier drafts used EF v3.1."
    assert rs.method_families_in_prose(stray, cml, known) == ["EF v3.1"]

    # …including the short sibling, when the prose really does name it on its own.
    short = "Impacts are assessed with CML v4.8 2016, which includes long-term emissions."
    assert rs.method_families_in_prose(short, cml, known) == ["CML v4.8 2016"]

    # …but not the selected family said short, with its variant named in the same chapter.
    said_short = "Acidification comes from CML v4.8 2016. The CML family is the no LT variant."
    assert rs.method_families_in_prose(said_short, cml, known) == []


def test_a_chapter_written_before_this_check_is_still_caught_by_its_prose():
    """The transitional rule: an old string fingerprint cannot be compared, but a method name that
    the report does not use is wrong whenever it was written."""
    section = _section(
        text="The assessment follows the EF v3.1 method.",
        bindings={},
        based_on="d71b4d8f97e9dcea",  # the old, pre-components shape
    )
    cml = _report(methods=[["CML v4.8 2016 no LT", "climate change", "GWP100"]])
    found = rs.verdicts(section, cml, _data(), known_families=["EF v3.1", "CML v4.8 2016 no LT"])
    kinds = {f["kind"] for f in found}
    assert "selection" in kinds
    assert rs.worst(found) == "rewrite"


def test_an_old_fingerprint_alone_is_reported_as_unverified_not_as_stale():
    section = _section(based_on="d71b4d8f97e9dcea")
    found = rs.verdicts(section, _report(), _data())
    assert [f["kind"] for f in found] == ["unknown"]
    assert rs.worst(found) == "none"


def test_the_selection_message_names_the_field_that_moved():
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    found = rs.verdicts(section, _report(aggregate_by="geo"), _data())
    selection = [f for f in found if f["kind"] == "selection"]
    assert selection and "contribution breakdown" in selection[0]["message"]


def test_changing_the_amount_is_a_rewrite():
    """V195, measured: the PVC-window report printed 696 kg CO2-Eq, the amount went from 1 to 10, and
    the document came back with nine green chapters and no finding — while four of them still said
    "every figure below refers to one window element"."""
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    found = rs.verdicts(section, _report(amount=10), _data(amount=10, score=15.0))
    selection = [f for f in found if f["kind"] == "selection"]
    assert selection and selection[0]["severity"] == "rewrite"
    # Both amounts, so the author reads what happened rather than that something did.
    assert "an amount of 1" in selection[0]["message"]
    assert "now computes 10" in selection[0]["message"]
    assert "1 L" in selection[0]["message"]  # what the amount counts
    assert rs.worst(found) == "rewrite"


def test_the_same_amount_set_again_is_not_a_change():
    """The obvious false alarm: typing the value the report already had must report nothing."""
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(amount=1), _data()))
    assert rs.verdicts(section, _report(amount=1.0), _data(amount=1.0)) == []


def test_an_unwritten_chapter_has_no_amount_to_be_wrong_about():
    section = _section(text="", bindings={}, based_on=None)
    assert rs.verdicts(section, _report(amount=10), _data(amount=10, score=15.0)) == []


def test_an_amount_change_leaves_the_shares_alone():
    """The proof that the fix is not broader than the fault: an amount multiplies the absolute figures
    and leaves every share where it was, so nothing about the wording of a share may be reported."""
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    found = rs.verdicts(section, _report(amount=10), _data(amount=10, score=15.0))
    assert [f["kind"] for f in found] == ["selection", "values"]
    assert not [f for f in found if f["kind"] == "bands"]


def test_switching_the_reference_process_is_reported_although_no_label_moves():
    """Every variant of a report carries the *same* code and differs only by its scenario, so the
    subject labels cannot see this — "Baseline" stays "Baseline", and the study metadata does not move
    either. The reference process was as silent as the amount."""
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    other = _data(activity=("orange juice production", "xyz"), score=2.0)
    found = rs.verdicts(section, _report(code="xyz"), other)
    selection = [f for f in found if f["kind"] == "selection"]
    assert selection and selection[0]["severity"] == "rewrite"
    assert "apple juice production" in selection[0]["message"]
    assert "orange juice production" in selection[0]["message"]


def test_renaming_the_reference_dataset_is_not_a_changed_selection():
    """The comparison is on the code: a renamed dataset is the same dataset, and a verdict about it
    would be a rewrite bought for nothing."""
    section = _section(based_on=rs.components(TEXT, BINDINGS, _report(), _data()))
    renamed = _data(activity=("apple juice production, from concentrate", "abc"))
    assert [f["kind"] for f in rs.verdicts(section, _report(), renamed)] == []


def test_moving_the_significance_threshold_is_a_rewrite():
    """Chapters quote this number — "below the 5 % threshold this report treats as a difference" — and
    there is no placeholder that could resolve it."""
    text = "The variants differ by less than the 5 % this report treats as a difference."
    section = _section(
        text=text, bindings={}, based_on=rs.components(text, {}, _report(), _data())
    )
    found = rs.verdicts(section, _report(significance=15.0), _data())
    selection = [f for f in found if f["kind"] == "selection"]
    assert selection and selection[0]["severity"] == "rewrite"
    assert "threshold of 5 %" in selection[0]["message"]
    assert "now uses 15 %" in selection[0]["message"]

    # …and the unset option is the convention, so writing 5 % into an empty field changes nothing.
    assert rs.verdicts(section, _report(significance=5.0), _data()) == []


def test_a_record_written_before_a_field_was_watched_is_not_condemned_by_it():
    """The rollout case: every chapter on disk carries a selection without `amount`, and an absent
    value differs from every real one. Comparing anyway would have reported "written for an amount of
    none" for every report in the project."""
    recorded = rs.components(TEXT, BINDINGS, _report(), _data())
    recorded["selection"] = {
        k: v
        for k, v in recorded["selection"].items()
        if k not in ("amount", "reference", "reference_name", "significance_percent")
    }
    section = _section(based_on=recorded)
    found = rs.verdicts(section, _report(amount=10, significance=15.0), _data(amount=10, score=15.0))
    assert [f["kind"] for f in found] == ["values"]
    assert rs.worst(found) == "none"


def test_bands_are_coarse_on_purpose():
    assert rs._band(4.9) == "<5 %"
    assert rs._band(5.0) == "5–20 %"
    assert rs._band(-60.0) == ">50 %"  # by absolute value; the sign is tracked separately
    assert rs._band(20.0) == "20–50 %"


def test_a_method_stored_as_one_string_is_still_a_family():
    """`MethodRef` is a tuple *or* "family / category / indicator" as one string, and both land on the
    report verbatim. Taken as a sequence, the string's family was its first *character*."""
    known = ["CML v4.8 2016 no LT", "EF v3.1"]
    as_string = _report(methods=["CML v4.8 2016 no LT / climate change / GWP100"])
    assert rs.selection_of(as_string, _data())["methods"] == [
        "CML v4.8 2016 no LT / climate change / GWP100"
    ]
    text = "Impacts are assessed with CML v4.8 2016 no LT."
    assert rs.method_families_in_prose(text, as_string, known) == []
    assert rs.method_families_in_prose("Earlier drafts used EF v3.1.", as_string, known) == ["EF v3.1"]


def test_a_vanished_cited_path_is_a_hole_not_a_shrug():
    """A cited `checks.…` path that no longer resolves used to fall out of the values hash and read as
    "the numbers moved, remedy none" — while the PDF printed "[missing: …]"."""
    text = "The spread is {{checks.sensitivity.0.spread_percent}} across scenarios."
    data = dict(_data())
    data["checks"] = {"sensitivity": [{"spread_percent": 12.5}]}
    section = _section(text=text, bindings={}, based_on=rs.components(text, {}, _report(), data))

    gone = dict(_data())  # the scenario was deleted; checks.sensitivity is empty now
    gone["checks"] = {"sensitivity": []}
    found = rs.verdicts(section, _report(), gone)
    holes = [f for f in found if f["kind"] == "members" and "no longer resolves" in f["message"]]
    assert holes and holes[0]["severity"] == "rewrite"
    assert rs.worst(found) == "rewrite"


def test_subject_reorder_is_not_a_rank_change():
    """`subjects` is report order, not magnitude — recording ranks for it made a pure reorder look
    like "'the largest' may no longer be true"."""
    text = "Variant {{subjects.0.label}} scores {{subjects.0.results.0.score}}."
    data = {
        "study": {"functional_unit": "1 L"},
        "results": [{"method_label": "m", "score": 1.0, "unit": "kg"}],
        "subjects": [
            {"label": "Baseline", "code": "a", "results": [{"score": 1.0}]},
            {"label": "B", "code": "b", "results": [{"score": 2.0}]},
        ],
    }
    bindings = {"subjects.0": {"code": "a", "scenario": ""}}
    recorded = rs.components(text, bindings, _report(), data)
    assert recorded["ranks"] == {}  # nothing rank-like is stored for a structure-ordered list

    reordered = dict(data)
    reordered["subjects"] = [data["subjects"][1], data["subjects"][0]]
    section = _section(text=text, bindings=bindings, based_on=recorded)
    found = rs.verdicts(section, _report(), reordered)
    assert not [f for f in found if f["kind"] == "ranks"], found


def test_family_scan_is_scoped_to_what_the_chapter_was_written_under():
    """"IPCC 2021" as the stated factor source of an EF study is ordinary vocabulary, not staleness —
    but a chapter written under EF v3.1 that still names it after the switch to CML is stale."""
    known = ["EF v3.1", "CML v4.8 2016", "IPCC 2021"]
    report = _report(methods=[["CML v4.8 2016", "acidification"]])

    # Written under EF v3.1, still naming it: stale.
    stored = {"selection": {"methods": ["EF v3.1 / climate change / GWP100"]}}
    assert rs.method_families_in_prose("computed with EF v3.1.", report, known, stored) == ["EF v3.1"]
    # Naming IPCC 2021 as a factor source: not a family this chapter was written under — no finding.
    assert rs.method_families_in_prose("factors from IPCC 2021.", report, known, stored) == []
    # Legacy chapter without a stored selection keeps the transitional full scan.
    assert rs.method_families_in_prose("factors from IPCC 2021.", report, known, None) == ["IPCC 2021"]


#: One elementary flow across five compartments, ranked by share — the shape of `inventory.flows`.
_FLOWS = {
    "air": {"flow": "Carbon dioxide, fossil", "compartment": "air", "share_percent": 40.0},
    "urban": {"flow": "Carbon dioxide, fossil", "compartment": "air / urban", "share_percent": 35.0},
    "low": {"flow": "Carbon dioxide, fossil", "compartment": "air / low pop.", "share_percent": 15.0},
    "methane": {"flow": "Methane, fossil", "compartment": "air", "share_percent": 6.0},
    "n2o": {"flow": "Dinitrogen monoxide", "compartment": "air", "share_percent": 4.0},
}
_FLOW_ORDER = ("air", "urban", "low", "methane", "n2o")


def _inventory(order=_FLOW_ORDER):
    data = _data()
    data["inventory"] = {"unit": "kg CO2-Eq", "flows": [dict(_FLOWS[k]) for k in order]}
    return data


#: The sentence from a real run: three members, one figure, no superlative.
SUM_TEXT = (
    "The score is carried almost entirely by fossil carbon dioxide "
    "({{sum(inventory.flows.0.share_percent, inventory.flows.1.share_percent, "
    "inventory.flows.2.share_percent)}} % across its three air compartments)."
)
INV_BINDINGS = {
    f"inventory.flows.{i}": {"flow": _FLOWS[k]["flow"], "compartment": _FLOWS[k]["compartment"]}
    for i, k in enumerate(_FLOW_ORDER[:3])
}


def _inv_section(text=SUM_TEXT, order=_FLOW_ORDER):
    stored = rs.components(text, INV_BINDINGS, _report(), _inventory())
    return _section(text=text, bindings=INV_BINDINGS, based_on=stored), _inventory(order)


def test_a_swap_inside_one_sum_is_nobody_s_finding():
    """V172: two chapters read `inventory.flows.0` and `.1` only as operands of the same sum — the
    same flow in two compartments. They swapped, the sum moved by nothing, and the finding bought a
    paid rewrite of a correct chapter plus a second one stuck on `review` with nothing to correct."""
    section, swapped = _inv_section(order=("urban", "air", "low", "methane", "n2o"))
    found = rs.verdicts(section, _report(), swapped)
    assert not [f for f in found if f["kind"] == "ranks"], found
    assert rs.worst(found) == "none"


def test_a_member_that_also_stands_bare_keeps_its_rank_finding():
    """The exemption is about the *reading*, not about the path: print the figure on its own and the
    chapter is making a claim about that member after all."""
    text = SUM_TEXT + " The leading compartment alone contributes {{inventory.flows.0.share_percent}} %."
    section, swapped = _inv_section(text=text, order=("urban", "air", "low", "methane", "n2o"))
    found = rs.verdicts(section, _report(), swapped)
    ranks = [f for f in found if f["kind"] == "ranks"]
    assert [f["path"] for f in ranks] == ["inventory.flows.0"], found
    assert rs.worst(found) == "review"


def test_a_member_leaving_the_summed_indices_keeps_its_rank_finding():
    """"across its three air compartments" describes the top three. A member that drops to fourth
    may have made that sentence false — only a permutation inside the folded indices is harmless."""
    section, dropped = _inv_section(order=("urban", "low", "methane", "air", "n2o"))
    found = rs.verdicts(section, _report(), dropped)
    ranks = [f for f in found if f["kind"] == "ranks"]
    assert [f["path"] for f in ranks] == ["inventory.flows.0"], found
    assert "rank 1" in ranks[0]["message"] and "rank 4" in ranks[0]["message"]


def test_a_derivation_over_one_member_is_no_exemption():
    """`percent(flow, total)` folds two figures but one member of the ranked list, and "X of the
    total" is a claim about that member."""
    text = "Fossil CO2 is {{percent(inventory.flows.0.share_percent, results.0.score)}} % of it."
    section, swapped = _inv_section(text=text, order=("urban", "air", "low", "methane", "n2o"))
    found = rs.verdicts(section, _report(), swapped)
    assert [f["path"] for f in found if f["kind"] == "ranks"] == ["inventory.flows.0"], found


def test_a_comparison_of_two_members_is_no_exemption():
    """A fold is order-blind; a comparison is not. "the leader exceeds the runner-up by X" is exactly
    the sentence a swap falsifies, so `diff` stays watched even over two members of one list."""
    text = ("Fossil CO2 in air leads its next compartment by "
            "{{diff(inventory.flows.0.share_percent, inventory.flows.1.share_percent)}} points.")
    section, swapped = _inv_section(text=text, order=("urban", "air", "low", "methane", "n2o"))
    found = rs.verdicts(section, _report(), swapped)
    assert {f["path"] for f in found if f["kind"] == "ranks"} == {
        "inventory.flows.0",
        "inventory.flows.1",
    }, found


# ---- V196: a chapter that quotes a figure somebody switched off ---------------------------------
_CITES = "The overall picture is summarised in {{ref:f-heatmap}}."
_PLAIN = "Packaging carries the balance, and the ranking is stable across the variants."


def _nine(citing=(3, 6), figures=None):
    """A measurement: nine written chapters, two of them quoting the heatmap.

    Passed as a report *and* as the section list, because a verdict is asked per chapter — which is
    the whole point of the finding below: seven of these nine never mention the figure.
    """
    kinds = ("goal_scope", "inventory", "methods", "lcia", "contribution",
             "interpretation_checks", "conclusions", "limitations", "appendix")
    sections = [
        {"id": f"c{i}", "kind": kind, "order": i, "text": _CITES if i in citing else _PLAIN}
        for i, kind in enumerate(kinds)
    ]
    report = {**_report(), "sections": sections}
    if figures is not None:
        report["options"] = {"figures": figures}
    return report, sections


def _heatmap_findings(section, report):
    return [f for f in rs.verdicts(section, report, _data(), []) if f.get("path") == "ref:f-heatmap"]


def test_a_reference_to_a_switched_off_figure_is_reported_at_the_chapters_that_make_it():
    """The heatmap box was cleared and nothing else. `options.figures` is in nothing this module
    compares, so the check reported "Every chapter written" while the export refused the PDF (V196).

    Per chapter, not per report: a switched-off figure invalidates a *reference*, and the seven
    chapters that never quoted it are not wrong about anything.
    """
    report, sections = _nine()
    hit = [s["id"] for s in sections if _heatmap_findings(s, report)]
    assert hit == ["c3", "c6"], hit
    assert all(rs.worst(rs.verdicts(s, report, _data(), [])) == "none" for s in sections if s["id"] not in hit)


def test_the_switched_off_figure_finding_names_the_figure_and_the_box_that_repairs_it():
    """The old sentence blamed a deleted chapter, so the author went looking for one that was there.
    `rewrite`, because the document prints a gap — and because that is the verdict "Correct all"
    buys nothing for and "Accept as it is" is withheld on: no model can tick a checkbox.
    """
    report, sections = _nine()
    (found,) = _heatmap_findings(sections[3], report)
    assert found["severity"] == "rewrite" and found["kind"] == "members"
    assert "Heatmap of every indicator" in found["message"]
    assert "Scope & indicators" in found["message"]
    assert "chapter" not in found["message"], found["message"]


def test_the_finding_disappears_when_the_figure_is_switched_back_on():
    """Read from the option on every pass, never from the stored record — so the repair is the box,
    and there is nothing to accept, stamp or correct away."""
    report, sections = _nine(figures={"heatmap": True})
    assert not [s["id"] for s in sections if _heatmap_findings(s, report)]


def test_switching_the_contribution_between_stacked_and_grouped_reports_nothing():
    """`f-contribution` is one label over three drawings — stacked, grouped, plain bars — and the
    renderer supplies whichever was asked for. The switch changes how the chapter is drawn and never
    what it can point at, so a chapter quoting it must stay silent either way."""
    for stacked in (True, False):
        report, sections = _nine(citing=(), figures={"stacked": stacked})
        sections[6]["text"] = "The split is drawn in {{ref:f-contribution}}."
        found = rs.verdicts(sections[6], report, _data(), [])
        assert rs.worst(found) == "none", (stacked, found)


def test_a_figure_whose_own_chapter_is_gone_is_not_blamed_on_the_checkbox():
    """With the impact assessment deleted the box is not the remedy, and pointing at a switch that
    changes nothing repeats the mistake this finding exists to fix. Left to the export, which knows
    the blocks rather than only the options."""
    report, sections = _nine()
    report = {**report, "sections": [s for s in sections if s["kind"] != "lcia"]}
    assert not _heatmap_findings(sections[6], report)


# ---- V198: a chapter that quotes a table whose chapter somebody deleted -------------------------
_CITES_TABLE = "Every indicator is listed with its unit in {{ref:t-lcia}}."


def _snapshot(**kw):
    """`_data()` with the ISO §4.5 summary every real snapshot carries (`report_data`).

    Without it the check declines to judge table references at all, which is deliberate — the three
    check tables are drawn from the data rather than from the summary, so a snapshot missing it prints
    tables the authority does not list. Every fixture above omits it, and that is why none of them is
    affected by this finding.
    """
    from prism_lca.engine.report_checks import checks_summary

    data = _data(**kw)
    data["checks"] = checks_summary(data)
    return data


def _table_findings(section, report, data=None, label="t-lcia"):
    return [
        f
        for f in rs.verdicts(section, report, data if data is not None else _snapshot(), [])
        if f.get("path") == f"ref:{label}"
    ]


def test_a_reference_to_a_deleted_chapters_table_is_reported_at_the_chapters_that_still_quote_it():
    """A measurement (V198): the results chapter and the conclusions both quoted
    `{{ref:t-lcia}}`, the results chapter was deleted, and the check answered "Every chapter written"
    while the export refused the PDF over the reference the conclusions still make.

    Asked the way the endpoint asks it — over the chapters the report still has. The deleted chapter
    quoted its own table and is the one place with nothing left to tell: it is gone from `sections`, so
    no verdict is ever sought for it, and the seven that never mentioned the table are not wrong.
    """
    report, sections = _nine(citing=(3, 6))
    for section in sections:
        section["text"] = _CITES_TABLE if section["order"] in (3, 6) else _PLAIN
    report = {**report, "sections": [s for s in sections if s["kind"] != "lcia"]}

    hit = [s["id"] for s in report["sections"] if _table_findings(s, report)]
    assert hit == ["c6"], hit
    assert all(
        rs.worst(rs.verdicts(s, report, _snapshot(), [])) == "none"
        for s in report["sections"]
        if s["id"] not in hit
    )


def test_the_deleted_chapters_table_finding_says_what_the_export_says():
    """One reference, one sentence. The export already refuses this PDF with `reference_gap`, and two
    places explaining the same dead reference differently is what V196 was about — so the wording is
    fetched from there rather than written again.

    `rewrite`, because the document prints a gap: "Correct all" buys no model call for it (the only
    edit a model could make is deleting the reference, which is a guess at whether the author wanted
    the chapter back), and "Accept as it is" is withheld — a green stamp on a hole the export refuses
    is V190.
    """
    from prism_lca.engine import report_prompts

    report, sections = _nine(citing=())
    sections[6]["text"] = _CITES_TABLE
    report = {**report, "sections": [s for s in sections if s["kind"] != "lcia"]}

    (found,) = _table_findings(sections[6], report)
    assert found["severity"] == "rewrite" and found["kind"] == "members"
    assert report_prompts.reference_gap("t-lcia", report) in found["message"]
    assert "no longer in this report" in found["message"]


def test_the_table_finding_disappears_when_the_chapter_is_back():
    """Read from the chapter list on every pass, never from the stored record — so undoing the
    deletion clears the badge, and there is nothing to accept or stamp away."""
    report, sections = _nine(citing=())
    sections[6]["text"] = _CITES_TABLE
    assert not _table_findings(sections[6], report)


def test_a_reference_to_a_table_this_report_prints_reports_nothing():
    """The other half of the same arithmetic, and the half that has to stay silent: every table this
    fixture prints, quoted by a chapter that is not the one printing it."""
    report, sections = _nine(citing=())
    for label in ("t-lcia", "t-methods", "t-contribution", "t-consistency"):
        sections[6]["text"] = f"See {{{{ref:{label}}}}}."
        found = rs.verdicts(sections[6], report, _snapshot(), [])
        assert rs.worst(found) == "none", (label, found)


def test_a_report_without_results_is_not_judged_on_its_table_references():
    """The results table is labelled whatever its row count (`report_typst.lcia_blocks`), while every
    condition in the authority that mentions an indicator switches off without results — so this is the
    one shape where the authority is narrower than the renderer, and a badge here would sit on a
    reference the PDF resolves. Declined, not guessed at."""
    report, sections = _nine(citing=())
    sections[6]["text"] = _CITES_TABLE
    empty = {**_snapshot(), "results": []}
    assert not _table_findings(sections[6], report, empty)


def test_the_glossary_table_is_left_to_the_export():
    """Whether the glossary prints a table depends on which acronyms the *finished blocks* use, and
    only the export sees those; the authority can read the stored list and calls that an honest
    approximation (V197). Approximate is enough to accept a reference and too little to refuse one — a
    report whose glossary is stored but not yet filled is a normal stage of writing, and a rewrite
    badge sitting on it through that stage is the unclearable bar V190 warns about."""
    report, sections = _nine(citing=())
    sections[6]["text"] = "The acronyms are expanded in {{ref:t-abbreviations}}."
    for stored in ({}, {"GWP": "Global warming potential"}):
        report = {**report, "abbreviations": stored}
        assert not _table_findings(sections[6], report, label="t-abbreviations"), stored


# --- a claim to the top made in words, under a ranking that changed hands (V206) ----------------
#
# Measured on the mould-remover report: the distribution distance went from 1 200 to
# 12 000 km, Distribution took first place from Packaging, five chapters were flagged, ten replacements
# were proposed and stored, the check said "Corrected 5 chapters, 0 gaps" — and two sentences went into
# the delivered PDF stating the old order. Both carried no placeholder: the executive summary's "dominé
# par l'emballage, premier poste devant la distribution", and — three paragraphs under a dominance
# sentence the same correction *did* soften — "le groupe prépondérant, l'emballage". Every check that
# reads a path or a spelled-out member name was blind to them, and the group label is the untranslated
# `Packaging` while the prose is French, so the words the identifier could be matched by are not in the
# sentence at all.

_FLIPPED_GROUPS = [
    {"key": "Distribution", "share_percent": 72.1},
    {"key": "Packaging", "share_percent": 20.1},
]


def _flipped(**kw):
    """The same report after the strong change: Distribution leads, Packaging is second."""
    data = _data(**kw)
    data["contribution"]["groups"] = [dict(g) for g in _FLIPPED_GROUPS]
    return data


#: A dominance claim in words with no figure in it, and a second sentence that does cite one — the
#: shape of the contribution chapter that was corrected and stayed wrong.
WORDS_ONLY = (
    "The dominant group, packaging, rests on documented background data. "
    "Its share is {{contribution.groups.0.share_percent}} %."
)
WORDS_ONLY_BINDINGS = {"contribution.groups.0": {"key": "Packaging"}}


def _written(text, bindings, data=None, report=None):
    """A chapter written against `data` — record and all."""
    report = report or _report()
    data = data if data is not None else _data()
    return _section(text=text, bindings=bindings, based_on=rs.components(text, bindings, report, data))


def _wording(section, report=None, data=None):
    return [
        f
        for f in rs.verdicts(section, report or _report(), data if data is not None else _flipped())
        if f["kind"] == "wording"
    ]


def test_a_dominance_claim_with_no_placeholder_is_flagged_once_the_lead_changes():
    """The sentence nothing could see. It cites no path, spells out no member name the data knows, and
    the write-time superlative rule has no figure to attribute the word to — so before this the chapter
    was graded on its *other* sentence, corrected there, and stamped current."""
    section = _written(WORDS_ONLY, WORDS_ONLY_BINDINGS)
    (found,) = _wording(section)
    assert found["severity"] == "review"
    assert found["sentence"] == "The dominant group, packaging, rests on documented background data."
    assert "dominant" in found["message"]
    assert "contribution.groups is now led by Distribution, not Packaging" in found["message"]
    # Correctable, and still acceptable by the author: the check cannot read the sentence.
    assert rs.worst(rs.verdicts(section, _report(), _flipped())) == "review"


def test_the_same_wording_is_left_alone_while_the_ranking_holds():
    """The guard against a remark that appears always. Numbers move on every recompute; the lead
    changing hands is the rare event, and only it says anything about the word "dominant"."""
    section = _written(WORDS_ONLY, WORDS_ONLY_BINDINGS)
    # Same order, both figures moved, one of them out of its band.
    assert _wording(section, data=_data(packaging=44.0, raw=41.0)) == []


def test_a_chapter_with_no_dominance_wording_is_untouched_by_a_flip():
    text = "Packaging contributes {{contribution.groups.0.share_percent}} % of the total."
    section = _written(text, WORDS_ONLY_BINDINGS)
    found = rs.verdicts(section, _report(), _flipped())
    # The band and the rank of the figure it does cite, and nothing about its wording.
    assert [f["kind"] for f in found] == ["bands", "ranks", "values"], found


def test_an_anchored_dominance_sentence_stays_the_write_time_rules_business():
    """No second report of the same sentence. Where the word stands beside a figure, the gate settles
    arithmetically whether it is attributed to the member that leads (V175) and the store refuses the
    chapter until it is — this rule is for the sentences that rule cannot see."""
    section = _written(TEXT, BINDINGS)
    assert _wording(section) == []


def test_an_ordinal_disarms_the_wording_rule_as_it_does_at_write_time():
    text = "Packaging is the second-largest group. Its share is {{contribution.groups.0.share_percent}} %."
    section = _written(text, WORDS_ONLY_BINDINGS)
    assert _wording(section) == []


def test_the_flagged_sentence_reaches_the_correction():
    """The point of locating it by the word: the model is handed the sentence, so one replacement can
    put it right. A rewrite of nine chapters per rank flip is what this avoids."""
    from prism_lca.engine import report_patch

    section = _written(WORDS_ONLY, WORDS_ONLY_BINDINGS)
    found = _wording(section)
    spans = report_patch.spans_for(WORDS_ONLY, found)
    assert [s["sentence"] for s in spans] == [
        "The dominant group, packaging, rests on documented background data."
    ]
    assert not report_patch.unlocated_in(WORDS_ONLY, found)


def test_a_correction_that_left_the_sentence_alone_keeps_the_finding():
    """V162's lesson on V206's case: the correction re-stamps the chapter, and a fresh record would say
    the ranking never moved. Both halves — an edit elsewhere keeps the finding, an edit inside the
    sentence answers it."""
    from prism_lca.engine import report_patch

    section = _written(WORDS_ONLY, WORDS_ONLY_BINDINGS)
    data = _flipped()
    actionable = [f for f in rs.verdicts(section, _report(), data) if f["severity"] != "none"]
    fresh = rs.components(WORDS_ONLY, WORDS_ONLY_BINDINGS, _report(), data)
    assert fresh["leaders"]["contribution.groups"] == {"key": "Distribution"}

    elsewhere = [{"old": "Its share is", "new": "It stands at"}]
    left = report_patch.unaddressed(WORDS_ONLY, actionable, elsewhere)
    assert any(f["kind"] == "wording" for f in left)
    kept = rs.keep_stale(fresh, section["based_on"], left)
    assert kept["leaders"]["contribution.groups"] == {"key": "Packaging"}
    assert _wording({**section, "based_on": kept}, data=data)

    on_it = [{"old": "The dominant group, packaging,", "new": "Distribution now leads, and packaging"}]
    answered = report_patch.unaddressed(WORDS_ONLY, actionable, on_it)
    assert not any(f["kind"] == "wording" for f in answered)
    stamped = rs.keep_stale(fresh, section["based_on"], answered)
    assert stamped["leaders"]["contribution.groups"] == {"key": "Distribution"}


def test_the_french_wording_is_found_although_the_group_label_is_english():
    """The case that occurred. The label is the binding identity and is deliberately never translated,
    the prose is French, and the writing model translated the identifier into words — so “l'emballage”
    is not searchable and “dominé” is not the “domine” the word list carries. Accents are folded for
    exactly that reason; the word list itself stays the one the write-time rule uses."""
    text = (
        "Le bilan climatique est dominé par l'emballage, premier poste devant la distribution "
        "({{ref:t-lcia}}). L'emballage représente {{contribution.groups.0.share_percent}} % du total."
    )
    report = _report(lang="fr")
    section = _written(text, WORDS_ONLY_BINDINGS, report=report)
    (found,) = _wording(section, report=report)
    assert found["sentence"].startswith("Le bilan climatique est dominé par l'emballage")
    assert "premier poste devant la distribution" in found["sentence"]
    # Quoted as the chapter spells it. The list carries “domine”; a message naming that beside a
    # sentence saying “dominé” sends the correction model looking for a word that is not there.
    assert "(“dominé”)" in found["message"]
    # Naming the group that leads today is no evidence that the sentence is right: this one names both
    # and puts them the wrong way round. So a mention of the leader does not disarm the rule.
    assert "Distribution" in found["message"]


def test_both_sentences_of_the_delivered_pdf_are_found():
    """The two that went out, in one chapter (V208a). The first fix round caught only the second: the
    word list had "domine" but not "prépondérant", so “le groupe prépondérant, l'emballage” — three
    paragraphs under a dominance sentence the correction *did* soften — stayed exactly as wrong as
    before. A word list that falls silent costs a finding, and this one cost it on a client PDF."""
    text = (
        "Le groupe prépondérant, l'emballage, repose sur des données d'arrière-plan documentées. "
        "Le bilan climatique est dominé par l'emballage, premier poste devant la distribution. "
        "L'emballage représente {{contribution.groups.0.share_percent}} % du total."
    )
    report = _report(lang="fr")
    section = _written(text, WORDS_ONLY_BINDINGS, report=report)
    found = _wording(section, report=report)
    assert [f["sentence"] for f in found] == [
        "Le groupe prépondérant, l'emballage, repose sur des données d'arrière-plan documentées.",
        "Le bilan climatique est dominé par l'emballage, premier poste devant la distribution.",
    ]
    # Each quoted as the chapter spells it, from the one shared fold (`report_claims.folded`).
    assert "(“prépondérant”)" in found[0]["message"]
    assert "(“dominé”)" in found[1]["message"]
    # The third sentence carries a figure, so it stays the write-time rule's business.
    assert all("représente" not in f["sentence"] for f in found)


def test_a_leader_change_between_two_members_of_the_same_name_says_so():
    """V220. `inventory.flows` carries "Carbon dioxide, fossil" once per compartment, and run 21
    produced *"inventory.flows is now led by Carbon dioxide, fossil, not Carbon dioxide, fossil"* — a
    sentence that tells the author nothing. The label is not the identity (V203), so where the labels
    match, the identity has to be spelled out."""
    from prism_lca.engine import report_staleness as rs

    # `identity_fields("inventory.flows") == ("flow", "compartment")`, and `flow` is a label field —
    # so the same flow in two compartments is two members with one name, which is what the report hit.
    was = {"flow": "Carbon dioxide, fossil", "compartment": "air/urban"}
    data = {"inventory": {"flows": [{"flow": "Carbon dioxide, fossil", "compartment": "air/rural"}]}}
    line = rs._leader_change("inventory.flows", was, data, {})
    assert "another member with the same name" in line
    assert "air/rural" in line and "air/urban" in line

    # Two different names keep the plain wording, which is the readable case.
    other = {"flow": "Methane, fossil", "compartment": "air/urban"}
    plain = rs._leader_change("inventory.flows", other, data, {})
    assert plain == "inventory.flows is now led by Carbon dioxide, fossil, not Methane, fossil"


def test_a_record_written_before_the_leaders_were_kept_still_reports_the_flip():
    """The transitional rule: a chapter already on disk has no `leaders` in its record, and its ranks
    still say who led — a member stored at rank 0 that is not the leader today is a flip, and the record
    even knows who it was. Without this the finding would only start working after every chapter of
    every report in progress had been re-stamped once."""
    section = _written(WORDS_ONLY, WORDS_ONLY_BINDINGS)
    section["based_on"].pop("leaders")
    (found,) = _wording(section)
    assert "not Packaging" in found["message"]


def test_a_share_text_placeholder_is_watched_through_its_percent_twin():
    """The formatted `share_text` — the form the prose is told to use — is a string,
    and a string had no band; a majority claim on it went from 60 % to 40 % with no verdict."""
    text = "Packaging carries {{contribution.groups.0.share_text}} of the balance."
    before = _data()
    before["contribution"]["groups"][0]["share_text"] = "60.0 %"
    section = _section(text=text, based_on=rs.components(text, BINDINGS, _report(), before))
    after = _data(packaging=40.0)
    after["contribution"]["groups"][0]["share_text"] = "40.0 %"
    found = rs.verdicts(section, _report(), after)
    assert any(f["kind"] == "bands" and "moved from" in f["message"] for f in found), found


def test_a_derivation_that_flips_sign_asks_for_a_look():
    """Only the arguments of `change(a, b)` were recorded, so two positive figures
    swapping order — the difference turning negative — left "A is higher than B" unquestioned."""
    # Two variants under the SAME indicator: a change between two categories is refused
    # at the derivation, so the fixture no longer fakes it with a water-use row in kg CO2-Eq.
    text = "A lies {{change(subjects.1.results.0.score, subjects.0.results.0.score)}} above B."
    gwp = "EF v3.1 / climate change / GWP100"
    before = _data()
    before["subjects"] = [
        {"label": "B", "results": [{"method_label": gwp, "score": 0.9, "unit": "kg CO2-Eq"}]},
        {"label": "A", "results": [{"method_label": gwp, "score": 1.5, "unit": "kg CO2-Eq"}]},
    ]
    section = _section(text=text, based_on=rs.components(text, BINDINGS, _report(), before))
    after = _data()
    after["subjects"] = [
        {"label": "B", "results": [{"method_label": gwp, "score": 0.9, "unit": "kg CO2-Eq"}]},
        {"label": "A", "results": [{"method_label": gwp, "score": 0.8, "unit": "kg CO2-Eq"}]},
    ]
    found = rs.verdicts(section, _report(), after)
    assert any(f["kind"] == "bands" and "direction" in f["message"] for f in found), found


def test_reordering_the_methods_condemns_only_chapters_citing_the_first_indicator():
    """The method list is compared as a set, so `results.0` silently became another
    indicator under the old unit — for a chapter that cites it; one that names the methods in words is
    not affected by their order."""
    two = [["EF v3.1", "climate change", "GWP100"], ["EF v3.1", "water use", "WU"]]
    lead = "The total is {{results.0.score}} kg CO2-Eq."
    words = "This study applies EF v3.1 throughout."
    cites = _section(text=lead, based_on=rs.components(lead, BINDINGS, _report(methods=two), _data()))
    names = _section(text=words, based_on=rs.components(words, BINDINGS, _report(methods=two), _data()))
    swapped = _report(methods=list(reversed(two)))
    found = rs.verdicts(cites, swapped, _data())
    assert any(f["kind"] == "selection" and "leading indicator" in f["message"] for f in found), found
    assert not [f for f in rs.verdicts(names, swapped, _data()) if f["kind"] == "selection"]


# ---- a comparison that flipped, and what a correction has to prove -----------

COMPARE = (
    "Packaging at {{contribution.groups.0.share_percent}} % is higher than raw materials at "
    "{{contribution.groups.1.share_percent}} %."
)


def test_a_comparison_between_two_placeholders_that_flipped_is_a_finding():
    """Both figures stay positive and in their bands, so the record saw nothing — while the gate would
    refuse the sentence. Asked afresh of the numbers, like the gate does."""
    written = _data(packaging=60.0, raw=30.0)
    section = _section(COMPARE, BINDINGS, rs.components(COMPARE, BINDINGS, _report(), written))
    assert [f["kind"] for f in rs.verdicts(section, _report(), written) if f["kind"] == "comparison"] == []
    flipped = rs.verdicts(section, _report(), _data(packaging=20.0, raw=40.0))
    hit = [f for f in flipped if f["kind"] == "comparison"]
    assert len(hit) == 1 and hit[0]["severity"] == "review" and hit[0]["sentence"].startswith("Packaging at")
    assert rs.worst(flipped) == "review"


def _rank_finding(path="contribution.groups.0"):
    return {"kind": "ranks", "severity": "review", "path": path, "declared": False,
            "message": f"{path} was rank 1 and is now rank 2"}


def test_a_touched_rank_finding_is_not_resolved_by_editing_around_the_claim():
    """"Packaging is" → "The Packaging is" cleared the finding while the false claim stood."""
    now = _data(packaging=20.0, raw=40.0)  # Packaging no longer leads
    bindings = {"contribution.groups.0": {"key": "Packaging"}}
    still_claims = "The Packaging is the largest contributor with {{contribution.groups.0.share_percent}} %."
    assert rs.unresolved_after([_rank_finding()], still_claims, bindings, _report(), now) == [_rank_finding()]
    # The claim is gone: the sentence only reads the figure.
    no_claim = "Packaging carries {{contribution.groups.0.share_percent}} % of the total."
    assert rs.unresolved_after([_rank_finding()], no_claim, bindings, _report(), now) == []
    # The path is gone altogether.
    assert rs.unresolved_after([_rank_finding()], "Raw materials lead the balance.", bindings, _report(), now) == []


def test_a_declared_rank_resolves_only_when_the_member_holds_it_again():
    bindings = {"contribution.groups.0": {"key": "Packaging"}}
    declared = "{{rank:contribution.groups.0}} leads with {{contribution.groups.0.share_percent}} %."
    # The fixture lists Packaging first whatever its share; a real ranking puts raw materials ahead.
    overtaken = _data(packaging=20.0, raw=40.0)
    overtaken["contribution"]["groups"].reverse()
    assert rs.unresolved_after([_rank_finding()], declared, bindings, _report(), overtaken) == [_rank_finding()]
    assert rs.unresolved_after([_rank_finding()], declared, bindings, _report(), _data(packaging=60.0, raw=30.0)) == []


def test_a_band_finding_follows_the_same_rule_and_a_selection_finding_its_families():
    band = {"kind": "bands", "severity": "review", "path": "contribution.groups.0.share_percent",
            "message": "moved from >50 % to 5–20 %"}
    now = _data(packaging=18.0, raw=40.0)
    assert rs.unresolved_after([band], "Packaging still dominates at {{contribution.groups.0.share_percent}} %.", BINDINGS, _report(), now) == [band]
    assert rs.unresolved_after([band], "Packaging stands at {{contribution.groups.0.share_percent}} %.", BINDINGS, _report(), now) == []
    names = {"kind": "selection", "severity": "rewrite", "names": ["IPCC 2013"], "message": "names IPCC 2013"}
    report = _report(methods=[["EF v3.1", "climate change", "GWP100"]])
    assert rs.unresolved_after([names], "The study follows IPCC 2013.", {}, report, now, ["IPCC 2013", "EF v3.1"]) == [names]
    assert rs.unresolved_after([names], "The study follows EF v3.1.", {}, report, now, ["IPCC 2013", "EF v3.1"]) == []


# ---- the texts a chapter drew on -------------------------------------------
from prism_lca.engine import report_prompts as _rp  # noqa: E402


def _with_study(**study):
    d = _data()
    d["study"] = {**d["study"], **study}
    return d


def test_a_changed_system_boundary_is_a_finding_although_no_number_moved():
    """"The system ends at the factory gate" stayed green after cradle-to-gate became cradle-to-grave:
    the record watched numbers, never the texts the chapter describes."""
    text = "The system ends at the factory gate, as the study's scope defines it."
    written = _with_study(system_boundaries="cradle-to-gate", allocation="mass")
    section = {"id": "s1", "kind": "goal_scope", "text": text, "bindings": {}}
    section["based_on"] = rs.with_sources(rs.components(text, {}, _report(), written), section, _report(), written)
    assert [f for f in rs.verdicts(section, _report(), written) if f["kind"] == "sources"] == []
    moved = _with_study(system_boundaries="cradle-to-grave", allocation="mass")
    found = [f for f in rs.verdicts(section, _report(), moved) if f["kind"] == "sources"]
    assert len(found) == 1 and found[0]["severity"] == "review" and found[0]["path"] == "study.system_boundaries"
    assert "system boundaries changed" in found[0]["message"]
    # A record from before the sources existed has nothing to compare and says nothing.
    legacy = {**section, "based_on": rs.components(text, {}, _report(), written)}
    assert [f for f in rs.verdicts(legacy, _report(), moved) if f["kind"] == "sources"] == []


def test_a_summary_notices_when_the_chapters_it_read_change():
    summary_kind, read_kind = _rp._SUMMARISING[0], _rp._WORTH_READING[0]
    data = _data()
    sibling = {"id": "s-lcia", "kind": read_kind, "title": "Results", "text": "Packaging leads the balance."}
    summary = {"id": "s-sum", "kind": summary_kind, "text": "Packaging leads, as the results chapter shows.", "bindings": {}}
    report = {**_report(), "sections": [sibling, summary]}
    summary["based_on"] = rs.with_sources(rs.components(summary["text"], {}, report, data), summary, report, data)
    assert [f for f in rs.verdicts(summary, report, data) if f["kind"] == "sources"] == []
    report_after = {**report, "sections": [{**sibling, "text": "Raw materials lead the balance now."}, summary]}
    found = [f for f in rs.verdicts(summary, report_after, data) if f["kind"] == "sources"]
    assert len(found) == 1 and found[0]["severity"] == "review" and "Results" in found[0]["message"]


def test_a_patch_elsewhere_does_not_clear_a_source_finding():
    """The lesson of the flipped comparison applied to sources: an unaddressed finding keeps its old
    fingerprint."""
    written = _with_study(system_boundaries="cradle-to-gate")
    section = {"id": "s1", "kind": "goal_scope", "text": "The system ends at the factory gate.", "bindings": {}}
    stored = rs.with_sources(rs.components(section["text"], {}, _report(), written), section, _report(), written)
    moved = _with_study(system_boundaries="cradle-to-grave")
    finding = {"kind": "sources", "severity": "review", "path": "study.system_boundaries", "source": "study", "message": "m"}
    fresh = rs.with_sources(rs.components(section["text"], {}, _report(), moved), section, _report(), moved)
    kept = rs.keep_stale(fresh, stored, [finding])
    assert kept["sources"]["study"]["system_boundaries"] == stored["sources"]["study"]["system_boundaries"]
    assert rs.keep_stale(fresh, stored, [])["sources"] == fresh["sources"]


def test_a_release_lapses_when_the_chapters_figures_move_even_at_remedy_none():
    """V393: a parameter change reported "the numbers moved" at severity
    none on five chapters and every release stood, because the rule read the remedy. It reads the
    figures now: the mark carries the values hash it was released against."""
    section = {"model": "m", "text": "t", "reviewed": {"release": True, "text": "t", "values": "abc"}}
    assert rs.expert_review(section, "none", "abc") == "released"
    assert rs.expert_review(section, "none", "xyz") == "pending"
    # A mark without the hash (made before V393) is a reading, not a release.
    legacy = {"model": "m", "text": "t", "reviewed": {"release": True, "text": "t"}}
    assert rs.expert_review(legacy, "none", "abc") == "pending"


def test_a_pending_release_says_why():
    """V396: three chapters stood on "pending" with no visible finding — the figures had moved since the
    release. The reason travels with the status so the badge can say it."""
    base = {"model": "m", "text": "t", "reviewed": {"release": True, "text": "t", "values": "abc"}}
    assert rs.expert_review_with_reason(base, "none", "abc") == ("released", None)
    assert rs.expert_review_with_reason(base, "none", "xyz") == ("pending", "values")
    assert rs.expert_review_with_reason({**base, "text": "t2"}, "none", "abc") == ("pending", "text")
    assert rs.expert_review_with_reason(base, "review", "abc") == ("pending", "findings")
    assert rs.expert_review_with_reason({"model": "m", "text": "t"}, "none", "abc") == ("pending", "never")
    assert rs.expert_review_with_reason({"source": "user", "text": "t"}, "none", "abc") == (None, None)


def test_a_correction_in_a_source_chapter_does_not_stale_the_summary_a_rewrite_does():
    """V423: four rounds of Correct all on a silicone report ended at the same "4 to
    check" because every accepted correction in the impact chapter re-staled the summary and the
    conclusions. The fingerprint a summary records is the sibling's text as last WRITTEN
    (`written_sha`), which a correction leaves alone; a rewrite moves it and is still noticed."""
    summary_kind, read_kind = _rp._SUMMARISING[0], _rp._WORTH_READING[0]
    data = _data()
    written = "Packaging leads the balance, and it dominates every category."
    sibling = {
        "id": "s-lcia", "kind": read_kind, "title": "Results", "text": written,
        "written_sha": rs.written_fingerprint({"text": written}),
    }
    summary = {"id": "s-sum", "kind": summary_kind, "text": "Packaging leads, as the results chapter shows.", "bindings": {}}
    report = {**_report(), "sections": [sibling, summary]}
    summary["based_on"] = rs.with_sources(rs.components(summary["text"], {}, report, data), summary, report, data)
    # A correction: the text changes, `written_sha` does not (the patch route never sets it).
    corrected = {**sibling, "text": "Packaging leads the balance, and it carries a large share of every category."}
    assert [f for f in rs.verdicts(summary, {**report, "sections": [corrected, summary]}, data) if f["kind"] == "sources"] == []
    # A rewrite: the writer's store sets a new `written_sha` — the summary has something new to read.
    rewritten_text = "Raw materials lead the balance now."
    rewritten = {**sibling, "text": rewritten_text, "written_sha": rs.written_fingerprint({"text": rewritten_text})}
    found = [f for f in rs.verdicts(summary, {**report, "sections": [rewritten, summary]}, data) if f["kind"] == "sources"]
    assert len(found) == 1 and "Results" in found[0]["message"]
    # A chapter stored before the field existed falls back to its text on both sides, as before.
    legacy = {"id": "s-lcia", "kind": read_kind, "title": "Results", "text": written}
    assert rs.written_fingerprint(legacy) == rs.written_fingerprint({"text": written})


def test_a_rank_finding_names_the_stable_path_as_the_exit():
    """V423: told only what was wrong, the correction model softened the same sentence three rounds in
    a row while the ranked placeholder kept the finding alive. For a variant the finding now names the
    positional path that does not move with the ranking."""
    data = _data()
    subjects = [
        {"code": "p", "scenario": None, "label": "Baseline"},
        {"code": "p", "scenario": "s1", "label": "Variant A"},
    ]
    data["subjects"] = subjects
    data["results"] = [{"method": ["M"], "subjects_by_score": [subjects[1], subjects[0]]}]
    text = "The variant {{results.0.subjects_by_score.0.label}} is the largest."
    bindings = {"results.0.subjects_by_score.0": {"code": "p", "scenario": "s1"}}
    section = {"id": "s1", "kind": "lcia", "text": text, "bindings": bindings}
    section["based_on"] = rs.components(text, bindings, _report(), data)
    # The ranking flips: the baseline overtakes the variant.
    flipped = {**data, "results": [{"method": ["M"], "subjects_by_score": [subjects[0], subjects[1]]}]}
    found = [f for f in rs.verdicts(section, _report(), flipped) if f["kind"] == "ranks"]
    assert len(found) == 1
    assert "was rank 1 and is now rank 2" in found[0]["message"]
    assert "{{subjects.1.label}}" in found[0]["message"]
    assert "{{rank:results.0.subjects_by_score.1}}" in found[0]["message"]
