"""Tag groups (dimensions) with their values — the vocabulary of ONE model.

A tag group is a named dimension (e.g. "Life-cycle phase") holding an ordered list of values (e.g.
"Production", "Distribution", "End-of-life"). A process may carry at most ONE value per group (enforced
by TagStore.set_tag), but values from several groups.

A group belongs to a model, like the tags themselves: the same name may exist in two models with
different values, colours and orders, and nothing one model does to its groups reaches another. What
lets two models be broken down side by side is the same group NAME and the same value strings — a
convention the calculation reads from the tags, not an object the models share. For the life-cycle
phase the name is held by :data:`_SAME_AS`; everything else is the modeller's choice.

**The list follows the tags.** A value some process or input of the model carries is part of the
model's vocabulary whether or not anybody registered it: a bundle or a spreadsheet import writes tags
without declaring them, and an undo can put a tag back whose value has since been removed. So reading a
model's groups adds what its tags carry and the list does not hold (:meth:`TagGroupStore.list_groups`).
The reverse does not hold — a value nobody carries stays until it is removed, because a vocabulary is
prepared before it is used.

**A read may write** (the completion above, and the split of an older file), so every access holds the
project lock before the store's own: a workspace switch in another thread could otherwise fall between
reading one workspace's tags and saving, and the save would land in the other workspace's file.

Stored in one file for the workspace, keyed by model (``{"schema": 2, "models": {name: [group, …]}}``).
Up to data format 1 the file was one list for the whole workspace; it is split where it is read
(:mod:`prism_lca.engine.tag_groups_split`).
"""
from __future__ import annotations

import unicodedata
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from prism_lca.engine._store import JsonFileStore, read_json, write_json_atomic
from prism_lca.errors import PrismError

#: The name the life-cycle phase has in every model that does not already call it something else.
PHASE = "Life-cycle phase"
#: ``schema`` of the per-model file.
SCHEMA = 2

# Distinct, colour-blind-friendly-ish palette assigned to new groups in order.
_PALETTE = [
    "#93c120", "#2f4e66", "#9f5987", "#1779ba", "#d18a00",
    "#3a9d5d", "#cc4b37", "#7a5cff", "#0f9b8e", "#b5651d",
]


#: Dimension names that mean the same thing, folded to the one this product treats specially.
#:
#: A pure normalisation fold ("Life-cycle phase" == "Life cycle phase") is not enough, and the measured
#: case says why: one workspace held **four** parallel phase vocabularies — "Phase" (5 models),
#: "Life-cycle phase" (38), "Life cycle phase" (1, with no values at all) and "Lebenswegphase" (2) —
#: so no breakdown could be chosen across two models and no report could compare them (V246).
#:
#: The cause was not a missing convention: the modelling skill has named "Life-cycle phase" all along.
#: It was a collision between two rules — the same skill says study documentation is written in the
#: study's language, and a model applied that to the dimension NAME as well. The name is an identifier
#: and is not translated; the VALUES are study text and are (the report translates them for printing,
#: V240). This table is the machinery that makes the convention hold even when a caller forgets.
#:
#: Deliberately one dimension and a closed list. Guessing at synonyms in general would silently merge
#: two dimensions somebody meant to keep apart, which is worse than the fragmentation it fixes.
_SAME_AS: dict[str, str] = {
    alias: PHASE
    for alias in (
        "phase", "phases", "lifecyclephase", "lifecyclephases", "lifecyclestage", "lifecyclestages",
        "lifephase", "stage", "stages",
        "lebenswegphase", "lebenswegphasen", "lebenszyklusphase", "lebensphase", "phasen",
        "phaseducycledevie", "phasesducycledevie", "etapeducycledevie",
        "fasedelciclodevida", "fasesdelciclodevida", "etapadelciclodevida",
        "fasedociclodevida", "fasesdociclodevida", "etapadociclodevida",
    )
}


def fold_name(name: str) -> str:
    """A dimension name reduced to what identifies it — case, spaces, hyphens and accents dropped."""
    stripped = "".join(c for c in unicodedata.normalize("NFKD", name or "") if not unicodedata.combining(c))
    return "".join(c for c in stripped.casefold() if c.isalnum())


def same_dimension(a: str, b: str) -> bool:
    """Whether two dimension names are the same dimension — see `_SAME_AS`."""
    fa, fb = fold_name(a), fold_name(b)
    return bool(fa) and (fa == fb or _SAME_AS.get(fa, fa) == _SAME_AS.get(fb, fb))


def palette_color(groups: list[dict]) -> str:
    return _PALETTE[len(groups) % len(_PALETTE)]


class TagGroupStore(JsonFileStore):
    FILENAME = "tag_groups.json"

    def _default(self) -> dict:
        return {"schema": SCHEMA, "models": {}}

    @contextmanager
    def _held(self) -> Iterator[None]:
        """The project lock, then the store's own — in that order everywhere (module docstring). Both
        are reentrant: a command reaches the store with the project lock already held by the bus."""
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK, self._lock:
            yield

    def _load(self) -> dict:
        raw = read_json(self._path(), default=self._default(), on_error=self.ON_ERROR)
        if isinstance(raw, list):
            # The workspace-wide list of data format 1 — wherever it comes from: a workspace opened for
            # the first time by this version, one restored from an older backup over a newer one, one
            # carried over from another directory. Recognised by its shape, so there is no marker that
            # could disagree with the file.
            from prism_lca.engine import tag_groups_split

            with self._held():
                path = self._path()
                raw = read_json(path, default=self._default(), on_error=self.ON_ERROR)
                if isinstance(raw, list):
                    write_json_atomic(path.with_name(tag_groups_split.BACKUP_NAME), raw)
                    raw = {"schema": SCHEMA, "models": tag_groups_split.per_model(raw)}
                    self._save(raw)
        if not isinstance(raw.get("models"), dict):
            raw["models"] = {}
        return raw

    # --- reading ------------------------------------------------------------------------------
    def list_groups(self, database: str, carried: dict[str, list[str]] | None = None) -> list[dict]:
        """The model's groups in their order, completed by what its tags carry (module docstring).
        ``carried``: ``TagStore.carried(database)`` when the caller has just read it — under the project
        lock, or it may be another workspace's by the time it is used here."""
        from prism_lca.engine.tags import TagStore

        with self._held():
            if carried is None:
                carried = TagStore().carried(database)
            data = self._load()
            groups = data["models"].get(database, [])
            if self._absorb(groups, carried):
                data["models"][database] = groups
                self._save(data)
            return groups

    @staticmethod
    def _absorb(groups: list[dict], carried: dict[str, list[str]]) -> bool:
        """Add the groups and values of ``carried`` that ``groups`` lacks; True when something was added."""
        changed = False
        for dimension, values in carried.items():
            group = next((g for g in groups if g["name"] == dimension), None)
            if group is None:
                group = {"name": dimension, "color": palette_color(groups), "values": []}
                groups.append(group)
                changed = True
            for value in values:
                if value not in group["values"]:
                    group["values"].append(value)
                    changed = True
        return changed

    def _groups(self, data: dict, database: str) -> list[dict]:
        """The model's groups inside ``data``, for a change: completed from its tags first, like a read.
        A group only the tags carry (an import wrote them) is a group of the model, and a change that
        did not see it would create its twin beside it or refuse a value for a group that is there."""
        from prism_lca.engine.tags import TagStore

        groups = data["models"].setdefault(database, [])
        self._absorb(groups, TagStore().carried(database))
        return groups

    def _find(self, groups: list[dict], name: str) -> dict | None:
        return next((g for g in groups if g["name"] == name), None)

    def _same(self, groups: list[dict], name: str) -> dict | None:
        """A group of the model that IS this dimension under another spelling — see `same_dimension`."""
        return next((g for g in groups if same_dimension(g.get("name") or "", name)), None)

    def name_for(self, database: str, name: str) -> str:
        """The name a dimension goes by in this model: the group that already is it (exactly, or under
        another spelling), else the fixed name of the life-cycle phase for one of its aliases, else the
        name as given. Creates nothing."""
        name = (name or "").strip()
        groups = self.list_groups(database)
        found = self._find(groups, name) or self._same(groups, name)
        if found:
            return found["name"]
        return PHASE if same_dimension(name, PHASE) else name

    # --- groups -------------------------------------------------------------------------------
    def create_group(self, database: str, name: str, color: str | None = None) -> dict:
        with self._held():
            name = (name or "").strip()
            if not name:
                raise PrismError("Tag group name must not be empty.", code="invalid_name")
            data = self._load()
            groups = self._groups(data, database)
            if self._find(groups, name):
                raise PrismError(f"Tag group '{name}' already exists.", code="group_exists", status_code=409)
            # A near-duplicate is refused like a duplicate, and for the reason a duplicate is: a second
            # spelling of one dimension is not a second dimension, it is the same breakdown split in two
            # inside one model (V246). The message names the group to use, so the caller has an
            # action rather than an obstacle; a genuinely different dimension needs a genuinely different
            # name, which is a fair thing to ask.
            if twin := self._same(groups, name):
                raise PrismError(
                    f"Tag group '{twin['name']}' already covers this dimension — use it instead of "
                    f"creating '{name}'.",
                    # A code of its own: the caller asked for a name that does NOT exist, and the
                    # answer is to use a different one — a decision. The exact-name case above is the
                    # caller's own wish already granted, and its caller treats it as a no-op (V305).
                    code="group_dimension_exists",
                    status_code=409,
                    hint=(
                        "Add your values to that group (edit_tags action=\"add_value\"). A dimension name "
                        "is an identifier and is not translated; its VALUES are study text and follow the "
                        "study's language."
                    ),
                )
            # The life-cycle phase is created under its one name whatever the caller called it: with a
            # list per model there is no existing group to join, and two new models would otherwise
            # start "Phase" and "Lebenswegphase" — the same breakdown under names no comparison lines up.
            if same_dimension(name, PHASE):
                name = PHASE
            group = {"name": name, "color": color or palette_color(groups), "values": []}
            groups.append(group)
            self._save(data)
            return group

    def find_or_create(self, database: str, name: str) -> dict:
        """Resolve a dimension of the model by name, creating it if it is not there yet.

        A tag written straight onto an activity used to be able to name a dimension that no group
        existed for. The tag stuck — the process really carried it — but every picker in the app
        reads the GROUP list, so the dimension was invisible: no *Split by*, no report breakdown, no
        colour. A balcony-solar model had all nine of its processes tagged
        `Lebenswegphase` and its report could not group by phase (V237).

        Registering the dimension on first use is what the parameter groups already do
        (`parameter_groups.find_or_create`), and for the same reason: the name a person or a model
        writes IS the declaration.
        """
        with self._held():
            name = (name or "").strip()
            if not name:
                raise PrismError("Tag group name must not be empty.", code="invalid_name")
            groups = self._groups(self._load(), database)
            # An exact hit first, then the same dimension under another spelling: a tag written as
            # "Lebenswegphase" onto a model that already has "Life-cycle phase" joins that group
            # rather than starting a second vocabulary (V246). This path never refuses — it is reached
            # from a tag WRITE, and failing there would lose the tag over a naming question.
            return self._find(groups, name) or self._same(groups, name) or self.create_group(database, name)

    def delete_group(self, database: str, name: str) -> bool:
        with self._held():
            data = self._load()
            groups = self._groups(data, database)
            kept = [g for g in groups if g["name"] != name]
            if len(kept) == len(groups):
                return False
            data["models"][database] = kept
            self._save(data)
            return True

    def restore_group(self, database: str, group: dict, index: int | None = None) -> None:
        """Re-insert a previously deleted group (undo), keeping its original list position."""
        with self._held():
            data = self._load()
            groups = self._groups(data, database)
            if self._find(groups, group["name"]):
                return
            if index is None or index > len(groups):
                groups.append(group)
            else:
                groups.insert(index, group)
            self._save(data)

    # --- values -------------------------------------------------------------------------------
    def add_value(self, database: str, group: str, value: str) -> dict:
        with self._held():
            value = (value or "").strip()
            if not value:
                raise PrismError("Tag value must not be empty.", code="invalid_value")
            data = self._load()
            g = self._find(self._groups(data, database), group)
            if g is None:
                raise PrismError(f"Tag group '{group}' does not exist.", code="group_not_found", status_code=404)
            if value not in g["values"]:
                g["values"].append(value)
                self._save(data)
            return g

    def remove_value(self, database: str, group: str, value: str) -> bool:
        with self._held():
            data = self._load()
            g = self._find(self._groups(data, database), group)
            if g is None or value not in g["values"]:
                return False
            g["values"] = [v for v in g["values"] if v != value]
            self._save(data)
            return True

    def restore_value(self, database: str, group: str, value: str, index: int | None = None) -> None:
        """Re-insert a previously removed value (undo), keeping its original list position."""
        with self._held():
            data = self._load()
            g = self._find(self._groups(data, database), group)
            if g is None or value in g["values"]:
                return
            if index is None or index > len(g["values"]):
                g["values"].append(value)
            else:
                g["values"].insert(index, value)
            self._save(data)

    # --- taking over another model's groups ---------------------------------------------------
    def adopt(self, database: str, taken: list[dict]) -> dict:
        """Copy ``taken`` — another model's groups — into ``database``: a group the model lacks arrives
        with its colour and values, one it has gains the values it lacks, appended. Nothing the model
        already has is changed, and the two lists are independent afterwards. Returns what was added —
        ``{"groups": {new group: [its values]}, "values": {existing group: [new values]}}`` — for the
        undo."""
        taken = [dict(g, values=list(g["values"])) for g in taken]
        with self._held():
            data = self._load()
            groups = self._groups(data, database)
            added: dict[str, Any] = {"groups": {}, "values": {}}
            for theirs in taken:
                mine = self._find(groups, theirs["name"]) or self._same(groups, theirs["name"])
                if mine is None:
                    groups.append(theirs)
                    added["groups"][theirs["name"]] = list(theirs["values"])
                    continue
                new = [v for v in theirs["values"] if v not in mine["values"]]
                if new:
                    mine["values"] += new
                    added["values"][mine["name"]] = new
            if added["groups"] or added["values"]:
                self._save(data)
            return added

    def drop_adopted(self, database: str, added: dict) -> None:
        """Take back what :meth:`adopt` added, and only that: the values it brought, and a group it
        brought once none of its values is left — a value added to such a group since stays, with the
        group. A value or group that has been used since comes back the next time the list is read (the
        list follows the tags)."""
        with self._held():
            data = self._load()
            groups = self._groups(data, database)
            brought = dict(added.get("groups") or {})
            for name, values in {**brought, **(added.get("values") or {})}.items():
                if g := self._find(groups, name):
                    g["values"] = [v for v in g["values"] if v not in values]
            data["models"][database] = [g for g in groups if not (g["name"] in brought and not g["values"])]
            self._save(data)

    # --- the model lifecycle (see `_store.per_model_stores`) ----------------------------------
    def rename_database(self, old: str, new: str) -> None:
        with self._held():
            data = self._load()
            if old in data["models"]:
                data["models"][new] = data["models"].pop(old)
                self._save(data)

    def remove_database(self, database: str) -> None:
        with self._held():
            data = self._load()
            if data["models"].pop(database, None) is not None:
                self._save(data)

    def snapshot_database(self, database: str) -> list[dict]:
        """The model's groups as stored — without the completion from its tags, which a restore of the
        tags beside it brings back anyway."""
        with self._held():
            return [dict(g, values=list(g["values"])) for g in self._load()["models"].get(database, [])]

    def restore_database(self, database: str, groups: list[dict] | None) -> None:
        with self._held():
            data = self._load()
            if groups:
                data["models"][database] = [dict(g, values=list(g["values"])) for g in groups]
            else:
                data["models"].pop(database, None)
            self._save(data)

    def copy(self, source: str, target: str) -> None:
        """A copy of a model starts with its original's groups (colours, orders, prepared values)."""
        self.restore_database(target, self.snapshot_database(source))
