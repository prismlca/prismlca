"""How a model looks and what it compares — the view state that belongs to the model, not to a browser.

Until 2026-07-31 this lived in the renderer's `localStorage`: the canvas positions and which
background datasets were pinned on it (`prism.canvas.<db>`), the node colours (`prism.nodeColors`,
stored *globally* at that — unlike everything else about the canvas), and the results and
detailed-results setup (`prism.ov.*`, `prism.dr.*`). That is a browser profile, not a project: it
does not travel to another machine, a reinstall drops it, "clear application data" takes it, and in
development it once disappeared because Vite came up on port 5174 instead of 5173.

The arrangement of a canvas is authored work — somebody dragged those nodes — and the results setup
is the choice of what a study compares. Both belong here, beside the tags and the scenarios, which
also means they can travel in a model bundle.

The renderer keeps a `localStorage` copy as a **write-behind cache**: it draws from it at once so
opening a model does not wait for a round trip, then takes what this store says when the two differ.
The truth is here.

Shape (`prism_meta/views.json`)::

    {"schema": 1, "models": {"<database>": {"layout": {...}, "colors": {...}, "groups": [...],
                                            "results": {...}, "detailed": {...}}}}

**Unknown keys are preserved.** A newer PrismLCA writes a section this version has never heard of; a PUT
from this version must not delete it. Same rule as the model bundle — practised here first, where the
cost of getting it wrong is one model's view rather than somebody's export.
"""
from __future__ import annotations

import re
from typing import Any

from prism_lca.engine._store import JsonFileStore, read_json

#: Bumped only for a change a reader cannot handle additively. New sections are new keys, not v2.
SCHEMA = 1

#: The sections a client may send. Anything else in a model's entry is somebody else's — carried
#: through untouched rather than dropped (see the module docstring).
#: ``short_report`` holds the two parts of the short report's setup that belong to one model: the title and
#: subtitle (``head``), which name a study, and the variants it compares (``compare``), which are the model's
#: own scenarios and processes.
KNOWN = ("layout", "colors", "groups", "results", "detailed", "short_report")


# --- compare-subject keys ----------------------------------------------------------------------
#
# The Results page keys a compare subject RELATIVE to the model whose view it is: an own process is
# ``code`` / ``code#scenario``, anything else ``database/code``, every part percent-escaped for ``%``,
# ``/`` and ``#`` (frontend ``lib/subjectKey.ts`` — the two must agree). The helpers below are what the
# backend needs of that: follow a renamed model, and follow scenarios that got new ids on import.


#: ``results.keys`` of a section in this key form — ``SUBJECT_KEYS_VERSION`` in the frontend.
SUBJECT_KEYS_VERSION = 2


def _enc(part: str) -> str:
    return part.replace("%", "%25").replace("/", "%2F").replace("#", "%23")


def _dec(part: str) -> str:
    return part.replace("%23", "#").replace("%2F", "/").replace("%25", "%")


def rename_in_view(view: dict, old: str, new: str, codes: set[str] | None = None) -> bool:
    """Point one model's view at a model renamed ``old`` → ``new``: its compare entries from that model,
    the colour and reference keys naming it, the detailed-results subject, and the canvas keys
    (:func:`rename_canvas_keys`). True when changed."""
    changed = False

    def entry(x: Any) -> Any:
        nonlocal changed
        if isinstance(x, dict) and x.get("database") == old:
            changed = True
            return {**x, "database": new}
        return x

    src, dst = f"{_enc(old)}/", f"{_enc(new)}/"

    def key(k: Any) -> Any:
        nonlocal changed
        if isinstance(k, str) and k.startswith(src):
            changed = True
            return dst + k[len(src):]
        return k

    results = view.get("results")
    if isinstance(results, dict):
        for name in ("fgSubjects", "bgSubjects"):
            if isinstance(results.get(name), list):
                results[name] = [entry(x) for x in results[name]]
        # Keys only in a migrated section (``keys`` ≥ SUBJECT_KEYS_VERSION): in an older one ``B/x`` may
        # be the model's OWN code "B/x", and only the renderer's migration on the next open can tell —
        # against the entries, which are renamed above either way.
        keys = results.get("keys")
        if isinstance(keys, int) and keys >= SUBJECT_KEYS_VERSION:
            if isinstance(results.get("colors"), dict):
                results["colors"] = {key(k): v for k, v in results["colors"].items()}
            if "refCode" in results:
                results["refCode"] = key(results["refCode"])
    detailed = view.get("detailed")
    if isinstance(detailed, dict) and "subject" in detailed:
        detailed["subject"] = entry(detailed["subject"])
    return rename_canvas_keys(view, old, new, codes) or changed


#: A copy of a dataset placed on the canvas and not connected yet: ``<node id>#new-<n>`` (lib/occurrences.ts).
_COPY_SUFFIX = re.compile(r"#new-\d+$")


def rename_canvas_keys(view: dict, old: str, new: str, codes: set[str] | None = None) -> bool:
    """The canvas half of :func:`rename_in_view`: node ids are ``<database>/<code>`` unescaped, so the
    positions, the node colours, the group boxes and the placed reference boxes of a renamed (or
    imported-under-another-name) model all name it. With the model's ``codes`` a key moves exactly when
    it names one of them — a code may hold a ``/``, and ``A/B/x`` may be a model called ``A/B``. Without
    them (the renderer's cache has no codes) the rest has to be one plain code. True when anything changed."""
    changed = False
    prefix = f"{old}/"

    def ours(rest: str) -> bool:
        return _COPY_SUFFIX.sub("", rest) in codes if codes is not None else "/" not in rest

    def node(k: Any) -> Any:
        nonlocal changed
        if isinstance(k, str) and k.startswith(prefix) and ours(k[len(prefix):]):
            changed = True
            return f"{new}/{k[len(prefix):]}"
        return k

    layout = view.get("layout")
    if isinstance(layout, dict):
        if isinstance(layout.get("pos"), dict):
            layout["pos"] = {node(k): v for k, v in layout["pos"].items()}
        if isinstance(layout.get("refs"), list):
            layout["refs"] = [
                {**r, "id": node(r.get("id")), **({"dataset_id": node(r["dataset_id"])} if "dataset_id" in r else {})}
                if isinstance(r, dict)
                else r
                for r in layout["refs"]
            ]
    if isinstance(view.get("colors"), dict):
        view["colors"] = {node(k): v for k, v in view["colors"].items()}
    if isinstance(view.get("groups"), list):
        view["groups"] = [
            {**g, "members": [node(m) for m in g["members"]]}
            if isinstance(g, dict) and isinstance(g.get("members"), list)
            else g
            for g in view["groups"]
        ]
    return changed


def remap_scenarios_in_view(view: dict, mapping: dict[str, str]) -> dict:
    """The view of an imported model, with the scenario ids that could not be kept replaced by the ones
    they got (``read_scenarios``): the ticks, the scenario colours, a scenario reference, the detailed
    subject and its variants, and the short report's variants. Without it the page pruned the ticks as "deleted scenarios" and a
    comparison of variants had nothing left to compute."""
    if not mapping:
        return view
    out = dict(view)

    def own_variant(key: Any) -> Any:
        """``code#scenario`` of an own process (no ``/`` before the ``#``), with the scenario followed."""
        if isinstance(key, str) and "#" in key and "/" not in key.split("#", 1)[0]:
            base, scen = key.split("#", 1)
            if _dec(scen) in mapping:
                return f"{base}#{_enc(mapping[_dec(scen)])}"
        return key

    results = out.get("results")
    if isinstance(results, dict):
        results = dict(results)
        if isinstance(results.get("scenSel"), dict):
            results["scenSel"] = {mapping.get(k, k): v for k, v in results["scenSel"].items()}
        if isinstance(results.get("colors"), dict):
            # Keyed by a bare scenario id, or by a variant ``code#scenario`` — both follow.
            results["colors"] = {own_variant(mapping.get(k, k)): v for k, v in results["colors"].items()}
        if "refCode" in results:
            results["refCode"] = own_variant(results["refCode"])
        out["results"] = results
    detailed = out.get("detailed")
    if isinstance(detailed, dict):
        detailed = dict(detailed)
        subject = detailed.get("subject")
        if isinstance(subject, dict) and subject.get("scenario") in mapping:
            detailed["subject"] = {**subject, "scenario": mapping[subject["scenario"]]}
        if isinstance(detailed.get("variants"), list):
            detailed["variants"] = [mapping.get(v, v) if isinstance(v, str) else v for v in detailed["variants"]]
        out["detailed"] = detailed
    short = out.get("short_report")
    if isinstance(short, dict) and isinstance(short.get("compare"), list):
        out["short_report"] = {
            **short,
            "compare": [
                {**v, "scenario": mapping[v["scenario"]]}
                if isinstance(v, dict) and v.get("scenario") in mapping
                else v
                for v in short["compare"]
            ],
        }
    return out


def _codes_of(database: str) -> set[str] | None:
    """The process codes of a model that has just been renamed — what its canvas keys end in."""
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    return {a.key[1] for a in bd.Database(database)} if database in bd.databases else None


class ViewStore(JsonFileStore):
    FILENAME = "views.json"
    SORT_KEYS = True

    def _default(self) -> dict:
        return {"schema": SCHEMA, "models": {}}

    def _load(self) -> dict:
        # A half-written file from a hard kill: an unreadable view must not stop the app —
        # the model itself is intact, and the renderer's cache still has the arrangement.
        data = read_json(self._path(), default=self._default(), on_error="empty_io")
        if isinstance(data, dict) and isinstance(data.get("models"), dict):
            return data
        return self._default()

    def get(self, database: str) -> dict:
        """The model's whole view entry, `{}` when it has none yet."""
        return self._load()["models"].get(database, {})

    def put(self, database: str, view: dict) -> dict:
        """Replace the sections the client sent; leave every other key of the entry alone.

        Not a blind overwrite: a client that does not know about a section must not be able to delete
        it. That is what makes a newer version's data survive an older version being run once.
        """
        with self._lock:
            if not isinstance(view, dict):
                raise TypeError("A view must be an object.")
            data = self._load()
            entry = dict(data["models"].get(database, {}))
            for key, value in view.items():
                if value is None:
                    entry.pop(key, None)  # explicit null clears a section — a client may reset one
                else:
                    entry[key] = value
            data["models"][database] = entry
            data["schema"] = SCHEMA
            self._save(data)
            return entry

    def rename_database(self, old: str, new: str) -> None:
        """Follow a renamed model, or its view strands under the dead name (it used to, silently).

        Not only its own entry: every other model that compares one of its processes names it too —
        as the entry's database and in the ``old/…`` colour and reference keys. Left alone, the subject
        vanished from that comparison, and a new model given the old name later would take its place.
        """
        with self._lock:
            data = self._load()
            models = data["models"]
            changed = False
            codes = _codes_of(new)
            entry = models.pop(old, None)
            if entry is not None:
                models[new] = entry
                changed = True
            for view in models.values():
                if isinstance(view, dict) and rename_in_view(view, old, new, codes):
                    changed = True
            if changed:
                self._save(data)

    def remove_database(self, name: str) -> None:
        with self._lock:
            data = self._load()
            if data["models"].pop(name, None) is not None:
                self._save(data)

    def all_models(self) -> list[str]:
        """Which models have a stored view — for the renderer's one-time migration check."""
        return sorted(self._load()["models"])
