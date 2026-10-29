"""Model bundles: what a round trip must not lose, and how a bad import fails.

`test_bundle.py` holds the format's promises; these pin the things a test run against real models found
missing — fields the graph did not carry, history the stores re-stamped, a view still naming the source
model — and the failures that left half a model behind instead of a plain refusal.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile

import pytest
from test_bundle import _b64, _export, _library_with_two_datasets, _link, _repack, fill_source


@pytest.fixture
def filled(client, token, project) -> str:
    del project
    return fill_source(client, token)


def _import(client, token, data: bytes, name: str, **extra):
    return client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": name, **extra}, headers=token
    )


def _databases(client, token) -> set[str]:
    return {d["name"] for d in client.get("/api/v1/databases", headers=token).json()}


def _top(client, token, db: str) -> str:
    return client.get(f"/api/v1/model/activities/{db}", headers=token).json()[0]["code"]


def _with_manifest(data: bytes, edit) -> bytes:
    """The bundle with its manifest changed — the members stay as they are."""
    with zipfile.ZipFile(io.BytesIO(data)) as src:
        raw = {name: src.read(name) for name in src.namelist()}
    manifest = json.loads(raw["manifest.json"])
    edit(manifest)
    raw["manifest.json"] = json.dumps(manifest).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as dst:
        for name, content in raw.items():
            dst.writestr(name, content)
    return buf.getvalue()


def _schema(file: str, schema: int):
    def edit(manifest: dict) -> None:
        for entry in manifest["sections"]:
            if entry["file"] == file:
                entry["schema"] = schema

    return edit


# --- what the round trip carries -------------------------------------------------------------


def test_classification_documentation_and_product_properties_travel(client, token, filled):
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    top = _top(client, token, filled)
    act = bd.Database(filled).get(top)
    act["prism_isic"] = "C"
    act["prism_cpc"] = "36990"
    act["classifications"] = [("CPC", "36990: other plastic products")]
    act["prism_doc"] = {"technology": "injection moulding"}
    act["prism_ref_quantity"] = {"parameter": "mass_kg", "of": top}
    act.save()
    prod = next(iter(act.production()))
    prod["properties"] = {"dry mass": {"amount": 0.95, "unit": "kg", "comment": "measured"}}
    prod.save()

    r = _import(client, token, _export(client, token, filled), "Carried")
    assert r.status_code == 200, r.text
    copy = bd.Database("Carried").get(top)
    assert copy["prism_isic"] == "C" and copy["prism_cpc"] == "36990"
    assert [tuple(c) for c in copy["classifications"]] == [("CPC", "36990: other plastic products")]
    assert copy["prism_doc"] == {"technology": "injection moulding"}
    assert copy["prism_ref_quantity"] == {"parameter": "mass_kg", "of": top}
    assert next(iter(copy.production()))["properties"]["dry mass"]["amount"] == 0.95


def test_parameter_groups_keep_their_order(client, token, filled):
    from prism_lca.engine import parameter_groups

    parameter_groups.create(filled, "Zeta first")
    parameter_groups.create(filled, "Alpha second")
    r = _import(client, token, _export(client, token, filled), "Ordered")
    assert r.status_code == 200, r.text
    assert [g["name"] for g in parameter_groups.list_groups("Ordered")] == ["Zeta first", "Alpha second"]


def test_a_chapter_keeps_its_previous_version_and_its_written_fingerprint(client, token, filled):
    from prism_lca.engine.report_store import ReportStore

    store = ReportStore()
    rep = store.create(filled, name="With history")
    previous = {"text": "The wording before.", "at": "2026-01-02T03:04:05Z", "bindings": {}}
    store.replace_sections(
        filled,
        rep["id"],
        [{"kind": "prose", "title": "Intro", "text": "The wording now.", "previous": previous, "written_sha": "abc123"}],
    )
    r = _import(client, token, _export(client, token, filled), "Reported")
    assert r.status_code == 200, r.text
    (copied,) = [x for x in store.list_reports("Reported") if x["name"] == "With history"]
    (section,) = store.get("Reported", copied["id"])["sections"]
    assert section["text"] == "The wording now."
    assert section["previous"] == previous and section["written_sha"] == "abc123"


def test_a_structure_never_hands_one_reports_history_to_the_next(client, token, project):
    """The history fields are restored by `replace_sections` only, not by every chapter built from a spec."""
    from prism_lca.engine.report_store import ReportStore

    del project
    store = ReportStore()
    store.set_default_sections([{"kind": "prose", "title": "Intro", "previous": {"text": "x"}, "written_sha": "y"}])
    rep = store.create("Anything", name="Fresh")
    assert all("previous" not in s and "written_sha" not in s for s in rep["sections"])


def test_chats_and_research_keep_when_they_happened(client, token, filled):
    from prism_lca.engine.chat_store import ChatStore
    from prism_lca.engine.research_log import ResearchLogStore

    chats = ChatStore()
    chat = chats.create_chat(filled, "Earlier talk")
    said = "2026-01-02T03:04:05.000001+00:00"
    chats.append_messages(filled, chat["id"], [{"role": "user", "content": "hello", "ts": said}], keep_ts=True)
    asked = "2026-01-02T03:04:05Z"
    ResearchLogStore().replace(
        filled, [{"question": "How heavy is it?", "findings": [{"text": "About 20 g."}], "asked": asked}]
    )

    r = _import(client, token, _export(client, token, filled, preset="full"), "Historic")
    assert r.status_code == 200, r.text
    (summary,) = [c for c in chats.list_chats("Historic") if c.get("title") == "Earlier talk"]
    copied = chats.get_chat("Historic", summary["id"])
    assert [m["ts"] for m in copied["messages"]] == [said]
    assert copied["updated"] == said
    assert [e["asked"] for e in ResearchLogStore().list("Historic")] == [asked]


def test_a_live_chat_turn_is_still_stamped_now(client, token, filled):
    """`keep_ts` is the import's: a client cannot backdate a turn through the normal append."""
    from prism_lca.engine.chat_store import ChatStore

    chats = ChatStore()
    chat = chats.create_chat(filled, "Now")
    out = chats.append_messages(filled, chat["id"], [{"role": "user", "content": "hi", "ts": "2001-01-01T00:00:00Z"}])
    assert out["messages"][-1]["ts"] != "2001-01-01T00:00:00Z"


# --- the view follows the model's name -------------------------------------------------------


def test_the_view_follows_a_model_imported_under_another_name(client, token, filled):
    top = _top(client, token, filled)
    node = f"{filled}/{top}"
    view = {
        "layout": {"pos": {node: {"x": 10, "y": 20}, "ecoinvent/abc": {"x": 1, "y": 2}}, "refs": []},
        "colors": {node: "#123456"},
        "groups": [{"id": "g1", "color": "#000000", "members": [node]}],
        "detailed": {"subject": {"database": filled, "code": top}, "shown": [top]},
    }
    assert client.put(f"/api/v1/views/{filled}", json={"view": view}, headers=token).status_code == 200

    r = _import(client, token, _export(client, token, filled), "Elsewhere")
    assert r.status_code == 200, r.text
    back = client.get("/api/v1/views/Elsewhere", headers=token).json()["view"]
    assert back["layout"]["pos"] == {f"Elsewhere/{top}": {"x": 10, "y": 20}, "ecoinvent/abc": {"x": 1, "y": 2}}
    assert back["colors"] == {f"Elsewhere/{top}": "#123456"}
    assert back["groups"][0]["members"] == [f"Elsewhere/{top}"]
    # The detailed results computed the ORIGINAL model while the copy's canvas was open.
    assert back["detailed"]["subject"] == {"database": "Elsewhere", "code": top}
    # …and the source keeps its own.
    assert client.get(f"/api/v1/views/{filled}", headers=token).json()["view"]["colors"] == {node: "#123456"}


def test_the_canvas_follows_a_renamed_model(client, token, filled):
    top = _top(client, token, filled)
    view = {"layout": {"pos": {f"{filled}/{top}": {"x": 5, "y": 6}}}, "colors": {f"{filled}/{top}": "#abcdef"}}
    client.put(f"/api/v1/views/{filled}", json={"view": view}, headers=token)
    r = client.post(
        "/api/v1/databases/foreground/rename", json={"database": filled, "name": "Renamed"}, headers=token
    )
    assert r.status_code == 200, r.text
    back = client.get("/api/v1/views/Renamed", headers=token).json()["view"]
    assert back["layout"]["pos"] == {f"Renamed/{top}": {"x": 5, "y": 6}}
    assert back["colors"] == {f"Renamed/{top}": "#abcdef"}


def test_a_canvas_key_of_a_model_whose_name_extends_the_old_one_stays():
    from prism_lca.engine.view_store import rename_canvas_keys

    view = {"layout": {"pos": {"A/x": 1, "A/B/y": 2}}}
    assert rename_canvas_keys(view, "A", "C")
    assert view["layout"]["pos"] == {"C/x": 1, "A/B/y": 2}


# --- newer formats -------------------------------------------------------------------------------


def test_a_newer_shape_of_a_known_section_is_named_and_not_imported(client, token, filled):
    data = _with_manifest(_export(client, token, filled), _schema("parameters.json", 99))
    look = client.post("/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token).json()
    assert look["newer_sections"] == ["parameters"] and look["unreadable_sections"] == []
    assert look["summary"]["can_import"]
    r = _import(client, token, data, "Older reader")
    assert r.status_code == 200, r.text
    body = r.json()
    # Named as not imported — not "kept", which the next export would have overwritten with an empty section.
    assert body["not_imported_newer"] == ["parameters"] and body["kept_unreadable"] == []
    assert "parameters" not in body["applied"]


def test_a_model_in_a_newer_format_is_refused_in_the_preview_already(client, token, filled):
    data = _with_manifest(_export(client, token, filled), _schema("graph.json", 99))
    look = client.post("/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token)
    assert look.status_code == 400 and look.json()["error"]["code"] == "bundle_too_new"
    before = _databases(client, token)
    r = _import(client, token, data, "Too new")
    assert r.status_code == 400 and r.json()["error"]["code"] == "bundle_too_new"
    assert _databases(client, token) == before


# --- refusals that leave nothing behind --------------------------------------------------------


def test_a_member_that_is_not_json_is_a_damaged_file(client, token, filled):
    data = _export(client, token, filled)
    with zipfile.ZipFile(io.BytesIO(data)) as src:
        raw = {name: src.read(name) for name in src.namelist()}
    raw["study.json"] = b'{"study": '
    manifest = json.loads(raw["manifest.json"])
    for entry in manifest["sections"]:
        if entry["file"] == "study.json":
            entry["sha256"] = hashlib.sha256(raw["study.json"]).hexdigest()
    raw["manifest.json"] = json.dumps(manifest).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as dst:
        for name, content in raw.items():
            dst.writestr(name, content)
    for route in ("inspect", "import"):
        r = client.post(f"/api/v1/bundle/{route}", json={"content": _b64(buf.getvalue())}, headers=token)
        assert r.status_code == 400, r.text
        assert r.json()["error"]["code"] == "bundle_corrupt"


def test_a_malformed_graph_row_leaves_no_half_model(client, token, filled):
    data = _repack(_export(client, token, filled), "graph.json", lambda g: g["exchanges"][-1].pop("input_code"))
    before = _databases(client, token)
    r = _import(client, token, data, "Half")
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "bundle_corrupt"
    assert _databases(client, token) == before


def _library_model_without_its_datasets(client, token, db: str) -> tuple[bytes, str]:
    """A bundle that carries two library datasets, exported and then removed here — the receiver's view."""
    from prism_lca.engine.bootstrap import get_bd

    lib, bolt = _library_with_two_datasets(client, token)
    _link(client, token, db, _top(client, token, db), lib, bolt)
    data = _export(client, token, db)
    for code in ("bolt", "steel"):
        get_bd().Database(lib).get(code).delete()
    return data, lib


def test_a_malformed_library_dataset_takes_the_earlier_ones_back(client, token, filled):
    from prism_lca.engine.bootstrap import get_bd

    data, lib = _library_model_without_its_datasets(client, token, filled)
    # "bolt" lands first and is complete; "steel" fails on its second row.
    broken = _repack(data, "library.json", lambda s: s["datasets"][1]["exchanges"].append({"input_database": lib}))
    before = _databases(client, token)
    r = _import(client, token, broken, "Half library")
    assert r.status_code == 400 and r.json()["error"]["code"] == "bundle_corrupt", r.text
    assert sorted(a["code"] for a in get_bd().Database(lib)) == ["unrelated"]
    assert _databases(client, token) == before


def test_leaving_out_the_library_a_model_needs_is_refused_before_writing(client, token, filled):
    data, _lib = _library_model_without_its_datasets(client, token, filled)
    before = _databases(client, token)
    r = _import(client, token, data, "No library", include=["graph", "parameters"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "bundle_unresolved", r.text
    assert _databases(client, token) == before


def test_a_chosen_dataset_that_does_not_exist_is_no_answer(client, token, filled):
    data, lib = _library_model_without_its_datasets(client, token, filled)
    before = _databases(client, token)
    r = _import(
        client, token, data, "Bad choice",
        include=["graph"], choices={f"{lib}/bolt": {"database": "nowhere", "code": "nothing"}},
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "bundle_unresolved", r.text
    assert _databases(client, token) == before


def test_an_unknown_section_name_in_an_import_is_refused(client, token, filled):
    before = _databases(client, token)
    r = _import(client, token, _export(client, token, filled), "Unknown pick", include=["does_not_exist"])
    assert r.status_code == 400 and r.json()["error"]["code"] == "bundle_unknown_section", r.text
    assert _databases(client, token) == before


# --- found in review -----------------------------------------------------------------------------


def test_the_authors_answers_travel_with_the_report(client, token, filled):
    from prism_lca.engine.report_store import ReportStore

    store = ReportStore()
    rep = store.create(filled, name="Answered")
    answers = {"q1": {"answer": "Recycled PET, 30 %.", "question": "Which granulate?", "at": "2026-01-02T03:04:05Z"}}
    store.update(filled, rep["id"], {"answers": answers})
    r = _import(client, token, _export(client, token, filled), "Answers")
    assert r.status_code == 200, r.text
    (copied,) = [x for x in store.list_reports("Answers") if x["name"] == "Answered"]
    assert store.get("Answers", copied["id"])["answers"] == answers


def test_a_variant_colour_follows_a_scenario_that_got_a_new_id(client, token, filled):
    half = next(
        s for s in client.get("/api/v1/scenarios", params={"database": filled}, headers=token).json()
        if s["name"] == "Half"
    )
    top = _top(client, token, filled)
    client.put(
        f"/api/v1/views/{filled}",
        json={"view": {"results": {"colors": {f"{top}#{half['id']}": "#123456", f"other/{top}#{half['id']}": "#1"}}}},
        headers=token,
    )
    r = _import(client, token, _export(client, token, filled), "Variant colours")
    assert r.status_code == 200, r.text
    new_half = next(
        s for s in client.get("/api/v1/scenarios", params={"database": "Variant colours"}, headers=token).json()
        if s["name"] == "Half"
    )
    assert new_half["id"] != half["id"]
    colors = client.get("/api/v1/views/Variant colours", headers=token).json()["view"]["results"]["colors"]
    # The own variant follows; another model's variant under the same scenario id is not ours to move.
    assert colors == {f"{top}#{new_half['id']}": "#123456", f"other/{top}#{half['id']}": "#1"}


def test_canvas_keys_follow_by_the_models_codes_even_with_a_slash_in_one(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    del project
    bd = get_bd()
    bd.Database("Slashed").write(
        {("Slashed", "part/root"): {"name": "part", "unit": "kilogram", "location": "GLO", "type": "process",
                                    "exchanges": [{"input": ("Slashed", "part/root"), "amount": 1, "type": "production"}]}}
    )
    bd.databases["Slashed"]["prism_read_only"] = False
    bd.databases.flush()
    view = {"layout": {"pos": {"Slashed/part/root": {"x": 1, "y": 2}}}, "colors": {"Slashed/part/root#new-1": "#abc"}}
    client.put("/api/v1/views/Slashed", json={"view": view}, headers=token)

    r = _import(client, token, _export(client, token, "Slashed"), "Slashed copy")
    assert r.status_code == 200, r.text
    back = client.get("/api/v1/views/Slashed copy", headers=token).json()["view"]
    assert back["layout"]["pos"] == {"Slashed copy/part/root": {"x": 1, "y": 2}}
    assert back["colors"] == {"Slashed copy/part/root#new-1": "#abc"}

    r = client.post(
        "/api/v1/databases/foreground/rename", json={"database": "Slashed", "name": "Renamed slash"}, headers=token
    )
    assert r.status_code == 200, r.text
    assert client.get("/api/v1/views/Renamed slash", headers=token).json()["view"]["layout"]["pos"] == {
        "Renamed slash/part/root": {"x": 1, "y": 2}
    }


def test_a_manifest_of_the_wrong_shape_is_a_damaged_file(client, token, filled):
    data = _export(client, token, filled)
    shapes = [
        lambda m: m.update(format="broken"),
        lambda m: m.update(sections=[None]),
        lambda m: m.update(sections=5),
        lambda m: m["sections"][0].update(schema={"a": 1}),
        lambda m: m["sections"][0].update(file=["graph.json"]),
    ]
    for edit in shapes:
        broken = _with_manifest(data, edit)
        for route in ("inspect", "import"):
            r = client.post(f"/api/v1/bundle/{route}", json={"content": _b64(broken)}, headers=token)
            assert r.status_code == 400, (route, r.text)
            assert r.json()["error"]["code"] == "bundle_corrupt"


def test_an_unknown_section_that_cannot_be_stored_takes_the_model_back(client, token, filled, monkeypatch):
    from prism_lca.engine import bundle_unknown

    def refuse(*_args, **_kwargs):
        raise OSError("File name too long")

    monkeypatch.setattr(bundle_unknown, "store_unknown", refuse)
    data = _with_manifest(
        _export(client, token, filled),
        lambda m: m["sections"].append({"file": "future.json", "schema": 1, "required": False}),
    )
    with zipfile.ZipFile(io.BytesIO(data)) as src:
        raw = {name: src.read(name) for name in src.namelist()}
    raw["future.json"] = b"{}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as dst:
        for name, content in raw.items():
            dst.writestr(name, content)
    before = _databases(client, token)
    with pytest.raises(OSError):  # the test client hands the server's exception through
        _import(client, token, buf.getvalue(), "Unstorable")
    assert _databases(client, token) == before
