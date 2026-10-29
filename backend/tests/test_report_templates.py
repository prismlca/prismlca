from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd


def _report(client, token, **kw):
    payload = {
        "database": "tp",  # the database _seed() writes
        "name": "Client report",
        "methods": [["t", "gwp"]],
        "subjects": [{"database": "tp", "code": "a"}],
    }
    payload.update(kw)
    return client.post("/api/v1/report/create", json=payload, headers=token).json()


def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("tp").write(
        {
            ("tp", "a"): {
                "name": "thing", "unit": "unit", "reference product": "thing", "location": "GLO",
                "exchanges": [
                    {"input": ("tp", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])


def test_a_broken_template_is_refused_at_upload_with_the_compiler_message(client, token, project):
    """The fixture check is the reason a custom template is safe to allow at all: it fails here, once,
    instead of breaking a report at the moment someone needs it.

    An incomplete theme is answered by the contract rather than by the compiler (V202): "unknown
    variable: lca-outlines" named one internal symbol per upload, so a theme author found the contract
    out by guessing. A syntax error still gets the compiler's own words — see `test_report_pdf.py`.
    """
    r = client.post(
        "/api/v1/report/templates",
        json={"name": "broken", "source": "#let lca-kv(pairs) = pairs\n"},  # missing the other four
        headers=token,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "report_template_contract"
    assert "lca-outlines" in r.json()["error"]["message"]
    # The built-ins are always listed; nothing of the user's was stored.
    listed = client.get("/api/v1/report/templates", headers=token).json()["templates"]
    assert [t["name"] for t in listed if not t.get("builtin")] == []


def test_a_template_whose_outlines_take_no_arguments_is_refused(client, token, project):
    """The renderer calls `lca-outlines(contents: …, figures: …, tables: …)`; the fixture only ever
    called it bare, so a template with `#let lca-outlines() = {}` passed the upload and failed the
    report."""
    from prism_lca.engine.typst_render import template_source

    shipped = template_source("template.typ")
    start = shipped.index("#let lca-outlines(")
    end = shipped.index("\n#let ", start + 1)
    bare = shipped[:start] + "#let lca-outlines() = {}\n" + shipped[end + 1 :]
    r = client.post("/api/v1/report/templates", json={"name": "bare-outlines", "source": bare}, headers=token)
    assert r.status_code == 400, r.text
    listed = client.get("/api/v1/report/templates", headers=token).json()["templates"]
    assert "bare-outlines" not in [t["name"] for t in listed]


def test_a_valid_template_is_stored_and_used_for_the_render(client, token, project):
    from prism_lca.engine import typst_render

    _seed(get_bd())
    source = client.get("/api/v1/report/templates/prism-network/source", headers=token).json()["source"]
    # A visible difference we can find in the rendered sources.
    house = source.replace('title: "LCA study"', 'title: "House style"')
    assert client.post("/api/v1/report/templates", json={"name": "house", "source": house}, headers=token).status_code == 200
    listed = client.get("/api/v1/report/templates", headers=token).json()["templates"]
    # Built-ins first (each with the label the dropdown shows), then this project's own.
    # The order is the dropdown's, and the theme a new report starts on comes first.
    # Network first (the theme a new report starts on), then the fixed order of the other themes.
    assert [t["name"] for t in listed if t.get("builtin")] == [
        "prism-network",
        "prism-strip",
        "prism-ribbons",
        "prism-facets",
        "prism-sans-duo",
        "prism-planes",
        "prism-study",
        "prism-network-dark",
        "prism-editorial-6",
        "prism-cover",
        # The pair from the second round of drafts, added at the end so the order above stays as set.
        "prism-measured",
        "prism-field",
    ]
    assert listed[0]["name"] == typst_render.DEFAULT_TEMPLATE
    # The UI reads these flags instead of knowing the ids, so they have to be there.
    assert {t["name"]: t["client_logo"] for t in listed if t.get("builtin")} == {
        # Both marks, each on a white card at the top of the cover.
        "prism-strip": True,
        "prism-study": True,
        # Both marks, side by side at the top left, in the white the ribbons leave.
        "prism-ribbons": True,
        # Both marks, side by side at the top left, each on a white card over the bands.
        "prism-sans-duo": True,
        # Both marks, side by side at the top right, on the paper above the planes.
        "prism-planes": True,
        # Both marks, side by side at the top right, each on a white card over the facets.
        "prism-facets": True,
        "prism-cover": True,
        # Both marks, at the two top corners of the cover.
        "prism-network": True,
        "prism-network-dark": True,
        # One mark only: its head is a single column.
        "prism-editorial-6": False,
        # Both marks, at the two top corners of the cover.
        "prism-measured": True,
        "prism-field": True,
    }
    # Every shipped theme brings its own composition since the two picture covers were retired, so an
    # uploaded picture has nowhere to go in any of them.
    assert {t["name"]: t["cover_image"] for t in listed if t.get("builtin")} == {
        "prism-strip": False,
        "prism-ribbons": False,
        "prism-sans-duo": False,
        "prism-planes": False,
        "prism-facets": False,
        "prism-study": False,
        "prism-cover": False,
        "prism-editorial-6": False,
        "prism-network": False,
        "prism-network-dark": False,
        "prism-measured": False,
        "prism-field": False,
    }
    assert all(t.get("label") for t in listed)
    assert [t["name"] for t in listed if not t.get("builtin")] == ["house"]

    rep = client.post(
        "/api/v1/report/create",
        json={"database": "tp", "methods": [["t", "gwp"]], "subjects": [{"database": "tp", "code": "a"}],
              "template": "house"},
        headers=token,
    ).json()
    files = client.post(f"/api/v1/report/one/tp/{rep['id']}/sources", json={}, headers=token).json()["files"]
    assert 'title: "House style"' in files["template.typ"]

    pdf = client.post(f"/api/v1/report/one/tp/{rep['id']}/pdf", json={}, headers=token)
    assert pdf.status_code == 200, pdf.text


def test_the_shipped_template_is_never_replaced(client, token, project):
    r = client.post("/api/v1/report/templates", json={"name": "default", "source": "x"}, headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "report_template_name"


def test_deleting_a_template_falls_reports_back_to_the_default(client, token, project):
    """A deleted template must not leave a report unable to render."""
    _seed(get_bd())
    source = client.get("/api/v1/report/templates/prism-network/source", headers=token).json()["source"]
    client.post("/api/v1/report/templates", json={"name": "temp", "source": source}, headers=token)
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "tp", "methods": [["t", "gwp"]], "subjects": [{"database": "tp", "code": "a"}],
              "template": "temp"},
        headers=token,
    ).json()
    client.post("/api/v1/report/templates/temp/delete", headers=token)

    from prism_lca.engine import typst_render as tr

    back = client.get(f"/api/v1/report/one/tp/{rep['id']}", headers=token).json()
    # The *id* of the default theme: the string "default" is a retired id.
    assert back["template"] == tr.DEFAULT_TEMPLATE
    assert client.post(f"/api/v1/report/one/tp/{rep['id']}/pdf", json={}, headers=token).status_code == 200


def test_a_report_pointing_at_a_missing_template_is_refused_at_write_time(client, token, project):
    """The typo is reported where it is made — not on the next render, long after."""
    _seed(get_bd())
    r = client.post(
        "/api/v1/report/create",
        json={"database": "tp", "methods": [["t", "gwp"]], "subjects": [{"database": "tp", "code": "a"}],
              "template": "ghost"},
        headers=token,
    )
    assert r.status_code == 404 and r.json()["error"]["code"] == "report_template_not_found"

    rep = client.post(
        "/api/v1/report/create",
        json={"database": "tp", "methods": [["t", "gwp"]], "subjects": [{"database": "tp", "code": "a"}]},
        headers=token,
    ).json()
    r = client.post(f"/api/v1/report/one/tp/{rep['id']}", json={"template": "ghost"}, headers=token)
    assert r.status_code == 404 and r.json()["error"]["code"] == "report_template_not_found"


def test_project_defaults_reset_by_posting_an_empty_list(client, token, project):
    client.post("/api/v1/report/defaults", json={"sections": [{"kind": "prose", "title": "Only this"}]}, headers=token)
    assert [s["title"] for s in client.get("/api/v1/report/defaults", headers=token).json()["sections"]] == ["Only this"]
    client.post("/api/v1/report/defaults", json={"sections": []}, headers=token)
    kinds = [s["kind"] for s in client.get("/api/v1/report/defaults", headers=token).json()["sections"]]
    # Back to the built-in ISO structure — abbreviations as front matter, then the executive summary.
    assert kinds[0] == "summary" and kinds[1] == "abbreviations" and "goal_scope" in kinds and "lcia" in kinds


# ---- the cover and the tables, after two defects found in a real PDF -------------------
def test_a_wide_table_stays_inside_the_text_block():
    """The defect: `columns: (1fr,) + (auto,)*n`. `auto` sizes a column to its content, so a header
    carrying a full ecoinvent method path made the table wider than the page — the 1fr column collapsed
    to nothing and printed *on top of* its neighbour. Fractions cannot do that."""
    from prism_lca.engine import typst_render

    source = typst_render.template_source()
    assert "auto," not in source.split("#let lca-table")[1].split("#let lca-figure")[0]
    long_name = "IPCC 2013 no LT / climate change no LT / global temperature change potential (GTP100) no LT"
    main = (
        '#import "template.typ": *\n'
        '#show: lca-report-template.with(title: "Wide", lang: "en")\n'
        "#lca-table(\n"
        f'  ("Subject", "{long_name}", "{long_name}", "{long_name}", "{long_name}"),\n'
        '  (("A very long subject label indeed", "1.1", "2.2", "3.3", "4.4"),),\n'
        "  align-right: (1, 2, 3, 4),\n"
        ")\n"
    )
    png, _ = typst_render.compile_png({"template.typ": source, "main.typ": main}, page=2, ppi=48)
    assert png.startswith(b"\x89PNG")  # it compiles; the overlap was a layout defect, not an error


def test_the_cover_labels_come_from_the_assembler_not_the_template():
    """The second defect class, and the same one as the hardcoded `supplement:` earlier: the template
    printed "Author", "Commissioned by" and "Date" in English, so every German, French, Spanish and
    Portuguese cover carried English labels. Labels now arrive already translated."""
    from prism_lca.engine import typst_render

    # Comments are allowed to mention the old labels — the point is that no *code* prints them.
    lines = typst_render.template_source().split("\n")
    code = "\n".join(line for line in lines if not line.strip().startswith("//"))
    assert "Commissioned by" not in code
    assert "strong[Author]" not in code
    assert "meta:" in code


def test_the_cover_prints_author_organisation_and_client_in_the_report_language():
    from prism_lca.engine.report_typst import wrap_document

    study = {
        "author": "M. Beispiel",
        "organisation": "Example Org",
        "commissioner": "Beispiel GmbH",
        "date": "2026-07-26",
    }
    main = wrap_document([], title="Studie", study=study, lang="de")["main.typ"]
    assert '("Verfasser", "M. Beispiel")' in main
    assert '("Durchgeführt von", "Example Org")' in main
    assert '("Auftraggeber", "Beispiel GmbH")' in main
    assert "Commissioned by" not in main


def test_an_empty_field_is_left_off_the_cover_rather_than_printed_as_a_bare_label():
    from prism_lca.engine.report_typst import wrap_document

    main = wrap_document([], title="T", study={"author": "A"}, lang="en")["main.typ"]
    assert '("Author", "A")' in main
    assert "Commissioned by" not in main and "Carried out by" not in main


def test_a_report_can_carry_its_own_subtitle():
    from prism_lca.engine.report_render import render_sources

    report = {"lang": "en", "subtitle": "Comparative study for the 2026 tender", "sections": []}
    lcia = {"activity": {"name": "bag", "database": "m"}, "results": []}
    sources, _ = render_sources(report, {}, lcia)
    assert "Comparative study for the 2026 tender" in sources["main.typ"]
    assert "bag (m)" not in sources["main.typ"]


def test_without_a_subtitle_the_reference_process_is_used_unless_it_repeats_the_title():
    """The fallback second line is the reference process — but only where it says something new.

    A report created from the canvas is named after that very process ("<process> report"), so the
    fallback printed the title again with the database appended. It showed on a cling-film cover:
    it reads as a bug, not as a subtitle. Suppressed there; nothing is lost, because the cover's study
    block and the reproducibility chapter both name the database.
    """
    from prism_lca.engine.report_render import render_sources

    named = {"lang": "en", "name": "Packaging comparison 2026", "sections": []}
    lcia = {"activity": {"name": "bag", "database": "m"}, "results": []}
    sources, _ = render_sources(named, {}, lcia)
    assert "bag (m)" in sources["main.typ"]

    # Title derived from the process itself — with and without the " report" suffix the app appends.
    for title in ("bag", "bag report"):
        report = {"lang": "en", "name": title, "sections": []}
        sources, _ = render_sources(report, {}, lcia)
        assert "bag (m)" not in sources["main.typ"]


def test_an_image_keeps_its_caption_on_the_same_page():
    """A caption alone at the top of a page, under no figure — the defect seen in the radar chart.

    `show figure: set block(breakable: true)` was added for the annex's 25-row inventory table, which has
    to break across pages. Applied to *every* figure it also allowed an image and its caption to be split:
    an image cannot break, so the picture stayed where it was and only the caption moved on. The fix scopes
    the rule to `kind: table`.

    Checked by compiling a tall figure under a page of filler, once with the shipped template and once
    with the rule widened back to all figures: the orphaned caption costs the document an extra page, so
    the page count alone separates the two behaviours.
    """
    from prism_lca.engine import typst_render

    shipped = typst_render.template_source()
    widened = shipped.replace("show figure.where(kind: table): set block", "show figure: set block")
    assert widened != shipped  # guards against the rule being renamed without updating this test

    tall = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="900">'
        '<rect width="400" height="900" fill="#93c120"/></svg>'
    )
    main = (
        '#import "template.typ": *\n'
        '#show: lca-report-template.with(title: "Break", lang: "en")\n'
        "= Filler\n" + ("Text that fills the first page. " * 90) + "\n"
        '#lca-figure("tall.svg", caption: "A caption that belongs to the picture above it")\n'
    )

    def pages(template: str) -> int:
        _, count = typst_render.compile_png(
            {"template.typ": template, "main.typ": main, "tall.svg": tall}, page=1, ppi=48
        )
        return count

    assert pages(shipped) < pages(widened)


def test_the_designed_cover_ships_as_a_second_template(client, token, project):
    """Two built-ins that differ only in their cover page: one places a photograph you upload, the other
    brings a cover of its own. A report can therefore change its look without changing its content."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _report(client, token)
    r = client.post(f"/api/v1/report/one/tp/{rep['id']}", json={"template": "prism-cover"}, headers=token)
    assert r.status_code == 200, r.text

    files = client.post(f"/api/v1/report/one/tp/{rep['id']}/sources", json={}, headers=token).json()["files"]
    # The designed cover reached the project, and it is the wave one. The shape moved out of the cover block
    # (it is now `cover-wave`, drawn once and sliced for the band at the foot of every page), so the name it is
    # checked by moved with it.
    assert "let cover-wave(" in files["template.typ"]
    # And the band exists: the same drawing, clipped to its bottom 5mm as a page background.
    assert "height: 5mm, clip: true" in files["template.typ"]
    assert client.post(f"/api/v1/report/one/tp/{rep['id']}/pdf", json={}, headers=token).status_code == 200


def test_a_builtin_name_cannot_be_overwritten_or_deleted(client, token, project):
    """Otherwise a project could lose the template every other report points at."""
    for name in (
        "default", "prism-cover", "prism-arcs", "prism-editorial-4", "prism-editorial-5", "prism-editorial-6",
    ):
        r = client.post(
            "/api/v1/report/templates", json={"name": name, "source": "#let x = 1\n"}, headers=token
        )
        assert r.status_code == 400, name
        assert r.json()["error"]["code"] == "report_template_name"
        assert client.post(f"/api/v1/report/templates/{name}/delete", headers=token).status_code >= 400


def test_the_designed_cover_ignores_an_uploaded_image_instead_of_failing(client, token, project):
    """The assembler passes a cover image whenever the report carries one. This template has its own
    cover and no place for a photograph — it must compile all the same, not reject the argument."""
    import base64
    import zlib

    from prism_lca.engine.bootstrap import get_bd

    def png() -> bytes:
        def chunk(k, p):
            return len(p).to_bytes(4, "big") + k + p + zlib.crc32(k + p).to_bytes(4, "big")

        ihdr = (8).to_bytes(4, "big") + (8).to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
        raw = b"".join(b"\x00" + bytes([90, 193, 32] * 8) for _ in range(8))
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

    _seed(get_bd())
    rep = _report(client, token)
    client.post(
        f"/api/v1/report/one/tp/{rep['id']}",
        json={"template": "prism-cover", "cover_image": base64.b64encode(png()).decode()},
        headers=token,
    )
    assert client.post(f"/api/v1/report/one/tp/{rep['id']}/pdf", json={}, headers=token).status_code == 200


def test_the_typographic_cover_places_an_uploaded_picture(client, token, project):
    """It has somewhere to put one — a full-bleed band between the wordmark and the title — so unlike the
    designed cover it must actually carry the file into the project, and still compile without one."""
    import base64
    import zlib

    from prism_lca.engine.bootstrap import get_bd

    def png() -> bytes:
        def chunk(k, p):
            return len(p).to_bytes(4, "big") + k + p + zlib.crc32(k + p).to_bytes(4, "big")

        ihdr = (12).to_bytes(4, "big") + (8).to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
        raw = b"".join(b"\x00" + bytes([90, 193, 32] * 12) for _ in range(8))
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

    _seed(get_bd())
    rep = _report(client, token)
    client.post(f"/api/v1/report/one/tp/{rep['id']}", json={"template": "prism-arcs"}, headers=token)

    # Without a picture it still renders — the cover is not left with a gap.
    assert client.post(f"/api/v1/report/one/tp/{rep['id']}/pdf", json={}, headers=token).status_code == 200

    client.post(
        f"/api/v1/report/one/tp/{rep['id']}",
        json={"cover_image": base64.b64encode(png()).decode()},
        headers=token,
    )
    body = client.post(f"/api/v1/report/one/tp/{rep['id']}/sources", json={}, headers=token).json()
    assert "cover.png" in body["binary"]
    assert 'cover-image: "cover.png"' in body["files"]["main.typ"]
    assert client.post(f"/api/v1/report/one/tp/{rep['id']}/pdf", json={}, headers=token).status_code == 200


def test_every_shipped_template_typesets_a_report():
    """Each built-in compiled against the fixture, which is what a custom template has to pass too.

    A cover is a page of absolute placements and measured type; the compiler is the only thing that can
    say whether one still works. Without this a template could ship broken and only fail the day someone
    picked it from the dropdown.
    """
    from prism_lca.engine import typst_render

    for template_id in typst_render.BUILTIN_TEMPLATES:
        typst_render.validate_template(typst_render.builtin_template_source(template_id))


def test_the_designed_covers_survive_a_report_with_nothing_on_it():
    """No subtitle, no study details, no logo — the state a report is in for its first few minutes.

    Every element of those covers is optional and placed absolutely, so "nothing set" is the case most
    likely to end in a compiler error over a `none` or a card of height zero — and on the card variant the
    card is the cover, so an empty one has nowhere to hide. Panel and year adds a second way to fail: it
    reads the study's year out of the date it is given, so "no date at all" and "a date with no year in it"
    both have to end in a panel that simply holds nothing.
    """
    import itertools

    from prism_lca.engine import report_typst as rt
    from prism_lca.engine import typst_render

    for study, template_id in itertools.product(
        ({}, {"author": "Jane Doe", "date": "2026-07-28"}, {"author": "Jane Doe", "date": "spring"}),
        ("prism-strip", "prism-ribbons", "prism-sans-duo", "prism-planes", "prism-facets", "prism-study",
         "prism-editorial-6", "prism-measured", "prism-field"),
    ):
        sources = rt.wrap_document(
            [{"type": "heading", "level": 1, "text": "Goal and scope"}],
            title="A study",
            study=study,
            template=typst_render.builtin_template_source(template_id),
        )
        assert typst_render.compile_pdf(sources)[:5] == b"%PDF-"


def test_a_project_theme_can_be_downloaded_again(client, token, project):
    """`/templates/default` only ever served the shipped ones.

    A theme someone uploaded could therefore never be got back out of the app, which makes it uneditable
    the moment the `.typ` on their disk is gone — and that is the file a house style lives in.
    """
    source = client.get("/api/v1/report/templates/prism-network/source", headers=token).json()["source"]
    house = source.replace('title: "LCA study"', 'title: "House style"')
    assert client.post("/api/v1/report/templates", json={"name": "house", "source": house}, headers=token).status_code == 200

    own = client.get("/api/v1/report/templates/house/source", headers=token)
    assert own.status_code == 200, own.text
    assert own.json()["source"] == house

    shipped = client.get("/api/v1/report/templates/prism-editorial-6/source", headers=token)
    assert shipped.status_code == 200
    assert "lca-report-template" in shipped.json()["source"]

    missing = client.get("/api/v1/report/templates/nope/source", headers=token)
    assert missing.status_code == 404
    assert "nope" in missing.json()["error"]["message"]


def test_cover_5_drops_the_label_once_the_author_has_a_mark():
    """Logo or label, never both — and with the PrismLCA fallback gone, "a logo" is the whole
    question.

    The template used to tell an uploaded mark from the fallback by file name (`logo.*` against exactly
    `prism-logo.png`), because a cover always carried one or the other. A cover now carries the author's
    mark or nothing, so `logo != none` is the test — and the label takes the head when there is nothing.
    """
    from prism_lca.engine import report_typst as rt
    from prism_lca.engine import typst_render

    template = typst_render.builtin_template_source("prism-editorial-6")
    assert "logo != none" in template
    # The rule, not the prose: the file still *mentions* the old fallback in the comment that explains why
    # it is gone, which is exactly where that name belongs now.
    assert 'logo != "prism-logo.png"' not in template

    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
    bare = rt.wrap_document([], title="T", study={}, template=template)["main.typ"]
    assert "  logo:" not in bare
    own = rt.wrap_document([], title="T", study={}, logo=png, template=template)["main.typ"]
    assert 'logo: "logo.png"' in own


def test_cover_5_ignores_a_client_logo_and_says_so_in_the_registry():
    """It draws one mark. The report card reads the flag and marks the control unused rather than taking an
    upload that would go nowhere — and the render must not fail over the argument it is still handed."""
    from prism_lca.engine import report_typst as rt
    from prism_lca.engine import typst_render

    for theme in ("prism-editorial-6",):
        assert typst_render.BUILTIN_TEMPLATES[theme]["client_logo"] is False
        template = typst_render.builtin_template_source(theme)
        assert "client-logo: none," in template  # still accepted, per the contract
        assert "image(client-logo" not in template  # but never drawn

        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
        sources = rt.wrap_document([], title="T", study={}, client_logo=png, template=template)
        assert 'client-logo: "client-logo.png"' in sources["main.typ"]
        assert typst_render.compile_pdf(sources)[:5] == b"%PDF-"


def test_a_new_report_starts_on_the_theme_whose_label_says_so(client, token, project):
    """"(PrismLCA Default)" in a label has to be true of something.

    The id `default` is a template like any other — it is only named after the role it used to have — so the
    theme a new report starts on is a registry constant rather than that name.
    """
    from prism_lca.engine import typst_render

    _seed(get_bd())
    rep = _report(client, token)
    assert rep["template"] == typst_render.DEFAULT_TEMPLATE
    assert "(PrismLCA Default)" in typst_render.BUILTIN_TEMPLATES[rep["template"]]["label"]
    # And an explicit choice still wins.
    other = _report(client, token, template="prism-arcs")
    assert other["template"] == "prism-arcs"


def test_a_report_on_a_retired_theme_still_renders(client, token, project):
    """Two themes shipped once and were removed. A report that points at one must not 404.

    The report was written against numbers and chapters, not against a cover: retiring a design cannot be
    allowed to break a document nobody touched. It renders in the current default and keeps its stored id, so
    nothing is silently rewritten under the author.
    """
    from prism_lca.engine import report_store, typst_render

    _seed(get_bd())
    rep = _report(client, token)
    store = report_store.ReportStore()
    store.update("tp", rep["id"], {})  # nothing to change; just prove the report exists
    # Written past the API, the way a report stored before the theme was removed looks.
    data = store._load()
    for r in data["tp"]:
        if r["id"] == rep["id"]:
            r["template"] = "prism-editorial-card"
    store._save(data)

    assert "prism-editorial-card" in typst_render.RETIRED_TEMPLATES
    assert store.get("tp", rep["id"])["template"] == "prism-editorial-card"  # not rewritten
    assert client.post(f"/api/v1/report/one/tp/{rep['id']}/pdf", json={}, headers=token).status_code == 200

    # The two Shapes and card variants retired for the one without circles: their files are gone, their ids
    # still resolve — to the default, not to a 404.
    for gone in ("prism-editorial-5", "prism-editorial-4"):
        assert gone in typst_render.RETIRED_TEMPLATES and gone not in typst_render.BUILTIN_TEMPLATES
        assert store.get_template(gone) == typst_render.builtin_template_source(typst_render.DEFAULT_TEMPLATE)


def test_every_theme_has_a_preview_of_its_cover(client, token, project):
    """The picker shows a rendered cover per theme, sample data, no mark of any kind.

    A theme's label can only hint at what it looks like — "Curved band" and "Shapes and card" are
    two very different pages. No logo on purpose: a preview is of the theme, not of whoever configured this
    installation, and a PrismLCA mark on every thumbnail would say more about us than about the
    cover.
    """
    import base64

    from prism_lca.engine import report_preview, typst_render

    for theme in typst_render.BUILTIN_TEMPLATES:
        r = client.get(f"/api/v1/report/templates/{theme}/preview", headers=token)
        assert r.status_code == 200, (theme, r.text)
        png = base64.b64decode(r.json()["base64"])
        assert png[:8] == b"\x89PNG\r\n\x1a\n", theme
        assert len(png) > 4_000, (theme, len(png))  # a blank page is ~1kB

    # The sources behind it carry no logo argument at all, so no cover draws a mark.
    source = typst_render.builtin_template_source("prism-cover")
    assert report_preview.preview_png(source)  # cached by now
    from prism_lca.engine import report_typst as rt

    probe = rt.wrap_document([], title="x", study={}, template=source)
    assert "  logo:" not in probe["main.typ"]

    assert client.get("/api/v1/report/templates/nope/preview", headers=token).status_code == 404


def test_an_imported_theme_gets_its_preview_at_upload(client, token, project):
    """Rendered while the user is still looking at the upload, so the picker is instant afterwards — and a
    broken preview must never cost a theme that compiles."""
    import base64

    source = client.get("/api/v1/report/templates/prism-network/source", headers=token).json()["source"]
    house = source.replace('title: "LCA study"', 'title: "House style"')
    assert client.post("/api/v1/report/templates", json={"name": "house", "source": house}, headers=token).status_code == 200

    r = client.get("/api/v1/report/templates/house/preview", headers=token)
    assert r.status_code == 200, r.text
    assert base64.b64decode(r.json()["base64"])[:8] == b"\x89PNG\r\n\x1a\n"


def test_the_cover_label_follows_the_report_language():
    """The word for what the document is comes from the string table, in every language it has.

    It used to be five strings inside each of the two editorial themes: reaching the table would have meant a
    new argument, and an argument the assembler passes unconditionally breaks every theme uploaded before it
    existed. Passing it only to a theme that declares it settled that, so the duplicate tables are gone and
    this is the one place the words live.

    Only the noun is translated; "LCA" stays, because it is the abbreviation the app is named after and it
    travels. A region tag must resolve to its language — `de-DE` is German, and an unknown one falls back to
    English rather than printing a key.
    """
    from prism_lca.engine import report_typst as rt
    from prism_lca.engine import typst_render
    from prism_lca.engine.report_i18n import LANGUAGES, t

    expected = {
        "en": "LCA report",
        "de": "LCA-Bericht",  # a German compound of an abbreviation and a noun takes the hyphen
        "fr": "Rapport d'ACV",
        "es": "Informe de ACV",
        "pt": "Relatório de ACV",
    }
    assert set(expected) == set(LANGUAGES), "a language without this word would print an empty eyebrow"
    for lang, word in expected.items():
        assert t("cover.kind", lang) == word
    assert t("cover.kind", "de-DE") == expected["de"]
    assert t("cover.kind", "xx") == expected["en"]

    # And every theme that prints it typesets in every language.
    for theme in ("prism-strip", "prism-ribbons", "prism-sans-duo", "prism-planes", "prism-editorial-6",
                  "prism-measured", "prism-field"):
        source = typst_render.builtin_template_source(theme)
        assert rt._declares(source, "kind"), theme
        for lang in expected:
            sources = rt.wrap_document(
                [{"type": "heading", "level": 1, "text": "Ziel"}],
                title="Apfelsaft",
                study={"author": "Jane Doe"},
                lang=lang,
                template=source,
            )
            assert typst_render.compile_pdf(sources)[:5] == b"%PDF-", (theme, lang)


def test_every_palette_typesets_every_shipped_theme():
    """Six colour sets × five themes, compiled. The one check that matters for this feature.

    A theme no longer declares its colours: it imports `palette.typ`, which the assembler writes per render.
    That makes a missing or misspelt name a compile error rather than a wrong colour — in every combination,
    not only in the default one, which is the only combination anybody would notice by looking.
    """
    from prism_lca.engine import report_palettes, typst_render

    for palette in report_palettes.PALETTES:
        for theme in typst_render.BUILTIN_TEMPLATES:
            typst_render.validate_template(
                typst_render.builtin_template_source(theme), palette=palette["id"]
            )


def test_the_default_palette_is_the_colours_the_themes_used_to_hard_code():
    """The house green and navy, byte for byte. A default that shifts a colour would restyle every existing
    report the moment this feature shipped — the point is that nothing changes until a set is chosen."""
    from prism_lca.engine import report_palettes

    default = report_palettes.resolve(None)
    assert default["id"] == "prism"
    assert default["colors"]["prism-green"] == "#93c120"
    assert default["colors"]["prism-navy"] == "#2f4e66"
    # An unknown id falls back rather than raising: a report naming a set a later version dropped must
    # still render, and "renders in the default colours" beats "cannot be opened".
    assert report_palettes.resolve("no-such-set")["id"] == "prism"


def test_a_report_carries_its_palette_into_the_render(client, token, project):
    """Stored on the report, echoed back, and visible in the sources it renders — the whole path."""
    _seed(get_bd())
    rep = _report(client, token)
    assert rep["palette"] == "prism"  # a new report starts in the default set

    r = client.post(
        f"/api/v1/report/one/tp/{rep['id']}", json={"palette": "teal"}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["palette"] == "teal"

    src = client.post(f"/api/v1/report/one/tp/{rep['id']}/sources", json={}, headers=token)
    assert src.status_code == 200, src.text
    files = src.json()["files"]
    # The set travels as a file beside the theme, so an exported project can be recompiled — and edited.
    assert "palette.typ" in files
    assert "#17505a" in files["palette.typ"]
    assert '#import "palette.typ"' in files["template.typ"]


def test_the_palette_catalogue_is_offered_with_three_swatches_each(client, token):
    """What the picker draws. Three, not eight: the accent, the deep tone and the paper of the cover."""
    r = client.get("/api/v1/report/palettes", headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["default"] == "prism"
    ids = [p["id"] for p in body["palettes"]]
    assert ids[0] == "prism"  # the default comes first, so the picker's first chip is the one in use
    assert len(ids) == len(set(ids)) >= 4
    for p in body["palettes"]:
        assert p["label"] and p["hint"]
        assert len(p["swatches"]) == 3
        assert all(c.startswith("#") and len(c) == 7 for c in p["swatches"]), p


def test_a_theme_preview_is_rendered_in_the_palette_it_is_asked_for(client, token, project):
    """Two sets, two pictures. The gallery shows every cover in the colours the report is typeset in, so a
    preview cached under the theme alone would keep serving green tiles after the set was changed."""
    import base64

    a = client.get("/api/v1/report/templates/prism-cover/preview?palette=prism", headers=token)
    b = client.get("/api/v1/report/templates/prism-cover/preview?palette=steel", headers=token)
    assert a.status_code == b.status_code == 200, (a.text, b.text)
    assert base64.b64decode(a.json()["base64"]) != base64.b64decode(b.json()["base64"])


def test_every_theme_asks_for_a_font_it_can_actually_get():
    """A family a theme names must exist — because asking for one that does not is *silent*.

    Typst falls back to a face it has rather than failing, so a misspelt family prints a whole cover in
    something else and the compile stays green. It happened on the way in: `heading-font: "Noto Sans
    Condensed"` finds nothing, because a font's family as far as Typst is concerned is its *typographic*
    family (name ID 16) and the condensed cut's is plain "Noto Sans" — the width is a separate property.
    Panel and year printed its title in the compiler's embedded serif and nothing said so.

    Reads the family out of every bundled file rather than trusting the file names, and checks every quoted
    family in every shipped theme against that list plus the ones the compiler embeds.
    """
    import re
    import struct
    from pathlib import Path

    from prism_lca.engine import typst_render

    def family(path: Path) -> str:
        """The family Typst matches this file under: the typographic family (name ID 16) if the file has
        one, else the plain family (1). *One* name, not both — that distinction is the whole test. A file
        whose plain name is "Noto Sans SemiBold" or "Noto Sans Condensed" is reached as "Noto Sans" plus a
        weight or a width; asking for the long name finds nothing at all."""
        d = path.read_bytes()
        num_tables = struct.unpack(">H", d[4:6])[0]
        name_off = None
        for i in range(num_tables):
            tag, _, off, _ = struct.unpack(">4sIII", d[12 + i * 16 : 28 + i * 16])
            if tag == b"name":
                name_off = off
        assert name_off is not None, f"{path.name} has no name table"
        count, str_off = struct.unpack(">HH", d[name_off + 2 : name_off + 6])
        found: dict[int, str] = {}
        for i in range(count):
            rec = name_off + 6 + i * 12
            plat, _enc, _lang, nid, ln, off = struct.unpack(">HHHHHH", d[rec : rec + 12])
            if nid not in (1, 16):
                continue
            raw = d[name_off + str_off + off : name_off + str_off + off + ln]
            found.setdefault(nid, raw.decode("utf-16-be" if plat == 3 else "latin-1"))
        return found.get(16) or found[1]

    have = set(typst_render.EMBEDDED_FONTS)
    for f in sorted(typst_render.font_dir().rglob("*")):
        if f.suffix.lower() in (".ttf", ".otf"):
            have.add(family(f))

    for template_id in typst_render.BUILTIN_TEMPLATES:
        source = typst_render.builtin_template_source(template_id)
        asked = set(re.findall(r'font\s*:\s*"([^"]+)"', source))
        missing = asked - have
        assert not missing, (
            f"{template_id} asks for {sorted(missing)}, which no bundled or embedded font offers "
            f"(available: {sorted(have)})"
        )


def test_the_document_word_is_translated_and_only_reaches_a_theme_that_asks_for_it():
    """The eyebrow over the title says what the document is, in the report's language.

    Two things at once, because they are one decision. The word comes from the string table like every other
    label on a cover — a template cannot know the language, and a hardcoded "LCA report" would print English
    on a German report. And it is passed *only* to a theme whose `lca-report-template` declares the
    parameter: Typst rejects an argument a function does not take, so a theme downloaded before this existed
    has to keep compiling. It nearly did not — the first version of the guard looked for `"kind:"` anywhere
    in the source, which is true of every theme, because they all carry `show figure.where(kind: table)`.
    """
    from prism_lca.engine import report_typst as rt
    from prism_lca.engine import typst_render

    blocks = [{"type": "heading", "level": 1, "text": "Ziel und Untersuchungsrahmen"}]
    # The seven that print the word: Gradient strip, Ribbons and Flows over their titles, Planes at the top
    # of its cover, the two from the second drafts, where it was asked for, and Shapes and card, which printed
    # it all along from a translation table of its own inside the file. Three others hold that place with an accent
    # rule and no word, and stay that way — a slot that would fit is not a slot that was meant; Facets keeps
    # its title block to the title, the subtitle and the date, as its draft does.
    for template_id, expected in (("prism-strip", "LCA-Bericht"), ("prism-ribbons", "LCA-Bericht"),
                                  ("prism-sans-duo", "LCA-Bericht"), ("prism-planes", "LCA-Bericht"),
                                  ("prism-measured", "LCA-Bericht"),
                                  ("prism-field", "LCA-Bericht"), ("prism-editorial-6", "LCA-Bericht")):
        sources = rt.wrap_document(
            blocks, title="Eine Studie", study={"date": "Heidelberg, Juli 2026"}, lang="de",
            template=typst_render.builtin_template_source(template_id),
        )
        assert f'kind: "{expected}",' in sources["main.typ"], template_id
        assert typst_render.compile_pdf(sources)[:5] == b"%PDF-"

    # English, and the themes that do not ask for the word are not given it — and still typeset.
    for template_id in typst_render.BUILTIN_TEMPLATES:
        source = typst_render.builtin_template_source(template_id)
        sources = rt.wrap_document(blocks, title="A study", study={"date": "2026"}, template=source)
        asks = rt._declares(source, "kind")
        assert ('kind: "LCA report",' in sources["main.typ"]) is asks, template_id
        assert typst_render.compile_pdf(sources)[:5] == b"%PDF-"


def test_colours_picked_on_a_report_replace_the_sets_three(client, token, project):
    """Three hex fields under the sets, for trying colours on one report without adding a set.

    They reach the document the same way the set does — written into `palette.typ`, so no theme knows they
    exist — and only the three the picker shows: the accent, the deep tone and the paper. The neutrals stay
    the set's, because they are what keeps a page readable.

    Also checks what a typo does. An unchecked value reaches `rgb("…")` and fails the *compile*, which would
    surface as "the report cannot be typeset" on a page that no longer shows the field that caused it.
    """
    import pytest

    from prism_lca.engine import report_palettes
    from prism_lca.errors import PrismError

    typ = report_palettes.palette_typst("prism", {"accent": "#ff0088", "paper": "#FFF"})
    assert '#let prism-green = rgb("#ff0088")' in typ
    assert '#let paper = rgb("#fff")' in typ
    # Not the neutrals, and not the second accent.
    assert '#let prism-ink = rgb("#303030")' in typ
    assert '#let prism-accent2 = rgb("#d18a00")' in typ
    # An empty field means "the set's own", not black.
    assert '#let prism-navy = rgb("#2f4e66")' in report_palettes.palette_typst("prism", {"deep": ""})

    for bad in ("nope", "#12345", "rgb(1,2,3)", "#12345g"):
        with pytest.raises(PrismError):
            report_palettes.check_colors({"accent": bad})
    with pytest.raises(PrismError):
        report_palettes.check_colors({"ink": "#000000"})

    # Over the API: stored on the report, refused when it is not a colour, cleared by an empty object.
    client.post("/api/v1/databases/foreground", json={"name": "pc-db"}, headers=token)
    rid = client.post(
        "/api/v1/report/create", json={"database": "pc-db", "name": "Colours"}, headers=token
    ).json()["id"]
    base = f"/api/v1/report/one/pc-db/{rid}"
    assert client.post(base, json={"palette_colors": {"accent": "#123456"}}, headers=token).status_code == 200
    assert client.get(base, headers=token).json()["palette_colors"] == {"accent": "#123456"}
    assert client.post(base, json={"palette_colors": {"accent": "green"}}, headers=token).status_code == 400
    assert client.post(base, json={"palette_colors": {}}, headers=token).status_code == 200
    assert client.get(base, headers=token).json().get("palette_colors") in ({}, None)


def test_colours_a_report_stores_are_typeset_with_the_fields_switched_off(client, token, project):
    """The flag hides the three hex fields; it does not discard what a report stores.

    "White page background" under the colour sets writes the paper of a report's own colours, and it is
    offered in every installation. A render that dropped stored colours whenever the fields are hidden would
    quietly take every white page back to the set's paper — so if this fails, the checkbox needs a field of
    its own before the colours can be dropped.
    """
    from prism_lca.config import get_settings

    assert get_settings().report_custom_colors is False
    _seed(get_bd())
    rep = _report(client, token)
    base = f"/api/v1/report/one/tp/{rep['id']}"
    assert client.post(base, json={"palette_colors": {"paper": "#ffffff"}}, headers=token).status_code == 200
    files = client.post(f"{base}/sources", json={}, headers=token).json()["files"]
    assert '#let paper = rgb("#ffffff")' in files["palette.typ"]


def test_the_three_colour_fields_can_be_switched_off_for_an_installation():
    """`PRISM_REPORT_CUSTOM_COLORS=0` hides them, and nothing in the UI can turn them back on.

    The flag rides with the palette catalogue, which the picker fetches anyway. Whether a document may be
    typeset in colours nobody reviewed is a decision for whoever hands the app out — so it is an environment
    variable, not a checkbox to find mid-report.
    """
    import os

    from prism_lca.config import get_settings

    get_settings.cache_clear()
    try:
        # Off by default: nine reviewed sets are the offer, and a hand-picked
        # colour is the exception — an exception does not belong in the panel unless it is asked for.
        assert get_settings().report_custom_colors is False
        import os

        os.environ["PRISM_REPORT_CUSTOM_COLORS"] = "1"
        get_settings.cache_clear()
        assert get_settings().report_custom_colors is True
    finally:
        os.environ.pop("PRISM_REPORT_CUSTOM_COLORS", None)
        get_settings.cache_clear()


def test_a_theme_that_takes_the_date_gets_it_on_its_own_and_not_twice():
    """Facets sets the date as the third line of its title block, not among the details at the foot.

    The assembler hands it over as `date` — only to a theme that declares the parameter, for the reason `kind`
    is guarded: Typst rejects an argument a function does not take, and a theme of your own is a file nobody
    migrates — and leaves it out of `meta` then, or the cover would print it twice. Every other theme keeps
    the date in its row of details, exactly as before.
    """
    from prism_lca.engine import report_typst as rt
    from prism_lca.engine import typst_render

    blocks = [{"type": "heading", "level": 1, "text": "Goal and scope"}]
    study = {"author": "Jane Doe", "organisation": "Doe Consulting", "date": "24 October 2026"}
    for template_id in typst_render.BUILTIN_TEMPLATES:
        source = typst_render.builtin_template_source(template_id)
        main = rt.wrap_document(blocks, title="A study", study=study, template=source)["main.typ"]
        meta = next(line for line in main.splitlines() if line.lstrip().startswith("meta:"))
        if template_id == "prism-facets":
            assert rt._declares(source, "date")
            assert 'date: "24 October 2026",' in main
            assert "24 October 2026" not in meta
            assert '("Carried out by", "Doe Consulting")' in meta
        else:
            assert not rt._declares(source, "date"), template_id
            assert '("Date", "24 October 2026")' in meta, template_id
            assert "  date:" not in main, template_id

    # No date, no argument — and the theme's own `none` leaves the line out.
    source = typst_render.builtin_template_source("prism-facets")
    sources = rt.wrap_document(blocks, title="A study", study={"author": "Jane Doe"}, template=source)
    assert "  date:" not in sources["main.typ"]
    assert typst_render.compile_pdf(sources)[:5] == b"%PDF-"


def test_only_the_parameter_list_says_what_a_theme_takes():
    """`_declares` reads the parameter list of `lca-report-template` up to its balancing parenthesis.

    A theme of your own may close that list on the last parameter's line. Cut at a fixed closing line, such
    a theme had its whole body searched — and a `date:` inside `set document(...)` was taken for a parameter,
    handed over, and refused by Typst as "unexpected argument". Comments full of parentheses and names inside
    a default value do not count either.
    """
    from prism_lca.engine import report_typst as rt
    from prism_lca.engine import typst_render

    source = """#let lca-report-template(
  // A note (with: parentheses) and a "quoted (string)".
  title: "A (title)",
  meta: (("Date", "2026"),),
  kind: none, body) = {
  set document(
    title: title,
    date: auto,
  )
  body
}"""
    assert rt._template_params(source) == {"title", "meta", "kind"}
    assert not rt._declares(source, "date")
    assert rt._declares(source, "kind")

    # The same through a whole render: a shipped theme rewritten that way still typesets with a date.
    network = typst_render.builtin_template_source("prism-network")
    head, rest = network.split("#let lca-report-template(", 1)
    params, body = rest.split("\n) = {", 1)
    custom = head + "#let lca-report-template(" + params.rstrip().rstrip(",") + ") = {\n  set document(\n    date: auto,\n  )" + body
    assert not rt._declares(custom, "date")
    sources = rt.wrap_document(
        [{"type": "heading", "level": 1, "text": "Goal"}], title="A study",
        study={"author": "Jane Doe", "date": "24 October 2026"}, template=custom,
    )
    assert "  date:" not in sources["main.typ"]
    assert typst_render.compile_pdf(sources)[:5] == b"%PDF-"
