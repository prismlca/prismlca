"""ISO 14040/44 study metadata (goal & scope, functional unit, boundaries, …).

Keyed **per foreground database** (= per model/study), not per project: one background project
(a given ecoinvent version) holds many models, each with its own study metadata. Stored under
``prism_meta/studies/<readable>~<hash>.json`` in the project directory — see `study_file_name`.
"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from pathlib import Path

from prism_lca.engine._store import JsonFileStore, prism_meta_dir, read_json, write_json_atomic

FIELDS = (
    #: The language the study is DOCUMENTED in — process notes, scenario names, these fields
    #: themselves. Set once at the start (default "en"); the assistant is instructed to write all
    #: study documentation in it, and a report whose language differs knows it has to translate
    #: rather than guessing from the characters.
    "language",
    "goal",
    "scope",
    "functional_unit",
    #: Where the product is made and where it is sold or used — the market the datasets have to match
    #: (ISO 14044 §4.2.3.6, geographical coverage). A field of its own rather than a sentence in the
    #: scope, because nothing else says it: left unstated, an assistant took the market from the
    #: language of the conversation and modelled a German study's product for Germany.
    "geography",
    #: The year (or period) the data should represent — ISO 14044 §4.2.3.6, time-related coverage.
    "reference_year",
    "system_boundaries",
    "cutoff_criteria",
    #: How a **multi-output process** is split between its products (mass, economic, energy). Kept under
    #: the old key so existing studies keep their text; only the label says "process allocation" now.
    "allocation",
    #: How **end-of-life** burdens and credits are handled across the system — cut-off, avoided burden,
    #: 50/50, circular footprint formula. A different decision from the one above, and the one a critical
    #: review asks about most often; conflating them under one word hid it.
    "system_allocation",
    "author",
    #: The organisation carrying out the study — printed on the cover next to the author. Distinct from
    #: `commissioner`, who it was carried out for.
    "organisation",
    "commissioner",
    "date",
    #: Who reviewed the study and when, in the author's words — a description, not the answer.
    "critical_review",
    #: Whether a critical review was carried out at all: "yes" or "no". The structured half of the
    #: record above, and the only thing the report reads when it decides whether ISO 14044 §7.3.3
    #: applies (see `report_checks.critical_review_recorded`).
    #:
    #: It exists because the prose could not answer the question (V191). The honest content of the
    #: field is usually a *negation* — "Keine kritische Prüfung (interne Screening-Studie)" — so
    #: reading "field not empty" as "there was a review" silenced the §7.3.3 note exactly where it was
    #: required. Of every study on record here, not one filled the field affirmatively; the text had
    #: only ever switched the note off falsely, including one that spelled out that §7.3.3 *would*
    #: require a review.
    #:
    #: Only the literal "yes" counts as confirmation. Unset, "no" and anything unrecognised all mean
    #: "not confirmed", so a study that never answers keeps its note — a report carrying it needlessly
    #: is an annoyance, one missing it claims a conformity it does not have.
    "critical_review_done",
    "notes",
    #: What the modeller could not resolve — the judgements that belong to the *study* rather than to
    #: any one process. A list of ``{text, kind, subject}``; see ``LIMITATION_KINDS`` and
    #: ``clean_limitations``. This is the channel from whoever builds the model to whoever writes the
    #: report: a proxy's reasoning fits in the process comment and reaches the inventory chapter, but
    #: "the whole result rests on how much of a shower belongs to one hair wash" fits nowhere and was
    #: therefore lost. The report prints them in its Limitations chapter, beside the four it can check
    #: for itself, and every chapter's brief carries them as context.
    "limitations",
    #: Which LLM last filled study fields, recorded automatically when the assistant writes them
    #: (V128) — provenance a reader checks under Model info, never typed by hand.
    #: One value, not a history: the audit log already has the full sequence.
    "ai_model",
)

#: The answers `critical_review_done` accepts — a closed choice, so the question cannot be answered by
#: accident. Anything else is refused at the API instead of being stored as a third, unread meaning.
CRITICAL_REVIEW_ANSWERS = ("yes", "no")

#: What a recorded limitation *is*, so a report can sort them and a reader knows what they are looking
#: at. Deliberately few: a taxonomy nobody can keep apart is filled in at random.
LIMITATION_KINDS = ("limitation", "assumption", "exclusion", "data_gap")


def clean_limitations(value: object) -> list[dict]:
    """Normalise what a caller sent into ``[{text, kind, subject}]``, dropping what is not usable.

    Accepts a plain list of strings too — the shape an assistant reaches for first — because refusing
    it would only teach it to stop recording them. Unknown keys are dropped rather than trusted: this
    ends up in a client's document.
    """
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[dict] = []
    for item in value[:50]:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        kind = str(item.get("kind") or "limitation").strip().lower()
        entry = {"text": text[:2000], "kind": kind if kind in LIMITATION_KINDS else "limitation"}
        subject = str(item.get("subject") or "").strip()
        if subject:
            entry["subject"] = subject[:200]
        # The same statement twice prints twice (V408c): an assistant that appends its limitations in two
        # turns sends the earlier ones again, and the limitations chapter showed the customer-trip
        # paragraph two paragraphs apart. One statement is one entry — compared on its text.
        if any(e["text"] == entry["text"] for e in out):
            continue
        out.append(entry)
    return out

#: The fields ISO 14044 §5.2 expects a report to state, with the words a reader knows them by.
#: The report's scope panel lists the empty ones before a chapter is written from them
#: (`ReportSections.tsx`, REPORTABLE_SCOPE — same list, same order), and the model-health linter
#: names them too, because that is the one report the assistant reads by itself.
REPORTABLE: tuple[tuple[str, str], ...] = (
    ("functional_unit", "functional unit"),
    ("geography", "geography"),
    ("reference_year", "reference year"),
    ("system_boundaries", "system boundaries"),
    ("cutoff_criteria", "cut-off criteria"),
    ("allocation", "process allocation"),
    ("system_allocation", "system allocation (end of life)"),
    ("critical_review", "critical review"),
)


def unrecorded_scope(study: dict) -> list[tuple[str, str]]:
    """The REPORTABLE fields this study leaves unanswered, as the health check reads them.

    The report panel applies the same rule in the renderer (`unrecordedScope` in `lib/report/model.ts`).

    A field counts once it has text. The critical review also counts once its yes/no is answered: "no
    review" is a complete answer the report prints as such, and authors give it in the closed choice
    rather than in a sentence. Reading only the description kept the notice up after they had answered.
    """
    out = []
    for key, label in REPORTABLE:
        if str(study.get(key) or "").strip():
            continue
        answer = str(study.get("critical_review_done") or "")
        if key == "critical_review" and answer in CRITICAL_REVIEW_ANSWERS:
            continue
        out.append((key, label))
    return out


#: Words whose final dot belongs to the word, not to a sentence — so a functional unit ending in one
#: keeps it. Short, because the cost of missing one is a stray dot and the cost of over-matching is a
#: sentence that ends without a stop.
_ABBREVIATED = frozenset({"etc", "approx", "incl", "excl", "max", "min", "ca", "resp", "vs", "cf"})


#: The five XML/HTML entities, and nothing else. A study field is prose, not markup: the report, the
#: PDF and the exported XML all escape for themselves on the way out, so an entity arriving here can
#: only be a mistake — and it survives every stage as literal text. A solar-lamp run had
#: an assistant write `cut-off: wires and screws (&lt;1 g per lamp)` into the system boundaries; it was
#: stored, and would have printed, exactly like that. Deliberately not a general HTML unescape: a
#: numeric entity in a study text is far more likely to be someone's chemical notation than markup.
_ENTITIES = (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&amp;", "&"))

#: JSON escapes that survived one encoding too many. A model writing its tool call as text produced
#: `½\"` in a functional unit (V416): the backslash reached the study file, the renderer
#: dutifully escaped it, and the PDF printed `½\„`. Nobody means a backslash before a quote in prose.
_STRAY_ESCAPES = (('\\"', '"'), ("\\'", "'"), ("\\\\", "\\"))


def _unescape(value):
    """Turn the five standard entities back into the characters the author meant, at any depth."""
    if isinstance(value, str):
        for entity, char in _ENTITIES:
            value = value.replace(entity, char)
        for escaped, char in _STRAY_ESCAPES:
            value = value.replace(escaped, char)
        return value
    if isinstance(value, list):
        return [_unescape(v) for v in value]
    if isinstance(value, dict):
        return {k: _unescape(v) for k, v in value.items()}
    return value


#: Names of the models this one is compared with (symmetric, see `StudyMetaStore.link`). Stored in
#: the study file beside the ISO fields, but not one of `FIELDS`: only `link`/`unlink` write it.
COMPARED_WITH = "compared_with"


class StudyMetaStore(JsonFileStore):
    # One file per model rather than one for the store — so _path/_load/_save take the database.
    # The base still supplies the shared serialisation, the read policy and the class lock.
    def _path(self, database: str) -> Path:  # type: ignore[override]
        return prism_meta_dir() / "studies" / study_file_name(database)

    def get(self, database: str) -> dict:
        path = self._path(database)
        if not path.exists() and (path.parent / f"{_safe(database)}.json").exists():
            # A legacy file still there means a migration did not finish (it is retried per file):
            # catch it up before answering, rather than reading an empty study. Under the store lock
            # (re-entrant), like every write here.
            with self._lock:
                if not path.exists():
                    migrate_active_workspace()
        return read_json(path, default={})

    def _save(self, database: str, data: dict) -> None:  # type: ignore[override]
        write_json_atomic(self._path(database), data)

    def snapshot(self, database: str) -> dict:
        return dict(self.get(database))

    def for_report(self, database: str) -> dict:
        """The metadata as a document should carry it: the functional unit without its own full stop.

        A functional unit is a noun phrase that gets *placed inside* sentences — "for the functional
        unit of {{study.functional_unit}}." in the prose, and "functional unit: {fu}." in the results
        lead-in, which supplies the stop itself. Authors and assistants alike write it as a sentence,
        so the first real report printed "…and packaging end-of-life.. Under this scope" on its
        opening page and again on page ten. Stripped here rather than on the way in: the author's
        wording stays exactly as typed in the Goal & scope form, and the document decides how to set
        it. Only a sentence's full stop goes: a unit ending in an abbreviation ("etc.", "e.g.",
        "approx.") keeps its dot, because there the dot belongs to the word rather than to a sentence.
        """
        data = dict(self.get(database))
        unit = str(data.get("functional_unit") or "").rstrip()
        if unit.endswith(".") and not unit.endswith(".."):
            last = unit[:-1].rsplit(" ", 1)[-1]
            if "." not in last and last.lower() not in _ABBREVIATED:
                data["functional_unit"] = unit[:-1].rstrip()
        return data

    def update(self, database: str, fields: dict) -> dict:
        with self._lock:
            data = self.get(database)
            clean = {k: v for k, v in fields.items() if k in FIELDS and v is not None}
            if "limitations" in clean:
                clean["limitations"] = clean_limitations(clean["limitations"])
            clean = {k: _unescape(v) for k, v in clean.items()}
            data.update(clean)
            self._save(database, data)
            return data

    def replace(self, database: str, data: dict) -> None:
        # Under the store lock like `update`: an undo or import writing here must not interleave with a
        # migration that has just checked this file is absent.
        with self._lock:
            self._save(database, dict(data))

    # --- comparison models ---------------------------------------------------------------------
    # "B is compared with A" is a property of the study, not of a chat: every chat on B shows A's
    # brief by default, the Info dialog lists it, and the Results page can pre-select it later. The
    # relation is SYMMETRIC: linking A to B writes both files, so A's assistant sees
    # B as well and can notice an asymmetry itself. Pairwise, not transitive — A~B and A~C do not make
    # B and C comparison models of each other.
    #
    # Deliberately NOT in `FIELDS`: `update()` — the path behind the study form and the assistant's
    # `model_info` tool — must not be able to write one side of a symmetric relation.

    def compared_with(self, database: str) -> list[str]:
        raw = self.get(database).get(COMPARED_WITH)
        return [str(n) for n in raw if isinstance(n, str) and n.strip()] if isinstance(raw, list) else []

    def link(self, database: str, other: str) -> None:
        """Make the two models comparison models of each other. Idempotent; a model cannot link itself."""
        if not other or other == database:
            from prism_lca.errors import PrismError

            raise PrismError(
                "A model cannot be its own comparison model.",
                code="comparison_self",
                hint="Pick another model of this workspace.",
            )
        with self._lock:
            for a, b in ((database, other), (other, database)):
                data = self.get(a)
                names = [n for n in data.get(COMPARED_WITH) or [] if isinstance(n, str)]
                if b not in names:
                    names.append(b)
                    data[COMPARED_WITH] = names
                    self._save(a, data)

    def unlink(self, database: str, other: str) -> None:
        """Remove the relation on both sides; a side that never had it is left as it is."""
        with self._lock:
            for a, b in ((database, other), (other, database)):
                data = self.get(a)
                names = [n for n in data.get(COMPARED_WITH) or [] if isinstance(n, str)]
                if b in names:
                    names = [n for n in names if n != b]
                    if names:
                        data[COMPARED_WITH] = names
                    else:
                        data.pop(COMPARED_WITH, None)
                    self._save(a, data)

    def _retarget_links(self, old: str, new: str | None) -> None:
        """Every OTHER study that names `old` as a comparison model now names `new` — or, when `new`
        is None, no longer names it. Walks the files rather than the database list: the relation has
        to follow a rename or a delete even for a study whose model is gone."""
        folder = prism_meta_dir() / "studies"
        if not folder.exists():
            return
        for path in folder.glob("*.json"):
            data = read_json(path, default={})
            names = data.get(COMPARED_WITH)
            if not isinstance(names, list) or old not in names:
                continue
            kept = [n for n in names if n != old]
            if new and new not in kept:
                kept.append(new)
            if kept:
                data[COMPARED_WITH] = kept
            else:
                data.pop(COMPARED_WITH, None)
            write_json_atomic(path, data)

    def rename_database(self, old: str, new: str) -> None:
        """Move a renamed model's study metadata file (old name → new name), and let every model that
        compares itself with it follow the new name."""
        with self._lock:
            # The registry already carries the new name; the old one's legacy file must find it first.
            migrate_active_workspace(also=[old])
            src, dst = self._path(old), self._path(new)
            if src.exists():
                self.replace(new, self.get(old))
                # A rename to the same name maps to the same file; unlinking the source would then delete
                # what was just written (the names "A B" and "A_B" no longer share a file).
                if src != dst:
                    src.unlink()
            self._retarget_links(old, new)

    def remove_database(self, database: str) -> None:
        """Delete a model's study metadata file, and drop it from every other model's comparison list."""
        with self._lock:
            # A legacy file of the deleted model would otherwise wait for a later model of that name.
            migrate_active_workspace(also=[database])
            path = self._path(database)
            if path.exists():
                path.unlink()
            self._retarget_links(database, None)


# --- file names ---------------------------------------------------------------------------------
# The file used to be `<safe>.json`, where `safe` turns every character but `A-Za-z0-9._-` into
# "_": "Model A" and "Model_A", "Flasche (A)" and "Flasche _A_" wrote one file, and one model's goal &
# scope overwrote the other's. The name now carries a hash of the exact model name.

#: The readable part is cut here: with the hash and `.json.tmp` it stays well under a 255-byte file name.
_READABLE_MAX = 80
#: Legacy files without an owner among today's models go here, out of the scan for good — a model created
#: later under a matching name must not inherit a deleted model's metadata.
LEGACY_ARCHIVE = "_legacy"
#: Set while a restore's "the backup's legacy files win" is not yet carried out in full (see migration).
PREFER_LEGACY_MARKER = ".prefer-legacy"


def _safe(database: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", database or "default")


def study_file_name(database: str) -> str:
    """`<readable>~<hash>.json`: the readable part to find a file by eye, the hash of the exact name to keep
    two models apart. `~` never occurs in the readable part, which is how a legacy name is told apart."""
    digest = hashlib.sha1((database or "default").encode("utf-8")).hexdigest()[:12]
    return f"{_safe(database)[:_READABLE_MAX]}~{digest}.json"


def migrate_legacy_files(
    names: Iterable[str], folder: Path | None = None, *, prefer_legacy: bool = False
) -> dict:
    """Move every legacy `<safe>.json` to the new name of each model it belongs to — run where a workspace
    becomes active (app start, activation, restore over the active one), under the project lock and before
    any model can be created, renamed or deleted.

    A legacy file is copied to EVERY existing model whose sanitised name matches: two colliding models both
    saw its content until now, so both keep it and diverge from here. Each copy is an atomic write; a copy
    already there is left alone (a retry after a crash); the legacy file is removed only after all copies
    stood. A file no existing model owns — or one that cannot be read — goes to `_legacy/`. Idempotent: a
    second run finds nothing to do. Each file on its own: one that fails stays where it is for the next run
    (counted in ``failed``) and the scan goes on.

    ``prefer_legacy``: after a restore over the active workspace, where Brightway copies the backup *over*
    the folder — the legacy files then are the backup's and win over the current ones.
    """
    folder = folder or (prism_meta_dir() / "studies")
    out = {"moved": 0, "copies": 0, "archived": 0, "failed": 0, "conflicts": 0}
    if not folder.is_dir():
        return out
    # "The backup wins" has to outlive a run that fails half-way: otherwise the next ordinary run keeps the
    # pre-restore copy and deletes the backup's legacy file. A marker holds it until a run completes.
    marker = folder / PREFER_LEGACY_MARKER
    if prefer_legacy:
        marker.touch()  # no marker, no restore precedence: the caller must hear that (it raises)
    prefer_legacy = prefer_legacy or marker.exists()
    owners: dict[str, list[str]] = {}
    for name in names:
        owners.setdefault(_safe(name), []).append(name)
    for legacy in sorted(folder.glob("*.json")):
        if "~" in legacy.stem:
            continue
        try:
            data = read_json(legacy, default=None)
        except Exception:  # noqa: BLE001 - unreadable: archived like an orphan, the scan goes on
            data = None
        mine = owners.get(legacy.stem, [])
        if data is None or not mine:
            try:
                archive = folder / LEGACY_ARCHIVE
                archive.mkdir(exist_ok=True)
                target = archive / legacy.name
                n = 2
                while target.exists():
                    target = archive / f"{legacy.stem}.{n}.json"
                    n += 1
                legacy.replace(target)
                out["archived"] += 1
            except FileNotFoundError:  # another backend process on the same folder was quicker
                pass
            except OSError:
                out["failed"] += 1
            continue
        conflict = False
        try:
            for name in mine:
                dst = folder / study_file_name(name)
                if prefer_legacy or not dst.exists():
                    write_json_atomic(dst, data)
                    out["copies"] += 1
                elif read_json(dst, default=None, on_error="empty") != data:
                    # A different copy is already there: an interrupted run would have written the same
                    # content, so this is a newer study (or a restore whose precedence got lost). The newer
                    # one stays in use, and the legacy file is archived, never deleted — no version is lost.
                    conflict = True
        except OSError:
            out["failed"] += 1  # the legacy file stays; the next run (or the next read) retries
            continue
        try:
            if conflict:
                archive = folder / LEGACY_ARCHIVE
                archive.mkdir(exist_ok=True)
                target = archive / legacy.name
                n = 2
                while target.exists():
                    target = archive / f"{legacy.stem}.{n}.json"
                    n += 1
                legacy.replace(target)
                out["conflicts"] += 1
            else:
                legacy.unlink()
                out["moved"] += 1
        except FileNotFoundError:
            pass
        except OSError:
            out["failed"] += 1  # the copies stand; the next run finds them and only removes this file
    if not out["failed"] and marker.exists():
        try:
            marker.unlink()
        except OSError:
            pass
    return out


def migrate_active_workspace(*, also: Iterable[str] = (), prefer_legacy: bool = False) -> dict:
    """`migrate_legacy_files` for the active workspace and its models — plus ``also``: a model the registry
    no longer lists because it is being renamed or deleted right now, so its legacy file still finds it.

    Under the store's own lock, the one `update`/`replace` hold: a migration checking "is there a copy
    yet?" and a save writing that copy cannot interleave."""
    from prism_lca.engine.bootstrap import get_bd

    with StudyMetaStore()._lock:
        return migrate_legacy_files([*get_bd().databases, *also], prefer_legacy=prefer_legacy)


def ensure_migrated(database: str) -> None:
    """Before a model is renamed or deleted: its legacy file, if any, must be migrated now — while the
    registry still lists it — or the rename stops before anything has changed. A file left behind would
    wait for the next model of a matching name."""
    migrate_active_workspace()
    legacy = prism_meta_dir() / "studies" / f"{_safe(database)}.json"
    if legacy.exists():
        from prism_lca.errors import PrismError

        raise PrismError(
            f"The study metadata of ‘{database}’ could not be prepared for this change.",
            code="study_migration_failed",
            status_code=500,
            hint=f"Check that the workspace folder is writable ({legacy.parent}), then try again.",
        )

