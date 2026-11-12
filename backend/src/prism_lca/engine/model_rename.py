"""Renaming a model in place: the name is rewritten where Brightway stores it, nothing is copied.

In Brightway a database's name is part of every identity in it. An activity is ``(database, code)``, an
exchange stores both of its ends that way, and the parameter store files the model's parameters under the
name and names each of its activity groups after it (``prism__<model>__<code>``). bw2data's own
``Database.rename`` therefore loads the whole model, writes it again under the new name and drops the old
rows, and ``Database.write`` ends in a ``VACUUM`` of the whole inventory file — with a background installed
that file holds gigabytes, and the VACUUM was nearly all of a rename's time. Here the same end state comes
from rewriting the name where it is stored:

* inventory: ``ActivityDataset.database``, ``ExchangeDataset.input_database``/``output_database`` — inputs
  that other models and the library draw from this one included, which the copying rename left pointing at
  nothing — and the copies of those fields in each row's pickled ``data``, which ``Database.load`` and the
  bundle export read as stored;
* parameters: the model's ``DatabaseParameter`` and ``ActivityParameter`` rows, and every place that names
  one of its groups (``Group``, ``GroupDependency``, ``ParameterizedExchange``, other groups' ``order``);
* the registry: the entry moves to the new key, and databases that draw on the model name the new one in
  ``depends`` and are processed again on their next use.

The two SQLite files change inside one transaction each, the registry is written between their commits, and
an error before the last one leaves the model under its old name as it was (:func:`rename`). A crash of the
process in the milliseconds between the commits is not covered: the parameters would sit under the new name
while the inventory keeps the old one, and a second rename to that name refuses rather than overwrite them.
Row ids survive, so the parameterised exchanges stay attached and nothing has to be registered or
recalculated again. After the commit come the processed arrays under the new file name and the signals
bw2data's rename sent. PrismLCA's own per-model stores are the caller's part.
"""

from __future__ import annotations

import copy
import datetime
import logging
from pathlib import Path

from peewee import chunked

from prism_lca import _log
from prism_lca.engine import hygiene
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.params import _group_name
from prism_lca.engine.step_timing import StepTimer
from prism_lca.errors import PrismError

_logger = logging.getLogger(__name__)


def rename(old: str, new: str, timer: StepTimer) -> None:
    """Rename database ``old`` to ``new`` in bw2data. The caller has checked that ``old`` is a writable
    model and ``new`` a free name.

    The parameter transaction sits inside the inventory one and commits first. Anything that fails after it
    — the registry write, the inventory commit — is taken back by renaming the parameters again, and the
    registry is put back as it was read."""
    bd = get_bd()
    from bw2data.backends import sqlite3_lci_db
    from bw2data.parameters import parameters

    stale = hygiene.database_files(old)  # named while the old name still resolves
    # bw2data's full-text index, on a database that still keeps one (engine/hygiene.py): its file name.
    index = bd.Database(old).filename if bd.databases[old].get("searchable") else None
    registry = copy.deepcopy(bd.databases.data)
    parameters_committed = registry_written = False
    try:
        with sqlite3_lci_db.atomic():
            with parameters.db.atomic():
                consumers = _rename_inventory(old, new)
                timer.done("inventory rows renamed")
                _rename_parameters(old, new)
                timer.done("parameters renamed")
            parameters_committed = True
            registry_written = True
            _move_registry_entry(old, new, consumers)
        timer.done("registry updated")
    except BaseException:
        if parameters_committed:
            _take_parameters_back(new, old)
        if registry_written:
            _put_registry_back(registry)
        raise
    _after_commit(old, new, stale, index)
    timer.done("arrays processed")


def _rename_inventory(old: str, new: str) -> set[str]:
    """Rewrite the name in the inventory rows. Returns the other databases with inputs from the model."""
    from bw2data.backends import ActivityDataset, ExchangeDataset

    # Read in full before the first update: an update under an open cursor that walks the same index can
    # meet a row twice or not at all.
    nodes = list(
        ActivityDataset.select(ActivityDataset.id, ActivityDataset.data)
        .where(ActivityDataset.database == old)
        .tuples()
    )
    for row_id, data in nodes:
        data["database"] = new
        ActivityDataset.update(database=new, data=data).where(ActivityDataset.id == row_id).execute()

    edges = list(
        ExchangeDataset.select(
            ExchangeDataset.id,
            ExchangeDataset.data,
            ExchangeDataset.input_database,
            ExchangeDataset.input_code,
            ExchangeDataset.output_database,
            ExchangeDataset.output_code,
        )
        .where((ExchangeDataset.input_database == old) | (ExchangeDataset.output_database == old))
        .tuples()
    )
    consumers: set[str] = set()
    for row_id, data, input_db, input_code, output_db, output_code in edges:
        fields: dict = {"data": data}
        if input_db == old:
            fields["input_database"] = new
            data["input"] = (new, input_code)
        if output_db == old:
            fields["output_database"] = new
            data["output"] = (new, output_code)
        else:
            consumers.add(output_db)
        ExchangeDataset.update(**fields).where(ExchangeDataset.id == row_id).execute()
    return consumers


def _rename_parameters(old: str, new: str) -> None:
    """Move the model's parameters and its activity groups to the new name."""
    from bw2data.parameters import (
        ActivityParameter,
        DatabaseParameter,
        Group,
        GroupDependency,
        ParameterizedExchange,
    )

    rows = list(ActivityParameter.select().where(ActivityParameter.database == old).dicts())
    # The database's own group carries its name; an activity group carries it when we named it. A group
    # someone else named (an imported one) keeps its name and only changes database.
    groups = {old: new} | {
        row["group"]: _group_name(new, row["code"])
        for row in rows
        if row["group"] == _group_name(old, row["code"])
    }
    _clear_leftovers(new, set(groups.values()))

    DatabaseParameter.update(database=new).where(DatabaseParameter.database == old).execute()
    if rows:
        # bw2data's triggers keep a group inside one database and an activity inside one group, and they
        # check row by row: an UPDATE moving a group's rows one at a time trips them on the second row.
        # Deleted and inserted again, the rows move at once — ids included.
        ActivityParameter.delete().where(ActivityParameter.database == old).execute()
        moved = [{**row, "database": new, "group": groups.get(row["group"], row["group"])} for row in rows]
        for batch in chunked(moved, 100):
            ActivityParameter.insert_many(batch).execute()
    for before, after in groups.items():
        Group.update(name=after).where(Group.name == before).execute()
        GroupDependency.update(group=after).where(GroupDependency.group == before).execute()
        GroupDependency.update(depends=after).where(GroupDependency.depends == before).execute()
        ParameterizedExchange.update(group=after).where(ParameterizedExchange.group == before).execute()
    for group_id, order in Group.select(Group.id, Group.order).tuples():
        if any(name in groups for name in order or ()):
            renamed = [groups.get(name, name) for name in order]
            Group.update(order=renamed).where(Group.id == group_id).execute()


def _clear_leftovers(new: str, group_names: set[str]) -> None:
    """Drop parameter groups still named after ``new`` that no parameter row uses.

    bw2data keeps a database's ``Group`` rows when it deletes the database, and our activity groups carry
    the model's name, so a model once called ``new`` can leave some behind; the moving groups would collide
    with them (a group name is unique). Parameter rows themselves are never dropped here: rows still filed
    under ``new``, or a group of another database that carries one of the names, stop the rename instead.
    """
    from bw2data.parameters import ActivityParameter, DatabaseParameter, Group, GroupDependency

    names = list(group_names)
    if (
        DatabaseParameter.select().where(DatabaseParameter.database == new).exists()
        or ActivityParameter.select().where(ActivityParameter.database == new).exists()
    ):
        raise PrismError(
            f"Parameters are still stored under the name '{new}', left by an earlier model of that name.",
            code="name_in_use",
            status_code=409,
            hint="Choose another name.",
        )
    if ActivityParameter.select().where(ActivityParameter.group << names).exists():
        raise PrismError(
            f"The name '{new}' is used by a parameter group of another database.",
            code="name_in_use",
            status_code=409,
            hint="Choose another name.",
        )
    GroupDependency.delete().where(
        (GroupDependency.group << names) | (GroupDependency.depends << names)
    ).execute()
    Group.delete().where(Group.name << names).execute()


def _move_registry_entry(old: str, new: str, consumers: set[str]) -> None:
    """Move the registry entry and point the databases that draw on the model at the new name.

    Their processed arrays still name the old one as a dependency, so they are marked to be processed again
    on their next use; the model itself is marked too, until :func:`_after_commit` has processed it."""
    bd = get_bd()
    # A new dict swapped in whole: a calculation thread iterating the registry meanwhile keeps the one it
    # started with. The entry goes to the end, where bw2data's rename put it.
    entries = {name: meta for name, meta in bd.databases.data.items() if name != old}
    meta = entries[new] = bd.databases.data[old]
    meta["modified"] = datetime.datetime.now().isoformat()
    meta["dirty"] = True
    for name, other in entries.items():
        depends = other.get("depends") or []
        if old in depends or name in consumers:
            other["depends"] = sorted({new if d == old else d for d in depends})
            other["dirty"] = True
    bd.databases.data = entries
    # bw2data diffs the whole registry for its revision log on every flush, and asks only afterwards
    # whether the project keeps one; ours never do.
    bd.databases.flush(signal=bool(bd.projects.dataset.is_sourced))


def _take_parameters_back(new: str, old: str) -> None:
    """Undo a committed parameter rename after a later step failed — in its own transaction."""
    from bw2data.parameters import parameters

    try:
        with parameters.db.atomic():
            _rename_parameters(new, old)
    except Exception:  # noqa: BLE001 - the first failure is the one the caller reports
        _logger.exception("model rename: the parameters could not be moved back to the old name")


def _put_registry_back(registry: dict) -> None:
    """The registry as it was read before the rename, in memory and on disk."""
    bd = get_bd()
    bd.databases.data = registry
    try:
        bd.databases.flush(signal=False)
    except Exception:  # noqa: BLE001 - the first failure is the one the caller reports
        _logger.exception("model rename: the registry could not be written back")


def _after_commit(old: str, new: str, stale: list[Path], index: str | None) -> None:
    """What follows the commit: bw2data's full-text index where one is kept, the processed arrays under the
    new name, and the signals bw2data's own rename sent."""
    bd = get_bd()
    from bw2data.search import IndexManager
    from bw2data.signals import on_database_delete, on_database_write

    if index is not None:
        IndexManager(index).delete_database()
        bd.Database(new).make_searchable(reset=True, signal=False)
    try:
        bd.Database(new).process()
    except Exception as exc:  # noqa: BLE001 - e.g. an input whose process is gone
        # The rename itself is done. The model stays marked dirty, and the calculation that processes it
        # next reports the same error where it can be acted on.
        _log.swallowed(exc, "model_rename._after_commit")
    hygiene.remove_files(stale)
    if bd.projects.dataset.is_sourced:
        on_database_write.send(name=new)
    # Also drops bw2data's (database, code) → id cache entries under the old name.
    on_database_delete.send(name=old)
