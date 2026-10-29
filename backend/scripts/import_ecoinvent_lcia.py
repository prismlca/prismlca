"""Dev/test helper: import ecoinvent 3.12 LCIA methods from the licensed implementation file.

    # 1) extract the workbook from the licensed archive (once):
    7z e -y -o"$HOME/.local/share/Prism LCA/ei-lcia" \
        "databases/ecoinvent/ecoinvent 3.12_LCIA_implementation.7z" "LCIA Implementation 3.12.xlsx"
    # 2) write the methods into the ecoinvent project:
    cd backend
    BRIGHTWAY2_DIR="$HOME/.local/share/Prism LCA/brightway" uv run --no-sync python \
        scripts/import_ecoinvent_lcia.py "$HOME/.local/share/Prism LCA/ei-lcia/LCIA Implementation 3.12.xlsx"

A thin wrapper around the same engine code the app uses (``engine.ecoinvent``); the linking and
writing live there so the script and the in-app import cannot drift apart.
"""
import sys
import time

from prism_lca.engine.ecoinvent import JobState, start_lcia_import, status

XLSX = sys.argv[1]
PROJECT = sys.argv[2] if len(sys.argv) > 2 else "ecoinvent-3.12-cutoff"

t0 = time.time()
start_lcia_import(XLSX, PROJECT, run_in_thread=False)
st = status()

print(f"[lcia] {st.step}: {st.detail}", flush=True)
if st.state is JobState.error:
    sys.exit(2)
print(f"[lcia] DONE in {round(time.time() - t0)}s", flush=True)
