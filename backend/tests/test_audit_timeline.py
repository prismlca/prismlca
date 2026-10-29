"""A name is the name at the time; only the log's own order says which model had it.

Phase 1 made attribution a **field**, which killed F3 (identity guessed out of the summary prose).
That leaves one hole, and it is the same mistake one level up: the field holds the model's name *at
the time*, Brightway keys models by name, and PrismLCA can rename one. A per-model history that
matched on the name alone would lose everything a model wrote before its rename — and, worse, hand
it to a
*new* model that later takes the freed name.

So the read side resolves against a timeline built from the lifecycle notes in the log itself
(`create_model`, `duplicate_model`, `import_bundle`, `rename_model`, `delete_model`). The test that
carries this file is `test_a_freed_name_does_not_inherit_the_previous_holders_history`: it fails in
both directions without the resolution — the renamed model loses its past, and the new namesake
inherits a past that is not its own.

Nothing here parses prose. The rename note keeps its sentence for the reader and carries
`previous_name` as a field for the resolver, and a rename written before that field existed leaves
the two names unlinked on purpose (see the test that pins that decision).
"""
from __future__ import annotations

import json
import uuid

from prism_lca.engine import audit_store, bundle


def _model(client, token, name) -> None:
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text


def _rename(client, token, old, new) -> None:
    r = client.post("/api/v1/databases/foreground/rename",
                    json={"database": old, "name": new}, headers=token)
    assert r.status_code == 200, r.text


def _delete(client, token, name) -> None:
    r = client.post("/api/v1/databases/foreground/delete", json={"database": name}, headers=token)
    assert r.status_code == 200, r.text


def _set_param(client, token, database, name, amount) -> None:
    r = client.post("/api/v1/params",
                    json={"database": database, "name": name, "amount": amount}, headers=token)
    assert r.status_code == 200, r.text


def _audit(client, token, **query) -> list[dict]:
    q = "&".join(f"{k}={v}" for k, v in query.items())
    r = client.get(f"/api/v1/model/audit{'?' + q if q else ''}", headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def _params(entries: list[dict]) -> set[str]:
    """The parameter names in these entries' prose — the shortest way to say *which* edits are here.

    Read out of `summary` on purpose: this is a test asserting where an entry landed, and the prose is
    the only thing that tells the two `set_parameter` lines apart. The product never does this.
    """
    return {e["summary"].split("'")[1] for e in entries if e["action"] == "set_parameter"}


def _one(entries: list[dict], action: str) -> dict:
    hits = [e for e in entries if e["action"] == action]
    assert len(hits) == 1, [e["summary"] for e in hits] or [e["action"] for e in entries]
    return hits[0]


# --------------------------------------------------------------------------- #
# Item 11 — the field on the note
# --------------------------------------------------------------------------- #
def test_the_rename_note_carries_the_previous_name_as_a_field_and_keeps_its_prose(
    client, token, project
):
    del project
    _model(client, token, "Before")
    _rename(client, token, "Before", "After")

    note = _one(_audit(client, token), "rename_model")
    assert note["database"] == "After"          # the name from here on (Phase 1's decision)
    assert note["previous_name"] == "Before"    # …and the one the resolver needs
    assert note["summary"] == "Rename model 'Before' → 'After'"  # unchanged: this is what a user reads
    assert "related" not in note, "`related` means 'came from another model', not 'used to be called'"


# --------------------------------------------------------------------------- #
# Item 12 — resolution over the timeline
# --------------------------------------------------------------------------- #
def test_a_renamed_model_keeps_what_it_wrote_under_its_old_name(client, token, project):
    """The plain case: append-only forbids rewriting the stored name (D3), so the read side has to
    know that `Old` and `New` are one model."""
    del project
    _model(client, token, "Old")
    _set_param(client, token, "Old", "before_rename", 1.0)
    _rename(client, token, "Old", "New")
    _set_param(client, token, "New", "after_rename", 2.0)

    stored = {e["database"] for e in audit_store.load() if e.get("action") == "set_parameter"}
    assert stored == {"Old", "New"}, f"the fixture did not produce two names: {stored}"

    assert _params(_audit(client, token, database="New")) == {"before_rename", "after_rename"}


def test_a_freed_name_does_not_inherit_the_previous_holders_history(client, token, project):
    """**The case that makes a name chain wrong.** Rename A → B, then create a *new* A.

    Now two entries say `database: "A"` and belong to different models. A chain of names ("A is now
    B") gives both to B, or both to A, depending on which way it walks — the F3 error one level up.
    Only the position in the log separates them.

    This fails in both directions without the resolution: `B` loses `wrote_as_a`, and `A` collects it.
    """
    del project
    _model(client, token, "A")
    _set_param(client, token, "A", "wrote_as_a", 1.0)
    _rename(client, token, "A", "B")
    _set_param(client, token, "B", "wrote_as_b", 2.0)
    _model(client, token, "A")  # a *different* model, same name
    _set_param(client, token, "A", "wrote_as_new_a", 3.0)

    # The fixture really did put the same name on two different models' entries.
    under_a = [e for e in audit_store.load()
               if e.get("database") == "A" and e.get("action") == "set_parameter"]
    assert _params(under_a) == {"wrote_as_a", "wrote_as_new_a"}, (
        f"the collision this test is about did not happen: {_params(under_a)}"
    )

    assert _params(_audit(client, token, database="B")) == {"wrote_as_a", "wrote_as_b"}
    assert _params(_audit(client, token, database="A")) == {"wrote_as_new_a"}


def test_delete_then_create_under_the_same_name_is_the_same_case(client, token, project):
    """The other half of the previous case, and the one that needs no rename at all.

    Two things close the first model's tenure independently, and that is deliberate: the delete note
    says it ended, and the *birth* of the namesake says it must have. Either alone keeps the second
    life clean, so a project whose delete predates the structured notes is still not misread.
    """
    del project
    _model(client, token, "Reused")
    _set_param(client, token, "Reused", "first_life", 1.0)
    _delete(client, token, "Reused")
    _model(client, token, "Reused")
    _set_param(client, token, "Reused", "second_life", 2.0)

    assert len([e for e in audit_store.load() if e.get("database") == "Reused"]) >= 5

    assert _params(_audit(client, token, database="Reused")) == {"second_life"}
    # And the first model's entries are still in the log — they are simply nobody's model view.
    everything = _audit(client, token)
    assert _params(everything) == {"first_life", "second_life"}
    first = [e for e in everything if _params([e]) == {"first_life"}]
    assert len(first) == 1 and first[0]["model_gone"] is True, "the dead model's line is unlabelled"


def test_a_rename_from_before_the_field_leaves_the_two_names_unlinked(client, token, project):
    """The decision, pinned: a rename note without `previous_name` is **not** parsed out of its prose.

    A model name is free text — it can contain quotes and arrows — so reading identity out of
    "Rename model 'A' → 'B'" is a guess, and guessing identity out of prose is the failure this whole
    mechanism replaces. The timeline therefore starts where the structured notes start. The cost
    is nil: such a note leaves the two names unlinked, which is exactly what Phase 1 answered, so
    nothing that used to be attributed stops being — only nothing new is gained.
    """
    del project
    _model(client, token, "Legacy")
    _set_param(client, token, "Legacy", "old_edit", 1.0)
    # A Phase-1-era rename note: the new name in the field, the old one only in the sentence.
    with audit_store.path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "index": audit_store.next_index(), "timestamp": "2026-08-24T09:00:00+00:00",
            "source": "user", "action": "rename_model", "database": "Modern",
            "summary": "Rename model 'Legacy' → 'Modern'", "undoable": False,
        }) + "\n")
    audit_store.reset_cache()
    note = _one(_audit(client, token), "rename_model")
    assert "previous_name" not in note, "the fixture is not the pre-field shape this test is about"
    assert "Legacy" in note["summary"], "…and its prose does name the old model, which is the bait"

    assert _params(_audit(client, token, database="Modern")) == set()
    assert _params(_audit(client, token, database="Legacy")) == {"old_edit"}


# --------------------------------------------------------------------------- #
# Item 13 — what the view is told
# --------------------------------------------------------------------------- #
def test_an_entry_whose_model_is_gone_says_so_instead_of_disappearing(client, token, project):
    """Append-only means the history outlives the model, and that is the point — so the project
    view has to be able to label it rather than drop it."""
    del project
    _model(client, token, "Doomed")
    _set_param(client, token, "Doomed", "p", 1.0)
    _model(client, token, "Alive")
    _set_param(client, token, "Alive", "q", 1.0)
    _delete(client, token, "Doomed")

    entries = _audit(client, token)
    gone = [e for e in entries if e.get("model_gone")]
    assert {e["database"] for e in gone} == {"Doomed"}
    assert len(gone) >= 3, [e["action"] for e in gone]  # create, set_parameter, delete
    assert all(not e.get("model_gone") for e in entries if e.get("database") == "Alive")


def test_an_entry_written_under_an_old_name_reports_the_name_it_has_now(client, token, project):
    """The stored name is never rewritten (D3); the read side says what it means today."""
    del project
    _model(client, token, "Werke")
    _set_param(client, token, "Werke", "p", 1.0)
    _rename(client, token, "Werke", "Works")

    entries = _audit(client, token, database="Works")
    old = [e for e in entries if e.get("database") == "Werke"]
    assert old, "the fixture wrote nothing under the old name"
    assert all(e["current_name"] == "Works" for e in old)
    assert all(not e.get("model_gone") for e in old), "renamed is not deleted"
    # Nothing redundant on the wire: the entries already carrying today's name say nothing extra.
    assert all("current_name" not in e for e in entries if e.get("database") == "Works")


def test_a_copied_models_history_points_at_the_model_it_came_from(client, token, project):
    """A duplicate starts with one line and looks like it came from nothing, while all of its
    substance came from somewhere. One line in its history answers the first question a reviewer
    asks."""
    del project
    _model(client, token, "Source")
    _set_param(client, token, "Source", "p", 1.0)
    r = client.post("/api/v1/databases/foreground/duplicate",
                    json={"source": "Source", "name": "Copy"}, headers=token)
    assert r.status_code == 200, r.text

    marked = [e for e in _audit(client, token, database="Copy") if e.get("copied_from")]
    assert len(marked) == 1, [e["summary"] for e in marked]
    assert marked[0]["copied_from"] == "Source"
    assert marked[0]["action"] == "duplicate_model"
    # Only ever in a model-scoped answer: in the project view every duplicate would raise its hand.
    assert not any(e.get("copied_from") for e in _audit(client, token))
    # …and not in the *source* model's view either, which did not come from anywhere.
    assert not any(e.get("copied_from") for e in _audit(client, token, database="Source"))


def test_an_imported_model_is_not_sent_to_a_history_this_project_never_had(client, token, project):
    """`related` is not always somebody else, and not always local.

    A bundle import records the name the model had in the **sender's** project. Arriving in a fresh
    project, that name is free, so the import lands under it — and the provenance would then point at
    the model's own first line, promising a history that is the one already on screen. "See its
    history" has to mean another model's history or it means nothing. The entry still says
    ``from Sender``, which is all the log can honestly claim.
    """
    del project
    _model(client, token, "Sender")
    _set_param(client, token, "Sender", "p", 1.0)
    r = client.post("/api/v1/bundle/export", json={"database": "Sender", "preset": "full"},
                    headers=token)
    assert r.status_code == 200, r.text
    content = r.json()["base64"]

    fresh = "recipient-" + uuid.uuid4().hex[:8]
    assert client.post("/api/v1/projects", json={"name": fresh},
                       headers=token).status_code == 200
    r = client.post("/api/v1/bundle/import", json={"content": content}, headers=token)
    assert r.status_code == 200, r.text
    landed = r.json()["database"]

    entries = _audit(client, token, database=landed)
    imported = _one(entries, "import_bundle")
    assert imported["related"] == "Sender", "the fixture recorded no foreign provenance at all"
    assert landed == "Sender", "the name was not free, so this is not the case under test"
    assert not any(e.get("copied_from") for e in entries)

    # A second import *does* meet a local model of that name, and pointing at it is right.
    r = client.post("/api/v1/bundle/import", json={"content": content}, headers=token)
    assert r.status_code == 200, r.text
    second = r.json()["database"]
    assert second != landed, "no collision, so the derivation is not being exercised"
    marked = [e for e in _audit(client, token, database=second) if e.get("copied_from")]
    assert [e["copied_from"] for e in marked] == ["Sender"]


def test_the_provenance_line_survives_the_limit_that_would_drop_it(client, token, project):
    """It is the oldest entry a copied model has, so the newest-first budget would cut it first — and
    it would go missing for exactly the models with enough history to make the question worth
    asking."""
    del project
    _model(client, token, "Origin")
    r = client.post("/api/v1/databases/foreground/duplicate",
                    json={"source": "Origin", "name": "Descendant"}, headers=token)
    assert r.status_code == 200, r.text
    for i in range(6):
        _set_param(client, token, "Descendant", f"p{i}", float(i))

    full = _audit(client, token, database="Descendant")
    assert len(full) > 3, len(full)
    assert full[0].get("copied_from") == "Origin", "the line to be pinned is not the oldest one"

    kept = _audit(client, token, database="Descendant", limit=3)
    assert len(kept) == 3
    assert kept[0].get("copied_from") == "Origin"
    assert [e["index"] for e in kept] == sorted(e["index"] for e in kept)  # still chronological
    assert kept[-1]["index"] == full[-1]["index"]  # and still newest-first for the rest


def test_the_three_resolved_fields_are_never_written_to_the_log(client, token, project):
    """They are answers, not records. A stored `current_name` would be the log rewriting itself one
    field at a time, which is the thing D3 forbids."""
    del project
    _model(client, token, "Kept")
    _set_param(client, token, "Kept", "p", 1.0)
    _rename(client, token, "Kept", "Renamed")
    _delete(client, token, "Renamed")
    r = client.post("/api/v1/databases/foreground/duplicate",
                    json={"source": "Kept", "name": "Nope"}, headers=token)
    assert r.status_code in (200, 400, 404, 409)  # the source is gone; either answer is fine here

    served = _audit(client, token)
    assert any(e.get("model_gone") or e.get("current_name") for e in served), (
        "nothing was resolved, so this test would pass on an empty log"
    )
    stored = audit_store.path().read_text(encoding="utf-8")
    for computed in ("current_name", "model_gone", "copied_from"):
        assert computed not in stored, f"{computed} was written to the log"
    assert "previous_name" in stored, "…while the field that *is* stored must be there"


# --------------------------------------------------------------------------- #
# The other two readers of the predicate
# --------------------------------------------------------------------------- #
def test_the_bundle_exports_the_history_across_a_rename(client, token, project):
    """One predicate, three readers — F3 happened because the export had a filter of its own. The
    bundle passes no timeline, so it gets the cached one, and a renamed model's export is complete
    without `bundle.py` knowing that renames exist."""
    del project
    _model(client, token, "Ausgangslage")
    _set_param(client, token, "Ausgangslage", "before", 1.0)
    _rename(client, token, "Ausgangslage", "Starting point")
    _set_param(client, token, "Starting point", "after", 2.0)

    exported = bundle.write_audit("Starting point")["audit"]
    assert _params(exported) == {"before", "after"}
    assert {e.get("database") for e in exported} == {"Ausgangslage", "Starting point"}, (
        "the export carries the stored names, untouched — resolution happens on read, not on write"
    )


def test_the_timeline_is_not_rebuilt_while_the_log_stands_still(client, token, project, monkeypatch):
    """`Parameters` and `Scenarios` fetch this on every navigation and the log grows for ever.
    Append-only makes the cached line count a complete invalidation test, so a read that follows a
    read reads no file at all."""
    del project
    _model(client, token, "Cheap")
    _set_param(client, token, "Cheap", "p", 1.0)
    assert bundle.write_audit("Cheap")["audit"], "nothing to export, so nothing is being measured"

    reads = {"n": 0}
    real = audit_store.load

    def counted() -> list[dict]:
        reads["n"] += 1
        return real()

    monkeypatch.setattr(audit_store, "load", counted)
    audit_store.reset_cache()        # a cold process, so the first call has to do the work
    audit_store.lifecycle()
    assert reads["n"] == 1, reads["n"]
    for _ in range(20):
        audit_store.lifecycle()
    assert reads["n"] == 1, "the timeline was rebuilt although nothing was appended"
    _set_param(client, token, "Cheap", "q", 2.0)
    audit_store.lifecycle()
    assert reads["n"] == 2, "a new line did not invalidate the timeline"
