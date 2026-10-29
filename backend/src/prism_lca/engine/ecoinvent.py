"""First-run ecoinvent setup: import from local ecospold2 files (ADR-008, no online login).

Raw ecoinvent data is never bundled or committed — the user points at their own licensed
ecospold2 release. The import is long (~10–40 min, up to ~20 GB RAM) so it runs on a
background thread and reports progress via :func:`status`.

Everything comes from the SAME release, which is what keeps the three steps linkable without
any name matching across versions:

1. biosphere flows from ``MasterData/ElementaryExchanges.xml``,
2. the inventory from ``datasets/``,
3. the LCIA methods from the release's LCIA-implementation workbook.

bw2io's ``import_ecoinvent_release`` does the same for steps 1 and 2, but downloads the release
through ``ecoinvent_interface`` and therefore needs a login — which is exactly what ADR-008
rules out. ``bw2setup()`` is not an alternative: it installs bw2io's bundled 3.9 flow list
(4 709 flows against 3.12's 9 850) and 3.9 LCIA methods that error in this bw2io/bw2data
combination.
"""

from __future__ import annotations

import difflib
import threading
import time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from numbers import Number
from pathlib import Path
from typing import Any

from prism_lca import _log
from prism_lca.engine import geography_names
from prism_lca.engine.backgrounds import common as backgrounds
from prism_lca.engine.backgrounds import sync as background_sync
from prism_lca.engine.bootstrap import get_bd, get_bi
from prism_lca.engine.guardrails import set_read_only
from prism_lca.errors import PrismError

BIOSPHERE_DB = "biosphere3"

#: Marks an import that ran to completion. A bare activity count cannot tell a finished import
#: from a crashed one, and a half-written database looks fine until a calculation is wrong.
COMPLETE_KEY = "prism_import_complete"
#: Which flow list produced the biosphere, so a later import can say so instead of guessing.
BIO_REVISION_KEY = "prism_biosphere_revision"
BIO_SOURCE_KEY = "prism_biosphere_source"
BIO_FLOW_COUNT_KEY = "prism_biosphere_flows"
#: On the biosphere while a workspace that started with BAFU still waits for the rewrite onto ecoinvent.
#: The flow list's source cannot say so for long: the import replaces it in its first step, so a cancel,
#: an error or a crash before the rewrite would otherwise leave it undone for good.
SYNC_PENDING_KEY = "prism_ecoinvent_sync_pending"


class JobState(StrEnum):
    idle = "idle"
    running = "running"
    done = "done"
    error = "error"
    cancelled = "cancelled"


@dataclass
class ImportStatus:
    state: JobState = JobState.idle
    step: str = ""
    detail: str = ""
    project: str | None = None
    database: str | None = None
    #: 0.0–1.0 where the job can say how far it is; ``None`` = running, but not measurable.
    progress: float | None = None
    #: True while :func:`cancel_import` can still stop the job — the ecoinvent import until it writes.
    cancellable: bool = False
    #: Wall-clock start (epoch seconds), so a client can show the elapsed time.
    started_at: float | None = None


_status = ImportStatus()
_LOCK = threading.Lock()
#: Set by :func:`cancel_import`; the ecoinvent job checks it between datasets and between strategies.
_CANCEL = threading.Event()


def assert_no_import_running(action: str) -> None:
    """Refuse a workspace change while a background import writes into the current workspace.

    The worker sets bw2data's active workspace once, at its start, and writes for minutes after;
    a switch in between sent the rest of the import into the workspace switched to, while its status
    still named the first. Callers hold PROJECT_LOCK, and the
    import starts claim the job under the same lock (`_claims_workspace`), so neither can slip past
    the other.
    """
    if _status.state == JobState.running:
        raise PrismError(
            f'A background import into workspace "{_status.project}" is running; {action} now would '
            "send the rest of it into another workspace.",
            code="import_running",
            status_code=409,
            hint="Wait until it has finished — Overview → Background shows its progress.",
        )


def _claims_workspace(fn: Callable[..., ImportStatus]) -> Callable[..., ImportStatus]:
    """Start an import under PROJECT_LOCK: the job is claimed in the workspace that is current while
    no switch can happen (see assert_no_import_running)."""
    import functools

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> ImportStatus:
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            return fn(*args, **kwargs)

    return wrapper


def status() -> ImportStatus:
    return _status


def _update(**kwargs) -> None:
    with _LOCK:
        for key, value in kwargs.items():
            setattr(_status, key, value)


def _failed(exc: Exception) -> None:
    """The job's end on an error. The hint travels along: the client sees only the status, and a
    message without its remedy left users guessing which folder the import wanted."""
    hint = getattr(exc, "hint", None) if isinstance(exc, PrismError) else None
    _update(
        state=JobState.error,
        step="error",
        detail=f"{exc} {hint}" if hint else str(exc),
        progress=None,
        cancellable=False,
    )


def cancel_import() -> ImportStatus:
    """Ask the running ecoinvent import to stop. Reading stops within about a second, linking at the
    next strategy; the write, once begun, runs to its end — a half-written database would be worse
    than a finished one."""
    with _LOCK:  # one decision with _begin_writing: a cancel is either honoured or refused
        if _status.state != JobState.running or not _status.cancellable:
            raise PrismError(
                "No import is running that can still be cancelled.",
                code="import_not_cancellable",
                status_code=409,
                hint="Only the ecoinvent import can be stopped, and only until it writes the database.",
            )
        _CANCEL.set()
    return _status


def _begin_writing(**fields) -> None:
    """From here the job runs to its end. A cancel that came in before still counts; after this,
    :func:`cancel_import` refuses."""
    from prism_lca.engine.ecoinvent_inventory import ImportCancelled

    with _LOCK:
        if _CANCEL.is_set():
            raise ImportCancelled
        _status.cancellable = False
        for key, value in fields.items():
            setattr(_status, key, value)


def _mark_sync_pending(pending: bool) -> None:
    meta = get_bd().databases[BIOSPHERE_DB]
    if pending:
        meta[SYNC_PENDING_KEY] = True
    else:
        meta.pop(SYNC_PENDING_KEY, None)
    get_bd().databases.flush()


def flow_list_path(ecospold2_dir: Path) -> Path:
    """The release's own elementary-flow list — it sits BESIDE ``datasets/``, not inside it."""
    return ecospold2_dir.parent / "MasterData" / "ElementaryExchanges.xml"


def datasets_folder(chosen: Path) -> Path:
    """The ``datasets`` folder of the release the user pointed at. Choosing the extracted release
    itself is the natural pick, so its ``datasets`` subfolder is taken; any other folder stays as
    chosen and is judged by the checks that follow."""
    inner = chosen / "datasets"
    if inner.is_dir() and flow_list_path(inner).is_file():
        return inner
    return chosen


def _flow_list_revision(filepath: Path) -> str:
    """Master-data revision of the flow list, e.g. ``3.0.0.70158``.

    Not the ecoinvent release number: these attributes describe the master-data context, and
    3.12's list still reports majorRelease 3 / minorRelease 0. Useful only as a fingerprint
    answering "which flow list produced this biosphere".
    """
    from lxml import objectify

    with filepath.open(encoding="utf-8") as handle:
        attrib = objectify.parse(handle).getroot().attrib
    parts = [
        attrib.get(key)
        for key in ("majorRelease", "minorRelease", "majorRevision", "minorRevision")
    ]
    return ".".join(part for part in parts if part) or "unknown"


def _ensure_biosphere(elementary: Path) -> tuple[str, list[dict]]:
    """Create — or PATCH — ``biosphere3`` from the release's own flow list. Returns the note and
    the release's flows (the ecoinvent-master sync needs them to lift a bundled biosphere).

    Patching rather than skipping is what makes a pre-existing biosphere safe. A biosphere3 left
    over from ``bw2setup()`` holds 4 709 of 3.12's 9 850 flows; skipping it would fail the
    inventory step later with thousands of unlinked exchanges and no hint as to why. This is
    bw2io's own ``biosphere_write_mode="patch"`` behaviour.
    """
    bd = get_bd()
    bi = get_bi()
    from bw2io.importers.ecospold2_biosphere import Ecospold2BiosphereImporter

    # Needed by the ecospold2 inventory strategies, not by the biosphere itself.
    if not len(bi.migrations):
        bi.create_core_migrations()

    # No ``version=``: that argument only selects bw2io's BUNDLED 3.9 flow list, and only when
    # ``filepath`` is absent. Passing both reads as a contradiction rather than a fallback.
    importer = Ecospold2BiosphereImporter(name=BIOSPHERE_DB, filepath=elementary)
    importer.apply_strategies()
    if not importer.all_linked:
        raise PrismError(
            "The release's elementary-flow list did not link cleanly.",
            code="biosphere_unlinked",
            hint=f"Check {elementary} — it looks damaged or is not an ecospold2 flow list.",
        )

    if BIOSPHERE_DB not in bd.databases:
        # PrismLCA has its own index — see engine/hygiene.py
        importer.write_database(searchable=False)
        note = f"Created {BIOSPHERE_DB} with {len(importer.data)} flows."
    else:
        existing = {flow["code"] for flow in bd.Database(BIOSPHERE_DB)}
        missing = [flow for flow in importer.data if flow["code"] not in existing]
        database = bd.Database(BIOSPHERE_DB)
        for flow in missing:
            # ``database`` is set by the importer but is not a node field.
            database.new_activity(**{k: v for k, v in flow.items() if k != "database"}).save()
        note = (
            f"Patched {BIOSPHERE_DB}: added {len(missing)} missing flows "
            f"({len(existing)} were present)."
            if missing
            else f"{BIOSPHERE_DB} already holds all {len(existing)} flows of this release."
        )

    bd.databases[BIOSPHERE_DB][BIO_REVISION_KEY] = _flow_list_revision(elementary)
    bd.databases[BIOSPHERE_DB][BIO_SOURCE_KEY] = str(elementary)
    bd.databases[BIOSPHERE_DB][BIO_FLOW_COUNT_KEY] = len(bd.Database(BIOSPHERE_DB))
    bd.databases.flush()
    return note, [{k: v for k, v in flow.items() if k != "database"} for flow in importer.data]


def _biosphere_lookup() -> dict[tuple, int]:
    """``(name, categories) -> flow id`` for the biosphere flows. Ids rather than keys because
    ``Method.write`` resolves every key with a full node load — half the time of writing a release's
    ~480 000 factors."""
    bd = get_bd()
    return {
        (flow.get("name"), tuple(flow.get("categories") or ())): flow.id
        for flow in bd.Database(BIOSPHERE_DB)
    }


def _categories(compartment, subcompartment) -> tuple:
    if not subcompartment or str(subcompartment).lower() in ("unspecified", "(unspecified)"):
        return (compartment,)
    return (compartment, subcompartment)


def _unmatched_hint(unmatched: set[tuple], lookup: dict[tuple, int], limit: int = 8) -> str:
    """Name the flows a CF could not reach, plus the closest candidates in the same context.

    Deliberately a hint and NOT an automatic substitution. bw2io fuzzy-matches names at this
    point, but a wrong guess silently writes the wrong characterisation factor into every
    result that uses the method. With biosphere and CFs from the same release the case does not
    arise (0 of 484 598 rows in 3.12); should a future release rename a flow, this says exactly
    what needs deciding.
    """
    # ``str()`` because a blank cell reaches here as None, and a crash inside the error path
    # would replace a clear message with a confusing one.
    lines = []
    for name, categories in sorted(unmatched, key=lambda pair: (str(pair[0]), pair[1]))[:limit]:
        same_context = [str(key[0]) for key in lookup if key[1] == categories]
        near = difflib.get_close_matches(str(name), same_context, n=3, cutoff=0.6)
        lines.append(
            f"'{name}' {categories}"
            + (f" — closest flows: {', '.join(near)}" if near else " — no similar flow here")
        )
    if len(unmatched) > limit:
        lines.append(f"…and {len(unmatched) - limit} more")
    return " | ".join(lines)


def _column_indices(
    header: tuple, wanted: dict[str, tuple[str, ...]], sheet: str
) -> dict[str, int]:
    """Resolve columns by header name, so a reordered workbook fails loudly instead of silently."""
    normalised = [str(cell).strip().lower() if cell is not None else "" for cell in header]
    indices = {}
    for field, candidates in wanted.items():
        for candidate in candidates:
            if candidate in normalised:
                indices[field] = normalised.index(candidate)
                break
        else:
            raise PrismError(
                f"Column '{candidates[0]}' not found in worksheet '{sheet}'.",
                code="lcia_column_missing",
                hint=f"Found columns: {', '.join(c for c in normalised if c)}. This does not "
                "look like an ecoinvent LCIA-implementation workbook.",
            )
    return indices


def _import_lcia(xlsx: Path) -> str:
    """Write the release's LCIA methods, linking every CF against ``biosphere3``.

    bw2io bundles only the 3.9 implementation and its ``EcoinventLCIAImporter`` reads that
    bundled file in ``__init__``, so we link and write directly: match each characterisation
    factor to a flow by ``(name, categories)`` and write one ``bw2data.Method`` per
    ``(method, category, indicator)`` triple with its indicator unit.
    """
    from openpyxl import load_workbook

    bd = get_bd()
    if BIOSPHERE_DB not in bd.databases or not len(bd.Database(BIOSPHERE_DB)):
        raise PrismError(
            f"No populated '{BIOSPHERE_DB}' in this workspace.",
            code="biosphere_missing",
            hint="Import the ecoinvent inventory first — the LCIA methods link against its "
            "elementary flows.",
            status_code=409,
        )

    lookup = _biosphere_lookup()
    workbook = load_workbook(xlsx, read_only=True, data_only=True)

    units_sheet = next((s for s in ("Indicators", "units") if s in workbook.sheetnames), None)
    if units_sheet is None or "CFs" not in workbook.sheetnames:
        raise PrismError(
            "The workbook has no 'CFs' and 'Indicators' worksheets.",
            code="lcia_sheets_missing",
            hint=f"Found worksheets: {', '.join(workbook.sheetnames)}. Point at the "
            "'LCIA Implementation <version>.xlsx' from your licensed release.",
        )

    # Indicator units, keyed by the (method, category, indicator) triple.
    units: dict[tuple, str] = {}
    rows = workbook[units_sheet].iter_rows(values_only=True)
    unit_cols = _column_indices(
        next(rows),
        {
            "method": ("method",),
            "category": ("category",),
            "indicator": ("indicator",),
            "unit": ("indicator unit", "unit", "unitname", "impact score unit"),
        },
        units_sheet,
    )
    for row in rows:
        key = (row[unit_cols["method"]], row[unit_cols["category"]], row[unit_cols["indicator"]])
        units[key] = row[unit_cols["unit"]]

    rows = workbook["CFs"].iter_rows(values_only=True)
    cf_cols = _column_indices(
        next(rows),
        {
            "method": ("method",),
            "category": ("category",),
            "indicator": ("indicator",),
            "name": ("name", "flow name"),
            "compartment": ("compartment",),
            "subcompartment": ("subcompartment",),
            "amount": ("cf", "cf 3.6", "cf 3.5", "cf 3.4"),
        },
        "CFs",
    )

    # One CF per (method, flow): bw2calc SUMS duplicate matrix entries, so appending without
    # dedup would double-count a flow's CF. Duplicates arise from the subcompartment fallback
    # below (two rows with different subcompartments can map onto the same unspecified flow) —
    # the first, more specific row wins.
    cfs: dict[tuple, dict[int, float]] = defaultdict(dict)
    unmatched: set[tuple] = set()
    n_rows = n_linked = n_dupes = 0
    for row in rows:
        amount = row[cf_cols["amount"]]
        if not isinstance(amount, Number):
            continue
        n_rows += 1
        method = (
            row[cf_cols["method"]],
            row[cf_cols["category"]],
            row[cf_cols["indicator"]],
        )
        name = row[cf_cols["name"]]
        compartment = row[cf_cols["compartment"]]
        categories = _categories(compartment, row[cf_cols["subcompartment"]])
        key = lookup.get((name, categories)) or lookup.get((name, (compartment,)))
        if key is None:
            unmatched.add((name, categories))
            continue
        if key in cfs[method]:
            n_dupes += 1
            continue
        cfs[method][key] = float(amount)
        n_linked += 1

    # Refuse to write a half-linked method set: the numbers would look plausible and be wrong.
    if unmatched:
        raise PrismError(
            f"{len(unmatched)} characterisation factors reference flows that are missing from "
            f"'{BIOSPHERE_DB}' — no methods were written.",
            code="lcia_unlinked",
            hint=f"Biosphere and workbook must come from the same ecoinvent release. "
            f"Unmatched: {_unmatched_hint(unmatched, lookup)}",
        )

    written = 0
    for method, data in cfs.items():
        if not data:
            continue
        bw_method = bd.Method(method)
        meta = {
            "unit": units.get(method, ""),
            "description": "ecoinvent LCIA implementation",
            "filepath": str(xlsx),
        }
        # ``register`` is a no-op for a name that already exists (bw2data keeps the old metadata),
        # so a re-import — or the workbook replacing a bundled 3.9 method of the same name —
        # must set the metadata itself; otherwise the method would still say "bundled".
        bw_method.register(**meta)
        current = dict(bd.methods[method])  # keeps bw2data's own keys (abbreviation)
        current.update(meta)
        current.pop("prism_bundled", None)
        bd.methods[method] = current
        bw_method.write(list(data.items()))
        written += 1
    bd.methods.flush()
    # The factors behind an already-cached method key changed; `get_lca` reuses the characterisation
    # matrix by key, so without this the next score still used the old factors.
    from prism_lca.engine.lca import invalidate_lca_cache

    invalidate_lca_cache()

    return (
        f"Wrote {written} LCIA methods ({n_linked} characterisation factors of {n_rows} rows; "
        f"{n_dupes} duplicate flow mappings skipped)."
    )


def _run_import(
    ecospold2_dir: Path,
    project: str,
    database: str,
    lcia_xlsx: Path | None,
    use_mp: bool,
    on_done: Callable[[str, dict], None] | None = None,
) -> None:
    try:
        bd = get_bd()
        bd.projects.set_current(project)

        # One database per provider: a second ecoinvent under another name is not
        # a second background, it is a mistake waiting to double-count.
        other = backgrounds.database_of(backgrounds.PROVIDER_ECOINVENT)
        if other and other != database:
            raise PrismError(
                f"This workspace already holds an ecoinvent database ('{other}').",
                code="background_exists",
                status_code=409,
                hint="Remove it in Background data first if you want to import another release.",
            )
        # A biosphere built from bw2io's bundled 3.9 list (a project that started with BAFU):
        # ecoinvent is the master, so after this import everything is rewritten onto its list.
        retry_sync = bool(BIOSPHERE_DB in bd.databases and bd.databases[BIOSPHERE_DB].get(SYNC_PENDING_KEY))
        bundled = background_sync.has_bundled_biosphere() or retry_sync
        if bundled:
            _mark_sync_pending(True)

        # An EMPTY existing database is the signature of a crashed write. A missing completion
        # flag is not: databases imported before PrismLCA recorded the flag carry their activities
        # perfectly well, and refusing those would lock every existing installation out of its
        # own project.
        if database in bd.databases and not len(bd.Database(database)):
            raise PrismError(
                f"'{database}' exists but is empty — a previous import was interrupted.",
                code="import_incomplete",
                hint="Delete the database and start over ('Start over' in Background data); a "
                "partially written inventory would give wrong results.",
                status_code=409,
            )

        elementary = flow_list_path(ecospold2_dir)
        if not elementary.is_file():
            raise PrismError(
                f"ElementaryExchanges.xml not found at {elementary}.",
                code="flow_list_not_found",
                hint="Point at the extracted release's 'datasets' folder — 'MasterData' must "
                "sit beside it.",
            )

        _update(
            step="biosphere",
            detail="Building the biosphere from the release's flow list…",
            progress=0.03,
        )
        flows_before = len(bd.Database(BIOSPHERE_DB)) if BIOSPHERE_DB in bd.databases else 0
        biosphere_note, release_flows = _ensure_biosphere(elementary)
        flows_after = len(bd.Database(BIOSPHERE_DB))

        if database in bd.databases:
            # Nothing left to read: what follows writes (methods, the rewrite), so no cancel any more.
            _begin_writing(step="lcia" if lcia_xlsx is not None else "finishing", detail="", progress=0.8)
            inventory_note = (
                f"'{database}' already imported ({len(bd.Database(database))} activities)."
            )
        else:
            from prism_lca.engine.ecoinvent_inventory import import_inventory

            _update(step="inventory", detail="Reading datasets…", progress=0.05)
            written = import_inventory(
                ecospold2_dir,
                database,
                biosphere=BIOSPHERE_DB,
                complete_key=COMPLETE_KEY,
                use_mp=use_mp,
                cancelled=_CANCEL,
                update=_update,
                begin_writing=_begin_writing,
            )
            inventory_note = f"Imported {written} activities."

        set_read_only(database, True)
        set_read_only(BIOSPHERE_DB, True)
        _register_ecoinvent(database, ecospold2_dir, elementary)

        if lcia_xlsx is not None:
            _update(step="lcia", detail="Linking and writing LCIA methods…", progress=0.85)
            lcia_note = _import_lcia(lcia_xlsx)
        else:
            lcia_note = (
                "No LCIA methods imported — without them nothing can be calculated. Add them "
                "from your release's 'LCIA Implementation' workbook."
            )

        sync_note = ""
        if bundled:
            _update(
                step="sync",
                detail="Rewriting the existing background onto ecoinvent…",
                progress=0.92,
            )
            report = background_sync.ecoinvent_master(
                release_flows,
                progress=lambda text: _update(step="sync", detail=text, progress=0.95),
                replace_methods=lcia_xlsx is not None,
                reprocess=retry_sync,
            )
            _mark_sync_pending(False)
            moved = sum(r.get("moved", 0) for r in report["remapped"])
            sync_note = (
                f" ecoinvent is now the reference: {report['lifted_flows']} flows lifted to the "
                f"release's names, {moved} exchanges re-mapped, "
                f"{report['bundled_methods_removed']} bundled methods replaced, "
                f"{report['flows_removed']} orphaned flows removed."
            )

        # A new background is a model change for everything keyed on the generation — the report
        # snapshots, and the vocabulary scan that may have run on an empty project.
        from prism_lca.engine.lca import invalidate_lca_cache

        invalidate_lca_cache()
        _update(
            state=JobState.done,
            step="finished",
            detail=f"{biosphere_note} {inventory_note} {lcia_note}{sync_note}",
            progress=1.0,
        )
        if on_done is not None:
            # The biosphere index has to follow: a rebuild when flows were renamed (the sync) or
            # added by the patch — an old index would not find the release's own flows.
            on_done(database, {"biosphere_rebuild": bundled or flows_after != flows_before})
    except Exception as exc:  # noqa: BLE001 - surface any engine error to the client
        from prism_lca.engine.ecoinvent_inventory import ImportCancelled

        if isinstance(exc, ImportCancelled):
            _update(
                state=JobState.cancelled,
                step="cancelled",
                detail="Import cancelled before anything was written. Start it again whenever you like.",
                progress=None,
                cancellable=False,
            )
            return
        _log.swallowed(exc, "_run_import")
        _failed(exc)


def _register_ecoinvent(database: str, ecospold2_dir: Path, elementary: Path) -> None:
    info = backgrounds.infer_from_name(database) or backgrounds.BackgroundInfo(
        provider=backgrounds.PROVIDER_ECOINVENT, label=database, version=""
    )
    info.source_path = str(ecospold2_dir)
    info.flow_mapping = {"flow_list_revision": _flow_list_revision(elementary)}
    backgrounds.write_registry(database, info)
    geography_names.store_from_release(ecospold2_dir)


def _run_bafu_import(
    ecospold1_dir: Path,
    project: str,
    database: str | None,
    on_done: Callable[[str, dict], None] | None = None,
) -> None:
    from prism_lca.engine.backgrounds import bafu

    try:
        get_bd().projects.set_current(project)
        result = bafu.run_import(
            ecospold1_dir,
            database,
            progress=lambda step, detail, progress=None: _update(
                step=step, detail=detail, database=database, progress=progress
            ),
        )
        from prism_lca.engine.lca import invalidate_lca_cache

        invalidate_lca_cache()  # see the ecoinvent path
        _update(state=JobState.done, step="finished", database=result["database"], progress=1.0)
        if on_done is not None:
            # New, uncharacterised flows must be findable: appended to the biosphere index rather
            # than rebuilding it (108 flows, not 9 958).
            on_done(result["database"], {"biosphere_added": result.get("biosphere_added") or []})
    except Exception as exc:  # noqa: BLE001 - surface any engine error to the client
        _log.swallowed(exc, "_run_bafu_import")
        _failed(exc)


@_claims_workspace
def start_bafu_import(
    ecospold1_dir: str,
    project: str | None = None,
    database: str | None = None,
    *,
    run_in_thread: bool = True,
    on_done: Callable[[str, dict], None] | None = None,
) -> ImportStatus:
    """Import a BAFU:20XY ecoSpold-1 folder as a background database (at most one
    per provider). ``on_done`` runs with the database name once the import finished — the API
    uses it to build the search index."""
    from prism_lca.engine.backgrounds import bafu

    _assert_idle()
    path = Path(ecospold1_dir)
    if not path.is_dir():
        raise PrismError(
            f"ecoSpold-1 directory not found: {ecospold1_dir}",
            code="path_not_found",
            status_code=400,
            hint="Point at the 'ecoSpold files' folder of the BAFU download.",
        )
    bd = get_bd()
    project = project or bd.projects.current
    existing = backgrounds.database_of(backgrounds.PROVIDER_BAFU)
    if existing:
        raise PrismError(
            f"This workspace already holds a BAFU database ('{existing}').",
            code="background_exists",
            status_code=409,
            hint="Remove it in Background data first if you want to import another release.",
        )
    database = database or bafu.label_from_path(path)[0]
    _update(
        state=JobState.running,
        step="starting",
        detail="",
        project=project,
        database=database,
        progress=0.0,
        cancellable=False,
        started_at=time.time(),
    )
    args = (path, project, database, on_done)
    if run_in_thread:
        threading.Thread(target=_run_bafu_import, args=args, daemon=True).start()
    else:
        _run_bafu_import(*args)
    return _status


def _run_lcia_import(xlsx: Path, project: str) -> None:
    try:
        get_bd().projects.set_current(project)
        _update(step="lcia", detail="Linking and writing LCIA methods…")
        _update(state=JobState.done, step="finished", detail=_import_lcia(xlsx))
    except Exception as exc:  # noqa: BLE001 - surface any engine error to the client
        _log.swallowed(exc, "_run_lcia_import")
        _failed(exc)


def _assert_idle() -> None:
    if _status.state == JobState.running:
        raise PrismError(
            "A background import is already running.",
            code="import_busy",
            status_code=409,
            hint="Wait for it to finish (poll GET /api/v1/setup/status).",
        )


def _existing_file(path: str, *, code: str, hint: str) -> Path:
    resolved = Path(path)
    if not resolved.is_file():
        raise PrismError(f"File not found: {path}", code=code, status_code=400, hint=hint)
    return resolved


@_claims_workspace
def start_import(
    ecospold2_dir: str,
    project: str = "ecoinvent-3.12-cutoff",
    database: str = "ecoinvent-3.12-cutoff",
    lcia_xlsx: str | None = None,
    *,
    run_in_thread: bool = True,
    use_mp: bool = True,
    on_done: Callable[[str, dict], None] | None = None,
) -> ImportStatus:
    _assert_idle()

    path = Path(ecospold2_dir)
    if not path.is_dir():
        raise PrismError(
            f"ecospold2 directory not found: {ecospold2_dir}",
            code="path_not_found",
            status_code=400,
            hint="Choose the extracted ecoinvent release folder (or the 'datasets' folder inside it).",
        )
    workbook = (
        _existing_file(
            lcia_xlsx,
            code="lcia_file_not_found",
            hint="Point at the 'LCIA Implementation <version>.xlsx' extracted from your "
            "licensed LCIA-implementation archive, or omit it to import the inventory only.",
        )
        if lcia_xlsx
        else None
    )

    path = datasets_folder(path)
    # Checked here, not only in the job: an answer to the request carries its hint to the window.
    if not flow_list_path(path).is_file():
        archive = next((p.name for p in path.glob("*.7z")), None)
        raise PrismError(
            f"{path} is not an extracted ecoinvent release: 'MasterData/ElementaryExchanges.xml' is "
            "missing beside its datasets.",
            code="flow_list_not_found",
            status_code=400,
            hint=(f"Extract {archive} first, then choose" if archive else "Choose")
            + " the extracted folder — the one that holds 'datasets' and 'MasterData'.",
        )

    _CANCEL.clear()
    _update(
        state=JobState.running,
        step="starting",
        detail="",
        project=project,
        database=database,
        progress=0.0,
        cancellable=True,
        started_at=time.time(),
    )
    args = (path, project, database, workbook, use_mp, on_done)
    if run_in_thread:
        threading.Thread(target=_run_import, args=args, daemon=True).start()
    else:
        _run_import(*args)
    return _status


@_claims_workspace
def start_lcia_import(
    lcia_xlsx: str,
    project: str = "ecoinvent-3.12-cutoff",
    *,
    run_in_thread: bool = True,
) -> ImportStatus:
    """Add the LCIA methods to a project whose inventory is already imported."""
    _assert_idle()
    workbook = _existing_file(
        lcia_xlsx,
        code="lcia_file_not_found",
        hint="Point at the 'LCIA Implementation <version>.xlsx' extracted from your licensed "
        "LCIA-implementation archive.",
    )

    _update(
        state=JobState.running,
        step="starting",
        detail="",
        project=project,
        database=None,
        progress=None,
        cancellable=False,
        started_at=time.time(),
    )
    if run_in_thread:
        threading.Thread(target=_run_lcia_import, args=(workbook, project), daemon=True).start()
    else:
        _run_lcia_import(workbook, project)
    return _status
