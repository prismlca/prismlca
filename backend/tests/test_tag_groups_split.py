"""The workspace-wide tag-group list of data format 1, split into one list per model where it is read
(engine/tag_groups_split.py).

What each model gets: the groups its processes and inputs carry, with the values they carry, in the old
order and colour; a carried value the list never held is appended. A group or value nobody in the model
carries stays behind — and so does one carried only by the leftover tags of a deleted process or a
removed input. Nothing is renamed, the tags are not touched, the old list is kept beside the new file, and
reading again changes nothing.
"""
from __future__ import annotations

import json

import pytest

from prism_lca.engine._store import prism_meta_dir
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.tag_groups import TagGroupStore
from prism_lca.engine.tag_groups_split import BACKUP_NAME
from prism_lca.engine.tags import TagStore

UID = "a" * 32  # an exchange uid as the app writes them
GONE_UID = "b" * 32  # one no exchange of the model has (any more)

#: The workspace list as data format 1 kept it: one list, every model's values in it.
OLD = [
    {"name": "Phase", "color": "#111111", "values": ["Production", "Use", "Unused value", "Ghost", "End-of-life"]},
    {"name": "Nobody's", "color": "#222222", "values": ["x"]},
    {"name": "Supplier", "color": "#333333", "values": ["Acme", "Leftover", "Beta"]},
    {"name": "Retired", "color": "#444444", "values": ["r1"]},
]

#: What the split makes of it for the workspace `_workspace` builds.
EXPECTED = {
    "A": [
        {"name": "Phase", "color": "#111111", "values": ["Production", "Use", "Recycling"]},
        {"name": "Supplier", "color": "#333333", "values": ["Beta"]},
    ],
    "B": [
        {"name": "Phase", "color": "#111111", "values": ["End-of-life"]},
        {"name": "Supplier", "color": "#333333", "values": ["Acme"]},
    ],
    "N": [{"name": "Phase", "color": "#111111", "values": ["Use"]}],
    "N/M": [{"name": "Phase", "color": "#111111", "values": ["Nested only"]}],
}


def _process(db: str, code: str):
    act = get_bd().Database(db).new_activity(code=code, name=code, unit="kilogram", type="process")
    act.save()
    return act


def _workspace() -> None:
    """Five models, a background, their tags — and the old list over whatever the setup wrote."""
    from prism_lca.engine.brightway_repository import BrightwayRepository

    bd = get_bd()
    repo = BrightwayRepository()
    for name in ("A", "B", "N", "N/M", "Untagged"):
        repo.create_foreground_database(name)
    bd.Database("bg").write({("bg", "steel"): {"name": "steel", "unit": "kg", "exchanges": []}})
    bd.databases["bg"]["prism_read_only"] = True
    bd.databases.flush()

    tags = TagStore()
    for code in ("a1", "a2", "a3"):
        _process("A", code)
    tags.add("A", "a1", "Phase", "Use")
    tags.add("A", "a1", "Supplier", "Beta")
    tags.add("A", "a2", "Phase", "Production")
    tags.add("A", "a3", "Phase", "Recycling")  # carried, never listed

    _process("B", "b1")
    b2 = _process("B", "b2")
    edge = b2.new_edge(input=bd.get_node(database="bg", code="steel"), amount=1.0, type="technosphere")
    edge["prism_uid"] = UID
    edge.save()
    tags.add("B", "b1", "Supplier", "Acme")
    tags.add("B", TagStore.exchange_code("b2", UID), "Phase", "End-of-life")  # an input's own tag
    # What a deleted process and a removed input leave behind: tags of nobody.
    tags.add("B", "gone", "Supplier", "Leftover")
    tags.add("B", "gone", "Retired", "r1")
    tags.add("B", TagStore.exchange_code("b2", GONE_UID), "Phase", "Ghost")

    # "N/M/x" starts with "N/", and is N/M's tag all the same.
    _process("N", "p")
    _process("N/M", "x")
    tags.add("N", "p", "Phase", "Use")
    tags.add("N/M", "x", "Phase", "Nested only")

    _write_old()


def _path():
    return prism_meta_dir() / TagGroupStore.FILENAME


def _write_old() -> None:
    _path().parent.mkdir(parents=True, exist_ok=True)
    _path().write_text(json.dumps(OLD, indent=1), encoding="utf-8")


def _stored() -> dict:
    return json.loads(_path().read_text(encoding="utf-8"))


@pytest.fixture
def workspace(project) -> None:
    del project
    _workspace()


def test_each_model_gets_what_it_carries_in_the_old_order_and_colour(workspace):
    tags_before = (prism_meta_dir() / TagStore.FILENAME).read_bytes()

    assert TagGroupStore().list_groups("A") == EXPECTED["A"]  # the first read converts
    assert _stored() == {"schema": 2, "models": EXPECTED}
    for name in ("B", "N", "N/M"):
        assert TagGroupStore().list_groups(name) == EXPECTED[name]
    assert TagGroupStore().list_groups("Untagged") == []
    assert TagGroupStore().list_groups("bg") == []

    assert (prism_meta_dir() / TagStore.FILENAME).read_bytes() == tags_before, "the tags were touched"
    assert json.loads((prism_meta_dir() / BACKUP_NAME).read_text(encoding="utf-8")) == OLD


def test_a_second_read_changes_nothing(workspace):
    store = TagGroupStore()
    store.list_groups("A")
    converted, backup = _path().read_bytes(), (prism_meta_dir() / BACKUP_NAME).read_bytes()
    for name in ("A", "B", "N", "N/M", "Untagged"):
        store.list_groups(name)
    assert _path().read_bytes() == converted
    assert (prism_meta_dir() / BACKUP_NAME).read_bytes() == backup


def test_the_old_shape_restored_over_a_converted_file_is_converted_again(workspace):
    """A backup from before the split, put back over a converted workspace: recognised by its shape."""
    store = TagGroupStore()
    store.list_groups("A")
    store.add_value("A", "Supplier", "Prepared later")  # gone with the restore, as everything after the backup
    _write_old()
    assert store.list_groups("B") == EXPECTED["B"]
    assert _stored() == {"schema": 2, "models": EXPECTED}
