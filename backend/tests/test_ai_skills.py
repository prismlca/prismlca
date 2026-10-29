

def test_the_model_building_skill_teaches_parameters_and_scenarios():
    """It told the assistant how to structure phases and pick datasets but never mentioned parameters or
    scenarios, so a built model came out as fixed numbers — nothing to vary, and a sensitivity check with
    nothing to say. The skills are topic-selected, so the separate parameters skill may never be loaded
    during a modelling run."""
    from prism_lca.engine.builtin_skills import BUILTIN_SKILLS

    skill = next(s for s in BUILTIN_SKILLS if s["id"] == "builtin-model-building")
    body = skill["content"]
    assert "edit_parameter" in body and "set_formula" in body
    assert "edit_scenario" in body and "compare_scenarios" in body
    # And why, not just how: scenarios are the only mechanism the report has for sensitivity.
    assert "sensitivity" in body.lower()
    # Over-parameterising is its own failure, so the limit is stated too.
    assert "over-parameterise" in body.lower()


def test_the_model_building_skill_asks_for_the_people_the_report_prints():
    """author / organisation / commissioner / critical_review appear on the report's title page and
    nothing else can supply them."""
    from prism_lca.engine.builtin_skills import BUILTIN_SKILLS

    body = next(s for s in BUILTIN_SKILLS if s["id"] == "builtin-model-building")["content"]
    for field in ("author", "organisation", "commissioner", "critical_review"):
        assert field in body, field
    assert "7.3.3" in body  # an empty review field is a reportable fact, not an omission


def test_the_scenario_skill_shows_how_to_test_a_dataset_choice():
    """V93: a scenario overrides parameters, not links — so swapping a proxy looks impossible.

    It is not: link both datasets and let a switch parameter decide which one is on. A
    wall-paint run did it by hand instead (replace_input, calculate, replace back), leaving the
    saved model wrong in between and the result in no scenario and no comparison — on the one
    assumption that moved the answer by 32 %, while its three parameter scenarios managed 11 %.
    The mechanism was always there; nothing told the assistant about it, which is the whole fix.
    """
    from prism_lca.engine.builtin_skills import BUILTIN_SKILLS

    body = next(s for s in BUILTIN_SKILLS if s["id"] == "builtin-eol-scenarios")["content"]
    assert "link both datasets" in body.lower()
    # The two rules that keep the trick honest: an explained dormant row, and switches summing to 1.
    assert "amount 0" in body and "counted twice" in body
    # And the thing NOT to do, because that is what actually happened.
    assert "replace_input" in body


def test_every_tool_a_builtin_skill_names_actually_exists():
    """A skill pointing at a tool that does not exist is worse than one that says nothing: the model
    tries it, fails, and has to recover. This caught `set_parameter` and `manage_scenario`, invented
    while writing the section above."""
    import json
    import pathlib
    import re

    from prism_lca.engine.builtin_skills import BUILTIN_SKILLS

    manifest = pathlib.Path(__file__).resolve().parents[2] / "docs" / "ai-tool-manifest.json"
    if not manifest.is_file():
        import pytest

        pytest.skip("tool manifest not generated in this checkout")
    data = json.loads(manifest.read_text())
    tools = data["tools"] if isinstance(data, dict) and "tools" in data else data
    real = {(t.get("name") or t.get("function", {}).get("name", "")) for t in tools}
    # Only names that look like a tool call: lower_snake_case in backticks, and not a known parameter
    # name from an example.
    # Not tools: parameter names from examples, and tool *arguments* the skills quote by name.
    examples = {
        "eol_incineration", "eol_landfill", "eol_recycling", "total_mass_kg", "critical_review",
        "max_depth", "aggregate_by", "set_formula", "set_amount", "set_value", "system_boundaries",
        "reference_product", "functional_unit", "cutoff_criteria", "share_percent", "read_only",
        "alloc_share", "reference_year", "data_gap", "system_allocation",
        # Fields of a tool's ANSWER, quoted so a skill can point at where to look.
        "not_yet_inspected", "service_note", "outside_geography_filter", "mass_range_kg",
        # Eurostat table ids — arguments of eurostat_eol — and the remainder parameter the EoL skill names.
        "env_wasoper", "env_wastrt", "env_waspac", "env_wasmun", "eol_other",
    }
    for skill in BUILTIN_SKILLS:
        for name in set(re.findall(r"`([a-z]+_[a-z_]{2,28})`", skill["content"])):
            if name in examples or name in real:
                continue
            raise AssertionError(f"{skill['id']} names a tool that does not exist: {name}")
        # The DESCRIPTION too, and without requiring backticks — that combination was the hole.
        # Descriptions do not carry backticks as a rule, and unlike the bodies they are in the system
        # prompt of EVERY run (only the name + description are always in context, the body is pulled
        # with get_skill). So a dead name here is the one a model reads even when it never loads the
        # skill. Found this way: `set_parameter`, `delete_parameter` and
        # `set_exchange_formula` in the parameters skill (reported by the model itself), plus
        # `set_model_info` and `top_elementary_flows`, which nobody had noticed.
        for name in set(re.findall(r"\b([a-z]+_[a-z_]{2,28})\b", skill.get("description") or "")):
            if name in examples or name in real:
                continue
            raise AssertionError(
                f"{skill['id']} description names a tool that does not exist: {name} "
                "(descriptions are in every run's system prompt)"
            )


def test_the_model_building_skill_names_services_not_only_materials():
    """V110: the pre-linking rule fired on an apple-sauce run and hit the wrong class.

    It opened six datasets before linking — apples, container glass, steel, waste glass, waste water,
    every one a material and every one small. The four that carried 78 % of the result were process
    heat, the parcel's last mile, the shipping carton and the line-haul lorry, and not one was opened.
    The examples in the skill were all materials, so the model's shortlist was too.
    """
    from prism_lca.engine.builtin_skills import BUILTIN_SKILLS

    raw = next(s for s in BUILTIN_SKILLS if s["id"] == "builtin-model-building")["content"]
    body = " ".join(raw.split())  # the skill is hard-wrapped; the phrases straddle line breaks
    assert "biggest energy input" in body
    assert "biggest transport item" in body
    assert "secondary packaging" in body
    # The measured case, so the rule is not an unbacked assertion.
    assert "78 %" in body


def test_the_review_skill_says_to_bring_the_prose_along_after_a_review():
    """V116/V115: a review finding lands on something described twice — inventory and prose.

    Measured: a reviewer showed a label at 2.13 % did not qualify for a "below 1 %" cut-off;
    the model added the label and updated `cutoff_criteria`, and left the process comment saying the
    label was excluded. That comment is what the report's inventory chapter prints. The duty lives in
    the critical-review skill, where the finding is handled.
    """
    from prism_lca.engine.builtin_skills import BUILTIN_SKILLS

    body = next(s for s in BUILTIN_SKILLS if s["id"] == "builtin-review")["content"]
    assert "Re-read what you wrote before the fix" in body
    assert "process comment" in body
    assert "cut-off" in body
