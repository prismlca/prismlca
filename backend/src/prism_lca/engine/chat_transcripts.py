"""The tool transcript of a chat's last turn, on disk — so it survives Stop, an error and a restart.

Until now the transcript lived only in a Map in the Electron main process (``agent.ts``, eight
entries), and a restart or an eviction made the next turn answer "from memory": rebuilt from prose,
16.5k instead of 123k tokens of context (V18). One file per chat, ``prism_meta/ai_transcripts/
<chat_id>.json``, next to ``ai_chats.json``. Chat ids are uuid4 hex and unique across models, so the
file is keyed by the chat alone and a model rename needs nothing here.

The content is opaque to the backend (``turn_id``, ``history_after``, ``messages`` — the model's
messages with every open call already closed by main). What this module does own is the size:

- one file may not exceed ``MAX_FILE_BYTES``; a bigger one is refused, never cut — JSON cut at a
  character position is not a shorter transcript, it is a broken one. Main budgets below this and
  drops whole rounds itself;
- the folder may not exceed ``MAX_FOLDER_BYTES`` per project; the oldest files by mtime go first,
  never the one just written. A transcript is a cache with a fallback (rebuild from prose), so losing
  an old chat's one costs a cold start, not data.

Transcripts are never exported in a bundle: they ARE tool results.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

from prism_lca.engine._store import now_iso, prism_meta_dir

DIRNAME = "ai_transcripts"
#: Per file. Main's own byte budget (agent.ts) has to stay below this, or every write is refused.
MAX_FILE_BYTES = 6 * 1024 * 1024
#: Per project, over the whole folder.
MAX_FOLDER_BYTES = 60 * 1024 * 1024

# A chat id becomes a file name — nothing that could climb out of the folder.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_lock = threading.RLock()


class TranscriptTooLarge(ValueError):
    def __init__(self, size: int) -> None:
        super().__init__(f"Transcript is {size} bytes; at most {MAX_FILE_BYTES} are stored.")
        self.size = size


def transcript_dir() -> Path:
    return prism_meta_dir() / DIRNAME


def _path(chat_id: str) -> Path | None:
    if not isinstance(chat_id, str) or not _ID_RE.match(chat_id):
        return None
    return transcript_dir() / f"{chat_id}.json"


def save(chat_id: str, turn_id: str, history_after: list, messages: list) -> int:
    """Write one chat's transcript atomically and return its size in bytes.

    Raises ``TranscriptTooLarge`` over ``MAX_FILE_BYTES`` (the old file stays), ``ValueError`` for an
    id that cannot be a file name.
    """
    path = _path(chat_id)
    if path is None:
        raise ValueError(f"Not a chat id: {chat_id!r}")
    doc = {"turn_id": turn_id, "history_after": history_after, "messages": messages, "saved": now_iso()}
    # Compact on purpose: unlike ai_chats.json nobody reads this by hand, and indentation would eat
    # a noticeable share of the budget on a deep message tree.
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_FILE_BYTES:
        raise TranscriptTooLarge(len(raw))
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, path)
        _enforce_folder_cap(keep=path)
    return len(raw)


def load(chat_id: str) -> Any | None:
    """The stored transcript, or None when there is none (or it cannot be read — a half-written file
    from a hard kill is the same as no file: main rebuilds from prose)."""
    path = _path(chat_id)
    if path is None or not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def delete(chat_id: str) -> None:
    """Idempotent: no file, nothing to do."""
    path = _path(chat_id)
    if path is None:
        return
    with _lock:
        path.unlink(missing_ok=True)


def delete_many(chat_ids: list[str]) -> None:
    for cid in chat_ids:
        delete(cid)


def _enforce_folder_cap(keep: Path) -> None:
    """Oldest first until the folder fits; the file just written is never a candidate."""
    folder = keep.parent
    files: list[tuple[float, int, Path]] = []
    total = 0
    for p in folder.glob("*.json"):
        try:
            st = p.stat()
        except OSError:
            continue  # deleted under us
        total += st.st_size
        if p != keep:
            files.append((st.st_mtime, st.st_size, p))
    if total <= MAX_FOLDER_BYTES:
        return
    files.sort(key=lambda f: f[0])
    for _mtime, size, p in files:
        if total <= MAX_FOLDER_BYTES:
            break
        p.unlink(missing_ok=True)
        total -= size
