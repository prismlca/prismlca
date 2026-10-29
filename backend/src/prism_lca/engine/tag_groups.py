"""Tag groups (dimensions) with a fixed set of allowed values.

A tag group is a named dimension (e.g. "Life-cycle phase") holding an ordered list of allowed
values (e.g. "Production", "Distribution", "End-of-life"). A process may carry at most ONE value
per group (enforced by TagStore.set_tag), but values from several groups. Groups are PrismLCA
config, stored in a JSON file in the active project's directory.
"""
from __future__ import annotations

import unicodedata

from prism_lca.engine._store import JsonFileStore
from prism_lca.errors import PrismError

# Distinct, colour-blind-friendly-ish palette assigned to new groups in order.
_PALETTE = [
    "#93c120", "#2f4e66", "#9f5987", "#1779ba", "#d18a00",
    "#3a9d5d", "#cc4b37", "#7a5cff", "#0f9b8e", "#b5651d",
]


#: Dimension names that mean the same thing, folded to the one this product treats specially.
#:
#: A pure normalisation fold ("Life-cycle phase" == "Life cycle phase") is not enough, and the measured
#: case says why: one project held **four** parallel phase vocabularies — "Phase" (5 models),
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
    alias: "Life-cycle phase"
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


class TagGroupStore(JsonFileStore):
    FILENAME = "tag_groups.json"

    def _default(self) -> list[dict]:
        return []

    def list_groups(self) -> list[dict]:
        return self._load()

    def _find(self, data: list[dict], name: str) -> dict | None:
        return next((g for g in data if g["name"] == name), None)

    def _same(self, data: list[dict], name: str) -> dict | None:
        """An existing group that IS this dimension under another spelling — see `same_dimension`."""
        return next((g for g in data if same_dimension(g.get("name") or "", name)), None)

    def create_group(self, name: str, color: str | None = None) -> dict:
        with self._lock:
            name = (name or "").strip()
            if not name:
                raise PrismError("Tag group name must not be empty.", code="invalid_name")
            data = self._load()
            if self._find(data, name):
                raise PrismError(f"Tag group '{name}' already exists.", code="group_exists", status_code=409)
            # A near-duplicate is refused like a duplicate, and for the reason a duplicate is: a second
            # spelling of one dimension is not a second dimension, it is the same breakdown that no longer
            # lines up across models (V246). The message names the group to use, so the caller has an
            # action rather than an obstacle; a genuinely different dimension needs a genuinely different
            # name, which is a fair thing to ask.
            if twin := self._same(data, name):
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
            group = {"name": name, "color": color or _PALETTE[len(data) % len(_PALETTE)], "values": []}
            data.append(group)
            self._save(data)
            return group

    def find_or_create(self, name: str) -> dict:
        """Resolve a dimension by name, creating it if it is not there yet.

        A tag written straight onto an activity used to be able to name a dimension that no group
        existed for. The tag stuck — the process really carried it — but every picker in the app
        reads the GROUP list, so the dimension was invisible: no *Split by*, no report breakdown, no
        colour. A balcony-solar model had all nine of its processes tagged
        `Lebenswegphase` and its report could not group by phase (V237).

        Registering the dimension on first use is what the parameter groups already do
        (`parameter_groups.find_or_create`), and for the same reason: the name a person or a model
        writes IS the declaration.
        """
        with self._lock:
            name = (name or "").strip()
            if not name:
                raise PrismError("Tag group name must not be empty.", code="invalid_name")
            data = self._load()
            # An exact hit first, then the same dimension under another spelling: a tag written as
            # "Lebenswegphase" onto a model whose project already has "Life-cycle phase" joins that group
            # rather than starting a fifth vocabulary (V246). This path never refuses — it is reached from
            # a tag WRITE, and failing there would lose the tag over a naming question.
            return self._find(data, name) or self._same(data, name) or self.create_group(name)

    def delete_group(self, name: str) -> bool:
        with self._lock:
            data = self._load()
            new = [g for g in data if g["name"] != name]
            if len(new) == len(data):
                return False
            self._save(new)
            return True

    def restore_group(self, group: dict, index: int | None = None) -> None:
        """Re-insert a previously deleted group (undo), keeping its original list position."""
        with self._lock:
            data = self._load()
            if self._find(data, group["name"]):
                return
            if index is None or index > len(data):
                data.append(group)
            else:
                data.insert(index, group)
            self._save(data)

    def add_value(self, group: str, value: str) -> dict:
        with self._lock:
            value = (value or "").strip()
            if not value:
                raise PrismError("Tag value must not be empty.", code="invalid_value")
            data = self._load()
            g = self._find(data, group)
            if g is None:
                raise PrismError(f"Tag group '{group}' does not exist.", code="group_not_found", status_code=404)
            if value not in g["values"]:
                g["values"].append(value)
                self._save(data)
            return g

    def remove_value(self, group: str, value: str) -> bool:
        with self._lock:
            data = self._load()
            g = self._find(data, group)
            if g is None or value not in g["values"]:
                return False
            g["values"] = [v for v in g["values"] if v != value]
            self._save(data)
            return True

    def restore_value(self, group: str, value: str, index: int | None = None) -> None:
        """Re-insert a previously removed value (undo), keeping its original list position."""
        with self._lock:
            data = self._load()
            g = self._find(data, group)
            if g is None or value in g["values"]:
                return
            if index is None or index > len(g["values"]):
                g["values"].append(value)
            else:
                g["values"].insert(index, value)
            self._save(data)
