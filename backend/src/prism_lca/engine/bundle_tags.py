"""The tags of a model in a ``.prism`` bundle: the ``tags`` section (process tags), the tags an input
carries of its own, which ride on that input's graph row, and the ``tag_groups`` section (the model's
groups with their colours and the order of their values).

The tags are the statement and the groups follow them: a bundle written before the groups travelled
has none, one that passed through an older PrismLCA may carry a group list older than its tags, and in
both cases the model's groups are completed from what its tags carry when they are read (see
``tag_groups.py``). So the section adds colour, order and prepared values, never a contradiction.

An input's tag is keyed by its exchange uid in the tag store, and a bundle carries no uids (they are per
model; the reader gives fresh ones). So the tags section could not find the exchange again: the graph row
carries them under :data:`EXCHANGE_TAGS_KEY` instead, and the reader writes them under the new uid. Tags are
their own subject inside a bundle — a store beside Brightway with its own keys — so they live here and
``bundle.py`` keeps the format, the sections and the reading order.
"""
from __future__ import annotations

from typing import Any

from prism_lca.engine import model as _model
from prism_lca.engine.tag_groups import TagGroupStore, palette_color
from prism_lca.engine.tags import TagStore

#: The row key that carries an input's own tags through a bundle (never a Brightway exchange field).
EXCHANGE_TAGS_KEY = "prism_tags"


def row_tags(tag_map: dict, database: str, act, ex) -> dict:
    """``{EXCHANGE_TAGS_KEY: [...]}`` for a graph row whose exchange carries tags, else ``{}``. Sorted, so
    two exports agree byte for byte."""
    uid = ex.get("prism_uid")
    own = tag_map.get(f"{database}/{TagStore.exchange_code(act.key[1], uid)}") if uid else None
    if not own:
        return {}
    tags = sorted(({"dimension": t["dimension"], "value": t["value"]} for t in own),
                  key=lambda t: (t["dimension"], t["value"]))
    return {EXCHANGE_TAGS_KEY: tags}


def apply_row_tags(store: TagStore, database: str, act, ex, row: dict, uid: str | None = None) -> None:
    """Save a freshly read exchange and write the tags its row carried under its uid: ``uid`` when the
    caller keeps one per row (the same on redo), else a new one when the row has tags (the tag needs it
    now; untagged rows get theirs from the reader's backfill)."""
    own = row.get(EXCHANGE_TAGS_KEY) or []
    if uid:
        ex["prism_uid"] = uid
    elif own:
        ex["prism_uid"] = _model.new_uid()
    ex.save()
    for tag in own:
        store.set_tag(database, TagStore.exchange_code(act.key[1], ex["prism_uid"]), tag["dimension"], tag["value"])


def write_tags(database: str) -> dict:
    store = TagStore()
    tag_map = store.load_map()
    prefix = f"{database}/"
    return {
        "tags": {
            key[len(prefix) :]: value
            for key, value in sorted(tag_map.items())
            # An input's tags travel on its graph row (see write_graph), not under its uid.
            if key.startswith(prefix) and not TagStore.is_exchange_key(key)
        }
    }


def read_tags(database: str, data: Any) -> None:
    store = TagStore()
    for code, tags in (data.get("tags") or {}).items():
        for tag in tags or []:
            dim, val = tag.get("dimension"), tag.get("value")
            if dim and val:
                store.add(database, code, dim, val)




def write_tag_groups(database: str) -> dict:
    return {
        "tag_groups": [
            {"name": g["name"], "color": g.get("color"), "values": list(g["values"])}
            for g in TagGroupStore().list_groups(database)
        ]
    }


def read_tag_groups(database: str, data: Any) -> None:
    groups: list[dict] = []
    for g in data.get("tag_groups") or []:
        name = str((g or {}).get("name") or "").strip()
        if not name or any(have["name"] == name for have in groups):
            continue
        values = list(dict.fromkeys(str(v).strip() for v in g.get("values") or [] if str(v).strip()))
        color = g.get("color")
        groups.append(
            {"name": name, "color": color if isinstance(color, str) and color else palette_color(groups), "values": values}
        )
    if groups:
        TagGroupStore().restore_database(database, groups)
