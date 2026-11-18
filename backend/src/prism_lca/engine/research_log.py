"""Web-research provenance, per model.

What the research tools found — the questions asked and the sourced findings that came back.
The full research answers live in the run's context and used to die with it: whatever did not fit
into a process comment was gone, and the report's bibliography could list only URLs that happened
to survive inside a comment (``_cited_sources``). Measured on the 2026-08-13 apple-sauce run: a
42,000-character research answer with two primary sources existed nowhere on disk an hour later.
This log keeps the provenance itself, so the References chapter can print what the study
*researched* — not just what a comment cites — and a chapter writer can say in words where a
figure came from.

It also keeps what the research could NOT settle. A bill-of-materials call writes its check — which
requested parts came back without a mass, the whole-product masses found, the versions the figures
rest on — even when it found no mass at all: the reviewer compares a booked figure against that, and
a check that left the frame open is as much a fact about the study as a mass that was found.

Stored as one JSON file in the active project's ``prism_meta`` dir, keyed by foreground database —
the same pattern as chats and scenarios. Recording is idempotent per (question, finding text), so
a re-run of the same research does not double the list; a bill-of-materials check is the exception
and is appended every time, dated, because the log is a history of what was asked and found, not a
current state of knowledge. Not undoable on purpose: this is a log of what was looked up, like the
chat itself, not a piece of the model.
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

#: What the research was given besides the question — product, version, market, a given total mass.
#: The same question asked in two chats can mean two versions of a product; this tells them apart.
CONTEXT_CHARS = 300
#: How a bill-of-materials figure was derived (area × thickness × density), as the research leg wrote it.
NOTE_CHARS = 240
#: The note beside a part the check left open — what the leg did find instead.
OPEN_NOTE_CHARS = 200

#: The bill-of-materials check's closed vocabularies, as research_bom reports them.
REQUEST_STATUSES = {"with_mass", "partial", "no_mass", "product_mass_only", "failed"}
OPEN_REASONS = {"no_mass", "zero_mass", "unclear_mass", "whole_product_only", "failed"}
MASS_BASES = {"net", "gross", "unknown"}
#: Whole-product masses kept per check, and other versions of the product the sources showed.
MAX_TOTALS = 6
MAX_VERSIONS_SEEN = 3
#: Requested parts / open parts / version groups per check — research_bom asks for at most eight.
MAX_CHECK_ROWS = 12


def _cut(value: object, limit: int) -> str:
    """Text bounded with a visible mark: a reader must see that and where a note was cut."""
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _mass(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return float(value)
    return None


def clean_bom_check(raw: object) -> dict | None:
    """Normalise what a bill-of-materials call reported about its own result, or ``None``.

    ``summary`` (the one sentence: what was summed, against which total, what is open), ``requests``
    (each requested component's status), ``unresolved`` (each open part with its reason), ``totals``
    (every whole-product mass found, with its scope, version and source) and ``versions`` (whether
    the figures rest on different versions, which entries sit on which, a few other versions seen).
    None of it is a finding: the health check never reads it, so a whole-product mass here can never
    be reported as a part nobody booked.
    """
    if not isinstance(raw, dict):
        return None
    check: dict = {}
    summary = _cut(raw.get("summary"), 600)
    if summary:
        check["summary"] = summary
    requests = []
    for r in raw.get("requests") or []:
        if isinstance(r, dict) and str(r.get("component") or "").strip() and r.get("status") in REQUEST_STATUSES:
            requests.append({"component": _cut(r["component"], 120), "status": r["status"]})
    if requests:
        check["requests"] = requests[:MAX_CHECK_ROWS]
    open_parts = []
    for u in raw.get("unresolved") or []:
        if not (isinstance(u, dict) and str(u.get("component") or "").strip() and u.get("reason") in OPEN_REASONS):
            continue
        part = {"component": _cut(u["component"], 120), "reason": u["reason"]}
        note = _cut(u.get("note"), OPEN_NOTE_CHARS)
        if note:
            part["note"] = note
        open_parts.append(part)
    if open_parts:
        check["unresolved"] = open_parts[:MAX_CHECK_ROWS]
    totals = []
    for t in raw.get("totals") or []:
        mass = _mass(t.get("mass_kg")) if isinstance(t, dict) else None
        if mass is None:
            continue
        total: dict = {"mass_kg": mass, "basis": t.get("basis") if t.get("basis") in MASS_BASES else "unknown"}
        for key, limit in (("version", 120), ("source", 300)):
            value = _cut(t.get(key), limit)
            if value:
                total[key] = value
        totals.append(total)
    if totals:
        check["totals"] = totals[:MAX_TOTALS]
    versions = _clean_versions(raw.get("versions"))
    if versions:
        check["versions"] = versions
    return check or None


def _clean_versions(raw: object) -> dict | None:
    """Whether the check's figures rest on different versions of the product, which entries sit on
    which (``used``), and a few other versions the sources showed (``seen``)."""
    if not isinstance(raw, dict):
        return None
    kept: dict = {"conflict": raw.get("conflict") is True}
    used = []
    for u in raw.get("used") or []:
        if not (isinstance(u, dict) and str(u.get("version") or "").strip()):
            continue
        entries = [_cut(e, 120) for e in (u.get("entries") or []) if str(e or "").strip()]
        used.append({"version": _cut(u["version"], 120), "entries": entries[:MAX_CHECK_ROWS]})
    if used:
        kept["used"] = used[:MAX_CHECK_ROWS]
    seen = []
    for v in raw.get("seen") or []:
        if not (isinstance(v, dict) and str(v.get("version") or "").strip()):
            continue
        other: dict = {"version": _cut(v["version"], 120)}
        for key, limit in (("differs_by", 160), ("sold_by", 80), ("source", 300)):
            value = _cut(v.get(key), limit)
            if value:
                other[key] = value
        mass = _mass(v.get("mass_kg"))
        if mass is not None:
            other["mass_kg"] = mass
        seen.append(other)
    if seen:
        kept["seen"] = seen[:MAX_VERSIONS_SEEN]
    return kept if kept["conflict"] or used or seen else None


def clean_entry(item: object) -> dict | None:
    """Normalise one research entry into ``{question, findings: [{text, sources}], asked}``.

    A finding may additionally carry the leg's judgement (``source_class``, ``confidence``,
    ``confidence_note``), whether its source came back from the search engine (``cited_by_search``)
    and — for bill-of-materials research — the structured figure itself (``component``, ``mass_kg``,
    and ``mass_range_kg`` when the sources gave a span rather than one number) with its derivation
    (``note``) and the product version it belongs to (``version``), which is what lets the health check reconcile researched masses against what the
    model actually books. The entry may carry the ``context`` the research was given and, for a
    bill-of-materials call, its ``bom_check`` — with a valid check an entry without findings is kept:
    a call that found no mass at all still says what it could not settle. All optional, all
    validated, none invented here.
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
        derivation = _cut(raw.get("note"), NOTE_CHARS)
        if derivation:
            finding["note"] = derivation
        # Which version of the product a bill-of-materials figure belongs to (an EAN, a board thickness).
        version = _cut(raw.get("version"), 120)
        if version:
            finding["version"] = version
        if isinstance(raw.get("cited_by_search"), bool):
            finding["cited_by_search"] = raw["cited_by_search"]
        findings.append(finding)
        if len(findings) >= MAX_FINDINGS:
            break
    check = clean_bom_check(item.get("bom_check"))
    if not findings and check is None:
        return None
    entry: dict = {"question": question[:300], "findings": findings, "asked": now_z()}
    context = _cut(item.get("context"), CONTEXT_CHARS)
    if context:
        entry["context"] = context
    if check is not None:
        entry["bom_check"] = check
    return entry


def _restore_evicted(kept: list[dict], repeated: list[tuple[dict, list[dict]]]) -> None:
    """Give a new entry back the repeated findings whose first record the trim just evicted.

    A repeat is stored once, in the entry that first found it. Once the log is full, the entry a repeat
    appends pushes the oldest out — possibly the one holding the finding the repeat confirmed — and the
    log would then hold neither copy.
    """
    present = {(e.get("question"), f.get("text")) for e in kept for f in e.get("findings") or []}
    for entry, dropped in repeated:
        if not any(e is entry for e in kept):
            continue
        back = [f for f in dropped if (entry["question"], f["text"]) not in present]
        if back:
            entry["findings"] = (back + entry["findings"])[:MAX_FINDINGS]
            present.update((entry["question"], f["text"]) for f in back)


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
        """Append what is new, skip what is already there; returns ``{added, total}``.

        An entry with a bill-of-materials check is appended every time, with only its new findings:
        the check is that call's own result, and a repeat that found the same masses may still have
        settled a part or met another version.
        """
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
            repeated: list[tuple[dict, list[dict]]] = []
            for raw in entries or []:
                entry = clean_entry(raw)
                if entry is None:
                    continue
                fresh = [f for f in entry["findings"] if (entry["question"], f["text"]) not in seen]
                if not fresh and "bom_check" not in entry:
                    continue
                repeated.append((entry, [f for f in entry["findings"] if f not in fresh]))
                entry["findings"] = fresh
                for f in fresh:
                    seen.add((entry["question"], f["text"]))
                stored.append(entry)
                added += 1
            if added:
                kept = stored[-MAX_ENTRIES:]
                _restore_evicted(kept, repeated)
                data[database] = kept
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

    def snapshot_database(self, database: str) -> list[dict]:
        return self.list(database)

    def restore_database(self, database: str, entries: list[dict]) -> None:
        """As stored, not through `replace`: that re-cleans what came from a bundle."""
        with self._lock:
            data = self._load()
            data.pop(database, None)
            if entries:
                data[database] = entries
            self._save(data)
