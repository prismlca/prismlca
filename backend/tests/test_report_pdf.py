from __future__ import annotations

import pytest

from prism_lca.engine import report_typst, typst_render


def test_default_template_satisfies_its_own_contract():
    """The fixture exercises every part of the template contract. If this breaks, a custom template
    would fail in exactly the same way — which is the point of validating against it."""
    typst_render.validate_template(typst_render.template_source())


def test_a_broken_template_is_rejected_with_the_compiler_message():
    with pytest.raises(Exception) as exc:
        typst_render.validate_template("#let lca-kv(pairs) = pairs\n")  # missing the other three
    assert "typeset" in str(exc.value).lower()


def test_a_theme_missing_a_contract_function_is_told_which_one(monkeypatch):
    """The author's likeliest mistake, answered once instead of one symbol per upload.

    A theme that defines the show rule and stops used to be refused with "unknown variable:
    lca-outlines" — an internal name nobody has read, and the next attempt revealed the next one.
    """
    source = "#let lca-report-template(..args, body) = { body }\n"
    with pytest.raises(Exception) as exc:
        typst_render.validate_template(source)
    message = str(exc.value)
    assert "lca-outlines" in message and "lca-kv" in message and "lca-table" in message
    # …and the way out is a file, not a guess.
    assert "Download one of the themes" in message
    assert getattr(exc.value, "code", "") == "report_template_contract"
    # The compiler's own words are kept, they just stop being the whole answer.
    assert "unknown variable" in (getattr(exc.value, "hint", "") or "")


def test_a_syntax_error_keeps_the_compilers_own_message():
    """The contract sentence is additive. A theme that defines all five and simply does not parse must
    not be told it is missing functions — that would send its author looking in the wrong place."""
    source = typst_render.template_source().replace("#let lca-kv(", "#let lca-kv((((")
    with pytest.raises(Exception) as exc:
        typst_render.validate_template(source)
    assert getattr(exc.value, "code", "") == "typst_compile_failed"


def test_every_shipped_theme_defines_the_contract_it_documents():
    """The comment in each template listed four functions while the fixture called five, so a theme
    author following it hit a wall. One check, so the list and the reality cannot drift apart again."""
    from prism_lca.engine.typst_render import _ASSETS, TEMPLATE_CONTRACT

    files = sorted((_ASSETS / "typst").glob("template*.typ"))
    assert len(files) >= 5
    for path in files:
        source = path.read_text(encoding="utf-8")
        for name in TEMPLATE_CONTRACT:
            assert f"#let {name}" in source, f"{path.name} does not define {name}"
        assert "exactly these five things" in source, f"{path.name} still documents the old contract"


def test_wrap_document_produces_a_pdf_with_the_colophon():

    study = {"goal": "PCF of a bottle", "functional_unit": "1 bottle", "author": "Example Org"}
    lcia = {
        "activity": {"name": "bottle", "database": "Test", "code": "b1"},
        "amount": 1.0,
        "results": [{"method": ["test", "gwp"], "unit": "kg CO2-eq", "score": 1.25}],
    }
    blocks = report_typst.goal_scope_blocks(study) + report_typst.lcia_blocks(lcia, study)
    sources = report_typst.wrap_document(
        blocks, title="PCF of a bottle", study=study, app_version="9.9.9", generated="2026-01-01 00:00 UTC"
    )
    # The attribution is written by the assembler, not the template — a custom template cannot drop it.
    assert "Generated with PrismLCA 9.9.9" in sources["main.typ"]
    assert "prism-mark.png" in sources
    assert "https://prismlca.com" in sources["main.typ"]

    pdf = typst_render.compile_pdf(sources)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 1000


def test_typst_markup_is_escaped_so_dataset_names_cannot_break_the_document():
    """A name like "market for electricity #2" would otherwise start a Typst code expression."""
    from prism_lca.engine import report_model as rm

    assert report_typst.esc("market #2 [DE] *x*") == "market \\#2 \\[DE\\] \\*x\\*"
    study = {"goal": "A #hash and a $dollar", "notes": "uses @ and _underscores_"}
    blocks = report_typst.goal_scope_blocks(study) + [rm.prose(rm.markup(study["notes"]))]
    pdf = typst_render.compile_pdf(report_typst.wrap_document(blocks, title=study["goal"], study=study))
    assert pdf.startswith(b"%PDF")


def test_a_compile_error_says_where_it_stopped():
    """Typst's message is "unclosed label" and nothing else — which is what a whole failed report told
    its author in V170, with no way to find the sentence that caused it. The compiler does know the
    position; the hint carries it, plus the chapter heading above it and the offending line."""
    source = "= Goal and scope\n\nfine\n\n= Limitations\n\n<0,2 % surfactants\n"
    with pytest.raises(Exception) as exc:
        typst_render.compile_pdf({"main.typ": source, "template.typ": "#let unused = 1\n"})
    assert "unclosed label" in str(exc.value)
    hint = exc.value.hint
    assert "main.typ, line 7" in hint
    assert "Limitations" in hint  # the chapter, not just a line number
    assert "<0,2 % surfactants" in hint


def test_a_compile_error_without_a_usable_position_still_reports_the_message():
    """The location is an addition, never a precondition: anything unexpected in the diagnostic must
    not turn a compiler error into an error about reading the compiler error."""
    assert typst_render._where_it_failed(RuntimeError("boom"), {"main.typ": "= x\n"}) is None
    with pytest.raises(Exception) as exc:
        typst_render.compile_pdf({"main.typ": "#panic(\"nope\")\n"})
    assert "could not be typeset" in str(exc.value)
    assert "If a custom template is in use" in exc.value.hint


def test_missing_main_source_is_a_named_error():
    with pytest.raises(Exception) as exc:
        typst_render.compile_pdf({"other.typ": "= x"}, main="main.typ")
    assert "main.typ" in str(exc.value)


# ---- preview: the typeset page, not an HTML lookalike -----------------------
def test_a_page_renders_as_png_and_reports_the_page_count():
    """The preview goes through the same compiler as the PDF, so it cannot show something the document
    does not contain — which is the whole reason it replaces the HTML approximation."""
    from prism_lca.engine import typst_render

    sources = {
        "template.typ": typst_render.template_source(),
        "main.typ": (
            '#import "template.typ": *\n'
            '#show: lca-report-template.with(title: "Preview", '
            'meta: (("Date", "2026-01-01"),), lang: "en")\n'
            "= One\nSome prose.\n#pagebreak()\n= Two\nMore prose.\n"
        ),
    }
    png, pages = typst_render.compile_png(sources, ppi=48)
    assert png.startswith(b"\x89PNG")
    assert pages >= 2  # the cover plus the two chapters


def test_asking_past_the_last_page_returns_the_last_one_rather_than_failing():
    """A preview that 404s when the document shrank under it is a worse experience than one that shows
    the last page."""
    from prism_lca.engine import typst_render

    sources = {
        "template.typ": typst_render.template_source(),
        "main.typ": (
            '#import "template.typ": *\n'
            '#show: lca-report-template.with(title: "P", lang: "en")\n= Only\nShort.\n'
        ),
    }
    png, pages = typst_render.compile_png(sources, page=99, ppi=48)
    assert png.startswith(b"\x89PNG")
    assert pages >= 1


def test_turning_a_page_does_not_recompile_the_document():
    """One compile produces every page, but each page request used to redo the whole thing — a reader
    pressed "next" and waited half a minute for a page that had already been rasterised. It showed
    as the app doing nothing for minutes after navigating."""
    from prism_lca.engine import typst_render

    sources = {
        "template.typ": typst_render.template_source(),
        "main.typ": (
            '#import "template.typ": *\n'
            '#show: lca-report-template.with(title: "Cache", lang: "en")\n'
            "= One\nText.\n#pagebreak()\n= Two\nMore.\n"
        ),
    }
    calls = {"n": 0}
    real = typst_render.typst.compile

    def counting(*a, **kw):
        calls["n"] += 1
        return real(*a, **kw)

    typst_render.typst.compile = counting
    try:
        typst_render._PAGE_CACHE.clear()
        first, pages = typst_render.compile_png(sources, ppi=48)
        second, _ = typst_render.compile_png(sources, page=2, ppi=48)
        assert calls["n"] == 1  # the second page came out of the cache
        assert pages >= 2 and first != second
        # An edit changes the sources, so the stale pages cannot be served.
        edited = {**sources, "main.typ": sources["main.typ"] + "\nAnd a new sentence.\n"}
        typst_render.compile_png(edited, ppi=48)
        assert calls["n"] == 2
    finally:
        typst_render.typst.compile = real


# ---- paging a preview must not recompute the study -------------------------------------------
def _seed_for_paging(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("pg").write(
        {
            ("pg", "a"): {
                "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
                "exchanges": [
                    {"input": ("pg", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _paging_report(client, token):
    from prism_lca.engine.bootstrap import get_bd

    _seed_for_paging(get_bd())
    return client.post(
        "/api/v1/report/create",
        json={
            "database": "pg",
            "name": "Paging",
            "methods": [["t", "gwp"]],
            "subjects": [{"database": "pg", "code": "a"}],
        },
        headers=token,
    ).json()


def _count_renders(monkeypatch):
    """Count how often the whole study is recomputed. That is the cost a page turn used to pay."""
    from prism_lca.engine import report_pipeline

    calls = {"n": 0}
    original = report_pipeline.render_inputs

    def counted(*args, **kwargs):
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(report_pipeline, "render_inputs", counted)
    return calls


def test_a_page_turn_reuses_the_typeset_document(client, token, project, monkeypatch):
    """Measured before this: 14 s per page turn on a three-variant report, because each click ran the
    whole pipeline twice — every subject's LCA, the contribution tree, the linter — once to draw the
    charts and once to typeset. The pages were already cached one layer down; this is what stood in
    front of that cache."""
    rep = _paging_report(client, token)
    url = f"/api/v1/report/one/pg/{rep['id']}"
    calls = _count_renders(monkeypatch)

    first = client.post(f"{url}/preview", json={"page": 1, "ppi": 48}, headers=token)
    assert first.status_code == 200, first.text
    assert calls["n"] == 1
    # Turning a page: no recomputation at all.
    second = client.post(f"{url}/preview", json={"page": 1, "ppi": 48, "reuse": True}, headers=token)
    assert second.status_code == 200
    assert calls["n"] == 1
    # Pressing Preview again *does* recompute — that is the point of the flag being the client's.
    client.post(f"{url}/preview", json={"page": 1, "ppi": 48}, headers=token)
    assert calls["n"] == 2


def test_a_render_token_spends_the_computation_the_charts_were_drawn_from(client, token, project, monkeypatch):
    """Drawing needs the numbers and typesetting needs the drawing, so a fresh preview is two round
    trips. The token says both halves are one interaction, so it costs one study instead of two."""
    rep = _paging_report(client, token)
    url = f"/api/v1/report/one/pg/{rep['id']}"
    sources = client.post(f"{url}/sources", json={}, headers=token).json()
    assert sources["render_token"]

    calls = _count_renders(monkeypatch)
    ok = client.post(
        f"{url}/preview",
        json={"page": 1, "ppi": 48, "render_token": sources["render_token"], "figures": {}},
        headers=token,
    )
    assert ok.status_code == 200 and calls["n"] == 0
    # An unknown token falls back to computing rather than failing.
    client.post(f"{url}/preview", json={"page": 1, "ppi": 48, "render_token": "nope"}, headers=token)
    assert calls["n"] == 1
