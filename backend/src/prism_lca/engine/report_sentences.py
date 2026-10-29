"""The one sentence rule for everything that judges or quotes chapter prose.

Two modules used to carry their own copy of the rule: ``report_claims`` (strings,
placeholder-masked) judged the sentences, and ``report_patch`` (offset spans, unmasked) decided
which sentence a finding is quoted against. The copies agreed on every real chapter — but the
judging layer and the quoting layer sharing a rule by coincidence is exactly the arrangement that
drifts, and the masked variant is the correct one: a placeholder is a token, and nothing inside it
may end a sentence, whatever a derivation's arguments happen to contain.

The rule itself, kept from both originals: a terminator only ends a sentence where prose actually
ends one — at whitespace followed by a capital, or at the end of the text. A bare ``[.!?]`` split
"ecoinvent-3.12-cutoff" into "…ecoinvent-3." + "12-cutoff…", which stranded "second-largest" in one
half and "largest" in the other and reported a contradiction that was not there; and a path is full
of dots (``subjects.1.results.0.score``), so the raw text is never split directly.
"""

from __future__ import annotations

import re

from prism_lca.engine.report_tokens import PLACEHOLDER

#: End of sentence: a full stop, question or exclamation mark followed by space and a capital. The
#: lookahead keeps "3.12" from splitting a sentence in half. A known imperfection, inherited from
#: both originals: an abbreviation directly before a capital ("z. B. Hier") still splits, against
#: the general rule that over-splitting is the dangerous direction (it can strand a claim's
#: disarming words in the other half). Tolerated because the pattern is rare in report prose and a
#: word-list fix ("z. B.", "e.g.", …) would be one more per-language table to keep honest.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-ZÄÖÜ„“\"])")


def _masked(text: str) -> str:
    """Placeholders blanked out, length-preserved.

    Length-preserving on purpose: the spans found on the masked text are used verbatim on the
    original, so every masked character has to sit at its original offset. The mask letter carries
    no terminator, no capital and no whitespace, so a placeholder can neither end a sentence nor
    start one.
    """
    return PLACEHOLDER.sub(lambda m: "x" * len(m.group(0)), text or "")


def sentence_spans(text: str) -> list[tuple[int, int]]:
    """(start, end) of each sentence in ``text``; the whitespace between sentences belongs to neither."""
    spans: list[tuple[int, int]] = []
    start = 0
    for match in _SENTENCE_SPLIT.finditer(_masked(text)):
        spans.append((start, match.start()))
        start = match.end()
    if start < len(text):
        spans.append((start, len(text)))
    return spans


def sentences(text: str) -> list[str]:
    """The sentences themselves, cut from the original text along :func:`sentence_spans`."""
    return [text[start:end] for start, end in sentence_spans(text)]
