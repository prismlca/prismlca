"""The report cover, with and without an uploaded image.

Both are laid out on purpose: a cover designed for a photograph and then rendered without one looks
unfinished, and a report whose cover image cannot be decoded must still render.
"""
from __future__ import annotations

import base64
import uuid
import zlib


def _png(width: int = 40, height: int = 30) -> bytes:
    """A real, minimal PNG — the validator sniffs the signature, and Typst decodes it for real."""
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            len(payload).to_bytes(4, "big") + kind + payload
            + zlib.crc32(kind + payload).to_bytes(4, "big")
        )

    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + bytes([8, 2, 0, 0, 0])
    raw = b"".join(b"\x00" + bytes([90, 193, 32] * width) for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def _model(client, token) -> tuple[str, str]:
    """A renderable model: one activity with an emission, and a method that characterises it. Without a
    method the report is "incomplete" and never reaches the typesetter, so the cover would go untested."""
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    db = "bd-" + uuid.uuid4().hex[:6]
    bd.Database(db).write(
        {
            (db, "a"): {
                "name": "Product", "unit": "kg", "reference product": "Product", "location": "GLO",
                "exchanges": [
                    {"input": (db, "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])
    return db, "a"


def _report(client, token, db, code) -> str:
    return client.post(
        "/api/v1/report/create",
        json={
            "database": db,
            "name": "Cover study",
            "methods": [["t", "gwp"]],
            "subjects": [{"database": db, "code": code}],
        },
        headers=token,
    ).json()["id"]


def test_cover_image_round_trips_and_reaches_the_typst_project(client, token, project):
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    data_url = "data:image/png;base64," + base64.b64encode(_png()).decode()

    r = client.post(f"/api/v1/report/one/{db}/{rid}", json={"cover_image": data_url}, headers=token)
    assert r.status_code == 200, r.text
    # Stored as bare base64 — the data-URL prefix would otherwise end up inside the PNG bytes.
    assert not r.json()["cover_image"].startswith("data:")

    src = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token)
    assert src.status_code == 200, src.text
    body = src.json()
    # Text files come back as `files`, images by name under `binary`.
    assert "cover.png" in body["binary"]
    assert 'cover-image: "cover.png"' in body["files"]["main.typ"]


def test_a_new_report_starts_with_the_shipped_picture(client, token, project):
    """A cover that places a picture should look finished on the first render, so a new report carries
    the placeholder. It is stored as the word "default" — 270 kB of the same PNG copied into every
    report would be waste, and nothing could then tell the placeholder from a picture that matches it."""
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    stored = client.get(f"/api/v1/report/one/{db}/{rid}", headers=token).json()
    assert stored["cover_image"] == "default"

    body = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    # A JPEG, so it is named .jpg in the project — Typst decodes by file name.
    assert "cover.jpg" in body["binary"]
    assert 'cover-image: "cover.jpg"' in body["files"]["main.typ"]


def test_removing_the_picture_leaves_the_cover_without_one(client, token, project):
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    client.post(f"/api/v1/report/one/{db}/{rid}", json={"cover_image": ""}, headers=token)
    body = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    assert "cover.png" not in body["binary"]
    assert "cover-image:" not in body["files"]["main.typ"]


def test_the_placeholder_can_be_put_back_and_is_served_for_the_thumbnail(client, token, project):
    """"Placeholder" in the report card sets the word back; the card needs the picture itself to show a
    thumbnail, because the report only stores the word."""
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    client.post(f"/api/v1/report/one/{db}/{rid}", json={"cover_image": ""}, headers=token)
    r = client.post(f"/api/v1/report/one/{db}/{rid}", json={"cover_image": "default"}, headers=token)
    assert r.json()["cover_image"] == "default"

    served = client.get("/api/v1/report/cover-placeholder", headers=token)
    assert served.status_code == 200
    import base64

    assert base64.b64decode(served.json()["base64"])[:3] == b"\xff\xd8\xff"  # the shipped photo is a JPEG


def test_an_empty_value_removes_the_cover(client, token, project):
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    client.post(
        f"/api/v1/report/one/{db}/{rid}",
        json={"cover_image": base64.b64encode(_png()).decode()},
        headers=token,
    )
    r = client.post(f"/api/v1/report/one/{db}/{rid}", json={"cover_image": ""}, headers=token)
    assert r.status_code == 200
    assert not r.json().get("cover_image")


def test_a_file_that_is_not_an_image_is_refused_with_a_usable_message(client, token, project):
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    r = client.post(
        f"/api/v1/report/one/{db}/{rid}",
        json={"cover_image": base64.b64encode(b"%PDF-1.7 not an image").decode()},
        headers=token,
    )
    assert r.status_code >= 400
    body = r.json()["error"]
    assert body["code"] == "cover_image_unsupported"
    assert "PNG" in body["hint"]


def test_a_cover_image_still_compiles_to_a_pdf(client, token, project):
    """The layout itself, not just the wiring: a bad `#image` argument or a clip block Typst rejects
    would only show up here, and a cover is the one page every reader sees."""
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    client.post(
        f"/api/v1/report/one/{db}/{rid}",
        json={"cover_image": base64.b64encode(_png(600, 400)).decode()},
        headers=token,
    )
    r = client.post(f"/api/v1/report/one/{db}/{rid}/pdf", json={}, headers=token)
    assert r.status_code == 200, r.text
    assert base64.b64decode(r.json()["base64"])[:5] == b"%PDF-"


def test_a_stored_cover_that_no_longer_decodes_does_not_break_the_report(client, token, project):
    """A broken cover must cost the cover, not the document."""
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    # Written past the API's validation, the way a hand-edited or half-migrated store would look.
    from prism_lca.engine import report_store

    store = report_store.ReportStore()
    store.update(db, rid, {"cover_image": "not base64 at all !!"})
    r = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token)
    assert r.status_code == 200, r.text
    assert "cover.png" not in r.json()["binary"]


def _jpeg() -> bytes:
    """A real, minimal JPEG. Written by Pillow rather than hand-rolled: the point of this fixture is that
    the bytes are genuinely a JPEG, which is what the bug was about."""
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (40, 24), (90, 193, 32)).save(buf, "JPEG", quality=80)
    return buf.getvalue()


def test_a_jpeg_cover_compiles(client, token, project):
    """Typst picks its decoder from the FILE NAME, not from the bytes. Everything used to be written into
    the project as `cover.png`, so a JPEG — which the upload has always accepted — failed the compile
    with "Invalid PNG signature". Every cover test used a PNG, so nothing caught it."""
    import base64

    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    r = client.post(
        f"/api/v1/report/one/{db}/{rid}",
        json={"cover_image": base64.b64encode(_jpeg()).decode()},
        headers=token,
    )
    assert r.status_code == 200, r.text

    body = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    assert "cover.jpg" in body["binary"], body["binary"]
    assert 'cover-image: "cover.jpg"' in body["files"]["main.typ"]
    assert client.post(f"/api/v1/report/one/{db}/{rid}/pdf", json={}, headers=token).status_code == 200


def test_the_shipped_cover_is_a_jpeg_and_reaches_the_page(client, token, project):
    """The default is a photograph: a JPEG at 158 kB rather than a 1.7 MB PNG, and it has to survive the
    same naming rule as an uploaded one."""
    db, code = _model(client, token)
    rid = _report(client, token, db, code)
    body = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    assert "cover.jpg" in body["binary"]
    assert client.post(f"/api/v1/report/one/{db}/{rid}/pdf", json={}, headers=token).status_code == 200


def test_the_identity_fills_the_cover_fields_a_study_leaves_empty():
    """Who the report says wrote it, when nobody typed it into the study.

    The point of storing an identity is that it is typed once. If the cover only printed what the study
    itself carries, the field would stay empty in exactly the case it exists for.
    """
    from prism_lca.engine.report_render import _cover_study

    filled = _cover_study(
        {"author": "", "organisation": None},
        {"author": "Jane Doe", "organisation": "Doe Consulting"},
        "2026-07-28 09:15 UTC",
    )
    assert filled["author"] == "Jane Doe"
    assert filled["organisation"] == "Doe Consulting"
    # The day, not the timestamp: a cover carries a date, not a moment.
    assert filled["date"] == "2026-07-28"


def test_a_study_that_names_its_own_author_keeps_it():
    """The identity is a fallback, never an override — a study written for a client under their name
    must not silently gain the consultancy's."""
    from prism_lca.engine.report_render import _cover_study

    kept = _cover_study(
        {"author": "Someone Else", "date": "2020-01-01"},
        {"author": "Jane Doe", "organisation": "Doe Consulting"},
        "2026-07-28 09:15 UTC",
    )
    assert kept["author"] == "Someone Else"
    assert kept["date"] == "2020-01-01"
    assert kept["organisation"] == "Doe Consulting"  # this one the study did leave open


def test_both_logos_and_a_custom_height_reach_the_cover_and_compile(client, token, project):
    """The whole identity path, end to end and through the typesetter.

    The wiring is easy to get right in three places and wrong in the fourth — a logo that is stored, echoed
    by the API and put in the Typst project, but never passed to the template, looks identical from the
    outside. Only the compiled page tells the difference, so this compiles.
    """
    db, code = _model(client, token)
    rid = _report(client, token, db, code)

    assert client.post(
        "/api/v1/report/identity",
        json={
            "author": "Jane Doe",
            "organisation": "Doe Consulting",
            "company_logo": base64.b64encode(_png(300, 90)).decode(),
            "logo_height_mm": 14.0,
        },
        headers=token,
    ).status_code == 200
    assert client.post(
        f"/api/v1/report/one/{db}/{rid}",
        json={"client_logo": base64.b64encode(_png(200, 80)).decode()},
        headers=token,
    ).status_code == 200

    body = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    main = body["files"]["main.typ"]
    assert 'logo: "logo.png"' in main, main[:400]
    assert 'client-logo: "client-logo.png"' in main, main[:400]
    assert "logo.png" in body["binary"] and "client-logo.png" in body["binary"], body["binary"]
    assert "logo-height: 14mm" in main, main[:400]
    # The identity fills the study fields nobody typed into this report.
    assert "Jane Doe" in main and "Doe Consulting" in main
    assert client.post(f"/api/v1/report/one/{db}/{rid}/pdf", json={}, headers=token).status_code == 200


def test_a_logo_height_outside_the_allowed_range_is_refused():
    """5–25mm is checked in the store, not only in the number input: a client that posts 400 would
    otherwise put a logo across the whole title page."""
    import pytest

    from prism_lca.engine import report_store
    from prism_lca.errors import PrismError

    store = report_store.ReportStore()
    for bad in (0.0, 4.9, 25.1, 400.0):
        with pytest.raises(PrismError):
            store.set_identity({"logo_height_mm": bad})
    assert store.set_identity({"logo_height_mm": 12.5})["logo_height_mm"] == 12.5


def test_no_logo_means_no_logo(client, token, project):
    """A cover carries the author's mark or nothing.

    PrismLCA's own mark used to stand in for a missing one, which is why there had to be a third state — a "no
    mark at all" switch — to say what removing the logo already says, and why removing an uploaded logo did
    not remove the mark from the cover. Both are gone: the argument is simply left out, the template's own
    `logo: none` default applies, and no file rides along in an exported project either. What still says the
    document came from PrismLCA is the colophon, which no template can suppress.
    """
    db, code = _model(client, token)
    rid = _report(client, token, db, code)

    bare = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    assert "  logo:" not in bare["files"]["main.typ"]
    assert not [n for n in bare["binary"] if n.startswith(("logo.", "prism-logo"))]
    assert client.post(f"/api/v1/report/one/{db}/{rid}/pdf", json={}, headers=token).status_code == 200

    # Upload one and it is printed, under its own name.
    assert client.post(
        "/api/v1/report/identity",
        json={"company_logo": base64.b64encode(_png(300, 90)).decode()},
        headers=token,
    ).status_code == 200
    own = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    assert 'logo: "logo.png"' in own["files"]["main.typ"]
    assert "logo.png" in own["binary"]

    # Remove it and the cover is bare again — which is the whole of what the switch used to do.
    assert client.post("/api/v1/report/identity", json={"company_logo": ""}, headers=token).status_code == 200
    again = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    assert "  logo:" not in again["files"]["main.typ"]
    assert not [n for n in again["binary"] if n.startswith(("logo.", "prism-logo"))]


def test_the_removed_no_logo_switch_does_nothing_any_more(client, token, project):
    """`no_logo` is gone. It existed only because an empty logo field meant "use PrismLCA's mark".

    Over the API it is simply not a field: the request model drops it, so an older client sending it gets a
    200 and changes nothing — which is the right way for a switch to disappear. The store still refuses it,
    because writing a key nothing reads into an identity is a typo, not a request.
    """
    import pytest

    from prism_lca.engine import report_store
    from prism_lca.errors import PrismError

    assert client.post("/api/v1/report/identity", json={"no_logo": True}, headers=token).status_code == 200
    identity = client.get("/api/v1/report/identity", headers=token).json()
    assert "no_logo" not in identity

    store = report_store.ReportStore()
    with pytest.raises(PrismError):
        store.set_identity({"no_logo": True})


def test_the_cover_date_survives_the_pdf_path(client, token, project):
    """The date on the title page comes from the study, and from the render stamp when the study is silent.

    That stamp used to reach the renderer only on the preview path, which pins it deliberately. `/sources`
    and `/pdf` passed none — so a report whose study carries no date previewed *with* one and exported
    without. It now falls back to the provenance every path already hands over.
    """
    db, code = _model(client, token)
    rid = _report(client, token, db, code)

    sources = client.post(f"/api/v1/report/one/{db}/{rid}/sources", json={}, headers=token).json()
    main = sources["files"]["main.typ"]
    assert '("Date", "' in main, main[:600]
    # The day, not the minute — a cover carries a date, not a moment.
    date = main.split('("Date", "')[1].split('"')[0]
    assert len(date) == 10 and date.count("-") == 2, date

    # And the same on the PDF path, which is what was actually broken.
    assert client.post(f"/api/v1/report/one/{db}/{rid}/pdf", json={}, headers=token).status_code == 200


def test_the_subtitle_does_not_repeat_the_title():
    """A report named after its reference process must not print that process again underneath.

    The default second line is "<reference process> (<database>)". A report created from the canvas is
    named "<reference process> report", so the fallback repeated the title almost word for word — it
    read as a bug on the cover. An empty string leaves the key out of the Typst call, so the templates
    print nothing at all.
    """
    from prism_lca.engine.report_render import _cover_subtitle

    process = {"name": "Household cling film roll — cradle-to-gate", "database": "Cling film"}

    # The duplicating case: the title already contains the process name.
    assert _cover_subtitle({}, "Household cling film roll — cradle-to-gate report", process) == ""
    assert _cover_subtitle({}, "Household cling film roll — cradle-to-gate", process) == ""
    # A title of the author's own still gets the process spelled out — that is what a subtitle is for.
    assert _cover_subtitle({}, "Cling film study 2026", process) == (
        "Household cling film roll — cradle-to-gate (Cling film)"
    )
    # A title SHORTER than the process name is an abbreviation, not a duplication.
    assert _cover_subtitle({}, "Cling film", process).startswith("Household cling film roll")
    # An explicit subtitle always wins, and nothing is invented when there is no process.
    assert _cover_subtitle({"subtitle": "For internal review"}, "X report", process) == "For internal review"
    assert _cover_subtitle({}, "LCA report", {"name": "", "database": "db"}) == ""
