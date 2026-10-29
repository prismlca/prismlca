"""Moving a process out of a model and into the library — the inverse of Localize.

The point is not the copy, it is the **link**: afterwards the model draws on the library dataset,
so a correction made once reaches this study and every other one. A plain copy would leave two
processes that drift apart, and that is the outcome these tests exist to prevent.
"""

from __future__ import annotations

import pytest

from prism_lca.engine import commands, model
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.commands import CommandBus
from prism_lca.engine.library import LIBRARY_DB
from prism_lca.errors import PrismError


@pytest.fixture
def bus():
    return CommandBus()


def _model_with_a_process(name: str = "my-model") -> tuple[str, str, str]:
    """A model whose top process consumes a hand-built sub-process. Returns (db, parent, child)."""
    bd = get_bd()
    bd.Database(name).register()
    from prism_lca.engine.guardrails import set_read_only

    set_read_only(name, False)
    db = bd.Database(name)
    child = db.new_activity(code="child", name="Widget forming", unit="kg", location="DE",
                            type="process")
    child["reference product"] = "formed widget"
    child.save()
    child.new_edge(input=child, amount=1.0, type="production").save()
    parent = db.new_activity(code="parent", name="Widget, packed", unit="kg", type="process")
    parent.save()
    parent.new_edge(input=parent, amount=1.0, type="production").save()
    parent.new_edge(input=child, amount=2.5, type="technosphere", comment="two and a half").save()
    return name, "parent", "child"


def test_the_model_ends_up_linked_to_the_library_copy(project, bus):
    db, parent_code, child_code = _model_with_a_process()

    result = bus.execute(commands.MoveToLibraryCommand(db, child_code))
    assert result["database"] == LIBRARY_DB and result["relinked"] == 1

    # The process is gone from the model…
    assert child_code not in {a["code"] for a in get_bd().Database(db)}
    # …and the parent's input now points into the library, with its amount and comment intact.
    parent = model.get_activity(db, parent_code)
    link = next(ex for ex in parent.exchanges() if ex.get("type") == "technosphere")
    assert link.input.key == (LIBRARY_DB, result["code"])
    assert link.get("amount") == 2.5 and link.get("comment") == "two and a half"

    # …and the library copy carries the process itself, production edge and all.
    moved = model.get_activity(LIBRARY_DB, result["code"])
    assert moved.get("name") == "Widget forming"
    assert any(ex.get("type") == "production" for ex in moved.exchanges())


def test_undo_puts_the_process_back_and_the_link_with_it(project, bus):
    db, parent_code, child_code = _model_with_a_process()
    result = bus.execute(commands.MoveToLibraryCommand(db, child_code))

    bus.undo()

    parent = model.get_activity(db, parent_code)
    link = next(ex for ex in parent.exchanges() if ex.get("type") == "technosphere")
    assert link.input.key == (db, child_code)  # pointing home again
    assert link.get("amount") == 2.5
    assert model.get_activity(db, child_code).get("name") == "Widget forming"
    # …and nothing of it is left in the library.
    assert result["code"] not in {a["code"] for a in get_bd().Database(LIBRARY_DB)}


def test_a_formula_stops_the_move_instead_of_freezing_it(project, bus):
    """An fx formula is driven by THIS model's parameters, and the library has none. Freezing it
    would turn a parameterised process into fixed numbers that no longer follow their driver —
    silently, which is the part that makes it unacceptable."""
    db, _, child_code = _model_with_a_process()
    child = model.get_activity(db, child_code)
    edge = next(ex for ex in child.exchanges())
    edge["formula"] = "mass * 2"
    edge.save()

    with pytest.raises(PrismError) as caught:
        bus.execute(commands.MoveToLibraryCommand(db, child_code))
    assert caught.value.code == "has_formulas"
    assert child_code in {a["code"] for a in get_bd().Database(db)}  # nothing moved


def test_a_library_dataset_cannot_be_moved_into_the_library(project, bus):
    from prism_lca.engine.library import ensure_library

    ensure_library()
    act = get_bd().Database(LIBRARY_DB).new_activity(code="already", name="Already here", unit="kg")
    act.save()
    with pytest.raises(PrismError) as caught:
        bus.execute(commands.MoveToLibraryCommand(LIBRARY_DB, "already"))
    assert caught.value.code == "already_in_library"
