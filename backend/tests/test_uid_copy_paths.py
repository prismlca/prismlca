"""Inventory of every place that gives an exchange a fresh uid or copies exchanges.

An input's own tag (life-cycle phase) is stored under its exchange uid. A path that copies an exchange and
gives the copy a new uid loses the tag unless it carries it over — and the breakdown by phase then changes
without a word. This test cannot prove that a path carries tags (the tests of each operation do that); it
makes sure no new such path appears without someone deciding what happens to the tags there. A new call
site fails here until it is entered below with that decision.
"""
from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "prism_lca"
WATCHED = ("new_uid", "_copy_exchanges", "ensure_exchange_uids")

#: (file, enclosing function, call) → what happens to input tags there.
ALLOWED: dict[tuple[str, str, str], str] = {
    # --- a new exchange, not a copy: nothing to carry
    ("engine/commands.py", "AddExchangeCommand.__init__", "new_uid"): "new input; tags come with the call",
    ("engine/model.py", "create_activity", "new_uid"): "the production exchange of a new process",
    ("engine/model.py", "set_reference_quantity", "new_uid"): "reference-quantity exchanges, never tagged",
    ("engine/commands.py", "CreateActivityCommand.__init__", "new_uid"): "an activity code, not an exchange",
    # --- copies: each carries (or deliberately drops) tags, tested in test_exchange_tags.py
    ("engine/commands.py", "_copy_exchanges", "new_uid"): "returns (old uid, new uid) pairs for the caller",
    ("engine/commands.py", "DuplicateActivityCommand.__init__", "new_uid"): "activity code",
    ("engine/commands.py", "DuplicateActivityCommand.execute", "_copy_exchanges"): "tags copied (copy_process_tags)",
    ("engine/commands.py", "CopyToForegroundCommand.__init__", "new_uid"): "activity code",
    ("engine/commands.py", "CopyToForegroundCommand.execute", "_copy_exchanges"):
        "from a model: tags copied; relinked inputs fold their common tags into the copy",
    ("engine/commands.py", "LocalizePathCommand.__init__", "new_uid"): "activity codes",
    ("engine/commands.py", "LocalizePathCommand._copy", "_copy_exchanges"): "background datasets carry no tags",
    ("engine/commands.py", "MoveToLibraryCommand.__init__", "new_uid"): "activity code",
    ("engine/commands.py", "MoveToLibraryCommand.execute", "_copy_exchanges"):
        "the library carries no tags; the process's tags move onto the consuming inputs",
    ("engine/brightway_repository.py", "BrightwayRepository.duplicate_foreground_database", "new_uid"):
        "activity codes and exchange uids; input tags re-keyed under the new uids",
    ("engine/commands.py", "ImportModelCommand.execute", "new_uid"): "sheet import; the tags column is written",
    ("engine/bundle_tags.py", "apply_row_tags", "new_uid"): "bundle import; the row's tags are written",
    ("engine/bundle.py", "_write_graph_rows", "new_uid"): "bundle import; one uid per row, kept by the command for redo",
    ("engine/bundle.py", "_write_graph_rows", "ensure_exchange_uids"): "untagged rows of a bundle",
    ("engine/bundle.py", "read_library", "ensure_exchange_uids"): "library datasets carry no tags",
    ("engine/dataimport/session.py", "_commit", "new_uid"): "importer edges into the library, never tagged",
    ("engine/dataimport/session.py", "_commit", "ensure_exchange_uids"): "importer edges, never tagged",
    ("engine/model.py", "ensure_exchange_uids", "new_uid"): "backfill of exchanges that had no uid (no tag possible)",
    ("engine/hygiene.py", "backfill_exchange_uids", "ensure_exchange_uids"): "backfill, as above",
    # --- uids of other things
    ("engine/model_folders.py", "create", "new_uid"): "a folder id",
    ("engine/parameter_groups.py", "copy", "new_uid"): "a parameter-group id",
    ("engine/parameter_groups.py", "create", "new_uid"): "a parameter-group id",
    ("engine/scenarios.py", "ScenarioStore._migrate", "new_uid"): "a scenario id",
    ("engine/scenarios.py", "ScenarioStore.copy", "new_uid"): "a scenario id",
    ("engine/scenarios.py", "ScenarioStore.create", "new_uid"): "a scenario id",
    ("engine/scenarios.py", "ScenarioStore.duplicate", "new_uid"): "a scenario id",
    ("engine/scenarios.py", "ScenarioStore.import_columns", "new_uid"): "a scenario id",
}


def _call_sites() -> set[tuple[str, str, str]]:
    found: set[tuple[str, str, str]] = set()
    for path in SRC.rglob("*.py"):
        rel = str(path.relative_to(SRC)).replace("\\", "/")

        def visit(node, owner: str, rel: str = rel) -> None:
            for child in ast.iter_child_nodes(node):
                name = owner
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    name = f"{owner}.{child.name}" if owner else child.name
                if isinstance(child, ast.Call):
                    f = child.func
                    fn = f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else None)
                    if fn in WATCHED:
                        found.add((rel, owner or "<module>", fn))
                visit(child, name, rel)

        visit(ast.parse(path.read_text(encoding="utf-8")), "")
    return found


def test_every_place_that_gives_out_uids_has_decided_about_input_tags():
    found = _call_sites()
    assert found, "the walk found nothing — the path to the sources is wrong"
    new = sorted(found - set(ALLOWED))
    assert not new, (
        "New place(s) giving an exchange a fresh uid or copying exchanges: "
        f"{new}. An input's tag is keyed by its uid — decide whether the copy keeps it (and test that), then "
        "enter the place in ALLOWED with that decision."
    )
    gone = sorted(set(ALLOWED) - found)
    assert not gone, f"Entries for places that no longer exist — remove them: {gone}"
