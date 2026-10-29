"""Abstract repository interface.

The contract for workspace (project) and foreground-database lifecycle. It is one part of
the engine seam: everything else reaches Brightway only through the lazy accessors in
`engine/bootstrap.py`, and nothing patches it — the lesson from the Activity Browser's
monkey-patching migration lock-in (docs/ARCHITEKTUR.md, ADR-002).
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from pydantic import BaseModel


class BackendInfo(BaseModel):
    engine: str
    engine_version: str
    ready: bool
    note: str | None = None


class ProjectInfo(BaseModel):
    name: str
    database_count: int = 0
    is_active: bool = False


class DatabaseInfo(BaseModel):
    name: str
    node_count: int = 0
    #: Background databases (ecoinvent, biosphere) are hard read-only (ADR-005).
    read_only: bool = True
    #: "foreground" | "background" | "biosphere"
    kind: str = "background"


class LcaRepository(ABC):
    """Contract the API/services depend on. Concrete impls: BrightwayRepository (real),
    StubRepository (fast in-memory fake for API-shape tests)."""

    @abstractmethod
    def backend_info(self) -> BackendInfo:
        """Describe the underlying engine and whether it is ready to compute."""

    @abstractmethod
    def list_projects(self) -> list[ProjectInfo]:
        """Return all known LCA projects."""

    @abstractmethod
    def current_project(self) -> ProjectInfo | None:
        """Return the active project, or None if none is selected."""

    @abstractmethod
    def create_project(self, name: str) -> ProjectInfo:
        """Create a new project and make it active."""

    @abstractmethod
    def set_current_project(self, name: str) -> ProjectInfo:
        """Activate an existing project."""

    @abstractmethod
    def delete_project(self, name: str) -> None:
        """Delete a project and its data directory. Refuses the active project and 'default'."""

    @abstractmethod
    def list_databases(self) -> list[DatabaseInfo]:
        """List databases in the active project, with their read-only status."""

    @abstractmethod
    def create_foreground_database(self, name: str) -> DatabaseInfo:
        """Create a writable foreground database in the active project."""
