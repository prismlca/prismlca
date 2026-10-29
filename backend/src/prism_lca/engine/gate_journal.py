"""A short-lived record of what the report gate decided, one line per judgement.

**Why this exists.** The gate refuses a chapter, the writer revises, the second attempt passes — and
nothing anywhere says what the objection was. Only the accepted text is stored, with its *advisory*
findings; the blocking one that triggered the revision lives for the length of one HTTP call. The
audit log keeps successful stores only, and the app's console log is truncated at every start. In
one run three chapters finished at two attempts, and by the morning it was impossible
to say what any of the three had been refused for.

**Why here and not in the writer.** Every attempt goes through `POST …/sections/{id}/proposal` —
the revision loop with ``store=false``, the final write with ``store=true``, and so do the single
Write, the patch path and the draft's "Check & store". One place catches all of them; four places
would eventually be three.

**Diagnostics, not a record.** This is not the audit log and not part of the report. It rotates, it
keeps no whole chapter — only each finding's own sentence, capped — and nothing in the product reads
it; it is opened by hand when a run needs explaining. A logging failure must never cost a chapter, so
every write is guarded.

**The tally behind retiring a rule.** A chapter read by a second model carries, per hint kind, how
often the reader had the sentence changed (`fixed`) and how often it let the hint stand
(`dismissed`). Summed over runs, that is each word list's precision against a reader — the number
that decides whether a list still earns its place.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from prism_lca.engine.bootstrap import get_bd

#: Rotate above this. Two megabytes is a few thousand judgements — several weeks of modelling sessions —
#: and small enough that rewriting the file to trim it costs nothing.
MAX_BYTES = 2 * 1024 * 1024

#: How much of the file survives a rotation. Half, so trimming happens rarely rather than on every
#: append once the cap is reached.
KEEP_FRACTION = 0.5

#: A finding's own explanation is the whole point of the record — it is what says *what* was wrong.
#: Capped because a detail quoting a long sentence is still a detail.
_DETAIL_CHARS = 400

_LOCK = threading.Lock()


def _path() -> Path:
    return Path(get_bd().projects.dir) / "prism_meta" / "report_gate.jsonl"


def _trim(path: Path) -> None:
    """Drop the oldest lines so the file is back under half the cap."""
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    keep = int(MAX_BYTES * KEEP_FRACTION)
    size, out = 0, []
    for line in reversed(lines):
        size += len(line.encode("utf-8"))
        if size > keep:
            break
        out.append(line)
    tmp = path.with_suffix(".jsonl.tmp")
    tmp.write_text("".join(reversed(out)), encoding="utf-8")
    tmp.replace(path)


def _slim(finding: Any) -> dict[str, Any]:
    """One finding, without the payload that would make this file big or interesting to leak."""
    if not isinstance(finding, dict):
        return {"kind": "?"}
    out: dict[str, Any] = {"kind": str(finding.get("kind") or "?")}
    for key in ("detail", "sentence", "path"):
        value = finding.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()[:_DETAIL_CHARS]
    return out


def note(
    *,
    database: str,
    report_id: str,
    section_id: str,
    kind: str,
    store: bool,
    ok: bool,
    findings: list[dict] | None,
    advisory_kinds: frozenset[str] | set[str],
    text_chars: int,
    lookups: int,
    model: str | None,
    run: str | None,
    attempt: int | None,
    repaired: int = 0,
    reviewer: str | None = None,
    hint_outcomes: dict[str, dict[str, int]] | None = None,
) -> None:
    """Append one judgement. Never raises."""
    try:
        blocking = [_slim(f) for f in (findings or []) if isinstance(f, dict)
                    and str(f.get("kind")) not in advisory_kinds]
        advisory = sorted({str(f.get("kind")) for f in (findings or [])
                           if isinstance(f, dict) and str(f.get("kind")) in advisory_kinds})
        from datetime import UTC, datetime

        row = {
            "ts": datetime.now(UTC).isoformat(timespec="seconds"),
            "run": run,
            "attempt": attempt,
            "database": database,
            "report": report_id,
            "section": section_id,
            "kind": kind,
            "store": store,
            "ok": ok,
            "blocking": blocking,
            "advisory": advisory,
            "repaired": repaired,
            "chars": text_chars,
            "lookups": lookups,
            "model": model,
        }
        if reviewer:
            row["reviewer"] = reviewer
            row["hints"] = hint_outcomes or {}
        path = _path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with _LOCK:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            if path.stat().st_size > MAX_BYTES:
                _trim(path)
    except Exception:  # noqa: BLE001 — diagnostics must never cost a chapter
        if os.environ.get("PRISM_DEBUG"):
            raise
