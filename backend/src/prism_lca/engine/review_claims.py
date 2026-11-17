"""Study prose that claims an internal review of the model — read for the health check.

Whether an internal review ran is a fact: every review that returns a result is kept in the model's review
log (review_log.py). What the study text says about it is prose, and prose can claim a review that never
ran. A balcony-solar study declared an "automatisierte Modellreview" that was never called (V234); a
wheelbarrow study wrote "eine interne KI-gestützte Zweitmeinung (Review) wurde während des Aufbaus
eingeholt" after both attempts of its review had timed out and the tool had said that nothing was judged.

The health check warns about such a claim, in a sentence that names both readings, because only whoever
edits the model knows which review is meant: the log holds the assistant's reviewer alone, and "internal
review" is just as much the word for a review by the author's colleagues. For the same reason the report
prints nothing from this reading — a misread sentence there would tell a client that the author's own
review never happened (report_checks.limitations_blocks).

This is a word list because no structure carries the signal: the fields are free text, and a critical
review by independent experts — which the review log never holds — is exactly what one of them is for.
So the list is deliberately narrow. It catches the claim of an *internal* or *AI* review or second opinion,
never "critical review" on its own, and never "strukturelle Modellprüfung (Prism Model Health Check)",
which names a check that really does run: flagging it would teach authors to stop writing down what they
did.
"""
from __future__ import annotations

import re

from prism_lca.engine.study import AUTHOR_TEXT_FIELDS

#: Phrases that claim an internal, automated or AI review OF THE MODEL, in the five languages a study can
#: be documented in. The AI and second-opinion forms are the vocabulary assistants actually wrote into
#: `critical_review` — they echo the review tool's own description ("a second opinion from a separate AI
#: reviewer"): "interne KI-gestützte Zweitmeinung", "interne KI-Second-Opinion", "interne Zweitmeinung
#: (KI-Review)", "modellinterne Zweitprüfung". A second opinion counts only with "AI" or "internal" beside
#: it; on its own it may be a human expert's.
_REVIEW_CLAIM_RE = re.compile(
    r"\b("
    r"modell[- ]?review|automatis(?:ierte|che)\s+modellpr[üu]fung|interne\s+modellpr[üu]fung"
    r"|model\s+review|automated\s+model\s+(?:review|check)|internal\s+review"
    r"|revue\s+(?:interne\s+)?du\s+mod[èe]le|revue\s+interne"
    r"|revisi[óo]n\s+(?:interna\s+)?del\s+modelo|revisi[óo]n\s+interna"
    r"|revis[ãa]o\s+(?:interna\s+)?do\s+modelo|revis[ãa]o\s+interna"
    # An AI review or second opinion, the qualifier first: "KI-Review", "AI-assisted second opinion".
    r"|(?:ki|ai|ia)[- ](?:\w+[- ])?"
    r"(?:review|zweitmeinung|zweitpr[üu]fung|second[- ]opinion|revue|revisi[óo]n|revis[ãa]o)"
    # The same with the qualifier after it: "revue par IA", "review by an AI".
    r"|(?:review|zweitmeinung|zweitpr[üu]fung|second[- ]opinion|revue|revisi[óo]n|revis[ãa]o)"
    r"\s+(?:\w+\s+){0,2}?(?:ki|ai|ia)"
    # An internal second opinion: "interne Zweitmeinung", "modellinterne Zweitprüfung".
    r"|\w*intern(?:e[nrs]?|al)\s+(?:\w+[- ])?(?:zweitmeinung|zweitpr[üu]fung|second[- ]opinion)"
    r")\b",
    re.IGNORECASE,
)

#: A denial reads like a claim to a regex. "Keine automatisierte Modellreview" is the honest form of
#: exactly this sentence, and flagging it would be the worst possible lesson.
_REVIEW_DENIAL_RE = re.compile(
    r"\b(kein[a-z]*|ohne|nicht|no|not|none|without|sans|aucune?|sin|ninguna|sem|nenhuma)\b",
    re.IGNORECASE,
)

#: A review that was tried and gave nothing is not a review carried out: "the AI review timed out", "ein
#: versuchtes KI-Review", "la revue par IA a échoué". Said honestly after a failed review, and the case
#: this reading exists for — so it must never be mistaken for the claim.
_REVIEW_FAILED_RE = re.compile(
    r"\b(time[sd]?[- ]?out|failed|fail|did\s+not|could\s+not|incomplete|attempted|planned"
    r"|abgebrochen|fehlgeschlagen|gescheitert|versucht\w*|geplant\w*|zeitüberschreitung"
    r"|échou\w*|tentée?|prévue?|fall[óo]|fallida|intentad[ao]|prevista|falhou|tentad[ao])\b",
    re.IGNORECASE,
)

#: A sentence ends at one of these followed by white space — "§7.3.3" and "3.12" do not end one.
_SENTENCE_END = re.compile(r"[.;!?]\s")

#: What follows a claim is read up to the end of its clause: "…KI-Review wurde nicht durchgeführt" denies it,
#: while the "keine" of "…wurde eingeholt, ersetzt aber keine kritische Prüfung" belongs to the next clause.
_CLAUSE_END = re.compile(r"[.;:!?,]")


def claims_review(text: str) -> bool:
    """Whether ``text`` claims an internal review of the model, anywhere, carried out and not denied.

    A denial or a failure counts only within the claim's own sentence: the words just before it ("Keine
    automatisierte Modellreview", "a failed AI review") or the rest of its clause ("An AI review was not
    carried out", "die KI-Zweitmeinung ist abgebrochen"). The "Keine" that opens "Keine externe kritische
    Review …; eine interne Zweitmeinung wurde eingeholt" belongs to the first clause, and a "nicht" three
    sentences up belongs to something else. Both lists only ever silence a claim — the safe direction for a
    reading whose finding ends up in a client's report.
    """
    text = text or ""
    for m in _REVIEW_CLAIM_RE.finditer(text):
        before = _SENTENCE_END.split(text[max(0, m.start() - 40) : m.start()])[-1]
        after = _CLAUSE_END.split(text[m.end() : m.end() + 60])[0]
        if not any(r.search(part) for r in (_REVIEW_DENIAL_RE, _REVIEW_FAILED_RE) for part in (before, after)):
            return True
    return False


def claimed_review_fields(study: dict) -> list[str]:
    """The study fields whose text claims an internal review of the model, in the order the report prints
    them — the free-text fields first, then ``limitations`` once, however many of its entries claim one."""
    study = study or {}
    out = [field for field in AUTHOR_TEXT_FIELDS if claims_review(str(study.get(field) or ""))]
    limitations = [item.get("text") if isinstance(item, dict) else item for item in study.get("limitations") or []]
    if any(claims_review(str(text or "")) for text in limitations):
        out.append("limitations")
    return out
