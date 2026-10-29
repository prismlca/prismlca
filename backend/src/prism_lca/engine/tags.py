"""Generic free-text tags for activities (life-cycle stage, location, supplier, …).

Tags are a PrismLCA concept, not a Brightway one, so they live in a small JSON file inside the
active project's directory. Each activity can carry a set of ``(dimension, value)`` pairs.
"""
from __future__ import annotations

from prism_lca.engine._store import JsonFileStore


class TagStore(JsonFileStore):
    FILENAME = "tags.json"

    @staticmethod
    def _key(database: str, code: str) -> str:
        return f"{database}/{code}"

    # --- an input's own tag ---------------------------------------------------
    # One input (technosphere exchange) of a process can carry a tag of its own: "this steel counts as raw
    # material" while the process that consumes it counts as production. It is stored here, next to the
    # process tags, under the consumer's key plus the exchange uid — so undo, the audit, merging and deleting
    # values, and renaming or deleting a model treat it like any other tag without code of their own.
    EXCHANGE_SEP = "#"

    @staticmethod
    def exchange_code(code: str, uid: str) -> str:
        """The code part of an input's tag key: the consuming process's code and the exchange uid."""
        return f"{code}{TagStore.EXCHANGE_SEP}{uid}"

    @staticmethod
    def split_code(code: str) -> tuple[str, str | None]:
        """``(process code, exchange uid)`` of a key's code part; the uid is None for a process tag.

        Only a 32-digit hex suffix after the LAST separator is a uid, so a process code that happens to
        contain the separator is still read as a process."""
        from prism_lca.engine.tag_scope import UID_RE

        base, sep, uid = code.rpartition(TagStore.EXCHANGE_SEP)
        if sep and base and UID_RE.match(uid):
            return base, uid
        return code, None

    @staticmethod
    def is_exchange_key(key: str) -> bool:
        """Whether a ``database/code`` key of the store belongs to an input rather than a process."""
        return TagStore.split_code(key.rsplit("/", 1)[-1])[1] is not None

    # --- read-only snapshot for tree traversals -----------------------------
    # A tag-aggregated contribution visits thousands of nodes; reading + parsing tags.json per
    # node would dominate the request. Load once, then answer lookups from the dict.
    def load_map(self) -> dict[str, list[dict]]:
        return self._load()

    @staticmethod
    def value_from(tag_map: dict, database: str, code: str, dimension: str) -> str | None:
        for t in tag_map.get(f"{database}/{code}", []):
            if t["dimension"] == dimension:
                return t["value"]
        return None

    def databases_by_dimension(self) -> dict[str, list[str]]:
        """Per tag dimension, the databases in which some activity actually carries a value of it.

        What a *split by* needs to know. A dimension exists as project config the moment it is created, so
        the picker used to offer every one of them for every model — and splitting a contribution by a
        dimension nobody has tagged yields one group called "untagged", which looks like a broken chart
        rather than an empty answer. Read from the tag map, whose keys are already ``<database>/<code>``,
        so this costs one file read and no Brightway query.
        """
        out: dict[str, set[str]] = {}
        for key, tags in self._load().items():
            database = key.rsplit("/", 1)[0]
            for t in tags:
                out.setdefault(t["dimension"], set()).add(database)
        return {dim: sorted(dbs) for dim, dbs in out.items()}

    def list_for(self, database: str, code: str) -> list[dict]:
        return self._load().get(self._key(database, code), [])

    def has(self, database: str, code: str, dimension: str, value: str) -> bool:
        return any(
            t["dimension"] == dimension and t["value"] == value
            for t in self.list_for(database, code)
        )

    def add(self, database: str, code: str, dimension: str, value: str) -> bool:
        """Return True if the tag was newly added."""
        with self._lock:
            data = self._load()
            key = self._key(database, code)
            tags = data.setdefault(key, [])
            if any(t["dimension"] == dimension and t["value"] == value for t in tags):
                return False
            tags.append({"dimension": dimension, "value": value})
            self._save(data)
            return True

    def value_in(self, database: str, code: str, dimension: str) -> str | None:
        """The single value assigned to this activity in ``dimension`` (or None)."""
        for t in self.list_for(database, code):
            if t["dimension"] == dimension:
                return t["value"]
        return None

    def set_tag(self, database: str, code: str, dimension: str, value: str | None) -> str | None:
        """Assign (at most one) value per dimension. ``value`` None/empty clears the dimension.
        Returns the *previous* value in that dimension (for undo)."""
        with self._lock:
            data = self._load()
            key = self._key(database, code)
            tags = data.get(key, [])
            old = next((t["value"] for t in tags if t["dimension"] == dimension), None)
            tags = [t for t in tags if t["dimension"] != dimension]
            if value:
                tags.append({"dimension": dimension, "value": value})
            if tags:
                data[key] = tags
            else:
                data.pop(key, None)
            self._save(data)
            return old

    def lists_for(self, keys: list[str]) -> dict[str, list[dict]]:
        """The complete tag list of each key (empty list when untagged) — the snapshot a merge keeps
        so that undo can put every activity back exactly, whatever it carried (an activity may hold
        several values of one dimension through the plain /tags route)."""
        data = self._load()
        return {k: [dict(t) for t in data.get(k, [])] for k in keys}

    def rewrite_lists(self, lists: dict[str, list[dict]]) -> None:
        """Replace the tag lists of the given keys wholesale (undo of a merge)."""
        with self._lock:
            data = self._load()
            for key, tags in lists.items():
                if tags:
                    data[key] = [dict(t) for t in tags]
                else:
                    data.pop(key, None)
            self._save(data)

    def remove_dimension(self, dimension: str) -> None:
        """Cascade: drop every tag of ``dimension`` across all activities (group deleted)."""
        with self._lock:
            data = self._load()
            changed = False
            for key in list(data.keys()):
                kept = [t for t in data[key] if t["dimension"] != dimension]
                if len(kept) != len(data[key]):
                    changed = True
                    if kept:
                        data[key] = kept
                    else:
                        data.pop(key, None)
            if changed:
                self._save(data)

    def remove_dimension_value(self, dimension: str, value: str) -> None:
        """Cascade: drop tags matching (dimension, value) across all activities (value deleted)."""
        with self._lock:
            data = self._load()
            changed = False
            for key in list(data.keys()):
                kept = [t for t in data[key] if not (t["dimension"] == dimension and t["value"] == value)]
                if len(kept) != len(data[key]):
                    changed = True
                    if kept:
                        data[key] = kept
                    else:
                        data.pop(key, None)
            if changed:
                self._save(data)

    def remove(self, database: str, code: str, dimension: str, value: str) -> bool:
        """Return True if a tag was removed."""
        with self._lock:
            data = self._load()
            key = self._key(database, code)
            tags = data.get(key, [])
            new_tags = [t for t in tags if not (t["dimension"] == dimension and t["value"] == value)]
            if len(new_tags) == len(tags):
                return False
            if new_tags:
                data[key] = new_tags
            else:
                data.pop(key, None)
            self._save(data)
            return True

    def rename_database(self, old: str, new: str) -> None:
        """Re-key all tags of a renamed foreground model (codes are preserved)."""
        with self._lock:
            data = self._load()
            prefix = f"{old}/"
            moved = False
            for key in [k for k in data if k.startswith(prefix)]:
                data[f"{new}/{key[len(prefix):]}"] = data.pop(key)
                moved = True
            if moved:
                self._save(data)

    def remove_database(self, database: str) -> None:
        """Drop all tags belonging to a deleted foreground model."""
        with self._lock:
            data = self._load()
            prefix = f"{database}/"
            keys = [k for k in data if k.startswith(prefix)]
            if keys:
                for k in keys:
                    data.pop(k, None)
                self._save(data)
