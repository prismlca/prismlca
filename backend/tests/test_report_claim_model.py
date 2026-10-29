"""The model may add a suspicion. It may not take a finding away, and it may not shut a door.

`report_claims._SUPERLATIVES` has been repaired nine times in three days (V205–V213), and the
failure that keeps coming back is the wording nobody listed — V208 shipped a false claim to a
delivered PDF because `prépondérant` was not in the French list. `report_claim_model` asks the same
question of an embedding model, in front of the same arithmetic.

Everything here runs on a stub provider. The point of these tests is the *contract* — only ever
additive, never blocking, guards intact — and a contract is testable without a 2 GB model; the
model's accuracy is a measurement, and a measurement does not belong in a test suite that has to
pass on a machine with no weights on it.
"""
from __future__ import annotations

import numpy as np
import pytest

from prism_lca.engine import report_claim_model as rcm
from prism_lca.engine import report_claims as rc
from prism_lca.engine import report_prompts as rp
from prism_lca.engine import report_staleness as rs

DATA = {
    "study": {},
    "results": [{"method_label": "IPCC", "unit": "kg CO2-eq", "score": 0.1195}],
    "hotspots": [
        {"name": "incineration", "database": "d", "code": "i", "share_percent": 51.9},
        {"name": "granulate", "database": "d", "code": "g", "share_percent": 41.6},
    ],
    "contribution": {
        "groups": [
            {"key": "End of life", "share_percent": 51.9, "share_text": "51.9 %"},
            {"key": "Raw materials", "share_percent": 41.6, "share_text": "41.6 %"},
        ]
    },
}
#: The figure of a member that is *not* the leader — what a false claim to the top stands next to.
RUNNER_UP = "{{contribution.groups.1.share_text}}"
LEADER = "{{contribution.groups.0.share_text}}"


class Always:
    """Says "claim" about every sentence it is shown. The adversary the guards have to survive."""

    def candidates(self, sentences: list[str], lang: str) -> list[str]:
        return list(sentences)


class Never:
    """Says nothing about anything — the proof that a silent model changes no existing verdict."""

    def candidates(self, sentences: list[str], lang: str) -> list[str]:
        return []


class Exploding:
    """A detector that is broken rather than absent — the state a half-installed model leaves."""

    def candidates(self, sentences: list[str], lang: str) -> list[str]:
        raise RuntimeError("no weights on this machine")


def kinds(text: str, lang: str = "en", detector: object | None = None) -> list[str]:
    return [f["kind"] for f in rc.check_claims(text, DATA, lang, detector=detector)]


# ---- the door: a model-suggested finding cannot refuse a chapter --------------------------------


def test_the_kind_a_candidate_carries_is_one_the_gate_does_not_block_on():
    """The whole safety argument in one assertion, and the reason the constant is not a new word:
    `ADVISORY_FINDINGS` is the set `check_proposal` excludes when it works out whether anything
    blocks, and the frontend keeps two copies of it by name. A new kind would have had to be added
    to three lists, and a model-suggested refusal is exactly what must be impossible."""
    assert rc.MODEL_CANDIDATE_KIND in rp.ADVISORY_FINDINGS


def test_a_candidate_advises_and_the_gate_still_stores_the_chapter():
    """"trägt die Hauptlast" is in no word list here, and the figure beside it is the runner-up. So
    the finding appears — and `ok` stays true, because an unaudited model must not hold the door."""
    text = f"Die Verpackung trägt die Hauptlast des Ergebnisses ({RUNNER_UP})."
    assert kinds(text, "de") == []  # without a detector: the word list sees nothing at all
    findings = rc.check_claims(text, DATA, "de", detector=Always())
    assert [f["kind"] for f in findings] == [rc.MODEL_CANDIDATE_KIND]
    assert findings[0]["sentence"] == text
    # The wording has to read as a suspicion, or an author treats it as a refusal and stops reading.
    assert "may be nothing" in findings[0]["detail"]
    blocking = [f for f in findings if f["kind"] not in rp.ADVISORY_FINDINGS]
    assert blocking == []


def test_the_full_gate_accepts_a_chapter_a_candidate_was_raised_about():
    """One level up from the kind: the verdict `check_proposal` returns, which is what the store
    reads. A chapter carrying nothing but a candidate is storable."""
    section = {"id": "s", "kind": "contribution", "title": "Contribution"}
    text = f"Die Verpackung trägt die Hauptlast des Ergebnisses ({RUNNER_UP})."
    verdict = rp.check_proposal(text, section, DATA, "de")
    assert verdict["ok"] is True
    # …and the finding the detector adds is of a kind that cannot change that answer.
    assert rc.MODEL_CANDIDATE_KIND in rp.ADVISORY_FINDINGS


# ---- the guards: everything the word list decided stays decided ---------------------------------


#: One sentence per guard the word lists earned the hard way, each with the finding it once cost.
#: Every one of them carries the runner-up's figure, which is the arrangement that makes the
#: superlative rule fire — so if the model could reach past a guard, it would show here.
GUARDED = (
    ("es", "El dominio de aplicación del estudio es la producción de envases", "V212 domain≠dominance"),
    ("es", "Los datos de dominio público se documentan en el anexo B", "V212"),
    ("pt", "O domínio de aplicação do estudo é a produção de embalagens", "V212"),
    ("pt", "Segundo a norma ISO 14044, a revisão crítica é obrigatória", "V213 segundo=according to"),
    ("fr", "Les calculs sont faits en vertu de la norme ISO 14044", "V207 vert→vertu"),
    ("fr", "Les espaces verts autour du site ne sont pas modélisés", "V207"),
    ("fr", "Les valeurs de fond reposent sur des estimations propres", "V205 propre=own"),
    ("de", "Die Gründe für die Abweichung sind dokumentiert", "V207 grün→Gründe"),
    ("en", "Secondary data was used for the background system", "V209 second→secondary"),
    ("de", "Weitere Annahmen sind im Anhang dokumentiert", "V209 weiter"),
    # The three the rejected runtime stemmer blocked: Snowball collapses *bedeutendste* to *bedeut*.
    ("de", "Das bedeutet, dass die Ergebnisse nur für diese funktionelle Einheit gelten", "stemmer"),
    ("de", "Ein wichtiger Beitrag kommt von der Datenqualität der Vorketten", "stemmer"),
    ("de", "Die Daten sind hoch aufgelöst und stammen aus dem Bezugsjahr 2024", "stemmer"),
)


@pytest.mark.parametrize(("lang", "sentence", "why"), GUARDED)
def test_a_guard_sentence_is_no_worse_off_than_it_was(lang: str, sentence: str, why: str) -> None:
    """The one property that matters more than recall: the word list's guards are not weakened.

    They cannot be, by construction — the model is asked only where the list matched no superlative
    at all, so there is no guard decision to overrule. This is that argument, measured: with a
    detector that calls *everything* a claim, the finding these sentences produce is at worst
    advisory, and never the refusal the word list once wrongly made.
    """
    text = f"{sentence} ({RUNNER_UP})."
    without = rc.check_claims(text, DATA, lang)
    with_model = rc.check_claims(text, DATA, lang, detector=Always())
    assert [f["kind"] for f in without] == [], why
    assert all(f["kind"] in rp.ADVISORY_FINDINGS for f in with_model), why


def test_the_model_cannot_take_a_word_list_finding_away():
    """A detector that says "no claim here" about a sentence the list condemns changes nothing.

    The suppression path does not exist: `check_claims` consults the detector in a branch that runs
    only where `_mentions` found no superlative, so a listed word is never put to a vote."""
    text = f"Der dominante Prozess ist {RUNNER_UP}."
    assert kinds(text, "de") == ["contradicted_claim"]
    assert kinds(text, "de", detector=Never()) == ["contradicted_claim"]
    assert kinds(text, "de", detector=Always()) == ["contradicted_claim"]


def test_the_comparative_exemption_is_not_reopened():
    """V210/V211: "A est plus important que B" states nothing about the top, and the exemption that
    says so drops the *word* rather than the sentence. So the branch that asks the model tests
    `_mentions`, not the surviving words — otherwise the model would be handed exactly the sentences
    the exemption exists to release, and the refusal V210 removed would come back as a note."""
    text = f"L'emballage est plus important que {RUNNER_UP}."
    assert kinds(text, "fr") == []
    assert kinds(text, "fr", detector=Always()) == []


def test_an_ordinal_still_disarms_a_wordless_candidate():
    """"An zweiter Stelle" uses no listed superlative, so the word list never reaches this sentence —
    but it is a statement about rank 2, and a candidate on it would be a false alarm the list never
    made. The ordinal guard therefore runs on the model's side of the branch too."""
    text = f"An zweiter Stelle steht die Distribution ({RUNNER_UP})."
    assert kinds(text, "de") == []
    assert kinds(text, "de", detector=Always()) == []


# ---- attribution: the model is never asked which member the claim is about ----------------------


def test_a_candidate_needs_exactly_one_ranked_anchor():
    """The model says "this claims a top rank"; *whose* rank stays positional. With two figures in
    the sentence there is no elimination to make, so the sentence is left to the author — the same
    restraint V175 had to be taught after a true sentence was refused over a member it mentioned in
    passing."""
    two = f"Die Verpackung trägt die Hauptlast ({RUNNER_UP}), gefolgt von der Distribution ({LEADER})."
    assert kinds(two, "de", detector=Always()) == []


def test_a_sentence_whose_figure_leads_is_not_a_candidate():
    """The arithmetic decides, and it decides the same way it does for the word list: a claim to the
    top standing next to the member that *is* the top is a true sentence."""
    text = f"Die Verpackung trägt die Hauptlast des Ergebnisses ({LEADER})."
    assert kinds(text, "de", detector=Always()) == []


def test_an_aggregate_is_not_a_claim_about_one_member():
    """Same exemption as V145: "together they account for {{sum(…)}}" is a figure about several
    members. `_superlative_anchors` already says so, and the candidate path reads it rather than
    re-deriving it."""
    text = (
        "Die Verpackung trägt die Hauptlast, zusammen "
        "{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} %."
    )
    assert kinds(text, "de", detector=Always()) == []


def test_a_sentence_with_no_figure_is_not_the_write_time_rule_s_business():
    """Where a claim has no figure, there is nothing to check it against at write time — that is
    `report_staleness.unanchored_claims`' question, asked once the ranking has changed hands."""
    assert kinds("Die Verpackung trägt die Hauptlast des Ergebnisses.", "de", detector=Always()) == []


# ---- robustness: an advisory must never be able to stop the gate --------------------------------


def test_a_detector_that_raises_is_not_an_obstacle():
    """A missing model is a normal state — the weights are a download, and PyInstaller builds have
    been without them before. An advisory that took the gate down with it would make every chapter
    unstorable over a nicety."""
    text = f"Die Verpackung trägt die Hauptlast des Ergebnisses ({RUNNER_UP})."
    # Both layers: the detector's own provider failing, and any detector object at all raising.
    assert kinds(text, "de", detector=rcm.ClaimDetector(_RaisingProvider())) == []
    assert kinds(text, "de", detector=Exploding()) == []


class _RaisingProvider:
    def embed(self, texts: list[str], is_query: bool = False):
        raise RuntimeError("model unavailable")


def test_no_detector_is_the_default_and_changes_nothing():
    """Every existing caller passes no detector, so the module has to behave exactly as before."""
    text = f"Die Verpackung trägt die Hauptlast des Ergebnisses ({RUNNER_UP})."
    assert rc.check_claims(text, DATA, "de") == []


# ---- the scoring itself, on a stub provider -----------------------------------------------------


class _StubProvider:
    """Two orthogonal directions: "claim" and "prose". A sentence is placed by which words it has.

    Enough to test the arithmetic of the margin without weights — and deliberately not enough to
    test the model's judgement, which is a measurement rather than an assertion.
    """

    #: Every prototype sits on the claim axis and every anti-prototype on the prose axis, by
    #: membership rather than by keyword — a keyword rule would place some prototypes on the wrong
    #: axis and the margin would then measure the stub instead of the code under test.
    _CLAIM_WORDS = ("largest", "dominat", "highest", "hauptlast")

    def embed(self, texts: list[str], is_query: bool = False):
        claims = {s for group in rcm._PROTOTYPES.values() for s in group}
        out = np.zeros((len(texts), 2), dtype="float32")
        for i, text in enumerate(texts):
            claimish = text in claims or any(w in text.lower() for w in self._CLAIM_WORDS)
            out[i] = (1.0, 0.0) if claimish else (0.0, 1.0)
        return out


def test_the_score_is_the_distance_between_the_two_poles():
    det = rcm.ClaimDetector(_StubProvider())
    claim, prose = det.scores(
        ["Packaging carries the Hauptlast.", "The study follows ISO 14044."], "en"
    )
    assert claim == pytest.approx(1.0)
    assert prose == pytest.approx(-1.0)
    assert det.candidates(
        ["Packaging carries the Hauptlast.", "The study follows ISO 14044."], "en"
    ) == ["Packaging carries the Hauptlast."]


def test_a_placeholder_is_not_words():
    """"{{contribution.groups.1.share_text}}" is a path. Left in the sentence it is a run of subword
    tokens that says nothing about the claim and pulls every sentence carrying one towards every
    other — so it becomes an ellipsis, and the sentence keeps its shape."""
    assert rcm.readable(f"The result is dominated by {RUNNER_UP}.") == "The result is dominated by …."


def test_every_report_language_has_both_poles():
    """A language with prototypes and no anti-prototypes would score every sentence against nothing,
    and one with neither silently opts out. Both are bugs that only show as a missing finding."""
    from prism_lca.engine.report_i18n import LANGUAGES

    for code in LANGUAGES:
        assert code in rcm._PROTOTYPES, code
        assert code in rcm._ANTI_PROTOTYPES, code


def test_an_unknown_language_scores_nothing_rather_than_guessing():
    det = rcm.ClaimDetector(_StubProvider())
    assert det.candidates(["Packaging carries the Hauptlast."], "it") == []


# ---- the word list, unchanged --------------------------------------------------------------------


def test_the_staleness_rule_is_untouched_by_all_of_this():
    """The other reader of `_SUPERLATIVES` never sees a detector at all — stated as a test so that a
    later wiring has to come past this file."""
    sentence = "Die Verpackung trägt die Hauptlast des Ergebnisses."
    assert rs.unanchored_claims(sentence, "de") == []
    assert rs.unanchored_claims("Die Verpackung dominiert das Ergebnis.", "de") == [
        ("Die Verpackung dominiert das Ergebnis.", "dominiert")
    ]
