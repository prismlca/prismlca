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

import re
import uuid

from prism_lca.engine._store import JsonFileStore, now_z

#: Reviews kept per model — enough for a build with re-reviews after structural changes.
MAX_REVIEWS = 10
#: The review text is evidence, not snapshot material; capped so ten of them stay a small file.
MAX_REVIEW_CHARS = 12_000
MAX_RESOLUTIONS = 40

RESOLUTIONS = ("fixed", "rejected", "open")

#: This backend process. The generation counter starts again at every start and counts the edits of
#: every model, so a stored generation says something about the current state only while the same
#: process runs — `history` compares it only then.
_SESSION = uuid.uuid4().hex[:12]


#: A finding's tag where the reviewer starts the finding — "[F3]" at the beginning of a line, after any
#: bullet, number, heading or bold markup. A tag further into a line is a reference, not a finding.
_FINDING_TAG = re.compile(r"^\s*(?:#{1,6}\s*)?(?:[-*+]\s+|\d{1,3}[.)]\s+)?(?:\*\*|__)?\s*\[F(\d{1,3})\]\s*(.*)$")
#: The id a resolution names: "F3", "[F3]", "f3" or a bare "3".
_RESOLUTION_ID = re.compile(r"^\s*\[?\s*F?\s*(\d{1,3})\s*\]?\s*$", re.IGNORECASE)
#: The same id written at the start of the finding text instead ("F3: zinc coating …").
_LEADING_ID = re.compile(r"^\s*\[?F(\d{1,3})\]?(?=[\s:.)\-\u2013\u2014])", re.IGNORECASE)


def _plain(line: str) -> str:
    """A line of review Markdown as plain text: no emphasis markers, no leading punctuation."""
    text = re.sub(r"\*\*|__", "", line)
    return re.sub(r"\s+", " ", text).strip().lstrip(":.-\u2013\u2014 ").strip()


def tagged_findings(review: str) -> list[dict]:
    """The findings a review tagged ``[F1]``, ``[F2]`` …, in order, each with the start of its text.

    The reviewer is asked to tag every finding; a review that did not (an older one, or a reviewer that
    ignored the rule) yields an empty list, and then nobody can say which findings still lack an outcome.
    """
    out: list[dict] = []
    seen: set[str] = set()
    lines = str(review or "").splitlines()
    for i, line in enumerate(lines):
        m = _FINDING_TAG.match(line)
        if not m:
            continue
        fid = f"F{int(m.group(1))}"
        if fid in seen:
            continue
        seen.add(fid)
        # A tag alone on its line (a heading "**[F2]**"): the finding's words are on the next one.
        text = _plain(m.group(2)) or next((_plain(nxt) for nxt in lines[i + 1 : i + 3] if _plain(nxt)), "")
        out.append({"id": fid, "finding": text[:200]})
    return out


def _resolution_id(item: dict, finding: str) -> str | None:
    """The finding id a resolution names — in ``id``, or at the start of its finding text."""
    m = _RESOLUTION_ID.match(str(item.get("id") or "")) or _LEADING_ID.match(finding)
    return f"F{int(m.group(1))}" if m else None


def clean_resolutions(items: object) -> list[dict]:
    """Normalise ``[{id, finding, resolution, reason}]``; unknown resolutions become ``open``."""
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
        fid = _resolution_id(item, finding)
        if fid:
            entry["id"] = fid
        reason = str(item.get("reason") or "").strip()
        if reason:
            entry["reason"] = reason[:600]
        out.append(entry)
    return out


def _same_words(a: str, b: str) -> bool:
    return " ".join(a.casefold().split()) == " ".join(b.casefold().split())


def _merge_resolutions(stored: list[dict], incoming: list[dict]) -> list[dict]:
    """The later statement about a finding replaces the earlier one, in place.

    The same finding is the same id; or, where one of the two carries no id, the same words. Two
    entries with different ids are never merged, whatever they say: "see above" may answer two
    findings. Without the second rule, an outcome first recorded without an id and then again with
    one — what the answer asks for — stayed in the log twice, and the report printed the stale one.
    """
    out = [dict(r) for r in stored]
    for item in incoming:
        fid = item.get("id")
        hits = [
            i for i, r in enumerate(out)
            if (fid and r.get("id") == fid)
            or ((not fid or not r.get("id")) and _same_words(r["finding"], item["finding"]))
        ]
        if not hits:
            out.append(item)
            continue
        kept = out[hits[0]].get("id")
        out[hits[0]] = {**item, "id": fid or kept} if (fid or kept) else item
        for i in reversed(hits[1:]):
            del out[i]
    return out


def _without_id(resolution: dict) -> dict:
    return {k: v for k, v in resolution.items() if k != "id"}


def _coverage(review: str, resolutions: list[dict]) -> dict:
    """Which of the review's tagged findings have no outcome yet, for the answer to a resolutions call."""
    findings = tagged_findings(review)
    if not findings:
        return {"tagged": False}
    known = {f["id"] for f in findings}
    named = {r["id"] for r in resolutions if r.get("id")}
    out: dict = {
        "findings": len(findings),
        "no_outcome_yet": [f for f in findings if f["id"] not in named],
    }
    # Outcomes the ids cannot place: they may answer a finding listed above, or nothing at all.
    without = sum(1 for r in resolutions if not r.get("id"))
    if without:
        out["without_id"] = without
    unknown = sorted(named - known, key=lambda x: int(x[1:]))
    if unknown:
        out["unknown_ids"] = unknown
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

    def history(self, database: str, current_generation: int | None = None) -> list[dict]:
        """The reviews, each with ``stale``: whether anything was edited after it — in this model or
        another, the counter is shared — or None when that cannot be said (another backend session,
        no generation recorded)."""
        return [
            {
                **r,
                "stale": (
                    None
                    if r.get("generation") is None
                    or current_generation is None
                    or r.get("session") != _SESSION
                    else r.get("generation") != current_generation
                ),
            }
            for r in self.list(database)
        ]

    def latest(self, database: str) -> dict | None:
        reviews = self.list(database)
        return reviews[-1] if reviews else None

    def record_review(
        self,
        database: str,
        review: str,
        gaps: list | None = None,
        generation: int | None = None,
        chat: str | None = None,
        partial: bool = False,
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
            # The chat that ran it: a later review in the same chat is shown this one's findings and
            # outcomes, a review in another chat is not — that chat never saw the reasons.
            if chat and str(chat).strip():
                entry["chat"] = str(chat).strip()[:64]
            entry["session"] = _SESSION
            # Cut off at the reviewer's deadline: findings it had not reached are missing.
            if partial:
                entry["partial"] = True
            stored.append(entry)
            data[database] = stored[-MAX_REVIEWS:]
            self._save(data)
            return {"id": entry["id"], "created": entry["created"]}

    def record_resolutions(self, database: str, items: list, review_id: str | None = None) -> dict:
        """Attach the builder's per-finding outcomes to a review (default: the latest one).

        A finding recorded twice — the same id, or without one the same text — keeps the later statement:
        the builder may fix something it first marked open, and the log should read like the final state,
        not like a diff.

        The answer says which of the review's tagged findings still have no outcome. Counts alone could not:
        eleven findings, eight outcomes and "nothing open" read the same as eleven of eleven, and the
        builder cannot read the log back to tell.
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
            entry["resolutions"] = _merge_resolutions(entry.get("resolutions") or [], cleaned)[:MAX_RESOLUTIONS]
            data[database] = stored
            self._save(data)
            resolutions = entry["resolutions"]
            counts = {k: sum(1 for r in resolutions if r["resolution"] == k) for k in RESOLUTIONS}
            return {"id": entry["id"], "recorded": len(resolutions), **counts,
                    **_coverage(entry.get("review") or "", resolutions)}

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
            # Without the finding ids: they number one review's findings and mean nothing in a document,
            # and a stored report compares this shape to tell whether the review moved since.
            "open": [_without_id(r) for r in resolutions if r.get("resolution") == "open"],
            "rejected": [_without_id(r) for r in resolutions if r.get("resolution") == "rejected"],
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

    def snapshot_database(self, database: str) -> list[dict]:
        return self.list(database)

    def restore_database(self, database: str, reviews: list[dict]) -> None:
        """As stored, not through `replace`: that re-cleans what came from a bundle."""
        with self._lock:
            data = self._load()
            data.pop(database, None)
            if reviews:
                data[database] = reviews
            self._save(data)
