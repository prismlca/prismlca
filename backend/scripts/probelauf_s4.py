"""Phase 0, scenario S4 with real data: BAFU first (bw2io's bundled 3.9 biosphere + methods), then
ecoinvent's 3.12 flow list arrives and everything is rewritten onto it (``backgrounds.sync``).
Compares the result with the S2 run (`probelauf.csv`): after the sync, a BAFU dataset must score
exactly what it scores when ecoinvent was there first. THROWAWAY directory only.

The ecoinvent inventory itself (26 533 datasets, 10–40 min) is not imported — it plays no part in
the sync; the 3.12 flow list (``ElementaryExchanges.xml``) and the copied 3.12 methods do.

    cd backend
    uv run python scripts/probelauf_s4.py \\
        --bafu-dir "../databases/BAFU/ecoSpold files" \\
        --flow-list ../databases/ecoinvent/ElementaryExchanges.xml \\
        --live-dump /tmp/prism-bafu-probelauf/live.json \\
        --s2 local/flow_mappings/probelauf.csv \\
        --scratch /tmp/prism-bafu-s4 --out local/flow_mappings/probelauf-s4.json
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import statistics
import sys
import time
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bafu-dir", type=Path, required=True)
    ap.add_argument("--flow-list", type=Path, required=True)
    ap.add_argument("--live-dump", type=Path, required=True, help="live.json of probelauf_bafu.py")
    ap.add_argument("--s2", type=Path, required=True, help="probelauf.csv of the S2 run")
    ap.add_argument("--scratch", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    # Only a scratch directory made by one of the probelauf scripts is wiped: the
    # marker is what probelauf_bafu.py leaves behind, and an empty directory is fine too.
    marker = ".prism-probelauf-scratch"
    if args.scratch.exists():
        if any(args.scratch.iterdir()) and not (args.scratch / marker).exists():
            sys.exit(f"--scratch {args.scratch} is not empty and was not made by a probelauf script; refusing")
        shutil.rmtree(args.scratch)
    args.scratch.mkdir(parents=True)
    (args.scratch / marker).write_text("made by probelauf_s4.py; safe to delete\n", encoding="utf-8")
    os.environ["BRIGHTWAY2_DIR"] = str(args.scratch)
    os.environ.setdefault("PRISM_DATA_DIR", str(args.scratch / "prism"))

    from bw2data.backends import ExchangeDataset

    from prism_lca.engine import ecoinvent
    from prism_lca.engine.backgrounds import common, sync
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    bd.projects.set_current("probelauf-s4")
    timings = {}

    # ---- S3: BAFU alone -------------------------------------------------------------------------
    t = time.time()
    ecoinvent.start_bafu_import(str(args.bafu_dir), "probelauf-s4", run_in_thread=False)
    st = ecoinvent.status()
    timings["s3_import_s"] = round(time.time() - t, 1)
    print(f"[s3] {st.state}: {st.detail[:400]} ({timings['s3_import_s']}s)", flush=True)
    if st.state is not ecoinvent.JobState.done:
        raise SystemExit(1)
    database = st.database
    s3_report = common.registry(database).flow_mapping
    n_bio = len(bd.Database("biosphere3"))
    n_methods = len(bd.methods)
    print(f"[s3] biosphere {n_bio} flows, {n_methods} bundled methods", flush=True)

    # ---- ecoinvent arrives: flow list + 3.12 methods + sync ------------------------------------
    t = time.time()
    note, release_flows = ecoinvent._ensure_biosphere(args.flow_list)
    print(f"[ei] {note}", flush=True)
    data = json.loads(args.live_dump.read_text())
    for m in data["methods"]:
        name = tuple(m["name"])
        method = bd.Method(name)
        meta = {
            "unit": m["unit"],
            "description": "ecoinvent LCIA implementation (copied, probelauf)",
        }
        method.register(**meta)
        current = dict(bd.methods[name])  # register() keeps old metadata for an existing name
        current.update(meta)
        current.pop("prism_bundled", None)
        bd.methods[name] = current
        method.write([(("biosphere3", code), amount) for code, amount in m["cfs"]])
    bd.methods.flush()
    report = sync.ecoinvent_master(
        release_flows, progress=lambda s: print(f"[sync] {s}", flush=True), replace_methods=True
    )
    timings["sync_s"] = round(time.time() - t, 1)
    print(f"[sync] {json.dumps({k: v for k, v in report.items() if k != 'remapped'})}", flush=True)
    for r in report["remapped"]:
        print(f"[sync] {r}", flush=True)

    # ---- invariants ----------------------------------------------------------------------------
    codes_312 = {f["code"] for f in release_flows}
    bio = {n["code"]: n for n in bd.Database("biosphere3")}
    dangling = 0
    on_new = 0
    for row in ExchangeDataset.select(ExchangeDataset.input_code).where(
        (ExchangeDataset.output_database == database)
        & (ExchangeDataset.input_database == "biosphere3")
    ):
        if row.input_code not in bio:
            dangling += 1
        elif row.input_code not in codes_312:
            on_new += 1
    leftover_39 = sum(1 for n in bio.values() if n.get("prism_origin") == "bw2io")
    bundled_methods = sum(1 for m in bd.methods if bd.methods[m].get("prism_bundled"))
    print(
        f"[check] dangling exchanges {dangling}; exchanges on non-3.12 (new) flows {on_new}; "
        f"leftover bundled flows {leftover_39}; bundled methods left {bundled_methods}; "
        f"biosphere now {len(bio)} flows",
        flush=True,
    )

    # ---- scores vs S2 --------------------------------------------------------------------------
    import bw2calc as bc

    t = time.time()
    acts = list(bd.Database(database))
    methods = {
        "GWP": (
            "IPCC 2021",
            "climate change: total (excl. biogenic CO2)",
            "global warming potential (GWP100)",
        ),
        "UBP": ("Ecological Scarcity 2021", "total", "UBP"),
    }
    lca = bc.LCA({acts[0]: 1}, method=methods["GWP"])
    lca.lci(factorize=True)
    lca.lcia()
    cfs = {}
    for fam, m in methods.items():
        lca.switch_method(m)
        cfs[fam] = lca.characterization_matrix.copy()
    ours = {}
    for act in acts:
        lca.redo_lci({act.id: 1})
        ours[act["code"]] = {fam: float((cfs[fam] * lca.inventory).sum()) for fam in methods}
    timings["lcia_s"] = round(time.time() - t, 1)
    s2 = {r["code"]: r for r in csv.DictReader(args.s2.open(encoding="utf-8"))}
    # S2 scores in probelauf.csv are per workbook unit; convert back with the same factors.
    to_workbook = {
        ("kWh", "MJ"): 1 / 3.6,
        ("ha", "m2"): 1e-4,
        ("km", "m"): 1e-3,
        ("my", "km*a"): 1000.0,
    }
    diffs = {fam: [] for fam in methods}
    for code, sc in ours.items():
        r = s2.get(code)
        if not r:
            continue
        f = to_workbook.get((r["unit"], r["workbook_unit"]), 1.0)
        for fam in methods:
            a, b = sc[fam] * f, float(r[f"{fam}.ours"])
            diffs[fam].append(abs(a - b) / abs(b) if b else abs(a))
    summary = {}
    for fam, d in diffs.items():
        summary[fam] = {
            "compared": len(d),
            "max_rel_diff": max(d) if d else None,
            "median_rel_diff": statistics.median(d) if d else None,
            "identical_1e-9": sum(1 for x in d if x <= 1e-9),
        }
        print(f"[s4 vs s2] {fam}: {summary[fam]}", flush=True)
    result = {
        "database": database,
        "s3_flow_mapping": s3_report,
        "sync": report,
        "check": {
            "dangling": dangling,
            "on_new_flows": on_new,
            "leftover_bundled_flows": leftover_39,
            "bundled_methods_left": bundled_methods,
            "biosphere_flows": len(bio),
        },
        "s4_vs_s2": summary,
        "timings": timings,
    }
    args.out.write_text(json.dumps(result, indent=1, ensure_ascii=False, default=str))
    print(f"[out] {args.out} {timings}")


if __name__ == "__main__":
    main()
