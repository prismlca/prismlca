

def test_a_residual_that_is_empty_everywhere_is_not_printed():
    """V312. A real phase at zero is a statement — a coating's use phase carries no climate impact.
    The residual bucket at zero is not: it says only that everything was tagged, and it cost a table
    row, an empty group on the chart axis and one of six legend colours. It goes only when it is
    empty in the baseline AND in every variant."""
    from prism_lca.engine.report_data import _drop_empty_residual

    view = {
        "groups": [
            {"key": "Production", "impact": 1.0},
            {"key": "Use", "impact": 0.0},
            {"key": "(untagged)", "impact": 0.0},
        ],
        "top": {"key": "Production", "impact": 1.0},
    }
    subjects = [{"groups": [{"key": "Production", "impact": 1.2}, {"key": "(untagged)", "impact": 0.0}]}]
    _drop_empty_residual(view, subjects)
    assert [g["key"] for g in view["groups"]] == ["Production", "Use"]
    assert [g["key"] for g in subjects[0]["groups"]] == ["Production"]

    # Counter-case: non-zero in ONE variant is a fact about that variant, and it stays everywhere.
    view2 = {"groups": [{"key": "Production", "impact": 1.0}, {"key": "(untagged)", "impact": 0.0}], "top": None}
    subjects2 = [{"groups": [{"key": "(untagged)", "impact": 0.3}]}]
    _drop_empty_residual(view2, subjects2)
    assert [g["key"] for g in view2["groups"]] == ["Production", "(untagged)"]
    assert [g["key"] for g in subjects2[0]["groups"]] == ["(untagged)"]
