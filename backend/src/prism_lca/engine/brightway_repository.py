"""Brightway 2.5 implementation of the repository interface."""
from __future__ import annotations

import importlib.metadata as _md

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import is_read_only, set_read_only
from prism_lca.engine.library import is_library
from prism_lca.errors import PrismError
from prism_lca.repository.base import BackendInfo, DatabaseInfo, LcaRepository, ProjectInfo

BIOSPHERE_DB = "biosphere3"


def _bw_version() -> str:
    try:
        return f"bw2data {_md.version('bw2data')}"
    except Exception as exc:  # pragma: no cover
        _log.swallowed(exc, "_bw_version")
        return "unknown"


def _database_count(bd, project, current: str) -> int:
    """How many databases a project holds — the active one from memory, the others from their
    `databases.json` on disk. The field said 0 for every project since the first day (V337): only the
    active project was ever counted, and only on create/switch."""
    if project.name == current:
        return len(bd.databases)
    try:
        import json

        path = bd.projects._project_dir(project) / "databases.json"
        return len(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else 0
    except Exception as exc:  # noqa: BLE001 - a count is a courtesy, never a reason to fail the list
        _log.swallowed(exc, "_database_count")
        return 0


def _refuse_while_used_elsewhere(name: str) -> None:
    """Refuse to delete a model whose processes still supply processes OUTSIDE it.

    Moving a process to `My processes` keeps its inputs, which may point back into the model it came
    from; deleting that model then left the library dataset with an exchange into nothing
    (UnknownObject) — and every model drawing on it with a broken input. Single-process deletes already
    check their consumers; deleting the whole database went round that. Removing the outside inputs
    silently would change other studies' results, so the answer is no, with the processes named.
    """
    from bw2data.backends import ExchangeDataset

    bd = get_bd()
    rows = (
        ExchangeDataset.select(ExchangeDataset.output_database, ExchangeDataset.output_code)
        .where((ExchangeDataset.input_database == name) & (ExchangeDataset.output_database != name))
        .distinct()
        .limit(50)
    )
    consumers = [(r.output_database, r.output_code) for r in rows]
    if not consumers:
        return
    named: list[str] = []
    for db, code in consumers[:5]:
        try:
            named.append(f'"{bd.get_activity((db, code))["name"]}" in "{db}"')
        except Exception:  # noqa: BLE001 - a name is a courtesy; the refusal stands without it
            named.append(f'"{code}" in "{db}"')
    more = f" and {len(consumers) - 5} more" if len(consumers) > 5 else ""
    raise PrismError(
        f'Model "{name}" still supplies processes outside it: {", ".join(named)}{more}. Deleting it '
        "would leave them with inputs that point at nothing.",
        code="model_in_use",
        status_code=409,
        hint="Relink or remove those inputs first (in the library: open the dataset under My processes), "
        "then delete the model.",
    )


def _project_names(bd) -> list[str]:
    return [p.name for p in bd.projects]


def _is_populated(bd) -> bool:
    """True if the *current* project holds real inventory (any non-biosphere,
    non-empty database). ``len()`` is a cheap SQL count, not a full load."""
    for name in bd.databases:
        if name == BIOSPHERE_DB:
            continue
        try:
            if len(bd.Database(name)) > 0:
                return True
        except Exception as exc:  # pragma: no cover - corrupt/half-written db metadata
            _log.swallowed(exc, "_is_populated")
            continue
    return False


class BrightwayRepository(LcaRepository):
    def backend_info(self) -> BackendInfo:
        bd = get_bd()
        return BackendInfo(
            engine="brightway25",
            engine_version=_bw_version(),
            ready=True,
            note=f"Active workspace: {bd.projects.current}",
        )

    def ensure_working_project(self) -> None:
        """Don't strand the user on bw2data's empty throwaway ``default`` project.

        bw2data persists the last active project and auto-creates an empty
        ``default`` if none was set. When that leaves us on an empty project but
        a populated PrismLCA project exists (e.g. the ecoinvent stack), activate the
        real one so search/canvas have data. On a genuine first run (nothing
        populated anywhere) we stay put and the import wizard fills the project.
        """
        bd = get_bd()
        if _is_populated(bd):
            return
        original = bd.projects.current
        for name in _project_names(bd):
            if name == original:
                continue
            bd.projects.set_current(name)
            if _is_populated(bd):
                return
        bd.projects.set_current(original)

    def list_projects(self) -> list[ProjectInfo]:
        bd = get_bd()
        current = bd.projects.current
        infos = [
            ProjectInfo(
                name=p.name, is_active=(p.name == current), database_count=_database_count(bd, p, current)
            )
            for p in bd.projects
        ]
        # bw2data's throwaway ``default`` is listed only while it holds something or is where the
        # user stands: the first import proposes a workspace of its own ("Main"), and the empty
        # leftover would otherwise sit in the picker forever.
        return [i for i in infos if i.name != "default" or i.is_active or i.database_count]

    def current_project(self) -> ProjectInfo | None:
        bd = get_bd()
        name = bd.projects.current
        if not name:
            return None
        return ProjectInfo(name=name, database_count=len(bd.databases), is_active=True)

    def create_project(self, name: str) -> ProjectInfo:
        bd = get_bd()
        name = (name or "").strip()
        if not name:
            raise PrismError("Workspace name must not be empty.", code="invalid_name",
                             hint="Provide a non-empty workspace name.")
        if name in _project_names(bd):
            raise PrismError(f"Workspace '{name}' already exists.", code="project_exists",
                             status_code=409, hint="Activate it or choose another name.")
        bd.projects.set_current(name)  # creates and activates
        return ProjectInfo(name=name, database_count=len(bd.databases), is_active=True)

    def set_current_project(self, name: str) -> ProjectInfo:
        bd = get_bd()
        if name not in _project_names(bd):
            raise PrismError(f"Workspace '{name}' does not exist.", code="project_not_found",
                             status_code=404, hint="Create it first via POST /api/v1/projects.")
        bd.projects.set_current(name)
        return ProjectInfo(name=name, database_count=len(bd.databases), is_active=True)

    def delete_project(self, name: str) -> None:
        bd = get_bd()
        name = (name or "").strip()
        if name not in _project_names(bd):
            raise PrismError(f"Workspace '{name}' does not exist.", code="project_not_found",
                             status_code=404, hint="Nothing to delete.")
        if name == "default":
            raise PrismError("The 'default' workspace cannot be deleted.", code="project_protected",
                             status_code=400, hint="Brightway always keeps a 'default' workspace.")
        # Never delete the project we are standing in — switch to 'default' first.
        if name == bd.projects.current:
            bd.projects.set_current("default")
        # de facto via Brightway — removes both the DB row and the on-disk data directory.
        bd.projects.delete_project(name, delete_dir=True)

    def list_databases(self) -> list[DatabaseInfo]:
        bd = get_bd()
        out: list[DatabaseInfo] = []
        for name in bd.databases:
            read_only = is_read_only(name)
            if name == BIOSPHERE_DB:
                kind = "biosphere"
            elif is_library(name):
                # Writable like a model, but not a study: it holds datasets several models draw on,
                # so the Overview must not list it among them.
                kind = "library"
            elif read_only:
                kind = "background"
            else:
                kind = "foreground"
            try:
                node_count = len(bd.Database(name))
            except Exception as exc:  # pragma: no cover - fall back to stored metadata
                _log.swallowed(exc, "list_databases")
                node_count = int(bd.databases[name].get("number", 0) or 0)
            out.append(
                DatabaseInfo(name=name, node_count=node_count, read_only=read_only, kind=kind)
            )
        return out

    def create_foreground_database(self, name: str) -> DatabaseInfo:
        bd = get_bd()
        name = (name or "foreground").strip()
        if name in bd.databases:
            raise PrismError(f"Database '{name}' already exists.", code="database_exists",
                             status_code=409, hint="Choose another name.")
        # `searchable=False`: bw2data would otherwise maintain its own full-text index on every
        # save — PrismLCA has its own (`prism_search`) and never reads that one. See
        # engine/hygiene.py.
        bd.Database(name).register(searchable=False)
        set_read_only(name, False)  # foreground databases are writable
        # A model now exists — run the (guarded) legacy param migration if it was waiting.
        try:
            from prism_lca.engine import params as _params

            _params.migrate_project_to_models()
        except Exception as exc:  # noqa: BLE001 - never let migration block model creation
            _log.swallowed(exc, "create_foreground_database")
        return DatabaseInfo(name=name, node_count=0, read_only=False, kind="foreground")

    def duplicate_foreground_database(self, source: str, name: str) -> DatabaseInfo:
        """Copy a whole foreground model into a new writable database. Internal (model-internal)
        links are remapped to the new copies; inputs to background/biosphere are shared. Tags on
        the source activities and the model's study metadata (goal & scope) are copied too."""
        from prism_lca.engine import model as _model
        from prism_lca.engine.study import COMPARED_WITH, StudyMetaStore
        from prism_lca.engine.tags import TagStore

        bd = get_bd()
        name = (name or "").strip()
        if source not in bd.databases:
            raise PrismError(f"Database '{source}' does not exist.", code="database_not_found",
                             status_code=404)
        if is_read_only(source):
            raise PrismError("Only foreground models can be duplicated.", code="not_foreground",
                             status_code=400, hint="Pick a writable model as the source.")
        if not name:
            raise PrismError("New model name must not be empty.", code="invalid_name")
        if name in bd.databases:
            raise PrismError(f"Database '{name}' already exists.", code="database_exists",
                             status_code=409, hint="Choose another name.")

        src_db = bd.Database(source)
        code_map = {act.key[1]: _model.new_uid() for act in src_db}  # old code -> new code
        target = bd.Database(name)
        target.register(searchable=False)  # see create_foreground_database
        set_read_only(name, False)
        tags = TagStore()

        for act in src_db:
            new_code = code_map[act.key[1]]
            new = target.new_activity(
                code=new_code, name=act.get("name"),
                unit=act.get("unit") or "unit", location=act.get("location") or "GLO",
            )
            # Full copy of the remaining stored fields — comment, ISO documentation
            # (prism_doc), classifications, reference product … — not just the basics.
            for k, v in dict(act).items():
                if k not in ("database", "code", "id", "name", "unit", "location", "exchanges"):
                    new[k] = v
            new["type"] = act.get("type") or "process"
            new.save()
            for tag in tags.list_for(source, act.key[1]):
                tags.add(name, new_code, tag["dimension"], tag["value"])
        # Second pass: recreate exchanges with internal links remapped to the copies.
        for act in src_db:
            new = target.get(code_map[act.key[1]])
            for ex in act.exchanges():
                if ex.get("type") == "production":
                    target_input = new
                elif ex.input.key[0] == source and ex.input.key[1] in code_map:
                    target_input = target.get(code_map[ex.input.key[1]])  # internal → copy
                else:
                    target_input = ex.input  # background / biosphere → shared
                ne = new.new_edge(input=target_input, amount=ex.get("amount"), type=ex.get("type"))
                # Full copy: formula, uncertainty, pedigree, comment, properties — not just amount.
                for k, v in _model.exchange_extra_fields(ex).items():
                    ne[k] = v
                ne["prism_uid"] = _model.new_uid()
                ne.save()
                if ex.get("prism_uid"):  # an input's own tag follows it under the copy's key
                    old = TagStore.exchange_code(act.key[1], ex["prism_uid"])
                    for tag in tags.list_for(source, old):
                        tags.set_tag(name, TagStore.exchange_code(new.key[1], ne["prism_uid"]),
                                     tag["dimension"], tag["value"])

        # The study metadata (goal & scope, FU, boundaries …) belongs to the model — copy it too.
        study = StudyMetaStore()
        snapshot = dict(study.get(source))
        # The relation to the models the source is compared with is not copied: it is symmetric, and the
        # copy would hold one half of it. Linking a duplicate is the user's explicit act.
        snapshot.pop(COMPARED_WITH, None)
        if snapshot:
            study.replace(name, snapshot)

        # Parameters, their groups and scenarios are model-scoped — carry them into the copy.
        from prism_lca.engine import parameter_groups
        from prism_lca.engine import params as _params
        from prism_lca.engine.scenarios import ScenarioStore

        gid_map = parameter_groups.copy(source, name)  # {old group id: new group id}
        _params.copy_params(source, name, group_id_map=gid_map)
        ScenarioStore().copy(source, name)

        # The copied exchanges carry their `formula` text, but a formula that belongs to no parameter
        # group never recalculates: `recalc_all()` only walks groups that already exist, and a fresh
        # copy has none. Without this the copy looked complete — parameters listed, formulas shown,
        # scenarios present — and was frozen: every parameter edit and every scenario override was a
        # silent no-op, so a duplicate of a parameterised model reported the source's numbers forever.
        # Must run after `copy_params`, because the formulas resolve against the copy's own
        # parameters. The same trap is already handled on the activity-duplicate, model-rename and
        # sheet-import paths.
        _params.reregister_database_groups(name)

        return DatabaseInfo(name=name, node_count=len(target), read_only=False, kind="foreground")

    def rename_foreground_database(self, source: str, name: str) -> DatabaseInfo:
        """Rename a foreground model in place (activity codes are preserved). Tags and chat history
        keyed by the old name are moved to the new name."""
        bd = get_bd()
        name = (name or "").strip()
        if source not in bd.databases:
            raise PrismError(f"Database '{source}' does not exist.", code="database_not_found",
                             status_code=404)
        if is_read_only(source):
            raise PrismError("Only foreground models can be renamed.", code="not_foreground",
                             status_code=400, hint="Background databases are read-only.")
        if not name:
            raise PrismError("New model name must not be empty.", code="invalid_name")
        if name == source:
            return DatabaseInfo(name=source, node_count=len(bd.Database(source)),
                                read_only=False, kind="foreground")
        if name in bd.databases:
            raise PrismError(f"Database '{name}' already exists.", code="database_exists",
                             status_code=409, hint="Choose another name.")
        from prism_lca.engine import hygiene
        from prism_lca.engine import params as _params
        from prism_lca.engine._store import per_model_stores
        from prism_lca.engine.lca import invalidate_lca_cache

        # bw2data's rename deregisters the old database, which DELETES its DatabaseParameter rows
        # and the activities' parameter groups — so snapshot the parameters first, then recreate
        # and re-register them under the new name afterwards. Parameters stay an explicit step
        # beside the registry precisely because of this ordering constraint.
        param_dump = _params.dump_params(source)
        # While the registry still lists `source`: its legacy study file must find it (engine/study.py).
        from prism_lca.engine import study as _study

        _study.ensure_migrated(source)
        stale = hygiene.database_files(source)  # bw2data's rename writes the new name, leaves the old zip
        bd.Database(source).rename(name)
        hygiene.remove_files(stale)
        set_read_only(name, False)

        _params.load_params(name, param_dump)
        # Model-scoped data must follow the new name, or it strands under the dead old name. One
        # registry instead of a hand-written list per cascade: "forgot to add the new store" has
        # shipped once already (resurrected reports — see report_store.remove_database).
        for store in per_model_stores():
            store.rename(source, name)
        _params.reregister_database_groups(name)  # revive the renamed model's exchange formulas
        invalidate_lca_cache()
        return DatabaseInfo(name=name, node_count=len(bd.Database(name)),
                            read_only=False, kind="foreground")

    def delete_foreground_database(self, name: str) -> dict:
        """Delete a whole foreground model and its processes. Tags + chat history are cleaned up."""
        bd = get_bd()
        if name not in bd.databases:
            raise PrismError(f"Database '{name}' does not exist.", code="database_not_found",
                             status_code=404)
        if is_read_only(name):
            raise PrismError("Background databases cannot be deleted.", code="read_only_database",
                             status_code=409, hint="Only foreground models can be deleted.")
        if is_library(name):
            # Writable, so the read-only guard above lets it through — and every model that draws
            # on a library dataset would lose it at once.
            raise PrismError("The library cannot be deleted.", code="library_protected",
                             status_code=409,
                             hint="Remove single imports under Background, or datasets one by one.")
        _refuse_while_used_elsewhere(name)
        from prism_lca.engine import hygiene

        stale = hygiene.database_files(name)  # named now: after delete() the name resolves to nothing
        # Before the registry forgets it: its legacy study file must not outlive it (engine/study.py).
        from prism_lca.engine import study as _study

        _study.ensure_migrated(name)
        bd.Database(name).delete(warn=False)
        try:
            del bd.databases[name]  # ensure it is deregistered if delete() kept the entry
        except Exception as exc:  # noqa: BLE001 - already gone
            _log.swallowed(exc, "delete_foreground_database")
        hygiene.remove_files(stale)  # bw2data's delete() removes rows and index, never the processed zip
        from prism_lca.engine import params as _params
        from prism_lca.engine._store import per_model_stores
        from prism_lca.engine.lca import invalidate_lca_cache

        # Parameters live in bw2data rows, not JSON — explicit beside the registry (see rename).
        _params.remove_database(name)
        # Every JSON-backed per-model store, via the one registry — see per_model_stores().
        for store in per_model_stores():
            store.remove(name)
        # The model's chats went with it; attachments only those chats named are now nobody's.
        from prism_lca.engine.attachments import prune_unreferenced

        prune_unreferenced()
        invalidate_lca_cache()
        return {"deleted": name}
