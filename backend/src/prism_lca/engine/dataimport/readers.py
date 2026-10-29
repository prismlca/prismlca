"""One entry point per source format, all landing in the same shape.

For four of the five formats Brightway already has a reader and we would be mad to write another:
``SingleOutputEcospold1Importer``, ``SingleOutputEcospold2Importer``, ``SimaProCSVImporter`` and
``JSONLDImporter``. Their constructors only EXTRACT — the normalisation is a list of strategies the
importer holds and runs on ``apply_strategies()``, and taking ``importer.data`` before that took the
raw extract: a JSON-LD package was still a dict of object groups and crashed on its first dataset, a
SimaPro multi-output process was never split by its allocation factors.

We do not call ``apply_strategies()`` either, because its list LINKS: bw2io would bind exchanges
against whatever databases happen to be in the project, silently and by name. Linking is the step
this whole feature exists to make visible, so it happens later, in :mod:`matching`, where every
decision gets a confidence and a reason. What runs here is a chosen subset per format
(:data:`_STRATEGIES`), and the rule for choosing is short: **only what makes the data's shape and
settles units and allocation.** Not linking, not migrations that rename flows or regions into
ecoinvent's vocabulary (that is matching, and it runs at runtime against the user's own database),
not uncertainty or parameter bookkeeping PrismLCA does not read.

``JSONLDImporter`` is reachable but not exported from ``bw2io``'s top level (measured, 0.9.17) — it
has to be imported from ``bw2io.importers.json_ld``.
"""

from __future__ import annotations

import contextlib
import io
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from prism_lca.engine.dataimport import ilcd
from prism_lca.engine.dataimport.detect import SourceFormat, detect
from prism_lca.engine.dataimport.model import (
    FlowProperty,
    ForeignDataset,
    ForeignExchange,
    ReadResult,
    SourceKind,
)
from prism_lca.errors import PrismError

_log = logging.getLogger(__name__)

#: A working name for the source while it is being read. The real database name is chosen by the
#: user in the last step of the wizard, so nothing is written under a placeholder.
STAGING_DB = "prism_import_staging"


def _properties_from_bw(raw: dict[str, Any]) -> tuple[FlowProperty, ...]:
    """EcoSpold 2 states properties per exchange and bw2io keeps them as ``{name: {amount, unit}}``.

    Only properties with a real unit survive: the dimensionless ones (water content, carbon
    fraction) and the currencies cannot bridge a unit conversion, which is the one job this field
    has downstream.
    """
    found = raw.get("properties")
    if not isinstance(found, dict):
        return ()
    kept: list[FlowProperty] = []
    for name, body in found.items():
        if not isinstance(body, dict):
            continue
        unit = str(body.get("unit") or "").strip()
        try:
            amount = float(body.get("amount"))
        except (TypeError, ValueError):
            continue
        if unit and unit.lower() != "dimensionless" and amount > 0:
            kept.append(FlowProperty(name=str(name), amount=amount, unit=unit))
    return tuple(kept)


def _exchange_from_bw(raw: dict[str, Any]) -> ForeignExchange:
    kind = str(raw.get("type") or "unknown")
    categories = raw.get("categories") or ()
    # EcoSpold 2 names the supplier of an input by activity (``activityLinkId``); the product is the
    # exchange's own flow. Together they identify one dataset — in this package, if it came along.
    provider = f"{raw['activity']}:{raw['flow']}" if raw.get("activity") and raw.get("flow") else None
    return ForeignExchange(
        kind="biosphere" if kind == "biosphere" else kind,
        name=str(raw.get("name") or ""),
        amount=float(raw.get("amount") or 0.0),
        unit=str(raw.get("unit") or ""),
        compartment=tuple(str(c) for c in categories),
        uuid=str(raw["flow"]) if raw.get("flow") else None,
        location=str(raw["location"]) if raw.get("location") else None,
        # bw2io writes production and technosphere as inputs of the process; only a biosphere flow
        # in a non-resource compartment is an output. The compartment decides, not the sign.
        direction="output" if kind == "biosphere" and (not categories or categories[0] != "natural resource") else "input",
        properties=_properties_from_bw(raw),
        provider=provider if kind == "technosphere" else None,
        raw={k: v for k, v in raw.items() if k not in {"input", "output"}},
    )


def _dataset_name(raw: dict[str, Any], production: ForeignExchange | None) -> str:
    """What to call this dataset — and not every reader fills the obvious field.

    A SimaPro CSV process carries **no** ``name`` at all (measured): bw2io gives it a ``code``, a
    ``simapro metadata`` block and the exchanges, and the human name is the production exchange's.
    An unnamed row in the review table is the one thing that makes the whole step unusable, so the
    fallback runs all the way down to the identifier rather than leaving it blank.
    """
    metadata = raw.get("simapro metadata") or {}
    for candidate in (
        raw.get("name"),
        production.name if production else None,
        raw.get("reference product"),
        metadata.get("Process name") if isinstance(metadata, dict) else None,
        metadata.get("Process identifier") if isinstance(metadata, dict) else None,
        raw.get("code"),
    ):
        if candidate and str(candidate).strip():
            return str(candidate).strip()
    return "unnamed dataset"


def _reference_index(raw_exchanges: list[dict[str, Any]], raw: dict[str, Any]) -> int | None:
    """Which production exchange is the reference product — the others are co-products.

    bw2io marks every product a dataset gives off as ``production``: the reference and the by-products
    alike (EcoSpold 1 ``outputGroup`` 0 and 2, EcoSpold 2 the same). The dataset names its reference —
    ``reference product``, or failing that its own name — and the first product stands in when it
    names none.
    """
    products = [i for i, e in enumerate(raw_exchanges) if e.get("type") == "production"]
    if not products:
        return None
    for wanted in (raw.get("reference product"), raw.get("name")):
        if not wanted:
            continue
        for i in products:
            if str(raw_exchanges[i].get("name") or "") == str(wanted):
                return i
    return products[0]


def _as_coproduct(exchange: ForeignExchange) -> ForeignExchange:
    """A second product, read as what it is: an output of the technosphere, not a consumption."""
    exchange.kind = "technosphere"
    exchange.direction = "output"
    exchange.coproduct = True
    return exchange


def _as_waste_output(exchange: ForeignExchange, body: dict[str, Any]) -> ForeignExchange:
    """A waste the process gives off, read as what it is: the demand for its treatment — never a
    co-product, whatever type bw2io gave it (see :attr:`ForeignExchange.waste`)."""
    exchange.kind = "technosphere"
    exchange.direction = "output"
    exchange.coproduct = False
    exchange.waste = True
    if exchange.provider is None and body.get("activity") and body.get("flow"):
        exchange.provider = f"{body['activity']}:{body['flow']}"
    return exchange


def _is_waste_product(body: dict[str, Any]) -> bool:
    """A non-reference PRODUCT line that is in truth a waste going out.

    EcoSpold 1 puts it in output group 3, "Waste to treatment" — bw2io reads that group as
    ``production`` and keeps no trace of the group, so :func:`_mark_ecospold1_waste` notes it on
    the line before. EcoSpold 2 classifies a by-product as waste (``By-product classification``).
    """
    if body.get("prism_waste_output"):
        return True
    found = body.get("classifications")
    if isinstance(found, dict):
        value = found.get("By-product classification")
        return isinstance(value, str) and value.strip().casefold() == "waste"
    return False


def _is_waste_input_line(body: dict[str, Any], exchange: ForeignExchange, fmt: SourceFormat | None) -> bool:
    """A technosphere line that is a waste going OUT, in the formats that say so on an input.

    SimaPro files it under "Waste to treatment" (bw2io keeps the section as the category). EcoSpold 2
    writes a waste as a NEGATIVE input — ecoinvent's convention — but the sign alone is not proof: a
    negative correction on a producing supplier (−0.3 of it, a credit) looks exactly the same, and
    reading it as waste turned the credit into a purchase. So a negative input is a
    waste only with a second fact: classified as waste here, or linked to a treatment of the same
    package (:func:`_confirm_ecospold2_waste`). Otherwise it keeps its sign and is flagged for the
    reviewer (``sign_review``). A negative input in SimaPro or EcoSpold 1 is somebody's modelling.
    """
    if exchange.kind != "technosphere":
        return False
    if fmt is SourceFormat.simapro_csv:
        categories = body.get("categories") or ()
        return bool(categories) and str(categories[0]).strip().casefold() == "waste to treatment"
    if fmt is SourceFormat.ecospold2:
        return exchange.amount < 0 and _is_waste_product(body)
    return False


def _confirm_ecospold2_waste(datasets: list[ForeignDataset]) -> None:
    """A negative EcoSpold 2 input whose ``activityLinkId`` names a treatment of this package — a
    dataset whose reference production is negative — is a waste going out to that treatment. The
    rest stay as written, flagged ``sign_review``."""
    treatments = {
        name
        for d in datasets
        if any(e.kind == "production" and e.amount < 0 for e in d.exchanges)
        for name in d.provides
    }
    for dataset in datasets:
        for exchange in dataset.exchanges:
            if exchange.sign_review and exchange.provider in treatments:
                exchange.kind, exchange.direction, exchange.waste = "technosphere", "output", True
                exchange.sign_review = False


def _dataset_from_bw(raw: dict[str, Any], fmt: SourceFormat | None = None) -> ForeignDataset:
    raw_exchanges = list(raw.get("exchanges") or [])
    reference = _reference_index(raw_exchanges, raw)
    exchanges: list[ForeignExchange] = []
    for i, body in enumerate(raw_exchanges):
        exchange = _exchange_from_bw(body)
        if exchange.kind == "production" and i != reference:
            if not exchange.amount:
                # A co-product of zero is what an attributional cut-off dataset writes for the
                # products it allocated away — not produced here, so nothing to decide about.
                continue
            # A waste booked as a co-product was, with substitution on, CREDITED for being treated.
            exchange = _as_waste_output(exchange, body) if _is_waste_product(body) else _as_coproduct(exchange)
        elif _is_waste_input_line(body, exchange, fmt):
            exchange = _as_waste_output(exchange, body)
        elif fmt is SourceFormat.ecospold2 and exchange.kind == "technosphere" and exchange.amount < 0:
            # Maybe a waste, maybe a credit — see _is_waste_input_line. Booked as written unless
            # the package confirms it; the reviewer is told to look.
            exchange.sign_review = True
        exchanges.append(exchange)
    production = next((e for e in exchanges if e.kind == "production"), None)
    key = str(raw.get("code") or raw.get("filename") or raw.get("name") or "")
    source_key = str(raw.get("prism_source_key") or key)
    reference_raw = raw_exchanges[reference] if reference is not None else {}
    source_product = str(reference_raw.get("prism_source_name") or (production.name if production else ""))
    return ForeignDataset(
        key=key,
        # Source id, the PROCESS as the source named it, and the product: two processes can share an id
        # (EcoSpold 1 numbers every file's dataset "1") and a product ("electricity" from coal and
        # from gas), and an identity without the process name replaced the one with the other.
        identity=f"{source_key}|{raw.get('prism_source_name') or ''}|{source_product}",
        legacy_key=source_key,
        # `simapro name` is what `split_simapro_name_geo` kept of the name before splitting it.
        legacy_name=str(raw.get("simapro name") or raw.get("prism_source_name") or source_product or ""),
        name=_dataset_name(raw, production),
        unit=str(raw.get("unit") or (production.unit if production else "")),
        location=str(raw.get("location") or ""),
        reference_product=str(raw.get("reference product") or (production.name if production else "")),
        comment=str(raw.get("comment") or ""),
        kind=SourceKind.unit_process,
        exchanges=exchanges,
        # The name another dataset of the package links to this one by: its activity and product.
        provides=(f"{raw['activity']}:{production.uuid}",)
        if raw.get("activity") and production is not None and production.uuid
        else (),
    )


def _strategies(fmt: SourceFormat) -> list[Any]:
    """The bw2io strategies that make each format's data shape — see the module docstring.

    Measured against bw2io 0.9.17, whose importers list, in this order and among others:

    * **EcoSpold 1** — ``normalize_units``, ``assign_only_product_as_production``,
      ``clean_integer_codes``, ``strip_biosphere_exc_locations``. Left out:
      ``drop_unspecified_subcategories`` (our compartment rule reads "unspecified" itself),
      ``update_ecoinvent_locations`` (renames regions into ecoinvent's), ``set_code_by_activity_hash``
      (would change every dataset's key, and with it what a re-import replaces), the linkers.
    * **EcoSpold 2** — ``normalize_units``, ``remove_zero_amount_coproducts`` (a cut-off dataset's
      allocated-away products), ``remove_zero_amount_inputs_with_no_activity``,
      ``es2_assign_only_product_with_amount_as_reference_product``. Left out: ``create_composite_code``
      (the key again), ``fix_ecoinvent_flows_pre35`` and ``drop_temporary_outdated_biosphere_flows``
      (ecoinvent's own flow migrations), the linkers and the uncertainty/parameter clean-ups.
    * **SimaPro CSV** — ``normalize_units``, ``assign_only_product_as_production``,
      ``sp_allocate_products`` (one dataset per product, by its allocation factor),
      ``fix_zero_allocation_products``, ``split_simapro_name_geo`` (``Rice/IN U`` → ``Rice`` in IN),
      ``strip_biosphere_exc_locations``. Left out: ``normalize_simapro_biosphere_*`` and the
      ``simapro-water`` migration (renaming flows into ecoinvent's names IS matching),
      ``migrate_*`` with ``default-units`` (needs the project's migration tables; our units module
      converts t → kg exactly and says so), ``change_electricity_unit_mj_to_kwh`` (the same, by name
      heuristics), ``update_ecoinvent_locations``, the linkers.
    * **JSON-LD** — its own path, see :func:`_json_ld_result`.
    """
    from bw2io import strategies as st

    if fmt is SourceFormat.ecospold1:
        return [
            st.normalize_units,
            st.assign_only_product_as_production,
            st.clean_integer_codes,
            st.strip_biosphere_exc_locations,
        ]
    if fmt is SourceFormat.ecospold2:
        return [
            st.normalize_units,
            st.remove_zero_amount_coproducts,
            st.remove_zero_amount_inputs_with_no_activity,
            st.es2_assign_only_product_with_amount_as_reference_product,
        ]
    if fmt is SourceFormat.simapro_csv:
        return [
            st.normalize_units,
            st.assign_only_product_as_production,
            st.sp_allocate_products,
            st.fix_zero_allocation_products,
            st.split_simapro_name_geo,
            st.strip_biosphere_exc_locations,
        ]
    return []


def _unreadable(target: Path, exc: Exception) -> PrismError:
    return PrismError(
        f"This file could not be read as {target.suffix or 'that format'}: {exc}",
        code="import_unreadable",
        hint="Check that the export is complete — a partial package is the usual cause.",
    )


def _run_bw_importer(
    factory, target: Path, fmt: SourceFormat | None = None, convert=None, mark=None
) -> ReadResult:
    """Build a bw2io importer, run the format's shape strategies, and take its data.

    bw2io prints its progress; in a desktop app that lands in a terminal nobody is looking at, and in
    a test run it drowns the output — so it goes to the log. The exception, if there is one, is what
    we want. ``convert`` replaces the generic mapping for a format whose data is not bw2io's flat
    list even after its strategies (JSON-LD). ``mark`` notes on the raw data, before any strategy,
    what the source said and bw2io does not keep (EcoSpold 1's waste output group).
    """
    chatter = io.StringIO()
    try:
        with contextlib.redirect_stdout(chatter):
            importer = factory()
            if convert is not None:
                return convert(importer)
            data = list(getattr(importer, "data", []) or [])
            # A folder is read in os.listdir order, which belongs to the file system — hashed on ext4,
            # newest first on tmpfs, alphabetical on NTFS — so one package listed its datasets
            # differently on every machine. Sorted by file; stable, so a file's own order stays.
            data.sort(key=lambda ds: str(ds.get("filename") or "") if isinstance(ds, dict) else "")
            _stamp_source_identity(data)
            if mark is not None:
                mark(data)
            if fmt is SourceFormat.simapro_csv:
                _refuse_or_mark_unallocatable(data)
            for strategy in _strategies(fmt) if fmt is not None else []:
                data = strategy(data)
            if fmt is SourceFormat.simapro_csv:
                _refuse_burden_lost(data)
    except PrismError:
        raise
    except Exception as exc:  # noqa: BLE001 — every reader failure is the same answer to the user
        raise _unreadable(target, exc) from exc
    finally:
        text = chatter.getvalue().strip()
        if text:
            _log.debug("bw2io: %s", text.replace("\n", " | ")[:2000])

    datasets = [_dataset_from_bw(d, fmt) for d in data if isinstance(d, dict)]
    if fmt is SourceFormat.ecospold2:
        _confirm_ecospold2_waste(datasets)
    notes: list[str] = []
    unallocated = sum(1 for d in data if isinstance(d, dict) and d.get("prism_unallocated"))
    if unallocated:
        notes.append(
            f"{unallocated} process{'es have' if unallocated != 1 else ' has'} several products but no "
            "usable allocation factors (missing, or all zero). PrismLCA did not split "
            f"{'them' if unallocated != 1 else 'it'}: the first product is the reference, the others are "
            "co-products and are not booked — allocate in SimaPro and export again, or book them as "
            "substitution."
        )
    return ReadResult(datasets=datasets, notes=notes)


def _stamp_source_identity(data: list[dict[str, Any]]) -> None:
    """Note each dataset's id and each product's name as the SOURCE wrote them, before any strategy.

    ``sp_allocate_products`` copies a process per product and ``split_simapro_name_geo`` renames
    ``Rice/IN U`` into ``Rice``; what identifies the dataset on the next import of the same file must
    not depend on either. The stamps travel through the deep copies the strategies make.
    """
    for ds in data:
        if not isinstance(ds, dict):
            continue
        ds.setdefault("prism_source_key", str(ds.get("code") or ds.get("filename") or ds.get("name") or ""))
        products = [e for e in ds.get("exchanges") or [] if e.get("type") == "production"]
        for exc in ds.get("exchanges") or []:
            if isinstance(exc, dict) and exc.get("name") is not None:
                exc.setdefault("prism_source_name", str(exc["name"]))
        # What a pre-identity import called the dataset: its own name, else its first product's.
        ds.setdefault("prism_source_name", str(ds.get("name") or (products[0].get("name") if products else "") or ""))
        # Whether the source booked anything besides its products — checked again after allocation.
        ds.setdefault(
            "prism_had_burden",
            any(
                isinstance(e, dict) and e.get("type") != "production" and _as_number(e.get("amount"))
                for e in ds.get("exchanges") or []
            ),
        )


def _as_number(value: Any) -> float | None:
    """A number, or a string that is one ("0", "4,2") — None for a real formula or nothing."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip().replace(",", "."))
        except ValueError:
            return None
    return None


def _refuse_burden_lost(data: list[Any]) -> None:
    """No process may come out of allocation carrying nothing when the source gave it a burden.

    A factor bw2io evaluates to zero for every product (a formula, a parameter) passes every check
    made before allocation, and ``fix_zero_allocation_products`` then strips each copy down to its
    production: the inventory vanishes without a trace.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for ds in data:
        if isinstance(ds, dict) and ds.get("prism_had_burden"):
            groups.setdefault(str(ds.get("prism_source_key") or ""), []).append(ds)
    for key, copies in groups.items():
        kept = any(
            e.get("type") != "production" and _as_number(e.get("amount"))
            for ds in copies
            for e in ds.get("exchanges") or []
        )
        if not kept:
            name = copies[0].get("prism_source_name") or key
            raise PrismError(
                f"Allocating “{name}” left none of its inputs or emissions on any product — its "
                "allocation factors come to zero.",
                code="import_allocation_missing",
                hint="Check the allocation factors (and the parameters they use) in SimaPro, then "
                "export again.",
            )


def _refuse_or_mark_unallocatable(data: list[dict[str, Any]]) -> None:
    """A multi-product SimaPro process that cannot be allocated is kept unallocated, not zeroed.

    ``sp_allocate_products`` treats a missing factor as zero, and ``fix_zero_allocation_products``
    then strips every input of a dataset whose production is zero: two products without factors and
    10 kg of CO2 came out as two datasets with no burden at all. Such a process is taken out of the
    allocation (the strategy leaves a dataset that already names its ``reference product`` alone)
    and read as one dataset whose other products are co-products — visible, unbooked, never lost.
    """
    for ds in data:
        if not isinstance(ds, dict) or ds.get("reference product"):
            continue
        products = [e for e in ds.get("exchanges") or [] if e.get("type") == "production"]
        if len(products) < 2:
            continue
        factors = [p.get("allocation") for p in products]
        factors = [None if isinstance(f, str) and not f.strip() else f for f in factors]
        # A string that reads as a number is a number ("0" is not a formula); only the rest is left
        # to bw2io to evaluate — and checked again afterwards (`_refuse_burden_lost`).
        if any(isinstance(f, str) and _as_number(f) is None for f in factors):
            continue
        numbers = [_as_number(f) for f in factors]
        if any(n is None for n in numbers) or sum(n or 0.0 for n in numbers) <= 0:
            ds["prism_unallocated"] = True
            ds["reference product"] = products[0].get("name")
            ds.setdefault("name", products[0].get("name"))
            ds["unit"] = products[0].get("unit")


def _repaired_ecospold1(target: Path) -> Path | None:
    """A schema-conform copy of a file that only violates the EcoSpold 1 STRUCTURE.

    Real-world EcoSpold 1 (US LCI above all) swaps the order of ``processInformation`` children or
    omits ``geography`` altogether, and the validating parser refuses the whole file for it — a
    structural quibble standing between the user and an otherwise perfectly readable inventory.
    Both faults have one mechanical, lossless remedy: put the children in the schema's sequence,
    and write an EMPTY geography where none stands (``location=""`` is valid — the type is only
    "at most 7 characters" — and it honestly means "no region stated", which downstream makes the
    region the reviewer's explicit call). Anything beyond that is not repaired: a file broken in
    substance keeps its real error. Returns None when there was nothing to repair.
    """
    from lxml import etree

    ns = "http://www.EcoInvent.org/EcoSpold01"
    order = ["referenceFunction", "geography", "technology", "timePeriod", "dataSetInformation"]
    try:
        tree = etree.parse(str(target))
    except Exception:  # noqa: BLE001 — not even XML: nothing structural to repair
        return None
    changed = False
    for info in tree.iter(f"{{{ns}}}processInformation"):
        if info.find(f"{{{ns}}}geography") is None:
            geography = etree.SubElement(info, f"{{{ns}}}geography")
            geography.set("location", "")
            changed = True
        ranked = sorted(
            list(info),
            key=lambda c: order.index(etree.QName(c).localname)
            if etree.QName(c).localname in order
            else len(order),
        )
        if ranked != list(info):
            for child in ranked:
                info.append(child)  # re-appending an existing child moves it — this reorders
            changed = True
    if not changed:
        return None
    fd, path = tempfile.mkstemp(suffix=".xml", prefix="prism-ecospold1-")
    os.close(fd)  # mkstemp hands the descriptor over open; the path is all that is needed
    out = Path(path)
    tree.write(str(out), xml_declaration=True, encoding="utf-8")
    return out


def _ecospold1_waste_lines(path: Path) -> set[tuple[str, int, int]]:
    """(file name, dataset number, exchange number) of every exchange in output group 3.

    Read from the XML itself, because bw2io turns "Waste to treatment" into ``production`` like a
    reference product and drops the group. A file that does not parse is skipped: bw2io reads it
    next and gives the error that names it.
    """
    files = [path] if path.is_file() else sorted(p for p in path.iterdir() if p.suffix.lower() == ".xml")
    found: set[tuple[str, int, int]] = set()
    for file in files:
        try:
            root = ElementTree.parse(file).getroot()
        except (ElementTree.ParseError, OSError):
            continue
        for dataset in root.iter():
            if dataset.tag.rsplit("}", 1)[-1] != "dataset":
                continue
            number = _as_int(dataset.get("number"))
            for exchange in dataset.iter():
                if exchange.tag.rsplit("}", 1)[-1] != "exchange":
                    continue
                groups = [c for c in exchange if c.tag.rsplit("}", 1)[-1] == "outputGroup"]
                if any((g.text or "").strip() == "3" for g in groups):
                    found.add((file.name, number, _as_int(exchange.get("number"))))
    return found


def _as_int(value: Any) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def _mark_ecospold1_waste(data: list[Any], path: Path) -> None:
    """Note on each EcoSpold 1 line in output group 3 that it is a waste going out — see
    :func:`_is_waste_product`."""
    lines = _ecospold1_waste_lines(path)
    if not lines:
        return
    for ds in data:
        if not isinstance(ds, dict):
            continue
        filename, number = str(ds.get("filename") or ""), _as_int(ds.get("code"))
        for exc in ds.get("exchanges") or []:
            if isinstance(exc, dict) and (filename, number, _as_int(exc.get("code"))) in lines:
                exc["prism_waste_output"] = True


def _read_ecospold1(target: Path) -> ReadResult:
    from bw2io import SingleOutputEcospold1Importer

    # `use_mp=False`: the importer's default spawns a multiprocessing pool, which inside our
    # threaded backend comes back as "Error sending result: <ExceptionWithTraceback>" — a message
    # about the pool, not about the file, on any dataset that fails to parse. Reading in-process
    # gives the real error, and an import already runs on its own background thread.
    def read(path: Path) -> ReadResult:
        return _run_bw_importer(
            lambda: SingleOutputEcospold1Importer(str(path), STAGING_DB, use_mp=False),
            target,
            SourceFormat.ecospold1,
            mark=lambda data: _mark_ecospold1_waste(data, path),
        )

    try:
        return read(target)
    except PrismError as refusal:
        # A second try on a structurally repaired copy — single files only: in a directory the
        # honest error names the file, and repairing some-of-many silently would blur that.
        repaired = _repaired_ecospold1(target) if target.is_file() else None
        if repaired is None:
            raise
        try:
            result = read(repaired)
        except PrismError:
            raise refusal from None
        finally:
            repaired.unlink(missing_ok=True)
        result.notes.append(
            "This file violates the EcoSpold 1 schema (element order, or a missing geography). "
            "PrismLCA repaired the structure to read it; a missing geography reads as “no region "
            "stated”, so those region choices are yours in the review."
        )
        return result


def _read_ecospold2(target: Path) -> ReadResult:
    from bw2io import SingleOutputEcospold2Importer

    if target.is_dir():
        return _run_bw_importer(
            lambda: SingleOutputEcospold2Importer(str(target), STAGING_DB), target, SourceFormat.ecospold2
        )
    # ecospold2 wants a directory. A single .spold file is read from a folder holding only it: the
    # importer walks the whole directory, and the parent may be a release folder — every other
    # dataset in it came along, tens of thousands for an ecoinvent folder.
    with tempfile.TemporaryDirectory(prefix="prism-ecospold2-") as tmp:
        shutil.copy2(target, Path(tmp) / target.name)
        return _run_bw_importer(
            lambda: SingleOutputEcospold2Importer(tmp, STAGING_DB), target, SourceFormat.ecospold2
        )


#: What SimaPro writes in `{CSV separator: …}`, and the character it means.
_SIMAPRO_SEPARATORS = {"semicolon": ";", "tab": "\t", "comma": ",", "space": " "}


def _simapro_flavour(target: Path) -> tuple[str, str]:
    """The delimiter this export uses, and what kind of export it is.

    A SimaPro export says both about itself, and we asked neither. The delimiter defaults to ``;``
    in bw2io, so a tab-separated export — brightway2-io ships one as a fixture, from a real user —
    failed to read with an empty error message. And a *method* export ran all the way into bw2io
    before dying on "Can't understand metadata", which tells nobody that they exported the wrong
    thing.
    """
    try:
        head = target.read_text(encoding="latin-1", errors="replace")[:4000]
    except OSError:
        return ";", ""
    lines = [line.strip() for line in head.splitlines() if line.strip()]
    delimiter, kind = "", ""
    for line in lines[:30]:
        named = re.match(r"\{CSV separator:\s*([A-Za-z]+)\}", line)
        if named:
            delimiter = _SIMAPRO_SEPARATORS.get(named.group(1).lower(), "")
        braced = re.match(r"\{(processes?|methods?)\}", line, re.IGNORECASE)
        if braced:
            kind = braced.group(1).lower()
    if not kind and lines and lines[0].startswith("SimaPro"):
        # The unbraced variant states it in field two of line one: "SimaPro 8.0.4.30;process;Date:…"
        parts = re.split(r"[;\t,]", lines[0])
        if len(parts) > 1:
            kind = parts[1].strip().lower()
    if not delimiter and lines:
        counts = {sep: lines[0].count(sep) for sep in (";", "\t", ",")}
        delimiter = max(counts, key=lambda k: counts[k]) if any(counts.values()) else ";"
    return delimiter or ";", kind


def _read_simapro(target: Path) -> ReadResult:
    from bw2io import SimaProCSVImporter

    delimiter, kind = _simapro_flavour(target)
    if kind.startswith("method"):
        raise PrismError(
            "This is a SimaPro *method* export — impact categories and characterisation factors, "
            "not an inventory. There are no processes in it to import.",
            code="simapro_method_export",
            hint="Export the processes from SimaPro instead (or use Manage methods for factors).",
        )
    return _run_bw_importer(
        lambda: SimaProCSVImporter(str(target), STAGING_DB, delimiter=delimiter),
        target,
        SourceFormat.simapro_csv,
    )


def _json_ld_category(flow_ref: dict[str, Any], flow: dict[str, Any], categories: dict[str, Any]) -> tuple[str, ...]:
    """A flow's category path, in whichever of openLCA's two spellings the package uses.

    openLCA 2 writes ``"Elementary flows/Emission to air/unspecified"`` on the flow; openLCA 1 a
    reference into ``categories/``, each of which points at its parent, or a ``categoryPath`` on the
    reference. Outermost first either way — the compartment rule finds its level by itself.
    """
    for source in (flow_ref, flow):
        category = source.get("category")
        if isinstance(category, str) and category.strip():
            return tuple(p.strip() for p in category.split("/") if p.strip())
        path = source.get("categoryPath")
        if isinstance(path, list) and path:
            name = category.get("name") if isinstance(category, dict) else None
            return tuple(str(p) for p in [*path, *([name] if name else [])] if p)
    node = flow.get("category") if isinstance(flow.get("category"), dict) else None
    chain: list[str] = []
    while isinstance(node, dict) and len(chain) < 12:
        full = categories.get(node.get("@id", ""), node)
        if full.get("name"):
            chain.append(str(full["name"]))
        node = full.get("category") if isinstance(full.get("category"), dict) else None
    return tuple(reversed(chain))


def _json_ld_location(ref: Any, locations: dict[str, Any]) -> str:
    """The region's CODE ("DE"), which is what our background calls regions — not its name
    ("Germany"), which is what bw2io's ``json_ld_location_name`` would have kept."""
    if isinstance(ref, str):
        return ref
    if not isinstance(ref, dict):
        return ""
    full = locations.get(ref.get("@id", ""), {})
    return str(full.get("code") or ref.get("code") or full.get("name") or ref.get("name") or "")


def _json_ld_result(importer) -> ReadResult:
    """openLCA JSON-LD into our shape — bw2io for units and allocation, the mapping our own.

    What bw2io contributes (measured, 0.9.17): ``json_ld_allocate_datasets`` (one dataset per product
    by the process's default allocation factors), ``json_ld_convert_unit_to_reference_unit`` (every
    amount into its unit group's reference unit), ``json_ld_get_activities_list_from_rawdata``,
    ``json_ld_get_normalized_exchange_units`` and ``json_ld_rename_metadata_fields``. What it does NOT
    get to do: ``json_ld_label_exchange_type`` refuses every waste treatment ("Inputs must be
    products") and calls a waste output "production"; ``json_ld_prepare_exchange_fields_for_linking``
    throws away the flow type and category the mapping needs; ``json_ld_add_products_as_activities``
    adds every product flow as a dataset; ``json_ld_location_name`` keeps "Germany" where our
    background says "DE"; and the rest links. The exchange types are read here instead, off the flow
    type and the direction — the two facts openLCA writes on every exchange.
    """
    from functools import partial

    from bw2io.strategies import (
        json_ld_allocate_datasets,
        json_ld_convert_unit_to_reference_unit,
        json_ld_get_activities_list_from_rawdata,
        json_ld_get_normalized_exchange_units,
        json_ld_rename_metadata_fields,
    )

    raw = importer.data
    if not isinstance(raw, dict) or not raw.get("processes"):
        raise PrismError(
            "This openLCA JSON-LD package holds no processes — nothing to import.",
            code="import_empty",
            hint="Export processes from openLCA (not only flows or methods), as JSON-LD.",
        )
    for group in ("flows", "unit_groups", "locations", "categories"):
        raw.setdefault(group, {})
    flows: dict[str, Any] = raw["flows"]
    locations: dict[str, Any] = raw["locations"]
    #: Unit id → the reference unit of the group it belongs to (openLCA 2 `isRefUnit`, 1
    #: `referenceUnit`, else the unit whose factor is 1).
    reference_units: dict[str, str] = {}
    for group in raw["unit_groups"].values():
        units_of = [u for u in group.get("units") or [] if isinstance(u, dict)]
        ref = next((u for u in units_of if u.get("isRefUnit") or u.get("referenceUnit")), None)
        ref = ref or next((u for u in units_of if float(u.get("conversionFactor") or 0) == 1.0), None)
        if ref is None:
            continue
        for unit in units_of:
            if unit.get("@id"):
                reference_units[unit["@id"]] = str(ref.get("name") or "")
    categories: dict[str, Any] = raw["categories"]

    # openLCA 1 and 2 spell the same exchange fields differently, and bw2io's strategies read one
    # spelling each (the allocation `input`, the unit step `isInput`). Both are set, from whichever
    # the file wrote, so neither strategy reads a field that is not there.
    for process in raw["processes"].values():
        process.setdefault("@type", "Process")
        process["prism_process_id"] = process.get("@id", "")
        for exc in process.get("exchanges") or []:
            is_input = bool(exc.get("isInput", exc.get("input", False)))
            exc["isInput"] = exc["input"] = is_input
            exc["avoidedProduct"] = bool(exc.get("isAvoidedProduct", exc.get("avoidedProduct", False)))
            exc["quantitativeReference"] = bool(
                exc.get("isQuantitativeReference", exc.get("quantitativeReference", False))
            )
            flow = exc.setdefault("flow", {})
            full = flows.get(flow.get("@id", ""), {})
            flow.setdefault("flowType", full.get("flowType"))
            flow.setdefault("name", full.get("name", ""))
            # bw2io multiplies the amount by the unit's factor to its GROUP's reference unit, but
            # names the result after the flow's `refUnit` — or, without one, after the unit the
            # exchange was in: 100 g became "0.1 gram". Amount and unit have to come
            # from the same place, so the unit is set to that group's reference unit here, and a
            # unit no group of the package defines is refused rather than half-converted.
            unit_id = (exc.get("unit") or {}).get("@id", "") if isinstance(exc.get("unit"), dict) else ""
            reference_unit = reference_units.get(unit_id)
            if reference_unit is None:
                raise PrismError(
                    f"An exchange of “{process.get('name') or process.get('@id')}” is in a unit this "
                    "package does not define, so its amount cannot be converted.",
                    code="import_unit_unresolved",
                    hint="Export the package with its unit groups (openLCA: include referenced data).",
                )
            flow["refUnit"] = reference_unit

    data: Any = raw
    for strategy in (
        partial(json_ld_allocate_datasets, preferred_allocation=None),
        json_ld_convert_unit_to_reference_unit,
        json_ld_get_activities_list_from_rawdata,
        json_ld_get_normalized_exchange_units,
        json_ld_rename_metadata_fields,
    ):
        data = strategy(data)

    datasets: list[ForeignDataset] = []
    for ds in data:
        process_id = str(ds.get("prism_process_id") or ds.get("code") or "")
        location = _json_ld_location(ds.get("location"), locations)
        exchanges: list[ForeignExchange] = []
        reference: ForeignExchange | None = None
        for exc in ds.get("exchanges") or []:
            flow_ref = exc.get("flow") or {}
            flow_id = str(flow_ref.get("@id") or "")
            flow = flows.get(flow_id, {})
            flow_type = flow_ref.get("flowType") or flow.get("flowType") or ""
            is_input = bool(exc.get("isInput"))
            amount = float(exc.get("amount") or 0.0)
            provider = exc.get("defaultProvider") if isinstance(exc.get("defaultProvider"), dict) else None
            coproduct = waste = False
            if flow_type == "ELEMENTARY_FLOW":
                kind = "biosphere"
            elif exc.get("quantitativeReference") and reference is None:
                kind = "production"
                # A waste treatment's reference is the waste it takes IN; a negative production is
                # how Brightway — and our commit — says "treatment".
                amount = -abs(amount) if is_input else amount
            elif exc.get("avoidedProduct"):
                kind = "substitution"  # the source's own system expansion, booked as it says
            else:
                kind = "technosphere"
                coproduct = not is_input and flow_type == "PRODUCT_FLOW"
                # A waste going OUT is the demand for its treatment; openLCA names the treatment as
                # the output's `defaultProvider`, so the link is kept for it too.
                waste = not is_input and flow_type == "WASTE_FLOW"
            entry = ForeignExchange(
                kind=kind,
                name=str(flow_ref.get("name") or flow.get("name") or ""),
                amount=amount,
                unit=str(exc.get("unit") or ""),
                compartment=_json_ld_category(flow_ref, flow, categories) if kind == "biosphere" else (),
                uuid=flow_id or None,
                location=_json_ld_location(flow_ref.get("location") or flow.get("location"), locations) or None,
                direction="input" if is_input else "output",
                coproduct=coproduct,
                waste=waste,
                provider=f"{provider.get('@id')}:{flow_id}" if provider and provider.get("@id") and kind == "technosphere" and (is_input or waste) else None,
                raw={k: v for k, v in exc.items() if k not in {"flow", "defaultProvider", "input"}}
                | {"flowType": flow_type},
            )
            if kind == "production":
                reference = entry
            exchanges.append(entry)
        declared = str(ds.get("processType") or "")
        datasets.append(
            ForeignDataset(
                key=str(ds.get("code") or process_id),
                name=str(ds.get("name") or (reference.name if reference else "") or "unnamed dataset"),
                unit=reference.unit if reference else "",
                location=location,
                reference_product=reference.name if reference else "",
                comment=str(ds.get("description") or ""),
                kind=SourceKind.lci_result if declared == "LCI_RESULT" else SourceKind.unit_process,
                exchanges=exchanges,
                provides=(f"{process_id}:{reference.uuid}",) if reference and reference.uuid and process_id else (),
            )
        )
    return ReadResult(datasets=datasets)


def _json_ld_root(folder: Path) -> Path:
    """The folder that holds ``processes/`` — a zip often wraps the package in one more level."""
    if (folder / "processes").is_dir():
        return folder
    for child in sorted(p for p in folder.iterdir() if p.is_dir()):
        if (child / "processes").is_dir():
            return child
    return folder


#: What a zipped JSON-LD package may unpack to. An archive is data from somewhere else: a few
#: kilobytes can expand into gigabytes, so the members are counted and measured before and WHILE
#: they are written — a member's header can lie about its size, the byte count cannot.
ZIP_MAX_TOTAL = 200 * 1024 * 1024
ZIP_MAX_MEMBER = 50 * 1024 * 1024
ZIP_MAX_MEMBERS = 20_000
#: The object folders the reader uses. Everything else in the archive is not unpacked at all.
_JSON_LD_FOLDERS = frozenset(
    {"processes", "flows", "unit_groups", "flow_properties", "locations", "categories"}
)


def _json_ld_member_wanted(name: str) -> bool:
    """A JSON file in one of the object folders — at the top of the archive or one level down."""
    parts = [p for p in name.split("/") if p]
    # The endings bw2io's extractor reads (it takes any suffix containing "json").
    if not parts or not parts[-1].lower().endswith((".json", ".jsonld")):
        return False
    return (len(parts) == 2 and parts[0] in _JSON_LD_FOLDERS) or (
        len(parts) == 3 and parts[1] in _JSON_LD_FOLDERS
    )


def _unzip_json_ld(target: Path, into: Path) -> None:
    import zipfile

    too_big = PrismError(
        "This archive unpacks to more than PrismLCA reads from one package — not reading it.",
        code="import_archive_too_large",
        hint=f"At most {ZIP_MAX_MEMBERS} files, {ZIP_MAX_MEMBER // 2**20} MB each, "
        f"{ZIP_MAX_TOTAL // 2**20} MB in all.",
    )
    root = into.resolve()
    try:
        with zipfile.ZipFile(target) as zf:
            members = zf.infolist()
            if len(members) > ZIP_MAX_MEMBERS:
                raise too_big
            wanted = [m for m in members if not m.is_dir() and _json_ld_member_wanted(m.filename)]
            if sum(m.file_size for m in wanted) > ZIP_MAX_TOTAL or any(
                m.file_size > ZIP_MAX_MEMBER for m in wanted
            ):
                raise too_big
            written = 0
            for member in wanted:
                dest = (root / member.filename).resolve()
                # Containment on the resolved PATH, not on a string prefix: "/tmp/x-evil" starts
                # with "/tmp/x" and is not inside it.
                if not dest.is_relative_to(root):
                    raise PrismError(
                        "This archive writes outside its own folder — not reading it.",
                        code="import_unreadable",
                    )
                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as source, dest.open("wb") as sink:
                    size = 0
                    while chunk := source.read(1 << 16):
                        size += len(chunk)
                        written += len(chunk)
                        if size > ZIP_MAX_MEMBER or written > ZIP_MAX_TOTAL:
                            raise too_big
                        sink.write(chunk)
    except zipfile.BadZipFile as exc:
        raise _unreadable(target, exc) from exc


def _read_json_ld(target: Path) -> ReadResult:
    from types import SimpleNamespace

    from bw2io.extractors.json_ld import JSONLDExtractor

    def read(folder: Path) -> ReadResult:
        root = _json_ld_root(folder)
        # The extractor, not the importer: `JSONLDImporter.__init__` builds bw2io's own biosphere and
        # product lists and dies on an openLCA 1 category given as a reference object (it calls
        # `.split("/")` on it) before any of our code runs. We need neither list.
        return _run_bw_importer(
            lambda: SimpleNamespace(data=JSONLDExtractor.extract(str(root))),
            target,
            convert=_json_ld_result,
        )

    if target.suffix.lower() == ".zip" and target.is_file():
        # bw2io's extractor reads folders only ("Extraction of zip archives not yet supported").
        with tempfile.TemporaryDirectory(prefix="prism-jsonld-") as tmp:
            _unzip_json_ld(target, Path(tmp))
            return read(Path(tmp))
    return read(target if target.is_dir() else target.parent)


_READERS = {
    SourceFormat.ecospold1: _read_ecospold1,
    SourceFormat.ecospold2: _read_ecospold2,
    SourceFormat.simapro_csv: _read_simapro,
    SourceFormat.json_ld: _read_json_ld,
    SourceFormat.ilcd: ilcd.read,
}


def _unique_keys(datasets: list[ForeignDataset]) -> None:
    """One key per dataset — the review table groups rows by it and the commit writes by it.

    An allocated SimaPro process becomes one dataset per product, and every copy keeps the process's
    identifier; a folder of EcoSpold 1 files numbers each file's dataset "1". Two datasets under one
    key pooled their rows at commit, each coming out with the other's inventory as well (the same failure
    once hit names). The product tells allocated copies apart, a counter the rest.
    """
    counts: dict[str, int] = {}
    for dataset in datasets:
        counts[dataset.key] = counts.get(dataset.key, 0) + 1
    seen: set[str] = set()
    for dataset in datasets:
        if counts[dataset.key] > 1 and dataset.reference_product:
            dataset.key = f"{dataset.key}:{dataset.reference_product}"
        key, n = dataset.key, 2
        while key in seen:
            key, n = f"{dataset.key}#{n}", n + 1
        dataset.key = key
        seen.add(key)


def read(target: Path) -> tuple[SourceFormat, ReadResult]:
    """Detect and read. The only function the API layer calls."""
    found = detect(target)
    reader = _READERS.get(found.format)
    if reader is None:
        raise PrismError(
            f"PrismLCA does not read this: {found.evidence}.",
            code="import_unknown_format",
            hint="Supported: EcoSpold 1 and 2, ILCD, SimaPro CSV and openLCA JSON-LD.",
        )
    result = reader(target)
    _unique_keys(result.datasets)
    if not result.datasets:
        raise PrismError(
            f"Read as {found.label}, but there is no dataset in it.",
            code="import_empty",
            hint="An export that filtered everything out looks exactly like this.",
        )
    return found.format, result
