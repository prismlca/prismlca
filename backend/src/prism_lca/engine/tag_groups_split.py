"""Splitting the workspace-wide tag-group list of data format 1 into one list per model.

Up to data format 1 a workspace had one list of tag groups, and every model wrote its values into it.
From format 2 on a group belongs to a model (:mod:`prism_lca.engine.tag_groups`). This module turns the
old list into the new shape, and the store calls it wherever it finds the old shape — a workspace this
version opens for the first time, one restored from an older backup, one carried over from another
directory.

What a model gets: the groups its processes and inputs carry a tag of, each with the values they carry,
in the old list's order and with its colour. A group or a value no process of the model carries is not
taken along — it was another model's, or nobody's. A value that is carried but was never in the list
(tags written by an import) is added at the end.

**Nothing is renamed**: not a group, not a value. A finished report pins its breakdown by the group's
name and its numbers by the value, and a stored *split by* names the group — all of them keep pointing
at what they pointed at. Parallel spellings of one dimension in different models stay as they are for
the same reason.

The old list is kept beside the new file (:data:`BACKUP_NAME`); the tags themselves are not touched.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.tags import TagStore

#: The workspace-wide list as it was, written next to ``tag_groups.json`` before the split.
BACKUP_NAME = "tag_groups.workspace-list.json"


def per_model(old: list) -> dict[str, list[dict]]:
    """``{model: [group, …]}`` from the workspace-wide list and the tags the models carry."""
    from prism_lca.engine.tag_groups import TagGroupStore, palette_color
    from prism_lca.engine.tag_scope import MODEL, tag_kind

    listed = [g for g in old if isinstance(g, dict) and g.get("name")]
    store = TagStore()
    out: dict[str, list[dict]] = {}
    for database in sorted(get_bd().databases):
        if tag_kind(database) != MODEL:
            continue
        carried = store.carried(database)
        if not carried:
            continue
        groups: list[dict] = []
        for g in listed:
            if g["name"] in carried and not any(have["name"] == g["name"] for have in groups):
                values = [v for v in g.get("values") or [] if v in carried[g["name"]]]
                groups.append({"name": g["name"], "color": g.get("color") or palette_color(groups), "values": values})
        TagGroupStore._absorb(groups, carried)  # carried, never listed: appended, with a colour of its own
        out[database] = groups
    return out
