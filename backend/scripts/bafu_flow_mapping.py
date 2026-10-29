"""Generate (or refresh) the BAFU → biosphere flow-mapping review table. READ-ONLY.

Reads the BAFU ecoSpold-1 folder, the live project's ``biosphere3`` (ecoinvent 3.12) and
bw2io's bundled 3.9 flow list, runs the ladder from
``prism_lca.engine.backgrounds.flow_mapping`` against BOTH targets and writes one CSV with a
column group per target. Method relevance (GWP / UBP / EF) is read from the live project's
methods so the reviewer can sort unresolved flows by what they would cost.

The table holds ecoinvent flow names and UUIDs, so it lives in ``backend/local/`` (gitignored,
not packaged) — BYOD rule: the repo ships the engine and a small name-only fallback, never the
table. Nothing is written to any Brightway project — the live project is opened only to read
``biosphere3`` and three method families (nothing is ever imported into the working
project). Re-running keeps ``status`` and ``note`` of the existing table and treats
``confirmed`` rows as curated.

    cd backend
    BRIGHTWAY2_DIR="$HOME/.local/share/Prism LCA/brightway" \\
        uv run python scripts/bafu_flow_mapping.py \\
        --bafu-dir "../databases/BAFU/ecoSpold files" \\
        --out local/flow_mappings/bafu-2026-v1.csv
"""

from __future__ import annotations

import argparse
import time
from collections import Counter, defaultdict
from pathlib import Path

from prism_lca.engine.backgrounds.flow_mapping import (
    Correspondence,
    Proposal,
    SourceFlow,
    TargetBiosphere,
    curated_factors_from_review,
    curated_from_review,
    load_fallbacks,
    propose,
    read_review_table,
    renamed_flows,
    scan_ecospold1_flows,
    summarize,
    write_review_table,
)
from prism_lca.engine.bootstrap import get_bd

EI312, BW39 = "ei312", "bw39"

#: Method families whose characterisation decides a flow's review priority.
FAMILIES = {
    "GWP": lambda m: m[0] == "IPCC 2021" and "GWP100" in m[2],
    "UBP": lambda m: m[0] == "Ecological Scarcity 2021",
    "EF": lambda m: m[0] == "EF v3.1",
}


def live_biosphere(bd, project: str, db: str) -> tuple[TargetBiosphere, dict[str, set[str]]]:
    """``biosphere3`` of the live project as plain records, plus ``code → {families with a CF}``."""
    bd.projects.set_current(project)
    # Only the release's own flows: a project that already holds BAFU also holds the flows its
    # import created, and the ladder would find those by name.
    nodes = [n for n in bd.Database(db) if not n.get("prism_origin")]
    records = [
        {
            "code": n["code"],
            "name": n["name"],
            "categories": n["categories"],
            "unit": n.get("unit", ""),
            "CAS number": n.get("CAS number", ""),
            "synonyms": n.get("synonyms", ()),
        }
        for n in nodes
    ]
    code_of_id = {n.id: n["code"] for n in nodes}
    relevance: dict[str, set[str]] = defaultdict(set)
    for method in bd.methods:
        fams = [f for f, test in FAMILIES.items() if test(method)]
        if not fams:
            continue
        for key, amount in bd.Method(method).load():
            if not amount:
                continue
            code = code_of_id.get(key) if isinstance(key, int) else key[1]
            if code:
                relevance[code].update(fams)
    return TargetBiosphere.from_records(records, f"{db} @ {project}"), relevance


def check(
    flows: list[SourceFlow],
    proposals: dict[str, list[Proposal]],
    truth: dict[tuple[str, str, str, str], dict[str, str]],
    expected_path: Path,
    write_expected: bool,
) -> int:
    """Engine-only proposals against the reviewed table; returns the number of differences.

    A ``confirmed``/``auto`` row must come out with the same target code and factor; a
    ``rejected`` row must stay unresolved — except an ``exact`` hit, which is by definition right
    for THAT target (the 3.9 list still carries ore flows 3.12 dropped). Rows the table left
    empty for a target (no 3.9 counterpart known) may be filled by the engine; that is progress,
    printed as such, not counted.
    """
    problems = 0
    totals: dict[str, dict[str, int]] = {}
    for tgt, plist in proposals.items():
        rungs = Counter()
        status = Counter()
        exchanges = Counter()
        for p in plist:
            row = truth.get(p.source.key)
            if row is None:
                print(f"[check:{tgt}] NEW FLOW not in table: {p.source.key}")
                problems += 1
                continue
            rungs[p.rung] += 1
            exchanges["resolved" if p.resolved else "unresolved"] += p.source.count
            want = row[f"{tgt}.code"] if row["status"] in ("auto", "confirmed") else ""
            want_factor = float(row[f"{tgt}.factor"] or 1.0)
            got = p.target.code if p.resolved else ""
            if want == got and (not want or abs(want_factor - p.factor) < 1e-9):
                status["same"] += 1
                continue
            if not want and row["status"] == "confirmed" and got:
                status["filled"] += 1  # progress on a target the review left empty
                continue
            if not want and row["status"] == "rejected" and p.rung == "exact":
                status["exact_kept"] += 1
                continue
            problems += 1
            status["DIFF"] += 1
            print(
                f"[check:{tgt}] {row['status']:9s} {p.rung:12s} {p.source.count:5d}× "
                f"{p.source.name!r} [{p.source.category}/{p.source.subcategory}/{p.source.unit}]"
                f" table: {row[f'{tgt}.target_name']!r} ×{want_factor}"
                f" engine: {p.target.name if p.target else None!r} ×{p.factor} {p.unit_conflict}"
            )
        totals[tgt] = {
            "rows": len(plist),
            **{f"rung.{k}": v for k, v in sorted(rungs.items())},
            **{f"status.{k}": v for k, v in sorted(status.items())},
            "exchanges.resolved": exchanges["resolved"],
            "exchanges.unresolved": exchanges["unresolved"],
        }
        print(f"[check:{tgt}] {dict(status)}  unresolved rows: {rungs['unresolved']}")
    import json

    if write_expected:
        expected_path.write_text(json.dumps(totals, indent=1, sort_keys=True) + "\n")
        print(f"[check] control values written to {expected_path}")
    elif expected_path.exists():
        expected = json.loads(expected_path.read_text())
        for tgt, values in totals.items():
            for key, value in values.items():
                if expected.get(tgt, {}).get(key) != value:
                    print(
                        f"[check:{tgt}] CONTROL {key}: expected {expected.get(tgt, {}).get(key)}, got {value}"
                    )
                    problems += 1
        for tgt in expected:
            for key in expected[tgt]:
                if key not in totals.get(tgt, {}):
                    print(f"[check:{tgt}] CONTROL {key} missing in this run")
                    problems += 1
    else:
        print(f"[check] no control file at {expected_path} (use --write-expected)")
    return problems


def _deviation_class(p312: Proposal, p39: Proposal, bw39: TargetBiosphere) -> str:
    """What kind of difference between the two targets this is — a label for the report; the
    accepted list decides, not the label."""
    if p312.target.code not in bw39.by_code:
        return "new in 3.12"
    if not p39.resolved:
        return "unresolved in 3.9"
    name, cats = p39.target.name, p39.target.categories
    if "%" in name or "ppm" in name:
        return "ore grade (3.9 only)"
    if "stratosphere" in " ".join(cats):
        return "stratosphere (3.9 only)"
    return "other"


def cross_check(
    proposals: dict[str, list[Proposal]],
    bw39: TargetBiosphere,
    accepted_path: Path,
    write: bool,
) -> int:
    """The BAFU-only path against the reviewed 3.12 one: every flow whose 3.9 target is not the flow
    its 3.12 target was in 3.9 (same UUID) must be a reviewed, accepted difference in
    ``cross-39.json`` (version differences: ore grades and the stratosphere compartment 3.12
    dropped, ion names, substances 3.9 lacks). A new difference, or an accepted one that is gone,
    counts as a problem."""
    import json

    p312 = {p.source.key: p for p in proposals[EI312]}
    seen: dict[str, dict[str, str]] = {}
    classes: Counter = Counter()
    for p39 in proposals[BW39]:
        p = p312[p39.source.key]
        if not p.resolved:
            continue  # the review left the flow without a 3.12 target: nothing to compare against
        if p39.resolved and p39.target.code == p.target.code:
            continue
        kind = _deviation_class(p, p39, bw39)
        classes[kind] += 1
        seen["|".join(p39.source.key)] = {
            "class": kind,
            "ei312": p.target.name,
            "bw39": p39.target.name if p39.resolved else "",
        }
    print(f"[cross-39] {sum(classes.values())} differences 3.9 vs 3.12: {dict(classes)}")
    if write:
        accepted_path.write_text(json.dumps(seen, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
        print(f"[cross-39] accepted list written to {accepted_path}")
        return 0
    if not accepted_path.exists():
        print(f"[cross-39] no accepted list at {accepted_path} (use --write-expected after review)")
        return 1
    accepted = json.loads(accepted_path.read_text())
    problems = 0
    for key in sorted(set(seen) - set(accepted)):
        print(f"[cross-39] NEW {seen[key]['class']:24s} {key}: 3.12 {seen[key]['ei312']!r} / 3.9 {seen[key]['bw39']!r}")
        problems += 1
    for key in sorted(set(accepted) - set(seen)):
        print(f"[cross-39] GONE {key}: was 3.9 {accepted[key]['bw39']!r}")
        problems += 1
    for key in sorted(set(seen) & set(accepted)):
        if seen[key]["bw39"] != accepted[key]["bw39"]:
            print(f"[cross-39] CHANGED {key}: 3.9 {accepted[key]['bw39']!r} → {seen[key]['bw39']!r}")
            problems += 1
    return problems


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bafu-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--check", action="store_true", help="regression: engine-only vs. the table")
    ap.add_argument(
        "--write-expected", action="store_true", help="with --check: refresh expected.json"
    )
    ap.add_argument("--project", default="ecoinvent-3.12-cutoff")
    ap.add_argument("--biosphere", default="biosphere3")
    ap.add_argument(
        "--bw39-xml",
        type=Path,
        default=None,
        help="bw2io's bundled 'ecoinvent elementary flows 3.9.xml' (auto-detected)",
    )
    args = ap.parse_args()

    t0 = time.time()
    flows = scan_ecospold1_flows(args.bafu_dir)
    print(
        f"[scan] {len(flows)} unique flows, {sum(f.count for f in flows)} exchanges "
        f"({time.time() - t0:.0f}s)",
        flush=True,
    )

    bd = get_bd()
    ei312, relevance312 = live_biosphere(bd, args.project, args.biosphere)
    print(
        f"[ei312] {len(ei312)} flows, {len(relevance312)} characterised in GWP/UBP/EF", flush=True
    )

    xml = args.bw39_xml
    if xml is None:
        import bw2io

        xml = Path(bw2io.__file__).parent / "data" / "lci" / "ecoinvent elementary flows 3.9.xml"
    bw39 = TargetBiosphere.from_ecospold2_xml(xml, "bw2io bundled 3.9")
    renames = renamed_flows(bw39, ei312)
    # 3.9 flows carry no CF list of their own here: a 3.9 flow is "relevant" when its UUID is
    # characterised in 3.12 (90.9 % of the UUIDs are shared).
    relevance39 = {c: fams for c, fams in relevance312.items() if c in bw39.by_code}
    print(f"[bw39] {len(bw39)} flows, {len(renames)} renamed against 3.12", flush=True)

    corr = Correspondence.from_bw2io()
    print(
        f"[ei2to3] {len(corr.uuid)} v2.2→v3 rows with UUID, {len(corr.dropped)} dropped in v3 "
        f"— source: {corr.source}",
        flush=True,
    )
    fallbacks = load_fallbacks()
    print(f"[fallback] {len(fallbacks)} shipped name-to-name decisions", flush=True)
    previous = read_review_table(args.out)
    if args.check:
        proposals = {
            EI312: propose(flows, ei312, renames=renames, correspondence=corr, fallbacks=fallbacks),
            BW39: propose(flows, bw39, correspondence=corr, fallbacks=fallbacks),
        }
        problems = check(
            flows, proposals, previous, args.out.with_name("expected.json"), args.write_expected
        )
        problems += cross_check(
            proposals, bw39, args.out.with_name("cross-39.json"), args.write_expected
        )
        print(f"[check] {problems} difference(s) ({time.time() - t0:.0f}s)")
        raise SystemExit(1 if problems else 0)
    proposals = {
        EI312: propose(
            flows,
            ei312,
            renames=renames,
            correspondence=corr,
            curated=curated_from_review(previous, EI312),
            curated_factors=curated_factors_from_review(previous, EI312),
            fallbacks=fallbacks,
        ),
        BW39: propose(
            flows,
            bw39,
            correspondence=corr,
            curated=curated_from_review(previous, BW39),
            curated_factors=curated_factors_from_review(previous, BW39),
            fallbacks=fallbacks,
        ),
    }
    total = sum(f.count for f in flows)
    for name, props in proposals.items():
        print(f"[{name}]")
        for rung, (n_flows, n_exc) in summarize(props).items():
            print(f"   {rung:14s} {n_flows:5d} flows  {n_exc:7d} exchanges  {n_exc / total:6.1%}")
    write_review_table(
        args.out,
        flows,
        proposals,
        relevance={EI312: relevance312, BW39: relevance39},
        previous=previous,
    )
    kept = sum(1 for r in previous.values() if r.get("status") in ("confirmed", "rejected"))
    print(
        f"[out] {args.out} — {len(flows)} rows, {kept} reviewed rows carried over "
        f"({time.time() - t0:.0f}s total)"
    )


if __name__ == "__main__":
    main()
