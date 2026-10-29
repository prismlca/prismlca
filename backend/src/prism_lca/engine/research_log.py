"""Web-research provenance, per model.

What the research tools found — the questions asked and the sourced findings that came back.
The full research answers live in the run's context and used to die with it: whatever did not fit
into a process comment was gone, and the report's bibliography could list only URLs that happened
to survive inside a comment (``_cited_sources``). Measured on the 2026-08-13 apple-sauce run: a
42,000-character research answer with two primary sources existed nowhere on disk an hour later.
This log keeps the provenance itself, so the References chapter can print what the study
*researched* — not just what a comment cites — and a chapter writer can say in words where a
figure came from.

Stored as one JSON file in the active project's ``prism_meta`` dir, keyed by foreground database —
the same pattern as chats and scenarios. Recording is idempotent per (question, finding text), so
a re-run of the same research does not double the list. Not undoable on purpose: this is a log of
what was looked up, like the chat itself, not a piece of the model.
"""
from __future__ import annotations

from prism_lca.engine._store import JsonFileStore, now_z

#: Entries per model. Beyond this the oldest go first — a model researched in waves keeps the
#: recent evidence, and 80 questions is far past anything a study legitimately needs.
MAX_ENTRIES = 80
#: Findings per entry / sources per finding. The tools already condense; these only stop abuse.
MAX_FINDINGS = 20
MAX_SOURCES = 5


#: The research legs' closed judgement vocabularies. Everything else is dropped, not stored: a
#: free-text class would be indistinguishable from a checked one, and "when unsure pick the lower"
#: only works over a closed set.
SOURCE_CLASSES = {"official", "industry", "media", "community"}
CONFIDENCES = {"high", "medium", "low"}


def clean_entry(item: object) -> dict | None:
    """Normalise one research entry into ``{question, findings: [{text, sources}], asked}``.

    A finding may additionally carry the leg's judgement (``source_class``, ``confidence``,
    ``confidence_note``) and — for bill-of-materials research — the structured figure itself
    (``component``, ``mass_kg``, and ``mass_range_kg`` when the sources gave a span rather than one
    number), which is what lets the health check reconcile researched masses against what the model
    actually books. All optional, all validated, none invented here.
    """
    if not isinstance(item, dict):
        return None
    question = str(item.get("question") or "").strip()
    if not question:
        return None
    findings: list[dict] = []
    for raw in (item.get("findings") or [])[: MAX_FINDINGS * 2]:
        if isinstance(raw, str):
            raw = {"text": raw}
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        sources = [str(s).strip()[:300] for s in (raw.get("sources") or []) if str(s).strip()]
        finding: dict = {"text": text[:400], "sources": sources[:MAX_SOURCES]}
        klass = str(raw.get("source_class") or "").strip().lower()
        if klass in SOURCE_CLASSES:
            finding["source_class"] = klass
        conf = str(raw.get("confidence") or "").strip().lower()
        if conf in CONFIDENCES:
            finding["confidence"] = conf
        note = str(raw.get("confidence_note") or "").strip()
        if note:
            finding["confidence_note"] = note[:160]
        # The search engine's excerpt of the cited page (Exa highlights), when the leg's provider
        # supplied one: the row a figure was read from, kept beside it. Text only, bounded.
        excerpt = str(raw.get("excerpt") or "").strip()
        if excerpt:
            finding["excerpt"] = excerpt[:400]
        component = str(raw.get("component") or "").strip()
        if component:
            finding["component"] = component[:120]
        mass = raw.get("mass_kg")
        if isinstance(mass, (int, float)) and not isinstance(mass, bool) and mass > 0:
            finding["mass_kg"] = float(mass)
        # Same stance as the vocabularies: a range is stored validated or not at all — it must be a
        # real [min, max] with room in it, or downstream scenario spreads would build on nonsense.
        rng = raw.get("mass_range_kg")
        if (
            isinstance(rng, (list, tuple))
            and len(rng) == 2
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in rng)
            and 0 < float(rng[0]) < float(rng[1])
        ):
            finding["mass_range_kg"] = [float(rng[0]), float(rng[1])]
        findings.append(finding)
        if len(findings) >= MAX_FINDINGS:
            break
    if not findings:
        return None
    return {"question": question[:300], "findings": findings, "asked": now_z()}


class ResearchLogStore(JsonFileStore):
    FILENAME = "research_log.json"
    # A log: a half-written file from a hard kill must not stop the app — entries can be re-recorded.
    ON_ERROR = "empty_io"

    def _load(self) -> dict[str, list[dict]]:
        data = super()._load()
        return data if isinstance(data, dict) else {}

    def list(self, database: str) -> list[dict]:
        return list(self._load().get(database) or [])

    def record(self, database: str, entries: list) -> dict:
        """Append what is new, skip what is already there; returns ``{added, total}``."""
        with self._lock:
            data = self._load()
            stored = list(data.get(database) or [])
            # Dedup key is (question, finding text): the same question asked again with a NEW finding
            # is worth keeping; the same finding twice is not.
            seen = {
                (e.get("question"), f.get("text"))
                for e in stored
                for f in e.get("findings") or []
            }
            added = 0
            for raw in entries or []:
                entry = clean_entry(raw)
                if entry is None:
                    continue
                fresh = [f for f in entry["findings"] if (entry["question"], f["text"]) not in seen]
                if not fresh:
                    continue
                entry["findings"] = fresh
                for f in fresh:
                    seen.add((entry["question"], f["text"]))
                stored.append(entry)
                added += 1
            if added:
                data[database] = stored[-MAX_ENTRIES:]
                self._save(data)
            return {"added": added, "total": len(data.get(database) or stored)}

    def replace(self, database: str, entries: list) -> None:
        """Restore a bundle's log verbatim (already normalised on the way out)."""
        with self._lock:
            data = self._load()
            cleaned = []
            for raw in entries or []:
                entry = clean_entry(raw)
                if entry:
                    # When it was asked, not when the bundle was imported: `clean_entry` stamps now.
                    asked = raw.get("asked") if isinstance(raw, dict) else None
                    if isinstance(asked, str) and asked.strip():
                        entry["asked"] = asked.strip()[:40]
                    cleaned.append(entry)
            if cleaned:
                data[database] = cleaned[-MAX_ENTRIES:]
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
