"""Every Command says which model it changes — or is named here as project-wide.

A tripwire, in the manner of the `lca.`-call scan in `test_params_threadpool.py` and the tool-count
cap in `tools.test.ts`. The thing it guards cannot be seen in review: a new command that declares no
attribution still works, still writes its audit line, and that line simply never appears in its
model's history. Nobody notices until someone asks "who changed this number?" and the answer is
missing — which is the state 1107 of 1268 lines in the development log are already in, and the whole
reason for D1.

So the rule is not "attribute your command" (a wish) but "decide, in one of three ways":

1. ``audit_attr = "<field>"`` — the model is in that instance attribute (32 of 38 classes);
2. override ``audit_database()`` — the model has to be derived (6 classes);
3. stand on :data:`PROJECT_SCOPE` below — the command genuinely belongs to no single model.

There is no fourth way, and no default that quietly means "none".
"""
from __future__ import annotations

import ast
import inspect
import pathlib

from prism_lca.engine import commands
from prism_lca.engine.commands import Command

#: Commands whose changes belong to no single model. Both of these are project-wide *and* have
#: consequences inside models (they strip tag assignments everywhere), which is why they answer
#: `audit_databases()` with the list of models they actually reached into. A command that
#: is project-wide with no model consequence at all would stand here answering nothing.
PROJECT_SCOPE = {
    "DeleteTagGroupCommand",
    "RemoveTagValueCommand",
    # Merges are project-wide the same way (V385): the vocabulary belongs to the project,
    # the retagging reaches into models, and `audit_databases()` names the ones it touched.
    "MergeTagValueCommand",
    "MergeTagGroupCommand",
}

SOURCE = pathlib.Path(commands.__file__)


def _concrete() -> list[type[Command]]:
    """Every concrete Command subclass in the module, found the way a new one arrives: by being
    there. Not a hand-kept list — a hand-kept list is the thing that goes stale."""
    return [
        obj
        for _name, obj in vars(commands).items()
        if inspect.isclass(obj)
        and issubclass(obj, Command)
        and obj is not Command
        and not inspect.isabstract(obj)
    ]


def test_the_test_is_looking_at_the_real_classes():
    """If the discovery breaks, every assertion below passes over an empty list."""
    names = {c.__name__ for c in _concrete()}
    assert len(names) >= 35, names
    for expected in ("SetParameterCommand", "ImportBundleCommand", "DeleteTagGroupCommand"):
        assert expected in names


def test_every_command_declares_an_attribution_or_is_named_project_wide():
    undecided = [
        c.__name__
        for c in _concrete()
        if "audit_attr" not in c.__dict__
        and "audit_database" not in c.__dict__
        and c.__name__ not in PROJECT_SCOPE
    ]
    assert not undecided, (
        f"{undecided} write audit entries that name no model. Set `audit_attr` to the field holding "
        "the model, override `audit_database()` if it has to be derived, or — only if the command "
        "really belongs to no single model — add it to PROJECT_SCOPE in this test and give it "
        "`audit_databases()` if it changes anything inside models."
    )


def test_no_command_is_both_declared_and_listed_as_project_wide():
    """The two answers contradict each other, and the list is the one that would be ignored."""
    both = [c.__name__ for c in _concrete()
            if c.__name__ in PROJECT_SCOPE
            and ("audit_attr" in c.__dict__ or "audit_database" in c.__dict__)]
    assert not both, both


def test_the_project_scope_list_holds_no_ghosts():
    """A renamed or deleted command must not leave a permanent exemption behind."""
    names = {c.__name__ for c in _concrete()}
    assert PROJECT_SCOPE <= names, PROJECT_SCOPE - names


def test_every_declared_audit_attr_is_an_attribute_the_class_actually_sets():
    """A typo in `audit_attr` is silent: `getattr` misses, the entry gets no model, and the class
    looks decided. So the name is checked against the assignments in the class body."""
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
    bodies = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
    checked = 0
    for cls in _concrete():
        attr = cls.__dict__.get("audit_attr")
        if not attr:
            continue
        node = bodies[cls.__name__]
        assigned = {
            n.attr
            for n in ast.walk(node)
            if isinstance(n, ast.Attribute)
            and isinstance(n.value, ast.Name)
            and n.value.id == "self"
            and isinstance(n.ctx, ast.Store)
        }
        assert attr in assigned, f"{cls.__name__}.audit_attr = {attr!r}, which it never assigns"
        checked += 1
    assert checked >= 31, f"only {checked} classes were checked — the scan found nothing"


def test_the_project_wide_commands_report_the_models_they_reached_into():
    """Half of the deal: being project-wide does not mean being silent about the models whose
    tags were stripped."""
    for name in PROJECT_SCOPE:
        cls = getattr(commands, name)
        assert "audit_databases" in cls.__dict__, f"{name} is project-wide and says nothing at all"


def test_the_counts_are_what_the_concept_says_they_are():
    """Measured, not quoted. The original design estimate was that 30 of 35 carry the model in a field and
    four derive it; both numbers are wrong, and this test is where the real ones live. They move
    when a command is added — `SetParametersCommand` (V228) and `SetReferenceQuantityCommand` (V233)
    took the field count from 29 to 31; `LinkModelsCommand` (comparison models) took it to 33 by field
    and 38 to 39 overall.

    The one the estimate missed is `ImportBundleCommand`: its model name does not exist until
    `execute()` has run, because `free_model_name()` resolves collisions, so it cannot be a field on
    the constructor and has to be a method. That is also why the bus asks *after* execute.
    """
    by_field = [c.__name__ for c in _concrete() if "audit_attr" in c.__dict__]
    derived = [c.__name__ for c in _concrete() if "audit_database" in c.__dict__]
    project_wide = [c.__name__ for c in _concrete() if c.__name__ in PROJECT_SCOPE]

    assert len(by_field) == 33, sorted(by_field)
    assert sorted(derived) == [
        "ImportBundleCommand",
        "SetScenarioValueCommand",
        "SetTagCommand",
        "TagActivitiesCommand",
    ], sorted(derived)
    # The two merge commands (V385) took the project-wide list from 2 to 4 and the total
    # from 39 to 41.
    assert sorted(project_wide) == [
        "DeleteTagGroupCommand",
        "MergeTagGroupCommand",
        "MergeTagValueCommand",
        "RemoveTagValueCommand",
    ]
    assert len(by_field) + len(derived) + len(project_wide) == len(_concrete()) == 41
