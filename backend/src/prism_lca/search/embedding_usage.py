"""What the API embeddings actually consumed — the backend's side of the cost ledger.

The chat and report models bill through the Electron main process, which keeps the ledger the
Settings page shows. Embeddings bill from *here* (the search index talks to OpenRouter/OpenAI
directly), and until V127 that spend was invisible: the ledger simply had no embedding rows.

Same shape as the frontend ledger — month → model → {cost, prompt, calls} — so the main process
can merge it in as the 'embedding' category without translating anything. Cost is recorded when
the response carries one; the OpenAI embeddings API usually reports only tokens, and a token count
with cost 0 is honest ("this ran, this is its size") where an invented price would not be.

Local backends (fastembed, sentence-transformers, hashing) record nothing: they cost electricity,
not API budget, and a ledger of API costs should not claim otherwise.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from prism_lca import _log

_LOCK = threading.Lock()


def _file() -> Path:
    from prism_lca.config import settings

    return Path(settings.data_dir) / "embedding-usage.json"


def _load() -> dict[str, Any]:
    try:
        data = json.loads(_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as exc:  # noqa: BLE001 — no file yet / unreadable → start fresh
        _log.swallowed(exc, "_load")
        return {}


def record(model: str, prompt_tokens: int, cost: float = 0.0) -> None:
    """Add one request. Never raises — a failed cost write must never break an index build."""
    if not model or (prompt_tokens <= 0 and cost <= 0):
        return
    try:
        with _LOCK:
            data = _load()
            month = time.strftime("%Y-%m")
            bucket = data.setdefault(month, {})
            entry = bucket.setdefault(model, {"cost": 0.0, "prompt": 0, "calls": 0})
            entry["cost"] = float(entry.get("cost", 0.0)) + max(0.0, float(cost))
            entry["prompt"] = int(entry.get("prompt", 0)) + max(0, int(prompt_tokens))
            entry["calls"] = int(entry.get("calls", 0)) + 1
            target = _file()
            tmp = target.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
            tmp.replace(target)
    except Exception as exc:  # noqa: BLE001
        _log.swallowed(exc, "record")


def snapshot() -> dict[str, Any]:
    """The whole ledger, for the system endpoint the frontend merges from."""
    with _LOCK:
        return _load()
