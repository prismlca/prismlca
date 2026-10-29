from __future__ import annotations

import json
import re

from prism_lca.engine import report_typst
from prism_lca.engine.bootstrap import get_bd


def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("rr").write(
        {
            ("rr", "w"): {
                "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
                "exchanges": [
                    {"input": ("rr", "w"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 3.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _report(client, token, **kw):
    payload = {"database": "rr", "methods": [["t", "gwp"]], "subjects": [{"database": "rr", "code": "w"}]}
    payload.update(kw)
    return client.post("/api/v1/report/create", json=payload, headers=token).json()


def _add_prose(client, token, rep, database=None):
    """Add a free prose chapter and return it.

    The default structure used to include an anonymous "Written chapter", and these tests borrowed it.
    It now starts with the concrete ISO chapters instead (methods, interpretation checks, conclusions),
    so a test that needs a prose chapter asks for one.
    """
    db = database or rep.get("database") or "rr"
    return client.post(
        f"/api/v1/report/one/{db}/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()


def test_a_stored_report_renders_its_sections_in_order(client, token, project):
    _seed(get_bd())
    client.post("/api/v1/study", json={"database": "rr", "goal": "Widget PCF", "functional_unit": "1 widget"}, headers=token)
    rep = _report(client, token, name="Client version", lang="de")

    r = client.post(f"/api/v1/report/one/rr/{rep['id']}/sources", json={}, headers=token)
    assert r.status_code == 200, r.text
    main = r.json()["files"]["main.typ"]
    # German titles, in the stored order, and the identifiers untranslated.
    assert main.index("Ziel und Untersuchungsrahmen") < main.index("Wirkungsabschätzung")
    assert "t / gwp" in main
    # A new report carries the shipped cover picture — a JPEG, so named .jpg — and the colophon's mark.
    # No author logo: nothing is stored for this project, and PrismLCA's own no longer stands in.
    assert r.json()["binary"] == ["cover.jpg", "prism-mark.png"]

    pdf = client.post(f"/api/v1/report/one/rr/{rep['id']}/pdf", json={}, headers=token)
    assert pdf.status_code == 200, pdf.text
    import base64

    assert base64.b64decode(pdf.json()["base64"]).startswith(b"%PDF")
    assert pdf.json()["missing_placeholders"] == []


def test_reordering_sections_reorders_the_document(client, token, project):
    _seed(get_bd())
    rep = _report(client, token)
    ids = [s["id"] for s in rep["sections"]]
    before = client.post(f"/api/v1/report/one/rr/{rep['id']}/sources", json={}, headers=token).json()["files"]["main.typ"]
    client.post(f"/api/v1/report/one/rr/{rep['id']}/reorder", json={"order": list(reversed(ids))}, headers=token)
    after = client.post(f"/api/v1/report/one/rr/{rep['id']}/sources", json={}, headers=token).json()["files"]["main.typ"]
    assert before != after
    # The annex was last and is now first.
    assert after.index("Annex") < after.index("Goal and scope")


def test_prose_placeholders_resolve_against_the_same_numbers_as_the_tables(client, token, project):
    _seed(get_bd())
    rep = _report(client, token)
    prose = _add_prose(client, token, rep)
    client.post(
        f"/api/v1/report/one/rr/{rep['id']}/sections/{prose['id']}",
        json={"kind": "prose", "text": "The total is {{results.0.score}} {{results.0.unit}}; see {{ref:t-lcia}}."},
        headers=token,
    )
    out = client.post(f"/api/v1/report/one/rr/{rep['id']}/sources", json={}, headers=token).json()
    main = report_typst.document_text(out["files"])
    assert out["missing_placeholders"] == []
    assert "@t-lcia" in main
    # 3 kg CO2 x factor 1.0 — the same number the LCIA table carries.
    assert "3" in main


def test_an_unresolved_placeholder_is_named_rather_than_hidden(client, token, project):
    _seed(get_bd())
    rep = _report(client, token)
    prose = _add_prose(client, token, rep)
    client.post(
        f"/api/v1/report/one/rr/{rep['id']}/sections/{prose['id']}",
        json={"kind": "prose", "text": "Nonsense: {{does.not.exist}}"},
        headers=token,
    )
    # The export gate: a deliverable with a hole refuses by default and names the gap…
    refused = client.post(f"/api/v1/report/one/rr/{rep['id']}/pdf", json={}, headers=token)
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "report_has_gaps"
    assert "does.not.exist" in refused.json()["error"]["message"]
    # …and exporting anyway is a decision, made explicitly.
    out = client.post(f"/api/v1/report/one/rr/{rep['id']}/pdf", json={"allow_gaps": True}, headers=token).json()
    assert out["missing_placeholders"] == ["does.not.exist"]
    assert base64_ok(out["base64"])  # still renders — a hole is visible, not fatal


def base64_ok(b64: str) -> bool:
    import base64 as b

    return b.b64decode(b64).startswith(b"%PDF")


def test_the_annex_carries_parameters_and_the_provenance_block(client, token, project):
    _seed(get_bd())
    client.post("/api/v1/params", json={"database": "rr", "name": "mass", "amount": 2.5, "unit": "kg"}, headers=token)
    rep = _report(client, token, sections=[{"kind": "appendix"}, {"kind": "provenance"}, {"kind": "references"}])
    main = client.post(f"/api/v1/report/one/rr/{rep['id']}/sources", json={}, headers=token).json()["files"]
    main = report_typst.document_text(main)
    assert "mass" in main and "Parameters" in main
    assert "Reproducibility" in main and "Software version" in main
    assert "ISO 14044" in main  # references list what the study actually used, plus the standards


def test_an_incomplete_report_says_what_is_missing(client, token, project):
    _seed(get_bd())
    rep = client.post("/api/v1/report/create", json={"database": "rr"}, headers=token).json()
    r = client.post(f"/api/v1/report/one/rr/{rep['id']}/pdf", json={}, headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "report_incomplete"


def test_an_unknown_section_kind_in_a_stored_report_does_not_break_the_render(client, token, project):
    """Forward compatibility: a report written by a newer version must still produce a document."""
    from prism_lca.engine import report_render

    report = {"lang": "en", "sections": [{"kind": "sparkline", "title": "Trends", "order": 0}]}
    blocks, missing = report_render.blocks_for(report, {}, {"results": []}, None, {})
    rendered = " ".join(b.get("text", "") for b in blocks)
    assert "Trends" in rendered and "not supported" in rendered and missing == []


def test_a_supplied_chart_lands_in_the_sources_and_in_the_document(client, token, project):
    """Charts are drawn in the renderer, where echarts lives, and handed over as SVG — the backend
    never draws, so a report figure and the on-screen chart cannot diverge."""
    _seed(get_bd())
    rep = _report(client, token, sections=[{"kind": "lcia"}])
    from prism_lca.engine import report_model as rm

    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#93c120"/></svg>'
    key = "lcia:t / gwp"
    out = client.post(
        f"/api/v1/report/one/rr/{rep['id']}/sources",
        json={"figures": {key: svg}},
        headers=token,
    ).json()
    # Placed under a file named from the key, listed in `figures.json`, read through `#pfigure`.
    path = rm.chart_path(key)
    assert path in out["files"] and path.startswith("charts/lcia-t-gwp-")
    assert json.loads(out["files"]["figures.json"]) == {key: path}
    assert f'#pfigure(\n  "{key}",' in out["files"]["main.typ"]

    pdf = client.post(
        f"/api/v1/report/one/rr/{rep['id']}/pdf", json={"figures": {key: svg}}, headers=token
    )
    assert pdf.status_code == 200, pdf.text
    import base64

    assert base64.b64decode(pdf.json()["base64"]).startswith(b"%PDF")


def test_a_figure_for_a_section_that_is_not_there_is_ignored(client, token, project):
    """Removing or reordering a section takes its chart with it — no orphan figure appears."""
    _seed(get_bd())
    rep = _report(client, token, sections=[{"kind": "goal_scope"}])
    out = client.post(
        f"/api/v1/report/one/rr/{rep['id']}/sources",
        json={"figures": {"contribution": "<svg xmlns='http://www.w3.org/2000/svg'/>"}},
        headers=token,
    ).json()
    assert "#lca-figure(" not in out["files"]["main.typ"]


def _seed_two(bd) -> None:
    """Two comparable products in one model — the normal consulting case."""
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("cmp").write(
        {
            ("cmp", "pet"): {
                "name": "PET bottle", "unit": "unit", "reference product": "bottle", "location": "GLO",
                "exchanges": [
                    {"input": ("cmp", "pet"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.4, "type": "biosphere"},
                ],
            },
            ("cmp", "glass"): {
                "name": "Glass bottle", "unit": "unit", "reference product": "bottle", "location": "GLO",
                "exchanges": [
                    {"input": ("cmp", "glass"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 1.2, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])


def test_two_subjects_become_a_comparison_matrix(client, token, project):
    _seed_two(get_bd())
    rep = client.post(
        "/api/v1/report/create",
        json={
            "database": "cmp",
            "methods": [["t", "gwp"]],
            "subjects": [
                {"database": "cmp", "code": "pet"},
                {"database": "cmp", "code": "glass"},
            ],
            "sections": [{"kind": "lcia"}],
        },
        headers=token,
    ).json()
    out = client.post(f"/api/v1/report/one/cmp/{rep['id']}/sources", json={}, headers=token).json()
    main = report_typst.document_text(out["files"])
    # Rows are subjects, so both appear with their own score — one table, not two sections.
    assert "PET bottle" in main and "Glass bottle" in main
    assert main.count("#ptable(") == 1
    assert "Subject" in main
    # Both subjects are in the data snapshot, so prose can name either one.
    labels = [s["label"] for s in out["data"]["subjects"]]
    assert labels == ["PET bottle", "Glass bottle"]
    scores = [s["results"][0]["score"] for s in out["data"]["subjects"]]
    assert scores[1] > scores[0] > 0


def test_a_single_subject_keeps_the_simpler_table(client, token, project):
    _seed_two(get_bd())
    rep = client.post(
        "/api/v1/report/create",
        json={
            "database": "cmp",
            "methods": [["t", "gwp"]],
            "subjects": [{"database": "cmp", "code": "pet"}],
            "sections": [{"kind": "lcia"}],
        },
        headers=token,
    ).json()
    main = client.post(f"/api/v1/report/one/cmp/{rep['id']}/sources", json={}, headers=token).json()["files"]
    main = report_typst.document_text(main)
    # "Indicator", not "Subject": one subject keeps the simple three-column table rather than a matrix.
    assert "Indicator" in main and "Subject" not in main


def test_a_comparison_renders_to_pdf(client, token, project):
    _seed_two(get_bd())
    rep = client.post(
        "/api/v1/report/create",
        json={
            "database": "cmp",
            "lang": "de",
            "methods": [["t", "gwp"]],
            "subjects": [{"database": "cmp", "code": "pet"}, {"database": "cmp", "code": "glass"}],
        },
        headers=token,
    ).json()
    r = client.post(f"/api/v1/report/one/cmp/{rep['id']}/pdf", json={}, headers=token)
    assert r.status_code == 200, r.text
    import base64

    assert base64.b64decode(r.json()["base64"]).startswith(b"%PDF")


def test_prose_can_compare_the_subjects_by_placeholder(client, token, project):
    _seed_two(get_bd())
    rep = client.post(
        "/api/v1/report/create",
        json={
            "database": "cmp",
            "methods": [["t", "gwp"]],
            "subjects": [{"database": "cmp", "code": "pet"}, {"database": "cmp", "code": "glass"}],
            "sections": [{"kind": "prose", "text": "{{subjects.0.label}} scores {{subjects.0.results.0.score}}, {{subjects.1.label}} scores {{subjects.1.results.0.score}}."}],
        },
        headers=token,
    ).json()
    out = client.post(f"/api/v1/report/one/cmp/{rep['id']}/sources", json={}, headers=token).json()
    assert out["missing_placeholders"] == []
    # The document *looks the figures up* rather than containing them: that is what lets an exported
    # project pick up new numbers, and it is the whole reason `values.json` exists.
    main = report_typst.document_text(out["files"])
    # Scoped per section (sec-<id>:token), so two chapters citing the same ranked token with different
    # bindings cannot overwrite each other's figure in values.json.
    assert re.search(r'#pval\("sec-[0-9a-f]+:subjects\.0\.label"\)', main), main
    assert re.search(r'#pval\("sec-[0-9a-f]+:subjects\.0\.results\.0\.score"\)', main)
    assert '#let _values = json("values.json")' in main
    values = json.loads(out["files"]["values.json"])
    # The bare token stays beside the scoped one: exported chapters are the user's, and "update only
    # the data" must keep satisfying the #pval calls those files already contain.
    assert values["subjects.0.label"] == "PET bottle"
    scoped = [k for k in values if k.endswith(":subjects.0.label")]
    assert scoped and values[scoped[0]] == "PET bottle"
    assert values["subjects.0.results.0.score"]


# ---- annex: the elementary flows (added with the inventory section) ----------
def test_the_annex_lists_the_flows_that_carry_the_leading_indicator():
    """What a reviewer asks for first. Characterised flows, not the raw inventory: the question the
    annex answers is "where does this number come from", and a few thousand uncharacterised rows answer
    it worse than the handful that move it."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _inventory_blocks

    data = {
        "inventory": {
            "method": ["IPCC 2021", "climate change", "GWP100"],
            "flows": [
                {"flow": "Carbon dioxide, fossil", "categories": ["air"], "unit": "kg", "impact": 1.8, "share": 0.9},
                {"flow": "Methane, fossil", "categories": ["air", "urban"], "unit": "kg", "impact": 0.2, "share": 0.1},
            ],
        }
    }
    out = render_blocks(_inventory_blocks(data, "en"))
    assert "Carbon dioxide, fossil" in out
    assert "air / urban" in out  # the compartment path, not just the top level
    assert "IPCC 2021 / climate change / GWP100" in out  # which indicator the table is about
    assert "90" in out and "%" in out


def test_no_inventory_means_no_empty_annex_table():
    from prism_lca.engine.report_render import _inventory_blocks

    assert _inventory_blocks({}, "en") == []
    assert _inventory_blocks({"inventory": {"flows": []}}, "en") == []


def test_the_annex_inventory_follows_the_report_language():
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _inventory_blocks

    data = {"inventory": {"method": ["X"], "flows": [{"flow": "CO2", "categories": [], "unit": "kg",
                                                     "impact": 1234.5, "share": 1.0}]}}
    out = render_blocks(_inventory_blocks(data, "de"))
    assert "Sachbilanz" in out and "Elementarfluss" in out
    # German groups thousands with a dot. The column formatter also rounds to a readable precision, so
    # the point of this assertion is the separator, not the digit count.
    assert "1.234" in out or "1.235" in out


def test_the_bibliography_cites_where_a_method_is_published():
    """Naming "IPCC 2013 / climate change / GWP100" without saying where it is published is the citation a
    reviewer sends back. The table lives in the renderer next to the "Method reference" links the user
    already sees, so it arrives with the render rather than being duplicated in Python."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _references_blocks

    data = {
        "provenance": {"background": "ecoinvent-3.12-cutoff"},
        "results": [
            {"method": ["IPCC 2013", "climate change", "GWP100"], "method_label": "IPCC 2013 / climate change / GWP100"},
            {"method": ["CML v4.8 2016", "acidification"], "method_label": "CML v4.8 2016 / acidification"},
        ],
        "method_references": [{"name": "IPCC 2013", "url": "https://www.ipcc.ch/", "text": "…"}],
    }
    out = render_blocks(_references_blocks(data, "en", "References"))
    assert "https://www.ipcc.ch/" in out
    assert "ecoinvent-3.12-cutoff" in out
    # The database every result draws on gets cited like any other source; it used to be the one row
    # with an empty reference column.
    data["method_references"].append({"name": "ecoinvent-3.12-cutoff", "url": "https://ecoinvent.org/"})
    assert "https://ecoinvent.org/" in render_blocks(_references_blocks(data, "en", "References"))
    # Both standards have been amended since 2006; the bare year is the citation a reviewer sends back.
    assert "ISO 14044:2006 + Amd 1:2017 + Amd 2:2020" in out
    assert "ISO 14040:2006 + Amd 1:2020" in out
    # A family with no reference supplied is still listed — silence about the source beats omitting it.
    assert "CML v4.8 2016" in out
    # One line per *family*, not per indicator: a bibliography says where something is published, and
    # eleven CML indicators are published in one place. The first real report printed eleven rows
    # carrying the identical URL.
    data["results"].append(
        {"method": ["CML v4.8 2016", "eutrophication"], "method_label": "CML v4.8 2016 / eutrophication"}
    )
    again = render_blocks(_references_blocks(data, "en", "References"))
    assert again.count("CML v4.8 2016") == 1
    assert "eutrophication" not in again


def test_a_method_family_is_matched_even_when_the_variant_differs():
    """Families arrive as "EF v3.1 no LT" while the table is keyed "EF v3.1"; a citation that only appears
    for the exact string would be missing on most real reports."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _references_blocks

    data = {
        "results": [{"method": ["EF v3.1 no LT", "climate change"], "method_label": "EF v3.1 no LT / climate change"}],
        "method_references": [{"name": "EF v3.1", "url": "https://eplca.jrc.ec.europa.eu/", "text": "…"}],
    }
    assert "https://eplca.jrc.ec.europa.eu/" in render_blocks(_references_blocks(data, "en", "References"))


def test_the_comparison_figures_are_emitted_when_the_renderer_supplies_them():
    """A heatmap and a radar put indicators side by side, and indicators have no common unit — both are
    normalised per indicator in the renderer. Here the document side: they appear in the impact-assessment
    chapter, with their own captions and labels, only when a chart was actually produced."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import blocks_for

    report = {"lang": "en", "sections": [{"kind": "lcia", "order": 0}]}
    lcia = {"activity": {}, "amount": 1.0, "results": [{"method": ["IPCC", "climate change"], "unit": "kg", "score": 1.0}]}
    data = {"results": [{"method": ["IPCC", "climate change"], "method_label": "IPCC / climate change", "unit": "kg", "score": 1.0}]}
    svg = "<svg/>"

    without, _ = blocks_for(report, {}, lcia, None, data, {}, [])
    assert "charts/heatmap.svg" not in render_blocks(without)

    with_both, _ = blocks_for(report, {}, lcia, None, data, {"heatmap": svg, "radar": svg}, [])
    out = render_blocks(with_both)
    assert "charts/heatmap.svg" in out and "charts/radar.svg" in out
    assert "f-heatmap" in out and "f-radar" in out
    # The captions explain the normalisation, because a percentage without that explanation is a riddle.
    assert "share of the highest value" in out and "scaled to its own highest value" in out


# ---- the two chapters built from what the model already knows ----------------------
def test_the_methods_chapter_lists_each_indicator_with_its_family_and_source():
    """The reviewer's first question on a comparative study is why these methods. The table says
    which — from the results themselves, so it cannot cite a method the report did not use — and the
    chapter's written comment says why."""
    from prism_lca.engine.report_render import blocks_for

    data = {
        "results": [
            {"method": ["IPCC 2013", "climate change", "GWP100"], "method_label": "IPCC 2013 / climate change / GWP100", "unit": "kg CO2-Eq", "score": 1.0}
        ],
        "method_references": [{"name": "IPCC 2013", "url": "https://www.ipcc.ch/report/ar5/"}],
    }
    report = {"lang": "en", "sections": [{"id": "m", "kind": "methods", "order": 0}]}
    blocks, _ = blocks_for(report, {}, {"results": []}, None, data, {})
    table = next(b for b in blocks if b.get("type") == "table")
    assert table["rows"][0][1] == "IPCC 2013"
    assert "ipcc.ch" in table["rows"][0][3]


def test_the_dataset_index_lists_the_top_level_only_and_says_so():
    """With the author's restriction: tier-1 datasets, not the whole upstream tree. A market
    dataset pulls in hundreds that the study never chose, and the intro states the omission rather
    than leaving it to be discovered."""
    from prism_lca.engine.report_render import blocks_for

    data = {
        "background_datasets": [
            {"database": "ecoinvent 3.12", "name": "market for electricity", "product": "electricity", "location": "DE"},
            {"database": "ecoinvent 3.12", "name": "polyethylene production", "product": "polyethylene", "location": "RER"},
        ]
    }
    report = {"lang": "en", "sections": [{"id": "d", "kind": "datasets", "order": 0}]}
    blocks, _ = blocks_for(report, {}, {"results": []}, None, data, {})
    prose = " ".join(b.get("text", "") for b in blocks if b.get("type") == "prose")
    assert "not listed individually" in prose
    table = next(b for b in blocks if b.get("type") == "table")
    assert len(table["rows"]) == 2 and table["rows"][0][3] == "ecoinvent 3.12"


def test_an_empty_dataset_index_states_it_rather_than_printing_an_empty_table():
    from prism_lca.engine.report_render import blocks_for

    report = {"lang": "en", "sections": [{"id": "d", "kind": "datasets", "order": 0}]}
    blocks, _ = blocks_for(report, {}, {"results": []}, None, {}, {})
    assert any(b.get("type") == "note" for b in blocks)


# ---- the executive summary ---------------------------------------------------------------
def test_the_summary_carries_its_standard_figure_only_when_one_was_supplied():
    """One figure is allowed there — every variant for the leading indicator — and the renderer only
    supplies it with more than one variant, because a one-bar chart is decoration."""
    from prism_lca.engine.report_render import blocks_for

    data = {"results": [{"method": ["IPCC", "climate change"], "method_label": "IPCC / climate change", "unit": "kg", "score": 1.0}]}
    report = {"lang": "en", "sections": [{"id": "s", "kind": "summary", "order": 0, "text": "The study assessed one bag."}]}
    without, _ = blocks_for(report, {}, {"results": []}, None, data, {})
    assert not [b for b in without if b.get("type") == "figure"]
    # Keyed by the lead indicator, not by the slot: a refresh with another lead leaves a gap here.
    assert not [b for b in blocks_for(report, {}, {"results": []}, None, data, {"summary": "<svg/>"})[0] if b.get("type") == "figure"]
    withfig, _ = blocks_for(report, {}, {"results": []}, None, data, {"summary:IPCC / climate change": "<svg/>"})
    figure = next(b for b in withfig if b.get("type") == "figure")
    assert figure["key"] == "summary:IPCC / climate change" and "climate change" in figure["caption"]
    assert figure["path"].startswith("charts/summary-ipcc-climate-change-") and figure["label"] == "f-summary"


def test_the_summary_heading_is_localised_like_every_other_kind():
    from prism_lca.engine.report_render import blocks_for

    report = {"lang": "de", "sections": [{"id": "s", "kind": "summary", "order": 0, "text": "Text."}]}
    blocks, _ = blocks_for(report, {}, {"results": []}, None, {}, {})
    assert blocks[0]["text"] == "Zusammenfassung"


# ---- two allocation decisions instead of one ---------------------------------------------
def test_goal_and_scope_prints_both_allocation_decisions():
    """One field called "allocation" was where the end-of-life question used to disappear — and it is
    the one a critical review asks about."""
    from prism_lca.engine.report_render import blocks_for

    study = {"allocation": "mass allocation", "system_allocation": "cut-off, no credits"}
    report = {"lang": "en", "sections": [{"id": "g", "kind": "goal_scope", "order": 0}]}
    blocks, _ = blocks_for(report, study, {"results": []}, None, {"study": study}, {})
    flat = " ".join(
        " ".join(" ".join(p) for p in b.get("pairs", [])) if b.get("type") == "kv" else b.get("text", "")
        for b in blocks
    )
    assert "Process allocation" in flat and "System allocation" in flat and "cut-off, no credits" in flat


# ---- stale references: the two remaining ways a deletion used to break a report ---------------
def test_a_reference_to_a_deleted_chapter_becomes_a_visible_gap():
    """Typst refuses the *whole document* for a label that does not exist, so deleting the contribution
    chapter made every report mentioning its table unrenderable — with an error naming a label. The
    reference is now a reported gap, like an unresolved placeholder."""
    from prism_lca.engine.report_render import blocks_for

    report = {
        "lang": "en",
        "sections": [{"id": "p", "kind": "prose", "order": 0, "text": "See {{ref:t-contribution}} for the split."}],
    }
    blocks, missing = blocks_for(report, {}, {"results": []}, None, {}, {})
    prose = next(b for b in blocks if b.get("type") == "prose")
    assert "@t-contribution" not in prose["text"] and "[missing reference: t-contribution]" in prose["text"]
    # …and the reason still names the chapter, because here the chapter really is what is gone. The
    # sentence used to be printed for every dead reference, switched-off figures included (V196).
    assert missing == ["ref:t-contribution — the chapter it points at is no longer in this report"]


def test_a_reference_to_a_chapter_that_is_there_stays_a_reference():
    from prism_lca.engine.report_render import blocks_for

    data = {
        "contribution": {
            "dimension": "tag:Phase",
            "unit": "kg",
            "groups": [{"key": "End of life", "impact": 1.0, "share": 0.9, "share_percent": 90.0}],
        }
    }
    contribution = {
        "aggregation": {"dimension": "tag:Phase", "groups": [{"key": "End of life", "impact": 1.0, "share": 0.9}]},
        "meta": {"unit": "kg"},
    }
    report = {
        "lang": "en",
        "sections": [
            {"id": "c", "kind": "contribution", "order": 0},
            {"id": "p", "kind": "prose", "order": 1, "text": "See {{ref:t-contribution}}."},
        ],
    }
    blocks, missing = blocks_for(report, {}, {"results": []}, contribution, data, {})
    prose = next(b for b in blocks if b.get("type") == "prose")
    assert "@t-contribution" in prose["text"] and not missing


def test_a_reference_to_a_switched_off_figure_names_the_figure_and_not_a_deleted_chapter():
    """Measured (V196): nothing had been deleted. The "Heatmap of every indicator" box was
    cleared, two chapters kept quoting the figure, and the refusal sent the author hunting for a
    chapter that was still in the report. A reference dies for several reasons; the message has to
    name the one it knows, and for this one it also knows the remedy."""
    from prism_lca.engine.report_render import blocks_for

    report = {
        "lang": "en",
        "options": {"figures": {"heatmap": False}},
        "sections": [
            {"id": "l", "kind": "lcia", "order": 0},
            {"id": "p", "kind": "prose", "order": 1, "text": "The picture is in {{ref:f-heatmap}}."},
        ],
    }
    _blocks, missing = blocks_for(report, {}, {"results": []}, None, {"results": []}, {})
    (gap,) = missing
    assert "Heatmap of every indicator" in gap and "Scope & indicators" in gap
    assert "chapter" not in gap, gap


def test_a_figure_reference_that_cannot_be_explained_still_says_figure():
    """`f-lcia-3` can be missing because the chapter prints only its leading indicator, because the
    study has one subject, or because the renderer sent no chart. None of those is a deleted chapter,
    and a figure label at least says what kind of thing is gone."""
    from prism_lca.engine.report_render import blocks_for

    report = {
        "lang": "en",
        "sections": [{"id": "p", "kind": "prose", "order": 0, "text": "See {{ref:f-lcia-3}}."}],
    }
    _blocks, missing = blocks_for(report, {}, {"results": []}, None, {}, {})
    assert missing == ["ref:f-lcia-3 — the figure it points at is not part of this report"]


def test_a_comparison_that_lost_a_variant_says_so_in_the_document():
    """Skipping it silently would make the study read better than it is."""
    from prism_lca.engine.report_render import blocks_for

    subject = {"label": "A", "code": "a", "lcia": {"results": [{"method": ["m"], "unit": "kg", "score": 1.0}]}}
    data = {"dropped_subjects": ["Thicker bag (30 g)"], "subjects": [], "results": []}
    report = {"lang": "en", "sections": [{"id": "l", "kind": "lcia", "order": 0}]}
    blocks, _ = blocks_for(report, {}, {"results": []}, None, data, {}, [subject, subject])
    notes = " ".join(b.get("text", "") for b in blocks if b.get("type") == "note")
    assert "Thicker bag (30 g)" in notes and "no longer exists" in notes


def test_the_annex_prints_the_parameter_comments(client, token, project):
    """The comment column was read from `comment`, but the parameter store calls the field
    `description` — so every annex ever rendered had an empty column where the reasoning should be.
    A parameter's comment is where its source lives; a study loses its provenance without it."""
    from prism_lca.engine import report_render

    blocks = report_render._appendix_blocks(
        {
            "parameters": [
                {
                    "name": "mass_glass_bottle",
                    "amount": 0.37,
                    "unit": "kg/unit",
                    "description": "Mass of a 1 L clear glass bottle. Source: industry average.",
                }
            ]
        },
        "en",
        title="Annex",
    )
    text = str(blocks)
    assert "Source: industry average." in text
    # The name carries zero-width break opportunities now (see the wrapping test below). This reads the
    # blocks through `repr`, where the character appears as its escape, so strip that.
    text = text.replace("\\u200b", "")
    assert "mass_glass_bottle" in text


def test_a_comment_column_gets_the_width_its_sentences_need():
    """Column widths follow the content, not a fixed text-or-number split.

    The annex comment carries whole sentences beside a unit column of "kg". Under the old rule both got
    the same share, so the sentences wrapped over five lines while "kg" sat in a field several times
    wider than it needs. Asserted on the template source rather than on a rendering, because the width
    is decided in Typst — what this test protects is that all three shipped templates decide it the same
    way, which is the thing that silently drifts.
    """
    from prism_lca.engine import typst_render

    for template_id in typst_render.BUILTIN_TEMPLATES:
        source = typst_render.builtin_template_source(template_id)
        assert "let width-of(i)" in source, template_id
        assert "calc.sqrt(m)" in source, template_id
        # Numeric columns stay capped: figures are short, right-aligned and do not wrap.
        assert "calc.min(w, 2.6)" in source, template_id


def test_a_long_parameter_name_or_formula_may_wrap():
    """`bottles_per_pallet` is one unbreakable word to a typesetter.

    Without a break opportunity the column has to be as wide as the longest name in the study, and the
    comment beside it pays for that width. Formulas were once left out of this, on the grounds that one
    broken across two lines reads as a different string rather than as a wrapped one. The first real
    report settled it: the value column is right-aligned, so a formula naming two long parameters did
    not merely stick out of its column — it ran back over the name beside it and printed the two on
    top of each other.
    """
    from prism_lca.engine.report_render import _appendix_blocks, _breakable

    assert _breakable("bottles_per_pallet") == "bottles_​per_​pallet"
    assert _breakable("mass") == "mass"

    blocks = _appendix_blocks(
        {
            "parameters": [
                {"name": "bottle_mass", "formula": "glass_mass * 2", "unit": "kg", "description": "why"},
                {"name": "mass_per_bottle_kg", "formula": "bottle_volume_ml * density_kgl / 1000", "unit": "kg"},
            ]
        },
        "en",
        "Appendix",
    )
    table = next(b for b in blocks if b.get("type") == "table")
    name, formula, unit, comment = table["rows"][0]
    assert name == "bottle_​mass"
    assert formula == "glass_​mass * 2"
    assert (unit, comment) == ("kg", "why")

    # The row that overlapped: every identifier in it now has somewhere to break.
    assert table["rows"][1][1] == "bottle_​volume_​ml * density_​kgl / 1000"


def test_the_stacked_chart_stands_in_for_the_other_two():
    """Three shapes of one breakdown, and the chapter takes exactly one.

    Stacked, grouped and plain all draw the same numbers. Embedding two of them would put the same figure
    in the chapter twice under different captions, which is how a reader concludes they are looking at
    two different results.
    """
    from prism_lca.engine import report_render

    report = {"sections": [{"id": "c", "kind": "contribution", "title": "Contribution"}]}
    contribution = {
        "aggregation": {
            "dimension": "tag:life-cycle phase",
            "groups": [
                {"key": "Production", "impact": 0.8, "share": 0.67},
                {"key": "Transport", "impact": 0.4, "share": 0.33},
            ],
        },
        "meta": {"unit": "kg CO2-Eq"},
    }

    def keys(figures: dict) -> list[str]:
        blocks = report_render.blocks_for(report, {}, {}, contribution, {}, figures, [], {})[0]
        return [b["key"] for b in blocks if b.get("type") == "figure"]

    # A snapshot with neither a dimension list nor a method path: the identity is `|`.
    assert keys({"contribution-stacked:|": "<svg/>", "contribution:|": "<svg/>"}) == ["contribution-stacked:|"]
    assert keys({"contribution-grouped:|": "<svg/>", "contribution:|": "<svg/>"}) == ["contribution-grouped:|"]
    assert keys({"contribution:|": "<svg/>"}) == ["contribution:|"]


def test_the_stacked_caption_names_the_dimension_in_every_language():
    from prism_lca.engine.report_i18n import LANGUAGES, t

    for lang in LANGUAGES:
        caption = t("caption.figure_contribution_stacked", lang, dimension="life-cycle phase")
        assert "life-cycle phase" in caption, lang
        # A language without its own string would fall through to English.
        assert caption != t("caption.figure_contribution_stacked", "en") or lang == "en", lang


def test_a_functional_unit_written_as_a_sentence_does_not_double_the_full_stop():
    """The results lead-in ends in a full stop of its own, so the FU must not bring a second one.

    Seen on the cling-film report: "…functional unit: 1 roll … assessed at the factory gate..". ISO calls
    a functional unit a phrase, but authors write it as a sentence, and both have to typeset.
    """
    from prism_lca.engine.report_typst import lcia_blocks

    lcia = {"amount": 1.0, "results": []}
    with_stop = lcia_blocks(lcia, {"functional_unit": "1 roll, assessed at the factory gate."})
    without = lcia_blocks(lcia, {"functional_unit": "1 roll, assessed at the factory gate"})
    lead = next(b for b in with_stop if b.get("type") == "prose")["text"]
    assert ".." not in lead
    assert lead.endswith("gate.")
    assert lead == next(b for b in without if b.get("type") == "prose")["text"]


def test_the_results_matrix_turns_when_the_indicators_outnumber_the_variants():
    """Eleven indicators as columns on a portrait page: a header taller than its data, and a column so
    narrow that 8.35e-6 printed as "0.0000"."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_typst import lcia_matrix_blocks

    def subject(label, scores):
        return {"label": label, "lcia": {"amount": 1.0, "results": [
            {"method": ["CML", cat], "unit": u, "score": v} for cat, u, v in scores]}}

    many = [
        subject("Baseline", [("climate change", "kg CO2-Eq", 1.27), ("acidification", "kg SO2-Eq", 0.00445)]),
    ]
    wide = render_blocks(lcia_matrix_blocks(many, {}, "en"))
    # One subject, two indicators → indicators as rows: the name and the unit get columns of their own.
    assert '"Indicator"' in wide and '"Unit"' in wide and '"Subject"' not in wide

    two = [subject("Baseline", [("climate change", "kg CO2-Eq", 1.27)]),
           subject("Heavier", [("climate change", "kg CO2-Eq", 1.32)])]
    # Two variants, one indicator → the old shape: one row per subject.
    assert '"Subject"' in render_blocks(lcia_matrix_blocks(two, {}, "en"))
    # …and the chapter may say so itself, whatever the counts.
    assert '"Indicator"' in render_blocks(lcia_matrix_blocks(two, {}, "en", orientation="indicators"))
    assert '"Subject"' in render_blocks(lcia_matrix_blocks(many, {}, "en", orientation="subjects"))


def test_the_short_name_legend_yields_to_the_methods_chapter():
    """The same mapping stood three times in one document. It belongs in the methods chapter."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_typst import lcia_blocks

    lcia = {"amount": 1.0, "results": [
        {"method": ["CML v4.8 2016 no LT", "climate change no LT", "GWP100 no LT"],
         "unit": "kg CO2-Eq", "score": 1.27}]}
    assert "GWP100 no LT" in render_blocks(lcia_blocks(lcia, {}, "en"))
    assert "GWP100 no LT" not in render_blocks(lcia_blocks(lcia, {}, "en", legend=False))


def test_the_written_goal_and_scope_replaces_the_field_list():
    """The fields are working notes. Printing them raw *and* their prose says everything twice — and it
    put a modelling brief into a client's report."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import blocks_for

    study = {"goal": "Use web research for orchard yields and write the source URLs into the process.",
             "functional_unit": "1 L"}
    data = {"study": study, "results": [], "subjects": [], "provenance": {}}
    written = {"sections": [{"id": "s1", "kind": "goal_scope", "order": 0,
                             "text": "This study assesses one litre of apple juice."}]}
    out = render_blocks(blocks_for(written, study, {"results": []}, None, data)[0])
    assert "one litre of apple juice" in out
    assert "web research" not in out
    # No surviving field row either: the lone "Critical review" box above the prose read as a stamp
    # on the chapter. The fact is the writer's to state and the limitations
    # chapter's to enforce; for a public comparative assertion `critical_review_note` still fires.
    assert "Critical review" not in out

    # Nothing written yet: the fields still say what the report is about, rather than an empty chapter.
    bare = {"sections": [{"id": "s1", "kind": "goal_scope", "order": 0, "text": ""}]}
    assert "web research" in render_blocks(blocks_for(bare, study, {"results": []}, None, data)[0])


# ---- the inventory chapter ----------------------------------------------------------------------

def _lci_data():
    return {
        "activity": {"code": "root"},
        "provenance": {"background": "ecoinvent-3.12-cutoff"},
        "foreground": [
            {"code": "cap", "name": "Aluminium cap", "product": "cap", "unit": "unit", "location": "DE",
             "description": "28 mm ROPP closure, 2.5 g. Own estimate, no primary source."},
            {"code": "root", "name": "Apple juice, at retail", "product": "juice", "unit": "litre",
             "location": "DE", "description": "The reference flow. Cradle to grave."},
        ],
        "background_datasets": [{"name": "market for apple", "product": "apple", "location": "CH",
                                 "database": "ecoinvent-3.12-cutoff"}],
        "parameters": [{"name": "mass_alu_cap", "amount": 0.0025, "unit": "kg",
                        "description": "Own estimate, no primary source."}],
    }


def test_the_inventory_leads_with_the_product_the_study_is_about():
    """The database hands the processes over alphabetically, which buried the reference flow between an
    aluminium cap and an apple supply. Alphabetical is the database's order, not the study's."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _lci_blocks

    out = render_blocks(_lci_blocks(_lci_data(), {"inventory_detail": "full"}, "en", "Life cycle inventory"))
    assert out.index("Apple juice, at retail") < out.index("Aluminium cap")
    # The note recorded against each process, where the chapter is set to print the notes themselves.
    assert "ROPP closure" in out
    # No count in the prose: "15 foreground process(es)" is the plural hack showing through in a
    # document that goes to a client, and the table below counts itself.
    assert "process(es)" not in out and "Prozess(e)" not in out


def test_a_process_note_with_typst_syntax_cannot_break_the_document():
    """The notes are whoever-built-the-model's own words, and a real one said "(<1 g) … (<1 % der
    Verpackungsmasse)" — raw, that `<` opened a Typst label that never closes and the whole PDF
    refused to compile ("unclosed label"). The words must survive, escaped."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _lci_blocks

    data = _lci_data()
    data["foreground"][0]["description"] = "Gasket (<1 g) excluded per cut-off (<1 %). #let is prose."
    out = render_blocks(_lci_blocks(data, {"inventory_detail": "full"}, "en", "LCI"))
    assert "\\<1 g" in out and "\\<1 %" in out and "\\#let" in out


def test_the_datasets_intro_carries_no_plural_hack():
    """Same rule as the process intro: "12 background dataset(s)" is the plural hack showing
    through in a client PDF (V125) — the table below counts itself."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _lci_blocks

    out = render_blocks(_lci_blocks(_lci_data(), {}, "en", "LCI"))
    assert "dataset(s)" not in out and "market for apple" in out


def test_the_inventory_shows_what_the_chapter_asked_for():
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _lci_blocks

    data = _lci_data()
    # Default: processes and the datasets they link to; the annex keeps the parameters.
    # A parameter name is printed with zero-width breaks in it, so compare without them.
    plain = lambda text: text.replace("\u200b", "")  # noqa: E731
    default = plain(render_blocks(_lci_blocks(data, {}, "en", "LCI")))
    assert "market for apple" in default and "mass_alu_cap" not in default
    # …and the other legitimate arrangement, where the parameters are the study's data sources.
    moved = plain(render_blocks(_lci_blocks(data, {"inventory_parts": ["processes", "parameters"]}, "en", "LCI")))
    assert "mass_alu_cap" in moved and "market for apple" not in moved
    # "How much" of each note: the table alone is the right size for a three-process model.
    listed = render_blocks(_lci_blocks(data, {"inventory_detail": "list"}, "en", "LCI"))
    assert "ROPP closure" not in listed and "Aluminium cap" in listed


def test_the_inventory_table_follows_the_life_cycle_where_the_model_is_tagged():
    """V249. Once processes are named phase-first, alphabetical order reads Distribution, End-of-Life,
    Packaging, Production, Use — and the written chapter, which is told to follow the table, opened its
    narrative with the disposal of the empty container. The order comes from the tag group's own value
    list, which for a life-cycle dimension is the life cycle."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _lci_blocks

    data = {
        "activity": {"code": "root"},
        "foreground": [
            {"code": "eol", "name": "End-of-Life — container", "phase_order": 4},
            {"code": "pack", "name": "Packaging — can", "phase_order": 1},
            {"code": "root", "name": "The product — cradle to grave", "phase_order": 0},
            {"code": "prod", "name": "Production — formulation", "phase_order": 0},
            {"code": "use", "name": "Use — coating", "phase_order": 3},
            {"code": "x", "name": "Aardvark — untagged"},
        ],
    }
    out = render_blocks(_lci_blocks(data, {"inventory_detail": "list"}, "en", "LCI"))
    order = [out.index(n) for n in ("The product", "Production", "Packaging", "Use", "End-of-Life")]
    assert order == sorted(order), out[:400]
    # The reference process still leads, even against a phase that sorts before it…
    assert out.index("The product") < out.index("Production")
    # …and an untagged process falls to the end rather than to the front on its name.
    assert out.index("Aardvark") > out.index("End-of-Life")


def test_without_a_breakdown_dimension_the_order_is_what_it_always_was():
    """A model that is not tagged has no phase order, and nothing about it changes."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _lci_blocks

    data = {
        "activity": {"code": "root"},
        "foreground": [
            {"code": "b", "name": "Beta"},
            {"code": "root", "name": "Zeta root"},
            {"code": "a", "name": "Alpha"},
        ],
    }
    out = render_blocks(_lci_blocks(data, {"inventory_detail": "list"}, "en", "LCI"))
    assert out.index("Zeta root") < out.index("Alpha") < out.index("Beta")


def test_by_default_the_chapter_is_written_and_the_notes_are_not_printed():
    """A process note is a working note — shorthand, written to be true rather than to be read. Fifteen
    of them under fifteen headings is the model's documentation pasted into a client's report, not an
    inventory chapter. The table stays; the prose is the writer's."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _lci_blocks

    data = _lci_data()
    out = render_blocks(_lci_blocks(data, {}, "en", "LCI", written="The cap is a 28 mm aluminium closure."))
    assert "28 mm aluminium closure" in out
    assert "ROPP closure" not in out  # the note itself stays behind
    assert "Aluminium cap" in out  # …but the table still names every process
    # And the prose stands under the process table, not behind the dataset table two sub-sections on.
    assert out.index("28 mm aluminium closure") < out.index("market for apple")


def test_an_unwritten_inventory_chapter_says_so_rather_than_falling_back_to_the_notes():
    """Silently printing the notes instead would make "written" mean "written, unless nobody wrote it",
    and the author would never learn that the chapter is empty."""
    from prism_lca.engine.report_model import render_blocks
    from prism_lca.engine.report_render import _lci_blocks

    out = render_blocks(_lci_blocks(_lci_data(), {}, "en", "LCI"))
    assert "ROPP closure" not in out and "Aluminium cap" in out


def test_the_written_inventory_prints_its_text_once_and_in_the_right_place():
    """Every other deterministic chapter takes its written text as a comment at its foot. This one
    describes the table above it, so it stands there instead — and must not also be appended."""
    from prism_lca.engine.report_render import blocks_for

    report = {
        "lang": "en",
        "sections": [{"id": "l", "kind": "inventory", "order": 0, "text": "Two processes were modelled."}],
    }
    blocks, _ = blocks_for(report, {}, {"results": []}, None, _lci_data(), {})
    printed = [b for b in blocks if "Two processes were modelled." in str(b.get("text") or "")]
    assert len(printed) == 1
    # Printing the notes puts the text back at the foot, where a comment belongs.
    report["sections"][0]["inventory_detail"] = "full"
    blocks, _ = blocks_for(report, {}, {"results": []}, None, _lci_data(), {})
    texts = [str(b.get("text") or "") for b in blocks]
    assert sum("Two processes were modelled." in t for t in texts) == 1
    assert texts.index(next(t for t in texts if "Two processes were modelled." in t)) == len(texts) - 1


def test_a_duplicated_label_keeps_its_first_occurrence_and_the_reference_works():
    """Typst refuses the whole document over a reference to a duplicated label. An appendix and an
    inventory chapter with the parameters part both legitimately carry `t-parameters`; the first
    occurrence (document order) keeps the label, later ones lose theirs, and the reference resolves."""
    from prism_lca.engine.report_render import blocks_for

    report = {
        "lang": "en",
        "sections": [
            {"id": "l", "kind": "inventory", "order": 0, "inventory_parts": ["parameters"]},
            {"id": "a", "kind": "appendix", "order": 1},
            {"id": "p", "kind": "prose", "order": 2, "text": "Values are listed in {{ref:t-parameters}}."},
        ],
    }
    data = {"parameters": [{"name": "mass", "amount": 1.0, "unit": "kg", "description": "d"}]}
    blocks, missing = blocks_for(report, {}, {"results": []}, None, data, {})
    labelled = [b for b in blocks if b.get("label") == "t-parameters"]
    assert len(labelled) == 1  # the inventory chapter came first, so its table carries the label
    prose = next(b for b in blocks if b.get("type") == "prose" and "Values" in b.get("text", ""))
    assert "@t-parameters" in prose["text"]
    assert missing == []


def test_scenario_overrides_print_as_settings_not_physics():
    """`dc_distance_km = 15000` is a value someone typed; the annex used to print it as "1.50e+04"."""
    from prism_lca.engine.report_render import blocks_for

    report = {"lang": "en", "sections": [{"id": "a", "kind": "appendix", "order": 0}]}
    data = {
        "scenarios": [{"name": "Long haul", "description": "", "overrides": {"dc_distance_km": 15000, "share": 0.42}}],
    }
    blocks, _missing = blocks_for(report, {}, {"results": []}, None, data, {})
    table = next(b for b in blocks if b.get("type") == "table" and any("dc_distance_km" in c for r in b["rows"] for c in r))
    cell = next(c for r in table["rows"] for c in r if "dc_distance_km" in c)
    assert "dc_distance_km = 15,000" in cell and "share = 0.42" in cell, cell


def test_a_database_name_full_of_typst_syntax_stays_prose():
    """`provenance.background` is a user-chosen database name interpolated into prose; unescaped, a name
    containing `#let` failed the whole compile and `@x` was rewritten by the reference fixer."""
    from prism_lca.engine.report_render import blocks_for

    report = {"lang": "en", "sections": [{"id": "l", "kind": "inventory", "order": 0}]}
    data = {
        "provenance": {"background": "my db #let @x"},
        "foreground": [{"name": "p", "product": "x", "unit": "kg", "location": "GLO", "description": "note"}],
    }
    blocks, missing = blocks_for(report, {}, {"results": []}, None, data, {})
    intro = next(b for b in blocks if b.get("type") == "prose" and "my db" in b.get("text", ""))
    assert "\\#let" in intro["text"] and "\\@x" in intro["text"], intro["text"]
    assert not any("ref:x" in m for m in missing)


def test_the_functional_unit_reaches_the_document_without_its_own_full_stop():
    """"…and packaging end-of-life.. Under this scope" — page one of the first real report, and page
    ten of the same one. A functional unit is a noun phrase the document sets inside its own
    sentences, and both the prose and the results lead-in supply the stop themselves."""
    from prism_lca.engine.study import StudyMetaStore

    store = StudyMetaStore()
    store.update("fu-test", {"functional_unit": "One hair washing, including packaging end-of-life."})
    assert store.for_report("fu-test")["functional_unit"] == "One hair washing, including packaging end-of-life"
    # The author's own wording is untouched where they typed it.
    assert store.snapshot("fu-test")["functional_unit"].endswith(".")

    # A dot that belongs to a word stays: stripping it would misspell the unit.
    store.update("fu-test", {"functional_unit": "1 kg of packaging waste, incl. transport etc."})
    assert store.for_report("fu-test")["functional_unit"].endswith("etc.")
    store.update("fu-test", {"functional_unit": "1 m2 of coated board, approx."})
    assert store.for_report("fu-test")["functional_unit"].endswith("approx.")

    # Nothing to do, and nothing broken, when there is no stop or no unit at all.
    store.update("fu-test", {"functional_unit": "1 kg of bread"})
    assert store.for_report("fu-test")["functional_unit"] == "1 kg of bread"
    store.update("fu-test", {"functional_unit": ""})
    assert store.for_report("fu-test")["functional_unit"] == ""


def test_the_methods_table_names_a_family_and_its_source_once():
    """Three indicators of one family printed the family name three times and the same URL three
    times — a column that reads as three sources when it is one."""
    from prism_lca.engine.report_render import _methods_blocks

    data = {
        "results": [
            {"method_label": "EF v3.1 / climate change / GWP100", "method": ["EF v3.1", "climate change"], "unit": "kg CO2-Eq"},
            {"method_label": "EF v3.1 / water use / deprivation", "method": ["EF v3.1", "water use"], "unit": "m3"},
            {"method_label": "IPCC 2021 / climate change / GWP100", "method": ["IPCC 2021", "climate change"], "unit": "kg CO2-Eq"},
        ],
        "method_references": [
            {"name": "EF v3.1", "url": "https://eplca.jrc.ec.europa.eu/"},
            {"name": "IPCC 2021", "url": "https://www.ipcc.ch/"},
        ],
    }
    table = next(b for b in _methods_blocks(data, "en", "Methods") if b.get("type") == "table")
    families = [r[1] for r in table["rows"]]
    urls = [r[3] for r in table["rows"]]
    assert families == ["EF v3.1", "", "IPCC 2021"]
    assert urls == ["https://eplca.jrc.ec.europa.eu/", "", "https://www.ipcc.ch/"]
    # Every indicator still has its own row, with its own unit.
    assert [r[0].split(" / ")[1] for r in table["rows"]] == ["climate change", "water use", "climate change"]
    assert [r[2] for r in table["rows"]] == ["kg CO2-Eq", "m3", "kg CO2-Eq"]


def test_the_limitations_chapter_prints_what_the_study_declared(client, token, project):
    """The only channel from whoever builds the model to whoever writes the report. The four checks
    below can say whether an analysis was run; nothing in the data can say that the result rests on
    how much of a shower belongs to one hair wash."""
    _seed(get_bd())
    client.post(
        "/api/v1/study",
        json={
            "database": "rr",
            "functional_unit": "1 widget",
            "limitations": [
                {"text": "The whole shower's hot water is charged to one wash.", "kind": "assumption",
                 "subject": "use phase"},
                "Packaging adhesive is excluded; no dataset was found for it.",
            ],
        },
        headers=token,
    )
    rep = _report(client, token, sections=[{"kind": "limitations"}])
    main = client.post(f"/api/v1/report/one/rr/{rep['id']}/sources", json={}, headers=token).json()["files"]["main.typ"]

    assert "Declared by the study" in main
    assert "charged to one wash" in main and "Packaging adhesive is excluded" in main
    # And the mechanical four still appear, under their own heading so the two are told apart.
    assert "Checked by the report" in main
    assert "No quantitative uncertainty analysis" in main


def test_a_study_that_declares_nothing_keeps_the_chapter_it_had():
    """No declared limitations must not add an empty heading — the chapter stays what it was."""
    from prism_lca.engine.report_checks import limitations_blocks

    blocks = limitations_blocks({"study": {}}, "en", "Limitations")
    assert [b.get("type") for b in blocks] == ["heading", "prose"]
    assert "Declared by the study" not in " ".join(str(b.get("text", "")) for b in blocks)


def test_recorded_limitations_are_normalised_before_they_reach_a_document():
    """Plain strings are the shape an assistant reaches for first, and an unknown kind must not travel
    into a client's report as a heading nobody defined."""
    from prism_lca.engine.study import StudyMetaStore

    store = StudyMetaStore()
    store.update("lim-test", {"limitations": ["  a plain one  ", {"text": "typed", "kind": "nonsense"},
                                              {"text": "", "kind": "exclusion"}, {"kind": "data_gap"}, 42]})
    got = store.get("lim-test")["limitations"]
    assert got == [
        {"text": "a plain one", "kind": "limitation"},
        {"text": "typed", "kind": "limitation"},
    ]


def test_the_bibliography_collects_the_sources_the_study_researched():
    """The table above lists what the calculation used — background database, method families,
    standards. It cannot list what the study *looked up*, and after a real run that is most of its
    evidence: packaging masses, end-of-life rates, the dose per wash, each with a URL in the comment
    of the process or parameter it belongs to, scattered one per row across two chapters."""
    from prism_lca.engine.report_render import _references_blocks

    data = {
        "provenance": {"background": "ecoinvent-3.12-cutoff"},
        "results": [{"method_label": "EF v3.1 / climate change", "method": ["EF v3.1", "climate change"]}],
        "foreground": [
            {"name": "packaging", "description": "22 g PET (https://www.tarapac.cz/en/standard-pet-bottles)."},
            {"name": "use phase", "description": "See Itel et al. (https://www.mdpi.com/2071-1050/13/15/8478)."},
        ],
        "parameters": [
            # The same source twice, and one already cited by a process: listed once.
            {"name": "rinse_water_liters", "description": "https://www.mdpi.com/2071-1050/13/15/8478"},
            {"name": "eol_recycling", "description": "ZSVR (https://www.verpackungsregister.org/x.pdf)"},
        ],
        "study": {"limitations": [{"text": "Dose per wash from https://setac.onlinelibrary.wiley.com/doi/10.1002/ieam.4064."}]},
    }
    blocks = _references_blocks(data, "en", "References")
    tables = [b for b in blocks if b.get("type") == "table"]
    assert len(tables) == 2
    urls = [r[0] for r in tables[1]["rows"]]
    assert urls == [
        "https://setac.onlinelibrary.wiley.com/doi/10.1002/ieam.4064",
        "https://www.mdpi.com/2071-1050/13/15/8478",
        "https://www.tarapac.cz/en/standard-pet-bottles",
        "https://www.verpackungsregister.org/x.pdf",
    ]
    # The sentence's own full stop and brackets are not part of the address.
    assert not any(u.endswith((".", ")")) for u in urls)
    # And it says where each was cited, using the first place it appeared.
    where = dict(tables[1]["rows"])
    assert where["https://www.mdpi.com/2071-1050/13/15/8478"] == "use phase"
    assert where["https://www.tarapac.cz/en/standard-pet-bottles"] == "packaging"


def test_a_study_that_cites_nothing_keeps_the_bibliography_it_had():
    from prism_lca.engine.report_render import _references_blocks

    blocks = _references_blocks({"provenance": {"background": "ecoinvent"}, "results": []}, "en", "References")
    assert [b.get("type") for b in blocks] == ["heading", "table"]


def _view(label: str, groups: list[tuple[str, float, float]], subjects: list | None = None) -> dict:
    """A prepared per-indicator view, the shape `report_data.build_data` puts in the snapshot."""
    return {
        "method_label": label,
        "dimension": "tag:Phase",
        "unit": "kg CO2-Eq",
        "dropped": 0,
        "groups": [
            {"key": k, "impact": v, "share": sh, "share_percent": round(sh * 100, 1),
             "share_text": f"{sh * 100:.1f} %"}
            for k, v, sh in groups
        ],
        "subjects": subjects or [],
    }


def _contribution_blocks(data: dict, section: dict | None = None) -> list[dict]:
    from prism_lca.engine import report_render

    report = {"sections": [{"id": "c", "kind": "contribution", **(section or {})}]}
    return report_render.blocks_for(report, {}, {}, None, data, {}, [], {})[0]


def test_the_contribution_chapter_breaks_down_every_indicator():
    """A report that computes three indicators and breaks down one can say which phase drives its
    climate score and nothing about where its water or land use sits — and the chapter that tried
    anyway invented an answer."""
    data = {"contributions": [
        _view("EF v3.1 / climate change / GWP100", [("Production", 0.8, 0.67), ("Transport", 0.4, 0.33)]),
        _view("EF v3.1 / water use / deprivation", [("Production", 0.2, 0.5), ("Transport", 0.2, 0.5)]),
    ]}
    blocks = _contribution_blocks(data)
    labels = [b.get("label") for b in blocks if b.get("type") == "table"]
    # The lead keeps the bare label every stored chapter already references and the gate already knows.
    assert labels == ["t-contribution", "t-contribution-1"]
    # Each table is introduced by its own indicator, named the way a reader recognises it.
    headings = [b["text"] for b in blocks if b.get("type") == "heading"]
    assert headings[0].startswith("Contribution")
    assert headings[1:] == ["climate change", "water use"]


def test_a_single_indicator_needs_no_sub_headings():
    data = {"contributions": [_view("t / gwp", [("Production", 0.8, 1.0)])]}
    blocks = _contribution_blocks(data)
    assert [b["text"] for b in blocks if b.get("type") == "heading"] == ["Contribution analysis: Phase"]


def test_an_indicator_can_be_left_out_of_the_contribution_chapter():
    """Deselected by method label rather than by position: a position moves when the report's method
    list is edited, and then a different indicator silently disappears."""
    data = {"contributions": [
        _view("t / gwp", [("Production", 0.8, 1.0)]),
        _view("t / water", [("Production", 0.2, 1.0)]),
    ]}
    blocks = _contribution_blocks(data, {"hidden_indicators": ["t / water"]})
    assert [b.get("label") for b in blocks if b.get("type") == "table"] == ["t-contribution"]
    # And the one that remains is alone again, so it loses its sub-heading.
    assert [b["text"] for b in blocks if b.get("type") == "heading"] == ["Contribution analysis: Phase"]


def test_baseline_and_scenarios_share_one_table_per_indicator():
    """Rows are phases, columns are the baseline and every scenario — the comparison the chapter is
    for, per indicator, because indicators do not share a unit."""
    data = {"contributions": [
        _view(
            "t / gwp",
            [("Production", 0.8, 0.67), ("Transport", 0.4, 0.33)],
            subjects=[
                {"label": "Baseline", "groups": [{"key": "Production", "impact": 0.8}, {"key": "Transport", "impact": 0.4}]},
                {"label": "High recycling", "groups": [{"key": "Production", "impact": 0.6}, {"key": "Transport", "impact": 0.4}]},
            ],
        )
    ]}
    table = next(b for b in _contribution_blocks(data) if b.get("type") == "table")
    assert table["headers"][1:] == ["Baseline (kg CO2-Eq)", "High recycling (kg CO2-Eq)"]
    assert [r[0] for r in table["rows"]] == ["Production", "Transport"]


def test_a_snapshot_without_per_indicator_views_still_renders_the_chapter():
    """The ad-hoc /iso and /pdf paths build no snapshot, and a report rendered before this existed
    has none either. Both still get the chapter they had."""
    contribution = {
        "aggregation": {"dimension": "tag:Phase", "groups": [{"key": "Production", "impact": 0.8, "share": 1.0}]},
        "meta": {"unit": "kg CO2-Eq"},
    }
    from prism_lca.engine import report_render

    report = {"sections": [{"id": "c", "kind": "contribution"}]}
    # No breakdown dimension and no method path in a snapshot like this: the key is the bare identity.
    blocks = report_render.blocks_for(report, {}, {}, contribution, {}, {"contribution:|": "<svg/>"}, [], {})[0]
    assert [b.get("label") for b in blocks if b.get("type") == "table"] == ["t-contribution"]
    assert [b.get("label") for b in blocks if b.get("type") == "figure"] == ["f-contribution"]


def test_a_chapter_draws_its_figure_list_and_falls_back_to_the_single_key():
    """Which of the two keys a chapter's own figure lives in decides its label, so both are pinned here.

    `figures` is what a chapter owns today; `figure` is what a report written before that list carries,
    and it is drawn as `f-section-<id>` so such a report renders unchanged — including the reference its
    text may already make to that label (V203). The fallback applies only while the list is empty, which
    is why the store clears the single key whenever the list is written: an emptied list has to mean "no
    figure", not "the old one again".
    """
    from prism_lca.engine import report_render

    spec = {"kind": "bar", "source": "subjects"}
    # Keyed by chapter, place and what the figure plots (report_model.section_chart_key); no results here,
    # so no lead indicator in the key.
    charts = {
        "section:s/single|bar|subjects|||15|h|||": "<svg/>",
        "section:s/0|bar|subjects|||15|h|||": "<svg/>",
        "section:s/1|bar|subjects|||15|h|||": "<svg/>",
    }

    def drawn(section: dict) -> list[str]:
        report = {"sections": [{"id": "s", "kind": "prose", "title": "Ch", "text": "Ein Satz.", **section}]}
        blocks = report_render.blocks_for(report, {}, {}, None, {}, charts, [], {})[0]
        return [b.get("label") for b in blocks if b.get("type") == "figure"]

    assert drawn({"figure": spec}) == ["f-section-s"]
    assert drawn({"figures": [spec, spec]}) == ["f-section-s-0", "f-section-s-1"]
    # An empty list is not "no list": nothing is drawn, and nothing is resurrected from the old key
    # either — the store has cleared it by the time a list this empty is stored.
    assert drawn({"figures": []}) == []
    assert drawn({}) == []


def test_hiding_an_indicator_does_not_renumber_the_ones_after_it():
    """The label a stored chapter references is built from the indicator's position in the report's
    method list. Deriving it from the position in the *rendered* list would mean deselecting the
    second indicator silently turned the third one's table into the second one's label — and every
    sentence pointing at it would land on the wrong table."""
    data = {"contributions": [
        {**_view("EF / climate change / GWP100", [("Production", 0.8, 1.0)]), "index": 0},
        # The middle indicator is hidden, so the backend never computed it and it is not here.
        {**_view("EF / land use / soil quality", [("Production", 0.3, 1.0)]), "index": 2},
    ]}
    blocks = _contribution_blocks(data)
    assert [b.get("label") for b in blocks if b.get("type") == "table"] == [
        "t-contribution",
        "t-contribution-2",
    ]


def test_a_placeholder_in_backticks_does_not_print_its_backticks():
    """Writers set placeholders in code spans out of habit, and the renderer implements no code
    markup on purpose — so `{{results.0.score}}` reached the page with the backticks around it, a
    score fenced in the middle of a sentence."""
    from prism_lca.engine.report_data import resolve, unfence

    assert unfence("The total is `{{results.0.score}}` per unit.") == "The total is {{results.0.score}} per unit."
    # Whitespace inside the span, several spans, and a derivation with its own brackets.
    assert unfence("`{{a}}` and ` {{b}} `") == "{{a}} and {{b}}"
    assert unfence("`{{change(x, y)}}`") == "{{change(x, y)}}"
    # A real code span is left exactly as it was — that is what the renderer prints literally today.
    assert unfence("the parameter `mass_kg` drives it") == "the parameter `mass_kg` drives it"
    assert unfence("") == "" and unfence(None) == ""

    # And it happens on the way into a document, so a chapter written before this reads right too.
    data = {"results": [{"score": 0.15, "unit": "kg CO2-Eq", "method_label": "m"}]}
    out, missing = resolve("Total `{{results.0.score}}` {{results.0.unit}}.", data)
    assert missing == []
    assert "`" not in out

    # …and on the way to the editor, or it would show a fence the page does not print.
    from prism_lca.engine.report_data import explain

    parts = explain("Total `{{results.0.score}}` per unit.", data)
    assert "`" not in "".join(p["text"] for p in parts)
    assert [p["kind"] for p in parts] == ["text", "value", "text"]


# ---- V170: no text from outside may cost the document -----------------------
#: Every character Typst treats as syntax, in one string. `<0,2` is the one that broke a real report:
#: Typst reads it as the opening of a label, never finds the closing `>`, and refuses the *document* —
#: so a study whose limitations said "<0,2–5 % surfactants" had no PDF, no preview and no export.
_HOSTILE = "<0,2 % #hash @at $dollar *star* _under_ `tick` [br] \\slash"


def test_no_text_from_outside_can_break_the_typesetting():
    """The sweep behind V170, as a test: every field a human or a model writes, filled with Typst
    syntax, through the real chapter builders and into the real compiler.

    It is deliberately one broad test rather than twenty narrow ones. The failure mode is not "this
    chapter is wrong" — it is "the report does not exist", and a chapter added later that hands author
    text to the compiler raw should fail here without anybody remembering to extend a list.
    """
    from prism_lca.engine import report_data as rd
    from prism_lca.engine import report_render as rr
    from prism_lca.engine import report_typst as rt
    from prism_lca.engine import typst_render
    from prism_lca.engine.report_store import DEFAULT_SECTIONS

    def hostile(prefix: str) -> str:
        return f"{prefix} {_HOSTILE}"

    study = {
        key: hostile(key)
        for key in (
            "goal", "scope", "functional_unit", "system_boundaries", "cutoff_criteria", "allocation",
            "system_allocation", "critical_review", "author", "organisation", "commissioner", "notes",
        )
    }
    study["limitations"] = [{"text": hostile("limitation")}]
    lcia = {
        "activity": {"name": hostile("activity"), "database": hostile("db"), "code": "a",
                     "unit": "kg", "location": "GLO", "product": hostile("product")},
        "amount": 1.0,
        "results": [{"method": [hostile("family"), "climate change", "GWP100"],
                     "unit": hostile("unit"), "score": 1.0}],
    }
    contribution = {
        "meta": {"unit": hostile("unit"), "dimension": hostile("dimension")},
        "aggregation": {"dimension": hostile("dimension"),
                        "groups": [{"key": hostile("group"), "impact": 1.0, "share": 1.0}]},
    }
    data = rd.build_data(
        study, lcia, contribution, lang="en",
        parameters=[{"name": hostile("param"), "group": hostile("group"), "amount": 1.0,
                     "formula": hostile("formula"), "unit": hostile("unit"),
                     "description": hostile("description")}],
        scenarios=[{"name": hostile("scenario"), "description": hostile("description"),
                    "overrides": {hostile("param"): 2.0}}],
        provenance={"background": hostile("background"), "generated": "2026-08-19"},
        health={"activities": 1, "findings": [{"severity": "warning",
                                               "activity": {"name": hostile("process")},
                                               "message": hostile("message")}]},
        inventory={"method": [hostile("method")],
                   "flows": [{"flow": hostile("flow"), "categories": [hostile("compartment")],
                              "unit": hostile("unit"), "impact": 1.0, "share": 0.5}]},
        hotspots=[{"name": hostile("hotspot"), "direct": 1.0, "unit": hostile("unit")}],
        method_references=[{"name": hostile("family"), "citation": hostile("citation"),
                            "url": "https://example.org/<v>"}],
        model_context={
            "foreground": [{"name": hostile("process"), "product": hostile("product"), "unit": "kg",
                            "location": "GLO", "code": "a", "description": hostile("note")}],
            "background": [{"name": hostile("dataset"), "product": hostile("product"),
                            "location": "RER", "database": hostile("db")}],
        },
        web_research=[{"title": hostile("source"), "url": "https://example.org/<v>",
                       "note": hostile("note")}],
        review={"created": "2026-08-19T10:00:00Z", "fixed": 1, "resolutions_recorded": True,
                "rejected": [], "open": [{"finding": hostile("finding"), "reason": hostile("reason")}]},
    )
    report = {
        "lang": "en",
        "name": hostile("report"),
        # Every shipped chapter kind, not only the default structure.
        "sections": [dict(s, id=f"s{i}", order=i) for i, s in enumerate(DEFAULT_SECTIONS)]
        + [{"kind": "datasets", "id": "sd", "order": 90}, {"kind": "provenance", "id": "sp", "order": 91}],
        "abbreviations": {"FU": hostile("functional unit")},
        "options": {"intended_public": True},
    }
    values: dict[str, str] = {}
    blocks, _missing = rr.blocks_for(report, study, lcia, contribution, data, {}, None, values)
    sources = rt.wrap_document(blocks, title=report["name"], study=study, lang="en", values=values)
    main = sources["main.typ"]

    # The chapters really were built — otherwise this would pass by rendering nothing.
    for heading in ("Life cycle inventory", "Annex", "Limitations", "Interpretation checks"):
        assert heading in main
    # Outside a Typst string literal, every `<` is escaped. Inside one it must NOT be: a literal is not
    # markup, and escaping there printed "Particulates, \< 2.5 um" in every inventory table.
    for line in main.split("\n"):
        for hit in re.finditer(r'(?<!\\)<0,2', line):
            quotes = len(re.findall(r'(?<!\\)"', line[: hit.start()]))
            assert quotes % 2 == 1, f"unescaped `<` in markup: {line[:120]}"

    assert typst_render.compile_pdf(sources).startswith(b"%PDF")


def test_the_phase_order_survives_the_route_that_produces_it(client, token, project):
    """V249's second half, and the reason it needed one: the render orders by `phase_order`, and the
    API is what puts the number there. The first version read `request.app.state.tag_groups` where the
    state calls it `tag_group_store`, a broad `except` swallowed the AttributeError, and a whole
    report came out alphabetical. A unit test on the sort could not see that; this walks the
    route that fills it."""
    import uuid

    from prism_lca.engine.report_variants import context_in_phase_order

    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    codes = {}
    for name in ("Use — coating", "Manufacturing — mixing"):
        r = client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token)
        assert r.status_code == 200
        codes[name] = r.json()["activity"]["code"]
    for name, value in (("Manufacturing — mixing", "Manufacturing"), ("Use — coating", "Use")):
        assert client.post(
            "/api/v1/model/tags/set",
            json={
                "keys": [{"database": db, "code": codes[name]}],
                "group": "Life-cycle phase",
                "value": value,
            },
            headers=token,
        ).status_code == 200

    context = context_in_phase_order(db, {"aggregate_by": "tag:Life-cycle phase"})
    order = {e["name"]: e["phase_order"] for e in context["foreground"]}
    assert order["Manufacturing — mixing"] < order["Use — coating"], order

    # No breakdown dimension, no order — and nothing else about the context changes.
    plain = context_in_phase_order(db, {})
    assert all("phase_order" not in e for e in plain["foreground"])


def test_several_indicators_put_their_name_in_the_caption():
    """V311. Three contribution figures called "Contribution by Life-cycle phase, one bar per
    assessed variant" cannot be told apart in the list of figures — and that list is where a reader
    goes looking for one of them. The indicator names them; with a single indicator there is nothing
    to tell apart and the caption stays as it was."""
    from prism_lca.engine import report_render

    report = {"sections": [{"id": "c", "kind": "contribution", "title": "Contribution"}]}
    view = {
        "dimension_label": "Life-cycle phase",
        "unit": "kg CO2-Eq",
        "groups": [{"key": "Production", "label": "Production", "impact": 0.8, "share": 0.67, "share_text": "67 %"}],
        "subjects": [],
    }
    data = {
        "contributions": [
            {"index": 0, "method_label": "EF v3.1 · climate change · GWP100", **view},
            {"index": 1, "method_label": "EF v3.1 · water use · UDP", **view},
        ]
    }

    def captions(payload: dict) -> list[str]:
        blocks = report_render.blocks_for(
            report,
            {},
            {},
            {},
            payload,
            {"contribution-grouped": "<svg/>", "contribution-1-grouped": "<svg/>"},
        )[0]
        return [b["caption"] for b in blocks if b.get("type") in {"figure", "table"} and b.get("caption")]

    both = captions(data)
    assert len(both) == len({c for c in both}), both
    assert any("climate change" in c for c in both), both
    assert any("water use" in c for c in both), both

    one = captions({"contributions": [data["contributions"][0]]})
    assert not [c for c in one if "climate change" in c], one


# --- background provenance ---------------------------------------------------


def _bg(bd, name: str) -> None:
    """A read-only background the registry recognises by its name."""
    from prism_lca.engine.guardrails import set_read_only

    bd.Database(name).write({(name, "x"): {"name": "x", "unit": "kg", "exchanges": []}})
    set_read_only(name, True)


def _fg_with(bd, name: str, inputs: list[tuple[str, str]]) -> None:
    from prism_lca.engine.guardrails import set_read_only

    exchanges = [{"input": (name, "p"), "amount": 1, "type": "production"}]
    exchanges += [{"input": key, "amount": 1, "type": "technosphere"} for key in inputs]
    bd.Database(name).write({(name, "p"): {"name": "p", "unit": "kg", "exchanges": exchanges}})
    set_read_only(name, False)


def test_a_model_without_background_names_none(client, token, project):
    """Two backgrounds installed, none used: the report used to name both as the origin."""
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.report_pipeline import _referenced_backgrounds

    bd = get_bd()
    _bg(bd, "ecoinvent-3.12-cutoff")
    _bg(bd, "bafu-2026-v1")
    _fg_with(bd, "own-only", [])
    assert _referenced_backgrounds("own-only") == ("", [])


def test_a_model_reaches_its_background_through_my_processes(client, token, project):
    """Model → library dataset → ecoinvent: ecoinvent is the origin, BAFU is not."""
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.library import LIBRARY_DB, ensure_library
    from prism_lca.engine.report_pipeline import _referenced_backgrounds

    bd = get_bd()
    _bg(bd, "ecoinvent-3.12-cutoff")
    _bg(bd, "bafu-2026-v1")
    ensure_library()
    lib = bd.Database(LIBRARY_DB)
    part = lib.new_activity(code="part", name="part", unit="kg", type="process")
    part.save()
    part.new_edge(input=part, amount=1, type="production").save()
    part.new_edge(input=("ecoinvent-3.12-cutoff", "x"), amount=2, type="technosphere").save()
    _fg_with(bd, "via-library", [(LIBRARY_DB, "part")])
    names, entries = _referenced_backgrounds("via-library")
    assert names == "ecoinvent-3.12-cutoff"
    assert [e["database"] for e in entries] == ["ecoinvent-3.12-cutoff"]


def test_the_lci_intro_does_not_name_an_origin_the_model_does_not_have():
    from prism_lca.engine.report_i18n import t

    for lang in ("en", "de", "fr", "es", "pt"):
        own = t("lci.intro_plain_own", lang)
        assert own and "{background}" not in own and own != "lci.intro_plain_own"
        assert t("lci.intro_own", lang) != "lci.intro_own"



def test_provenance_follows_a_library_process_back_into_another_model(client, token, project):
    """Move-to-library keeps a process's inputs, so a library dataset can draw on the model it came
    from: Model B → library → Model A → ecoinvent must still name ecoinvent."""
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.library import LIBRARY_DB, ensure_library
    from prism_lca.engine.report_pipeline import _referenced_backgrounds

    bd = get_bd()
    _bg(bd, "ecoinvent-3.12-cutoff")
    _fg_with(bd, "model-a", [("ecoinvent-3.12-cutoff", "x")])
    ensure_library()
    lib = bd.Database(LIBRARY_DB)
    moved = lib.new_activity(code="moved", name="moved", unit="kg", type="process")
    moved.save()
    moved.new_edge(input=moved, amount=1, type="production").save()
    moved.new_edge(input=("model-a", "p"), amount=1, type="technosphere").save()
    _fg_with(bd, "model-b", [(LIBRARY_DB, "moved")])
    assert _referenced_backgrounds("model-b")[0] == "ecoinvent-3.12-cutoff"
