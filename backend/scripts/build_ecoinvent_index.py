"""Dev/test helper: build the semantic search index over ecoinvent-3.12-cutoff with bge-m3.

Run from the office (needs sentence-transformers + CPU torch installed, i.e. `uv sync`).
BRIGHTWAY2_DIR must point at the app data dir that holds the imported ecoinvent project, e.g.:

    cd backend
    uv sync --extra dev                       # installs CPU torch + sentence-transformers
    BRIGHTWAY2_DIR="$HOME/.local/share/Prism LCA/brightway" \
        uv run python scripts/build_ecoinvent_index.py

Downloads the bge-m3 model (~2 GB) on first use, then embeds ~26k activities on CPU
(~20–50 min). The index is saved where the running app's SearchService looks for it.
"""
import time
from pathlib import Path

from prism_lca.config import Settings
from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.embeddings import get_embedding_provider
from prism_lca.search.indexer import build_index

DB = "ecoinvent-3.12-cutoff"

bd = get_bd()
bd.projects.set_current(DB)
print(f"[embed] project active; {DB} = {len(bd.Database(DB))} activities", flush=True)

provider = get_embedding_provider(Settings(embedding_backend="sentence-transformers"))  # bge-m3
print(f"[embed] provider: {provider.name} (bge-m3; downloads on first use)…", flush=True)

t0 = time.time()
index = build_index(bd, DB, provider, batch_size=128)
print(f"[embed] embedded {len(index)} activities, dim={index.dim}, {round(time.time()-t0)}s", flush=True)

base = Path(bd.projects.dir) / "prism_search" / DB
index.save(base)
print(f"[embed] DONE — saved index to {base}.npz", flush=True)
