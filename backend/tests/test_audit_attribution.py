"""Attribution is a field that is written, not a name read out of the prose.

The failure this replaces is measurable and was shipped: `bundle.write_audit()` searched the
`summary` text for `'<model>'` and found 1 to 9 entries per model out of hundreds of real edits,
while looking like a successful complete export. The same search in the model view would file
`Set parameter 'tube_mass' = 0.4` under whichever model happened to share a word with it.

So: the entry carries `database` (what changed), `related` (where it came from) and, for
the two genuinely project-wide commands with model-wide consequences, `databases`. Nothing
here infers anything, and the tests that matter most are the ones proving the *absence* of
inference: an old line stays unattributed, and a model whose name appears in someone else's summary
does not collect it.
"""
from __future__ import annotations

import json
import uuid

from prism_lca.engine import audit_store, bundle


def _model(client, token, name) -> None:
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text


def _set_param(client, token, database, name, amount) -> None:
    r = client.post(
        "/api/v1/params", json={"database": database, "name": name, "amount": amount}, headers=token
    )
    assert r.status_code == 200, r.text


def _activity(client, token, database, name) -> str:
    r = client.post(
        "/api/v1/model/activities",
        json={"database": database, "name": name, "unit": "kg"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def _audit(client, token, **query) -> list[dict]:
    q = "&".join(f"{k}={v}" for k, v in query.items())
    r = client.get(f"/api/v1/model/audit{'?' + q if q else ''}", headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def _last(entries: list[dict], action: str) -> dict:
    hits = [e for e in entries if e["action"] == action]
    assert hits, f"no {action!r} entry among {[e['action'] for e in entries]}"
    return hits[-1]


# --------------------------------------------------------------------------- #
# The field on the way in
# --------------------------------------------------------------------------- #
def test_a_command_files_its_entry_under_the_model_it_changed(client, token, project):
    del project
    _model(client, token, "Alpha")
    _set_param(client, token, "Alpha", "mass", 2.0)
    entry = _last(_audit(client, token), "set_parameter")
    assert entry["database"] == "Alpha"
    assert entry["summary"] == "Set parameter 'mass' = 2 (new)"  # the prose does NOT name the model
    assert "related" not in entry and "databases" not in entry  # absent, not null


def test_the_model_lifecycle_notes_name_their_model(client, token, project):
    """The six `note()` callers are hand-wired; no tripwire can see them, so they get their own
    assertion. Creating a tag group stays unattributed on purpose — it changes no model."""
    del project
    _model(client, token, "Life")
    r = client.post(
        "/api/v1/databases/foreground/duplicate", json={"source": "Life", "name": "Copy"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/databases/foreground/rename", json={"database": "Copy", "name": "Renamed"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/model/tag-groups", json={"name": "Stage", "color": "#123456"},
                    headers=token)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/databases/foreground/delete", json={"database": "Renamed"},
                    headers=token)
    assert r.status_code == 200, r.text

    entries = _audit(client, token)
    assert _last(entries, "create_model")["database"] == "Life"
    # A duplicate starts with one line and looks like it came from nothing.
    duplicate = _last(entries, "duplicate_model")
    assert (duplicate["database"], duplicate["related"]) == ("Copy", "Life")
    # The NEW name — append-only means the line belongs to the model as it is called from here on.
    assert _last(entries, "rename_model")["database"] == "Renamed"
    assert _last(entries, "delete_model")["database"] == "Renamed"
    assert "database" not in _last(entries, "create_tag_group")  # project-wide


def test_a_cross_model_copy_is_a_change_in_one_and_provenance_in_the_other(client, token, project):
    """And the case that settles whose history owns it: the undo of this belongs to neither model alone."""
    del project
    _model(client, token, "Src")
    _model(client, token, "Dst")
    code = _activity(client, token, "Src", "widget")
    r = client.post(
        "/api/v1/model/activities/copy",
        json={"source_database": "Src", "source_code": code, "target_database": "Dst"},
        headers=token,
    )
    assert r.status_code == 200, r.text

    entry = _last(_audit(client, token), "copy_to_foreground")
    assert (entry["database"], entry["related"]) == ("Dst", "Src")
    # It shows up in both lists, and for opposite reasons.
    assert any(e["action"] == "copy_to_foreground" for e in _audit(client, token, database="Dst"))
    assert any(e["action"] == "copy_to_foreground" for e in _audit(client, token, database="Src"))


def test_deleting_a_tag_group_names_every_model_it_stripped(client, token, project):
    """The one case where a list is right: the group is project-wide, its cascade is not.
    `database: None` would be formally correct and practically a lie — the models changed, and their
    own history would say nothing about it."""
    del project
    _model(client, token, "One")
    _model(client, token, "Two")
    _model(client, token, "Three")
    a = _activity(client, token, "One", "a")
    b = _activity(client, token, "Two", "b")
    assert client.post("/api/v1/model/tag-groups", json={"name": "Stage", "color": "#123456"},
                       headers=token).status_code == 200
    for db, code in (("One", a), ("Two", b)):
        r = client.post(
            "/api/v1/model/tags/set",
            json={"keys": [{"database": db, "code": code}], "group": "Stage", "value": "use"},
            headers=token,
        )
        assert r.status_code == 200, r.text

    r = client.post("/api/v1/model/tag-groups/delete", json={"name": "Stage"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["untagged"] == 2, "nothing was untagged, so there is nothing to attribute"

    entry = _last(_audit(client, token), "delete_tag_group")
    assert entry["databases"] == ["One", "Two"]  # not Three: it carried no assignment
    assert "database" not in entry  # the action itself belongs to no single model
    # It reaches the affected models' views and no others.
    assert any(e["action"] == "delete_tag_group" for e in _audit(client, token, database="One"))
    assert not any(e["action"] == "delete_tag_group" for e in _audit(client, token, database="Three"))


def test_a_tag_across_two_models_is_attributed_to_neither(client, token, project):
    """A selection can cross models, and one of the two would be a smaller version of the same lie."""
    del project
    _model(client, token, "Left")
    _model(client, token, "Right")
    left = _activity(client, token, "Left", "l")
    right = _activity(client, token, "Right", "r")
    assert client.post("/api/v1/model/tag-groups", json={"name": "G", "color": "#123456"},
                       headers=token).status_code == 200
    r = client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": "Left", "code": left},
                       {"database": "Right", "code": right}], "group": "G", "value": "v"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert "database" not in _last(_audit(client, token), "set_tag")

    # …while a selection inside one model is attributed to it.
    r = client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": "Left", "code": left}], "group": "G", "value": "w"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert _last(_audit(client, token), "set_tag")["database"] == "Left"


def test_a_scenario_value_is_attributed_through_the_store(client, token, project):
    """The command knows a scenario id and nothing else; the scenario knows its model."""
    del project
    _model(client, token, "Sc")
    _set_param(client, token, "Sc", "p", 1.0)
    r = client.post("/api/v1/scenarios", json={"database": "Sc", "name": "Warm"}, headers=token)
    assert r.status_code == 200, r.text
    sid = r.json()["scenario"]["id"]
    r = client.post("/api/v1/scenarios/value",
                    json={"id": sid, "param": "p", "value": 3.0}, headers=token)
    assert r.status_code == 200, r.text
    assert _last(_audit(client, token), "set_scenario_value")["database"] == "Sc"


def test_an_undo_is_filed_under_the_model_it_moved(client, token, project):
    """When a reported number moves, the log has to be able to say that an undo moved it — in
    the list of the model whose number it was."""
    del project
    _model(client, token, "U")
    _set_param(client, token, "U", "p", 1.0)
    _set_param(client, token, "U", "p", 2.0)
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert _last(_audit(client, token), "undo")["database"] == "U"
    assert client.post("/api/v1/model/redo", headers=token).status_code == 200
    assert _last(_audit(client, token), "redo")["database"] == "U"


# --------------------------------------------------------------------------- #
# The filter on the way out
# --------------------------------------------------------------------------- #
def test_the_model_filter_is_a_query_parameter_and_only_a_query_parameter(client, token, project):
    """This is the mistake worth a test of its own: sent in the body, the route reads its default and
    answers with everything — which looks exactly like a broken filter and is not one."""
    del project
    _model(client, token, "Q")
    _model(client, token, "Other")
    _set_param(client, token, "Q", "p", 1.0)
    _set_param(client, token, "Other", "p", 1.0)

    as_query = client.get("/api/v1/model/audit?database=Q", headers=token).json()
    assert [e["action"] for e in as_query if e.get("database") == "Other"] == []
    assert any(e.get("database") == "Q" for e in as_query)

    as_body = client.request("GET", "/api/v1/model/audit", json={"database": "Q"}, headers=token)
    assert as_body.status_code == 200
    assert any(e.get("database") == "Other" for e in as_body.json()), (
        "a filter in the body was honoured — then this test can no longer tell the two apart"
    )


def test_the_source_filter_narrows_to_one_author(client, token, project):
    del project
    _model(client, token, "S")
    r = client.post("/api/v1/params", json={"database": "S", "name": "p", "amount": 1.0,
                                            "source": "ai"}, headers=token)
    assert r.status_code == 200, r.text
    both = {e["source"] for e in _audit(client, token)}
    assert {"user", "ai"} <= both, both
    assert {e["source"] for e in _audit(client, token, source="ai")} == {"ai"}


def test_the_limit_keeps_the_newest_and_the_models_own_history_first(client, token, project):
    del project
    _model(client, token, "L")
    for i in range(6):
        _set_param(client, token, "L", f"p{i}", float(i))
    all_entries = _audit(client, token)
    assert len(all_entries) > 4, len(all_entries)

    kept = _audit(client, token, database="L", limit=3)
    assert len(kept) == 3
    assert [e["index"] for e in kept] == sorted(e["index"] for e in kept)  # still chronological
    assert kept[-1]["index"] == all_entries[-1]["index"]  # the newest is kept
    assert all(e.get("database") == "L" for e in kept), "the budget went to unattributed lines"

    # `limit=0` means no limit. It has to be said, because `out[-0:]` is the whole list either way,
    # and a caller who asked for nothing and silently got everything is the wrong way round.
    assert len(_audit(client, token, database="L", limit=0)) == len(all_entries)


def test_old_entries_stay_readable_and_stay_unattributed(client, token, project):
    """The 1268 lines already on disk have none of the three fields, and are not to be backfilled by
    matching names in their text — that is F3 one level up. They are returned so the view can show
    them as their own block, and they are not claimed by any model."""
    del project
    _model(client, token, "New")
    _set_param(client, token, "New", "p", 1.0)
    # Exactly the old shape, and its summary names 'New' — the substring search would take it. At the
    # START of the file, where such lines really are: they predate the field.
    log = audit_store.path()
    ancient_line = json.dumps({"index": 0, "timestamp": "2026-01-01T00:00:00+00:00",
                               "source": "user", "action": "ancient",
                               "summary": "Set parameter 'x' = 1 in 'New'", "undoable": True})
    log.write_text(ancient_line + "\n" + log.read_text(encoding="utf-8"), encoding="utf-8")
    audit_store.reset_cache()

    entries = _audit(client, token, database="New")
    ancient = _last(entries, "ancient")
    assert "database" not in ancient and "related" not in ancient
    assert not audit_store.is_attributed(ancient), "the old line was claimed by a model"
    assert any(e.get("database") == "New" for e in entries), "the attributed half went missing"


def test_a_future_field_still_does_not_break_reading(client, token, project):
    """Unchanged property, re-asserted because the entry model grew three fields: `audit()` must keep
    tolerating a line from a later version."""
    del project
    _model(client, token, "F")
    with audit_store.path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"index": 800, "timestamp": "2026-09-01T00:00:00+00:00",
                             "source": "user", "action": "future", "summary": "later",
                             "undoable": True, "database": "F", "batch": "abc"}) + "\n")
    audit_store.reset_cache()
    entries = _audit(client, token, database="F")
    assert _last(entries, "future")["database"] == "F"


def test_the_support_bundle_still_gets_the_whole_project_log(client, token, project):
    """The support bundle needs everything, unfiltered — that is what it is for."""
    del project
    _model(client, token, "A")
    _model(client, token, "B")
    _set_param(client, token, "A", "p", 1.0)
    _set_param(client, token, "B", "p", 1.0)
    r = client.get("/api/v1/system/support-bundle", headers=token)
    assert r.status_code == 200
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        entries = json.loads(zf.read("audit.json"))
    assert {e.get("database") for e in entries} >= {"A", "B"}


# --------------------------------------------------------------------------- #
# The bundle
# --------------------------------------------------------------------------- #
def test_the_bundle_exports_the_history_on_the_field_not_on_the_text(client, token, project):
    """F3, from the other side: the old substring search found 1 of 11 entries for one of the real
    models. The name in a *different* model's summary must not be collected either."""
    del project
    _model(client, token, "Shampoo")
    _model(client, token, "Other")
    for i in range(5):
        _set_param(client, token, "Shampoo", f"p{i}", float(i))
    # A line that mentions the model by name but belongs to another one — the substring search's bait.
    r = client.post(
        "/api/v1/model/activities",
        json={"database": "Other", "name": "packaging for 'Shampoo'", "unit": "kg"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert "'Shampoo'" in _last(_audit(client, token), "create_activity")["summary"], (
        "the bait line does not mention the model, so this test cannot tell the two filters apart"
    )

    exported = bundle.write_audit("Shampoo")["audit"]
    assert len(exported) >= 5, len(exported)
    assert all(e.get("database") == "Shampoo" for e in exported)
    assert not any(e["action"] == "create_activity" for e in exported)


def test_a_bundle_import_is_filed_under_the_name_it_landed_under(client, token, project):
    """The class a field-based design misses: a bundle import's model name does not exist until the
    command has run (`free_model_name` resolves collisions), so it cannot be a constructor field and
    the bus has to ask *after* execute. Landing it under the requested name would be wrong the moment
    two imports of the same bundle meet.
    """
    del project
    source = "Bundle Src"
    r = client.post("/api/v1/databases/foreground", json={"name": source}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/model/activities",
        json={"database": source, "name": "bottle", "unit": "kilogram"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/bundle/export", json={"database": source, "preset": "full"},
                    headers=token)
    assert r.status_code == 200, r.text
    content = r.json()["base64"]

    first = client.post("/api/v1/bundle/import", json={"content": content}, headers=token)
    assert first.status_code == 200, first.text
    second = client.post("/api/v1/bundle/import", json={"content": content}, headers=token)
    assert second.status_code == 200, second.text
    landed = second.json()["database"]
    assert landed != source, "no collision happened, so the derivation is not being exercised"

    entries = [e for e in _audit(client, token) if e["action"] == "import_bundle"]
    assert len(entries) == 2, [e["summary"] for e in entries]
    assert entries[-1]["database"] == landed        # where it actually is
    assert entries[-1]["related"] == source         # what it was called where it came from


def test_imported_history_is_filed_under_the_model_it_landed_in(client, token, project):
    """Appended as notes, never replayed — and given the field of the model being imported,
    because that is the list whose reader wants them."""
    del project
    target = "Imported-" + uuid.uuid4().hex[:6]
    _model(client, token, target)
    bundle.read_audit(target, {"audit": [
        {"timestamp": "2026-02-02T00:00:00+00:00", "summary": "Set parameter 'x' = 1"},
    ]})
    audit_store.reset_cache()
    entry = _last(_audit(client, token), "imported_history")
    assert entry["database"] == target
    assert entry["source"] == "import" and entry["undoable"] is False
    assert entry["summary"].startswith("[from the bundle]")
    assert any(e["action"] == "imported_history" for e in _audit(client, token, database=target))


def test_a_workspace_wide_action_is_not_a_models_earlier_history(client, token, project):
    """A tag group or tag value names no model because it changes none — not because it predates the
    field. Shown in a model's "earlier history" block, 106 of them read as that model's past under a
    label saying they were written before entries named their model. They stand in
    every model's list instead, in their place in time, marked `workspace`."""
    del project
    _model(client, token, "W")
    _set_param(client, token, "W", "p", 1.0)
    r = client.post("/api/v1/model/tag-groups", json={"name": "Phase"}, headers=token)
    assert r.status_code == 200, r.text
    whole = _audit(client, token)
    assert any("Phase" in e["summary"] and not audit_store.is_attributed(e) for e in whole), (
        "the tag action is meant to stay unattributed — and visible in the whole-project log"
    )
    mine = _audit(client, token, database="W")
    phase = [e for e in mine if "Phase" in e["summary"]]
    assert len(phase) == 1 and phase[0].get("workspace") is True, "the workspace action is missing or unmarked"
    assert mine.index(phase[0]) > max(i for i, e in enumerate(mine) if e.get("database") == "W"), (
        "it is not in its place in time"
    )
    # The marker is computed on read and never written to the file.
    assert "workspace" not in audit_store.path().read_text(encoding="utf-8")
