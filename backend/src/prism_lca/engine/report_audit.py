"""The report module's own lines in the audit log.

Until this existed, the log recorded every parameter and every exchange — 1268 entries in the
development project, 1128 of them the assistant's model edits — and **not one** line from the report
module. Writing a chapter, correcting it, deleting it, translating the study texts, typesetting the
PDF: the actions that cost money, and the ones a reviewer asks about first, left no trace. A tool
whose promise is "every change is recorded and attributable" was silent about its most expensive half.

**Notes, not Commands.** A chapter is not model state, and an undo over a paid model
call is not an undo — it cannot give the money back and it cannot know whether the author has since
read the text. So every entry here is `bus.note(..., undoable=False)`; nothing lands on the undo
stack, and there is no second store: the log stays one file per project.

**One line per change to the deliverable.** The gate is asked with `store=false` up to four times per
chapter while the writer revises; none of that is logged. What is logged is the outcome that changed
the document, plus the paid outcome that changed nothing (a chapter the gate refused), because that
one is otherwise invisible.

**What never goes in:** no chapter text, no prompt, no model answer. A finding's `detail` quotes the
prose, so only its `kind` is recorded. Names, counts, kinds, models, timestamps — the log is a trail,
not a transcript.

**Writing a note may never fail the action it describes.** The chapter is already stored by the time
we get here; a full disk must not turn a paid, accepted chapter into a 500. So the write is guarded —
and *not* swallowed: the loss is logged, counted, and the next entry that does get written says how
many lines were lost and what they were about (`report_audit_lost`). A log that quietly stops
recording while the app reports success is the "says ready while something is wrong" family this
project has already fixed five times (V196/V198/V200/V201/V215).
"""
from __future__ import annotations

import logging
from collections import Counter
from threading import Lock

from prism_lca.engine.report_i18n import chapter_name

logger = logging.getLogger(__name__)

#: Entries the log could not take, per action. Kept so the *next* successful write can say so — the
#: log is append-only, so a lost line can never be filled in, but the gap can be named.
_lost: Counter[str] = Counter()
_LOCK = Lock()


def note(
    request,  # noqa: ANN001 - fastapi.Request or a CommandBus, typed loosely so this module imports nothing web
    action: str,
    summary: str,
    *,
    database: str | None = None,
    source: str = "user",
) -> bool:
    """Append one audit line for a report action. Returns whether it was written; never raises.

    ``database`` is the **model** the report belongs to, and it is what makes the entry findable in
    the model's own history — written, never inferred from the summary text.

    ``request`` is whatever carries the bus: the routers pass their ``Request`` (the bus hangs off
    ``app.state``), engine callers may pass the ``CommandBus`` itself. Duck-typed so this module
    keeps importing nothing web — it lives in the engine.
    """
    bus = getattr(getattr(getattr(request, "app", None), "state", None), "command_bus", None)
    if bus is None and callable(getattr(request, "note", None)):
        bus = request  # a CommandBus handed over directly
    if bus is None:
        # Only reachable from an app assembled without a bus. Counted rather than ignored: silence
        # here is exactly what Phase 3 exists to end.
        logger.error("No command bus on this app; the audit entry %r is lost.", action)
        _lose(action)
        return False
    _report_losses(bus)
    try:
        bus.note(source, action, summary, database=database)
        return True
    except Exception:  # noqa: BLE001 - deliberately broad: see the module docstring
        logger.exception("The audit entry %r could not be written; the action itself stands.", action)
        _lose(action)
        return False


def by_model(model: str | None) -> str:
    """`ai` when a model produced it, `user` otherwise — the same rule the chapter store already uses
    for a section's `source`, so the log and the chapter agree about who wrote it."""
    return "ai" if model else "user"


def report_label(report: dict) -> str:
    """What to call this report in a sentence. Reports are named by their author and a project holds
    several, so the name comes first and the id stands in when there is none."""
    return str(report.get("name") or "").strip() or str(report.get("id") or "report")


def chapter_label(section: dict) -> str:
    """The chapter's own title, else the standard name of its kind — the name the author sees."""
    return chapter_name(section)


def with_model(model: str | None) -> str:
    return f", model '{model}'" if model else ""


def finding_kinds(findings: list | None, limit: int = 4) -> str:
    """The *kinds* a gate refusal names, deduplicated. Never the details: a finding's detail quotes
    the sentence it condemns, and the log does not carry chapter text."""
    kinds: list[str] = []
    for finding in findings or []:
        kind = str((finding or {}).get("kind") or "").strip() if isinstance(finding, dict) else ""
        if kind and kind not in kinds:
            kinds.append(kind)
    if not kinds:
        return "no kind reported"
    shown = ", ".join(sorted(kinds)[:limit])
    return shown + (f", +{len(kinds) - limit} more" if len(kinds) > limit else "")


def size(text: str | None) -> str:
    return f"{len(text or '')} characters"


# --------------------------------------------------------------------------- #
# What happens when the log itself cannot be written
# --------------------------------------------------------------------------- #
def _lose(action: str) -> None:
    with _LOCK:
        _lost[action] += 1


def _report_losses(bus) -> None:  # noqa: ANN001
    """Write one line saying that earlier lines were lost, then forget them.

    Attributed to no model on purpose: this is a statement about the log, not about a model, and
    guessing one would be the inference this log never makes. It shows up in the project view, and in a model
    view as earlier history — which is where a reader who wonders about a gap will be looking.
    """
    with _LOCK:
        pending = Counter(_lost)
    if not pending:
        return
    total = sum(pending.values())
    detail = ", ".join(f"{action} ×{count}" for action, count in sorted(pending.items()))
    summary = (
        f"{total} report audit entr{'y' if total == 1 else 'ies'} could not be written and "
        f"{'is' if total == 1 else 'are'} lost ({detail}) — see the application log"
    )
    try:
        bus.note("system", "report_audit_lost", summary)
    except Exception:  # noqa: BLE001
        # Still broken. The count stays pending, so the first write that succeeds reports the lot.
        logger.exception("The report audit loss could not be recorded either; it stays pending.")
        return
    with _LOCK:
        _lost.subtract(pending)
        for action in [a for a, n in _lost.items() if n <= 0]:
            del _lost[action]


def pending_losses() -> dict[str, int]:
    """How many entries are waiting to be reported as lost, per action.

    The only place that can answer "did the log drop anything" while the store is still broken — the
    line saying so cannot be written until the store takes it. Read by the tests; worth reaching for
    if a support bundle ever wants to say it too.
    """
    with _LOCK:
        return dict(_lost)


def reset_for_tests() -> None:
    with _LOCK:
        _lost.clear()
