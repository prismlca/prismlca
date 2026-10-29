"""Where a tag may sit, and how an input's tag finds its exchange.

Tags are study data. A process carries one only inside a **model** database; an input (technosphere
exchange) carries one only when its consumer is in a model and its supplier is **not in that same model** —
a background dataset, a library process, or another model's process. Everything else is refused, by name:

* a background dataset is shared by every model of the workspace and occurs all over every supply chain, so a
  tag on it would act everywhere at once — the place to say "this steel is raw material" is the input;
* the library is reused across studies, so a phase written into it would follow the process into each of
  them — the study tags the input that draws on it;
* a supplier inside the same model is tagged on the process itself, so a model never says one thing about a
  process and another about the way it is used.
"""
from __future__ import annotations

import re

from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

MODEL, LIBRARY, BACKGROUND, BIOSPHERE = "model", "library", "background", "biosphere"

#: An exchange uid as model.new_uid() writes it.
UID_RE = re.compile(r"^[0-9a-f]{32}$")


def tag_kind(database: str) -> str:
    """What a database is for tagging purposes. A database without any marker counts as a model."""
    from prism_lca.engine.backgrounds.common import BIOSPHERE_DB, is_background
    from prism_lca.engine.library import is_library

    if database == BIOSPHERE_DB:
        return BIOSPHERE
    if is_library(database):
        return LIBRARY
    if is_background(database):
        return BACKGROUND
    return MODEL


def kind_checker():
    """``tag_kind`` memoised for one traversal or one request."""
    seen: dict[str, str] = {}

    def kind(database: str) -> str:
        if database not in seen:
            seen[database] = tag_kind(database)
        return seen[database]

    return kind


def check_process_target(database: str, code: str) -> None:
    """Refuse a process tag outside a model database (see the module docstring)."""
    kind = tag_kind(database)
    if kind == MODEL:
        return
    if kind == LIBRARY:
        raise PrismError(
            f"'{code}' is a library process; the library carries no tags.",
            code="tag_target_library",
            hint="Tag the input of the model process that uses it instead: keys: [{ uid }] with the exchange "
            "uid from get_model_graph.",
        )
    raise PrismError(
        f"'{database}' is a background database; its datasets cannot carry tags.",
        code="tag_target_background",
        hint="A tag on a background dataset would act in every model and every supply chain. Tag the input "
        "that brings it into the model instead: keys: [{ uid }] with the exchange uid from get_model_graph.",
    )


def find_input(uid: str, database: str | None = None):
    """``(consumer activity, exchange)`` for an exchange uid, searched in ``database`` or every model.

    Refuses an unknown uid and one found twice (two models hold an exchange with that uid only after a bug
    or a hand edit, and guessing between them would tag the wrong model)."""
    bd = get_bd()
    if not uid or not isinstance(uid, str):
        raise PrismError("An input key needs the exchange uid.", code="tag_target_no_uid")
    names = [database] if database else [n for n in bd.databases if tag_kind(n) == MODEL]
    hits = []
    for name in names:
        if name not in bd.databases:
            raise PrismError(f"Database '{name}' does not exist.", code="database_not_found", status_code=404)
        for act in bd.Database(name):
            for ex in act.exchanges():
                if ex.get("prism_uid") == uid:
                    hits.append((act, ex))
    if not hits:
        raise PrismError(
            f"No input with uid '{uid}'.",
            code="exchange_not_found",
            status_code=404,
            hint="Take the uid from the edges of get_model_graph or from get_process_details.",
        )
    if len(hits) > 1:
        raise PrismError(f"The uid '{uid}' occurs {len(hits)} times.", code="exchange_uid_ambiguous", status_code=409)
    return hits[0]


def check_input_target(consumer, exchange) -> None:
    """Refuse an input tag that the rules do not allow (see the module docstring)."""
    if exchange.get("type") not in ("technosphere", "substitution"):
        raise PrismError(
            "Only inputs can carry a tag of their own, not a production or elementary flow.",
            code="tag_target_not_input",
        )
    if tag_kind(consumer.key[0]) != MODEL:
        raise PrismError(
            f"'{consumer.get('name')}' is not in a model; only a model's inputs carry tags.",
            code="tag_target_not_model",
        )
    supplier = exchange.input
    if supplier.key[0] == consumer.key[0]:
        raise PrismError(
            f"'{supplier.get('name')}' is a process of this model; tag the process itself.",
            code="tag_target_same_model",
            hint="An input tag is for what a model draws from outside it: background, library, another model.",
        )


def resolve_keys(keys: list[dict], *, inputs_allowed: bool = True) -> list[tuple[str, str]]:
    """Validated store keys ``(database, code)`` for a tag selection, in order, without duplicates.

    Each item is either a process ``{database, code}`` or an input ``{uid}`` / ``{database, uid}``; an input
    becomes ``(model, consumer_code#uid)``. Every key is checked before anything is written, so a selection
    with one bad key changes nothing."""
    from prism_lca.engine import model as _model
    from prism_lca.engine.tags import TagStore

    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in keys:
        uid, database, code = item.get("uid"), item.get("database"), item.get("code")
        if uid and code:
            raise PrismError("A tag key names a process ({database, code}) or an input ({uid}), not both.",
                             code="tag_key_ambiguous")
        if uid:
            if not inputs_allowed:
                raise PrismError("Inputs are tagged through /model/tags/set (one value per group).",
                                 code="tag_key_input_here")
            consumer, ex = find_input(uid, database)
            check_input_target(consumer, ex)
            key = (consumer.key[0], TagStore.exchange_code(consumer.key[1], uid))
        else:
            if not database or not code:
                raise PrismError("A process key needs database and code.", code="tag_key_incomplete")
            if TagStore.split_code(code)[1]:
                raise PrismError("Name an input by its uid, not by a composed code.", code="tag_key_composed")
            _model.get_activity(database, code)  # 404 for a code that does not exist (V425)
            check_process_target(database, code)
            key = (database, code)
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


# --- tags that travel with a copy ---------------------------------------------------------------
def copy_process_tags(store, src: tuple[str, str], dst: tuple[str, str], exchange_uids) -> list[str]:
    """Copy a process's own tags and its inputs' tags onto a copy of it (only into a model).

    ``exchange_uids`` pairs each source exchange uid with the uid its copy got. Returns the keys written,
    so undo can take exactly those back."""
    from prism_lca.engine.tags import TagStore

    if tag_kind(dst[0]) != MODEL:
        return []
    written: list[str] = []
    pairs = [(src[1], dst[1])] + [
        (TagStore.exchange_code(src[1], old), TagStore.exchange_code(dst[1], new))
        for old, new in exchange_uids
        if old and new
    ]
    for old_code, new_code in pairs:
        for tag in store.list_for(src[0], old_code):
            store.set_tag(dst[0], new_code, tag["dimension"], tag["value"])
            written.append(f"{dst[0]}/{new_code}")
    return sorted(set(written))


def drop_keys(store, keys: list[str]) -> None:
    """Remove every tag of the given store keys (undo of a copy)."""
    if keys:
        store.rewrite_lists({k: [] for k in keys})
