"""The short report: a stored-report definition that is never stored.

What these pin: the definition admits only deterministic chapters and follows the rail's switches; the
three routes run the stored pipeline end to end (snapshot + token → typeset PDF / PNG page); the memo
answers a second identical request without recomputing; nothing a model produced is printed (D1); and
two breakdown dimensions become two contribution chapters over distinct data.
"""
from __future__ import annotations

import base64
import json

import pytest

from prism_lca.engine import report_pipeline, report_short, report_snapshot
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.report_kinds import PROSE_KINDS


@pytest.fixture(autouse=True)
def _clean_cache():
    report_snapshot.invalidate()
    yield
    report_snapshot.invalidate()


def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("eco").write(
        {
            ("eco", "elec"): {
                "name": "market for electricity", "unit": "kWh", "reference product": "electricity",
                "location": "DE",
                "exchanges": [
                    {"input": ("eco", "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.4, "type": "biosphere"},
                ],
            },
            ("eco", "pet"): {
                "name": "market for PET", "unit": "kg", "reference product": "PET", "location": "GLO",
                "exchanges": [
                    {"input": ("eco", "pet"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Database("sh").write(
        {
            ("sh", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle", "location": "DE",
                "exchanges": [
                    {"input": ("sh", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("sh", "cap"), "amount": 1, "type": "technosphere"},
                    {"input": ("eco", "pet"), "amount": 0.03, "type": "technosphere"},
                    {"input": ("eco", "elec"), "amount": 0.2, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.01, "type": "biosphere"},
                ],
            },
            ("sh", "cap"): {
                "name": "cap", "unit": "unit", "reference product": "cap", "location": "DE",
                "exchanges": [
                    {"input": ("sh", "cap"), "amount": 1, "type": "production"},
                    {"input": ("eco", "pet"), "amount": 0.003, "type": "technosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])
    bd.Method(("t", "ap")).write([(("biosphere", "co2"), 0.5)])


def _settings(**over) -> report_short.ShortSettings:
    base = {"database": "sh", "code": "bottle", "methods": [["t", "gwp"]]}
    base.update(over)
    return report_short.ShortSettings(**base)


# ---- the definition ----------------------------------------------------------------------------
def test_the_definition_carries_only_deterministic_chapters(project):
    _seed(get_bd())
    report = report_short.definition(_settings(contents={k: True for k in PROSE_KINDS}))
    kinds = [s["kind"] for s in report["sections"]]
    assert not set(kinds) & set(PROSE_KINDS)
    # The defaults: goal & scope, the system model, the inventory, methods, results, checks, limits,
    # references, reproducibility — and no contribution chapter without a dimension.
    assert kinds == [
        "goal_scope", "system_model", "inventory", "methods", "lcia", "interpretation_checks",
        "limitations", "references", "provenance",
    ]
    assert report["id"] == report_short.SHORT_ID
    assert report["options"]["figures"] == {"heatmap": False, "radar": False, "stacked": False}
    # Titled after the reference process — the study goal as a title was a sentence on a cover (07.09.2026).
    assert report["name"] == "bottle"
    # The glossary never: resolving acronyms is a model's job, and the short report has none.
    assert "abbreviations" not in [
        x["kind"] for x in report_short.definition(_settings(contents={"abbreviations": True}))["sections"]
    ]


def test_a_title_and_subtitle_of_your_own_reach_the_cover_without_a_new_study(project, monkeypatch):
    """The rail's "Title & language" group: an own title replaces the reference process on the cover, a
    subtitle is printed under it — and neither moves a number, so changing them reuses the computed study."""
    _seed(get_bd())
    calls: list[int] = []
    real = report_pipeline._compute_render_inputs

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(report_pipeline, "_compute_render_inputs", counting)
    _, _, plain, _ = report_short.document(_settings())
    assert 'title: "bottle",' in plain["main.typ"]
    _, _, own, _ = report_short.document(_settings(title="  Glass or PET? ", subtitle="A first look"))
    assert 'title: "Glass or PET?",' in own["main.typ"]
    assert 'subtitle: "A first look",' in own["main.typ"]
    assert len(calls) == 1, "a title is dress, not data — the study was computed once"


def test_the_datasets_table_prints_once(project):
    _seed(get_bd())
    both = report_short.definition(_settings(contents={"datasets": True}))
    inventory = next(x for x in both["sections"] if x["kind"] == "inventory")
    assert inventory["inventory_parts"] == ["processes"]
    assert any(x["kind"] == "datasets" for x in both["sections"])
    alone = report_short.definition(_settings())
    assert next(x for x in alone["sections"] if x["kind"] == "inventory")["inventory_parts"] == ["processes", "datasets"]


def test_switches_and_variants_reach_the_definition(project, client, token):
    _seed(get_bd())
    from prism_lca.engine.scenarios import ScenarioStore

    scenario_id = ScenarioStore().create("sh", "Thin cap")["id"]
    s = _settings(
        contents={"appendix": True, "inventory": False},
        breakdowns=["geo", "tag:Stage"],
        compare=[{"code": "cap"}, {"scenario": scenario_id}],
        heatmap=True,
        per_indicator_charts="lead",
        hotspots=False,
        per_process=2,
        lang="de",
    )
    report = report_short.definition(s)
    kinds = [x["kind"] for x in report["sections"]]
    assert "appendix" in kinds and "inventory" not in kinds
    # Two breakdowns → two contribution chapters; the first is the report's own dimension.
    contrib = [x for x in report["sections"] if x["kind"] == "contribution"]
    assert len(contrib) == 2
    assert report["aggregate_by"] == "geo" and "aggregate_by" not in contrib[0]
    assert contrib[1]["aggregate_by"] == "tag:Stage"
    assert all(x["hotspots"] is False for x in contrib)
    assert next(x for x in report["sections"] if x["kind"] == "lcia")["per_indicator_charts"] == "lead"
    assert next(x for x in report["sections"] if x["kind"] == "system_model")["per_process"] == 2
    assert report["subjects"][0] == {"database": "sh", "code": "bottle"}
    assert {"database": "sh", "code": "cap"} in report["subjects"]
    assert any(x.get("scenario") == scenario_id and x.get("scenario_name") == "Thin cap" for x in report["subjects"])
    assert report["lang"] == "de" and report["options"]["figures"]["heatmap"] is True



def test_a_variant_that_is_not_this_models_is_left_out(project):
    """The variants travel with the request; only this model's scenarios and processes may become one.

    Another model's scenario used to be applied to this one — its overrides on any parameter of the same
    name, the rest skipped — and printed under its bare id; a deleted scenario or process was announced as
    a variant that "could not be computed". The rail lists only this model's own, so none of them had a
    checkbox to untick. All are left out; another process of the model still counts.
    """
    _seed(get_bd())
    from prism_lca.engine.scenarios import ScenarioStore

    store = ScenarioStore()
    own = store.create("sh", "Thin cap")["id"]
    foreign = store.create("eco", "Somebody else's")["id"]
    report = report_short.definition(
        _settings(
            compare=[
                {"scenario": foreign},
                {"scenario": own},
                {"scenario": "deleted-long-ago"},
                {"code": "cap"},
                {"code": "pet"},  # a process of another database
                {"code": "gone"},
            ]
        )
    )
    assert [x.get("scenario") for x in report["subjects"] if x.get("scenario")] == [own]
    assert [x["code"] for x in report["subjects"] if not x.get("scenario")] == ["bottle", "cap"]

# ---- the routes --------------------------------------------------------------------------------
def test_sources_then_pdf_is_one_study(client, token, project, monkeypatch):
    _seed(get_bd())
    calls: list[int] = []
    real = report_pipeline._compute_render_inputs

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(report_pipeline, "_compute_render_inputs", counting)
    body = {"database": "sh", "code": "bottle", "methods": [["t", "gwp"], ["t", "ap"]], "breakdowns": ["geo"]}
    r = client.post("/api/v1/report/short/sources", json=body, headers=token)
    assert r.status_code == 200, r.text
    snap = r.json()
    assert snap["render_token"] and snap["language"] == "en"
    assert [x["method_label"] for x in snap["data"]["results"]] == ["t / gwp", "t / ap"]
    assert snap["data"]["system_model"]["counts"]["processes"] == 2
    assert snap["data"]["breakdown_dimensions"] == ["geo"]
    # The system-model section travels with the sources, so the renderer knows to draw it.
    assert any(s["kind"] == "system_model" for s in snap["sections"])
    assert len(calls) == 1

    r = client.post(
        "/api/v1/report/short/pdf",
        json={**body, "render_token": snap["render_token"], "figures": {"system-model": "<svg xmlns='http://www.w3.org/2000/svg'/>"}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["filename"].endswith(".pdf")
    assert base64.b64decode(out["base64"]).startswith(b"%PDF")
    assert len(calls) == 1, "the token spared the second study"

    # A third identical request without the token is served from the memo, not recomputed.
    r = client.post("/api/v1/report/short/sources", json=body, headers=token)
    assert r.status_code == 200
    assert len(calls) == 1


def test_preview_pages_and_reuses_the_typeset_document(client, token, project):
    _seed(get_bd())
    body = {"database": "sh", "code": "bottle", "methods": [["t", "gwp"]], "lang": "fr"}
    r = client.post("/api/v1/report/short/preview", json={**body, "page": 1}, headers=token)
    assert r.status_code == 200, r.text
    first = r.json()
    assert first["page"] == 1 and first["pages"] >= 2
    assert base64.b64decode(first["base64"])[:8] == b"\x89PNG\r\n\x1a\n"
    r = client.post("/api/v1/report/short/preview", json={**body, "page": 2, "reuse": True}, headers=token)
    assert r.status_code == 200 and r.json()["page"] == 2
    assert r.json()["missing_placeholders"] == []


def test_nothing_a_model_produced_reaches_the_short_report(project, monkeypatch):
    """Decision D1: the research log and the review log are assistant output and stay out."""
    _seed(get_bd())
    monkeypatch.setattr(
        report_pipeline.ReviewLogStore, "for_report", lambda self, db, gen: {"open": [{"finding": "leaked", "reason": "x"}]}
    )
    monkeypatch.setattr(report_pipeline.ResearchLogStore, "list", lambda self, db: [{"question": "q", "findings": []}])
    _report, inputs, sources, _info = report_short.document(_settings())
    assert inputs["review"] == {} and inputs["web_research"] == []
    assert "leaked" not in sources["main.typ"]


def test_two_dimensions_give_two_chapters_over_distinct_data(client, token, project):
    _seed(get_bd())
    r = client.post(
        "/api/v1/report/short/sources",
        json={"database": "sh", "code": "bottle", "methods": [["t", "gwp"]], "breakdowns": ["geo", "isic"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["breakdown_dimensions"] == ["geo", "isic"]
    assert set(data["contributions_by_dimension"]) == {"geo", "isic"}
    geo = data["contributions_by_dimension"]["geo"][0]["groups"]
    isic = data["contributions_by_dimension"]["isic"][0]["groups"]
    assert {g["key"] for g in geo} == {"DE", "GLO"}
    assert {g["key"] for g in isic} != {g["key"] for g in geo}
    tables = json.loads(r.json()["files"]["tables.json"])
    # Both chapters print, each under its own labels — a second chapter must not reuse the first's. The
    # label is the table's key in `tables.json`.
    # Its labels are the cross-reference targets in `main.typ`; the data keys in `tables.json` name what
    # each table is, so they are checked apart.
    main = r.json()["files"]["main.typ"]
    for label in ("t-contribution", "t-contribution-d1", "t-contribution-hotspots"):
        assert f'label-name: "{label}"' in main
    assert len({key for key in tables if "contribution:" in key}) >= 2


def test_a_missing_theme_is_refused_before_the_study_is_computed(project):
    _seed(get_bd())
    with pytest.raises(Exception) as exc:
        report_short.definition(_settings(template="no-such-theme"))
    assert "no-such-theme" in str(exc.value) or "template" in str(exc.value).lower()
