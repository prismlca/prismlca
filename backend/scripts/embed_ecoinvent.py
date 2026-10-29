"""Robust bge-m3 embedding of the ecoinvent project (progress + small batches).

Memory-conscious variant of build_ecoinvent_index.py: small batches keep peak RAM low on a
loaded workstation, and it logs progress every ~800 activities so a long CPU run is monitorable.
Writes a `.DONE` marker next to the index on success.

    cd backend
    BRIGHTWAY2_DIR="$HOME/.local/share/Prism LCA/brightway" \
        OMP_NUM_THREADS=4 uv run --no-sync python scripts/embed_ecoinvent.py
"""
import os
import time
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from prism_lca.config import Settings  # noqa: E402
from prism_lca.engine.bootstrap import get_bd  # noqa: E402
from prism_lca.search.embeddings import get_embedding_provider  # noqa: E402
from prism_lca.search.index import VectorIndex  # noqa: E402
from prism_lca.search.indexer import activity_meta  # noqa: E402

DB = "ecoinvent-3.12-cutoff"
BATCH = 16

bd = get_bd()
bd.projects.set_current(DB)

metas, texts = [], []
for act in bd.Database(DB):
    m, t = activity_meta(act, DB)
    metas.append(m)
    texts.append(t)
print(f"[embed] {len(texts)} activities loaded", flush=True)

provider = get_embedding_provider(Settings(embedding_backend="sentence-transformers"))
print(f"[embed] provider: {provider.name} (bge-m3)", flush=True)
dim = int(provider.embed(["probe"]).shape[1])
index = VectorIndex(dim=dim, provider=provider.name)
print(f"[embed] dim={dim}; embedding in batches of {BATCH}…", flush=True)

t0 = time.time()
for start in range(0, len(texts), BATCH):
    index.add(provider.embed(texts[start:start + BATCH]), metas[start:start + BATCH])
    if start % 800 == 0 and start:
        rate = start / (time.time() - t0)
        eta = round((len(texts) - start) / rate)
        print(f"[embed] {start}/{len(texts)}  {round(time.time()-t0)}s  ~{eta}s left", flush=True)

base = Path(bd.projects.dir) / "prism_search" / DB
index.save(base)  # atomic (tmp+rename) + load-time consistency check; no extra marker needed
print(f"[embed] DONE {len(index)} vectors dim={index.dim} -> {base}.npz  {round(time.time()-t0)}s", flush=True)
