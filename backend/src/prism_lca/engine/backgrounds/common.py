"""What every background database has in common: a registry entry and a provider.

PrismLCA knows two providers — ``ecoinvent`` (ecoSpold 2 + the release's LCIA workbook) and
``bafu`` (the Swiss Federal Administration's ecoSpold-1 database). A project holds at most one
database per provider. The registry is not a table of its own: it is
the ``prism_background`` entry in Brightway's database metadata, next to ``prism_read_only`` and
``prism_import_complete``. A database imported before the registry existed gets its entry derived
from its name the first time anyone asks (``ecoinvent-3.12-cutoff`` → ecoinvent, 3.12, cut-off).

ecoinvent is the master: whenever it is present its flow list and its LCIA workbook are the
reference, and a BAFU import (or an earlier BAFU import, once ecoinvent arrives) is mapped onto
it — never the other way round.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.library import is_library

REGISTRY_KEY = "prism_background"
BIOSPHERE_DB = "biosphere3"
COMPLETE_KEY = "prism_import_complete"

PROVIDER_ECOINVENT = "ecoinvent"
PROVIDER_BAFU = "bafu"
PROVIDERS = (PROVIDER_ECOINVENT, PROVIDER_BAFU)

#: The citation each provider asks for. BAFU's is a licence condition (Terms of Use, 23.06.2026);
#: ecoinvent's is the usual reference. Both end up in the report's bibliography.
CITATIONS = {
    PROVIDER_ECOINVENT: "ecoinvent Association: ecoinvent database v{version}, {system_model} system model. Zurich.",
    PROVIDER_BAFU: "Life Cycle Inventory database of the Swiss Federal Administration, BAFU:{version}",
}

_ECOINVENT_NAME_RE = re.compile(r"^ecoinvent[-_ ](\d+\.\d+)[-_ ]?(\w+)?$", re.I)
_BAFU_NAME_RE = re.compile(r"^bafu[-_ ](\d{4})(?:[-_ ]?v(\d+))?$", re.I)


@dataclass
class BackgroundInfo:
    """One registry entry. ``flow_mapping`` is the import report of the elementary-flow ladder
    (BAFU only): exchanges per rung, new flows created, which target list they were mapped to."""

    provider: str
    label: str
    version: str
    system_model: str = ""
    citation: str = ""
    source_path: str = ""
    imported_at: str = ""
    flow_mapping: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


def infer_from_name(name: str) -> BackgroundInfo | None:
    """The registry entry a pre-registry database would have had, derived from its name."""
    m = _ECOINVENT_NAME_RE.match(name)
    if m:
        version = m.group(1)
        system_model = {
            "cutoff": "cut-off",
            "cut-off": "cut-off",
            "apos": "APOS",
            "consequential": "consequential",
        }.get((m.group(2) or "cutoff").lower(), m.group(2) or "cut-off")
        return BackgroundInfo(
            provider=PROVIDER_ECOINVENT,
            label=f"ecoinvent {version} {system_model}",
            version=version,
            system_model=system_model,
            citation=CITATIONS[PROVIDER_ECOINVENT].format(
                version=version, system_model=system_model
            ),
        )
    m = _BAFU_NAME_RE.match(name)
    if m:
        year, minor = m.group(1), m.group(2) or "1"
        return BackgroundInfo(
            provider=PROVIDER_BAFU,
            label=f"BAFU:{year} v{minor}",
            version=f"{year} v{minor}",
            system_model="attributional (DQRv2:2023)",
            citation=CITATIONS[PROVIDER_BAFU].format(version=year),
        )
    return None


def is_background(name: str) -> bool:
    """A read-only inventory the user draws on: complete import, or explicitly read-only."""
    bd = get_bd()
    if name in (BIOSPHERE_DB,) or is_library(name) or name not in bd.databases:
        return False
    meta = bd.databases[name]
    return bool(meta.get(COMPLETE_KEY)) or meta.get("prism_read_only") is True


def registry(name: str) -> BackgroundInfo | None:
    """The registry entry of a background database; derived and written once when missing."""
    bd = get_bd()
    if not is_background(name):
        return None
    meta = bd.databases[name]
    raw = meta.get(REGISTRY_KEY)
    if raw:
        return BackgroundInfo(
            **{
                k: raw.get(k, "")
                for k in BackgroundInfo.__dataclass_fields__
                if k != "flow_mapping"
            },
            flow_mapping=raw.get("flow_mapping") or {},
        )
    inferred = infer_from_name(name)
    if inferred is None:
        return None
    meta[REGISTRY_KEY] = inferred.as_dict()
    bd.databases.flush()
    return inferred


def write_registry(name: str, info: BackgroundInfo) -> None:
    bd = get_bd()
    if not info.imported_at:
        info.imported_at = datetime.now(UTC).isoformat(timespec="seconds")
    bd.databases[name][REGISTRY_KEY] = info.as_dict()
    bd.databases.flush()


def backgrounds() -> list[tuple[str, BackgroundInfo | None]]:
    """Every background database of the current project with its registry entry, by name."""
    bd = get_bd()
    return [(name, registry(name)) for name in sorted(bd.databases) if is_background(name)]


def database_of(provider: str) -> str | None:
    for name, info in backgrounds():
        if info is not None and info.provider == provider:
            return name
    return None


def offered_providers() -> list[str]:
    """Which providers may still be imported: both on a bare project, the missing one when
    one is present, none when both are (no further background imports)."""
    present = {info.provider for _name, info in backgrounds() if info is not None}
    return [p for p in PROVIDERS if p not in present]


def ecoinvent_present() -> bool:
    return database_of(PROVIDER_ECOINVENT) is not None
