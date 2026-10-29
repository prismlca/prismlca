"""Model bundles: the round trip, and the four promises the format makes.

The promises, each with its own test below, because each is the kind of thing that is easy to claim
and easy to break silently:

1. a bundle written by an older version still imports (the golden bundles in `fixtures/bundles/`),
2. two exports of the same model are byte-identical,
3. no background dataset content ends up in the file (the licence rule),
4. a section this version cannot read survives a round trip instead of being dropped.
"""

from __future__ import annotations

import base64
import io
import json
import os
import zipfile
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "bundles"


def _model(client, token, name: str) -> str:
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    return name


def _activity(client, token, db: str, name: str) -> str:
    r = client.post(
        "/api/v1/model/activities",
        json={"database": db, "name": name, "unit": "kilogram", "location": "GLO"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


@pytest.fixture
def filled(client, token, project) -> str:
    """A model with enough in it that an empty section would be visible in a failure."""
    del project
    return fill_source(client, token)


def fill_source(client, token) -> str:
    """The body of `filled`, for the other bundle test modules' own fixture."""
    db = _model(client, token, "Bundle Source")
    top = _activity(client, token, db, "bottle")
    sub = _activity(client, token, db, "granulate")
    r = client.post(
        "/api/v1/model/exchanges",
        json={
            "activity_database": db,
            "activity_code": top,
            "input_database": db,
            "input_code": sub,
            "amount": 2.5,
            "type": "technosphere",
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    client.post(
        "/api/v1/params",
        json={
            "database": db,
            "name": "mass_kg",
            "amount": 0.5,
            "unit": "kg",
            "rule": {"kind": "range", "min": 0, "max": 1},
        },
        headers=token,
    )
    client.post(
        "/api/v1/model/tags",
        json={"database": db, "code": top, "dimension": "Life-cycle phase", "value": "Production"},
        headers=token,
    )
    client.post(
        "/api/v1/scenarios",
        json={"database": db, "name": "Half", "overrides": {"mass_kg": 0.25}},
        headers=token,
    )
    client.post(
        "/api/v1/study",
        json={
            "database": db,
            "goal": "PCF of a bottle",
            "functional_unit": "1 bottle",
            "author": "Example Org",
        },
        headers=token,
    )
    client.put(
        f"/api/v1/views/{db}",
        json={"view": {"layout": {"pos": {top: {"x": 10, "y": 20}}}}},
        headers=token,
    )
    return db


def _export(client, token, db: str, preset: str = "model") -> bytes:
    r = client.post("/api/v1/bundle/export", json={"database": db, "preset": preset}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"].endswith(".prism")
    assert body["bytes"] == len(base64.b64decode(body["base64"]))
    return base64.b64decode(body["base64"])


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _members(data: bytes) -> list[str]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return sorted(zf.namelist())


def _read(data: bytes, member: str) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return json.loads(zf.read(member))


# --- export -----------------------------------------------------------------------------------


def test_a_model_export_carries_the_sections_of_the_model_preset(client, token, filled):
    data = _export(client, token, filled)
    assert _members(data) == sorted(
        [
            "manifest.json",
            "graph.json",
            "library.json",
            "parameters.json",
            "tags.json",
            "scenarios.json",
            "study.json",
            "view.json",
            "reports.json",
            "research_log.json",
            "review_log.json",
        ]
    )
    manifest = _read(data, "manifest.json")
    assert manifest["format"] == 1
    assert manifest["model"]["name"] == filled
    assert manifest["written_at"] is None  # a timestamp would break determinism
    assert {e["file"] for e in manifest["sections"]} == set(_members(data)) - {"manifest.json"}


def test_the_full_preset_adds_the_chats_and_the_audit(client, token, filled):
    data = _export(client, token, filled, preset="full")
    assert "chats.json" in _members(data)
    assert "audit.json" in _members(data)


def test_the_graph_carries_formulas_and_uncertainty(client, token, filled):
    """What the XLSX round trip dropped: a parameterised amount came back as a bare number.

    Also the point of carrying the *whole* exchange rather than four columns of it — a formula and an
    uncertainty distribution are modelling decisions, not decoration.
    """
    ex_graph = _read(_export(client, token, filled), "graph.json")
    tech = next(e for e in ex_graph["exchanges"] if e.get("type") == "technosphere")
    detail = client.get(
        f"/api/v1/model/activities/{filled}/{tech['activity']}", headers=token
    ).json()
    uid = next(e["uid"] for e in detail["exchanges"] if e["type"] == "technosphere")

    assert (
        client.post(
            "/api/v1/params/exchange-formula",
            json={
                "activity_database": filled,
                "activity_code": tech["activity"],
                "uid": uid,
                "formula": "mass_kg * 2",
            },
            headers=token,
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/v1/model/exchanges/uncertainty",
            json={
                "activity_database": filled,
                "activity_code": tech["activity"],
                "uid": uid,
                "distribution": "lognormal",
                "params": {"median": 2.5, "gsd": 1.2},
            },
            headers=token,
        ).status_code
        == 200
    )

    graph = _read(_export(client, token, filled), "graph.json")
    exported = next(e for e in graph["exchanges"] if e.get("type") == "technosphere")
    assert exported.get("formula") == "mass_kg * 2"
    assert exported.get("uncertainty type") == 2  # lognormal
    assert exported.get("scale")  # the spread travels too, not just the number

    # …and it comes back on the other side, which is the half that actually matters.
    r = client.post(
        "/api/v1/bundle/import",
        json={"content": _b64(_export(client, token, filled)), "name": "WithFormula"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    back = client.get(
        f"/api/v1/model/activities/WithFormula/{tech['activity']}", headers=token
    ).json()
    ex_back = next(e for e in back["exchanges"] if e["type"] == "technosphere")
    assert ex_back.get("formula") == "mass_kg * 2"

    # …and it is *alive* there. The formula text travelled from the first day; what did not was its
    # registration in a parameter group, so the imported model showed the formula and ignored it —
    # every scenario of an imported model scored exactly the baseline.
    assert ex_back["amount"] == pytest.approx(1.0)  # mass_kg 0.5 * 2, recalculated on import
    assert (
        client.post(
            "/api/v1/params",
            json={"database": "WithFormula", "name": "mass_kg", "amount": 0.75},  # within its 0–1 rule
            headers=token,
        ).status_code
        == 200
    )
    back = client.get(
        f"/api/v1/model/activities/WithFormula/{tech['activity']}", headers=token
    ).json()
    ex_back = next(e for e in back["exchanges"] if e["type"] == "technosphere")
    assert ex_back["amount"] == pytest.approx(1.5)
    # The original is a separate model and keeps its own value.
    orig = client.get(f"/api/v1/model/activities/{filled}/{tech['activity']}", headers=token).json()
    assert next(e for e in orig["exchanges"] if e["type"] == "technosphere")["amount"] == pytest.approx(1.0)


def test_parameter_groups_survive_the_round_trip(client, token, filled):
    """The bundle carried the groups and the parameters, but not the line between them: the reader
    looked for a key the writer never used, so an imported model showed its groups empty and every
    parameter under Ungrouped."""
    r = client.post("/api/v1/params/groups", json={"database": filled, "name": "Masses"}, headers=token)
    assert r.status_code == 200, r.text
    gid = r.json()["group"]["id"] if "group" in r.json() else r.json()["id"]
    assert (
        client.post(
            "/api/v1/params/group",
            json={"database": filled, "name": "mass_kg", "group_id": gid},
            headers=token,
        ).status_code
        == 200
    )
    r = client.post(
        "/api/v1/bundle/import",
        json={"content": _b64(_export(client, token, filled)), "name": "Grouped"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    back = client.get("/api/v1/params", params={"database": "Grouped"}, headers=token).json()
    mass = next(p for p in back if p["name"] == "mass_kg")
    assert mass["group"] == "Masses"
    groups = client.get("/api/v1/params/groups", params={"database": "Grouped"}, headers=token).json()
    names = [g["name"] for g in (groups if isinstance(groups, list) else groups["groups"])]
    assert names == ["Masses"]


def test_two_exports_of_the_same_model_are_byte_identical(client, token, filled):
    """Without this a checksum means nothing and a diff of two bundles is unreadable."""
    assert _export(client, token, filled) == _export(client, token, filled)


def test_no_background_dataset_content_is_in_the_file(client, token, filled):
    """The licence rule: a bundle references background data, it never carries it."""
    data = _export(client, token, filled)
    graph = _read(data, "graph.json")
    # Every exchange input either belongs to the model or appears as a *reference* — never as an
    # activity with its own fields.
    own = {a["code"] for a in graph["activities"]}
    for ex in graph["exchanges"]:
        if ex["input_database"] != filled:
            assert ex["input_code"] not in own
    for ref in graph["references"]:
        assert set(ref) <= {
            "database",
            "code",
            "name",
            "reference_product",
            "location",
            "unit",
            "version",
        }


def test_a_background_database_cannot_be_exported_as_a_model(client, token, project):
    del project
    from prism_lca.engine.guardrails import set_read_only

    db = _model(client, token, "PretendBackground")
    set_read_only(db, True)
    r = client.post("/api/v1/bundle/export", json={"database": db}, headers=token)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "read_only_database"


# --- inspect ----------------------------------------------------------------------------------


def test_inspect_reports_without_writing(client, token, filled):
    data = _export(client, token, filled)
    before = client.get("/api/v1/databases", headers=token).json()
    r = client.post("/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model"]["name"] == filled
    assert body["summary"]["can_import"] is True  # this model has no background links
    assert body["unreadable_sections"] == []
    assert client.get("/api/v1/databases", headers=token).json() == before


def test_inspect_refuses_something_that_is_not_a_bundle(client, token, project):
    del project
    r = client.post(
        "/api/v1/bundle/inspect", json={"content": _b64(b"not a zip at all")}, headers=token
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "bundle_unreadable"


def test_a_bundle_from_a_newer_format_says_so_instead_of_guessing(client, token, filled):
    data = _export(client, token, filled)
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(buf, "w") as dst:
        for name in src.namelist():
            raw = src.read(name)
            if name == "manifest.json":
                m = json.loads(raw)
                m["format"] = 99
                raw = json.dumps(m).encode()
            dst.writestr(name, raw)
    r = client.post("/api/v1/bundle/inspect", json={"content": _b64(buf.getvalue())}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "bundle_too_new"


# --- import -----------------------------------------------------------------------------------


def test_the_round_trip_brings_everything_back(client, token, filled):
    data = _export(client, token, filled)
    r = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "Imported"}, headers=token
    )
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["database"] == "Imported"
    assert set(result["applied"]) >= {"graph", "parameters", "tags", "scenarios", "study", "view"}

    acts = client.get("/api/v1/model/activities/Imported", headers=token).json()
    assert {a["name"] for a in acts} == {"bottle", "granulate"}
    params = client.get("/api/v1/params?database=Imported", headers=token).json()
    assert [p["name"] for p in params] == ["mass_kg"]
    assert params[0]["rule"] == {"kind": "range", "min": 0.0, "max": 1.0}  # the value rule survives
    scen = client.get("/api/v1/scenarios?database=Imported", headers=token).json()
    assert [s["name"] for s in scen] == ["Half"]
    study = client.get("/api/v1/study?database=Imported", headers=token).json()
    assert study["goal"] == "PCF of a bottle"
    view = client.get("/api/v1/views/Imported", headers=token).json()["view"]
    assert view["layout"]["pos"]



def test_an_imported_model_can_be_edited_like_a_local_one(client, token, filled):
    """A bundle carries no exchange uids; the importer must give fresh ones, or every amount and
    comment edit is refused with "uid: Input should be a valid string"."""
    data = _export(client, token, filled)
    name = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "Editable"}, headers=token
    ).json()["database"]
    acts = client.get(f"/api/v1/model/activities/{name}", headers=token).json()
    for a in acts:
        detail = client.get(f"/api/v1/model/activities/{name}/{a['code']}", headers=token).json()
        assert all(ex["uid"] for ex in detail["exchanges"]), detail["exchanges"]
    bottle = next(a for a in acts if a["name"] == "bottle")
    detail = client.get(f"/api/v1/model/activities/{name}/{bottle['code']}", headers=token).json()
    ex = next(e for e in detail["exchanges"] if e["type"] != "production")
    base = {"activity_database": name, "activity_code": bottle["code"], "uid": ex["uid"]}
    r = client.post("/api/v1/model/exchanges/amount", json={**base, "amount": 3.0}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/model/exchanges/comment", json={**base, "comment": "from the bundle"}, headers=token)
    assert r.status_code == 200, r.text
    after = client.get(f"/api/v1/model/activities/{name}/{bottle['code']}", headers=token).json()
    edited = next(e for e in after["exchanges"] if e["uid"] == ex["uid"])
    assert edited["amount"] == 3.0 and edited["comment"] == "from the bundle"
    # The original is untouched: the copy got uids of its own.
    orig = client.get(f"/api/v1/model/activities/{filled}", headers=token).json()
    ob = next(a for a in orig if a["name"] == "bottle")
    o_detail = client.get(f"/api/v1/model/activities/{filled}/{ob['code']}", headers=token).json()
    assert ex["uid"] not in {e["uid"] for e in o_detail["exchanges"]}

def test_importing_twice_renames_rather_than_merges(client, token, filled):
    data = _export(client, token, filled)
    first = client.post("/api/v1/bundle/import", json={"content": _b64(data)}, headers=token).json()
    second = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data)}, headers=token
    ).json()
    assert first["database"] == filled + " (2)" or first["database"] == filled
    assert second["database"] != first["database"]


def test_an_import_is_one_undo(client, token, filled):
    data = _export(client, token, filled)
    name = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "Undoable"}, headers=token
    ).json()["database"]
    assert any(d["name"] == name for d in client.get("/api/v1/databases", headers=token).json())
    r = client.post("/api/v1/model/undo", headers=token)
    assert r.status_code == 200, r.text
    assert not any(d["name"] == name for d in client.get("/api/v1/databases", headers=token).json())


def test_an_unknown_section_survives_the_round_trip(client, token, filled):
    """Promise 4: read what you know, keep what you don't — or an older PrismLCA destroys newer data."""
    data = _export(client, token, filled)
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(buf, "w") as dst:
        for name in src.namelist():
            raw = src.read(name)
            if name == "manifest.json":
                m = json.loads(raw)
                m["sections"].append({"file": "uncertainty.json", "schema": 1, "required": False})
                raw = json.dumps(m).encode()
            dst.writestr(name, raw)
        dst.writestr("uncertainty.json", json.dumps({"seed": 7}).encode())

    body = client.post(
        "/api/v1/bundle/inspect", json={"content": _b64(buf.getvalue())}, headers=token
    ).json()
    assert body["unreadable_sections"] == ["uncertainty.json"]

    result = client.post(
        "/api/v1/bundle/import",
        json={"content": _b64(buf.getvalue()), "name": "KeptUnknown"},
        headers=token,
    ).json()
    assert result["kept_unreadable"], result
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.bundle_unknown import unknown_dir

    kept = unknown_dir("KeptUnknown") / "uncertainty.json"
    assert kept.is_relative_to(Path(get_bd().projects.dir) / "prism_meta" / "imported_unknown")
    assert json.loads(kept.read_text(encoding="utf-8")) == {"seed": 7}


def _with_unknown_and_name(data: bytes, name: str) -> bytes:
    """A bundle carrying one section this version cannot read, under a model name of our choosing."""
    import hashlib

    section = json.dumps({"proof": "written by bundle import"}).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(buf, "w") as dst:
        for member in src.namelist():
            raw = src.read(member)
            if member == "manifest.json":
                m = json.loads(raw)
                m["model"]["name"] = name
                m["sections"].append(
                    {"file": "review-proof.json", "schema": 99, "required": False,
                     "sha256": hashlib.sha256(section).hexdigest()}
                )
                raw = json.dumps(m).encode()
            dst.writestr(member, raw)
        dst.writestr("review-proof.json", section)
    return buf.getvalue()


def test_a_bundle_name_cannot_write_outside_prism_meta(client, token, filled, tmp_path):
    """The model name from a foreign manifest became a path component, so an
    absolute name or `../` wrote the unread sections anywhere the app could write."""
    from prism_lca.engine.bootstrap import get_bd

    outside = tmp_path / "outside"
    outside.mkdir()
    victim = outside / "review-proof.json"
    victim.write_text("ORIGINAL BENIGN TEST FILE", encoding="utf-8")
    root = Path(get_bd().projects.dir) / "prism_meta" / "imported_unknown"
    data = _export(client, token, filled)
    for name in (str(outside), "../../escape-attempt"):
        r = client.post("/api/v1/bundle/import", json={"content": _b64(_with_unknown_and_name(data, name))}, headers=token)
        assert r.status_code == 200, r.text
        assert all(Path(p).parts[0] == "imported_unknown" for p in r.json()["kept_unreadable"]), r.json()
    assert victim.read_text(encoding="utf-8") == "ORIGINAL BENIGN TEST FILE"
    assert not (Path(get_bd().projects.dir).parent / "escape-attempt").exists()
    assert any(f.name == "review-proof.json" for f in root.rglob("*"))


def test_a_damaged_bundle_is_refused_before_anything_is_written(client, token, filled):
    data = _export(client, token, filled)
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(buf, "w") as dst:
        for name in src.namelist():
            raw = src.read(name)
            if name == "study.json":
                raw = json.dumps({"study": {"goal": "tampered"}}).encode()
            dst.writestr(name, raw)
    r = client.post("/api/v1/bundle/inspect", json={"content": _b64(buf.getvalue())}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "bundle_corrupt"


def test_a_report_with_chapters_survives_the_round_trip(client, token, filled):
    """Found by exporting a real model and importing it again: `list_reports` adds a derived
    `section_count`, and handing that back to `update` failed the whole import with
    "Unknown report fields". A summary is not a report."""
    r = client.post(
        "/api/v1/report/create",
        json={"database": filled, "name": "Client report", "subtitle": "First draft", "lang": "de"},
        headers=token,
    )
    assert r.status_code == 200, r.text

    data = _export(client, token, filled)
    assert any(rep.get("name") == "Client report" for rep in _read(data, "reports.json")["reports"])

    imported = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "WithReport"}, headers=token
    )
    assert imported.status_code == 200, imported.text
    assert "reports" in imported.json()["applied"]
    back = client.get("/api/v1/report/list/WithReport", headers=token).json()
    names = [x["name"] for x in (back if isinstance(back, list) else back.get("reports", []))]
    assert "Client report" in names


def test_a_failing_section_leaves_nothing_behind(client, token, filled, monkeypatch):
    """The atomicity promise, tested where it actually broke.

    A real import wrote the graph and then hit a refused reports section — and the model stayed, minus
    its parameters. A half-imported model is worse than none, because nothing says so.
    """
    data = _export(client, token, filled)
    from prism_lca.engine import bundle as _b
    from prism_lca.errors import PrismError

    def boom(database, payload):  # noqa: ANN001, ARG001
        # A PrismError, because that is what the real failure was: a refused reports section.
        raise PrismError("section refused", code="test_refusal")

    monkeypatch.setattr(_b.SECTION_BY_NAME["study"], "reader", boom)
    r = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "HalfWay"}, headers=token
    )
    assert r.status_code >= 400
    names = {d["name"] for d in client.get("/api/v1/databases", headers=token).json()}
    assert "HalfWay" not in names


def test_a_report_option_that_no_longer_exists_does_not_refuse_the_model(client, token, filled):
    """Also from the live run: a months-old report carried retired option keys."""
    rid = client.post(
        "/api/v1/report/create", json={"database": filled, "name": "Old report"}, headers=token
    ).json()["id"]
    from prism_lca.engine._store import read_json, write_json_atomic
    from prism_lca.engine.report_store import ReportStore

    # Straight into the file: the store's `update` validates options and would refuse the retired one —
    # which is the point, a report written by an older PrismLCA carries it (the old
    # test called a `put_raw` that does not exist, so it never reached the import).
    store = ReportStore()
    path = store._path()
    everything = read_json(path, default={})
    for rep in everything[filled]:
        if rep["id"] == rid:
            rep["options"] = {"comparative": True, "figures": {"heatmap": True}}  # one retired, one current
    write_json_atomic(path, everything)
    assert "comparative" in store.get(filled, rid)["options"]

    data = _export(client, token, filled)
    reports = _read(data, "reports.json")["reports"]
    assert any("comparative" in (rep.get("options") or {}) for rep in reports)
    r = client.post(
        "/api/v1/bundle/import",
        json={"content": _b64(data), "name": "OldOptions"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    back = client.get("/api/v1/report/list/OldOptions", headers=token).json()
    rows = back if isinstance(back, list) else back.get("reports", [])
    assert rows, "the report did not come back"
    imported = store.get("OldOptions", rows[0]["id"])
    assert "comparative" not in (imported.get("options") or {})
    assert imported["options"]["figures"]["heatmap"] is True  # the current option survived


def test_the_dry_run_says_the_name_it_will_really_use(client, token, filled):
    """Importing a model that already exists used to be silent.

    Nothing was broken — the import never merges and never overwrites — but the dry run prefilled the
    name from the bundle, which is exactly the taken one, so a collision looked like no collision.
    """
    data = _export(client, token, filled)
    body = client.post("/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token).json()
    assert body["model"]["name"] == filled
    assert body["model"]["name_taken"] is True
    assert body["model"]["suggested_name"] == f"{filled} (2)"

    # …and the import lands exactly where the dry run said it would.
    r = client.post("/api/v1/bundle/import", json={"content": _b64(data)}, headers=token)
    assert r.json()["database"] == f"{filled} (2)"

    # A name that is free is reported as free, with no suffix invented.
    body2 = client.post(
        "/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token
    ).json()
    assert body2["model"]["suggested_name"] == f"{filled} (3)"  # (2) is taken now


def test_an_import_leaves_the_original_completely_alone(client, token, filled):
    """The question behind it: is the model I already had now broken?"""

    # Sorted, because Brightway's iteration order is not stable — comparing the lists as they come
    # back would fail on a reshuffle and read as "the import changed my model", which it did not.
    def acts() -> list:
        return sorted(
            client.get(f"/api/v1/model/activities/{filled}", headers=token).json(),
            key=lambda a: a["code"],
        )

    def params_of() -> list:
        return sorted(
            client.get(f"/api/v1/params?database={filled}", headers=token).json(),
            key=lambda p: p["name"],
        )

    before_acts = acts()
    before_params = params_of()
    before_view = client.get(f"/api/v1/views/{filled}", headers=token).json()["view"]

    data = _export(client, token, filled)
    copy = client.post("/api/v1/bundle/import", json={"content": _b64(data)}, headers=token).json()[
        "database"
    ]
    assert copy != filled

    assert acts() == before_acts
    assert params_of() == before_params
    assert client.get(f"/api/v1/views/{filled}", headers=token).json()["view"] == before_view

    # And the copy is wired to itself, not into the original — the failure that would make both wrong.
    from prism_lca.engine.bootstrap import get_bd

    targets = {e.input.key[0] for a in get_bd().Database(copy) for e in a.exchanges()}
    assert filled not in targets, targets


# --- the golden bundles -----------------------------------------------------------------------


@pytest.mark.parametrize("fixture", sorted(FIXTURES.glob("*.prism")) if FIXTURES.exists() else [])
def test_every_golden_bundle_still_imports(client, token, project, fixture):
    """The compatibility guarantee, and the only one that does not rely on good intentions.

    One fixture per schema version ever released; they stay here forever. If a change breaks an old
    save, this test breaks first.
    """
    del project
    content = _b64(fixture.read_bytes())
    body = client.post("/api/v1/bundle/inspect", json={"content": content}, headers=token).json()
    assert body["summary"]["can_import"] is True, body
    r = client.post(
        "/api/v1/bundle/import",
        json={"content": content, "name": f"Golden {fixture.stem}"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["activities"] >= 1


# --- the library section: the user's own datasets travel with the model -----------------------


def _library_with_two_datasets(client, token) -> tuple[str, str]:
    """Two library datasets, the first drawing on the second — the closure the section must follow."""
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.library import LIBRARY_DB, ensure_library, stamp

    del client, token
    bd = get_bd()
    lib = ensure_library()
    prov = stamp("supplier.xlsx", "simapro", "batch0001", "Supplier data 2026")
    bd.Database(lib).write(
        {
            (lib, "bolt"): {
                "name": "my bolt",
                "unit": "kilogram",
                "reference product": "my bolt",
                "location": "CH",
                "type": "process",
                "comment": "own measurement",
                **prov,
                "exchanges": [
                    {"input": (lib, "bolt"), "amount": 1, "type": "production"},
                    {
                        "input": (lib, "steel"),
                        "amount": 1.1,
                        "type": "technosphere",
                        "formula": "1.1 * loss",
                    },
                ],
            },
            (lib, "steel"): {
                "name": "my steel",
                "unit": "kilogram",
                "reference product": "my steel",
                "location": "CH",
                "type": "process",
                **prov,
                "exchanges": [{"input": (lib, "steel"), "amount": 1, "type": "production"}],
            },
            (lib, "unrelated"): {
                "name": "not used by the model",
                "unit": "kilogram",
                "reference product": "x",
                "location": "CH",
                "type": "process",
                "exchanges": [{"input": (lib, "unrelated"), "amount": 1, "type": "production"}],
            },
        }
    )
    bd.databases[lib]["prism_read_only"] = False
    bd.databases.flush()
    assert LIBRARY_DB == lib
    return lib, "bolt"


def _link(
    client, token, db: str, code: str, inp_db: str, inp_code: str, amount: float = 2.0
) -> None:
    r = client.post(
        "/api/v1/model/exchanges",
        json={
            "activity_database": db,
            "activity_code": code,
            "input_database": inp_db,
            "input_code": inp_code,
            "amount": amount,
            "type": "technosphere",
        },
        headers=token,
    )
    assert r.status_code == 200, r.text


def test_the_library_section_carries_the_closure_of_used_datasets(client, token, filled):
    lib, bolt = _library_with_two_datasets(client, token)
    top = client.get(f"/api/v1/model/activities/{filled}", headers=token).json()[0]["code"]
    _link(client, token, filled, top, lib, bolt)
    data = _export(client, token, filled)
    section = _read(data, "library.json")
    assert section["database"] == lib and section["model"] == filled
    # bolt (linked) and steel (bolt's input) travel; "unrelated" does not.
    assert [d["code"] for d in section["datasets"]] == ["bolt", "steel"]
    bolt_row = section["datasets"][0]
    assert bolt_row["prism_import_source"] == "supplier.xlsx"  # provenance comes along
    steel_link = next(e for e in bolt_row["exchanges"] if e["input_code"] == "steel")
    assert steel_link["formula"] == "1.1 * loss"
    assert not any(e.get("type") == "production" for e in bolt_row["exchanges"])
    manifest = _read(data, "manifest.json")
    assert lib not in {b["database"] for b in manifest["requires"]["backgrounds"]}
    # Determinism holds with the section in place.
    assert _export(client, token, filled) == data
    if os.environ.get("PRISM_WRITE_GOLDEN"):
        (FIXTURES / "v1-model-library.prism").write_bytes(data)


def test_the_library_lands_in_the_receivers_library_as_one_batch(client, token, filled):
    from prism_lca.engine.bootstrap import get_bd

    lib, bolt = _library_with_two_datasets(client, token)
    top = client.get(f"/api/v1/model/activities/{filled}", headers=token).json()[0]["code"]
    _link(client, token, filled, top, lib, bolt)
    data = _export(client, token, filled)

    # Receiver without those datasets: wipe the library first.
    bd = get_bd()
    for act in list(bd.Database(lib)):
        act.delete()
    look = client.post("/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token).json()
    assert look["library"] == {"datasets": 2, "present": 0, "new": 2}
    assert look["summary"]["can_import"] is True  # the library link resolves: the bundle brings it
    lib_ref = next(r for r in look["references"] if r["database"] == lib)
    assert lib_ref["verdict"] == "exact"

    r = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "With library"}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["library"] == {"added": 2, "kept": 0}
    assert "library" in r.json()["applied"]
    landed = {a["code"]: a for a in bd.Database(lib)}
    assert set(landed) == {"bolt", "steel"}
    assert landed["bolt"]["prism_import_format"] == "prism-bundle"
    assert landed["bolt"]["prism_import_label"].startswith("Bundle")
    assert landed["bolt"]["prism_bundle_origin"]["prism_import_source"] == "supplier.xlsx"
    assert landed["bolt"]["prism_import_batch"] == landed["steel"]["prism_import_batch"]
    inputs = {(e.input["database"], e.input["code"]): e for e in landed["bolt"].exchanges()}
    assert inputs[(lib, "steel")]["formula"] == "1.1 * loss"
    model_inputs = {
        (e.input["database"], e.input["code"])
        for e in bd.Database("With library").get(top).exchanges()
    }
    assert (lib, "bolt") in model_inputs

    # Undo takes the model AND the datasets this import brought.
    r = client.post("/api/v1/model/undo", headers=token)
    assert r.status_code == 200, r.text
    assert len(bd.Database(lib)) == 0


def test_an_existing_library_dataset_is_kept_and_a_clash_gets_a_free_code(client, token, filled):
    from prism_lca.engine.bootstrap import get_bd

    lib, bolt = _library_with_two_datasets(client, token)
    top = client.get(f"/api/v1/model/activities/{filled}", headers=token).json()[0]["code"]
    _link(client, token, filled, top, lib, bolt)
    data = _export(client, token, filled)

    bd = get_bd()
    # Same code, same name → the receiver's copy wins. Same code, other name → a different thing.
    steel_here = bd.Database(lib).get("steel")
    steel_here["comment"] = "the receiver's own steel"
    steel_here.save()
    bolt_here = bd.Database(lib).get("bolt")
    bolt_here["name"] = "something else entirely"
    bolt_here.save()
    look = client.post("/api/v1/bundle/inspect", json={"content": _b64(data)}, headers=token).json()
    # The preview counts by the import's rule: the renamed bolt is a new dataset, not one already here.
    assert look["library"] == {"datasets": 2, "present": 1, "new": 1}

    r = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "Clash"}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["library"] == {"added": 1, "kept": 1}
    codes = sorted(a["code"] for a in bd.Database(lib))
    assert codes == ["bolt", "bolt-2", "steel", "unrelated"]
    assert bd.Database(lib).get("steel")["comment"] == "the receiver's own steel"
    assert bd.Database(lib).get("bolt-2")["name"] == "my bolt"
    # The imported model points at the freed code, not at the stranger under the old one.
    model_inputs = {
        (e.input["database"], e.input["code"]) for e in bd.Database("Clash").get(top).exchanges()
    }
    assert (lib, "bolt-2") in model_inputs and (lib, "bolt") not in model_inputs


def _first_code(client, token, db: str) -> str:
    return client.get(f"/api/v1/model/activities/{db}", headers=token).json()[0]["code"]


def _report_ids(client, token, db: str) -> dict[str, str]:
    back = client.get(f"/api/v1/report/list/{db}", headers=token).json()
    rows = back if isinstance(back, list) else back.get("reports", [])
    return {r["name"]: r["id"] for r in rows}


def _repack(data: bytes, member: str, edit) -> bytes:
    """A bundle with one JSON member changed and its manifest checksum brought along."""
    import hashlib

    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src:
        raw = {name: src.read(name) for name in src.namelist()}
    changed = json.loads(raw[member])
    edit(changed)
    raw[member] = json.dumps(changed).encode()
    manifest = json.loads(raw["manifest.json"])
    for entry in manifest["sections"]:
        if entry["file"] == member:
            entry["sha256"] = hashlib.sha256(raw[member]).hexdigest()
    raw["manifest.json"] = json.dumps(manifest).encode()
    with zipfile.ZipFile(buf, "w") as dst:
        for name, content in raw.items():
            dst.writestr(name, content)
    return buf.getvalue()


def test_imported_reports_still_point_at_the_imported_scenarios(client, token, filled):
    """Scenarios came back under fresh ids while the reports kept the old ones, so
    every imported comparison saw its variants as deleted."""
    half = next(
        s for s in client.get("/api/v1/scenarios", params={"database": filled}, headers=token).json()
        if s["name"] == "Half"
    )
    top = _first_code(client, token, filled)
    r = client.post(
        "/api/v1/report/create",
        json={"database": filled, "name": "Variants",
              "subjects": [{"database": filled, "code": top}, {"database": filled, "code": top, "scenario": half["id"]}]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    data = _export(client, token, filled)
    imported = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "WithVariants"}, headers=token
    )
    assert imported.status_code == 200, imported.text
    new_half = next(
        s for s in client.get("/api/v1/scenarios", params={"database": "WithVariants"}, headers=token).json()
        if s["name"] == "Half"
    )
    # Imported beside its source, the id was taken — so this is the re-pointing path, not the keep-id one.
    assert new_half["id"] != half["id"]
    rid = _report_ids(client, token, "WithVariants")["Variants"]
    rep = client.get(f"/api/v1/report/one/WithVariants/{rid}", headers=token).json()
    assert [s.get("scenario") for s in rep["subjects"] if s.get("scenario")] == [new_half["id"]]


def test_the_imported_results_setup_follows_scenarios_that_got_new_ids(client, token, filled):
    """A copy imported beside its source got fresh scenario ids, the view kept the
    old ones — the page pruned the ticks and, with the baseline off, compared nothing."""
    half = next(
        s for s in client.get("/api/v1/scenarios", params={"database": filled}, headers=token).json()
        if s["name"] == "Half"
    )
    top = _first_code(client, token, filled)
    client.put(
        f"/api/v1/views/{filled}",
        json={
            "view": {
                "results": {
                    "subjSel": {top: True},
                    "scenSel": {half["id"]: True},
                    "baseline": False,
                    "colors": {half["id"]: "#123456", top: "#654321"},
                    "refCode": f"{top}#{half['id']}",
                },
                "detailed": {"subject": {"database": filled, "code": top, "scenario": half["id"]},
                             "variants": ["", half["id"]]},
                "short_report": {"head": {"title": "T", "subtitle": ""},
                                 "compare": [{"scenario": half["id"]}, {"code": top}]},
            }
        },
        headers=token,
    )
    data = _export(client, token, filled)
    imported = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "ViewVariants"}, headers=token
    )
    assert imported.status_code == 200, imported.text
    new_half = next(
        s for s in client.get("/api/v1/scenarios", params={"database": "ViewVariants"}, headers=token).json()
        if s["name"] == "Half"
    )
    assert new_half["id"] != half["id"]  # the re-pointing path, not the keep-id one
    view = client.get("/api/v1/views/ViewVariants", headers=token).json()["view"]
    assert view["results"]["scenSel"] == {new_half["id"]: True}
    assert view["results"]["colors"] == {new_half["id"]: "#123456", top: "#654321"}
    assert view["results"]["refCode"] == f"{top}#{new_half['id']}"
    assert view["detailed"]["subject"]["scenario"] == new_half["id"]
    assert view["detailed"]["variants"] == ["", new_half["id"]]
    # The short report's variants live with the model too, and follow the same way.
    assert view["short_report"]["compare"] == [{"scenario": new_half["id"]}, {"code": top}]
    assert view["short_report"]["head"] == {"title": "T", "subtitle": ""}
    # …and the view left the mapping for the reports section after it, which takes it (pops it).
    from prism_lca.engine.bundle import _IMPORTED_SCENARIO_IDS

    assert "ViewVariants" not in _IMPORTED_SCENARIO_IDS


def test_chapter_bindings_figures_and_options_survive_the_round_trip(client, token, filled):
    """`replace_sections` rebuilt every chapter from its core fields only."""
    from prism_lca.engine.report_store import ReportStore

    rid = client.post(
        "/api/v1/report/create", json={"database": filled, "name": "Pinned"}, headers=token
    ).json()["id"]
    store = ReportStore()
    sid = store.get(filled, rid)["sections"][0]["id"]
    store.update_section(
        filled, rid, sid,
        {"bindings": {"contribution.groups.0": {"key": "Packaging"}}, "hotspots": False,
         "hidden_indicators": ["EF v3.1 / water use"]},
    )
    data = _export(client, token, filled)
    imported = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "PinnedCopy"}, headers=token
    )
    assert imported.status_code == 200, imported.text
    new_rid = _report_ids(client, token, "PinnedCopy")["Pinned"]
    back = store.get("PinnedCopy", new_rid)["sections"][0]
    assert back["bindings"] == {"contribution.groups.0": {"key": "Packaging"}}
    assert back["hotspots"] is False
    assert back["hidden_indicators"] == ["EF v3.1 / water use"]


def test_a_template_the_receiver_does_not_have_does_not_refuse_the_model(client, token, filled):
    """The bundle names the template, the receiver's store refused the name, and the
    whole model import was undone over a cover design."""
    client.post("/api/v1/report/create", json={"database": filled, "name": "Styled"}, headers=token)
    data = _repack(
        _export(client, token, filled), "reports.json",
        lambda d: [rep.__setitem__("template", "no-such-template") for rep in d["reports"]],
    )
    imported = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "NoTemplate"}, headers=token
    )
    assert imported.status_code == 200, imported.text
    rid = _report_ids(client, token, "NoTemplate")["Styled"]
    rep = client.get(f"/api/v1/report/one/NoTemplate/{rid}", headers=token).json()
    assert rep.get("template") != "no-such-template"


def test_translations_travel_with_the_report(client, token, filled):
    """The export whitelist had `lang` but not `translations`."""
    from prism_lca.engine.report_store import ReportStore

    rid = client.post(
        "/api/v1/report/create", json={"database": filled, "name": "Translated", "lang": "en"}, headers=token
    ).json()["id"]
    store = ReportStore()
    store.update(filled, rid, {"translations": {"lang": "en", "map": {"study.goal": "PCF of a bottle"}}})
    data = _export(client, token, filled)
    assert any(rep.get("translations") for rep in _read(data, "reports.json")["reports"])
    imported = client.post(
        "/api/v1/bundle/import", json={"content": _b64(data), "name": "TranslatedCopy"}, headers=token
    )
    assert imported.status_code == 200, imported.text
    new_rid = _report_ids(client, token, "TranslatedCopy")["Translated"]
    assert store.get("TranslatedCopy", new_rid)["translations"] == {"lang": "en", "map": {"study.goal": "PCF of a bottle"}}


def test_an_unknown_section_goes_out_again_with_the_next_export(client, token, filled):
    """Kept on disk, but the next export wrote only the registered sections."""
    data = _export(client, token, filled)
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(buf, "w") as dst:
        for name in src.namelist():
            raw = src.read(name)
            if name == "manifest.json":
                m = json.loads(raw)
                m["sections"].append({"file": "uncertainty.json", "schema": 3, "required": False})
                raw = json.dumps(m).encode()
            dst.writestr(name, raw)
        dst.writestr("uncertainty.json", json.dumps({"seed": 7}).encode())
    assert client.post(
        "/api/v1/bundle/import", json={"content": _b64(buf.getvalue()), "name": "KeptAgain"}, headers=token
    ).status_code == 200
    again = _export(client, token, "KeptAgain")
    assert "uncertainty.json" in _members(again)
    assert _read(again, "uncertainty.json") == {"seed": 7}
    entry = next(e for e in _read(again, "manifest.json")["sections"] if e["file"] == "uncertainty.json")
    assert entry["schema"] == 3 and entry["required"] is False and entry["sha256"]


# --- scenarios with formula overrides -----------------------------------------


def _section_schema(data: bytes, file: str) -> int:
    return next(e["schema"] for e in _read(data, "manifest.json")["sections"] if e["file"] == file)


def test_a_bundle_of_numeric_scenarios_keeps_scenario_schema_1(client, token, filled):
    """An older PrismLCA must still read what it always could: nothing in `filled` is a formula."""
    assert _section_schema(_export(client, token, filled), "scenarios.json") == 1


def test_a_formula_override_travels_with_the_bundle(client, token, project):
    """Round trip of a scenario whose override is a formula; the section is declared schema 2 so an
    older PrismLCA keeps it verbatim instead of reading the formula as a number."""
    del project
    db = _model(client, token, "Golden v2")
    top = _activity(client, token, db, "bottle")
    sub = _activity(client, token, db, "granulate")
    for body in (
        {"name": "mass_kg", "amount": 0.5},
        {"name": "input_kg", "formula": "2 * mass_kg"},
    ):
        r = client.post("/api/v1/params", json={"database": db, **body}, headers=token)
        assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": top, "input_database": db, "input_code": sub,
              "amount": 1.0, "type": "technosphere"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/scenarios",
        json={"database": db, "name": "Heavier", "overrides": {"input_kg": "3 * mass_kg", "mass_kg": 0.6}},
        headers=token,
    )
    assert r.status_code == 200, r.text

    data = _export(client, token, db)
    assert _section_schema(data, "scenarios.json") == 2
    section = _read(data, "scenarios.json")
    assert section["scenarios"][0]["overrides"] == {"input_kg": "3 * mass_kg", "mass_kg": 0.6}
    assert _export(client, token, db) == data  # still deterministic
    if os.environ.get("PRISM_WRITE_GOLDEN"):
        (FIXTURES / "v2-scenario-formula.prism").write_bytes(data)

    r = client.post("/api/v1/bundle/import", json={"content": _b64(data), "name": "FormulaCopy"}, headers=token)
    assert r.status_code == 200, r.text
    scen = client.get("/api/v1/scenarios", params={"database": "FormulaCopy"}, headers=token).json()
    assert scen[0]["overrides"] == {"input_kg": "3 * mass_kg", "mass_kg": 0.6}


def test_the_golden_formula_scenario_imports_with_its_formula(client, token, project):
    del project
    content = _b64((FIXTURES / "v2-scenario-formula.prism").read_bytes())
    r = client.post("/api/v1/bundle/import", json={"content": content, "name": "GoldenFormula"}, headers=token)
    assert r.status_code == 200, r.text
    scen = client.get("/api/v1/scenarios", params={"database": "GoldenFormula"}, headers=token).json()
    assert scen[0]["overrides"]["input_kg"] == "3 * mass_kg"


# --- chats: plan travels, run is reset, transcript stays home ---------------------------------


def test_a_chat_plan_survives_the_round_trip_and_its_run_comes_back_idle(client, token, filled):
    from prism_lca.engine import chat_transcripts

    api = "/api/v1/ai/chats"
    cid = client.post(f"{api}/{filled}", json={"title": "Build"}, headers=token).json()["id"]
    client.post(f"{api}/{filled}/{cid}/messages",
                json={"messages": [{"role": "user", "content": "go"},
                                   {"role": "assistant", "content": "", "turn_id": "t9", "outcome": "rounds"}]},
                headers=token)
    plan = {"title": "Bottle", "steps": [{"step": "Link PET", "status": "completed", "note": "RER"},
                                         {"step": "Check", "status": "blocked", "note": "needs FU"}],
            "revision": 5, "updated": "2026-10-01T09:00:00+00:00"}
    client.put(f"{api}/{filled}/{cid}/plan", json={"plan": plan}, headers=token)
    client.put(f"{api}/{filled}/{cid}/run", json={"runId": "r-src", "state": "running", "turnId": "t9"}, headers=token)
    client.put(f"{api}/{filled}/{cid}/transcript",
               json={"turn_id": "t9", "history_after": [], "messages": []}, headers=token)

    data = _export(client, token, filled, preset="full")
    exported = _read(data, "chats.json")["chats"]
    assert exported[0]["plan"] == plan
    assert exported[0]["run"]["state"] == "running"
    assert not any("transcript" in m for m in _members(data))

    r = client.post("/api/v1/bundle/import", json={"content": _b64(data), "name": "WithPlan"}, headers=token)
    assert r.status_code == 200, r.text
    (summary,) = client.get(f"{api}/WithPlan", headers=token).json()["chats"]
    assert summary["id"] != cid
    back = client.get(f"{api}/WithPlan/{summary['id']}", headers=token).json()
    assert back["plan"] == plan
    assert back["run"]["state"] == "idle" and set(back["run"]) == {"runId", "state"}
    assert back["run"]["runId"] != "r-src"
    assert back["messages"][1]["turn_id"] == "t9" and back["messages"][1]["outcome"] == "rounds"
    assert chat_transcripts.load(summary["id"]) is None

    again = _read(_export(client, token, "WithPlan", preset="full"), "chats.json")["chats"]
    assert again[0]["plan"] == plan
    assert again[0]["run"]["state"] == "idle"


def test_a_chat_without_a_plan_imports_as_before(client, token, filled):
    api = "/api/v1/ai/chats"
    cid = client.post(f"{api}/{filled}", json={}, headers=token).json()["id"]
    client.post(f"{api}/{filled}/{cid}/messages", json={"messages": [{"role": "user", "content": "hi"}]},
                headers=token)
    data = _export(client, token, filled, preset="full")
    assert "plan" not in _read(data, "chats.json")["chats"][0]
    r = client.post("/api/v1/bundle/import", json={"content": _b64(data), "name": "NoPlan"}, headers=token)
    assert r.status_code == 200, r.text
    (summary,) = client.get(f"{api}/NoPlan", headers=token).json()["chats"]
    back = client.get(f"{api}/NoPlan/{summary['id']}", headers=token).json()
    assert "plan" not in back and "run" not in back
