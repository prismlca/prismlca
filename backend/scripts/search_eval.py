"""Dataset-search eval: run the gold cases through the product's search and report, per case, how far
the right dataset is from the top.

    cd backend
    uv run python scripts/search_eval.py                          # dev cases, model mode
    uv run python scripts/search_eval.py --mode panel --label before
    uv run python scripts/search_eval.py --mode panel --label after --service proto.py:FusionService
    uv run python scripts/search_eval.py --compare before-panel after-panel
    uv run python scripts/search_eval.py --holdout                # held-out cases: once, at the end

The cases live in ``backend/local/search_eval/*.jsonl`` and are NOT versioned: they name ecoinvent
datasets (BYOD rule). Their format is described in ``backend/local/search_eval/FORMAT.md``.

Read-only by construction: the index files are read from the workspace's ``prism_search`` folder and
Brightway is never opened (``BRIGHTWAY2_DIR`` points at a throwaway directory). The embedding model is the
product's own and is loaded only when a query vector is missing from ``qcache.npz`` (~2.3 GB RAM on CPU —
coordinate with anything else that needs memory on this machine).

What a run measures, per case and database scope (ecoinvent, BAFU, both together): the rank of the first
``best`` hit and of the first ``best`` or ``accept`` hit in the list as delivered (after geo-collapse);
for a ``none`` case whether the answer flags itself (weak match, unanchored terms, split or proxy warning).
There is no pass/fail threshold on purpose: runs are compared with each other (``--compare``) — by rank, and
strictly by hit list, regions, scores, weak flags and honesty fields (older saved runs carry no hit
lists). The product blends market vectors with their suppliers' (search/market_vectors.py);
``PRISM_SEARCH_MARKET_BLEND=0`` runs without.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import statistics
import subprocess
import tempfile
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parents[1]
LOCAL = BACKEND / "local" / "search_eval"
APP_DATA = Path.home() / ".local/share/Prism LCA/brightway"
ECOINVENT, BAFU = "ecoinvent-3.12-cutoff", "bafu-2026-v1"
SCOPES = {"ecoinvent": [ECOINVENT], "bafu": [BAFU], "both": [ECOINVENT, BAFU]}

# The request shapes the product sends. Mirrors frontend/src/renderer/src/lib/search.ts (panel) and
# frontend/src/main/ai/tools/groups/read.ts (model: one query, batch: several) — keep them in step.
MODES = {
    "panel": dict(limit=50, limit_cap=150, reserve=3, variants_cap=0),
    "model": dict(limit=25, limit_cap=40, reserve=3),
    "batch": dict(limit=8, limit_cap=16, reserve=2, variants_cap=3),
}


def _index_dir(explicit: Path | None) -> Path:
    """The workspace folder whose search index holds ecoinvent (or the one given)."""
    if explicit:
        return explicit
    for folder in sorted(APP_DATA.glob("*/prism_search")):
        if (folder / f"{ECOINVENT}.json").exists():
            return folder
    raise SystemExit(f"No prism_search folder with {ECOINVENT} under {APP_DATA}; pass --index-dir.")


class CachedProvider:
    """The product's embedding provider behind a persistent query-vector cache."""

    def __init__(self, settings, path: Path) -> None:
        self.settings = settings
        self.path = path
        self.name = "sentence-transformers" if settings.embedding_backend == "sentence-transformers" else (
            settings.embedding_backend)
        self.model = settings.embedding_model_st
        self._real = None
        self.vectors: dict[str, np.ndarray] = {}
        if path.exists():
            data = np.load(path, allow_pickle=False)
            if str(data["model"]) == self.model:
                self.vectors = dict(zip(data["keys"].tolist(), data["vectors"], strict=True))
        self.dirty = False

    def embed(self, texts, is_query: bool = False) -> np.ndarray:
        missing = [t for t in dict.fromkeys(texts) if t not in self.vectors]
        if missing:
            if self._real is None:
                from prism_lca.search.embeddings import get_embedding_provider

                print(f"[eval] loading embedding model {self.model} …", flush=True)
                self._real = get_embedding_provider(self.settings)
            for text, vec in zip(missing, self._real.embed(missing, is_query=True), strict=True):
                self.vectors[text] = vec
            self.dirty = True
        return np.stack([self.vectors[t] for t in texts])

    def save(self) -> None:
        if not self.dirty:
            return
        keys = list(self.vectors)
        tmp = self.path.with_name(self.path.name + ".tmp.npz")
        np.savez(tmp, keys=np.array(keys), vectors=np.stack([self.vectors[k] for k in keys]),
                 model=np.array(self.model))
        tmp.replace(self.path)
        self.dirty = False


def _service_class(spec: str | None):
    """The product's SearchService, or a prototype subclass loaded from ``file.py:ClassName``."""
    from prism_lca.search.service import SearchService

    if not spec:
        return SearchService
    file, _, cls = spec.partition(":")
    module_spec = importlib.util.spec_from_file_location("eval_proto", Path(file).resolve())
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    klass = getattr(module, cls)
    if not issubclass(klass, SearchService):
        raise SystemExit(f"{spec} is not a SearchService subclass")
    return klass


def _sqlite_rows(index_dir: Path, db_name: str):
    """Activity rows for the abbreviation dictionary, read from the workspace's SQLite file READ-ONLY
    (``immutable``: no lock, no journal) — the eval never opens Brightway."""
    import pickle
    import sqlite3

    from prism_lca.search import abbrev

    path = index_dir.parent / "lci" / "databases.db"
    con = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    try:
        for name, product, data in con.execute(
            "select name, product, data from activitydataset where database = ?", (db_name,)
        ):
            d = pickle.loads(data)  # noqa: S301 — the user's own Brightway file
            yield abbrev.Row(name=name or "", product=product or "", unit=str(d.get("unit") or ""),
                             synonyms=[str(x) for x in (d.get("synonyms") or []) if x])
    finally:
        con.close()


def _apply_overlays(index, overlays: list[Path]) -> int:
    """Replace the vectors of the rows an index-recipe experiment re-embedded (``codes`` + ``vectors``).
    Every other row keeps its stored vector bit for bit, so the run measures the WHOLE index under the new
    recipe without rebuilding it."""
    row = {m.get("code"): i for i, m in enumerate(index.meta)}
    index.matrix = index.matrix.copy()
    replaced = 0
    for path in overlays:
        data = np.load(path, allow_pickle=False)
        for code, vec in zip(data["codes"].tolist(), data["vectors"], strict=True):
            i = row.get(code)
            if i is not None:
                index.matrix[i] = vec
                replaced += 1
    return replaced


def make_service(spec: str | None, index_dir: Path, provider: CachedProvider, overlays: list[Path] | None = None):
    from prism_lca.search import abbrev

    base = _service_class(spec)
    dictionary: list = []
    applied: set = set()

    class EvalService(base):  # the seams that would otherwise reach into Brightway
        def _index_base(self, db_name):
            return index_dir / db_name

        def _require_index(self, db_name):
            index = super()._require_index(db_name)
            if overlays and db_name == ECOINVENT and db_name not in applied:
                applied.add(db_name)
                print(f"[eval] overlay: {_apply_overlays(index, overlays)} rows re-embedded", flush=True)
            return index

        def _cache_key(self, db_name):
            return db_name

        def _provider_(self):
            return provider

    def workspace_dictionary():
        # The workspace's backgrounds as the product would find them: ecoinvent and BAFU — read from the
        # SQLite file without Brightway (the product's own reader needs its project to be current).
        if not dictionary:
            dictionary.append(abbrev.Dictionary.merge(
                abbrev.derive(_sqlite_rows(index_dir, db)) for db in (ECOINVENT, BAFU)
                if (index_dir / f"{db}.json").exists()))
        return dictionary[0]

    service = EvalService(provider.settings)
    if hasattr(service, "_variants"):
        service._variants.dictionary = workspace_dictionary
    sqlite = index_dir.parent / "lci" / "databases.db"
    if hasattr(service, "_markets"):
        # The backgrounds and their file as the product would find them; the supplier reading and the
        # blend itself stay the product's (search/market_vectors.py). PRISM_SEARCH_MARKET_BLEND=0 = without.
        service._markets.source = lambda name: sqlite if name in (ECOINVENT, BAFU) else None
    if hasattr(service, "_identifiers"):  # the reference products' substance numbers, read the same way
        service._identifiers.source = lambda name: sqlite if name in (ECOINVENT, BAFU) else None
    return service


def load_cases(holdout: bool) -> list[dict]:
    cases = []
    for path in sorted(LOCAL.glob("cases*.jsonl")):
        for line in path.read_text("utf-8").splitlines():
            if line.strip():
                case = json.loads(line)
                if (case.get("split", "dev") == "holdout") == holdout:
                    cases.append(case)
    if not cases:
        raise SystemExit(f"No cases in {LOCAL} (holdout={holdout}).")
    return cases


def _matches(hit: dict, gold: dict, kinds: tuple[str, ...]) -> bool:
    if not any(re.search(rx, hit.get("name") or "", re.I) for k in kinds for rx in gold.get(k, [])):
        return False
    want = gold.get("geo")
    if not want:
        return True
    geos = {hit.get("geography")} | {v.get("geography") for v in hit.get("variants") or []}
    return bool(geos & set(want))


#: The answer's own honesty fields, kept per case so `--compare` can say which ones a change moved.
HONESTY = ("weak_match", "terms_not_in_results", "unmatched_terms", "split_match_warning", "proxy_warning",
           "best_match_words")


def _shape(h: dict) -> list:
    """A hit as `--compare` checks it strictly: what it is, where it sits, what it shows."""
    return [h.get("database"), h.get("code"), h.get("geography"),
            len(h.get("variants") or []), bool(h.get("reserved")), h.get("score"),
            bool(h.get("weak"))]


def _flagged(answer: dict) -> bool:
    return bool(answer.get("weak_match") or answer.get("terms_not_in_results")
                or answer.get("split_match_warning") or answer.get("proxy_warning"))


def judge(case: dict, scope: str, answer: dict) -> dict:
    dbs = SCOPES[scope]
    golds = {db: case["gold"][db] for db in dbs if db in case["gold"]}
    hits = answer.get("hits") or []
    out = {"id": case["id"], "split": case.get("split", "dev"), "category": case["category"],
           "persona": case["persona"], "tags": case.get("tags", []), "scope": scope,
           "query": case["query"],
           "top": [f"{h.get('database', '')[:4]}|{h.get('activity_type')}|{h.get('name')}" for h in hits[:5]],
           "hits": [_shape(h) for h in hits], "honesty": {k: answer.get(k) for k in HONESTY}}
    if all(g.get("none") for g in golds.values()):
        out["none"] = True
        out["flagged"] = _flagged(answer)
        return out

    def first(kinds):
        for i, h in enumerate(hits, 1):
            gold = golds.get(h.get("database"))
            if gold and not gold.get("none") and _matches(h, gold, kinds):
                return i
        return None

    out["best_rank"] = first(("best",))
    out["any_rank"] = first(("best", "accept"))
    return out


def run(args) -> dict:
    os.environ["BRIGHTWAY2_DIR"] = tempfile.mkdtemp(prefix="prism-search-eval-")  # never the live one
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    from prism_lca.config import get_settings

    settings = get_settings()
    LOCAL.mkdir(parents=True, exist_ok=True)
    provider = CachedProvider(settings, LOCAL / "qcache.npz")
    index_dir = _index_dir(args.index_dir)
    service = make_service(args.service, index_dir, provider, args.overlay)
    cases = load_cases(args.holdout)
    scopes = [args.scope] if args.scope else list(SCOPES)
    results, t0 = [], time.time()
    for case in cases:
        for scope in scopes:
            if not any(db in case["gold"] for db in SCOPES[scope]):
                continue
            if scope == "both" and not all(db in case["gold"] for db in SCOPES[scope]):
                continue
            kwargs = dict(MODES[args.mode])
            if args.literal:
                kwargs["literal"] = True
            if case.get("geographies"):
                kwargs["geographies"] = case["geographies"]
            answer = service.search_many(case["query"], SCOPES[scope], **kwargs)
            results.append(judge(case, scope, answer))
    provider.save()
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=BACKEND, capture_output=True,
                            text=True).stdout.strip()
    return {"meta": {"label": args.label, "mode": args.mode, "service": args.service or "product",
                     "literal": args.literal, "overlays": [str(p) for p in args.overlay],
                     "commit": commit, "date": datetime.now().isoformat(timespec="seconds"),
                     "index_dir": str(index_dir), "model": provider.model, "holdout": args.holdout,
                     "seconds": round(time.time() - t0, 1), "cases": len(cases)},
            "results": results}


def _cell(rows: list[dict]) -> str:
    ranked = [r for r in rows if not r.get("none")]
    nones = [r for r in rows if r.get("none")]
    parts = []
    if ranked:
        best = [r["best_rank"] for r in ranked]
        anyr = [r["any_rank"] for r in ranked]
        found = [x for x in anyr if x]
        parts.append(f"n={len(ranked):3d}  best@1 {sum(1 for x in best if x == 1):3d}  "
                     f"any@3 {sum(1 for x in anyr if x and x <= 3):3d}  "
                     f"any@10 {sum(1 for x in anyr if x and x <= 10):3d}  miss {anyr.count(None):3d}  "
                     f"median {statistics.median(found) if found else float('nan'):4.1f}")
    if nones:
        parts.append(f"none-cases flagged {sum(1 for r in nones if r['flagged'])}/{len(nones)}")
    return "  ".join(parts)


def summarise(report: dict) -> None:
    meta, rows = report["meta"], report["results"]
    print(f"\n[{meta['label'] or 'unlabelled'}] mode={meta['mode']} service={meta['service']} "
          f"commit={meta['commit']} holdout={meta['holdout']} ({meta['seconds']} s)")
    for scope in SCOPES:
        sub = [r for r in rows if r["scope"] == scope]
        if not sub:
            continue
        print(f"\n== {scope}: {_cell(sub)}")
        for key in ("category", "persona"):
            groups = defaultdict(list)
            for r in sub:
                groups[r[key]].append(r)
            for name in sorted(groups):
                print(f"   {key[:3]} {name:13s} {_cell(groups[name])}")
        tags = defaultdict(list)
        for r in sub:
            for t in r["tags"]:
                tags[t].append(r)
        for name in sorted(tags):
            print(f"   tag {name:13s} {_cell(tags[name])}")


def compare(a_path: Path, b_path: Path) -> None:
    a, b = (json.loads(p.read_text("utf-8")) for p in (a_path, b_path))
    index = {(r["id"], r["scope"]): r for r in a["results"]}
    worse, better = [], []
    for r in b["results"]:
        old = index.get((r["id"], r["scope"]))
        if not old:
            continue
        if r.get("none"):
            if old["flagged"] != r["flagged"]:
                (better if r["flagged"] else worse).append((r, "flag", old["flagged"], r["flagged"]))
            continue
        for field in ("any_rank", "best_rank"):
            before, after = old[field] or 999, r[field] or 999
            if after > before:
                worse.append((r, field, old[field], r[field]))
            elif after < before:
                better.append((r, field, old[field], r[field]))
    print(f"\n{a_path.stem} → {b_path.stem}: {len(better)} better, {len(worse)} worse")
    for r, field, before, after in sorted(worse, key=lambda x: (x[0]["scope"], x[0]["id"])):
        print(f"  WORSE  {r['scope']:9s} {field:9s} {before} → {after}  {r['id']}  {r['query']!r}")
    _compare_strictly(index, b["results"])


def _compare_strictly(index: dict, results: list[dict]) -> None:
    """Beyond the ranks: equal ranks can hide a reordered list, another region shown,
    a changed score or weak flag, a vanished warning. Runs saved by older versions carry no hit lists."""
    pairs = [(index[(r["id"], r["scope"])], r) for r in results
             if (r["id"], r["scope"]) in index and "hits" in r and "hits" in index[(r["id"], r["scope"])]]
    if not pairs:
        return
    order = [(old, new) for old, new in pairs
             if [h[:5] for h in old["hits"]] != [h[:5] for h in new["hits"]]]
    shown = 0
    for old, new in pairs:
        before = {(h[0], h[1]): h[5:] for h in old["hits"]}
        shown += sum(1 for h in new["hits"] if (h[0], h[1]) in before and before[(h[0], h[1])] != h[5:])
    moved = {k: sum(1 for old, new in pairs if old["honesty"].get(k) != new["honesty"].get(k)) for k in HONESTY}
    print(f"  strictly, of {len(pairs)} answers: hit list or regions differ in {len(order)}; "
          f"{shown} shared hits show another score or weak flag; honesty fields moved: "
          + (", ".join(f"{k} {n}" for k, n in moved.items() if n) or "none"))
    for _, new in sorted(order, key=lambda p: (p[1]["scope"], p[1]["id"]))[:10]:
        print(f"  ORDER  {new['scope']:9s} {new['id']}  {new['query']!r}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--mode", choices=sorted(MODES), default="model")
    ap.add_argument("--scope", choices=sorted(SCOPES))
    ap.add_argument("--label", default="")
    ap.add_argument("--service", help="prototype as file.py:ClassName (a SearchService subclass)")
    ap.add_argument("--index-dir", type=Path)
    ap.add_argument("--holdout", action="store_true", help="evaluate ONLY the held-out cases")
    ap.add_argument("--literal", action="store_true", help="search the text as typed (no abbreviation variant)")
    ap.add_argument("--overlay", type=Path, action="append", default=[],
                    help="re-embedded rows of an index-recipe experiment (npz: codes, vectors); repeatable. "
                         "The product blends market rows on top (search_market_blend): an overlay that is "
                         "itself a blend needs PRISM_SEARCH_MARKET_BLEND=0")
    ap.add_argument("--compare", nargs=2, metavar=("A", "B"), help="two saved run labels or files")
    args = ap.parse_args()

    runs = LOCAL / "runs"
    if args.compare:
        paths = [Path(x) if x.endswith(".json") else runs / f"{x}.json" for x in args.compare]
        compare(*paths)
        return
    report = run(args)
    summarise(report)
    runs.mkdir(parents=True, exist_ok=True)
    name = f"{args.label or datetime.now().strftime('%Y%m%d-%H%M%S')}-{args.mode}"
    if args.holdout:
        name += "-holdout"
    (runs / f"{name}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), "utf-8")
    print(f"\nsaved {runs / name}.json")


if __name__ == "__main__":
    main()
