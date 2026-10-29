"""First-class parameter groups (organisational only), **model-scoped**.

A parameter group is a named bucket a parameter can belong to — purely for organising the
Parameters page and the scenario dialog; it has NO effect on calculation. Groups belong to a
foreground model (database): the same group name may exist independently in different models.
Groups are PrismLCA config stored in a single JSON file (a flat list of ``{id, name, order,
database}``); parameters reference a group by its stable ``id`` (stored in the parameter row's
``data['group_id']``), so renaming a group never touches the parameters and deleting a group only
un-assigns them.
"""
from __future__ import annotations

import threading
from pathlib import Path

from prism_lca.engine._store import prism_meta_dir, read_json, write_json_atomic
from prism_lca.engine.model import new_uid
from prism_lca.errors import PrismError

#: Read-modify-write on one shared file — module functions, so the lock is module-level.
_LOCK = threading.RLock()


def _path() -> Path:
    return prism_meta_dir() / "parameter_groups.json"


def _load() -> list[dict]:
    return read_json(_path(), default=[])


def _save(data: list[dict]) -> None:
    write_json_atomic(_path(), data)


def list_groups(database: str) -> list[dict]:
    """Groups of one model, in display order — [{id, name, order, database}]."""
    rows = [g for g in _load() if g.get("database") == database]
    return sorted(rows, key=lambda g: g.get("order", 0))


def _find(data: list[dict], gid: str) -> dict | None:
    return next((g for g in data if g["id"] == gid), None)


def create(database: str, name: str, group_id: str | None = None) -> dict:
    """``group_id``: keep this id when it is free — a redo recreating the group it undid, so the steps
    after it that name the group by id still find it."""
    with _LOCK:
        name = (name or "").strip()
        if not name:
            raise PrismError("Group name must not be empty.", code="invalid_name",
                             hint="Provide a non-empty group name.")
        data = _load()
        if any(g.get("database") == database and g["name"].casefold() == name.casefold() for g in data):
            raise PrismError(f"A parameter group named '{name}' already exists.", code="group_exists",
                             status_code=409, hint="Pick a different name or rename the existing group.")
        order = len([g for g in data if g.get("database") == database])
        taken = {g["id"] for g in data}
        gid = group_id if group_id and group_id not in taken else new_uid()
        group = {"id": gid, "name": name, "order": order, "database": database}
        data.append(group)
        _save(data)
        return group


def rename(group_id: str, name: str) -> dict:
    with _LOCK:
        name = (name or "").strip()
        if not name:
            raise PrismError("Group name must not be empty.", code="invalid_name")
        data = _load()
        g = _find(data, group_id)
        if g is None:
            raise PrismError("Parameter group not found.", code="group_not_found", status_code=404)
        if any(o["id"] != group_id and o.get("database") == g.get("database")
               and o["name"].casefold() == name.casefold() for o in data):
            raise PrismError(f"A parameter group named '{name}' already exists.", code="group_exists",
                             status_code=409)
        g["name"] = name
        _save(data)
        return g


def snapshot(group_id: str) -> dict | None:
    return _find(_load(), group_id)


def delete(group_id: str) -> dict | None:
    """Remove a group. Does NOT touch parameters — the caller un-assigns them separately. Returns
    the removed group (for undo) or None if it did not exist."""
    with _LOCK:
        data = _load()
        g = _find(data, group_id)
        if g is None:
            return None
        _save([o for o in data if o["id"] != group_id])
        return g


def restore(group: dict) -> None:
    """Re-insert a previously deleted group (undo), keeping its id/order/database."""
    with _LOCK:
        data = _load()
        if _find(data, group["id"]):
            return
        data.append(dict(group))
        _save(data)


def find_or_create(database: str, name: str) -> dict:
    """Resolve a group by name within a model (case-insensitive), creating it if absent. Used when
    a parameter is given a group by NAME (e.g. by the assistant or the legacy label migration)."""
    with _LOCK:
        name = (name or "").strip()
        if not name:
            raise PrismError("Group name must not be empty.", code="invalid_name")
        data = _load()
        g = next((o for o in data if o.get("database") == database
                  and o["name"].casefold() == name.casefold()), None)
        return g if g else create(database, name)


# --------------------------------------------------------------------------- #
# Model lifecycle
# --------------------------------------------------------------------------- #
def copy(src: str, dst: str) -> dict[str, str]:
    """Copy every group of model ``src`` into ``dst`` with fresh ids. Returns {old_id: new_id} so
    the caller can remap parameter group_id references onto the copies."""
    with _LOCK:
        data = _load()
        id_map: dict[str, str] = {}
        for g in sorted((x for x in data if x.get("database") == src), key=lambda x: x.get("order", 0)):
            ng = {"id": new_uid(), "name": g["name"], "order": g.get("order", 0), "database": dst}
            id_map[g["id"]] = ng["id"]
            data.append(ng)
        if id_map:
            _save(data)
        return id_map


def rename_database(old: str, new: str) -> None:
    """Re-key all groups of a renamed model."""
    with _LOCK:
        data = _load()
        changed = False
        for g in data:
            if g.get("database") == old:
                g["database"] = new
                changed = True
        if changed:
            _save(data)


def remove_database(database: str) -> None:
    """Drop all groups of a deleted model."""
    with _LOCK:
        data = _load()
        kept = [g for g in data if g.get("database") != database]
        if len(kept) != len(data):
            _save(kept)


# --------------------------------------------------------------------------- #
# Legacy (project-global) migration helpers — used once by params.migrate_project_to_models()
# --------------------------------------------------------------------------- #
def _legacy_flat() -> list[dict]:
    """Groups from the old project-global format (no ``database`` field)."""
    return [g for g in _load() if not g.get("database")]


def _drop_legacy_flat() -> None:
    with _LOCK:
        data = _load()
        kept = [g for g in data if g.get("database")]
        if len(kept) != len(data):
            _save(kept)
