"""What kind of file did the user just hand us?

Format is **detected, never asked**. A person who exports from SimaPro knows they exported from
SimaPro; they do not necessarily know that the thing on disk is "SimaPro CSV 8.0.5" rather than
"EcoSpold", and a dropdown of five format names is a quiz nobody should have to pass.

The detection reads the first few hundred bytes — never the whole file. An ILCD package is a
directory of thousands of XML files and an ecoinvent release is 20 GB; sniffing has to be cheap
enough to run on the drop.

What each format actually announces (verified against the fixtures in
``tests/fixtures/import``, see SOURCES.md there):

* EcoSpold 1 — root ``ecoSpold`` in namespace ``…/EcoSpold01``
* EcoSpold 2 — root ``ecoSpold`` in namespace ``…/EcoSpold02``; files end in ``.spold``
* ILCD — root ``processDataSet`` (or one of its siblings) in an ``…/ILCD/…`` namespace
* SimaPro CSV — a first line of curly-brace metadata opening with ``{SimaPro``
* openLCA JSON-LD — a zip or directory carrying ``processes/`` and ``context.json``

**Root name and namespace must agree**, and both halves of that were learned from a failing test:

* brightway2-io ships a negative fixture whose root is ``notecoSpold`` while it still carries the
  EcoSpold01 namespace — so the namespace alone is not enough.
* An EcoSpold **2** file names its classification system ``EcoSpold01Categories``, so looking for
  ``"EcoSpold01"`` anywhere in the first kilobytes calls it EcoSpold 1 — so a substring search over
  the head is not enough either. The namespace is read off the root element with a pull parser.

One more ambiguity worth stating: ``processes/`` is a directory in an ILCD package **and** in an
openLCA JSON-LD tree. What tells them apart is that one of them holds JSON.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from xml.etree import ElementTree

#: The ILCD dataset kinds a package is made of. A package that holds only flows or only unit
#: groups is still ILCD — it is just not the part that carries processes.
_ILCD_ROOTS = frozenset(
    {"processDataSet", "flowDataSet", "flowPropertyDataSet", "unitGroupDataSet", "contactDataSet", "sourceDataSet"}
)

#: How much of a file we are willing to read to recognise it. Enough for an XML prologue plus the
#: root element with its namespace declarations, which is where every signal we use lives.
SNIFF_BYTES = 4096


class SourceFormat(StrEnum):
    ecospold1 = "ecospold1"
    ecospold2 = "ecospold2"
    ilcd = "ilcd"
    simapro_csv = "simapro_csv"
    json_ld = "json_ld"
    unknown = "unknown"


#: What each format is called where the user met it — the wizard says this, not the slug.
FORMAT_LABELS: dict[SourceFormat, str] = {
    SourceFormat.ecospold1: "EcoSpold 1 (ecoinvent 1/2, older exports)",
    SourceFormat.ecospold2: "EcoSpold 2 (ecoinvent 3)",
    SourceFormat.ilcd: "ILCD (EU Environmental Footprint, EPD packages, soda4LCA)",
    SourceFormat.simapro_csv: "SimaPro CSV",
    SourceFormat.json_ld: "openLCA JSON-LD",
    SourceFormat.unknown: "not recognised",
}


#: Lines a SimaPro export puts in its first block, whatever the version wrote in line one. Used as
#: the second signal, so a stray text file that merely mentions SimaPro is not taken for an export.
_SIMAPRO_BLOCKS = ("Project", "Process", "Products", "Materials/fuels", "Category type", "Date")


def _simapro_header(head: str) -> str:
    """Whether this looks like a SimaPro CSV export, and what gave it away.

    Braces were the whole test once, and real exports do not always have them. Two of brightway2-io's
    fixtures — both genuine process exports — open with ``SimaPro 8.0.4.30;process;Date:;…`` and
    ``SimaPro don't even know<TAB>processes<TAB>Date:…``. We refused both as "not a format PrismLCA
    reads", which is the worst answer available: the user has a SimaPro export in their hand.

    So: line one names SimaPro, and the head carries one of the block keywords an export always
    writes. One signal alone would take a note about SimaPro for a database.
    """
    lines = [line.strip() for line in head.lstrip().splitlines() if line.strip()]
    if not lines:
        return ""
    first = lines[0]
    braced = re.match(r"\{SimaPro ([^}]+)\}", first)
    if braced:
        return f"SimaPro export header, version {braced.group(1)}"
    if not first.startswith("SimaPro"):
        return ""
    if not any(
        line.split(";")[0].split("\t")[0].strip() in _SIMAPRO_BLOCKS for line in lines[1:40]
    ):
        return ""
    return f"SimaPro export header: {first[:60]}"


@dataclass(frozen=True)
class Detection:
    format: SourceFormat
    #: Which files carry the data — one for a single file, many for a package.
    files: tuple[Path, ...]
    #: What the detector saw, in the user's words. Shown when it guesses wrong so they can say so.
    evidence: str

    @property
    def label(self) -> str:
        return FORMAT_LABELS[self.format]


def _head(path: Path, size: int = SNIFF_BYTES) -> str:
    try:
        with path.open("rb") as fh:
            raw = fh.read(size)
    except OSError:
        return ""
    # utf-8-sig: every EcoSpold fixture we have starts with a BOM, and a stray ﻿ in front of
    # "<?xml" defeats a naive startswith.
    return raw.decode("utf-8-sig", errors="replace")


def _root_tag(head: str) -> tuple[str, str] | None:
    """``(namespace, localname)`` of the root element, or None if this is not parseable XML.

    A pull parser rather than a substring search, and the reason is a measured one: an EcoSpold **2**
    file names its classification system ``EcoSpold01Categories``, so ``"EcoSpold01" in head`` calls
    it EcoSpold 1. The namespace has to be read off the root element, not found somewhere in the
    first four kilobytes.
    """
    parser = ElementTree.XMLPullParser(events=("start",))
    try:
        parser.feed(head)
    except ElementTree.ParseError:
        return None
    for _event, elem in parser.read_events():
        tag = str(elem.tag)
        if tag.startswith("{"):
            namespace, _, local = tag[1:].partition("}")
            return namespace, local
        return "", tag
    return None


def _xml_format(head: str) -> SourceFormat | None:
    """The format an XML root announces. Namespace AND local name must agree."""
    root = _root_tag(head)
    if root is None:
        return None
    namespace, local = root
    if local == "ecoSpold":
        if "EcoSpold01" in namespace:
            return SourceFormat.ecospold1
        if "EcoSpold02" in namespace:
            return SourceFormat.ecospold2
        return None
    if local in _ILCD_ROOTS and "ILCD" in namespace:
        return SourceFormat.ilcd
    return None


def detect_file(path: Path) -> Detection:
    """Recognise one file. A directory or archive goes through :func:`detect`."""
    suffix = path.suffix.lower()
    head = _head(path)

    if suffix in {".csv", ".txt"}:
        simapro = _simapro_header(head)
        if simapro:
            return Detection(SourceFormat.simapro_csv, (path,), simapro)

    if suffix in {".xml", ".spold"} or head.lstrip().startswith("<?xml"):
        fmt = _xml_format(head)
        if fmt:
            root = re.search(r"<\s*(\w[\w:]*)[\s>]", head.split("?>", 1)[-1])
            return Detection(fmt, (path,), f"XML root <{root.group(1)}> in the {fmt.value} namespace" if root else fmt.value)
        # Name what stands there: "XML, but no" sends a person hunting through export settings,
        # while the actual root element sends them to the actual problem — a corrupted file
        # (`<notecoSpold>`, seen in the wild) or a vocabulary PrismLCA genuinely does not read.
        root = re.search(r"<\s*(\w[\w:]*)[\s>]", head.split("?>", 1)[-1])
        return Detection(
            SourceFormat.unknown,
            (),
            (
                f"XML whose root element <{root.group(1)}> is none PrismLCA knows — expected "
                f"<ecoSpold> (EcoSpold 1/2) or an ILCD dataset; if the name looks mangled, "
                f"the file is damaged"
                if root
                else "XML, but not a format PrismLCA reads"
            ),
        )

    if suffix == ".json" and '"@context"' in head:
        return Detection(SourceFormat.json_ld, (path,), "JSON-LD context")

    return Detection(SourceFormat.unknown, (), f"{suffix or 'no extension'} — not a format PrismLCA reads")


def _detect_dir(root: Path) -> Detection:
    """A package: a directory of XML files (ILCD, EcoSpold) or an openLCA JSON-LD tree."""
    # `processes/` alone does NOT mean openLCA: an ILCD package has one too. The JSON does.
    json_files = tuple(sorted(root.rglob("*.json")))
    if json_files and ((root / "context.json").is_file() or (root / "processes").is_dir()):
        return Detection(SourceFormat.json_ld, json_files, f"openLCA JSON-LD tree, {len(json_files)} files")

    # ILCD packages keep processes in `processes/`; some exports drop the datasets in flat.
    counts: dict[SourceFormat, list[Path]] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".xml", ".spold"}:
            continue
        fmt = _xml_format(_head(path))
        if fmt:
            counts.setdefault(fmt, []).append(path)
        # A package can hold thousands of files; the format is settled long before that.
        if sum(len(v) for v in counts.values()) >= 50:
            break

    if not counts:
        return Detection(SourceFormat.unknown, (), "no readable dataset files in this folder")
    fmt = max(counts, key=lambda k: len(counts[k]))
    # Re-walk without the cap, now that we know what we are collecting.
    files = tuple(p for p in sorted(root.rglob("*")) if p.is_file() and _xml_format(_head(p)) == fmt)
    return Detection(fmt, files, f"{len(files)} {fmt.value} files in this folder")


def detect(target: Path) -> Detection:
    """Recognise a file, a folder or a zip. The one entry point the API calls."""
    if target.is_dir():
        return _detect_dir(target)
    if target.suffix.lower() == ".zip" and zipfile.is_zipfile(target):
        return _detect_zip(target)
    return detect_file(target)


def _detect_zip(path: Path) -> Detection:
    """Look inside without unpacking: the names and the first bytes of a few members are enough."""
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        has_json = any(n.endswith(".json") for n in names)
        # openLCA writes its folders at the top of the archive ("processes/…"), so a processes folder
        # counts at the root as much as one level down (and "olca-schema.json" is openLCA 2's marker).
        in_processes = any(n.startswith("processes/") or "/processes/" in n for n in names)
        marker = any(n.endswith(("context.json", "olca-schema.json")) for n in names)
        if has_json and (marker or in_processes):
            return Detection(SourceFormat.json_ld, (path,), f"zipped openLCA JSON-LD, {len(names)} entries")
        for name in names[:200]:
            if not name.lower().endswith((".xml", ".spold")):
                continue
            with zf.open(name) as fh:
                fmt = _xml_format(fh.read(SNIFF_BYTES).decode("utf-8-sig", errors="replace"))
            if fmt:
                return Detection(fmt, (path,), f"zipped {fmt.value} package, {len(names)} entries")
    return Detection(SourceFormat.unknown, (), "zip, but nothing in it is a format PrismLCA reads")


def is_json_ld_package(target: Path) -> bool:
    """openLCA's own format, which bw2io reads from a directory rather than from single files."""
    return detect(target).format is SourceFormat.json_ld
