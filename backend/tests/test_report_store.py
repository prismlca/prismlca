from __future__ import annotations

import pytest

from prism_lca.engine import report_model as rm
from prism_lca.errors import PrismError


def test_create_uses_the_iso_default_structure(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "rs"}, headers=token)
    r = client.post("/api/v1/report/create", json={"database": "rs", "name": "Client version"}, headers=token)
    assert r.status_code == 200, r.text
    rep = r.json()
    kinds = [s["kind"] for s in rep["sections"]]
    # The shape ISO 14044 §5 asks for, in reading order — with the abbreviations as front matter
    # right after the contents and the figure/table lists. The executive summary
    # is written last. Previously the default stopped after the contribution analysis, so a study
    # opened with no methods chapter, no interpretation checks and no conclusions unless the author
    # knew to add each one.
    assert kinds == [
        "summary",
        "abbreviations",
        # The background, before the goal and scope; its writer searches the literature.
        "introduction",
        "goal_scope",
        # The system model as a figure, beside the boundaries it draws.
        "system_model",
        # ISO 14040 order: what was modelled comes before what it scores.
        "inventory",
        "methods",
        "lcia",
        "contribution",
        "interpretation_checks",
        # The interpretation itself, a written chapter: what the results and the checks mean.
        "prose",
        # On by default: a chapter nobody adds is a chapter nobody writes, and it names
        # only what is genuinely absent (see test_report_limits.py).
        "limitations",
        "conclusions",
        "appendix",
        "references",
    ]
    assert [s["order"] for s in rep["sections"]] == list(range(len(kinds)))
    # Exact equality on purpose: a silently added option would otherwise never be noticed.
    assert rep["options"] == {
        "intended_public": False,
        "figures": {"heatmap": False, "radar": False, "stacked": False},
        "outlines": {"contents": True, "figures": True, "tables": True},
        # The threshold below which the check advises against calling one variant better (C2).
        "significance_percent": 5.0,
    }


def test_several_reports_per_model(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "rs2"}, headers=token)
    a = client.post("/api/v1/report/create", json={"database": "rs2", "name": "internal", "lang": "de"}, headers=token).json()
    b = client.post("/api/v1/report/create", json={"database": "rs2", "name": "client", "lang": "en"}, headers=token).json()
    listing = client.get("/api/v1/report/list/rs2", headers=token).json()["reports"]
    assert {x["name"] for x in listing} == {"internal", "client"}
    # The listing omits the sections but says how many there are.
    assert all("sections" not in x and x["section_count"] > 0 for x in listing)
    assert a["id"] != b["id"]


def test_reorder_and_delete_sections(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "rs3"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "rs3"}, headers=token).json()
    ids = [s["id"] for s in rep["sections"]]
    flipped = list(reversed(ids))
    r = client.post(f"/api/v1/report/one/rs3/{rep['id']}/reorder", json={"order": flipped}, headers=token)
    assert [s["id"] for s in r.json()["sections"]] == flipped
    assert [s["order"] for s in r.json()["sections"]] == list(range(len(ids)))

    r = client.post(f"/api/v1/report/one/rs3/{rep['id']}/sections/{ids[0]}/delete", headers=token)
    assert r.status_code == 200
    left = client.get(f"/api/v1/report/one/rs3/{rep['id']}", headers=token).json()["sections"]
    assert ids[0] not in [s["id"] for s in left]
    assert [s["order"] for s in left] == list(range(len(left)))  # renumbered, no gaps


def test_a_partial_reorder_keeps_the_sections_the_client_did_not_know(client, token, project):
    """A stale client must not be able to silently drop a section by omitting its id."""
    client.post("/api/v1/databases/foreground", json={"name": "rs4"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "rs4"}, headers=token).json()
    ids = [s["id"] for s in rep["sections"]]
    r = client.post(f"/api/v1/report/one/rs4/{rep['id']}/reorder", json={"order": [ids[2], ids[0]]}, headers=token)
    got = [s["id"] for s in r.json()["sections"]]
    assert got[:2] == [ids[2], ids[0]]
    assert set(got) == set(ids)


def test_a_frozen_section_refuses_content_changes(client, token, project):
    """The whole point of the flag: regenerating must not overwrite text a reviewer signed off."""
    client.post("/api/v1/databases/foreground", json={"name": "rs5"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "rs5"}, headers=token).json()
    # A free prose chapter is no longer in the default structure (the concrete ISO chapters are), so the
    # test adds the one it needs.
    sec = client.post(
        f"/api/v1/report/one/rs5/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    url = f"/api/v1/report/one/rs5/{rep['id']}/sections/{sec['id']}"

    client.post(url, json={"kind": "prose", "text": "Reviewed prose."}, headers=token)
    client.post(url, json={"kind": "prose", "locked": True}, headers=token)

    blocked = client.post(url, json={"kind": "prose", "text": "overwritten"}, headers=token)
    assert blocked.status_code == 400 and blocked.json()["error"]["code"] == "report_section_locked"
    # And it says *which* chapter. A chapter has no title of its own until somebody renames it, so the
    # raw field said "Section ''" here as well (V192); the fallback is the heading the chapter prints.
    assert blocked.json()["error"]["message"] == "Section 'Interpretation' is locked — unlock it first."
    still = client.get(f"/api/v1/report/one/rs5/{rep['id']}", headers=token).json()
    assert next(s for s in still["sections"] if s["id"] == sec["id"])["text"] == "Reviewed prose."

    # Unlocking in the same call is the documented way through.
    ok = client.post(url, json={"kind": "prose", "text": "new", "locked": False}, headers=token)
    assert ok.status_code == 200 and ok.json()["text"] == "new"


def test_project_defaults_do_not_rewrite_existing_reports(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "rs6"}, headers=token)
    before = client.post("/api/v1/report/create", json={"database": "rs6"}, headers=token).json()
    client.post(
        "/api/v1/report/defaults",
        json={"sections": [{"kind": "goal_scope", "title": "Ziel und Untersuchungsrahmen"}]},
        headers=token,
    )
    after = client.post("/api/v1/report/create", json={"database": "rs6"}, headers=token).json()
    assert [s["title"] for s in after["sections"]] == ["Ziel und Untersuchungsrahmen"]
    # The report that existed already is untouched — a default change must not rewrite finished work.
    unchanged = client.get(f"/api/v1/report/one/rs6/{before['id']}", headers=token).json()
    assert len(unchanged["sections"]) == len(before["sections"]) > 1


def test_unknown_section_kind_is_refused(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "rs7"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "rs7"}, headers=token).json()
    r = client.post(
        f"/api/v1/report/one/rs7/{rep['id']}/sections", json={"kind": "nonsense"}, headers=token
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "report_bad_kind"


def test_reports_follow_a_model_rename(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "rs-old"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "rs-old", "name": "keeps"}, headers=token).json()
    client.post("/api/v1/databases/foreground/rename", json={"database": "rs-old", "name": "rs-new"}, headers=token)
    assert client.get("/api/v1/report/list/rs-old", headers=token).json()["reports"] == []
    moved = client.get(f"/api/v1/report/one/rs-new/{rep['id']}", headers=token)
    assert moved.status_code == 200 and moved.json()["name"] == "keeps"


# ---- document model ---------------------------------------------------------

def test_blocks_render_to_typst():
    out = rm.render_blocks([
        rm.heading("Goal and scope", 1),
        rm.prose("Plain prose."),
        rm.kv([("Functional unit", "1 kg")]),
        rm.table(["A", "B"], [["x", "1.5"]], caption="Cap", align_right=[1], label="t-x"),
        rm.figure("charts/g.svg", caption="Fig", label="f-x"),
        rm.note("Aside."),
        rm.pagebreak(),
    ])
    assert "= Goal and scope" in out
    assert "#lca-kv((" in out and '("Functional unit", "1 kg")' in out
    assert "#lca-table(" in out and 'label-name: "t-x"' in out and "align-right: (1,)" in out
    assert "#lca-figure(" in out and 'caption: [Fig]' in out
    assert "#pagebreak()" in out


def test_a_single_column_row_still_forms_a_typst_array():
    """("x") is a parenthesised string in Typst, not a one-element array — the comma is load-bearing."""
    out = rm.render_block(rm.table(["Only"], [["v"]]))
    assert '("Only",)' in out and '("v",)' in out


def test_table_and_kv_degrade_instead_of_emitting_broken_markup():
    assert rm.render_block(rm.table([], [])) == ""
    assert "No data" in rm.render_block(rm.table(["A"], []))
    assert rm.render_block(rm.kv([("Label", "")])) == ""  # empty values are dropped, not printed


def test_unknown_block_type_is_a_programming_error():
    with pytest.raises(ValueError):
        rm.render_block({"type": "sparkline"})


def test_rendered_blocks_compile_as_a_document():
    """The model is only useful if what it emits is valid Typst — so compile it."""
    from prism_lca.engine import typst_render

    body = rm.render_blocks([
        rm.heading("Results", 1),
        rm.prose("See @t-r for the numbers."),
        rm.table(["Method", "Score"], [["IPCC #2", "1.2"]], caption="Results", align_right=[1], label="t-r"),
    ])
    sources = {
        "template.typ": typst_render.template_source(),
        "main.typ": '#import "template.typ": *\n#show: lca-report-template.with(title: "T")\n\n' + body,
    }
    assert typst_render.compile_pdf(sources).startswith(b"%PDF")


def test_store_errors_are_prism_errors(client, token, project):
    from prism_lca.engine.report_store import ReportStore

    with pytest.raises(PrismError):
        ReportStore().get("nope", "rep-does-not-exist")


def test_a_report_remembers_its_contribution_dimension(client, token, project):
    """It used to live only in the render request, so a writing brief for a report *with* a contribution
    chapter said no contribution analysis had been carried out — and a model dutifully wrote that."""
    client.post("/api/v1/databases/foreground", json={"name": "rs-agg"}, headers=token)
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "rs-agg", "name": "phases", "aggregate_by": "tag:Life cycle phase"},
        headers=token,
    ).json()
    assert rep["aggregate_by"] == "tag:Life cycle phase"
    url = f"/api/v1/report/one/rs-agg/{rep['id']}"
    changed = client.post(url, json={"aggregate_by": "geo"}, headers=token).json()
    assert changed["aggregate_by"] == "geo"
    assert client.get(url, headers=token).json()["aggregate_by"] == "geo"


def test_setting_one_option_keeps_the_others(client, token, project):
    """How a report lost its table of contents: a request that only switched on the comparison figures
    replaced `options` wholesale and took `outlines` with it."""
    client.post("/api/v1/databases/foreground", json={"name": "op"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "op", "name": "Options"}, headers=token).json()
    url = f"/api/v1/report/one/op/{rep['id']}"

    after = client.post(url, json={"options": {"figures": {"heatmap": True}}}, headers=token).json()
    assert after["options"]["figures"] == {"heatmap": True, "radar": False, "stacked": False}  # nested merge
    assert after["options"]["outlines"] == {"contents": True, "figures": True, "tables": True}
    assert after["options"]["significance_percent"] == 5.0


def test_the_update_endpoint_says_when_a_change_can_move_the_verdicts(client, token, project):
    """The panel re-checks the chapters only when the backend says a change can move them, so this
    list has to be the one the fingerprint really compares. The amount was in neither (V195), and the
    significance threshold — a number chapters quote — was in neither either."""
    client.post("/api/v1/databases/foreground", json={"name": "mv"}, headers=token)
    rep = client.post(
        "/api/v1/report/create", json={"database": "mv", "name": "Moves"}, headers=token
    ).json()
    url = f"/api/v1/report/one/mv/{rep['id']}"

    def moves(payload: dict) -> bool:
        return client.post(url, json=payload, headers=token).json()["affects_staleness"]

    assert moves({"amount": 10})
    assert moves({"lang": "de"})
    assert moves({"options": {"significance_percent": 15}})
    # How the document is dressed is not what the chapters were written against.
    assert not moves({"subtitle": "internal draft"})
    assert not moves({"options": {"outlines": {"contents": False}}})


def test_a_figure_path_is_escaped_as_a_string_not_as_markup():
    """It failed a whole fifteen-page document over a filename: `esc` escapes `_`, so
    `charts/contribution_grouped.svg` reached Typst as `charts/contribution\\_grouped.svg` and it
    refused the path. A string literal needs its quotes and backslashes escaped, nothing else."""
    out = rm.render_block(rm.figure("charts/a_b-c.svg", caption="Cap", label="f-a_b"))
    assert '"charts/a_b-c.svg"' in out and "\\_" not in out.split("caption")[0]
    assert 'label-name: "f-a_b"' in out
    # A quote in a path cannot break out of the literal.
    assert '\\"' in rm.render_block(rm.figure('charts/a"b.svg'))


def test_null_clears_a_field_and_bad_options_are_refused(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "rs3"}, headers=token)
    rep = client.post(
        "/api/v1/report/create", json={"database": "rs3", "subtitle": "internal draft"}, headers=token
    ).json()
    base = f"/api/v1/report/one/rs3/{rep['id']}"

    # `null` means "back to the default" — it used to be dropped silently, 200 and no change.
    r = client.post(base, json={"subtitle": None, "aggregate_by": None}, headers=token)
    assert r.status_code == 200
    back = client.get(base, headers=token).json()
    assert "subtitle" not in back and "aggregate_by" not in back

    # An option key nothing reads, or a flag of the wrong type, is a 400 at write time.
    assert client.post(base, json={"options": {"figuers": {}}}, headers=token).status_code == 400
    assert client.post(base, json={"options": {"intended_public": "yes"}}, headers=token).status_code == 400
    # Explicit null removes an option key from the merge.
    client.post(base, json={"options": {"significance_percent": 10}}, headers=token)
    client.post(base, json={"options": {"significance_percent": None}}, headers=token)
    assert "significance_percent" not in client.get(base, headers=token).json()["options"]

    # A patch that sets nothing must not pretend something changed.
    updated = client.get(base, headers=token).json()["updated"]
    client.post(base, json={}, headers=token)
    assert client.get(base, headers=token).json()["updated"] == updated


def test_deleting_a_model_deletes_its_reports(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "rs4"}, headers=token)
    client.post("/api/v1/report/create", json={"database": "rs4", "name": "doomed"}, headers=token)
    assert client.post("/api/v1/databases/foreground/delete", json={"database": "rs4"}, headers=token).status_code == 200
    client.post("/api/v1/databases/foreground", json={"name": "rs4"}, headers=token)
    # A recreated model with the same name must NOT resurrect the old model's reports.
    assert client.get("/api/v1/report/list/rs4", headers=token).json()["reports"] == []


def test_an_added_chapter_lands_where_it_belongs(client, token, project):
    """Appending was the old behaviour, and it produced documents whose executive summary sat after the
    abbreviations — a list nobody can hand over, fixable only by dragging ten rows."""
    client.post("/api/v1/databases/foreground", json={"name": "rs-order"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "rs-order"}, headers=token).json()
    base = f"/api/v1/report/one/rs-order/{rep['id']}/sections"

    # Remove the summary, then add it back: it must return to the front, not to the end.
    summary = next(s for s in rep["sections"] if s["kind"] == "summary")
    client.post(f"{base}/{summary['id']}/delete", headers=token)
    client.post(base, json={"kind": "summary"}, headers=token)
    client.post(base, json={"kind": "limitations"}, headers=token)
    kinds = [
        s["kind"]
        for s in client.get(f"/api/v1/report/one/rs-order/{rep['id']}", headers=token).json()["sections"]
    ]
    # Reading order: the summary opens the list (the renderer hoists it before the contents), the
    # abbreviations follow as front matter.
    assert kinds[0] == "summary"
    assert kinds[1] == "abbreviations"
    # Limitations belong with the interpretation, before the conclusions.
    assert kinds.index("limitations") == kinds.index("interpretation_checks") + 1
    assert kinds.index("limitations") < kinds.index("conclusions")
    assert kinds[-1] == "references"


def test_an_explicit_position_still_wins(client, token, project):
    """The canonical order is a default, not a rule: the list is drag-and-drop and `at` is how that
    reordering is expressed."""
    client.post("/api/v1/databases/foreground", json={"name": "rs-at"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "rs-at"}, headers=token).json()
    sec = client.post(
        f"/api/v1/report/one/rs-at/{rep['id']}/sections",
        json={"kind": "summary", "at": 3},
        headers=token,
    ).json()
    sections = client.get(f"/api/v1/report/one/rs-at/{rep['id']}", headers=token).json()["sections"]
    assert sections[3]["id"] == sec["id"]


def test_a_free_chapter_still_goes_to_the_end(client, token, project):
    """An unnamed prose chapter has no place in the reading order, and the end is where it surprises
    least."""
    client.post("/api/v1/databases/foreground", json={"name": "rs-prose"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "rs-prose"}, headers=token).json()
    added = client.post(
        f"/api/v1/report/one/rs-prose/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    sections = client.get(f"/api/v1/report/one/rs-prose/{rep['id']}", headers=token).json()["sections"]
    kinds = [s["kind"] for s in sections]
    at = [s["id"] for s in sections].index(added["id"])
    # After the narrative chapters, before the annex material — not beside the interpretation the
    # starting structure already has.
    assert at == kinds.index("conclusions") + 1
    assert at < kinds.index("appendix")


def test_the_annex_decides_how_many_inventory_rows_it_lists(client, token, project):
    """25 rows is a hotspot list, every flow is a data appendix, and both are legitimate annexes.

    The setting lives on the appendix chapter, because that is the only chapter it changes. 0 means all —
    thousands on an ecoinvent-backed model, which is why it is a choice and not the default.
    """
    from prism_lca.engine.report_store import (
        DEFAULT_INVENTORY_ROWS,
        MAX_INVENTORY_ROWS,
        ReportStore,
    )

    client.post("/api/v1/databases/foreground", json={"name": "inv"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "inv", "name": "Annex length"}, headers=token).json()
    appendix = next(s for s in rep["sections"] if s["kind"] == "appendix")
    assert appendix.get("inventory_rows") is None  # unset = the default, not a stored 25

    url = f"/api/v1/report/one/inv/{rep['id']}/sections/{appendix['id']}"
    assert client.post(url, json={"kind": "appendix", "inventory_rows": 0}, headers=token).status_code == 200
    stored = ReportStore().get("inv", rep["id"])
    assert next(s for s in stored["sections"] if s["kind"] == "appendix")["inventory_rows"] == 0

    assert client.post(url, json={"kind": "appendix", "inventory_rows": 120}, headers=token).status_code == 200
    bad = client.post(url, json={"kind": "appendix", "inventory_rows": MAX_INVENTORY_ROWS + 1}, headers=token)
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "report_inventory_rows"
    assert client.post(url, json={"kind": "appendix", "inventory_rows": -1}, headers=token).status_code == 400
    assert DEFAULT_INVENTORY_ROWS == 25


def test_the_wording_a_change_replaced_is_kept(client, token, project):
    """The safety net under a rewrite.

    "Write all" is the one operation in this panel that destroys something the author may have spent
    an afternoon on, and "what did it say before?" had no answer: the read-marker diff only covers a
    chapter that was explicitly marked read, which the version just overwritten almost never was.
    """
    client.post("/api/v1/databases/foreground", json={"name": "prev"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "prev"}, headers=token).json()
    sec = client.post(
        f"/api/v1/report/one/prev/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    url = f"/api/v1/report/one/prev/{rep['id']}/sections/{sec['id']}"

    def stored() -> dict:
        got = client.get(f"/api/v1/report/one/prev/{rep['id']}", headers=token).json()
        return next(s for s in got["sections"] if s["id"] == sec["id"])

    # Nothing to keep the first time: an empty chapter had no wording to lose.
    client.post(url, json={"kind": "prose", "text": "First wording."}, headers=token)
    assert stored().get("previous") is None

    client.post(url, json={"kind": "prose", "text": "Second wording."}, headers=token)
    assert stored()["previous"]["text"] == "First wording."

    # One step, not a history: the next change replaces it.
    client.post(url, json={"kind": "prose", "text": "Third wording."}, headers=token)
    assert stored()["previous"]["text"] == "Second wording."

    # Putting it back is an ordinary text change, so the round trip is reversible both ways.
    client.post(url, json={"kind": "prose", "text": "Second wording."}, headers=token)
    back = stored()
    assert back["text"] == "Second wording."
    assert back["previous"]["text"] == "Third wording."

    # A save that changes nothing must not throw the earlier wording away.
    client.post(url, json={"kind": "prose", "text": "Second wording."}, headers=token)
    assert stored()["previous"]["text"] == "Third wording."


def test_replacing_the_chapter_list_is_refused_once_a_chapter_holds_text(client, token, project):
    """`replace_sections` swaps every chapter at once; the bundle import uses it on a report it has just
    created. On one with written text it must refuse — reviewed prose is not ours to discard."""
    from prism_lca.engine.report_store import ReportStore

    client.post("/api/v1/databases/foreground", json={"name": "ro"}, headers=token)
    rep = client.post("/api/v1/report/create", json={"database": "ro", "name": "swap"}, headers=token).json()
    url = f"/api/v1/report/one/ro/{rep['id']}"
    store = ReportStore()

    # With nothing written, a new list applies.
    swapped = store.replace_sections("ro", rep["id"], [{"kind": "lcia"}, {"kind": "prose"}])
    assert [s["kind"] for s in swapped["sections"]] == ["lcia", "prose"]

    # Write something, and it must not be replaceable.
    written = next(s for s in client.get(url, headers=token).json()["sections"] if s["kind"] == "prose")
    client.post(f"{url}/sections/{written['id']}", json={"kind": "prose", "text": "Reviewed prose."}, headers=token)
    with pytest.raises(PrismError) as raised:
        store.replace_sections("ro", rep["id"], [{"kind": "appendix"}])
    assert raised.value.code == "report_outline_would_discard"
    assert "1 chapter" in str(raised.value)
    # And nothing changed.
    assert any(s.get("text") == "Reviewed prose." for s in client.get(url, headers=token).json()["sections"])
