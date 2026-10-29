"""ecoinvent arrives after BAFU: rewrite everything onto ecoinvent ("ecoinvent is
master even when it comes later").

A project that started with BAFU holds bw2io's bundled ecoinvent-3.9 flow list as ``biosphere3``
and its 762 bundled methods; BAFU's exchanges point at those flows, and at new flows the ladder
created. When the user then imports ecoinvent 3.12, this module runs inside that import:

1. **lift** — flows that kept their UUID get the 3.12 name, categories, unit, CAS and synonyms
   (422 renamings between 3.9 and 3.12: "Calcium" → "Calcium II"); the ``prism_origin`` marker
   comes off, they are ecoinvent's now;
2. **re-map the BAFU database** — every biosphere exchange carries its source (name, compartment,
   unit, original amount), so the ladder runs again against the 3.12 list and the exchange is
   re-pointed with the new factor; unresolved ones keep or get a new flow;
3. **re-map the user's own databases** — exchanges on flows that the 3.12 list does not have
   (dropped 3.9 flows, BAFU new flows that now resolve) go through the same ladder;
4. **replace the bundled methods** — the workbook import has overwritten the ones with identical
   names in place; the rest are deregistered;
5. **prune** — bundled or BAFU-created flows the 3.12 list lacks and nothing references any more
   are deleted; a custom method's factors on such flows are dropped.

Everything reports counts; nothing is silent.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Callable
from dataclasses import replace

from prism_lca import _log
from prism_lca.engine.backgrounds import bafu
from prism_lca.engine.backgrounds.common import (
    BIOSPHERE_DB,
    PROVIDER_BAFU,
    backgrounds,
    is_background,
)
from prism_lca.engine.backgrounds.flow_mapping import (
    COMPARTMENTS,
    Proposal,
    SourceFlow,
    TargetBiosphere,
    _norm_cas,
)
from prism_lca.engine.bootstrap import get_bd

#: ecoinvent categories → the ecoSpold-1 pair the ladder expects (first spelling wins).
_REVERSE_COMPARTMENTS: dict[tuple[str, ...], tuple[str, str]] = {}
for _pair, _cats in COMPARTMENTS.items():
    if _pair[0] != "resource":  # prefer BAFU's plural spelling
        _REVERSE_COMPARTMENTS.setdefault(_cats, _pair)


def has_bundled_biosphere() -> bool:
    bd = get_bd()
    if BIOSPHERE_DB not in bd.databases:
        return False
    source = str(bd.databases[BIOSPHERE_DB].get("prism_biosphere_source") or "")
    return source.startswith("bw2io")


def lift_biosphere(release_flows: list[dict]) -> int:
    """Give every existing flow that the release also has the release's attributes. Returns the
    number of flows whose name, categories, unit or CAS changed."""
    bd = get_bd()
    by_code = {f["code"]: f for f in release_flows}
    changed = 0
    for node in bd.Database(BIOSPHERE_DB):
        release = by_code.get(node["code"])
        if release is None:
            continue
        touched = False
        for key in ("name", "categories", "unit", "CAS number", "synonyms", "type"):
            if key in release and node.get(key) != release[key]:
                node[key] = release[key]
                touched = True
        if node.get("prism_origin"):
            del node["prism_origin"]
            touched = True
        if touched:
            node.save()
            changed += 1
    return changed


def _source_flow(node, source: dict | None) -> SourceFlow | None:
    """The ladder's input for a biosphere node: its stored BAFU source, or the node itself
    expressed in ecoSpold-1 terms (for dropped 3.9 flows)."""
    if source:
        return SourceFlow(
            source["name"],
            source["category"],
            source["subcategory"],
            source["unit"],
            cas=_norm_cas(str(node.get("CAS number") or "")),
        )
    pair = _REVERSE_COMPARTMENTS.get(tuple(node.get("categories") or ()))
    if pair is None:
        return None
    unit = node.get("unit", "")
    short = {v: k for k, v in bafu.UNIT_ALIASES.items()}.get(unit, unit)
    return SourceFlow(
        node["name"], pair[0], pair[1], short, cas=_norm_cas(str(node.get("CAS number") or ""))
    )


def _lognormal_loc(exchange_data: dict, amount: float) -> None:
    if exchange_data.get("uncertainty type") == 2 and amount != 0:
        exchange_data["loc"] = math.log(abs(amount))
        exchange_data["negative"] = amount < 0
    elif exchange_data.get("uncertainty type") in (0, 3, None):
        exchange_data["loc"] = amount


def remap_database(
    name: str,
    target: TargetBiosphere,
    origin: str,
    progress: Callable[[str], None] | None = None,
    reprocess: bool = False,
) -> dict:
    """Re-run the ladder for every biosphere exchange of ``name`` that has to move.

    Exchanges with a stored BAFU source are all re-mapped (the target list changed, so the
    right flow may have too); exchanges without one are touched only when their flow is not in
    the target list. Writes through peewee inside one transaction and re-processes the database.
    ``reprocess`` processes it even when nothing moved: a retried sync whose earlier run committed
    the exchanges and then failed in ``process()`` finds nothing to move, while the calculation data
    is still the old one — raw exchange writes do not mark a database dirty.
    """
    from bw2data.backends import ExchangeDataset, sqlite3_lci_db

    bd = get_bd()
    nodes = {n["code"]: n for n in bd.Database(BIOSPHERE_DB)}
    rows = list(
        ExchangeDataset.select().where(
            (ExchangeDataset.output_database == name)
            & (ExchangeDataset.input_database == BIOSPHERE_DB)
        )
    )
    # 1. collect the unique source flows
    sources: dict[tuple[str, str, str, str], SourceFlow] = {}
    pending: list[tuple[ExchangeDataset, dict, tuple[str, str, str, str] | None]] = []
    for row in rows:
        data = row.data
        src_meta = data.get("prism_source")
        if not src_meta and row.input_code in target.by_code:
            continue
        node = nodes.get(row.input_code)
        src = (
            _source_flow(node, src_meta)
            if node is not None
            else (
                SourceFlow(
                    src_meta["name"],
                    src_meta["category"],
                    src_meta["subcategory"],
                    src_meta["unit"],
                )
                if src_meta
                else None
            )
        )
        if src is None:
            pending.append((row, data, None))
            continue
        sources.setdefault(src.key, src)
        pending.append((row, data, src.key))
    if not pending:
        if reprocess:
            bd.Database(name).process()
        return {"database": name, "exchanges_checked": len(rows), "moved": 0, "new_flows": 0}

    # BAFU writes the CAS number on some rows of a substance and not on others; the import
    # propagates it by name (``bafu.source_flows``) and the re-map must do the same, or a flow the
    # CAS rung placed at import time comes back unresolved here.
    cas_by_name = {src.name: src.cas for src in sources.values() if src.cas}
    for key, src in list(sources.items()):
        if not src.cas and src.name in cas_by_name:
            sources[key] = replace(src, cas=cas_by_name[src.name])

    # 2. one ladder run for all of them
    mapping = bafu.map_flows(list(sources.values()), target, origin=origin)
    added = len(bafu.write_new_flows(mapping.new_flows))

    # 3. re-point
    moved = unresolved = 0
    rungs: Counter[str] = Counter()
    with sqlite3_lci_db.atomic():
        for i, (row, data, key) in enumerate(pending, 1):
            if progress and i % 20000 == 0:
                progress(f"{name}: re-pointed {i} of {len(pending)} exchanges…")
            if key is None:
                unresolved += 1
                continue
            proposal: Proposal = mapping.proposals[key]
            src_meta = data.get("prism_source") or {}
            base_amount = float(src_meta.get("amount", data.get("amount", 0.0)))
            if proposal.resolved:
                code, unit, factor, rung = (
                    proposal.target.code,
                    proposal.target.unit,
                    proposal.factor,
                    proposal.rung,
                )
            else:
                record = mapping.new_flows[key]
                code, unit, factor, rung = record["code"], record["unit"], 1.0, "new_flow"
            amount = base_amount * factor
            if row.input_code == code and abs(float(data.get("amount", 0.0)) - amount) < 1e-15:
                continue
            data["input"] = (BIOSPHERE_DB, code)
            # A normal distribution's spread is absolute and follows the amount: converted from kg to
            # m3 with the mean divided by a thousand, the old sigma was a thousand times too wide in
            # the new unit. By the ratio of the amounts, so a re-sync compounds nothing.
            previous = float(data.get("amount") or 0.0)
            if data.get("uncertainty type") == 3 and data.get("scale") is not None and previous:
                data["scale"] = abs(float(data["scale"])) * abs(amount / previous)
            data["amount"] = amount
            data["unit"] = unit
            if src_meta:
                src_meta["rung"] = rung
                data["prism_source"] = src_meta
            _lognormal_loc(data, amount)
            row.input_code = code
            row.data = data
            row.save()
            moved += 1
            rungs[rung] += 1
    if moved or reprocess:
        bd.Database(name).process()
    return {
        "database": name,
        "exchanges_checked": len(rows),
        "moved": moved,
        "without_source": unresolved,
        "new_flows": added,
        "rungs": dict(rungs),
    }


def replace_bundled_methods() -> int:
    """Deregister the bundled 3.9 methods the workbook import did not overwrite."""
    bd = get_bd()
    removed = 0
    for name in list(bd.methods):
        if bd.methods[name].get("prism_bundled") == bafu.BUNDLED_ORIGIN:
            bd.Method(name).deregister()
            removed += 1
    return removed


def prune_orphans(target: TargetBiosphere) -> dict:
    """Delete bundled or BAFU-created flows the release lacks and nothing points at; drop the
    factors of remaining (custom) methods that sat on them."""
    from bw2data.backends import ExchangeDataset

    bd = get_bd()
    referenced = {
        row.input_code
        for row in ExchangeDataset.select(ExchangeDataset.input_code)
        .where(ExchangeDataset.input_database == BIOSPHERE_DB)
        .distinct()
    }
    doomed = []
    for node in bd.Database(BIOSPHERE_DB):
        if (
            node.get("prism_origin")
            and node["code"] not in target.by_code
            and node["code"] not in referenced
        ):
            doomed.append(node)
    doomed_ids = {n.id for n in doomed}
    trimmed_methods = 0
    if doomed_ids:
        for name in list(bd.methods):
            method = bd.Method(name)
            try:
                cfs = method.load()
            except Exception as exc:  # noqa: BLE001 - a method that cannot load has no factors to trim
                _log.swallowed(exc, "prune_orphans.load")
                continue
            kept = [cf for cf in cfs if not (isinstance(cf[0], int) and cf[0] in doomed_ids)]
            if len(kept) != len(cfs):
                method.write(kept)
                trimmed_methods += 1
        for node in doomed:
            node.delete()
        bd.databases[BIOSPHERE_DB]["prism_biosphere_flows"] = len(bd.Database(BIOSPHERE_DB))
        bd.databases.flush()
    return {"flows_removed": len(doomed), "methods_trimmed": trimmed_methods}


def ecoinvent_master(
    release_flows: list[dict],
    progress: Callable[[str], None] | None = None,
    replace_methods: bool = True,
    reprocess: bool = False,
) -> dict:
    """Run after ecoinvent's flow list has been merged into ``biosphere3`` and its methods are
    written. Returns the numbers for the import report."""
    bd = get_bd()

    def say(text: str) -> None:
        if progress:
            progress(text)

    say("Lifting the biosphere to the release's flow list…")
    lifted = lift_biosphere(release_flows)
    # The target is the RELEASE's list, never the whole biosphere: the 3.9-only flows are still in
    # there at this point and would be hit again by their own names ("TiO2, 54% in ilmenite …").
    target = TargetBiosphere.from_records(release_flows, "ecoinvent release flow list")
    remapped = []
    for name, info in backgrounds():
        if info is not None and info.provider == PROVIDER_BAFU:
            say(f"Re-mapping {name} onto ecoinvent's flow list…")
            remapped.append(remap_database(name, target, origin=name, progress=say, reprocess=reprocess))
            meta = bd.databases[name].get("prism_background") or {}
            meta.setdefault("flow_mapping", {})["remapped_onto"] = target.label
            meta["flow_mapping"]["remap"] = remapped[-1]
            bd.databases[name]["prism_background"] = meta
            bd.databases.flush()
    for name in sorted(bd.databases):
        if name == BIOSPHERE_DB or is_background(name):
            continue
        say(f"Checking {name} for flows the release does not have…")
        remapped.append(remap_database(name, target, origin="ecoinvent-sync", progress=say, reprocess=reprocess))
    say("Replacing bundled methods and removing orphaned flows…")
    # Without a workbook there would be no methods left at all — the bundled ones then stay
    # (they still work: the lifted flows kept their UUIDs) until the workbook arrives.
    removed_methods = replace_bundled_methods() if replace_methods else 0
    pruned = prune_orphans(target)
    from prism_lca.engine.lca import invalidate_lca_cache

    invalidate_lca_cache()
    return {
        "lifted_flows": lifted,
        "remapped": remapped,
        "bundled_methods_removed": removed_methods,
        **pruned,
    }
