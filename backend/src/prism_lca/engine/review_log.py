"""Internal-review provenance, per model.

``review_model`` produces the one document a critical reader asks for — what an independent pass
challenged — and it used to evaporate with the chat: the study field ``critical_review`` could say
"an internal second review was carried out" while nothing on disk could show what it found, what
was fixed, and what was considered and rejected. This log keeps each review verbatim, stamped with
the LCA cache generation so a report can say honestly whether the model has changed since, and it
keeps the *builder's* verdict per finding (fixed | rejected | open) once one is recorded.

The resolutions are deliberately the builder's statement, not a parse of the review prose: a
finding's outcome ("the reviewer suggested a DE heat market; it does not exist in 3.12") is a
judgement only the party that acted on it can state. Same storage pattern as chats and scenarios;
not undoable, because it is a log of what happened, not a piece of the model.
"""
from __future__ import annotations

import uuid

from prism_lca.engine._store import JsonFileStore, now_z

#: Reviews kept per model — enough for a build with re-reviews after structural changes.
MAX_REVIEWS = 10
#: The review text is evidence, not snapshot material; capped so ten of them stay a small file.
MAX_REVIEW_CHARS = 12_000
MAX_RESOLUTIONS = 40

RESOLUTIONS = ("fixed", "rejected", "open")


def clean_resolutions(items: object) -> list[dict]:
    """Normalise ``[{finding, resolution, reason}]``; unknown resolutions become ``open``."""
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for item in items[:MAX_RESOLUTIONS]:
        if not isinstance(item, dict):
            continue
        finding = str(item.get("finding") or "").strip()
        if not finding:
            continue
        resolution = str(item.get("resolution") or "open").strip().lower()
        entry = {
            "finding": finding[:400],
            "resolution": resolution if resolution in RESOLUTIONS else "open",
        }
        reason = str(item.get("reason") or "").strip()
        if reason:
            entry["reason"] = reason[:600]
        out.append(entry)
    return out


class ReviewLogStore(JsonFileStore):
    FILENAME = "review_log.json"
    # A log: a half-written file from a hard kill must not stop the app — entries can be re-recorded.
    ON_ERROR = "empty_io"

    def _load(self) -> dict[str, list[dict]]:
        data = super()._load()
        return data if isinstance(data, dict) else {}

    def list(self, database: str) -> list[dict]:
        return list(self._load().get(database) or [])

    def latest(self, database: str) -> dict | None:
        reviews = self.list(database)
        return reviews[-1] if reviews else None

    def record_review(
        self, database: str, review: str, gaps: list | None = None, generation: int | None = None
    ) -> dict:
        with self._lock:
            text = str(review or "").strip()
            if not text:
                return {"error": "empty review"}
            data = self._load()
            stored = list(data.get(database) or [])
            entry = {
                "id": uuid.uuid4().hex[:12],
                "created": now_z(),
                "review": text[:MAX_REVIEW_CHARS],
                "gaps": [str(g)[:300] for g in (gaps or [])][:20],
                # The same counter every model/parameter/method edit bumps — comparing it later is what
                # turns "is this review stale?" into arithmetic (the fingerprint idea from the report).
                "generation": generation,
                "resolutions": [],
            }
            stored.append(entry)
            data[database] = stored[-MAX_REVIEWS:]
            self._save(data)
            return {"id": entry["id"], "created": entry["created"]}

    def record_resolutions(self, database: str, items: list, review_id: str | None = None) -> dict:
        """Attach the builder's per-finding outcomes to a review (default: the latest one).

        A finding recorded twice keeps the later statement — the builder may fix something it first
        marked open, and the log should read like the final state, not like a diff.
        """
        with self._lock:
            cleaned = clean_resolutions(items)
            if not cleaned:
                return {"error": "no usable resolutions — each needs at least a finding text"}
            data = self._load()
            stored = list(data.get(database) or [])
            if not stored:
                return {"error": "no review on record for this model — run review_model first"}
            entry = None
            if review_id:
                entry = next((r for r in stored if r.get("id") == review_id), None)
                if entry is None:
                    return {"error": f"no review with id {review_id!r} — omit review_id for the latest"}
            else:
                entry = stored[-1]
            merged = {r["finding"]: r for r in entry.get("resolutions") or []}
            for item in cleaned:
                merged[item["finding"]] = item
            entry["resolutions"] = list(merged.values())[:MAX_RESOLUTIONS]
            data[database] = stored
            self._save(data)
            counts = {k: sum(1 for r in entry["resolutions"] if r["resolution"] == k) for k in RESOLUTIONS}
            return {"id": entry["id"], "recorded": len(entry["resolutions"]), **counts}

    def for_report(self, database: str, current_generation: int | None = None) -> dict | None:
        """The compact shape a report snapshot carries: dates, staleness, and the builder's verdicts.

        Deliberately without the review prose: the full text describes the model as it stood mid-build
        (findings that were fixed minutes later included), and handing that to a chapter writer is the
        stale-prose trap the placeholder architecture exists to avoid. What a document may state is
        the structured outcome — and that the review happened.
        """
        entry = self.latest(database)
        if entry is None:
            return None
        resolutions = entry.get("resolutions") or []
        generation = entry.get("generation")
        return {
            "created": entry.get("created") or "",
            #: True when the model was edited after the review — a report must not imply the review
            #: covers the current state. None when the generation was never recorded.
            "stale": (
                None
                if generation is None or current_generation is None
                else generation != current_generation
            ),
            "open": [r for r in resolutions if r.get("resolution") == "open"],
            "rejected": [r for r in resolutions if r.get("resolution") == "rejected"],
            "fixed": sum(1 for r in resolutions if r.get("resolution") == "fixed"),
            "resolutions_recorded": bool(resolutions),
            "reviews": len(self.list(database)),
        }

    def replace(self, database: str, reviews: list) -> None:
        """Restore a bundle's log verbatim."""
        with self._lock:
            data = self._load()
            kept = [r for r in reviews or [] if isinstance(r, dict) and r.get("review")]
            if kept:
                data[database] = kept[-MAX_REVIEWS:]
                self._save(data)

    def rename_database(self, old: str, new: str) -> None:
        with self._lock:
            data = self._load()
            if old in data:
                data[new] = data.pop(old)
                self._save(data)

    def remove_database(self, database: str) -> None:
        with self._lock:
            data = self._load()
            if database in data:
                del data[database]
                self._save(data)
