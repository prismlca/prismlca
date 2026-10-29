from __future__ import annotations

import base64
import io
import json
import re
import zipfile

from prism_lca.engine.bootstrap import get_bd

#: A stand-in for a figure the renderer would have drawn. The backend never draws, so a bundle only has
#: a `charts/` directory when the client hands one over — which is why the export is tested both ways.
_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40"/></svg>'


def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("bd").write(
        {
            ("bd", "a"): {
                "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
                "exchanges": [
                    {"input": ("bd", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _report(client, token, **kw):
    payload = {
        "database": "bd",
        "name": "Client report",
        "methods": [["t", "gwp"]],
        "subjects": [{"database": "bd", "code": "a"}],
    }
    payload.update(kw)
    return client.post("/api/v1/report/create", json=payload, headers=token).json()


def _zip(client, token, rep):
    r = client.post(f"/api/v1/report/one/bd/{rep['id']}/bundle", json={}, headers=token)
    assert r.status_code == 200, r.text
    return r.json(), zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"])))


def test_the_bundle_contains_a_compilable_typst_project(client, token, project):
    """A PDF is an endpoint; these files are a working state. That was the reason for choosing Typst,
    so the bundle has to be complete enough to compile without PrismLCA."""
    _seed(get_bd())
    meta, zf = _zip(client, token, _report(client, token))
    names = set(zf.namelist())
    assert {"main.typ", "template.typ", "data.json", "README.md"} <= names
    # The colophon's mark, and no author logo: a cover carries one only when the project stored one.
    assert "prism-mark.png" in names and "prism-logo.png" not in names
    assert meta["filename"] == "Client report.zip"

    # Compile what the user would compile — the real check that the bundle stands on its own.
    from prism_lca.engine import typst_render

    sources: dict[str, str | bytes] = {}
    for name in names:
        raw = zf.read(name)
        # By extension, like a person unpacking it would: the cover may be a JPEG.
        sources[name] = raw if name.endswith((".png", ".jpg", ".jpeg", ".svg")) else raw.decode("utf-8")
    sources.pop("README.md")
    sources.pop("data.json")
    assert typst_render.compile_pdf(sources).startswith(b"%PDF")


def test_the_readme_states_who_owns_which_files(client, token, project):
    """The hand-off contract only works if the person receiving it knows it exists."""
    _seed(get_bd())
    _meta, zf = _zip(client, token, _report(client, token))
    readme = zf.read("README.md").decode("utf-8")
    assert "**yours**" in readme and "**ours**" in readme
    assert "typst compile main.typ" in readme
    assert "SIL OFL" in readme


#: A file or directory the README names in backticks. Prose in backticks (`#pval("…")`) is not a path,
#: so only names with a real extension — or a trailing slash — count as a promise about the archive.
_PATH_IN_README = re.compile(r"`([^`\n]+)`")


def _promised_paths(readme: str) -> set[str]:
    return {
        token
        for token in _PATH_IN_README.findall(readme)
        if token.endswith("/") or re.search(r"\.(typ|json|png|jpe?g|svg|md)$", token)
    }


def test_the_readme_names_exactly_the_files_the_archive_contains(client, token, project):
    """The guard that keeps the note and the ZIP from drifting apart.

    They did drift: the README promised a `chapters/` directory and explained an ownership split along
    it, in an export that has always been a single `main.typ`. The recipient is the one person who
    cannot check such a claim against the app, so both directions are asserted — nothing named is
    missing from the archive, and nothing in the archive goes unmentioned. A new file in the bundle
    therefore fails here until the note says what it is.
    """
    _seed(get_bd())
    for figures in ({}, {"lcia-0": _SVG, "contribution": _SVG}):
        r = client.post(
            f"/api/v1/report/one/bd/{_report(client, token)['id']}/bundle",
            json={"figures": figures},
            headers=token,
        )
        assert r.status_code == 200, r.text
        zf = zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"])))
        names = set(zf.namelist())
        promised = _promised_paths(zf.read("README.md").decode("utf-8"))
        for path in promised:
            if path.endswith("/"):
                assert any(n.startswith(path) for n in names), f"README promises {path}, archive has none"
            else:
                assert path in names, f"README promises {path}, which is not in the archive"
        for name in names - {"README.md"}:
            assert name in promised or any(
                name.startswith(p) for p in promised if p.endswith("/")
            ), f"{name} is in the archive and the README never mentions it"
        # And the layout the old note described is still not the one we ship, so it must not come back.
        assert "#include" not in zf.read("main.typ").decode("utf-8")


def test_the_bundle_carries_the_resolved_data_snapshot(client, token, project):
    _seed(get_bd())
    _meta, zf = _zip(client, token, _report(client, token))
    data = json.loads(zf.read("data.json"))
    assert data["results"][0]["score"] > 0
    assert data["activity"]["name"] == "widget"


def test_data_only_returns_the_numbers_without_the_prose(client, token, project):
    """The "update data only" half: dropping these into an exported bundle refreshes every figure in
    text the author has since rewritten, because the text references values instead of containing them."""
    _seed(get_bd())
    rep = _report(client, token)
    r = client.post(f"/api/v1/report/one/bd/{rep['id']}/data", json={}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert json.loads(body["data_json"])["results"][0]["score"] > 0
    assert "main.typ" not in body and "charts" in body
    # `values.json` has to be among them, and it has to be the very file the project compiles against:
    # without it a refresh moves the tables and the charts and leaves every sentence the author rewrote
    # quoting the numbers of the export it was written against.
    _meta, zf = _zip(client, token, rep)
    assert body["values_json"] == zf.read("values.json").decode("utf-8")
    # And the tables' own file, for the same reason.
    assert body["tables_json"] == zf.read("tables.json").decode("utf-8")


def test_the_data_archive_carries_only_what_a_refresh_may_overwrite(client, token, project):
    """The route the hand-over note recommends, as files rather than as strings.

    Two properties matter and both are here: everything a refresh needs travels, and nothing the
    recipient owns does — a data update that shipped `main.typ` would silently revert an afternoon of
    their editing.
    """
    _seed(get_bd())
    rep = _report(client, token)
    r = client.post(
        f"/api/v1/report/one/bd/{rep['id']}/data/archive",
        json={"figures": {"lcia": _SVG}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    zf = zipfile.ZipFile(io.BytesIO(base64.b64decode(body["base64"])))
    names = set(zf.namelist())
    assert "values.json" in names and "data.json" in names
    assert any(n.startswith("charts/") for n in names)
    assert not {n for n in names if n.endswith(".typ")}
    assert "README.md" not in names
    assert json.loads(zf.read("data.json"))["results"][0]["score"] > 0
    # The same bytes the full export compiles against, so dropping this in beside an edited `main.typ`
    # cannot move the prose and the tables apart.
    _meta, full = _zip(client, token, rep)
    assert zf.read("values.json") == full.read("values.json")
    assert body["filename"] == "Client report — data.zip"


def test_the_data_archive_reports_gaps_instead_of_refusing_them(client, token, project):
    """`/pdf` and `/bundle` refuse a document with holes because the hole would be printed. This one
    prints nothing, and the recipient whose sentence quotes a vanished key needs it to find out."""
    _seed(get_bd())
    rep = _report(client, token)
    sec = client.post(
        f"/api/v1/report/one/bd/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    client.post(
        f"/api/v1/report/one/bd/{rep['id']}/sections/{sec['id']}",
        json={"kind": "prose", "text": "Nonsense: {{does.not.exist}}"},
        headers=token,
    )
    r = client.post(f"/api/v1/report/one/bd/{rep['id']}/data/archive", json={}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["missing_placeholders"]


def test_a_bundle_for_a_custom_template_ships_that_template(client, token, project):
    _seed(get_bd())
    source = client.get("/api/v1/report/templates/prism-network/source", headers=token).json()["source"]
    client.post("/api/v1/report/templates", json={"name": "house", "source": source}, headers=token)
    rep = _report(client, token, template="house")
    _meta, zf = _zip(client, token, rep)
    assert "lca-report-template" in zf.read("template.typ").decode("utf-8")


def test_outlines_are_generated_by_typst_when_the_report_asks_for_them(client, token, project):
    _seed(get_bd())
    rep = _report(client, token)
    client.post(
        f"/api/v1/report/one/bd/{rep['id']}",
        json={"options": {"outlines": {"contents": True, "figures": True, "tables": True}}},
        headers=token,
    )
    main = client.post(f"/api/v1/report/one/bd/{rep['id']}/sources", json={}, headers=token).json()["files"]["main.typ"]
    assert "#lca-outlines(contents: true, figures: true, tables: true)" in main
    assert client.post(f"/api/v1/report/one/bd/{rep['id']}/pdf", json={}, headers=token).status_code == 200


def test_the_executive_summary_opens_the_document_before_the_contents(client, token, project):
    """The summary is front matter BEFORE the table of contents — hoisted by the
    renderer whatever the stored section order says, which is also why the chapter list pins it."""
    _seed(get_bd())
    rep = _report(client, token)
    main = client.post(f"/api/v1/report/one/bd/{rep['id']}/sources", json={}, headers=token).json()[
        "files"
    ]["main.typ"]
    assert "#lca-outlines(" in main
    assert main.index("Executive summary") < main.index("#lca-outlines(")
    # …unnumbered (front matter), and the abbreviations pinned directly behind the generated
    # lists — unnumbered too, so the chapter count starts at goal & scope.
    assert "#heading(level: 1, numbering: none)[Executive summary]" in main
    assert "#heading(level: 1, numbering: none)[Abbreviations]" in main
    after_outlines = main[main.index("#lca-outlines(") :]
    assert after_outlines.index("Abbreviations") < after_outlines.index("Goal and scope")


def test_a_filename_with_awkward_characters_still_produces_a_zip(client, token, project):
    _seed(get_bd())
    rep = _report(client, token, name='PCF: "bottle" / v2')
    meta, _zf = _zip(client, token, rep)
    assert "/" not in meta["filename"] and meta["filename"].endswith(".zip")


def _bundle_sources(zf: zipfile.ZipFile) -> dict[str, str | bytes]:
    """The archive as the compiler sees it, the way a person unpacking it would read it."""
    sources: dict[str, str | bytes] = {}
    for name in zf.namelist():
        raw = zf.read(name)
        sources[name] = raw if name.endswith((".png", ".jpg", ".jpeg", ".svg")) else raw.decode("utf-8")
    return sources


def _pdf_text(pdf: bytes) -> str:
    from pdfminer.high_level import extract_text

    return extract_text(io.BytesIO(pdf))


def _write_widget(bd, co2: float) -> None:
    bd.Database("bd").write(
        {
            ("bd", "a"): {
                "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
                "exchanges": [
                    {"input": ("bd", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": co2, "type": "biosphere"},
                ],
            }
        }
    )


def test_a_data_refresh_renews_the_tables_beside_the_text(client, token, project):
    """The tables used to be literals in `main.typ`, so a data refresh moved the sentences and
    left the table beside them on the export's numbers — text 200, table 100.

    The whole route, as a recipient walks it: export, the model changes, the data archive is dropped in
    beside the (untouched) `main.typ`, recompile. The results table has to show the new score, and the
    old one must be gone from the document.
    """
    from prism_lca.engine import typst_render

    bd = get_bd()
    _seed(bd)
    _write_widget(bd, 1.37)
    rep = _report(client, token, sections=[{"kind": "lcia"}])
    _meta, zf = _zip(client, token, rep)
    exported = _bundle_sources(zf)
    assert "#ptable(" in exported["main.typ"] and "1.37" not in exported["main.typ"]
    assert "1.37" in _pdf_text(typst_render.compile_pdf(exported))

    _write_widget(bd, 2.74)  # the score doubles
    # Written behind the API's back, so the caches an edit through the app would drop are dropped here.
    from prism_lca.engine import lca, report_snapshot

    lca.invalidate_lca_cache()
    report_snapshot.invalidate()
    r = client.post(f"/api/v1/report/one/bd/{rep['id']}/data/archive", json={}, headers=token)
    assert r.status_code == 200, r.text
    refresh = zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"])))
    assert "tables.json" in refresh.namelist()
    assert not {n for n in refresh.namelist() if n.endswith(".typ")}

    refreshed = {**exported, **_bundle_sources(refresh)}
    assert refreshed["main.typ"] == exported["main.typ"]
    text = _pdf_text(typst_render.compile_pdf(refreshed))
    assert "2.74" in text and "1.37" not in text


def test_a_table_the_refresh_no_longer_carries_says_so():
    """Like a vanished `pval` key: a visible marker, never a failed compile or a stale table."""
    from prism_lca.engine import report_model as rm
    from prism_lca.engine import report_typst, typst_render

    sources = report_typst.wrap_document(
        [rm.table(["Group", "Share"], [["Packaging", "60 %"]], caption="Shares", label="t-shares")],
        title="T",
        generated="2026-01-01 00:00 UTC",
    )
    assert json.loads(sources["tables.json"])["t-shares"]["rows"] == [["Packaging", "60 %"]]
    assert "Packaging" in _pdf_text(typst_render.compile_pdf(sources))
    sources["tables.json"] = "{}"
    text = _pdf_text(typst_render.compile_pdf(sources))
    assert "[missing table: t-shares]" in text and "Packaging" not in text


def test_acronyms_in_a_table_are_still_candidates(client, token, project):
    """The glossary scan used to read `main.typ`, where the table cells stood. They are in `tables.json`
    now, and an acronym that stands only in a table must not drop out of the candidates."""
    from prism_lca.engine import report_typst

    sources = {
        "main.typ": '#ptable(\n  "t-x",\n)\n',
        "tables.json": json.dumps({"t-x": {"headers": ["Dataset"], "rows": [["market for PVC, RER"]]}}),
    }
    assert "PVC" in report_typst.document_text(sources)


def _export_then_refresh(client, token, rep, change) -> tuple[str, str]:
    """Export `rep`, apply `change`, drop the data archive in beside the untouched `main.typ`, recompile.

    Returns the text of the exported PDF and of the refreshed one — the route a recipient walks."""
    from prism_lca.engine import lca, report_snapshot, typst_render

    _meta, zf = _zip(client, token, rep)
    exported = _bundle_sources(zf)
    before = _pdf_text(typst_render.compile_pdf(exported))
    change()
    lca.invalidate_lca_cache()
    report_snapshot.invalidate()
    r = client.post(f"/api/v1/report/one/bd/{rep['id']}/data/archive", json={}, headers=token)
    assert r.status_code == 200, r.text
    refresh = _bundle_sources(zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"]))))
    return before, _pdf_text(typst_render.compile_pdf({**exported, **refresh}))


def test_a_table_printed_twice_is_refreshed_both_times(client, token, project):
    """The inventory chapter and the annex both print the parameter table,
    and the label dedup takes the second one's label away. Keyed by label, that second table stayed a
    literal — refreshed document: 2.74 in the inventory, 1.37 in the annex, no gap reported. Every table
    now has a data key of its own, scoped by its chapter."""
    _seed(get_bd())
    client.post("/api/v1/params", json={"database": "bd", "name": "mass", "amount": 1.37, "unit": "kg"}, headers=token)
    rep = _report(
        client, token, sections=[{"kind": "inventory", "inventory_parts": ["parameters"]}, {"kind": "appendix"}]
    )

    def change():
        r = client.post("/api/v1/params", json={"database": "bd", "name": "mass", "amount": 2.74, "unit": "kg"}, headers=token)
        assert r.status_code == 200, r.text

    before, after = _export_then_refresh(client, token, rep, change)
    assert before.count("1.37") >= 2
    assert after.count("2.74") >= 2 and "1.37" not in after


def _seed_three_indicators(bd) -> None:
    bd.Database("biosphere").write(
        {
            ("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"},
            ("biosphere", "so2"): {"name": "SO2", "type": "emission", "categories": ("air",), "unit": "kg"},
        }
    )
    bd.Database("bd").write(
        {
            ("bd", "a"): {
                "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
                "exchanges": [
                    {"input": ("bd", "a"), "amount": 1, "type": "production"},
                    {"input": ("bd", "b"), "amount": 1.0, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            },
            ("bd", "b"): {
                "name": "part", "unit": "kg", "reference product": "part", "location": "RER",
                "exchanges": [
                    {"input": ("bd", "b"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "so2"), "amount": 1.0, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp", "a")).write([(("biosphere", "co2"), 1.11)])
    bd.Method(("t", "acid", "b")).write([(("biosphere", "so2"), 5.55)])
    bd.Method(("t", "tox", "c")).write([(("biosphere", "so2"), 8.88)])


def test_a_refresh_after_the_method_list_changed_leaves_a_gap_not_another_indicator(client, token, project):
    """`t-contribution-1` is whichever indicator is second today. Keyed by
    it, a refresh after the method list changed put the new second indicator's numbers under the old
    one's caption, without a word. Keyed by what the table is, the old indicator's table is a visible gap
    and the new indicator's numbers appear nowhere the author has not placed them."""
    _seed_three_indicators(get_bd())
    rep = _report(
        client, token,
        methods=[["t", "gwp", "a"], ["t", "acid", "b"]],
        aggregate_by="geo",
        sections=[{"kind": "contribution"}],
    )

    def change():
        r = client.post(
            f"/api/v1/report/one/bd/{rep['id']}",
            json={"methods": [["t", "gwp", "a"], ["t", "tox", "c"]]},
            headers=token,
        )
        assert r.status_code == 200, r.text

    before, after = _export_then_refresh(client, token, rep, change)
    assert "5.55" in before and "8.88" not in before
    assert "[missing table:" in after and "t / acid / b" in after
    assert "8.88" not in after  # the new indicator's breakdown is not slipped under the old caption
    assert "1.11" in after  # the unchanged indicator still refreshes


def _chart(name: str) -> str:
    """A stand-in chart that says which one it is, so a test can tell whose drawing sits in a file."""
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><desc>{name}</desc><rect width="80" height="40"/></svg>'


def _figures_for(methods: list[str], version: str) -> dict[str, str]:
    """The charts the renderer would send for a one-variant report split by `geo` — keyed as it keys them."""
    from prism_lca.engine import report_model as rm

    out: dict[str, str] = {}
    for label in methods:
        for key in (rm.chart_key("lcia", label), rm.chart_key("contribution", rm.indicator_identity("geo", label))):
            # The drawing names its own key, so whose chart sits in a file can be read off it.
            out[key] = _chart(f"{key} {version}")
    return out


def test_a_refresh_after_the_method_list_changed_leaves_a_figure_gap_not_another_indicator(client, token, project):
    """The charts' half of the table-keying fix. Named by position, `charts/contribution-1.svg` was
    the acidification chart in the export and the toxicity chart in the refresh, and the old caption sat
    over it without a word. Keyed by what they show, the acidification chart is a visible gap — the same
    gap its table leaves — the toxicity chart is placed nowhere the author has not put it, and the
    unchanged climate chart is refreshed."""
    from prism_lca.engine import lca, report_snapshot, typst_render
    from prism_lca.engine import report_model as rm

    _seed_three_indicators(get_bd())
    gwp, acid, tox = "t / gwp / a", "t / acid / b", "t / tox / c"
    rep = _report(
        client, token,
        methods=[["t", "gwp", "a"], ["t", "acid", "b"]],
        aggregate_by="geo",
        sections=[{"kind": "lcia"}, {"kind": "contribution"}],
    )
    r = client.post(f"/api/v1/report/one/bd/{rep['id']}/bundle", json={"figures": _figures_for([gwp, acid], "v1")}, headers=token)
    assert r.status_code == 200, r.text
    exported = _bundle_sources(zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"]))))
    main = str(exported["main.typ"])
    acid_chart = rm.chart_key("contribution", rm.indicator_identity("geo", acid))
    gwp_chart = rm.chart_key("contribution", rm.indicator_identity("geo", gwp))
    assert f'#pfigure(\n  "{acid_chart}",' in main and f'#pfigure(\n  "{rm.chart_key("lcia", acid)}",' in main
    # The chart and the table of one indicator carry one identity.
    assert any(k.endswith(f"/{acid_chart}") for k in json.loads(str(exported["tables.json"])))
    before = _pdf_text(typst_render.compile_pdf(exported))
    assert "[missing figure:" not in before

    r = client.post(f"/api/v1/report/one/bd/{rep['id']}", json={"methods": [["t", "gwp", "a"], ["t", "tox", "c"]]}, headers=token)
    assert r.status_code == 200, r.text
    lca.invalidate_lca_cache()
    report_snapshot.invalidate()
    r = client.post(
        f"/api/v1/report/one/bd/{rep['id']}/data/archive", json={"figures": _figures_for([gwp, tox], "v2")}, headers=token
    )
    assert r.status_code == 200, r.text
    refresh = _bundle_sources(zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"]))))
    merged = {**exported, **refresh}
    manifest = json.loads(str(merged["figures.json"]))
    # Acidification is gone from the list, so its `#pfigure` finds nothing — although its old file is
    # still lying in `charts/`, which is exactly what a person dropping the archive in ends up with.
    assert acid_chart not in manifest and rm.chart_path(acid_chart) in merged
    # Toxicity is drawn and listed, but no call in the author's `main.typ` names it.
    tox_chart = rm.chart_key("contribution", rm.indicator_identity("geo", tox))
    assert tox_chart in manifest and tox_chart not in main and manifest[tox_chart] not in main
    # Every chart the document places is its own indicator's, in today's drawing — not only climate change.
    placed = re.findall(r'#pfigure\(\n  "([^"]+)",', main)
    assert set(placed) == {acid_chart, gwp_chart, rm.chart_key("lcia", gwp), rm.chart_key("lcia", acid)}
    for key in placed:
        if key in manifest:
            assert f"{key} v2".encode() in bytes(merged[manifest[key]]), key
    assert {k for k in placed if k not in manifest} == {acid_chart, rm.chart_key("lcia", acid)}
    after = _pdf_text(typst_render.compile_pdf(merged))
    assert after.count("[missing figure:") == 2  # the acidification bar chart and its breakdown chart
    assert f"[missing figure: {acid_chart}]" in after.replace("\n", "")
    assert "[missing table:" in after  # and its table, the same gap


def test_an_export_says_that_positional_chart_exports_need_a_new_export(client, token, project):
    """Exports from before content keys embed `charts/contribution-1.svg` directly — no `figures.json`, no
    `#pfigure` — and nothing a refresh could put under that name is safe. The archive does not try (the
    notice files it once wrote were too high a price for one day of such exports); the
    README says to export again, a refresh refuses positional keys, and none of today's charts is placed
    under a positional name."""
    from prism_lca.engine import report_model as rm

    _seed_three_indicators(get_bd())
    gwp, tox = "t / gwp / a", "t / tox / c"
    rep = _report(
        client, token,
        methods=[["t", "gwp", "a"], ["t", "tox", "c"]],
        aggregate_by="geo",
        sections=[{"kind": "lcia"}, {"kind": "contribution"}],
    )
    r = client.post(
        f"/api/v1/report/one/bd/{rep['id']}/bundle", json={"figures": _figures_for([gwp, tox], "v1")}, headers=token
    )
    exported = _bundle_sources(zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"]))))
    readme = " ".join(str(exported["README.md"]).split())
    assert (
        "Exports made before 29 Sept 2026 name their charts by position; this archive cannot refresh them "
        "safely — export the report again." in readme
    )
    assert "`[missing figure: …]`" in readme
    r = client.post(
        f"/api/v1/report/one/bd/{rep['id']}/data/archive", json={"figures": _figures_for([gwp, tox], "v2")}, headers=token
    )
    assert r.status_code == 200, r.text
    refresh = _bundle_sources(zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"]))))
    # The old scheme's exact shapes (a hashed name may start with `contribution-` too).
    positional = re.compile(
        r"charts/(lcia-\d+|contribution(-d\d+)?(-\d+)?(-stacked|-grouped)?|summary|section-[a-z0-9]+(-\d+)?)\.svg"
    )
    charts = [n for n in refresh if n.startswith("charts/")]
    assert charts and not [n for n in charts if positional.fullmatch(n)]
    assert sorted(charts) == sorted(rm.chart_path(k) for k in _figures_for([gwp, tox], "v2"))
    # And a refresh drawn under the old names is refused, on both routes.
    for route in ("data", "data/archive"):
        r = client.post(
            f"/api/v1/report/one/bd/{rep['id']}/{route}", json={"figures": {"contribution-1": _SVG}}, headers=token
        )
        assert r.status_code == 400 and "positional_figure_keys" in r.text, route


def test_the_chart_keys_are_the_strings_the_renderer_builds():
    """The other half of lib/report/figures.test.ts: the renderer keys the charts it draws, this side
    places them by the same key, and a key rebuilt differently is a chart silently left out."""
    from prism_lca.engine import report_model as rm

    gwp = "t / gwp / a"
    assert rm.chart_key("contribution", rm.indicator_identity("geo", gwp)) == "contribution:geo|t / gwp / a"
    assert rm.section_chart_key("p", 2, {"kind": "bar", "source": "subjects", "value": ""}, gwp) == (
        "section:p/2|bar|subjects|||15|h|||t / gwp / a"
    )
    spec = {"kind": "bar", "source": "contribution.groups", "value": "impact", "label": "key", "stacked": True}
    assert rm.section_chart_key("p", None, spec, gwp, "tag:phase") == (
        "section:p/single|bar|contribution.groups|key|impact|15|h|stacked|tag:phase|t / gwp / a"
    )
    assert rm.section_chart_key("p", None, {"kind": "heatmap"}, gwp) == "section:p/single|heatmap"
    # A file name that is stable, readable, and cannot leave `charts/`; the report-wide charts keep theirs.
    path = rm.chart_path("lcia:../../etc / passwd")
    assert path == rm.chart_path("lcia:../../etc / passwd") and re.fullmatch(r"charts/[a-z0-9-]+\.svg", path)
    assert rm.chart_path("heatmap") == "charts/heatmap.svg"
    # A positional name is never a chart's file: an old export embeds those names directly.
    assert rm.chart_path("lcia-1") != "charts/lcia-1.svg"


def test_a_chapter_figure_key_names_everything_that_changes_the_drawing():
    """`contribution.groups` split by geography and by phase had one key, and so did
    stacked and plain, 15 rows and 30 — a refresh put phase bars under a caption about countries."""
    from prism_lca.engine import report_model as rm

    spec = {"kind": "bar", "source": "contribution.groups", "value": "impact", "label": "key"}
    base = rm.section_chart_key("p", 0, spec, "m", "geo")
    for other in (
        rm.section_chart_key("p", 0, spec, "m", "tag:phase"),
        rm.section_chart_key("p", 0, {**spec, "stacked": True}, "m", "geo"),
        rm.section_chart_key("p", 0, {**spec, "horizontal": False}, "m", "geo"),
        rm.section_chart_key("p", 0, {**spec, "rows": 30}, "m", "geo"),
        rm.section_chart_key("p", 0, {**spec, "value": "share_percent"}, "m", "geo"),
        rm.section_chart_key("p", 0, {**spec, "label": "name"}, "m", "geo"),
    ):
        assert other != base
    assert rm.section_chart_key("p", 0, {**spec, "rows": 15, "horizontal": True}, "m", "geo") == base
    # In the document: the chapter's figure is looked up under the report's own dimension.
    from prism_lca.engine import report_render

    report = {"sections": [{"id": "p", "kind": "prose", "text": "Ein Satz.", "figures": [spec]}]}

    def keys(dim: str) -> list[str]:
        data = {"breakdown_dimensions": [dim], "results": [{"method_label": "m"}]}
        drawn = {rm.section_chart_key("p", 0, spec, "m", "geo"): "<svg/>"}
        blocks = report_render.blocks_for(report, {}, {}, None, data, drawn, [], {})[0]
        return [b["key"] for b in blocks if b.get("type") == "figure"]

    assert keys("geo") == [base]
    assert keys("tag:phase") == []  # a phase split finds no geography chart


def test_chart_identities_cannot_be_aliased_through_their_delimiters():
    """`("tag:a|b", "c")` and `("tag:a", "b|c")` were one identity, and chapter `p`'s
    figure 0 was chapter `p/0`'s single figure."""
    from prism_lca.engine import report_model as rm

    assert rm.indicator_identity("tag:a|b", "c") != rm.indicator_identity("tag:a", "b|c")
    assert rm.section_chart_key("p", 0, {"kind": "heatmap"}, "") != rm.section_chart_key("p/0", None, {"kind": "heatmap"}, "")
    assert rm.key_part("50%|a/b", slash=True) == "50%25%7Ca%2Fb"


def test_two_chart_keys_never_share_a_file():
    """With forty bits of digest, `"lcia:" + "a"*50 + " / 755509"` and `… / 930784`
    were one file — the manifest listed both and one drawing stood under the other's caption. The digest
    is longer now, and `place_charts` refuses a collision rather than overwriting."""
    import pytest

    from prism_lca.engine import report_model as rm
    from prism_lca.engine import report_typst
    from prism_lca.errors import PrismError

    one, two = "lcia:" + "a" * 50 + " / 755509", "lcia:" + "a" * 50 + " / 930784"
    assert rm.chart_path(one) != rm.chart_path(two)
    placed = report_typst.place_charts({one: "<svg>1</svg>", two: "<svg>2</svg>"})
    assert json.loads(placed["figures.json"]) == {one: rm.chart_path(one), two: rm.chart_path(two)}
    original = rm.chart_path
    try:
        rm.chart_path = lambda key: "charts/same.svg"  # type: ignore[assignment]
        with pytest.raises(PrismError):
            report_typst.place_charts({one: "<svg>1</svg>", two: "<svg>2</svg>"})
    finally:
        rm.chart_path = original  # type: ignore[assignment]


def test_a_refresh_refuses_figures_named_by_position(client, token, project):
    """`figures={"lcia-1": …}` was placed as `charts/lcia-1.svg` — a chart back where
    an old export embeds it by position. Refused now, on both refresh routes."""
    _seed(get_bd())
    rep = _report(client, token)
    for route in ("data", "data/archive"):
        r = client.post(f"/api/v1/report/one/bd/{rep['id']}/{route}", json={"figures": {"lcia-1": _SVG}}, headers=token)
        assert r.status_code == 400, (route, r.text)
        assert "lcia-1" in r.text


def test_a_missing_figure_stays_a_reference_target_in_every_theme():
    """`See @f-one.` beside a chart the refresh no longer lists must still compile: the gap is a figure
    with the caption and the label, in every shipped theme."""
    from prism_lca.engine import report_model as rm
    from prism_lca.engine import report_typst, typst_render

    key = rm.chart_key("lcia", "t / gwp")
    blocks = [
        rm.prose("See @f-one."),
        rm.figure(rm.chart_path(key), caption="Climate change", label="f-one", key=key),
    ]
    for template_id in typst_render.BUILTIN_TEMPLATES:
        sources = report_typst.wrap_document(
            blocks,
            title="T",
            template=typst_render.builtin_template_source(template_id),
            generated="2026-01-01 00:00 UTC",
            figures={key: _SVG},
        )
        assert json.loads(str(sources["figures.json"])) == {key: rm.chart_path(key)}
        assert "[missing figure:" not in _pdf_text(typst_render.compile_pdf(sources)), template_id
        sources["figures.json"] = "{}"
        text = _pdf_text(typst_render.compile_pdf(sources))
        assert "[missing figure: lcia:t / gwp]" in text and "Climate change" in text, template_id


def test_a_missing_figure_keeps_the_width_it_was_given():
    """The gap ignored `width`. It is a block of that width now, so a narrow
    figure's gap is as narrow as the figure was."""
    from prism_lca.engine import report_model as rm
    from prism_lca.engine import report_typst, typst_render

    key = rm.chart_key("lcia", "t / gwp")
    block = rm.figure(rm.chart_path(key), caption="Climate change", label="f-one", key=key, width="40%")
    sources = report_typst.wrap_document([block], title="T", generated="2026-01-01 00:00 UTC")
    assert "width: 40%," in sources["main.typ"]
    assert 'block(width: if width == none { 100% } else { width }' in sources["main.typ"]
    assert "[missing figure: lcia:t / gwp]" in _pdf_text(typst_render.compile_pdf(sources))


def test_a_missing_or_empty_table_stays_a_reference_target():
    """`See @t-one.` beside a table the refresh no longer carries failed the
    whole compile ("label <t-one> does not exist"). The gap is a labelled table figure now — and so is an
    empty table, which never had a target at all."""
    from prism_lca.engine import report_model as rm
    from prism_lca.engine import report_typst, typst_render

    blocks = [
        rm.prose("See @t-one and @t-empty."),
        rm.table(["Group", "Share"], [["Packaging", "60 %"]], caption="Shares", label="t-one"),
        rm.table(["Group", "Share"], [], caption="Nothing", label="t-empty"),
    ]
    sources = report_typst.wrap_document(blocks, title="T", generated="2026-01-01 00:00 UTC")
    text = _pdf_text(typst_render.compile_pdf(sources))
    assert "Packaging" in text and "No data." in text
    sources["tables.json"] = "{}"
    text = _pdf_text(typst_render.compile_pdf(sources))
    assert text.count("[missing table:") == 2 and "Packaging" not in text


def test_a_cited_table_without_a_caption_is_a_reference_target_in_every_theme():
    """The glossary is a labelled table without a caption, and every theme
    prints such a table bare, dropping its label — `See @t-abbrev.` failed the compile ("label <t-abbrev>
    does not exist"). Cited, it is wrapped in a table figure; uncited, it typesets bare as before, so no
    report that does not cite it gains a table number."""
    from prism_lca.engine import report_model as rm
    from prism_lca.engine import report_typst, typst_render

    glossary = rm.table(["Abbreviation", "Meaning"], [["GWP", "Global warming potential"]], label="t-abbrev")
    cited = [rm.prose("See @t-abbrev."), glossary]
    for template_id in typst_render.BUILTIN_TEMPLATES:
        sources = report_typst.wrap_document(
            cited,
            title="T",
            template=typst_render.builtin_template_source(template_id),
            generated="2026-01-01 00:00 UTC",
        )
        assert "cited: true" in sources["main.typ"]
        text = _pdf_text(typst_render.compile_pdf(sources))
        assert "Global warming potential" in text, template_id
    uncited = report_typst.wrap_document([rm.prose("No reference here."), glossary], title="T")
    assert "cited: true" not in uncited["main.typ"]
