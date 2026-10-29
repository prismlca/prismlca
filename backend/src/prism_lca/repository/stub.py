"""Fast in-memory fake repository.

Not used by the running app (that uses BrightwayRepository); kept as a lightweight double
for API-shape tests and offline experiments. Mirrors the guardrail rule: background
databases are read-only, the foreground database is writable.
"""
from __future__ import annotations

from prism_lca.errors import PrismError
from prism_lca.repository.base import BackendInfo, DatabaseInfo, LcaRepository, ProjectInfo


class StubRepository(LcaRepository):
    def __init__(self) -> None:
        self._projects: set[str] = {"default"}
        self._current = "default"
        self._dbs: dict[str, DatabaseInfo] = {}

    def backend_info(self) -> BackendInfo:
        return BackendInfo(
            engine="brightway25",
            engine_version="in-memory-stub",
            ready=False,
            note="StubRepository — no real engine attached.",
        )

    def list_projects(self) -> list[ProjectInfo]:
        return [
            ProjectInfo(name=n, is_active=(n == self._current)) for n in sorted(self._projects)
        ]

    def current_project(self) -> ProjectInfo | None:
        return ProjectInfo(name=self._current, database_count=len(self._dbs), is_active=True)

    def create_project(self, name: str) -> ProjectInfo:
        name = (name or "").strip()
        if not name:
            raise PrismError("Workspace name must not be empty.", code="invalid_name",
                             hint="Provide a non-empty workspace name.")
        if name in self._projects:
            raise PrismError(f"Workspace '{name}' already exists.", code="project_exists",
                             status_code=409, hint="Activate it or choose another name.")
        self._projects.add(name)
        self._current = name
        self._dbs = {}
        return ProjectInfo(name=name, is_active=True)

    def set_current_project(self, name: str) -> ProjectInfo:
        if name not in self._projects:
            raise PrismError(f"Workspace '{name}' does not exist.", code="project_not_found",
                             status_code=404, hint="Create it first.")
        self._current = name
        return ProjectInfo(name=name, database_count=len(self._dbs), is_active=True)

    def delete_project(self, name: str) -> None:
        name = (name or "").strip()
        if name not in self._projects:
            raise PrismError(f"Workspace '{name}' does not exist.", code="project_not_found",
                             status_code=404, hint="Nothing to delete.")
        if name == "default":
            raise PrismError("The 'default' workspace cannot be deleted.", code="project_protected",
                             status_code=400, hint="Brightway always keeps a 'default' workspace.")
        if name == self._current:
            self._current = "default"
            self._dbs = {}
        self._projects.discard(name)

    def list_databases(self) -> list[DatabaseInfo]:
        return list(self._dbs.values())

    def create_foreground_database(self, name: str) -> DatabaseInfo:
        name = (name or "foreground").strip()
        if name in self._dbs:
            raise PrismError(f"Database '{name}' already exists.", code="database_exists",
                             status_code=409, hint="Choose another name.")
        info = DatabaseInfo(name=name, node_count=0, read_only=False, kind="foreground")
        self._dbs[name] = info
        return info
