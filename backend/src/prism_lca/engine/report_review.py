"""The second reader of a written chapter: what it is shown, and which findings still decide alone.

A chapter a model writes is read by a second model before it is stored (the writer's dialogue in
``frontend/src/main/ai/writer/dialogue.ts``). That changes who decides about the gate's findings, and
they fall into two kinds:

* **The contract.** A placeholder that does not resolve or is malformed, a reference to nothing, a
  unit the figure does not carry, a typed number, an empty chapter. These are facts about tokens
  against the snapshot — exact, free, and true whoever reads the text — so they block every write.
* **Everything else.** A rank word, a comparison, a name in front of a figure, a quoted dataset, a
  sentence about how the report was made, the style notes. These are readings of language, and the
  word lists behind them miss phrasings and fire on innocent ones. With a second reader they are
  handed over as suspicions and the reader decides; without one they block exactly as before.

What the reader is shown is the chapter as the document will PRINT it — the figures worked out, each
under the member its pin names — because a number checked against its sentence is the one thing a
reader of the placeholder source cannot do.
"""
from __future__ import annotations

from typing import Any

from prism_lca.engine import report_bindings, report_prompts, report_typed_numbers
from prism_lca.engine.report_i18n import chapter_name

#: Findings that block a write even after a second reader has accepted it. Every one is a property of
#: the tokens against the snapshot, so no reading can make it right.
CONTRACT_FINDINGS = frozenset(
    {
        "unresolved_placeholder",
        "malformed_placeholder",
        "unknown_reference",
        "unit_mismatch",
        "duplicated_unit",
        "literal_number",
        "empty_chapter",
        "emoji",
    }
)

#: How much of each other chapter the reader sees, and of all of them together. The summarising
#: chapters are read against their siblings; for the rest the siblings are context, not material.
SIBLING_CHARS = 2_500
SIBLINGS_TOTAL = 18_000


def contract(findings: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """The findings no reader can overrule."""
    return [f for f in findings or [] if f.get("kind") in CONTRACT_FINDINGS]


def hints(findings: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """The findings a second reader decides about."""
    return [f for f in findings or [] if f.get("kind") not in CONTRACT_FINDINGS]


def decided(verdict: dict[str, Any], reviewed: bool) -> dict[str, Any]:
    """The gate's verdict with `ok` set by whoever decides it.

    Read by a second model, a chapter passes when the contract holds — the reader has already judged
    the rest. Unread, the gate's own `ok` stands, which is the behaviour before the reader existed.
    """
    if not reviewed:
        return verdict
    return {**verdict, "ok": not contract(verdict.get("findings"))}


def _cap(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def printed(text: str, data: dict[str, Any], lang: str, bindings: dict[str, Any] | None) -> str:
    """A text as a reader of the document sees it: every placeholder worked out, markup plain."""
    return report_bindings.resolve(text or "", data, lang, bindings, plain=True)[0]


def siblings(section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> list[dict[str, str]]:
    """The other chapters that carry text, as printed, in document order and capped."""
    lang = report.get("lang", "en")
    out: list[dict[str, str]] = []
    left = SIBLINGS_TOTAL
    for other in sorted(report.get("sections", []), key=lambda s: s.get("order", 0)):
        if other.get("id") == section.get("id"):
            continue
        body = str(other.get("text") or "").strip()
        if not body or left <= 0:
            continue
        shown = _cap(printed(body, data, lang, other.get("bindings") or {}), min(SIBLING_CHARS, left))
        left -= len(shown)
        out.append({"title": chapter_name(other, lang), "kind": str(other.get("kind") or ""), "text": shown})
    return out


def review_brief(
    section: dict[str, Any],
    report: dict[str, Any],
    data: dict[str, Any],
    text: str,
    lookups: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Everything the second reader judges a proposed chapter against.

    The same brief the writer had — the assignment, the study, the facts, the plan, the cautions —
    plus the two things the writer never sees: its own text as printed, and the other chapters as
    printed. The writer's lookups are not repeated here; the caller holds them and hands them over.

    The text is bound by position, as the store will bind it: a fresh chapter is written against
    today's data, and an update against the chapter rebased into today's positions (`update_brief`).
    """
    if lookups:
        data = {**data, "looked_up": lookups}
    brief = report_prompts.build_brief(section, report, data)
    lang = report.get("lang", "en")
    bindings = report_bindings.bindings_for(text, data)
    return {
        "title": brief.get("title"),
        "kind": brief.get("kind"),
        "language": brief.get("language"),
        "assignment": brief.get("prompt"),
        "cautions": brief.get("cautions") or [],
        "study": brief.get("study") or {},
        "facts": brief.get("facts") or {},
        "document_plan": brief.get("document_plan") or {},
        "printed": printed(text, data, lang, bindings),
        "siblings": siblings(section, report, data),
        "author_answers": answered(report),
        # The figures and tables printed with the chapter: a reader who cannot see them takes a
        # sentence pointing at "the figure" for an unsupported one.
        "renders": brief.get("renders") or [],
    }


def answered(report: dict[str, Any]) -> list[dict[str, str]]:
    """What the author has answered, as plain question-and-answer pairs for a brief."""
    out = []
    for entry in (report.get("answers") or {}).values():
        if isinstance(entry, dict) and str(entry.get("answer") or "").strip():
            out.append({"question": str(entry.get("question") or ""), "answer": str(entry["answer"])})
    return out


def current_review(section: dict[str, Any]) -> dict[str, Any] | None:
    """The chapter's reading, while it still describes the text the chapter has."""
    from prism_lca.engine.report_store import text_version

    review = section.get("ai_review")
    if isinstance(review, dict) and review.get("text_version") == text_version(section.get("text")):
        return review
    return None


def update_brief(section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    """The writer's brief for bringing a written chapter up to date instead of writing it again.

    The ordinary brief, plus the chapter as it stands and as it prints, what changed under it in the
    staleness check's words, the second reader's points that were still open, and the lookups the
    chapter was accepted with. The figures in placeholders follow the data by themselves; what an
    update is for are the words around them.

    The chapter comes rebased into today's positions (`report_rebase`), because the facts beside it
    are in today's order: one set of coordinates for the writer, and the update is then bound by
    position like a fresh write. Its lookups come along because the sentences an update leaves
    standing still rest on them — the reader is shown them, and the store keeps them — but only the
    ones that are still true (`_still_true`).
    """
    from prism_lca.engine import report_gate, report_rebase, report_staleness

    brief = report_prompts.build_brief(section, report, data)
    text = report_rebase.rebase(str(section.get("text") or ""), data, section.get("bindings") or {})
    found = report_staleness.verdicts(section, report, data, report_gate.known_method_families())
    review = current_review(section) or {}
    brief["update"] = {
        "text": text,
        "printed": printed(text, data, report.get("lang", "en"), report_bindings.bindings_for(text, data)),
        "lookups": _still_true(section, report, data),
        "changes": [
            str(f["message"])
            for f in found
            if f.get("severity") in ("review", "rewrite") and str(f.get("message") or "").strip()
        ],
        "open_points": [
            {"quote": i.get("quote", ""), "problem": i.get("problem", "")}
            for i in review.get("issues") or []
            if i.get("status") == "open"
        ],
    }
    brief["author_answers"] = answered(report)
    return brief


#: Lookups that read documentation rather than the model's results — a dataset, a method, the literature.
#: A recalculation cannot move what they say, so an update may carry them; one of `explain_result`,
#: `compare_scenarios` or `list_parameters` describes the numbers of its moment, which is exactly what
#: has just moved.
_DOCUMENTATION_LOOKUPS = frozenset(
    {"get_process_details", "get_method_factors", "get_characterization_factors", "research_web"}
)


def _still_true(section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> list[dict[str, Any]]:
    """The chapter's lookups an update may keep as evidence: documentation that has not changed since.

    A dataset's documentation is fingerprinted when the chapter is stored (`report_staleness.sources_of`).
    A lookup of a dataset whose fingerprint has moved since — or that no record vouches for — is left
    out: carried along, its old text would support a sentence the dataset no longer backs, and the store
    would then record today's fingerprint over it and clear the very warning that says it changed.
    """
    from prism_lca.engine import report_staleness

    recorded = ((section.get("based_on") or {}).get("sources") or {}).get("datasets") or {}
    kept = []
    for lookup in section.get("lookups") or []:
        if not isinstance(lookup, dict) or lookup.get("name") not in _DOCUMENTATION_LOOKUPS:
            continue
        if lookup.get("name") == "get_process_details":
            today = report_staleness.sources_of(section, report, data, [lookup])["datasets"]
            if not today or any(recorded.get(key) != sha for key, sha in today.items()):
                continue
        kept.append(lookup)
    return kept


#: Bounds on what a reading may store: a record of what was settled, not a transcript.
_MAX_POINTS = 30
_POINT_CHARS = 600
#: `kept`: the author read an open point and keeps the sentence as written.
_ISSUE_STATUS = frozenset({"resolved", "false_positive", "open", "kept"})


def _clip(value: Any, limit: int = _POINT_CHARS) -> str:
    return _cap(str(value or "").strip(), limit)


def record(review: dict[str, Any] | None, reviewer: str | None, text: str) -> dict[str, Any]:
    """The reading as it is kept with the chapter: who read it, how often, and how each point ended.

    Stamped with the version of the text it was formed against, so a reader of the record can tell
    whether it still describes the chapter (a hand edit since then means it does not).
    """
    from datetime import UTC, datetime

    from prism_lca.engine.report_store import text_version

    review = review or {}
    issues = []
    given = [i for i in review.get("issues") or [] if isinstance(i, dict)]
    # Capped apart: the reader's points are a record of what was settled, the typed numbers decisions the
    # author still has to make — none of those may fall off the end of a long reading.
    typed = [i for i in given if i.get("origin") == report_typed_numbers.ORIGIN]
    for issue in [i for i in given if i not in typed][:_MAX_POINTS] + typed[: report_typed_numbers.MAX_POINTS]:
        status = str(issue.get("status") or "open")
        entry: dict[str, Any] = {
            "quote": _clip(issue.get("quote")),
            "problem": _clip(issue.get("problem")),
            "status": status if status in _ISSUE_STATUS else "open",
            "resolution": _clip(issue.get("resolution")),
        }
        if issue.get("origin") == report_typed_numbers.ORIGIN:
            # A typed number the store kept for the author (`report_typed_numbers`): what is needed to
            # find it again, to offer its placeholder, and to remind after a recalculation.
            entry.update(
                origin=report_typed_numbers.ORIGIN,
                number=_clip(issue.get("number"), 40),
                sign=_clip(issue.get("sign"), 1),
                # Verbatim, not clipped: it is how the number is found again (`replace_in`).
                source=str(issue.get("source") or ""),
                offset=int(issue["offset"]) if isinstance(issue.get("offset"), int) else None,
                occurrence=int(issue["occurrence"]) if isinstance(issue.get("occurrence"), int) else 0,
                **({"snapshot": _clip(issue.get("snapshot"), 80)} if issue.get("snapshot") else {}),
                candidates=[
                    {
                        "path": _clip(c.get("path"), 200),
                        "label": _clip(c.get("label"), 200),
                        "prints": _clip(c.get("prints"), 60),
                        "own_percent": bool(c.get("own_percent")),
                    }
                    for c in (issue.get("candidates") or [])[:3]
                    if isinstance(c, dict) and c.get("path")
                ],
                **({"kept_results": _clip(issue.get("kept_results"), 40)} if issue.get("kept_results") else {}),
            )
        issues.append(entry)
    questions = []
    for q in (review.get("questions") or [])[:_MAX_POINTS]:
        if not isinstance(q, dict) or not str(q.get("question") or "").strip():
            continue
        questions.append(
            {
                "id": _clip(q.get("id"), 40),
                "question": _clip(q.get("question")),
                "why": _clip(q.get("why")),
                "proposal": _clip(q.get("proposal")),
                "options": [_clip(o, 200) for o in (q.get("options") or [])[:6] if str(o or "").strip()],
            }
        )
    hint_tally = {
        str(kind): {k: int(v) for k, v in (counts or {}).items() if k in ("fixed", "dismissed")}
        for kind, counts in (review.get("hints") or {}).items()
        if isinstance(counts, dict)
    }
    return {
        "reviewer": reviewer,
        "rounds": int(review.get("rounds") or 0),
        "verdict": "accepted" if not any(i["status"] == "open" for i in issues) else "open_points",
        "issues": issues,
        "questions": questions,
        "hints": hint_tally,
        "text_version": text_version(text),
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
