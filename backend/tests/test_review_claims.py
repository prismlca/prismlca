"""What counts as study prose claiming an internal review of the model (engine/review_claims.py).

The sentences are the ones assistants actually wrote into `critical_review` across a test series of nine
runs; the report's limitation (`claimed_review_not_run`) and the health check's warning both rest on this
reading, so a sentence misread here is misread in both.
"""
from __future__ import annotations

import pytest

from prism_lca.engine.review_claims import claimed_review_fields, claims_review

#: Each says an internal or AI review was carried out.
CLAIMS = [
    # Written after both attempts of the review had timed out.
    "Keine externe kritische Review nach ISO 14044 §7.3.3 durchgeführt; eine interne KI-gestützte "
    "Zweitmeinung (Review) wurde während des Aufbaus eingeholt.",
    "Keine kritische Review nach ISO 14044 §7.3.3 durchgeführt (Screening-Studie); eine interne "
    "KI-Second-Opinion wurde während des Aufbaus zweimal eingeholt.",
    "Keine kritische Review nach ISO 14044 §7.3.3 durchgeführt (Screening-Studie). Eine interne "
    "Zweitmeinung (KI-Review) wurde durchgeführt und ist im Review-Log des Modells dokumentiert.",
    "Interne Qualitätskontrolle: automatisierte Modellreview.",
    "An AI-assisted second opinion was obtained during the build.",
    "The model was checked in a review by an AI.",
    "Une revue par IA a été réalisée.",
    # A denial of the first clause does not reach into the next sentence.
    "No critical review according to ISO 14044. An internal review of the model was carried out.",
    # Nor does the "keine" of the clause after it.
    "Eine KI-Review wurde eingeholt, ersetzt aber keine kritische Prüfung.",
]

#: Each says there was no review, or names something that is not one.
NOT_CLAIMS = [
    "Es hat keine kritische Prüfung durch unabhängige Experten nach ISO 14044 §7.3.3 stattgefunden. Die "
    "Studie ist eine interne Screening-Ökobilanz ohne öffentliche vergleichende Aussage.",
    "Keine kritische Prüfung durchgeführt (Screening-Studie ohne öffentliche vergleichende Aussage).",
    "Keine unabhängige kritische Prüfung durchgeführt (internes Screening).",
    "Es hat keine kritische Prüfung durch unabhängige Expertinnen oder Experten nach ISO 14044 §7.3.3 "
    "stattgefunden.",
    "Interne Qualitätskontrolle: strukturelle Modellprüfung (Prism Model Health Check).",
    "Es fand keine automatisierte Modellreview statt.",
    "No internal review was carried out.",
    "No critical review according to ISO 14044 §7.3.3 was carried out.",
    "Critical review by Dr. A. Example (independent expert), March 2026.",
    "A second opinion on the allocation was obtained from the commissioner's LCA team.",
    "none — internal screening",
    "International second-hand market data were used.",
    # It says what the second check is NOT, not that one was done: ambiguous, and silencing is the safe side.
    "Es hat keine kritische Prüfung durch unabhängige Sachverständige nach ISO 14044 §7.3.3 stattgefunden. "
    "Eine separate modellinterne Zweitprüfung ist keine solche Prüfung.",
    # A denial or a failure after the claim, in its own clause.
    "An AI review was not carried out.",
    "The AI review timed out without a result.",
    "Eine KI-Zweitmeinung wurde versucht, kam aber nicht zustande.",
    "Die interne KI-Review ist zweimal abgebrochen.",
    "A failed AI second opinion is not a review.",
]


@pytest.mark.parametrize("text", CLAIMS)
def test_a_claimed_review_is_read_as_one(text):
    assert claims_review(text), text


@pytest.mark.parametrize("text", NOT_CLAIMS)
def test_a_denial_or_another_check_is_not_a_claim(text):
    assert not claims_review(text), text


def test_the_fields_are_named_in_report_order_and_limitations_once():
    study = {
        "critical_review": CLAIMS[0],
        "goal": "Interne Qualitätskontrolle: automatisierte Modellreview.",
        "scope": NOT_CLAIMS[0],
        "limitations": [{"text": CLAIMS[5]}, {"text": CLAIMS[6]}, "a plain string entry"],
    }
    assert claimed_review_fields(study) == ["goal", "critical_review", "limitations"]
    assert claimed_review_fields({}) == []
