"""Dev/test helper: import ecoinvent 3.12 cutoff from local ecospold2 files.

    cd backend
    BRIGHTWAY2_DIR="$HOME/.local/share/Prism LCA/brightway" \
        uv run python scripts/import_ecoinvent.py /path/to/extracted/datasets \
        ["/path/to/LCIA Implementation 3.12.xlsx"]

A thin wrapper around the same engine code the app uses (``engine.ecoinvent``), so the two can
never drift apart. Single process (``use_mp=False``) to keep peak RAM modest; the app defaults
to multiprocessing.
"""
import sys
import time

from prism_lca.engine.ecoinvent import JobState, start_import, status

DATASETS = sys.argv[1]
LCIA_XLSX = sys.argv[2] if len(sys.argv) > 2 else None
PROJECT = DB = "ecoinvent-3.12-cutoff"

t0 = time.time()
start_import(DATASETS, PROJECT, DB, LCIA_XLSX, run_in_thread=False, use_mp=False)
st = status()

print(f"[import] {st.step}: {st.detail}", flush=True)
if st.state is JobState.error:
    sys.exit(2)
print(f"[import] DONE in {round(time.time() - t0)}s", flush=True)
