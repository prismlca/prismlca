"""Reading ILCD — the one big format Brightway has no importer for.

Why we write this ourselves: bw2io covers EcoSpold 1/2, SimaPro CSV and openLCA JSON-LD (measured,
bw2io 0.9.17), and ILCD is the gap. It is also the format EU work runs on — the Environmental
Footprint reference packages are ILCD zips, the Life Cycle Data Network and soda4LCA serve ILCD,
and ILCD+EPD is the European standard for machine-readable EPDs.

**An ILCD package is a graph of files, not a file.** A process points at flows by UUID, a flow
points at a flow property, a flow property points at a unit group, and only the unit group knows
that the number in the process means kilograms. A single ``processDataSet`` on its own therefore
cannot say what its own amounts mean — the reader says so instead of guessing.

**Two kinds of dataset, and only one of them has an inventory.** ``typeOfDataSet`` distinguishes
them, and the difference is not cosmetic: an EPD or an "LCI result" carries characterised results
per EN 15804 module and *no elementary flows at all*. The Ökobaudat fixture in
``tests/fixtures/import`` is exactly that — 19 exchanges that are EPD indicators, 19 LCIAResults,
not one elementary flow. Trying to match its flows onto our biosphere would be looking for
something that is not there.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree

from prism_lca.engine.dataimport.model import (
    FlowProperty,
    ForeignDataset,
    ForeignExchange,
    ReadResult,
    SourceKind,
)

ILCD = "http://lca.jrc.it/ILCD/Process"
COMMON = "http://lca.jrc.it/ILCD/Common"
FLOW_NS = "http://lca.jrc.it/ILCD/Flow"
FP_NS = "http://lca.jrc.it/ILCD/FlowProperty"
UG_NS = "http://lca.jrc.it/ILCD/UnitGroup"

#: ``typeOfDataSet`` values that carry a real inventory. Everything else — "LCI result",
#: "Partly terminated system", "EPD", "Avoided product system" — is a result, not an inventory.
UNIT_PROCESS_TYPES = ("Unit process, single operation", "Unit process, black box")


def _text(node: ElementTree.Element | None) -> str:
    return (node.text or "").strip() if node is not None else ""


def _find_lang(parent: ElementTree.Element, path: str, lang: str = "en") -> str:
    """ILCD repeats every human string per language. Prefer English, take whatever exists."""
    found = parent.findall(path)
    for node in found:
        if node.get("{http://www.w3.org/XML/1998/namespace}lang") == lang:
            return _text(node)
    return _text(found[0]) if found else ""


@dataclass
class _Package:
    """The four dataset kinds an inventory needs, indexed by UUID."""

    processes: dict[str, ElementTree.Element] = field(default_factory=dict)
    flows: dict[str, ElementTree.Element] = field(default_factory=dict)
    flow_properties: dict[str, ElementTree.Element] = field(default_factory=dict)
    unit_groups: dict[str, ElementTree.Element] = field(default_factory=dict)
    #: Files whose UUID was already taken — the later one won. Kept because losing a dataset in
    #: silence is the failure mode, not the collision itself.
    shadowed: list[tuple[str, str]] = field(default_factory=list)
    #: Files that were not XML at all, or cut off — the same silence, one step earlier.
    #: Named so the notes can say which.
    unreadable: list[str] = field(default_factory=list)

    @property
    def resolvable(self) -> bool:
        """Whether amounts can be given a unit at all — see the module docstring."""
        return bool(self.flows)


def _uuid_of(root: ElementTree.Element) -> str:
    node = root.find(f".//{{{COMMON}}}UUID")
    return _text(node)


def _load(paths: list[tuple[str, bytes]]) -> _Package:
    pkg = _Package()
    buckets = {
        "processDataSet": pkg.processes,
        "flowDataSet": pkg.flows,
        "flowPropertyDataSet": pkg.flow_properties,
        "unitGroupDataSet": pkg.unit_groups,
    }
    for _name, raw in paths:
        try:
            root = ElementTree.fromstring(raw)
        except ElementTree.ParseError:
            pkg.unreadable.append(str(_name))
            continue
        local = root.tag.rpartition("}")[2]
        bucket = buckets.get(local)
        if bucket is None:
            continue
        uuid = _uuid_of(root)
        if not uuid:
            continue
        if uuid in bucket:
            # A UUID identifies a dataset, so the last file read wins — that part is right. What
            # is not right is doing it quietly: the InData ILCD+EPD sample package ships two
            # process files under one UUID, and a folder of four datasets read as three with
            # nothing on screen to say which one went.
            pkg.shadowed.append((local, _name.rsplit("/", 1)[-1]))
        bucket[uuid] = root
    return pkg


def _read_members(target: Path) -> list[tuple[str, bytes]]:
    if target.is_dir():
        return [(str(p), p.read_bytes()) for p in sorted(target.rglob("*.xml")) if p.is_file()]
    if target.suffix.lower() == ".zip" and zipfile.is_zipfile(target):
        with zipfile.ZipFile(target) as zf:
            return [(n, zf.read(n)) for n in zf.namelist() if n.lower().endswith(".xml")]
    return [(str(target), target.read_bytes())]


def _unit_of_flow(pkg: _Package, flow: ElementTree.Element) -> str:
    """flow → reference flow property → unit group → the unit at the reference index.

    Three hops, and every one of them can be missing from a partial export. An empty string is the
    honest answer then; the matcher treats "no unit" as a reason not to match, not as a wildcard.
    """
    ref_id = _text(flow.find(f".//{{{FLOW_NS}}}referenceToReferenceFlowProperty"))
    props = {
        p.get("dataSetInternalID"): p
        for p in flow.findall(f".//{{{FLOW_NS}}}flowProperty")
    }
    # `or` would be wrong here and Python says so: an Element with no children is FALSY, so a
    # flow property that exists but is empty would silently fall through to the first one in the
    # file — a different property, and therefore a different unit.
    prop = props.get(ref_id)
    if prop is None:
        prop = next(iter(props.values()), None)
    if prop is None:
        return ""
    return _unit_of_property(pkg, prop)


def _unit_of_property(pkg: _Package, prop: ElementTree.Element) -> str:
    """flow property element → flow-property file → unit group → the reference unit's name."""
    fp_ref = prop.find(f"{{{FLOW_NS}}}referenceToFlowPropertyDataSet")
    if fp_ref is None:
        return ""
    fp = pkg.flow_properties.get(fp_ref.get("refObjectId", ""))
    if fp is None:
        # No flow-property file in the package: its short description is the best we have, and it
        # usually reads "Mass" rather than "kg" — a name, not a unit. Say nothing instead.
        return ""
    ug_ref = fp.find(f".//{{{FP_NS}}}referenceToReferenceUnitGroup")
    ug = pkg.unit_groups.get(ug_ref.get("refObjectId", "")) if ug_ref is not None else None
    if ug is None:
        return ""
    ref_unit_id = _text(ug.find(f".//{{{UG_NS}}}referenceToReferenceUnit"))
    for unit in ug.findall(f".//{{{UG_NS}}}unit"):
        if unit.get("dataSetInternalID") == ref_unit_id:
            return _text(unit.find(f"{{{UG_NS}}}name"))
    return ""


def _properties_of_flow(pkg: _Package, flow: ElementTree.Element) -> tuple[FlowProperty, ...]:
    """Every non-reference flow property, as *amount per one reference unit*.

    An ILCD flow states all its properties against a common basis: the reference property's
    ``meanValue``. "Mass 1, Net calorific value 15" on a flow whose unit is kg says 15 MJ per kg —
    a calorific value the source itself vouches for. Dividing by the reference meanValue keeps that
    reading even when the basis is not 1.
    """
    ref_id = _text(flow.find(f".//{{{FLOW_NS}}}referenceToReferenceFlowProperty"))
    entries = flow.findall(f".//{{{FLOW_NS}}}flowProperty")
    ref_mean = 1.0
    for prop in entries:
        if prop.get("dataSetInternalID") == ref_id:
            try:
                ref_mean = float(_text(prop.find(f"{{{FLOW_NS}}}meanValue")) or 1.0)
            except ValueError:
                ref_mean = 1.0
    if ref_mean <= 0:
        return ()
    kept: list[FlowProperty] = []
    for prop in entries:
        if prop.get("dataSetInternalID") == ref_id:
            continue
        fp_ref = prop.find(f"{{{FLOW_NS}}}referenceToFlowPropertyDataSet")
        name = _find_lang(fp_ref, f"{{{COMMON}}}shortDescription") if fp_ref is not None else ""
        unit = _unit_of_property(pkg, prop)
        try:
            mean = float(_text(prop.find(f"{{{FLOW_NS}}}meanValue")) or 0.0)
        except ValueError:
            continue
        if name and unit and mean > 0:
            kept.append(FlowProperty(name=name, amount=mean / ref_mean, unit=unit))
    return tuple(kept)


def _compartment_of_flow(flow: ElementTree.Element) -> tuple[str, ...]:
    """The compartment path, in the order ILCD writes it (``Emissions`` → ``Emissions to air``…).

    Only ``elementaryFlowCategorization`` counts. The other classification an ILCD flow can carry
    is a product taxonomy (CPC and friends), and reading that as a compartment would put an
    emission into "Chemical products".
    """
    for cat in flow.iter(f"{{{COMMON}}}elementaryFlowCategorization"):
        levels = sorted(
            cat.findall(f"{{{COMMON}}}category"),
            key=lambda c: int(c.get("level") or 0),
        )
        return tuple(_text(c) for c in levels if _text(c))
    return ()


def _flow_kind(flow: ElementTree.Element) -> str:
    kind = _text(flow.find(f".//{{{FLOW_NS}}}typeOfDataSet"))
    if kind.startswith("Elementary"):
        return "biosphere"
    return "technosphere"


def _dataset_kind(process: ElementTree.Element, exchanges: list[ForeignExchange]) -> SourceKind:
    """What this dataset is — decided by what it CARRIES, with the declared type as a tiebreaker.

    The declared type alone was wrong, and expensively so. ILCD calls an *LCI result* aggregated,
    and it is — a black box with no supply chain — but it carries the complete list of elementary
    flows, which is precisely what the matcher works on. Judging by the label put the EU's own EF
    reference data (93 LCI results) in the same bin as an EPD and refused it with the words "no
    elementary flows to match", which was untrue of every one of them.

    So: elementary flows present → importable. Only a dataset with results and no flows is not.
    """
    declared = _text(process.find(f".//{{{ILCD}}}typeOfDataSet"))
    if declared in UNIT_PROCESS_TYPES:
        return SourceKind.unit_process
    if any(exc.kind == "biosphere" for exc in exchanges):
        return SourceKind.lci_result
    if process.find(f".//{{{ILCD}}}LCIAResult") is not None or declared:
        # Results and no flows — or a single process file whose flow datasets are missing, in which
        # case nothing can be told apart yet and the note above says to export the whole package.
        return SourceKind.aggregated
    return SourceKind.unit_process


def _read_process(pkg: _Package, uuid: str, process: ElementTree.Element) -> ForeignDataset:
    name = _find_lang(process, f".//{{{ILCD}}}baseName")
    ref_internal = _text(process.find(f".//{{{ILCD}}}referenceToReferenceFlow"))
    location = process.find(f".//{{{ILCD}}}locationOfOperationSupplyOrProduction")
    exchanges: list[ForeignExchange] = []
    reference_product = ""
    reference_unit = ""

    for exc in process.findall(f".//{{{ILCD}}}exchange"):
        ref = exc.find(f"{{{ILCD}}}referenceToFlowDataSet")
        if ref is None:
            continue
        flow_uuid = ref.get("refObjectId", "")
        flow = pkg.flows.get(flow_uuid)
        label = _find_lang(ref, f"{{{COMMON}}}shortDescription")
        amount = _text(exc.find(f"{{{ILCD}}}resultingAmount")) or _text(exc.find(f"{{{ILCD}}}meanAmount"))
        direction = _text(exc.find(f"{{{ILCD}}}exchangeDirection")).lower()
        is_reference = exc.get("dataSetInternalID") == ref_internal and ref_internal != ""
        kind = "production" if is_reference else (_flow_kind(flow) if flow is not None else "unknown")
        flow_type = _text(flow.find(f".//{{{FLOW_NS}}}typeOfDataSet")) if flow is not None else ""

        entry = ForeignExchange(
            kind=kind,
            name=(_find_lang(flow, f".//{{{FLOW_NS}}}baseName") if flow is not None else label) or label,
            amount=float(amount) if amount else 0.0,
            unit=_unit_of_flow(pkg, flow) if flow is not None else "",
            compartment=_compartment_of_flow(flow) if flow is not None else (),
            properties=_properties_of_flow(pkg, flow) if flow is not None else (),
            uuid=flow_uuid or None,
            direction="output" if direction == "output" else "input",
            # A product flow going OUT that is not the reference is a co-product. A waste flow going
            # out is not: it is the service of having it treated, a different question.
            coproduct=kind == "technosphere" and direction == "output" and flow_type == "Product flow",
            waste=kind == "technosphere" and direction == "output" and flow_type == "Waste flow",
            raw={
                "shortDescription": label,
                "internalId": exc.get("dataSetInternalID"),
                **({"flowType": flow_type} if flow_type else {}),
            },
        )
        if is_reference:
            reference_product, reference_unit = entry.name, entry.unit
        exchanges.append(entry)

    return ForeignDataset(
        key=uuid,
        name=name or uuid,
        unit=reference_unit,
        # The geography is an ATTRIBUTE on the element, not its text — the text is a free-form
        # description of restrictions, which is a different thing and usually empty.
        location=(location.get("location") or "") if location is not None else "",
        reference_product=reference_product,
        comment=_find_lang(process, f".//{{{COMMON}}}generalComment"),
        kind=_dataset_kind(process, exchanges),
        exchanges=exchanges,
    )


def read(target: Path) -> ReadResult:
    """Read an ILCD file, folder or zip into the shape the matcher works on."""
    pkg = _load(_read_members(target))
    datasets = [_read_process(pkg, uuid, node) for uuid, node in pkg.processes.items()]
    notes: list[str] = []
    if datasets and not pkg.resolvable:
        notes.append(
            "This is a single ILCD process file without the flow datasets it points at. Amounts "
            "have no unit and flows have no compartment until the whole package is here — export "
            "the package (or the zip), not the one file."
        )
    if pkg.unreadable:
        shown = ", ".join(pkg.unreadable[:3]) + (f" and {len(pkg.unreadable) - 3} more" if len(pkg.unreadable) > 3 else "")
        notes.append(
            f"{len(pkg.unreadable)} file(s) in this package could not be parsed as XML and were left "
            f"out: {shown}. A process among them is missing from this import."
        )
    if pkg.shadowed:
        names = ", ".join(name for _kind, name in pkg.shadowed[:3])
        more = f" and {len(pkg.shadowed) - 3} more" if len(pkg.shadowed) > 3 else ""
        notes.append(
            f"{len(pkg.shadowed)} file(s) carry an identifier another file in this package already "
            f"used ({names}{more}). A UUID names one dataset, so only the last one read is kept — "
            "check the export if you expected all of them."
        )
    aggregated = sum(1 for d in datasets if d.kind is SourceKind.aggregated)
    if aggregated:
        notes.append(
            f"{aggregated} of {len(datasets)} datasets carry characterised results rather than an "
            "inventory (an EPD). They have no elementary flows to match, so they are not imported."
        )
    results = sum(1 for d in datasets if d.kind is SourceKind.lci_result)
    if results:
        notes.append(
            f"{results} of {len(datasets)} datasets are aggregated inventories (LCI results): their "
            "elementary flows are matched and imported, but each is a black box — there is no "
            "supply chain inside it to look into, and no way to check how it was made."
        )
    return ReadResult(datasets=datasets, notes=notes)
