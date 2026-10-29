"""Repository layer — the single seam between PrismLCA and the LCA engine (ADR-002)."""
from __future__ import annotations

from prism_lca.repository.base import (
    BackendInfo,
    DatabaseInfo,
    LcaRepository,
    ProjectInfo,
)
from prism_lca.repository.stub import StubRepository

__all__ = [
    "BackendInfo",
    "DatabaseInfo",
    "LcaRepository",
    "ProjectInfo",
    "StubRepository",
]
