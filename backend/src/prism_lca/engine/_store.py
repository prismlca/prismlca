"""The one implementation of "a JSON file under ``prism_meta``" — and the registry of the stores
that hold per-model data.

Twelve stores each hand-rolled the same three functions (path under the active project's
``prism_meta`` dir, read, atomic tmp+replace write), four of them with the same copy-pasted comment
about concurrent readers — and the copies had drifted into five different load-error policies and
two lock conventions. Worse, the rename/delete cascade over those stores was written out by hand in
``brightway_repository`` (11 imports per cascade), and "forgot to add the new store to the cascade"
has already shipped once: deleting model "X" left its reports in the file, and creating a new model
named "X" resurrected them (see ``report_store.remove_database``). The registry at the bottom is the
fix for that class: a per-model store registers ONCE, and every cascade iterates the registry.

What deliberately did NOT move here: the JSONL append logs (``gate_journal``, ``audit_store``) have
a different shape and their own rotation/counting logic; the audit log is additionally *history* and
must survive a model deletion. ``params`` holds its per-model data in bw2data rows, not JSON, and
its rename has ordering constraints (dump before Brightway's rename, load after), so it stays an
explicit step beside the registry. Bundle export/import (``bundle.py``) is per-section IO with
bespoke logic per store, not a copy of this cascade.

On-disk format is untouched: same serialisation (``ensure_ascii=False, indent=1``), same paths,
same keys — only the code sharing changed.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, ClassVar, Literal

from prism_lca.engine.bootstrap import get_bd


def now_iso() -> str:
    """UTC timestamp as full isoformat (microseconds, +00:00 offset) — the store/command format.

    Two timestamp shapes exist on disk and BOTH are pinned by stored data: this one (commands, chats,
    reports) and `now_z` (review/research logs, seconds + "Z"). Consolidated per shape; converging on
    one shape would rewrite what existing files mean, for no reader's benefit.
    """
    return datetime.now(UTC).isoformat()


def now_z() -> str:
    """UTC timestamp truncated to seconds with a "Z" — the review/research-log format. See `now_iso`."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


#: How a store reads a file that exists but cannot be parsed:
#:
#: - ``"propagate"`` — the exception bubbles (surfaces as a 500). The strict default: most stores
#:   had no handler at all, and silently treating config as empty would let the very next write
#:   atomically replace the whole file.
#: - ``"empty"`` — any error yields the default. For caches of things that can be rebuilt or
#:   re-recorded (chats, logs, skills), where refusing to start over a half-written file from a
#:   hard kill would be worse than losing it.
#: - ``"empty_io"`` — like ``"empty"`` but only for OSError/JSONDecodeError, the two a hard kill or
#:   a locked file actually produces; a programming error still bubbles.
LoadPolicy = Literal["propagate", "empty", "empty_io"]


def prism_meta_dir() -> Path:
    """The active project's ``prism_meta`` directory — where every PrismLCA-side store lives."""
    return Path(get_bd().projects.dir) / "prism_meta"


def read_json(path: Path, *, default: Any, on_error: LoadPolicy = "propagate") -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        if on_error in ("empty", "empty_io"):
            return default
        raise
    except Exception:
        if on_error == "empty":
            return default
        raise


def write_json_atomic(path: Path, data: Any, *, sort_keys: bool = False) -> None:
    """Atomic replace: readers may hit these files concurrently from the threadpool, and a plain
    write_text (truncate-then-write) could expose a half-written file to a reader."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=sort_keys), encoding="utf-8")
    tmp.replace(path)


class JsonFileStore:
    """Base for a store that is one JSON file under ``prism_meta``.

    Subclasses set ``FILENAME``, ``ON_ERROR`` and ``_default()``; irregular stores (per-model files,
    two files) use :func:`read_json`/:func:`write_json_atomic` directly and still share the lock.

    ``_lock`` is **per subclass** and reentrant, and every read-modify-write mutator must hold it:
    atomic replace protects *readers*, but nothing used to protect two concurrent writers from a
    lost update — ten of the fourteen stores mutated unlocked despite their own comments about
    concurrent threadpool access. Reentrant because a mutator holding the lock may call ``_load``,
    which some stores (scenarios) let write a migration back.
    """

    FILENAME: ClassVar[str] = ""
    ON_ERROR: ClassVar[LoadPolicy] = "propagate"
    #: Serialisation detail some stores opt into (view_store); part of the on-disk format.
    SORT_KEYS: ClassVar[bool] = False

    _locks: ClassVar[dict[str, threading.RLock]] = {}

    @property
    def _lock(self) -> threading.RLock:
        # One lock per concrete store class, shared by all its instances — the stores are stateless
        # and constructed ad hoc all over the codebase, so an instance-level lock would guard nothing.
        return type(self)._locks.setdefault(type(self).__name__, threading.RLock())

    def _default(self) -> Any:
        return {}

    def _path(self) -> Path:
        return prism_meta_dir() / self.FILENAME

    def _load(self) -> Any:
        return read_json(self._path(), default=self._default(), on_error=self.ON_ERROR)

    def _save(self, data: Any) -> None:
        write_json_atomic(self._path(), data, sort_keys=self.SORT_KEYS)


@dataclass(frozen=True)
class ModelScopedStore:
    """One per-model store, as the cascade sees it: a name and the two lifecycle moves."""

    name: str
    rename: Callable[[str, str], None]
    remove: Callable[[str], None]


def per_model_stores() -> list[ModelScopedStore]:
    """Every store that keys data by foreground-database name, in the cascade's order.

    Imported lazily — the stores import this module for the base class. A new per-model store is
    added HERE and nowhere else; the rename/delete cascades in ``brightway_repository`` iterate
    this list, and ``tests/test_store_base.py`` fails if a store module grows a
    ``rename_database`` that is not registered.
    """
    from prism_lca.engine import model_folders, parameter_groups
    from prism_lca.engine.chat_store import ChatStore
    from prism_lca.engine.report_store import ReportStore
    from prism_lca.engine.research_log import ResearchLogStore
    from prism_lca.engine.review_log import ReviewLogStore
    from prism_lca.engine.scenarios import ScenarioStore
    from prism_lca.engine.study import StudyMetaStore
    from prism_lca.engine.tags import TagStore
    from prism_lca.engine.view_store import ViewStore

    return [
        ModelScopedStore("tags", TagStore().rename_database, TagStore().remove_database),
        ModelScopedStore("chats", ChatStore().rename_database, ChatStore().remove_database),
        ModelScopedStore("parameter_groups", parameter_groups.rename_database, parameter_groups.remove_database),
        ModelScopedStore("scenarios", ScenarioStore().rename_database, ScenarioStore().remove_database),
        ModelScopedStore("study", StudyMetaStore().rename_database, StudyMetaStore().remove_database),
        ModelScopedStore("reports", ReportStore().rename_database, ReportStore().remove_database),
        ModelScopedStore("research_log", ResearchLogStore().rename_database, ResearchLogStore().remove_database),
        ModelScopedStore("review_log", ReviewLogStore().rename_database, ReviewLogStore().remove_database),
        ModelScopedStore("views", ViewStore().rename_database, ViewStore().remove_database),
        # Folder membership is keyed by model name too. It used to be moved only by the API route,
        # so a rename through the repository (bundle import, tests) stranded it silently.
        ModelScopedStore("model_folders", model_folders.rename_database, model_folders.forget_database),
    ]
