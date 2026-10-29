"""BAFU:20XY — the Swiss Federal Administration's LCI database — as a background database.

The download is a folder of ecoSpold-1 files (11 947 in BAFU:2026 v1) without an XML namespace
and with dates bw2io's validating extractor refuses, so this module reads them itself with lxml
(concept D2). Datasets are single-output; technosphere exchanges point at other datasets through
the ecoSpold-1 ``number`` (100 % resolvable in 2026 v1); elementary exchanges (``inputGroup 4``
from nature, ``outputGroup 4`` to nature) go through the flow ladder of
:mod:`prism_lca.engine.backgrounds.flow_mapping` onto the project's biosphere, and the ones the
ladder cannot place become new, uncharacterised flows in that biosphere (D3), counted in the
import report.

Two situations:

* **ecoinvent is present** — its ``biosphere3`` (3.12 flow list) is the target; the ladder also
  uses ecoinvent's 3.9→3.12 renaming and its v2.2→v3 correspondence, both read from the user's
  bw2io installation.
* **no ecoinvent yet** — the project has no biosphere and no methods. Both are taken from what
  bw2io ships (the ecoinvent-3.9 flow list, 762 methods of the 3.9 LCIA implementation), written
  by this module and marked ``prism_origin: "bw2io"``. Brightway distributes these files, PrismLCA
  merely reads them at runtime (``docs/DATENHERKUNFT.md``). When ecoinvent arrives later the
  ecoinvent import replaces them and re-maps everything (:mod:`.sync`).

Every biosphere exchange keeps its source (``prism_source``: the BAFU name, compartment, unit,
amount and the rung that placed it) so that a later re-map has what it needs without re-reading
the files. Nothing here writes into an existing database except ``biosphere3`` (new flows only).
"""

from __future__ import annotations

import math
import re
import uuid
import zipfile
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from prism_lca import _log
from prism_lca.engine.backgrounds.common import (
    BIOSPHERE_DB,
    CITATIONS,
    COMPLETE_KEY,
    PROVIDER_BAFU,
    BackgroundInfo,
    ecoinvent_present,
    write_registry,
)
from prism_lca.engine.backgrounds.flow_mapping import (
    COMPARTMENTS,
    UNIT_ALIASES,
    Correspondence,
    Proposal,
    SourceFlow,
    TargetBiosphere,
    TargetFlow,
    _norm_cas,
    load_fallbacks,
    propose,
    renamed_flows,
)
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import set_read_only
from prism_lca.errors import PrismError

#: Default database name pattern (D10): minor release in the name, because BAFU ships corrected
#: versions and a bundle must tell v1 from v2.
DEFAULT_DATABASE = "bafu-2026-v1"
_FOLDER_RE = re.compile(r"BAFU[-_: ]?(\d{4})(?:[ _-]?v(\d+))?", re.I)
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_PEDIGREE_RE = re.compile(
    r"\(\s*([1-5])\s*,\s*([1-5])\s*,\s*([1-5])\s*,\s*([1-5])\s*,\s*([1-5])\s*(?:,\s*([1-5]|[^)]*))?\)"
)
_PEDIGREE_KEYS = (
    "reliability",
    "completeness",
    "temporal correlation",
    "geographical correlation",
    "further technological correlation",
    "sample size",
)

#: bw2io's bundled ecoinvent-3.9 material (read, never copied).
BW2IO_FLOWS_39 = Path("data") / "lci" / "ecoinvent elementary flows 3.9.xml"
BW2IO_METHODS_39 = Path("data") / "lcia" / "lcia_39_ecoinvent.zip"
BUNDLED_ORIGIN = "bw2io"
BUNDLED_METHOD_DESCRIPTION = "bw2io bundled LCIA (ecoinvent 3.9 implementation)"


# --------------------------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------------------------


@dataclass
class Exchange:
    number: str
    name: str
    category: str
    subcategory: str
    unit: str
    amount: float
    kind: str  # "production" | "technosphere" | "biosphere"
    location: str = ""
    cas: str = ""
    comment: str = ""
    uncertainty_type: int = 0
    sd95: float | None = None


@dataclass
class Dataset:
    code: str
    number: str
    name: str
    unit: str
    location: str
    category: str
    subcategory: str
    comment: str = ""
    included_processes: str = ""
    technology: str = ""
    period_start: str = ""
    period_end: str = ""
    infrastructure: bool = False
    source: str = ""
    exchanges: list[Exchange] = field(default_factory=list)

    @property
    def flow_key(self) -> tuple[str, str, str]:
        return (self.name, self.location, self.unit)


def _text(el, path: str) -> str:
    found = el.xpath(path)
    if not found:
        return ""
    node = found[0]
    return (node if isinstance(node, str) else (node.text or "")).strip()


def _first(el, local_name: str):
    found = el.xpath(f'.//*[local-name()="{local_name}"]')
    return found[0] if found else None


def _group(exc) -> tuple[str, int] | None:
    for child in exc:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag in ("inputGroup", "outputGroup"):
            try:
                return tag, int((child.text or "").strip())
            except ValueError:
                return None
    return None


def _kind(group: tuple[str, int] | None) -> str | None:
    """ecoSpold-1 groups: output 0 = reference product, input/output 4 = from/to nature,
    every other input group = technosphere. Allocated co-products (output 2) do not occur in
    BAFU:2026 (single-output datasets) and are refused by the linker if they do."""
    if group is None:
        return None
    tag, n = group
    if tag == "outputGroup" and n == 0:
        return "production"
    if n == 4:
        return "biosphere"
    if tag == "inputGroup":
        return "technosphere"
    return f"unsupported:{tag}{n}"


def _strip_uuid_note(comment: str) -> str:
    """openLCA appends ``UUID: …`` to the general comment; the UUID is the code, not prose."""
    return re.sub(r"\s*;?\s*UUID:\s*" + _UUID_RE.pattern + r"\s*$", "", comment).strip()


def read_dataset(path: Path) -> Dataset:
    from lxml import etree

    root = etree.parse(str(path)).getroot()
    ds = _first(root, "dataset")
    ref = _first(root, "referenceFunction")
    geo = _first(root, "geography")
    period = _first(root, "timePeriod")
    tech = _first(root, "technology")
    source = _first(root, "source")
    if ds is None or ref is None:
        raise PrismError(
            f"{path.name} is not an ecoSpold-1 dataset (no <dataset>/<referenceFunction>).",
            code="bafu_dataset_invalid",
        )
    m = _UUID_RE.search(path.stem) or _UUID_RE.search(ref.get("generalComment", ""))
    code = (
        m.group(0).lower()
        if m
        else str(uuid.uuid5(uuid.NAMESPACE_URL, f"prism://bafu/{ds.get('number')}"))
    )
    dataset = Dataset(
        code=code,
        number=(ds.get("number") or "").strip(),
        name=(ref.get("name") or "").strip(),
        unit=(ref.get("unit") or "").strip(),
        location=(geo.get("location") if geo is not None else "") or "GLO",
        category=(ref.get("category") or "").strip(),
        subcategory=(ref.get("subCategory") or "").strip(),
        comment=_strip_uuid_note(ref.get("generalComment") or ""),
        included_processes=(ref.get("includedProcesses") or "").strip(),
        technology=(tech.get("text") if tech is not None else "") or "",
        period_start=_text(period, './*[local-name()="startDate"]') if period is not None else "",
        period_end=_text(period, './*[local-name()="endDate"]') if period is not None else "",
        infrastructure=(ref.get("infrastructureProcess") or "").lower() == "true",
        source=(source.get("text") if source is not None else "") or "",
    )
    for exc in root.iter("{*}exchange", "exchange"):
        kind = _kind(_group(exc))
        if kind is None:
            continue
        try:
            amount = float(exc.get("meanValue") or 0.0)
        except ValueError:
            amount = 0.0
        sd = exc.get("standardDeviation95")
        dataset.exchanges.append(
            Exchange(
                number=(exc.get("number") or "").strip(),
                name=(exc.get("name") or "").strip(),
                category=(exc.get("category") or "").strip(),
                subcategory=(exc.get("subCategory") or "").strip(),
                unit=(exc.get("unit") or "").strip(),
                amount=amount,
                kind=kind,
                location=(exc.get("location") or "").strip(),
                cas=_norm_cas(exc.get("CASNumber") or ""),
                comment=(exc.get("generalComment") or "").strip(),
                uncertainty_type=int(exc.get("uncertaintyType") or 0),
                sd95=float(sd) if sd not in (None, "") else None,
            )
        )
    return dataset


def read_folder(
    directory: Path, progress: Callable[[int, int], None] | None = None
) -> list[Dataset]:
    paths = sorted(Path(directory).glob("*.xml"))
    if not paths:
        raise PrismError(
            f"No ecoSpold-1 files (*.xml) in {directory}.",
            code="bafu_folder_empty",
            status_code=400,
            hint="Point at the 'ecoSpold files' folder of the BAFU download.",
        )
    out = []
    for i, path in enumerate(paths, 1):
        out.append(read_dataset(path))
        if progress and (i % 500 == 0 or i == len(paths)):
            progress(i, len(paths))
    return out


def label_from_path(directory: Path) -> tuple[str, str, str]:
    """``(database name, label, version)`` from the download's folder names, else the default."""
    for part in reversed(Path(directory).resolve().parts):
        m = _FOLDER_RE.search(part)
        if m:
            year, minor = m.group(1), m.group(2) or "1"
            return f"bafu-{year}-v{minor}", f"BAFU:{year} v{minor}", f"{year} v{minor}"
    return DEFAULT_DATABASE, "BAFU:2026 v1", "2026 v1"


# --------------------------------------------------------------------------------------------
# Flows and links
# --------------------------------------------------------------------------------------------


def source_flows(datasets: list[Dataset]) -> list[SourceFlow]:
    """Unique elementary flows with usage counts — the same aggregation as
    :func:`flow_mapping.scan_ecospold1_flows`, from parsed datasets instead of files."""
    counts: Counter[tuple[str, str, str, str]] = Counter()
    meta: dict[tuple[str, str, str, str], tuple[str, str]] = {}
    for ds in datasets:
        for exc in ds.exchanges:
            if exc.kind != "biosphere":
                continue
            key = (exc.name, exc.category, exc.subcategory, exc.unit)
            counts[key] += 1
            meta.setdefault(key, (exc.cas, ds.name))
    cas_by_name: dict[str, str] = {}
    for key, (cas, _example) in meta.items():
        if cas:
            cas_by_name.setdefault(key[0], cas)
    return [
        SourceFlow(
            *key, cas=meta[key][0] or cas_by_name.get(key[0], ""), count=n, example=meta[key][1]
        )
        for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


def link_technosphere(datasets: list[Dataset]) -> dict[str, str]:
    """``exchange number → producer code``; by ``number`` first, by (name, location, unit) as
    the fallback. One unresolved link refuses the whole import — a half-linked background is
    a wrong result waiting to happen (ARCHITEKTUR.md, ADR-008: nothing half-linked is written)."""
    by_number = {ds.number: ds.code for ds in datasets if ds.number}
    by_key = {ds.flow_key: ds.code for ds in datasets}
    links: dict[str, str] = {}
    unresolved: Counter[str] = Counter()
    unsupported: Counter[str] = Counter()
    for ds in datasets:
        for exc in ds.exchanges:
            if exc.kind.startswith("unsupported"):
                unsupported[exc.kind] += 1
                continue
            if exc.kind != "technosphere":
                continue
            code = by_number.get(exc.number) or by_key.get((exc.name, exc.location, exc.unit))
            if code is None:
                unresolved[f"{exc.name} [{exc.location}] ({exc.number})"] += 1
                continue
            links[f"{ds.code}|{exc.number}|{exc.name}"] = code
    if unsupported:
        raise PrismError(
            f"{sum(unsupported.values())} exchanges use ecoSpold-1 groups this importer does "
            f"not support ({', '.join(sorted(unsupported))}) — nothing was written.",
            code="bafu_unsupported_exchange",
        )
    if unresolved:
        top = "; ".join(f"{k} ×{v}" for k, v in unresolved.most_common(8))
        raise PrismError(
            f"{sum(unresolved.values())} technosphere exchanges point at datasets that are not in "
            f"the folder — nothing was written.",
            code="bafu_unlinked",
            hint=f"Is the folder complete? Missing producers: {top}",
        )
    return links


def _uncertainty(exc: Exchange, amount: float) -> dict:
    """ecoSpold-1 uncertainty → Brightway: type 1 lognormal with ``standardDeviation95`` as the
    squared GSD (σ = ln(GSD²)/2), type 2 normal with sd95 as two standard deviations; GSD² of 0 or
    1 means "not stated" (Sacchi's rule). Negative amounts keep their sign via ``negative``."""
    sd = exc.sd95
    if exc.uncertainty_type == 1 and sd and sd > 1.0 and amount != 0:
        return {
            "uncertainty type": 2,
            "loc": math.log(abs(amount)),
            "scale": math.log(sd) / 2.0,
            "negative": amount < 0,
        }
    if exc.uncertainty_type == 2 and sd and sd > 0:
        return {"uncertainty type": 3, "loc": amount, "scale": sd / 2.0}
    return {"uncertainty type": 0, "loc": amount}


def _pedigree(comment: str) -> dict | None:
    m = _PEDIGREE_RE.search(comment or "")
    if not m:
        return None
    return {
        k: int(v) for k, v in zip(_PEDIGREE_KEYS, m.groups(), strict=False) if v and v.isdigit()
    }


def _long_unit(unit: str) -> str:
    return UNIT_ALIASES.get(unit, unit)


def _flow_type(cats: tuple[str, ...]) -> str:
    top = cats[0] if cats else ""
    return {
        "natural resource": "natural resource",
        "economic": "economic",
        "inventory indicator": "inventory indicator",
        "social": "social",
    }.get(top, "emission")


def new_flow_code(src: SourceFlow) -> str:
    """Deterministic: the same BAFU flow gets the same code in every project and every BAFU
    release, so bundles and later releases meet the same flow."""
    return str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"prism://flow/bafu/{src.name}|{src.category}|{src.subcategory}|{src.unit}",
        )
    )


def new_flow_record(src: SourceFlow, origin: str) -> dict:
    cats = COMPARTMENTS.get((src.category, src.subcategory)) or (src.category,) + (
        (src.subcategory,) if src.subcategory and src.subcategory != "unspecified" else ()
    )
    record = {
        "code": new_flow_code(src),
        "name": src.name,
        "categories": tuple(cats),
        "unit": _long_unit(src.unit),
        "type": _flow_type(cats),
        "prism_origin": origin,
        "prism_source": {
            "name": src.name,
            "category": src.category,
            "subcategory": src.subcategory,
            "unit": src.unit,
        },
    }
    if src.cas:
        record["CAS number"] = src.cas
    return record


# --------------------------------------------------------------------------------------------
# The biosphere and methods a project without ecoinvent gets (bw2io's bundled 3.9 material)
# --------------------------------------------------------------------------------------------


def bw2io_path(relative: Path) -> Path:
    import bw2io

    return Path(bw2io.__file__).resolve().parent / relative


def bw2io_source(relative: Path) -> str:
    import bw2io

    return f"bw2io {bw2io.__version__}: {bw2io_path(relative)}"


def bundled_flow_list() -> TargetBiosphere:
    return TargetBiosphere.from_ecospold2_xml(bw2io_path(BW2IO_FLOWS_39), "bw2io bundled 3.9")


def ensure_bundled_biosphere() -> str:
    """Create ``biosphere3`` from bw2io's bundled ecoinvent-3.9 flow list when the project has
    none. Every flow is marked ``prism_origin: "bw2io"`` so the ecoinvent import can later tell
    which flows it may remove once nothing points at them (:mod:`.sync`)."""
    from prism_lca.engine import ecoinvent

    bd = get_bd()
    if BIOSPHERE_DB in bd.databases and len(bd.Database(BIOSPHERE_DB)):
        return f"{BIOSPHERE_DB} already present ({len(bd.Database(BIOSPHERE_DB))} flows)."
    flows = bundled_flow_list()
    data = {
        (BIOSPHERE_DB, f.code): {
            "code": f.code,
            "name": f.name,
            "categories": tuple(f.categories),
            "unit": _long_unit(f.unit),
            "type": _flow_type(f.categories),
            "CAS number": f.cas,
            "synonyms": list(f.synonyms),
            "prism_origin": BUNDLED_ORIGIN,
        }
        for f in flows.flows
    }
    bd.Database(BIOSPHERE_DB).write(data, searchable=False)  # PrismLCA has its own index — see engine/hygiene.py
    meta = bd.databases[BIOSPHERE_DB]
    meta[ecoinvent.BIO_REVISION_KEY] = "ecoinvent 3.9 flow list (bw2io)"
    meta[ecoinvent.BIO_SOURCE_KEY] = bw2io_source(BW2IO_FLOWS_39)
    meta[ecoinvent.BIO_FLOW_COUNT_KEY] = len(data)
    bd.databases.flush()
    set_read_only(BIOSPHERE_DB, True)
    return (
        f"Created {BIOSPHERE_DB} from bw2io's bundled ecoinvent-3.9 flow list ({len(data)} flows)."
    )


def ensure_bundled_methods() -> str:
    """Write bw2io's bundled 3.9 LCIA methods (762) for a project without ecoinvent's workbook.
    Written directly — bw2io's own installer errors in this bw2io/bw2data combination — and
    marked so the ecoinvent import can replace them (D7). The normal test suite writes one method per
    family; after a change here, run ``PRISM_FULL_BAFU=1 uv run pytest tests/test_backgrounds_bafu.py``."""
    import json

    bd = get_bd()
    if len(bd.methods):
        return f"{len(bd.methods)} methods already present."
    # Flow ids rather than (database, code) keys: bw2data resolves every key with a full node load,
    # which doubles the time of writing the 227 000 factors.
    ids = {n["code"]: n.id for n in bd.Database(BIOSPHERE_DB)}
    with zipfile.ZipFile(bw2io_path(BW2IO_METHODS_39)) as archive:
        methods = json.load(archive.open("data.json"))
    written = skipped_cfs = 0
    source = bw2io_source(BW2IO_METHODS_39)
    for m in methods:
        name = tuple(m["name"])
        cfs = []
        for exc in m.get("exchanges", []):
            key = exc.get("input")
            if not key or key[1] not in ids:
                skipped_cfs += 1
                continue
            cfs.append((ids[key[1]], float(exc["amount"])))
        if not cfs:
            continue
        method = bd.Method(name)
        method.register(
            unit=m.get("unit", ""),
            description=BUNDLED_METHOD_DESCRIPTION,
            filepath=source,
            prism_bundled=BUNDLED_ORIGIN,
        )
        method.write(cfs)
        written += 1
    return f"Wrote {written} bundled LCIA methods (ecoinvent 3.9 implementation via bw2io; {skipped_cfs} factors without a flow skipped)."


# --------------------------------------------------------------------------------------------
# Mapping and writing
# --------------------------------------------------------------------------------------------


def live_target(biosphere: str = BIOSPHERE_DB) -> TargetBiosphere:
    bd = get_bd()
    records = [
        {
            "code": n["code"],
            "name": n["name"],
            "categories": n["categories"],
            "unit": n.get("unit", ""),
            "CAS number": n.get("CAS number", ""),
            "synonyms": n.get("synonyms", ()),
        }
        for n in bd.Database(biosphere)
    ]
    return TargetBiosphere.from_records(records, f"{biosphere} @ {bd.projects.current}")


@dataclass
class Mapping:
    """The ladder's result for one import: source key → proposal, plus the new flows it needs."""

    proposals: dict[tuple[str, str, str, str], Proposal]
    new_flows: dict[tuple[str, str, str, str], dict]
    target_label: str
    correspondence_source: str

    def report(self) -> dict:
        rungs: Counter[str] = Counter()
        resolved = unresolved = 0
        for p in self.proposals.values():
            if p.resolved:
                rungs[p.rung] += p.source.count
                resolved += p.source.count
            else:
                rungs["new_flow"] += p.source.count
                unresolved += p.source.count
        top = sorted(
            (p.source for p in self.proposals.values() if not p.resolved),
            key=lambda s: -s.count,
        )[:20]
        return {
            "target": self.target_label,
            "correspondence": self.correspondence_source,
            "fallback_entries": len(load_fallbacks()),
            "flows": len(self.proposals),
            "exchanges_resolved": resolved,
            "exchanges_new_flow": unresolved,
            "new_flows": len(self.new_flows),
            "rungs": dict(rungs),
            "new_flows_top": [
                {
                    "name": s.name,
                    "compartment": f"{s.category}/{s.subcategory}",
                    "unit": s.unit,
                    "exchanges": s.count,
                }
                for s in top
            ],
        }


def map_flows(flows: list[SourceFlow], target: TargetBiosphere, origin: str) -> Mapping:
    """Run the ladder for a set of source flows against the live biosphere.

    ecoinvent's renaming list (3.9 → 3.12) only makes sense when the target IS the 3.12 list;
    against the bundled 3.9 list it is empty by construction, so it is simply computed against
    whatever the target is.
    """
    renames = {}
    try:
        renames = renamed_flows(bundled_flow_list(), target)
    except Exception as exc:  # noqa: BLE001 - the renaming list is an aid, not a requirement
        _log.swallowed(exc, "map_flows.renames")
    correspondence = None
    try:
        correspondence = Correspondence.from_bw2io()
    except Exception as exc:  # noqa: BLE001 - as above
        _log.swallowed(exc, "map_flows.correspondence")
    proposals = propose(
        flows, target, renames=renames, correspondence=correspondence, fallbacks=load_fallbacks()
    )
    by_key = {p.source.key: p for p in proposals}
    new_flows = {
        p.source.key: new_flow_record(p.source, origin) for p in proposals if not p.resolved
    }
    return Mapping(
        proposals=by_key,
        new_flows=new_flows,
        target_label=target.label,
        correspondence_source=correspondence.source if correspondence else "",
    )


def write_new_flows(new_flows: dict, biosphere: str = BIOSPHERE_DB) -> list[str]:
    """Add the unresolved flows to the biosphere (only those not there yet — a re-import or a
    second BAFU release meets the same deterministic codes). Returns the codes actually added, so
    the caller can hand them to the search index instead of rebuilding it."""
    bd = get_bd()
    db = bd.Database(biosphere)
    existing = {n["code"] for n in db}
    added: list[str] = []
    for record in new_flows.values():
        if record["code"] in existing:
            continue
        db.new_activity(**record).save()
        added.append(record["code"])
    if added:
        from prism_lca.engine import ecoinvent

        bd.databases[biosphere][ecoinvent.BIO_FLOW_COUNT_KEY] = len(db)
        bd.databases.flush()
    return added


def biosphere_exchange(
    exc: Exchange, proposal: Proposal, new_flows: dict, biosphere: str = BIOSPHERE_DB
) -> dict:
    """One Brightway biosphere exchange with its BAFU source kept on it."""
    key = (exc.name, exc.category, exc.subcategory, exc.unit)
    if proposal.resolved:
        target: TargetFlow = proposal.target
        code, unit, factor, rung = target.code, target.unit, proposal.factor, proposal.rung
    else:
        record = new_flows[key]
        code, unit, factor, rung = record["code"], record["unit"], 1.0, "new_flow"
    amount = exc.amount * factor
    out = {
        "input": (biosphere, code),
        "amount": amount,
        "type": "biosphere",
        "unit": unit,
        "prism_source": {
            "name": exc.name,
            "category": exc.category,
            "subcategory": exc.subcategory,
            "unit": exc.unit,
            "amount": exc.amount,
            "rung": rung,
        },
    }
    unc = _uncertainty(exc, amount)
    if unc["uncertainty type"] == 3 and factor != 1.0:
        unc["scale"] *= abs(factor)
    out.update(unc)
    if exc.comment:
        out["comment"] = exc.comment
    ped = _pedigree(exc.comment)
    if ped:
        out["pedigree"] = ped
    return out


def build_database(
    datasets: list[Dataset],
    mapping: Mapping,
    database: str,
    links: dict[str, str],
    biosphere: str = BIOSPHERE_DB,
) -> dict:
    data = {}
    for ds in datasets:
        exchanges = [
            {
                "input": (database, ds.code),
                "amount": 1.0,
                "type": "production",
                "unit": _long_unit(ds.unit),
            }
        ]
        for exc in ds.exchanges:
            if exc.kind == "production":
                continue
            if exc.kind == "technosphere":
                producer = links[f"{ds.code}|{exc.number}|{exc.name}"]
                row = {
                    "input": (database, producer),
                    "amount": exc.amount,
                    "type": "technosphere",
                    "unit": _long_unit(exc.unit),
                }
                row.update(_uncertainty(exc, exc.amount))
                if exc.comment:
                    row["comment"] = exc.comment
                ped = _pedigree(exc.comment)
                if ped:
                    row["pedigree"] = ped
                exchanges.append(row)
            elif exc.kind == "biosphere":
                key = (exc.name, exc.category, exc.subcategory, exc.unit)
                exchanges.append(
                    biosphere_exchange(exc, mapping.proposals[key], mapping.new_flows, biosphere)
                )
        data[(database, ds.code)] = {
            "code": ds.code,
            "name": ds.name,
            "reference product": ds.name,
            "unit": _long_unit(ds.unit),
            "location": ds.location,
            "type": "process",
            "production amount": 1.0,
            "comment": ds.comment,
            "classifications": [("BAFU category", f"{ds.category} / {ds.subcategory}".strip(" /"))],
            "bafu_number": ds.number,
            "infrastructure_process": ds.infrastructure,
            "included_processes": ds.included_processes,
            "technology": ds.technology,
            "time period": f"{ds.period_start}–{ds.period_end}".strip("–"),
            "source": ds.source,
            "exchanges": exchanges,
        }
    return data


# --------------------------------------------------------------------------------------------
# The import
# --------------------------------------------------------------------------------------------


def run_import(
    ecospold1_dir: Path,
    database: str | None = None,
    progress: Callable[..., None] | None = None,
) -> dict:
    """Import a BAFU folder into the current project. Returns the registry entry as a dict.

    Steps: read → link technosphere → biosphere (existing ecoinvent one, or the bundled 3.9 list
    plus its methods) → ladder → new flows → write → flags/registry. The order matters: nothing
    is written before the whole folder has read and linked cleanly.
    """
    from prism_lca.engine.lca import invalidate_lca_cache

    def say(step: str, detail: str, fraction: float | None = None) -> None:
        """``fraction`` 0–1 for the progress bar; reading is the long part (~45 % of the time),
        writing the second (~30 %), the rest is quick."""
        if progress:
            progress(step, detail, fraction)

    bd = get_bd()
    name, label, version = label_from_path(ecospold1_dir)
    database = database or name
    if database in bd.databases and len(bd.Database(database)):
        raise PrismError(
            f"'{database}' is already imported ({len(bd.Database(database))} datasets).",
            code="background_exists",
            status_code=409,
            hint="Remove it in Background data first if you want to import it again.",
        )
    if database in bd.databases:
        # An empty leftover is a crashed write; the folder is complete or refused, so it is safe
        # to replace it rather than lock the user out.
        set_read_only(database, False)
        bd.Database(database).delete(warn=False)
        del bd.databases[database]

    say("reading", f"Reading ecoSpold-1 files from {ecospold1_dir}…", 0.02)
    datasets = read_folder(
        ecospold1_dir,
        lambda i, n: say("reading", f"Read {i} of {n} datasets…", 0.02 + 0.45 * i / n),
    )
    say("linking", f"Linking {len(datasets)} datasets…", 0.5)
    links = link_technosphere(datasets)

    with_ecoinvent = ecoinvent_present()
    if with_ecoinvent:
        biosphere_note = f"Mapping onto the workspace's {BIOSPHERE_DB} (ecoinvent)."
    else:
        say(
            "biosphere",
            "No ecoinvent in this workspace — installing bw2io's bundled flow list and methods…",
            0.53,
        )
        biosphere_note = ensure_bundled_biosphere() + " " + ensure_bundled_methods()

    say("mapping", "Mapping elementary flows onto the biosphere…", 0.6)
    flows = source_flows(datasets)
    mapping = map_flows(flows, live_target(), origin=database)
    added_codes = write_new_flows(mapping.new_flows)
    added = len(added_codes)
    report = mapping.report()
    report["new_flows_added"] = added

    say("writing", f"Writing {len(datasets)} datasets…", 0.68)
    data = build_database(datasets, mapping, database, links)
    bd.Database(database).write(data, searchable=False)  # PrismLCA has its own index — see engine/hygiene.py
    bd.databases[database][COMPLETE_KEY] = True
    bd.databases.flush()
    set_read_only(database, True)
    set_read_only(BIOSPHERE_DB, True)

    info = BackgroundInfo(
        provider=PROVIDER_BAFU,
        label=label,
        version=version,
        system_model="attributional (DQRv2:2023)",
        citation=CITATIONS[PROVIDER_BAFU].format(version=version.split()[0]),
        source_path=str(ecospold1_dir),
        flow_mapping={**report, "with_ecoinvent": with_ecoinvent},
    )
    write_registry(database, info)
    invalidate_lca_cache()
    added_flow_codes = added_codes
    say(
        "finished",
        f"{biosphere_note} Imported {len(datasets)} datasets. Elementary flows: "
        f"{report['exchanges_resolved']} exchanges mapped, {report['exchanges_new_flow']} on "
        f"{report['new_flows']} new flows without characterisation factors.",
        1.0,
    )
    return {"database": database, "biosphere_added": added_flow_codes, **info.as_dict()}
