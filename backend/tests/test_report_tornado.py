"""The parameter tornado in a report: computed for the reference process at its baseline, kept in the
snapshot under `checks.tornado`, printed under the scenario sensitivity check, offered to the writer.

Model: test_sensitivity_runs' bottle — `kwh` a plain input, `share` 0.95 within 0…1 (so +25 % stops at 1),
`choice` from a list, `const` a formula of numbers alone, `derived` calculated from `kwh`, `fixedc` a
one-value list.
"""
from __future__ import annotations

import base64

import pytest
from test_sensitivity_runs import DOUBLE, METHOD, _model

from prism_lca.engine import param_window, report_prompts, report_tornado, sensitivity
from prism_lca.engine import report_model as rm
from prism_lca.engine.report_model import render_blocks


@pytest.fixture(autouse=True)
def _clean():
    yield
    param_window.reset_for_tests()


def _short(client, token, **extra) -> dict:
    body = {"database": "fg", "code": "bottle", "methods": [METHOD, DOUBLE],
            "contents": {"interpretation_checks": True}, **extra}
    r = client.post("/api/v1/report/short/sources", json=body, headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def test_the_tornado_lands_in_the_snapshot_for_the_chosen_indicators(client, token, project):
    _model(client, token)
    snap = _short(client, token, tornado=True, tornado_methods=[DOUBLE], tornado_delta=0.25)
    blocks = snap["data"]["checks"]["tornado"]
    assert [b["method_label"] for b in blocks] == ["t / double"]
    block = blocks[0]
    assert block["delta_text"] == "±25 %" and block["reference"]
    names = [p["name"] for p in block["parameters"]]
    # The numbers are the tab's: same analysis, the baseline of the reference process.
    direct = sensitivity.tornado("fg", "bottle", [DOUBLE], 0.25)
    by_name = {e["param"]: e for e in direct["entries"]}
    for p in block["parameters"]:
        assert p["low"] == pytest.approx(by_name[p["name"]]["low"][0], rel=1e-12)
        assert p["high"] == pytest.approx(by_name[p["name"]]["high"][0], rel=1e-12)
    swings = [abs(p["high_change"] - p["low_change"]) for p in block["parameters"]]
    assert swings == sorted(swings, reverse=True), "ranked by how far each moves the indicator"
    share = next(p for p in block["parameters"] if p["name"] == "share")
    assert share["limited"] and share["step_high_text"] != "+25 %"
    assert "derived" not in names and "fixedc" not in names
    assert block["not_varied"] == {"has_formula": 1, "zero_value": 0, "fixed": 1}
    assert block["labels"]["axis"] == "Change of the result"


def test_without_the_option_there_is_no_tornado(client, token, project):
    _model(client, token)
    snap = _short(client, token)
    assert "tornado" not in snap["data"]["checks"]


def test_the_pdf_carries_the_figure(client, token, project):
    _model(client, token)
    snap = _short(client, token, tornado=True)
    key = rm.chart_key("tornado", snap["data"]["checks"]["tornado"][0]["method_label"])
    r = client.post("/api/v1/report/short/pdf", headers=token, json={
        "database": "fg", "code": "bottle", "methods": [METHOD, DOUBLE], "contents": {"interpretation_checks": True},
        "tornado": True, "render_token": snap["render_token"],
        "figures": {key: "<svg xmlns='http://www.w3.org/2000/svg'/>"},
    })
    assert r.status_code == 200, r.text
    assert base64.b64decode(r.json()["base64"]).startswith(b"%PDF")


# ---- rows and blocks, on numbers of our own ----------------------------------------------------------
def _raw(entries, baseline=(10.0, 0.0), delta=0.1, skipped=()):
    return {"methods": [["t", "a"], ["t", "b"]], "units": ["kg", "m3"], "baseline": list(baseline),
            "delta": delta, "entries": entries, "skipped": list(skipped)}


def _entry(name, base, low, high, **extra):
    return {"param": name, "base": base, "low_value": base * 0.9, "high_value": base * 1.1,
            "low": list(low), "high": list(high), **extra}


def _data():
    return {"results": [{"method": ["t", "a"], "method_label": "t / a", "unit": "kg"},
                        {"method": ["t", "b"], "method_label": "t / b", "unit": "m3"}],
            "parameters": [{"name": "x", "unit": "km"}], "activity": {"name": "Bottle"}}


def test_each_indicator_ranks_its_own_parameters():
    entries = [_entry("x", 2.0, (9.0, 0.5), (11.0, -0.5)), _entry("y", 1.0, (5.0, 0.0), (15.0, 0.0)),
               _entry("z", 1.0, (10.0, 0.0), (10.0, 0.0))]
    rows = report_tornado.rows(_raw(entries), _data(), "de")
    a, b = rows
    assert [p["name"] for p in a["parameters"]] == ["y", "x"]  # z moves nothing
    assert a["unmoved"] == 1 and a["more"] == 0
    assert a["parameters"][0]["low_text"] == "-50 %" and a["parameters"][0]["high_text"] == "+50 %"
    assert a["parameters"][1]["unit"] == "km" and a["parameters"][1]["swing_text"] == "20,0 %"
    # A result of 0 has no percentage: the change in its unit instead.
    assert not b["relative"] and [p["name"] for p in b["parameters"]] == ["x"]
    assert b["parameters"][0]["low_text"] == "+0,5 m3" and b["labels"]["axis"].endswith("(m3; das Ergebnis ist 0)")


def test_ten_are_shown_and_the_rest_counted():
    entries = [_entry(f"p{i}", 1.0, (10.0 - i - 1, 0.0), (10.0 + i + 1, 0.0)) for i in range(13)]
    row = report_tornado.rows(_raw(entries), _data(), "en")[0]
    assert len(row["parameters"]) == report_tornado.TOP and row["more"] == 3
    assert row["parameters"][0]["name"] == "p12"


def test_a_failure_or_an_empty_model_says_so():
    data = _data()
    assert report_tornado.rows({"error": "boom", "delta": 0.1}, data, "en") == []
    assert "boom" in report_tornado.note({"error": "boom", "delta": 0.1}, data, "en")
    assert "Bottle has no parameter" in report_tornado.note(_raw([]), data, "en")
    assert report_tornado.rows(None, data, "en") is None


def test_the_section_prints_a_figure_or_else_a_table_and_explains_the_marks():
    entries = [_entry("x", 2.0, (9.0, 0.5), (11.0, -0.5), limited={"high": "between 0 and 1"}),
               _entry("y", 1.0, (5.0, 0.0), (15.0, 0.0), breaks={"low": [{"param": "rest", "value": -0.1}]})]
    data = {**_data(), "checks": {}}
    data["checks"]["tornado"] = report_tornado.rows(_raw(entries, skipped=[{"reason": "has_formula"}]), data, "en")
    key = rm.chart_key("tornado", "t / a")
    with_figure = render_blocks(report_tornado.blocks(data, {key: "<svg/>"}, "en"))
    assert "f-tornado-0" in with_figure and "t-tornado-0" not in with_figure
    assert "t-tornado-1" in with_figure  # the second indicator had no figure: its table
    assert "x (" in with_figure and "y → rest" in with_figure
    assert "1 calculated from other parameters" in with_figure
    assert report_tornado.blocks({"checks": {}}, {}, "en") == []


def test_a_report_without_scenarios_is_not_told_it_lacks_a_sensitivity_check():
    from prism_lca.engine import report_checks

    data = {**_data(), "checks": {"tornado": []}, "subjects": []}
    out = render_blocks(report_checks.interpretation_blocks(data, {}, "en", "Checks"))
    assert "parameter sensitivity below" in out and "ISO 14044 asks" not in out


def test_the_writer_is_offered_each_figure():
    data = {**_data(), "checks": {"tornado": report_tornado.rows(
        _raw([_entry("x", 2.0, (9.0, 0.5), (11.0, -0.5))]), _data(), "en")}}
    section = {"id": "s1", "kind": "interpretation_checks"}
    report = {"sections": [section], "options": {"tornado": {"enabled": True}}}
    labels = [r["ref"] for r in report_prompts.renders_for(section, report, data)]
    labels = [x[len("{{ref:"):-2] for x in labels]
    assert "f-tornado-0" in labels and "f-tornado-1" in labels
    off = {"sections": [section], "options": {}}
    assert report_prompts.switched_off_figure("f-tornado-0", off) == "Parameter sensitivity (tornado)"
    assert report_prompts.switched_off_figure("f-tornado-0", report) is None


def test_the_option_is_checked_when_it_is_written(client, token, project):
    _model(client, token)
    r = client.post("/api/v1/report/create", json={"database": "fg"}, headers=token)
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    bad = client.post(f"/api/v1/report/one/fg/{rid}", headers=token,
                      json={"options": {"tornado": {"enabled": True, "delta": 1.5}}})
    assert bad.status_code == 400
    ok = client.post(f"/api/v1/report/one/fg/{rid}", headers=token,
                     json={"options": {"tornado": {"enabled": True, "methods": [METHOD], "delta": 0.25}}})
    assert ok.status_code == 200 and ok.json()["affects_staleness"] is True
    assert ok.json()["options"]["tornado"] == {"enabled": True, "methods": [METHOD], "delta": 0.25}


def test_a_parameter_that_moves_the_result_the_same_way_both_steps_is_ranked_by_how_far():
    """Both steps raise the result by 10 %: the ends are equal, the parameter is not without effect."""
    entries = [_entry("even", 1.0, (11.0, 0.0), (11.0, 0.0)), _entry("small", 1.0, (9.5, 0.0), (10.5, 0.0))]
    row = report_tornado.rows(_raw(entries), _data(), "en")[0]
    assert [p["name"] for p in row["parameters"]] == ["even", "small"] and row["unmoved"] == 0


def test_a_switch_from_zero_says_where_it_went():
    entry = {**_entry("switch", 0.0, (10.0, 0.0), (12.0, 0.0)), "low_value": 0.0, "high_value": 1.0,
             "limited": {"low": "one of 0, 1", "high": "one of 0, 1"}}
    p = report_tornado.rows(_raw([entry]), _data(), "en")[0]["parameters"][0]
    assert (p["step_low_text"], p["step_high_text"]) == ("= 0", "= 1")


def test_a_chapter_citing_the_tornado_is_held_to_its_signs_and_its_settings():
    from prism_lca.engine import report_staleness as rs

    data = {**_data(), "checks": {}}
    data["checks"]["tornado"] = report_tornado.rows(_raw([_entry("x", 2.0, (9.0, 0.5), (11.0, -0.5))]), data, "en")
    report = {"methods": [["t", "a"], ["t", "b"]], "subjects": [], "options": {"tornado": {"enabled": True,
                                                                                           "delta": 0.25}}}
    text = "Lowering {{checks.tornado.0.parameters.0.name}} changes it by {{checks.tornado.0.parameters.0.low_text}}."
    record = rs.components(text, {}, report, data)
    assert record["bands"]["checks.tornado.0.parameters.0.low_text"]["sign"] == -1
    assert record["selection"]["tornado"].startswith("±25 % on")
    assert "tornado" not in rs.components("No tornado here.", {}, report, data)["selection"]
    figure_only = rs.components("As {{ref:f-tornado-0}} shows, …", {}, report, data)
    assert "tornado" in figure_only["selection"]
    moved = {**record["selection"], "tornado": "±10 % on t / a"}
    assert "parameter tornado" in (rs._selection_message(record["selection"], moved) or "")
