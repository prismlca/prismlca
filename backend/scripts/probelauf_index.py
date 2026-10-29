"""Phase 0, second half: build the search index for the BAFU database in the THROWAWAY project
that ``probelauf_bafu.py`` left behind (run it with ``--keep`` or simply afterwards — the scratch
directory is only deleted at the START of that script), and report the build time and row count.

    cd backend
    uv run python scripts/probelauf_index.py --scratch /tmp/prism-bafu-probelauf --database bafu-2026-v1

Uses the app's real search service and embedding settings (the same model the desktop app uses),
so the number is what a user would wait. Nothing touches the working project.
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--scratch", type=Path, required=True)
    ap.add_argument("--database", default="bafu-2026-v1")
    ap.add_argument("--project", default="probelauf")
    args = ap.parse_args()

    os.environ["BRIGHTWAY2_DIR"] = str(args.scratch)
    os.environ.setdefault("PRISM_DATA_DIR", str(args.scratch / "prism"))
    from prism_lca.config import get_settings
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.search.builds import IndexState
    from prism_lca.search.service import SearchService

    bd = get_bd()
    bd.projects.set_current(args.project)
    service = SearchService(get_settings())
    t0 = time.time()
    status = service.builds.build(args.database)
    while status.state == IndexState.running:
        time.sleep(2)
        status = service.builds.status()
        print(f"[index] {status.count}/{status.total} ({time.time() - t0:.0f}s)", flush=True)
    info = service.index_info(args.database)
    print(
        f"[index] {status.state}: {status.detail} — {info.get('indexed_count')} rows in "
        f"{time.time() - t0:.0f}s (backend {get_settings().embedding_backend})"
    )
    hits = service.search_many("electricity, medium voltage, at grid", [args.database], limit=5)
    for h in (hits.get("results") or hits.get("hits") or [])[:5]:
        print("   ", h.get("name"), h.get("geography"), h.get("database"))


if __name__ == "__main__":
    main()
