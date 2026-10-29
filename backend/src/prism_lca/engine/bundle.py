"""A model as a file: export and import of a `.prism` bundle.

What Brightway offers does not fit. `BW2Package` writes Brightway's internals and is coupled to its
version; the Excel exporters are lossy; `backup_project_directory()` tars the whole project *including
the ecoinvent copy*, which must not leave the machine. And none of them knows what a PrismLCA model
is:
a foreground graph **plus** parameters with their value rules, tags, scenarios, study metadata, report
definitions and a canvas arrangement.

So: a ZIP of independent sections, each with its own `schema` number, described by a manifest.

**The registry is the additive rule.** A new stored thing is a new entry in `SECTIONS`, never a change
to an existing writer — which is what keeps old bundles readable as the app grows. Three properties
follow and each has a test:

* **Unknown sections are kept, not dropped.** A bundle written by a newer PrismLCA imports as far as this
  one understands and the sections it has never heard of are stored verbatim (`bundle_unknown`), so a
  round trip through an older version does not destroy what a newer one wrote. A newer shape of a
  section it does know is named in the preview and left out — and refused when it is the model itself.
* **Deterministic.** Sorted keys, no timestamp in the content, fixed member order and a fixed ZIP date
  — two exports of the same model are byte-identical, which is what makes a checksum mean something
  and a diff readable.
* **No licensed data.** Background datasets are *referenced*, never copied: `(database, code)` plus a
  fingerprint so the import can find them again (see `bundle_resolve`). Exporting a read-only
  background database is refused rather than helpfully attempted.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import uuid
import zipfile
from collections.abc import Callable
from typing import Any

from prism_lca.engine import model as _model
from prism_lca.engine import parameter_groups
from prism_lca.engine import params as _params
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.bundle_backgrounds import (
    background_providers,
    background_versions,
    installed_backgrounds,
)
from prism_lca.engine.bundle_resolve import Installed, Reference, fingerprint_of
from prism_lca.engine.bundle_tags import (
    EXCHANGE_TAGS_KEY,
    apply_row_tags,
    read_tags,
    row_tags,
    write_tags,
)
from prism_lca.engine.bundle_unknown import stored_unknown
from prism_lca.engine.guardrails import is_read_only, set_read_only
from prism_lca.engine.library import (
    BATCH_KEY,
    BATCH_LABEL_KEY,
    DATE_KEY,
    FORMAT_KEY,
    LIBRARY_DB,
    SOURCE_KEY,
    ensure_library,
    is_library,
    new_batch,
    stamp,
)
from prism_lca.errors import PrismError

#: Format version of the bundle as a whole. Sections carry their own; this one changes only if the
#: container itself does (the manifest's shape, the member layout).
FORMAT = 1

EXTENSION = ".prism"

#: Fixed date for every ZIP member: a timestamp would make two exports of the same model differ.
_ZIP_DATE = (2026, 1, 1, 0, 0, 0)


# --- what a section is ------------------------------------------------------------------------


class Section:
    """One file in the bundle: how to write it, how to read it back, and whether it is required."""

    def __init__(
        self,
        name: str,
        schema: int,
        writer: Callable[[str], Any],
        reader: Callable[[str, Any], None],
        *,
        required: bool = False,
        preset: str = "model",
        schema_for: Callable[[Any], int] | None = None,
    ) -> None:
        self.name = name
        #: The newest shape this version reads (and writes).
        self.schema = schema
        #: The schema a given payload is written under, when that depends on the content: a payload
        #: that uses nothing newer is declared under the old number, so an older PrismLCA still reads it.
        self.schema_for = schema_for
        self.writer = writer
        self.reader = reader
        self.required = required
        #: "model" = in every export; "full" = only when the user asked for everything.
        self.preset = preset

    @property
    def file(self) -> str:
        return f"{self.name}.json"


# --- graph ------------------------------------------------------------------------------------


def _fg_or_400(database: str) -> str:
    bd = get_bd()
    if database not in bd.databases:
        raise PrismError(
            f"Database '{database}' does not exist.", code="database_not_found", status_code=404
        )
    if is_read_only(database):
        raise PrismError(
            f"'{database}' is a background database and cannot be exported as a model.",
            code="read_only_database",
            status_code=409,
            hint="A bundle carries your own model and references background data — it never copies it, "
            "because that data is licensed.",
        )
    return database


#: Activity fields carried verbatim. Everything else Brightway keeps is derived or ours to rebuild.
_ACT_FIELDS = ("name", "unit", "location", "reference product", "comment", "type")
#: What a model's own process carries beyond that, and only there (a library dataset keeps the fields
#: above): its ISIC/CPC classification and our override of it, its documentation, and the marker that
#: ties the reference flow to a parameter. Left out, a full export came back without them and the
#: results grouped by ISIC or CPC changed.
_MODEL_ACT_FIELDS = (
    *_ACT_FIELDS,
    "classifications",
    "prism_isic",
    "prism_cpc",
    "prism_cpc_name",
    "prism_doc",
    "prism_ref_quantity",
)
#: Exchange fields, including the two the XLSX round trip dropped: the formula and the uncertainty —
#: and the product properties (dry mass, density …) and the spread a pedigree was applied on top of.
_EXC_FIELDS = (
    "amount",
    "type",
    "formula",
    "comment",
    "uncertainty type",
    "loc",
    "scale",
    "minimum",
    "maximum",
    "pedigree",
    "scale without pedigree",
    "properties",
)


def write_graph(database: str) -> dict:
    """Activities and exchanges, with every background input described well enough to find again."""
    from prism_lca.engine.tags import TagStore

    bd = get_bd()
    db = bd.Database(database)
    tag_map = TagStore().load_map()  # an input's own tags ride on its row (bundle_tags.row_tags)
    activities: list[dict] = []
    exchanges: list[dict] = []
    refs: dict[tuple[str, str], dict] = {}

    for act in sorted(db, key=lambda a: a.key[1]):
        activities.append(
            {"code": act.key[1], **{k: act.get(k) for k in _MODEL_ACT_FIELDS if act.get(k) is not None}}
        )
        for ex in sorted(
            act.exchanges(), key=lambda e: (e.input.key[0], e.input.key[1], e.get("type") or "")
        ):
            inp = ex.input
            row = {
                "activity": act.key[1],
                "input_database": inp.key[0],
                "input_code": inp.key[1],
                **{k: ex.get(k) for k in _EXC_FIELDS if ex.get(k) is not None},
            }
            row.update(row_tags(tag_map, database, act, ex))
            exchanges.append(row)
            # A reference is only interesting when it points *out* of this model.
            if inp.key[0] != database and inp.key not in refs:
                refs[inp.key] = {
                    "database": inp.key[0],
                    "code": inp.key[1],
                    "name": inp.get("name") or "",
                    "reference_product": inp.get("reference product") or "",
                    "location": inp.get("location") or "",
                    "unit": inp.get("unit") or "",
                }
    return {
        "database": database,
        "activities": activities,
        "exchanges": exchanges,
        # Sorted so two exports agree byte for byte.
        "references": [refs[k] for k in sorted(refs)],
    }


#: Import-time hand-over from the graph section to the view section: new model name → old one.
_IMPORTED_FROM: dict[str, str] = {}


def read_graph(database: str, data: Any) -> None:
    """Recreate the graph under `database`. Called with every reference already resolved."""
    bd = get_bd()
    if database in bd.databases:
        raise PrismError(f"'{database}' already exists.", code="database_exists", status_code=409)
    db = bd.Database(database)
    db.register(searchable=False)  # no bw2data FTS index — see engine/hygiene.py
    try:
        _write_graph_rows(db, database, data)
    except Exception as exc:
        # A malformed row halfway down left a registered model with half its processes — read-only, as
        # every freshly registered database is, so it even looked like a background. It goes again.
        from prism_lca.engine.brightway_repository import BrightwayRepository

        set_read_only(database, False)
        BrightwayRepository().delete_foreground_database(database)
        if isinstance(exc, (KeyError, TypeError)):  # a row without a field every row has
            raise _damaged("graph.json") from exc
        raise
    # The name the model had in the sender's project, for the view section: its canvas keys carry it.
    _IMPORTED_FROM[database] = str(data.get("database") or "")


def _write_graph_rows(db: Any, database: str, data: Any) -> None:
    """The processes, then their exchanges with links re-pointed through the resolved mapping."""
    mapping: dict[tuple[str, str], tuple[str, str]] = data.get("_mapping") or {}
    for row in data.get("activities") or []:
        fields = {k: v for k, v in row.items() if k != "code"}
        fields.setdefault("type", "process")
        db.new_activity(code=row["code"], **fields).save()

    from prism_lca.engine.tags import TagStore

    tag_store = TagStore()  # see bundle_tags.apply_row_tags
    # Per row, the uid it got the first time (ImportBundleCommand passes the same dict on redo, so a later
    # step that addresses an imported exchange by uid still finds it).
    uids: dict | None = data.get("_uids")
    for i, row in enumerate(data.get("exchanges") or []):
        act = db.get(row["activity"])
        src = (row["input_database"], row["input_code"])
        # A reference to the model itself keeps pointing at the model, under its new name.
        target = (database, src[1]) if src[0] == data.get("database") else mapping.get(src, src)
        fields = {
            k: v for k, v in row.items()
            if k not in ("activity", "input_database", "input_code", EXCHANGE_TAGS_KEY)
        }
        uid = uids.setdefault(i, _model.new_uid()) if uids is not None else None
        apply_row_tags(tag_store, database, act, act.new_exchange(input=(target[0], target[1]), **fields), row, uid)
    # A bundle carries no exchange uids (they are per model); without fresh ones the imported
    # model's exchanges could be seen but not edited.
    _model.ensure_exchange_uids(database)


def graph_references(data: Any) -> list[Reference]:
    """The background references a graph section needs, for the resolution ladder."""
    return [
        Reference(
            database=r.get("database", ""),
            code=r.get("code", ""),
            name=r.get("name", ""),
            reference_product=r.get("reference_product", ""),
            location=r.get("location", ""),
            unit=r.get("unit", ""),
            version=r.get("version", ""),
        )
        for r in (data.get("references") or [])
    ]


# --- library: the user's own datasets the model draws on --------------------------------------

#: The provenance an imported library dataset already carries; travels with it so the receiver sees
#: where the original came from, not only that it arrived in a bundle.
_LIBRARY_PROVENANCE = (SOURCE_KEY, FORMAT_KEY, BATCH_KEY, BATCH_LABEL_KEY, DATE_KEY)
#: Fields a library dataset carries verbatim (the import wizard's parked-flows note and its
#: unbooked co-products included — see dataimport.session.COPRODUCTS_KEY).
_IMPORT_NOTES = ("prism_unmatched", "prism_coproducts")
_LIB_FIELDS = (*_ACT_FIELDS, *_IMPORT_NOTES, *_LIBRARY_PROVENANCE)


def _library_closure(database: str) -> list[Any]:
    """Every library dataset the model reaches: directly, and through other library datasets.

    A library dataset may itself draw on another one (a part built from a material the user also
    keeps there); shipping only the first layer would leave the receiver's copy dangling one hop in.
    Backgrounds are never followed — they are referenced, not carried (the licence rule).
    """
    bd = get_bd()
    if LIBRARY_DB not in bd.databases:
        return []
    lib = bd.Database(LIBRARY_DB)
    wanted: list[str] = []
    seen: set[str] = set()
    for act in bd.Database(database):
        for ex in act.exchanges():
            if ex.input.key[0] == LIBRARY_DB and ex.input.key[1] not in seen:
                seen.add(ex.input.key[1])
                wanted.append(ex.input.key[1])
    out = []
    i = 0
    while i < len(wanted):
        code = wanted[i]
        i += 1
        try:
            act = lib.get(code)
        except Exception:  # noqa: BLE001 - a dangling link is the model's problem, not the bundle's
            continue
        out.append(act)
        for ex in act.exchanges():
            if ex.input.key[0] == LIBRARY_DB and ex.input.key[1] not in seen:
                seen.add(ex.input.key[1])
                wanted.append(ex.input.key[1])
    return sorted(out, key=lambda a: a.key[1])


def write_library(database: str) -> dict:
    """The datasets of "My processes" this model draws on — the user's own data, carried in full.

    A model that points into the library used to export those links as references only, and a receiver
    resolved them only when they happened to have the same datasets. Now the datasets travel, with their provenance, and land
    in the receiver's library as one batch (batch = bundle). Never anything from a background
    database: those stay references, here as everywhere in the bundle.
    """
    datasets: list[dict] = []
    refs: dict[tuple[str, str], dict] = {}
    for act in _library_closure(database):
        rows: list[dict] = []
        for ex in sorted(
            act.exchanges(), key=lambda e: (e.input.key[0], e.input.key[1], e.get("type") or "")
        ):
            inp = ex.input
            if inp.key == act.key and (ex.get("type") or "") == "production":
                continue  # recreated on import; the amount is 1 by construction
            rows.append(
                {
                    "input_database": inp.key[0],
                    "input_code": inp.key[1],
                    **{k: ex.get(k) for k in _EXC_FIELDS if ex.get(k) is not None},
                }
            )
            if inp.key[0] not in (LIBRARY_DB, database) and inp.key not in refs:
                refs[inp.key] = {
                    "database": inp.key[0],
                    "code": inp.key[1],
                    "name": inp.get("name") or "",
                    "reference_product": inp.get("reference product") or "",
                    "location": inp.get("location") or "",
                    "unit": inp.get("unit") or "",
                }
        datasets.append(
            {
                "code": act.key[1],
                **{k: act.get(k) for k in _LIB_FIELDS if act.get(k) is not None},
                "exchanges": rows,
            }
        )
    return {
        "database": LIBRARY_DB,
        "model": database,
        "datasets": datasets,
        "references": [refs[k] for k in sorted(refs)],
    }


def library_references(data: Any) -> list[Reference]:
    """The background references the library datasets need — resolved like the graph's."""
    return graph_references(data)


def library_codes(data: Any) -> dict[str, tuple[str, str, str, str]]:
    """``code → fingerprint`` of the datasets a bundle's library section carries."""
    return {
        d.get("code", ""): fingerprint_of(
            d.get("name") or "",
            d.get("reference product") or "",
            d.get("location") or "",
            d.get("unit") or "",
        )
        for d in (data or {}).get("datasets") or []
        if d.get("code")
    }


def read_library(database: str, data: Any) -> dict:
    """Land the bundle's library datasets in this project's "My processes".

    Returns ``{"mapping", "added", "kept"}``: ``mapping`` re-points the model's library links (a
    code taken here by a *different* dataset gets a free one), ``added`` are the codes this import
    created (what an undo removes), ``kept`` counts datasets that were already here — same code and
    same name is the same dataset, and the user's copy wins over the bundle's.
    """
    bd = get_bd()
    datasets = _carried_datasets(data)
    if not datasets:
        return {"mapping": {}, "added": [], "kept": 0}
    ensure_library()
    lib = bd.Database(LIBRARY_DB)
    lib_map, to_create, kept = _plan_library(datasets, {a.key[1]: a.get("name") or "" for a in lib})
    added: list[str] = []
    try:
        _land_library(lib, database, data, lib_map, to_create, added)
    except Exception as exc:
        remove_library_datasets(added)  # a malformed dataset halfway down takes the earlier ones back
        if isinstance(exc, (KeyError, TypeError)):
            raise _damaged("library.json") from exc
        raise
    _model.ensure_exchange_uids(LIBRARY_DB, codes=added)  # see read_graph
    return {"mapping": lib_map, "added": added, "kept": kept}


def _carried_datasets(data: Any) -> list[dict]:
    """The section's datasets that can be landed at all — the ones with a code, as `library_codes` counts."""
    return [d for d in (data or {}).get("datasets") or [] if isinstance(d, dict) and d.get("code")]


def _plan_library(
    datasets: list[dict], existing: dict[str, str]
) -> tuple[dict[tuple[str, str], tuple[str, str]], list[tuple[str, dict]], int]:
    """Which carried datasets are already here (same code AND same name — the user's copy wins) and
    which are landed, under which code. ``existing`` is ``code → name`` of "My processes". The import
    preview asks the same function, so it cannot count a renamed dataset as present."""
    taken = set(existing)
    lib_map: dict[tuple[str, str], tuple[str, str]] = {}
    to_create: list[tuple[str, dict]] = []
    kept = 0
    for ds in datasets:
        code = ds["code"]
        if code in existing and existing[code] == (ds.get("name") or ""):
            lib_map[(LIBRARY_DB, code)] = (LIBRARY_DB, code)
            kept += 1
            continue
        fresh = code
        if fresh in taken:
            n = 2
            while f"{code}-{n}" in taken:
                n += 1
            fresh = f"{code}-{n}"
        taken.add(fresh)
        lib_map[(LIBRARY_DB, code)] = (LIBRARY_DB, fresh)
        to_create.append((fresh, ds))
    return lib_map, to_create, kept


def library_preview(data: Any) -> dict:
    """``{datasets, present, new}`` for the import preview — counted by :func:`_plan_library`."""
    datasets = _carried_datasets(data)
    bd = get_bd()
    existing = {a.key[1]: a.get("name") or "" for a in bd.Database(LIBRARY_DB)} if LIBRARY_DB in bd.databases else {}
    _map, to_create, kept = _plan_library(datasets, existing)
    return {"datasets": len(datasets), "present": kept, "new": len(to_create)}


def _land_library(
    lib: Any,
    database: str,
    data: Any,
    lib_map: dict[tuple[str, str], tuple[str, str]],
    to_create: list[tuple[str, dict]],
    added: list[str],
) -> None:
    """Write the planned datasets as one batch; ``added`` grows with each code as it is created."""
    mapping: dict[tuple[str, str], tuple[str, str]] = dict(data.get("_mapping") or {})
    batch = new_batch()
    model = str(data.get("model") or database)
    provenance = stamp(f"bundle: {model}", "prism-bundle", batch, f"Bundle “{model}”")
    for fresh, ds in to_create:
        fields = {k: v for k, v in ds.items() if k in _ACT_FIELDS or k in _IMPORT_NOTES}
        fields.setdefault("type", "process")
        origin = {k: ds[k] for k in _LIBRARY_PROVENANCE if ds.get(k)}
        act = lib.new_activity(code=fresh, **fields, **provenance)
        if origin:
            act["prism_bundle_origin"] = origin  # where the dataset came from before the bundle
        act.save()
        added.append(fresh)  # before its exchanges: a failure among them must take this one back too
        act.new_edge(
            input=act,
            amount=1.0,
            type="production",
            unit=ds.get("unit") or "",
            name=ds.get("reference product") or ds.get("name") or "",
        ).save()
        for row in ds.get("exchanges") or []:
            src = (row["input_database"], row["input_code"])
            target = (
                lib_map.get(src, mapping.get(src, src))
                if src[0] == LIBRARY_DB
                else mapping.get(src, src)
            )
            # The library carries no tags; a row that brings some leaves them behind.
            exc = {k: v for k, v in row.items() if k not in ("input_database", "input_code", EXCHANGE_TAGS_KEY)}
            act.new_edge(input=(target[0], target[1]), **exc).save()


def remove_library_datasets(codes: list[str]) -> None:
    """Undo of :func:`read_library`: delete what that import created, nothing else."""
    bd = get_bd()
    if LIBRARY_DB not in bd.databases or not codes:
        return
    lib = bd.Database(LIBRARY_DB)
    for code in codes:
        try:
            lib.get(code).delete()
        except Exception:  # noqa: BLE001 - already gone
            continue


def installed_for_bundle(opened: dict) -> list[Installed]:
    """What the resolution ladder may match against for THIS bundle: every installed background,
    plus the library — including the datasets the bundle itself will land there. A model's link
    into "My processes" resolves because the section brings the dataset, not by luck."""
    installed = installed_backgrounds()
    carried = library_codes((opened.get("sections") or {}).get("library"))
    if not carried:
        return installed
    for entry in installed:
        if entry.name == LIBRARY_DB:
            entry.by_code = {**carried, **entry.by_code}
            return installed
    installed.append(Installed(name=LIBRARY_DB, version="", by_code=carried))
    return installed


def bundle_references(opened: dict) -> list[Reference]:
    """Every reference the import must resolve: the graph's and the library section's."""
    sections = opened.get("sections") or {}
    refs = graph_references(sections.get("graph") or {})
    seen = {(r.database, r.code) for r in refs}
    for r in library_references(sections.get("library") or {}):
        if (r.database, r.code) not in seen:
            refs.append(r)
            seen.add((r.database, r.code))
    return refs


# --- the other sections -----------------------------------------------------------------------


def write_parameters(database: str) -> dict:
    """Parameters with their formulas, groups and value rules (the rules live in `data`)."""
    return {
        "parameters": sorted(_params.dump_params(database), key=lambda p: p["name"]),
        "groups": sorted(parameter_groups.list_groups(database), key=lambda g: g.get("name") or ""),
    }


def read_parameters(database: str, data: Any) -> None:
    groups = {}
    # Created in their display order, which is the order they get here: the section lists them by name.
    for g in sorted(data.get("groups") or [], key=lambda g: g.get("order", 0)):
        name = g.get("name")
        if name:
            groups[g.get("id")] = parameter_groups.find_or_create(database, name)["id"]
    _params.load_params(database, data.get("parameters") or [])
    for p in data.get("parameters") or []:
        rule = (p.get("data") or {}).get("rule")
        unit = (p.get("data") or {}).get("unit")
        description = (p.get("data") or {}).get("description")
        if rule or unit or description:
            # Straight through `set_param` so the rule is validated exactly as a typed one would be.
            _params.set_param(
                database,
                p["name"],
                amount=p.get("amount"),
                formula=p.get("formula"),
                unit=unit,
                description=description,
                rule=rule,
            )
        # `dump_params` stores the assignment under `group_id` (the key `set_group` writes); the reader
        # looked for `group`, so every imported parameter landed in Ungrouped beside its empty groups
        # (seen in a frontend test). Both keys are accepted: bundles written before this fix carry
        # `group_id` only, and nothing ever wrote `group`.
        data = p.get("data") or {}
        gid = data.get("group_id") or data.get("group")
        if gid and gid in groups:
            _params.set_group(database, p["name"], groups[gid])
    # The graph reader wrote the exchanges with their `formula` text, but a formula that belongs to no
    # parameter group never recalculates — so an imported model listed its parameters, showed its
    # formulas and had scenarios, and every one of them was inert: all three scenarios of an imported
    # bottle model scored exactly the baseline while the original moved by ±5 %. Same trap, same cure as the
    # duplicate, rename and sheet-import paths.
    _params.reregister_database_groups(database)


def _scenarios_schema(payload: Any) -> int:
    """2 when a scenario carries a formula override (a string value in ``overrides``),
    else 1. An older PrismLCA keeps a schema-2 section verbatim instead of reading a formula as a number
    and failing the import; a bundle of numeric scenarios is byte-for-byte what it always was."""
    for s in (payload or {}).get("scenarios") or []:
        if any(isinstance(v, str) for v in (s.get("overrides") or {}).values()):
            return 2
    return 1


def write_scenarios(database: str) -> dict:
    from prism_lca.engine.scenarios import ScenarioStore

    return {"scenarios": ScenarioStore().list_all(database)}


#: Import-time hand-over from the scenarios section to the reports section: old id → new id per
#: model, for the ids that could not be kept (taken in this project — an import beside its source).
_IMPORTED_SCENARIO_IDS: dict[str, dict[str, str]] = {}


def read_scenarios(database: str, data: Any) -> None:
    from prism_lca.engine.scenarios import ScenarioStore

    store = ScenarioStore()
    mapping: dict[str, str] = {}
    for s in data.get("scenarios") or []:
        # Under its own id where that id is free: the reports section names its variants by scenario
        # id, and a fresh id per import left every imported comparison pointing at "deleted"
        # scenarios — a report of nothing but variants failed with report_no_subjects.
        entry = store.create(
            database,
            s.get("name") or "Scenario",
            s.get("description") or "",
            s.get("overrides") or {},
            scenario_id=s.get("id"),
        )
        if s.get("id"):
            mapping[str(s["id"])] = entry["id"]
    _IMPORTED_SCENARIO_IDS[database] = mapping


def write_study(database: str) -> dict:
    from prism_lca.engine.study import StudyMetaStore

    return {"study": StudyMetaStore().get(database)}


def read_study(database: str, data: Any) -> None:
    from prism_lca.engine.study import StudyMetaStore

    study = data.get("study") or {}
    if study:
        StudyMetaStore().replace(database, study)


def write_view(database: str) -> dict:
    from prism_lca.engine.view_store import ViewStore

    return {"view": ViewStore().get(database)}


def read_view(database: str, data: Any) -> None:
    from prism_lca.engine.view_store import ViewStore, remap_scenarios_in_view, rename_in_view

    view = data.get("view") or {}
    source = _IMPORTED_FROM.pop(database, "")
    if view:
        # Imported beside its source, a scenario may have had to take a new id (`read_scenarios`); the
        # results setup names scenarios by id and follows it. `.get`, not `.pop`: the reports section
        # after this one needs the same mapping.
        view = remap_scenarios_in_view(view, _IMPORTED_SCENARIO_IDS.get(database, {}))
        # Under another name the canvas keys, colours and the detailed-results subject still named the
        # source: positions fell back to the grid, and the detailed results computed the ORIGINAL.
        if source and source != database:
            view = copy.deepcopy(view)  # renamed in place, and a redo reads the same bundle again
            rename_in_view(view, source, database, codes={a.key[1] for a in get_bd().Database(database)})
        ViewStore().put(database, view)


#: Exactly the report fields `ReportStore.update` accepts. Deliberately a list here rather than
#: "everything except a few": `list_reports` adds derived fields (`section_count`), and passing those
#: back made the import fail with "Unknown report fields" — found by exporting a real model and
#: importing it again, which is why that round trip is now a test.
_REPORT_FIELDS = (
    "name",
    "subtitle",
    "lang",
    "template",
    "palette",
    "amount",
    "aggregate_by",
    "subjects",
    "methods",
    "options",
    "abbreviations",
    "palette_colors",
    "cover_image",
    "client_logo",
    # The stored translation table: without it an English report of a German model came back in
    # English with its model texts back in German. `update` validates the shape.
    "translations",
    # The author's answers to the writer's questions — what every later chapter is briefed with.
    "answers",
)


def write_reports(database: str) -> dict:
    """The full reports, chapters included — `list_reports` summarises and drops `sections`."""
    from prism_lca.engine.report_store import ReportStore

    store = ReportStore()
    out = []
    for summary in store.list_reports(database):
        full = store.get(database, summary["id"])
        out.append({k: v for k, v in full.items() if k in _REPORT_FIELDS or k == "sections"})
    return {"reports": out}


def read_reports(database: str, data: Any) -> None:
    """Reports, minus anything the current store no longer accepts.

    A report written months ago can carry option keys that have since been retired (`comparative`,
    `for_publication`, `state_absent` were in a real project) — and `check_options` refuses those. A
    stale switch on one report is no reason to refuse a whole model, so unknown options are dropped
    here rather than fatal. Found by importing a real export; the test that pins it is in test_bundle.
    """
    from prism_lca.engine.report_store import _OPTION_CHECKS, ReportStore

    store = ReportStore()
    scenario_ids = _IMPORTED_SCENARIO_IDS.pop(database, {})
    for rep in data.get("reports") or []:
        created = store.create(database, name=rep.get("name") or "Report")
        patch = {k: v for k, v in rep.items() if k in _REPORT_FIELDS}
        if scenario_ids and isinstance(patch.get("subjects"), list):
            # …and where a scenario could not keep its id, the variant follows it.
            patch["subjects"] = [
                {**s, "scenario": scenario_ids.get(str(s.get("scenario")), s.get("scenario"))}
                if isinstance(s, dict) and s.get("scenario")
                else s
                for s in patch["subjects"]
            ]
        if isinstance(patch.get("options"), dict):
            patch["options"] = {k: v for k, v in patch["options"].items() if k in _OPTION_CHECKS}
        # Same rule for a template the receiver does not have: the bundle carries the template's
        # NAME, not its source, and `update` refuses a name it cannot find — which undid the whole
        # model import over a report's cover design. The report falls back to the default.
        if patch.get("template"):
            try:
                store.get_template(patch["template"])
            except PrismError:
                patch.pop("template")
        if patch:
            store.update(database, created["id"], patch)
        sections = rep.get("sections")
        if sections:
            # Chapters go through their own path — `update` says so and refuses them.
            store.replace_sections(database, created["id"], sections)


def write_chats(database: str) -> dict:
    """Only in a "full" export: a conversation history carries costs and client talk.

    A chat's ``plan`` and ``run`` travel as stored (additive within schema 1 — an older reader ignores
    them). The tool transcript does NOT travel: it is tool results, the class of content the bundle
    keeps out.
    """
    from prism_lca.engine.chat_store import ChatStore

    store = ChatStore()
    chats = []
    for summary in store.list_chats(database):
        full = store.get_chat(database, summary["id"])
        if full:
            chats.append(full)
    return {"chats": chats}


def read_chats(database: str, data: Any) -> None:
    from prism_lca.engine.chat_store import ChatStore

    store = ChatStore()
    for chat in data.get("chats") or []:
        created = store.create_chat(database, chat.get("title"))
        msgs = chat.get("messages") or []
        if msgs:
            store.append_messages(database, created["id"], msgs, keep_ts=True)  # when they were said, not imported
        # The plan comes along with its revision, capped like any other write. The run does NOT: an
        # imported chat is never running, and the transcript a stopped run would continue from does
        # not exist in this project — so a fresh idle run, whatever the source said. A bundle from
        # before plans existed has neither key and imports as it always did.
        if isinstance(chat.get("plan"), dict):
            store.set_plan(database, created["id"], chat["plan"])
        if "plan" in chat or "run" in chat:
            store.set_run(database, created["id"], {"runId": uuid.uuid4().hex[:12], "state": "idle"})


def write_research_log(database: str) -> dict:
    """What the build researched — the provenance the report's bibliography prints."""
    from prism_lca.engine.research_log import ResearchLogStore

    return {"research": ResearchLogStore().list(database)}


def read_research_log(database: str, data: Any) -> None:
    from prism_lca.engine.research_log import ResearchLogStore

    ResearchLogStore().replace(database, data.get("research") or [])


def write_review_log(database: str) -> dict:
    """The internal reviews and the builder's per-finding outcomes."""
    from prism_lca.engine.review_log import ReviewLogStore

    return {"reviews": ReviewLogStore().list(database)}


def read_review_log(database: str, data: Any) -> None:
    from prism_lca.engine.review_log import ReviewLogStore

    ReviewLogStore().replace(database, data.get("reviews") or [])


def write_audit(database: str) -> dict:
    """The command history of this model, on the field (full export only).

    It used to be a substring search: ``needle = f"'{database}'"`` against the ``summary`` prose. On
    the development log that found 1 to 9 entries per model out of hundreds of real edits — and looked
    like a successful complete export while doing it. Entries written before the attribution
    field existed are not here, because they never were: they name no model, and reading one out of
    their text is exactly the guess that broke this.
    """
    from prism_lca.engine import audit_store

    return {"audit": [e for e in audit_store.load() if audit_store.attributed_to(e, database)]}


def read_audit(database: str, data: Any) -> None:
    """Imported history is *appended as notes*, never replayed: it happened elsewhere.

    Rewriting it as if it had happened here would be the one place in this app where the audit trail
    lies. So each entry is added with its origin visible in the text.
    """
    from prism_lca.engine import audit_store

    for e in data.get("audit") or []:
        audit_store.append(
            {
                "index": audit_store.next_index(),
                "timestamp": e.get("timestamp") or "",
                "source": "import",
                "action": "imported_history",
                "summary": f"[from the bundle] {e.get('summary') or ''}".strip(),
                "undoable": False,
                # The model it landed in, not the name it had in the sender's project: this is the
                # history of *this* model now, and this is the list its reader will be looking at. The
                # original name is still in the text, and the import note beside it carries `related`.
                "database": database,
            }
        )


#: The registry. **New stored things are new entries here** — that is the additive rule, as code.
SECTIONS: tuple[Section, ...] = (
    Section("graph", 1, write_graph, read_graph, required=True),
    # Applied BEFORE the graph by the import command (the graph's links point at what it lands),
    # listed after it because the graph is the bundle's spine.
    Section("library", 1, write_library, read_library),
    Section("parameters", 1, write_parameters, read_parameters),
    Section("tags", 1, write_tags, read_tags),
    Section("scenarios", 2, write_scenarios, read_scenarios, schema_for=_scenarios_schema),
    Section("study", 1, write_study, read_study),
    Section("view", 1, write_view, read_view),
    Section("reports", 1, write_reports, read_reports),
    Section("chats", 1, write_chats, read_chats, preset="full"),
    Section("audit", 1, write_audit, read_audit, preset="full"),
    # Provenance logs. In the default preset on purpose: a report re-rendered after an
    # import should keep its researched-sources bibliography and its review outcome — unlike chats,
    # they carry no costs or client talk, only questions, sources and finding texts.
    Section("research_log", 1, write_research_log, read_research_log),
    Section("review_log", 1, write_review_log, read_review_log),
)

SECTION_BY_NAME = {s.name: s for s in SECTIONS}

#: What each preset includes. "graph" is the only preset that is not a subset of "full".
PRESETS = {
    "model": [s.name for s in SECTIONS if s.preset == "model"],
    "full": [s.name for s in SECTIONS],
    "graph": ["graph"],
}


# --- the container ----------------------------------------------------------------------------


def _canon(obj: Any) -> bytes:
    """Sorted keys, stable separators, trailing newline — the same input gives the same bytes."""
    return (json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode("utf-8")


def export_bundle(database: str, include: list[str] | None = None) -> bytes:
    """Pack a model. `include` names sections; `None` means the "model" preset."""
    _fg_or_400(database)
    wanted = list(include or PRESETS["model"])
    unknown = [n for n in wanted if n not in SECTION_BY_NAME]
    if unknown:
        raise PrismError(
            f"Unknown section(s): {', '.join(sorted(unknown))}.",
            code="bundle_unknown_section",
            hint=f"Known sections: {', '.join(s.name for s in SECTIONS)}.",
        )
    if "graph" not in wanted:
        wanted.insert(0, "graph")  # a bundle without the model is not a model bundle

    versions = background_versions()
    providers = background_providers()
    members: list[tuple[str, bytes]] = []
    entries: list[dict] = []
    for section in SECTIONS:  # registry order, not request order: determinism
        if section.name not in wanted:
            continue
        payload = section.writer(database)
        # Both sections that reference backgrounds: a library dataset drawing on ecoinvent 3.11 was
        # exported without a version, and the resolver then accepted a 3.12 of the same name as
        # "found where the bundle said" — the one check the version exists for.
        if section.name in ("graph", "library"):
            for ref in payload.get("references") or []:
                ref["version"] = versions.get(ref.get("database", ""), "")
        raw = _canon(payload)
        members.append((section.file, raw))
        entries.append(
            {
                "file": section.file,
                "schema": section.schema_for(payload) if section.schema_for else section.schema,
                "required": section.required,
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
        )
    # …and the sections an import could not read (kept verbatim by `bundle_unknown.store_unknown`), unless
    # this version has learnt to write them since. Keeping them on disk protected nothing while the next
    # export left them out.
    for file, raw, entry in stored_unknown(database, {name for name, _raw in members}):
        members.append((file, raw))
        entries.append(entry)

    graph = next(raw for name, raw in members if name == "graph.json")
    refs = list(json.loads(graph).get("references") or [])
    library_raw = next((raw for name, raw in members if name == "library.json"), None)
    if library_raw:
        refs += json.loads(library_raw).get("references") or []
    manifest = {
        "format": FORMAT,
        "written_by": _app_version(),
        # Deliberately null: a timestamp in the content would make two exports of the same model
        # differ, and the file system already records when the file was made.
        "written_at": None,
        "model": {"name": database, "database": database},
        "requires": {
            "backgrounds": sorted(
                (
                    {
                        "database": d,
                        "version": versions.get(d, ""),
                        # Which provider (ecoinvent / bafu) — additive, so older readers ignore it. A
                        # BAFU:2027 is another number just as a 3.13 is (cross-version rule).
                        **({"provider": providers[d]} if providers.get(d) else {}),
                    }
                    # The library is referenced like a background but is not one anybody can
                    # install — it stays out of the requirements (graph.json still names the link).
                    for d in {r.get("database", "") for r in refs}
                    if d and not is_library(d)
                ),
                key=lambda x: x["database"],
            )
        },
        "sections": entries,
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, raw in [("manifest.json", _canon(manifest)), *members]:
            info = zipfile.ZipInfo(name, date_time=_ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, raw)
    return buf.getvalue()


def free_model_name(wanted: str) -> str:
    """`wanted`, or `wanted (2)` — the name an import would actually use.

    Lives here rather than in the command because the **dry run has to show the same answer**: the
    sheet used to prefill the name the bundle carried, which is precisely the taken one, so a collision
    looked like no collision. Merging is deliberately not on
    offer — two models with the same parameter names have no obvious winner — so a taken name means a
    second model, and saying so before the fact is the whole job.
    """
    bd = get_bd()
    wanted = (wanted or "").strip() or "Imported model"
    if wanted not in bd.databases:
        return wanted
    for n in range(2, 500):
        candidate = f"{wanted} ({n})"
        if candidate not in bd.databases:
            return candidate
    raise PrismError(f"Too many models named like '{wanted}'.", code="database_exists")


def read_bundle(content: bytes) -> dict:
    """Open a bundle: manifest, the sections this version knows, and the ones it does not.

    Nothing is written. What comes back is what `inspect` reports and what `import` then applies, so
    the preview and the deed cannot disagree.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise PrismError(
            "That file is not a PrismLCA bundle.",
            code="bundle_unreadable",
            hint="A bundle is a .prism file written by PrismLCA's model export.",
        ) from exc
    names = set(zf.namelist())
    if "manifest.json" not in names:
        raise PrismError(
            "The bundle has no manifest.",
            code="bundle_no_manifest",
            hint="It may be a plain ZIP rather than a .prism bundle.",
        )
    manifest = _parse(zf.read("manifest.json"), "manifest.json")
    entries = (manifest.get("sections") or []) if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not all(
        isinstance(e, dict) and isinstance(e.get("file") or "", str) for e in entries
    ):
        raise _damaged("manifest.json")
    if _number(manifest.get("format"), 0) > FORMAT:
        raise PrismError(
            f"This bundle was written in format {manifest.get('format')}; this version reads {FORMAT}.",
            code="bundle_too_new",
            hint="Update PrismLCA to import it. Older bundles always import.",
        )

    known: dict[str, Any] = {}
    unknown: dict[str, bytes] = {}
    unknown_entries: dict[str, dict] = {}
    newer: list[str] = []
    checksums: list[str] = []
    for entry in entries:
        file = entry.get("file") or ""
        if file not in names:
            if entry.get("required"):
                raise PrismError(
                    f"The bundle is missing {file}, which it declares as required.",
                    code="bundle_incomplete",
                )
            continue
        raw = zf.read(file)
        want = entry.get("sha256")
        if want and hashlib.sha256(raw).hexdigest() != want:
            checksums.append(file)
        name = file[:-5] if file.endswith(".json") else file
        section = SECTION_BY_NAME.get(name)
        if section is None:
            # A section this version has never heard of: kept verbatim rather than guessed at — see
            # engine/bundle_unknown.py.
            unknown[file] = raw
            unknown_entries[file] = dict(entry)
            continue
        if _number(entry.get("schema"), 1) > section.schema:
            # A newer shape of one it knows. It cannot be read, and keeping it does not help either: the
            # next export writes this version's own section of that name. So it is named as not imported
            # — and when it is the model itself, nothing can be.
            if section.required:
                raise PrismError(
                    f"This bundle's {name} section is in a newer format than this version of PrismLCA reads.",
                    code="bundle_too_new",
                    hint="Update PrismLCA to import it. Nothing has been written.",
                )
            newer.append(name)
            continue
        known[name] = _parse(raw, file)
    if checksums:
        raise PrismError(
            f"Damaged bundle: {', '.join(checksums)} does not match its checksum.",
            code="bundle_corrupt",
            hint="Ask for the file again; it changed in transit.",
        )
    return {
        "manifest": manifest,
        "sections": known,
        "unknown": unknown,
        "unknown_entries": unknown_entries,
        "newer": sorted(newer),
    }


def _damaged(file: str) -> PrismError:
    return PrismError(
        f"Damaged bundle: {file} cannot be read.",
        code="bundle_corrupt",
        hint="The file is incomplete or was changed after export. Ask for it again — nothing has been written.",
    )


def _number(value: Any, default: int) -> int:
    """A version number from the manifest; anything that is not one makes the manifest damaged."""
    try:
        return int(value or default)
    except (TypeError, ValueError) as exc:
        raise _damaged("manifest.json") from exc


def _parse(raw: bytes, file: str) -> Any:
    """One member as JSON — a member that is not is a damaged file, not an internal error."""
    try:
        return json.loads(raw)
    except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError both are
        raise _damaged(file) from exc


def _app_version() -> str:
    from prism_lca.config import get_settings

    return get_settings().app_version
