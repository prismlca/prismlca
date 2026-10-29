"""PrismLCA backend package.

The single source of truth for the app version is the installed package metadata
(see pyproject.toml). Frontend and backend are shipped and version-locked together.
"""
from __future__ import annotations

import importlib.metadata


def _version_from_pyproject() -> str:
    """Running from source without an install: read the one version that exists, never a copy.

    A literal here used to repeat pyproject's version and would have drifted at the first release;
    pyproject.toml is the one version source of the backend. An unreadable file yields a version no
    frontend matches, so the shell's startup check says so instead of pretending.
    """
    import re
    from pathlib import Path

    try:
        text = (Path(__file__).resolve().parents[2] / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        return "0.0.0+unknown"
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return m.group(1) if m else "0.0.0+unknown"


try:
    __version__ = importlib.metadata.version("prism-lca-backend")
except importlib.metadata.PackageNotFoundError:  # running from source without install
    __version__ = _version_from_pyproject()
