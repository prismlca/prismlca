"""Folders for the model list — organisational only, project-scoped.

A folder is a named bucket a model can sit in. It has no effect on anything a model *is*: no
calculation, no export, no identity. Its whole job is that a project with forty models is a list
nobody can read, and grouping them by what they are for is how a person finds one again.

Deliberately flat — one level, no folders inside folders. Two levels would need a tree, a move
target, a breadcrumb and a "where did it go" story, and the list this fixes is a couple of dozen
models long. A model belongs to at most one folder; the ones in none are shown together at the end,
which is the state every model starts in and most stay in.

Ordered by NAME, always, and not by anything the user can drag. A hand-made order is a thing to
maintain, and it stops being right the moment somebody adds a folder while looking somewhere else;
alphabetical is the order you can predict without having seen the list before.

Stored beside the parameter groups (``prism_meta/model_folders.json``) and in the same shape of
file: a list of ``{id, name}`` plus a ``{database: folder_id}`` map. Membership is keyed by
model NAME rather than by anything inside the model, so it has to follow a rename — see
:func:`rename_database`, which the rename route calls for exactly that reason.
"""
from __future__ import annotations

import threading
import unicodedata
from pathlib import Path

from prism_lca.engine._store import prism_meta_dir, read_json, write_json_atomic
from prism_lca.engine.model import new_uid
from prism_lca.errors import PrismError

#: Read-modify-write on one shared file — module functions, so the lock is module-level.
_LOCK = threading.RLock()


def _sort_key(name: str) -> str:
    """How a person expects a list of names to read, not how their codepoints happen to fall.

    ``casefold()`` alone is not enough: it turns "Ö" into "ö", which sorts after "z" and drops
    "Ölheizung" off the end of the list, past "Zink". Decomposing first and dropping the combining
    marks puts it where a reader looks for it — between "Obst" and "Papier".
    """
    folded = unicodedata.normalize("NFKD", name or "").casefold()
    return "".join(c for c in folded if not unicodedata.combining(c))


def _path() -> Path:
    return prism_meta_dir() / "model_folders.json"


def _load() -> dict:
    raw = read_json(_path(), default=None)
    if isinstance(raw, dict):
        return {"folders": list(raw.get("folders") or []), "of": dict(raw.get("of") or {})}
    return {"folders": [], "of": {}}


def _save(data: dict) -> None:
    write_json_atomic(_path(), data)


def _find(data: dict, fid: str) -> dict | None:
    return next((f for f in data["folders"] if f["id"] == fid), None)


def state() -> dict:
    """Everything the model list needs in one read: the folders in display order, and who is in what.

    One call rather than two because the list cannot draw either half on its own — a folder with no
    membership map is an empty box, and a map with no folders is a set of ids. Fetching them
    separately also made the list flicker through a state where every model looked unfiled.
    """
    data = _load()
    return {
        # Ties broken on the raw name so two folders differing only in accents keep a stable order.
        "folders": sorted(data["folders"], key=lambda f: (_sort_key(f.get("name")), f.get("name") or "")),
        "of": data["of"],
    }


def create(name: str) -> dict:
    with _LOCK:
        name = (name or "").strip()
        if not name:
            raise PrismError(
                "Folder name must not be empty.",
                code="invalid_name",
                hint="Give the folder a name — it is the only thing that tells it apart.",
            )
        data = _load()
        if any(f["name"].casefold() == name.casefold() for f in data["folders"]):
            raise PrismError(
                f"A folder named '{name}' already exists.",
                code="folder_exists",
                status_code=409,
                hint="Pick a different name, or move the models into the existing folder.",
            )
        folder = {"id": new_uid(), "name": name}
        data["folders"].append(folder)
        _save(data)
        return folder


def rename(folder_id: str, name: str) -> dict:
    with _LOCK:
        name = (name or "").strip()
        if not name:
            raise PrismError("Folder name must not be empty.", code="invalid_name")
        data = _load()
        folder = _find(data, folder_id)
        if folder is None:
            raise PrismError("Folder not found.", code="folder_not_found", status_code=404)
        if any(f["id"] != folder_id and f["name"].casefold() == name.casefold() for f in data["folders"]):
            raise PrismError(
                f"A folder named '{name}' already exists.", code="folder_exists", status_code=409
            )
        folder["name"] = name
        _save(data)
        return folder


def delete(folder_id: str) -> dict:
    """Remove a folder. **The models survive** — they come back unfiled.

    A folder holds no data of its own, so deleting one must never be a way to lose a model. The
    dialog says so, and this is what makes the sentence true.
    """
    with _LOCK:
        data = _load()
        folder = _find(data, folder_id)
        if folder is None:
            raise PrismError("Folder not found.", code="folder_not_found", status_code=404)
        data["folders"] = [f for f in data["folders"] if f["id"] != folder_id]
        freed = [db for db, fid in data["of"].items() if fid == folder_id]
        data["of"] = {db: fid for db, fid in data["of"].items() if fid != folder_id}
        _save(data)
        return {"folder": folder, "released": sorted(freed)}


def assign(database: str, folder_id: str | None) -> dict:
    """Put a model in a folder, or (``folder_id=None``) take it out of whichever it is in."""
    with _LOCK:
        data = _load()
        if folder_id:
            if _find(data, folder_id) is None:
                raise PrismError("Folder not found.", code="folder_not_found", status_code=404)
            data["of"][database] = folder_id
        else:
            data["of"].pop(database, None)
        _save(data)
        return {"database": database, "folder_id": folder_id or None}


# --------------------------------------------------------------------------- #
# Model lifecycle — membership is keyed by name, so it has to follow one
# --------------------------------------------------------------------------- #
def rename_database(old: str, new: str) -> None:
    with _LOCK:
        data = _load()
        if old in data["of"]:
            data["of"][new] = data["of"].pop(old)
            _save(data)


def forget_database(name: str) -> None:
    """A deleted model leaves no membership behind — otherwise a later model of the same name would
    silently inherit the folder of a model nobody remembers."""
    with _LOCK:
        data = _load()
        if data["of"].pop(name, None) is not None:
            _save(data)


def copy(src: str, dst: str) -> None:
    """A duplicate lands beside its original, which is where a person looks for it."""
    with _LOCK:
        data = _load()
        fid = data["of"].get(src)
        if fid:
            data["of"][dst] = fid
            _save(data)
