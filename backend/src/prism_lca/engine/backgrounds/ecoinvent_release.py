"""Which ecoinvent release an extracted folder holds: its version and its system model.

The import names the database after both (``ecoinvent-3.13-cutoff``), and the registry, the report's
citation and every exported bundle take the version from that name — so a wrong guess here is a wrong
citation everywhere. Neither number is where one would look first: every ecoSpold-2 file and every
MasterData file reports majorRelease 3 / minorRelease 0, whatever the release. So the version is read
where ecoinvent writes it for people:

1. the "Database Version" line on the "Read me" sheet of the release's LCIA workbook
   ("3.13, November 2026"), which travels with the workbook whatever its file is called;
2. the folder names — the archive ``ecoinvent 3.13_cutoff_ecoSpold02.7z`` extracts into a folder of
   that name, and the workbook is called ``LCIA Implementation 3.13.xlsx``.

Two sources that disagree mean two releases were mixed; that is refused before anything is read,
rather than four minutes later at the first factor that does not link. The system model IS in every
dataset (``systemModelName``), so one file settles it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from prism_lca.errors import PrismError

#: ecoinvent's system-model names (MasterData/SystemModels.xml) → the slug in the database name, which
#: :func:`prism_lca.engine.backgrounds.common.infer_from_name` reads back.
SYSTEM_MODELS = {
    "allocation, cut-off by classification": "cutoff",
    "allocation at the point of substitution": "apos",
    "substitution, consequential, long-term": "consequential",
    "allocation, cut-off, en15804": "en15804",
}

_VERSION = r"(\d+\.\d+)(?![\d.])"
#: "ecoinvent 3.13_cutoff_ecoSpold02", "ecoinvent_3.13", "ecoinvent-v3.13" — the release's own folder.
_IN_FOLDER = re.compile(r"ecoinvent[\s_-]*v?" + _VERSION, re.IGNORECASE)
#: "LCIA Implementation 3.13.xlsx", "ecoinvent 3.13_LCIA_implementation".
_IN_WORKBOOK_NAME = re.compile(r"(?:ecoinvent|implementation)[\s_-]*v?" + _VERSION, re.IGNORECASE)
_SYSTEM_MODEL = re.compile(r"<systemModelName[^>]*>([^<]+)</systemModelName>")


@dataclass
class Release:
    version: str | None
    system_model: str | None
    #: Where each value came from, for the error message and the log.
    evidence: dict[str, str]

    def database_name(self, requested: str | None = None) -> str:
        """The name to import under: the caller's, when it does not contradict the release, else
        ``ecoinvent-<version>-<system model>``. A requested name that carries another version is refused —
        it would put that version into the registry and the report's citation."""
        if requested:
            from prism_lca.engine.backgrounds.common import infer_from_name

            named = infer_from_name(requested)
            if named and self.version and named.version != self.version:
                raise PrismError(
                    f"'{requested}' names ecoinvent {named.version}, but the folder holds {self.version}.",
                    code="release_mismatch",
                    status_code=400,
                    hint="Leave the database name out — PrismLCA names it after the release it reads.",
                )
            return requested
        if not self.version:
            raise PrismError(
                "Could not tell which ecoinvent release this folder holds.",
                code="release_unknown",
                status_code=400,
                hint="Choose the release's LCIA workbook as well — its 'Read me' sheet names the "
                "version — or keep the folder name the archive extracts to, e.g. "
                "'ecoinvent 3.13_cutoff_ecoSpold02'.",
            )
        return f"ecoinvent-{self.version}-{self.system_model or 'cutoff'}"


def version_in_path(path: Path) -> str | None:
    """The version in the nearest folder name that carries one (the datasets folder, then its parents)."""
    for part in (path, *path.parents):
        found = _IN_FOLDER.search(part.name)
        if found:
            return found.group(1)
    return None


def version_in_workbook(xlsx: Path) -> str | None:
    """The "Database Version" line of the workbook's "Read me" sheet, else the version in its file name.

    Read-only and lazy: the sheet is a hundred rows, the factors sheet beside it is never touched."""
    try:
        from openpyxl import load_workbook

        workbook = load_workbook(xlsx, read_only=True, data_only=True)
        try:
            if "Read me" in workbook.sheetnames:
                for row in workbook["Read me"].iter_rows(max_row=200, values_only=True):
                    cells = [str(c).strip() for c in row if c is not None and str(c).strip()]
                    if len(cells) >= 2 and cells[0].lower() == "database version":
                        found = re.match(_VERSION, cells[1])
                        if found:
                            return found.group(1)
        finally:
            workbook.close()
    except Exception:  # noqa: BLE001 - an unreadable workbook is reported by the LCIA step itself
        pass
    found = _IN_WORKBOOK_NAME.search(xlsx.stem)
    return found.group(1) if found else None


def system_model_of(datasets: Path) -> str | None:
    """The system model one dataset of the folder names, as the slug of :data:`SYSTEM_MODELS`."""
    first = next(iter(sorted(datasets.glob("*.spold"))[:1]), None)
    if first is None:
        return None
    found = _SYSTEM_MODEL.search(first.read_text(encoding="utf-8", errors="replace"))
    if not found:
        return None
    name = found.group(1).strip().lower()
    return SYSTEM_MODELS.get(name) or re.sub(r"[^a-z0-9]+", "", name) or None


def identify(datasets: Path, lcia_xlsx: Path | None) -> Release:
    """Version and system model of the release in ``datasets``; refuses a workbook from another release."""
    evidence: dict[str, str] = {}
    from_workbook = version_in_workbook(lcia_xlsx) if lcia_xlsx is not None else None
    from_folder = version_in_path(datasets)
    if from_workbook:
        evidence["workbook"] = from_workbook
    if from_folder:
        evidence["folder"] = from_folder
    if from_workbook and from_folder and from_workbook != from_folder:
        raise PrismError(
            f"The LCIA workbook is from ecoinvent {from_workbook}, the datasets folder from "
            f"{from_folder}.",
            code="release_mismatch",
            status_code=400,
            hint="Datasets and LCIA workbook must come from the same release: every "
            "characterisation factor links to a flow of that release's list.",
        )
    model = system_model_of(datasets)
    if model:
        evidence["system_model"] = model
    return Release(version=from_workbook or from_folder, system_model=model, evidence=evidence)
