"""Numbers a stored chapter keeps typed out, for the author to decide (V461).

The gate refuses a figure typed where a placeholder belongs (`report_numbers`), and a writer that could
not put it right within its attempts lost the whole chapter: the document printed "This section has no
text yet" over one typed number in one sentence. When such numbers are all that is left, the chapter is
stored anyway, and each number becomes an open point of the chapter's reading: the author keeps it as
written, replaces it with the placeholder it most likely is, or has the chapter rewritten. The report
cannot be approved while one is open.

A kept number has no binding, so nothing else would notice when a recalculation makes it wrong. The
point records the results it was kept against, and the out-of-date check names it again once they move.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from prism_lca.engine import report_sentences

#: How a point of the reading says it came from a typed number rather than from the second reader.
ORIGIN = "typed_number"


def replace_in(text: str, point: dict[str, Any], candidate: dict[str, Any]) -> str | None:
    """`text` with the point's number replaced by the candidate placeholder, at the very place it was
    found — its sign too where the placeholder prints one, and the typed percent sign where it prints
    its own. None when the sentence is gone or no longer holds the number there."""
    source, number = str(point.get("source") or ""), str(point.get("number") or "")
    offset = point.get("offset")
    if not source or not number or not isinstance(offset, int):
        return None
    base = -1
    for _ in range(int(point.get("occurrence") or 0) + 1):
        base = text.find(source, base + 1)
        if base < 0:
            return None
    at = base + offset
    if text[at : at + len(number)] != number:
        return None
    sign = str(point.get("sign") or "")
    prints = str(candidate.get("prints") or "")
    start = at - len(sign) if sign and prints[:1] in "+-\u2212" and text[at - len(sign) : at] == sign else at
    end = at + len(number)
    if candidate.get("own_percent"):
        m = re.match(r"[ \u00a0\u202f]?%", text[end:])
        end += m.end() if m else 0
    return text[:start] + f"{{{{{candidate['path']}}}}}" + text[end:]


def problem(number: str, candidates: list[dict[str, Any]]) -> str:
    """What is wrong with a typed number, in the author's words rather than the writer's."""
    said = (
        f"“{number}” is typed into the text instead of being taken from the results, so it will not "
        "change when the model is recalculated."
    )
    if not candidates:
        return said + " Keep it if it is an input or a quoted figure; if it is a result, have the chapter rewritten."
    first = candidates[0]
    name = first.get("label") or first.get("path")
    return said + f" It looks like {name}, which prints “{first.get('prints')}” today."


#: More typed numbers than this in one chapter is not a chapter to store for the author to go through.
MAX_POINTS = 60


def points(
    findings: list[dict[str, Any]],
    text: str,
    printed: Any,
    previous: list[dict[str, Any]] | None = None,
    snapshot: str | None = None,
) -> list[dict[str, Any]] | None:
    """One open point per typed number in a chapter stored with them, shaped like a reading's points —
    or None when one of them cannot be placed, so that no number is stored without its point.

    Each point is where its finding stands (`at`): two typed "55 %" in two sentences are two decisions,
    and the second is not approved by keeping the first. `printed` turns a sentence into what the document
    shows (`report_review.printed`); `snapshot` is the snapshot the chapter is stored against — a
    replacement is only offered while the numbers have not moved (`replace_in`). A number the author
    already decided about in an earlier version of the chapter — same number, same sentence, same place —
    keeps that decision: a replacement elsewhere must not reopen what was kept.
    """
    from prism_lca.engine.report_numbers import sign_before

    decided = {
        (p.get("number"), p.get("source"), p.get("offset"), p.get("occurrence", 0)): p
        for p in previous or []
        if p.get("origin") == ORIGIN and p.get("status") != "open"
    }
    spans = report_sentences.sentence_spans(text)
    out: list[dict[str, Any]] = []
    for finding in findings:
        if finding.get("kind") != "literal_number":
            continue
        number = str((finding.get("names") or [""])[0])
        at = finding.get("at")
        if not number or not isinstance(at, int) or text[at : at + len(number)] != number:
            return None
        start, end = next(((a, b) for a, b in spans if a <= at < b), (None, None))
        if start is None:
            return None
        source = text[start:end]
        # The same sentence twice is two places: which of the identical ones this is.
        occurrence = sum(1 for a, b in spans if a < start and text[a:b] == source)
        candidates = [c for c in finding.get("candidates") or [] if isinstance(c, dict)]
        point = {
            "quote": printed(source.strip()),
            "problem": problem(number, candidates),
            "status": "open",
            "resolution": "",
            "origin": ORIGIN,
            "number": number,
            "sign": sign_before(text, at),
            "source": source,
            "offset": at - start,
            "occurrence": occurrence,
            "candidates": candidates,
            **({"snapshot": snapshot} if snapshot else {}),
        }
        before = decided.get((number, source, at - start, occurrence))
        if before:
            point.update({k: before[k] for k in ("status", "resolution", "kept_results") if k in before})
        out.append(point)
    return out if len(out) <= MAX_POINTS else None


def results_fingerprint(data: dict[str, Any]) -> str:
    """What a kept number was judged against: every value the gate could have matched it to — the
    results, the variants', every share and breakdown figure — and the parameters. A typed share stays
    wrong after a reallocation that leaves every total as it was, so the totals alone are not enough."""
    from prism_lca.engine import report_printed

    values = [[e.path, e.value] for e in report_printed.index(data, "en") if e.replaceable]
    values += [[p.get("name"), p.get("amount")] for p in data.get("parameters") or [] if isinstance(p, dict)]
    return hashlib.sha1(json.dumps(values, sort_keys=True, default=str).encode()).hexdigest()[:16]


def moved(review: dict[str, Any] | None, data: dict[str, Any]) -> list[dict[str, Any]]:
    """Kept numbers whose values have moved since they were kept — to be confirmed again."""
    now = results_fingerprint(data)
    return [p for p in typed(review, "kept") if p.get("kept_results") != now]


def typed(review: dict[str, Any] | None, status: str | None = None) -> list[dict[str, Any]]:
    """The typed-number points of a reading, optionally only those with this status."""
    return [
        i
        for i in (review or {}).get("issues") or []
        if isinstance(i, dict) and i.get("origin") == ORIGIN and (status is None or i.get("status") == status)
    ]


def verdicts(section: dict[str, Any], data: dict[str, Any]) -> list[dict[str, Any]]:
    """The reminder after a recalculation: kept numbers whose results have moved since they were kept."""
    from prism_lca.engine import report_review

    stale = moved(report_review.current_review(section), data)
    if not stale:
        return []
    listed = ", ".join(f"“{p.get('number')}”" for p in stale[:6])
    return [
        {
            "kind": "kept_numbers",
            "severity": "review",
            # Which points, so the editor can ask about exactly these again (`keep-point` reconfirms).
            "points": [
                {"quote": p.get("quote"), "offset": p.get("offset"), "occurrence": p.get("occurrence", 0)}
                for p in stale
            ],
            "message": (
                f"{len(stale)} number(s) kept as typed in this chapter were checked before the latest "
                f"recalculation — check that they still hold: {listed}."
            ),
        }
    ]
