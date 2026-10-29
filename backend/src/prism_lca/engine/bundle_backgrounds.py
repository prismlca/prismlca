"""The background databases installed here, as a bundle sees them.

Two readers: the resolution ladder, which matches a bundle's references against every installed
background (and the library) by code and fingerprint, and the export, which writes each referenced
background's version and provider into the manifest so a receiver can tell whether it holds the same
data. Version and provider come from the registry entry an import writes (``prism_background``).
"""

from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.bundle_resolve import Installed, fingerprint_of
from prism_lca.engine.guardrails import is_read_only
from prism_lca.engine.library import is_library


def installed_backgrounds() -> list[Installed]:
    """Every background database here — plus the library — flattened for the resolution ladder.

    The library is not a background (writable, not in ``requires.backgrounds``), but a reference
    into "My processes" must resolve where that dataset exists: on the same machine, or at a
    receiver who has the same library. Without the library section of the bundle, that is the only way
    such a link survives an import."""
    bd = get_bd()
    out: list[Installed] = []
    for name in bd.databases:
        if not is_read_only(name) and not is_library(name):
            continue
        meta = dict(bd.databases[name] or {})
        by_code = {
            act.key[1]: fingerprint_of(
                act.get("name") or "",
                act.get("reference product") or "",
                act.get("location") or "",
                act.get("unit") or "",
            )
            for act in bd.Database(name)
        }
        out.append(Installed(name=name, version=_version_of(name, meta), by_code=by_code))
    return out


def _version_of(name: str, meta: dict) -> str:
    """The background's version: from the registry entry (``prism_background.version``, written by
    the import or derived from the name), else the bare ``version`` key older projects may carry."""
    registry = meta.get("prism_background") or {}
    if registry.get("version"):
        return str(registry["version"])
    if meta.get("version"):
        return str(meta["version"])
    from prism_lca.engine.backgrounds.common import infer_from_name

    inferred = infer_from_name(name)
    return inferred.version if inferred else ""


def background_versions() -> dict[str, str]:
    bd = get_bd()
    return {
        name: _version_of(name, dict(bd.databases[name] or {}))
        for name in bd.databases
        if is_read_only(name)
    }


def background_providers() -> dict[str, str]:
    bd = get_bd()
    out = {}
    for name in bd.databases:
        if not is_read_only(name):
            continue
        registry = dict(bd.databases[name] or {}).get("prism_background") or {}
        out[name] = str(registry.get("provider") or "")
    return out
