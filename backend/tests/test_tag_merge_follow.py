"""What a tag merge does beside the tags (engine/tag_references.py).

A merged group is the same dimension under the surviving name, so the model's saved breakdowns and its
reports follow it — and undo takes them back, but not a choice the user made in between. A merged value is
not followed: the reports whose chapters cite it are named, before the merge and in its result.
"""
from __future__ import annotations

import uuid

import pytest

from prism_lca.engine.report_store import ReportStore
from prism_lca.engine.view_store import ViewStore

GROUPS = "/api/v1/model/tag-groups"


def _ok(r) -> dict:
    assert r.status_code == 200, r.text
    return r.json()


def _model(client, token) -> str:
    db = "m-" + uuid.uuid4().hex[:6]
    _ok(client.post("/api/v1/databases/foreground", json={"name": db}, headers=token))
    return db


def _process(client, token, db: str, name: str) -> str:
    return _ok(client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token))[
        "activity"
    ]["code"]


def _tagged(client, token, db: str, group: str, value: str, name: str) -> str:
    code = _process(client, token, db, name)
    _ok(client.post(f"{GROUPS}/values", json={"database": db, "group": group, "value": value}, headers=token))
    _ok(client.post("/api/v1/model/tags/set", json={"keys": [{"database": db, "code": code}], "group": group,
                                                    "value": value}, headers=token))
    return code


def _two_groups(client, token) -> str:
    """A model holding one dimension under two names, "Bauteil" and "Component"."""
    db = _model(client, token)
    for name in ("Bauteil", "Component"):
        _ok(client.post(GROUPS, json={"database": db, "name": name}, headers=token))
    _tagged(client, token, db, "Bauteil", "Use", "a")
    _tagged(client, token, db, "Component", "Production", "b")
    return db


def _view(db: str, view: dict) -> None:
    ViewStore().put(db, view)


def _chapter(selection_by: str, **extra) -> dict:
    """A written prose chapter: its record says which breakdown it was written for."""
    return {"kind": "prose", "text": "Text.", "based_on": {"selection": {"aggregate_by": selection_by}}, **extra}


def _report(db: str, aggregate_by: str, sections: list[dict], name: str = "Study") -> dict:
    return ReportStore().create(db, name=name, aggregate_by=aggregate_by, sections=sections)


def _stored(db: str, report_id: str) -> dict:
    return ReportStore().get(db, report_id)


def _merge_groups(client, token, db: str, name: str = "Bauteil", into: str = "Component") -> dict:
    return _ok(client.post(f"{GROUPS}/merge", json={"database": db, "name": name, "into": into}, headers=token))


def _undo(client, token, db: str) -> None:
    _ok(client.post("/api/v1/model/undo", json={"database": db}, headers=token))


def _redo(client, token, db: str) -> None:
    _ok(client.post("/api/v1/model/redo", json={"database": db}, headers=token))


SAVED = {
    "results": {"stackBy": "tag:Bauteil", "picked": ["x"]},
    "detailed": {"groupBy": "Bauteil", "cutoff": 1},
    "short_report": {"breakdowns": ["tag:Bauteil", "geo"], "colour_by": "tag:Bauteil", "head": {"title": "T"}},
}


def test_a_merged_group_takes_the_saved_breakdowns_along_and_undo_brings_them_back(client, token, project):
    db = _two_groups(client, token)
    _view(db, SAVED)

    r = _merge_groups(client, token, db)
    view = ViewStore().get(db)
    assert view["results"] == {"stackBy": "tag:Component", "picked": ["x"]}
    assert view["detailed"] == {"groupBy": "Component", "cutoff": 1}
    assert view["short_report"] == {
        "breakdowns": ["tag:Component", "geo"], "colour_by": "tag:Component", "head": {"title": "T"},
    }
    assert r["followed"]["views"] == [
        "the Results split", "the Detailed results grouping", "the short report's breakdowns",
        "the short report's system figure colours",
    ]
    assert r["followed"]["reports"] == []

    _undo(client, token, db)
    assert ViewStore().get(db) == SAVED
    _redo(client, token, db)
    assert ViewStore().get(db)["detailed"]["groupBy"] == "Component"


def test_undo_leaves_a_breakdown_alone_that_named_the_target_already_or_was_chosen_again(client, token, project):
    """Only what the merge wrote goes back: the grouping that was "Component" before stays so, and a
    split the user picked after the merge is the user's."""
    db = _two_groups(client, token)
    _view(db, {
        "results": {"stackBy": "tag:Bauteil"},
        "detailed": {"groupBy": "Component"},
        "short_report": {"breakdowns": ["tag:Component", "tag:Bauteil"], "colour_by": "tag:Bauteil"},
    })
    _merge_groups(client, token, db)
    # One breakdown now, not the same one twice.
    assert ViewStore().get(db)["short_report"]["breakdowns"] == ["tag:Component"]
    _view(db, {"results": {"stackBy": "isic"}})

    _undo(client, token, db)
    view = ViewStore().get(db)
    assert view["results"] == {"stackBy": "isic"}
    assert view["detailed"] == {"groupBy": "Component"}
    assert view["short_report"] == {"breakdowns": ["tag:Component", "tag:Bauteil"], "colour_by": "tag:Bauteil"}


def test_a_merged_group_takes_the_models_reports_along_with_their_chapter_records(client, token, project):
    db = _two_groups(client, token)
    rep = _report(db, "tag:Bauteil", [
        _chapter("tag:Bauteil"),
        {"kind": "contribution", "aggregate_by": "tag:Bauteil"},
        {"kind": "system_model", "colour_by": "tag:Bauteil"},
        _chapter("geo"),
    ])
    other = _report(db, "geo", [_chapter("geo")], name="Other")
    before = _stored(db, rep["id"])

    r = _merge_groups(client, token, db)
    assert r["followed"]["reports"] == [{"id": rep["id"], "name": "Study"}]
    after = _stored(db, rep["id"])
    assert after["aggregate_by"] == "tag:Component"
    prose, contribution, system, written_by_geo = after["sections"]
    assert prose["based_on"]["selection"]["aggregate_by"] == "tag:Component"
    assert prose["text"] == "Text."
    assert contribution["aggregate_by"] == "tag:Component"
    assert system["colour_by"] == "tag:Component"
    assert written_by_geo["based_on"]["selection"]["aggregate_by"] == "geo"
    assert after["updated"] != before["updated"]
    assert _stored(db, other["id"]) == other

    _undo(client, token, db)
    restored = _stored(db, rep["id"])
    assert {k: v for k, v in restored.items() if k != "updated"} == {k: v for k, v in before.items() if k != "updated"}


def test_a_written_chapter_is_not_called_stale_for_the_rename_alone(client, token, project):
    """The record follows the report, so the selection check finds nothing to say — the chapter was written
    for this breakdown, under its old name."""
    from prism_lca.engine import report_staleness as rs

    db = _two_groups(client, token)
    rep = _report(db, "tag:Bauteil", [_chapter("tag:Bauteil")])
    _merge_groups(client, token, db)
    stored = _stored(db, rep["id"])
    old = stored["sections"][0]["based_on"]["selection"]
    new = rs.selection_of(stored, {})
    assert rs._selection_message({"aggregate_by": old["aggregate_by"]}, {"aggregate_by": new["aggregate_by"]}) is None


def test_another_models_saved_breakdowns_and_reports_stay(client, token, project):
    """Groups belong to their model: the same name elsewhere is another group, and its choices are its own."""
    db, elsewhere = _two_groups(client, token), _two_groups(client, token)
    _view(elsewhere, SAVED)
    rep = _report(elsewhere, "tag:Bauteil", [_chapter("tag:Bauteil")])
    _merge_groups(client, token, db)
    assert ViewStore().get(elsewhere) == SAVED
    assert _stored(elsewhere, rep["id"]) == rep


def test_a_report_store_that_cannot_be_read_stops_the_merge_before_anything_moved(client, token, project):
    from prism_lca.engine._store import prism_meta_dir

    db = _two_groups(client, token)
    _view(db, SAVED)
    _report(db, "tag:Bauteil", [])
    groups_before = _ok(client.get(f"{GROUPS}?database={db}", headers=token))["groups"]
    path = prism_meta_dir() / ReportStore.FILENAME
    path.write_text("{ not json", encoding="utf-8")

    r = client.post(f"{GROUPS}/merge", json={"database": db, "name": "Bauteil", "into": "Component"}, headers=token)
    assert r.status_code >= 400 and r.json()["error"]["code"] == "report_store_unreadable"
    assert ViewStore().get(db) == SAVED
    assert _ok(client.get(f"{GROUPS}?database={db}", headers=token))["groups"] == groups_before


def test_the_preview_names_what_a_group_merge_would_take_along(client, token, project):
    db = _two_groups(client, token)
    _view(db, {"results": {"stackBy": "tag:Bauteil"}, "detailed": {"groupBy": "Component"}})
    rep = _report(db, "geo", [{"kind": "system_model", "colour_by": "tag:Bauteil"}])
    _report(db, "geo", [_chapter("geo")], name="Unrelated")

    r = _ok(client.get(f"{GROUPS}/merge-preview", params={"database": db, "group": "Bauteil"}, headers=token))
    assert r["views"] == ["the Results split"]
    assert r["reports"] == [{"id": rep["id"], "name": "Study"}]


# ---- a merged value -------------------------------------------------------------------------------------


def _citing(value: str, *, cited: bool = True) -> dict:
    """A chapter pinning a breakdown row to `value` — citing it in its text, or holding an orphaned pin."""
    text = "The phase takes {{contribution.groups.0.share_text}}." if cited else "No figure here."
    return {"kind": "prose", "text": text, "bindings": {"contribution.groups.0": {"key": value}}}


@pytest.fixture
def phases(client, token):
    db = _model(client, token)
    _ok(client.post(GROUPS, json={"database": db, "name": "Bauteil"}, headers=token))
    for value in ("Use", "Use Phase"):
        _tagged(client, token, db, "Bauteil", value, value)
    return db


def test_a_value_merge_names_the_reports_whose_chapters_cite_the_value(client, token, project, phases):
    db = phases
    rep = _report(db, "tag:Bauteil", [_citing("Use Phase"), _citing("Use Phase"), _citing("Use")])
    _report(db, "tag:Bauteil", [_citing("Use Phase", cited=False)], name="Orphaned pin")
    _report(db, "geo", [_citing("Use Phase")], name="Other breakdown")

    preview = _ok(client.get(f"{GROUPS}/merge-preview", params={"database": db, "group": "Bauteil", "value": "Use Phase"},
                             headers=token))
    assert preview["reports_citing"] == [{"id": rep["id"], "name": "Study", "chapters": 2}]
    assert preview["note"].startswith("Report “Study” (2 chapters) cites “Use Phase”")

    r = _ok(client.post(f"{GROUPS}/values/merge", json={"database": db, "group": "Bauteil", "value": "Use Phase",
                                                        "into": "Use"}, headers=token))
    assert r["reports_citing"] == preview["reports_citing"]
    assert r["note"] == (
        "Report “Study” (2 chapters) cites “Use Phase”; those figures show as missing until the chapters are updated."
    )
    # The pins stay where they were: re-pointing one at "Use" would print that figure twice in a chapter citing both.
    assert _stored(db, rep["id"])["sections"][0]["bindings"] == {"contribution.groups.0": {"key": "Use Phase"}}


def test_a_value_merge_nobody_cites_says_nothing_about_reports(client, token, project, phases):
    r = _ok(client.post(f"{GROUPS}/values/merge", json={"database": phases, "group": "Bauteil", "value": "Use Phase",
                                                        "into": "Use"}, headers=token))
    assert "reports_citing" not in r and "note" not in r


# ---- what Astra's review found ----------------------------------------------------------------------------


def test_a_report_that_splits_by_both_groups_keeps_its_breakdowns(client, token, project):
    """Following would make two of its breakdowns one, and every later chapter's table labels move up a place —
    `t-contribution-d2` would name another breakdown's table with nothing reporting it."""
    db = _two_groups(client, token)
    sections = [
        {"kind": "contribution", "aggregate_by": "tag:Bauteil"},
        {"kind": "contribution", "aggregate_by": "tag:Component"},
        {"kind": "contribution", "aggregate_by": "geo"},
        {"kind": "system_model", "colour_by": "tag:Bauteil"},
        _chapter("isic"),
    ]
    both = _report(db, "isic", sections, name="Both")
    single = _report(db, "tag:Bauteil", [_chapter("tag:Bauteil")], name="Single")

    preview = _ok(client.get(f"{GROUPS}/merge-preview", params={"database": db, "group": "Bauteil", "into": "Component"},
                             headers=token))
    assert preview["reports"] == [{"id": single["id"], "name": "Single"}]
    assert preview["reports_kept"] == [{"id": both["id"], "name": "Both"}]
    assert preview["note"] == "Report “Both” already splits by both groups and keeps its breakdowns; change them in the report."

    r = _merge_groups(client, token, db)
    assert r["followed"]["reports"] == [{"id": single["id"], "name": "Single"}]
    assert r["followed"]["reports_kept"] == [{"id": both["id"], "name": "Both"}]
    assert r["followed"]["note"] == preview["note"]
    stored = _stored(db, both["id"])
    assert [s.get("aggregate_by") for s in stored["sections"][:3]] == ["tag:Bauteil", "tag:Component", "geo"]
    assert stored["sections"][3]["colour_by"] == "tag:Component"  # a colour moves no label
    assert _stored(db, single["id"])["aggregate_by"] == "tag:Component"

    _undo(client, token, db)
    assert _stored(db, both["id"])["sections"][3]["colour_by"] == "tag:Bauteil"


def test_a_view_write_from_a_copy_older_than_the_merge_is_refused(client, token, project):
    """The renderer writes its whole copy of a view: one queued before the merge would put the old group back."""
    db = _two_groups(client, token)
    _view(db, SAVED)
    read = _ok(client.get(f"/api/v1/views/{db}", headers=token))
    _merge_groups(client, token, db)

    stale = {**read["view"], "layout": {"pos": {"n": {"x": 1, "y": 1}}}}
    r = client.put(f"/api/v1/views/{db}", json={"view": stale, "rev": read["rev"]}, headers=token)
    assert r.status_code == 409 and r.json()["error"]["code"] == "view_changed"
    assert ViewStore().get(db)["results"]["stackBy"] == "tag:Component"

    fresh = _ok(client.get(f"/api/v1/views/{db}", headers=token))
    assert fresh["rev"] != read["rev"]
    _ok(client.put(f"/api/v1/views/{db}", json={"view": {**fresh["view"], "layout": stale["layout"]}, "rev": fresh["rev"]},
                   headers=token))
    # A client that names no revision writes as it always did.
    _ok(client.put(f"/api/v1/views/{db}", json={"view": {"colors": {}}}, headers=token))


def test_an_undo_that_cannot_read_the_reports_changes_nothing(client, token, project):
    """The reports are restored first: when their store cannot be read, the view is not touched either, and the
    merge stays whole instead of half taken back."""
    from prism_lca.engine._store import prism_meta_dir

    db = _two_groups(client, token)
    _view(db, SAVED)
    _report(db, "tag:Bauteil", [])
    _merge_groups(client, token, db)
    view = ViewStore().get(db)
    path = prism_meta_dir() / ReportStore.FILENAME
    good = path.read_text(encoding="utf-8")
    path.write_text("{ not json", encoding="utf-8")

    r = client.post("/api/v1/model/undo", json={"database": db}, headers=token)
    assert r.status_code >= 400
    assert ViewStore().get(db) == view
    assert "Bauteil" not in [g["name"] for g in _ok(client.get(f"{GROUPS}?database={db}", headers=token))["groups"]]

    path.write_text(good, encoding="utf-8")
    _undo(client, token, db)
    assert ViewStore().get(db) == SAVED
