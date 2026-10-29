"""A second opinion on "does this sentence claim the top rank?", asked of an embedding model.

`report_claims._SUPERLATIVES` answers that question with a word list, and a word list can only ever
answer it for the wordings somebody thought of. Nine repairs in three days (V205–V213) all have the
same shape, and V208 is the expensive one: `prépondérant` was not in the French list, so a false
claim to the top reached a delivered PDF. The list is now long, and the next wording nobody listed
is still invisible to it.

So this module asks the same question a different way: embed the sentence, take the cosine against a
handful of hand-written prototype claims in the same language, and subtract the cosine against
hand-written ordinary report prose. The subtraction is what makes it work at all — inside one domain
*everything* is fairly similar to everything, so an absolute cosine has no usable threshold, while
the *difference* between "closer to a claim" and "closer to boilerplate" does.

Three properties are load-bearing, and each is a constraint rather than a feature:

* **It only ever adds.** `ClaimDetector.candidates` returns sentences; nothing here can remove one the
  word list found, because nothing here is consulted about the word list's hits. Every existing
  guard (`vertu`, `Gründe`, `espaces verts`, `secondary data`, `segundo a norma ISO 14044`,
  `El dominio de aplicación`, `estimations propres`) is therefore unaffected by construction.
* **It never decides whether the claim is true.** That is arithmetic against the ranking and stays
  where it is, in `report_claims`. This function returns a sentence, not a verdict.
* **It cannot refuse a chapter.** The finding built from a candidate carries an advisory `kind`
  (see `report_claims.check_claims`), so the gate stores the chapter either way. A model that
  cannot be audited must not hold the door shut.

Not a stemmer, deliberately. The runtime stemmer that was tried and rejected blocked ordinary German
prose — Snowball collapses *bedeutendste* to *bedeut*, so "Das bedeutet, dass…" became a claim to the
top. The failure mode of a stemmer is that it is *confidently* wrong about a word; the failure mode
here is a score near the threshold, which is why the threshold has a margin and the finding advises.

**What it costs**, measured with bge-m3 on this machine's eight CPU cores, warm: ~95 ms per sentence
in a batch, 3.7 s for forty, 8.6 s to load the weights the first time. The word list it stands beside
costs 265 µs per sentence. Four hundred times is not a rounding error, and it is why nothing calls
this by default: `check_claims` takes a detector as an argument and does nothing without one, so a
caller that runs nine chapters on every keystroke keeps the millisecond it has today, and only a
caller whose round trip is already a paid model call — a store, a correction — can choose to pay.

**Measured against the whole corpus and dropped.** 34 reports,
252 written chapters, 2 722 sentences, five languages, split and snapshot as the gate does them. The
number that decided it is not the false-alarm rate but the reverse direction: the corpus holds **71
rank claims we already know about** (12 declared by the author, 54 advised by the word list plus
arithmetic, 5 refused) and this detector **misses 21 of them — 9 of the 12 the author declared
himself**. "The largest single process in the whole model is *flat glass production, uncoated* at …"
scores **−0.027** against a margin of 0.06; "é dominada pelo grupo Packaging" **+0.002**; "den größten
Einzelbeitrag" **+0.026**. Those sentences are this module's own prototypes — the margin was fitted on
96 short hand-written positives and does not survive report prose. On the other side: 372 hits the word
list is silent about, of which **10** lie in the population branch 3a can reach at all (21 sentences in
252 chapters) and **exactly one** is a real claim. And the timing above is wrong for real prose: the
median is **0.56 s** per sentence, not 95 ms.

Nothing calls this, and nothing should. It stays because deleting it means deleting branch 3a from
`report_claims` and 18 tests, for no runtime gain — this module is inert by construction.

Further figures from the same measurement: one real find in 34 reports at about 90 % false alarms
(only 17 chapters hold any sentence of the reachable kind). The wide variant — sentences with no number
at all — gives 254 hits, of which 12 of 45 hand-classified are real and 32 are noise (scope sentences,
cut-off sentences, negations, meta sentences about the ranking), roughly two useful and five false
notes per report, and none of them could be offered a declaration because the sentence holds no anchor.
Time: 0.4–0.7 s per real report sentence, so 4–5 s for a medium chapter and 13–36 s for a long one.
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: Canonical claims to the top, one shape per line — the phrasings the word list *already* covers.
#: That is the point: the list is the ground truth for "this is what a claim to the top looks like",
#: so the prototypes are drawn from it and every sentence this module adds beyond it is the model
#: generalising rather than a second word list written in sentences.
#:
#: Six per language, and no idiom among them ("the lion's share", "trägt die Hauptlast"): an idiom in
#: here would make the evaluation circular, because the idioms are exactly what has to be *found*.
_PROTOTYPES: dict[str, tuple[str, ...]] = {
    "en": (
        "Packaging is the largest contributor to the result.",
        "The result is dominated by the use phase.",
        "Transport accounts for the highest share of the total.",
        "The main contributor is the packaging.",
        "Distribution is the single biggest driver of the climate score.",
        "The dominance of the packaging is clear in every indicator.",
    ),
    "de": (
        "Die Verpackung ist der größte Beitrag zum Ergebnis.",
        "Das Ergebnis wird von der Nutzungsphase dominiert.",
        "Der Transport hat den höchsten Anteil am Gesamtergebnis.",
        "Der Hauptbeitrag kommt von der Verpackung.",
        "Hauptverursacher der Klimawirkung ist die Distribution.",
        "Die Dominanz der Verpackung zeigt sich in allen Indikatoren.",
    ),
    "fr": (
        "L'emballage est le plus grand contributeur au résultat.",
        "Le résultat est dominé par la phase d'utilisation.",
        "Le transport représente la part la plus élevée du total.",
        "Le contributeur principal est l'emballage.",
        "La distribution est le premier poste du bilan climatique.",
        "La prédominance de l'emballage est nette dans tous les indicateurs.",
    ),
    "es": (
        "El envase es el mayor contribuyente al resultado.",
        "El resultado está dominado por la fase de uso.",
        "El transporte representa la mayor parte del total.",
        "El contribuyente principal es el envase.",
        "La distribución es el principal impulsor del resultado climático.",
        "El predominio del envase es claro en todos los indicadores.",
    ),
    "pt": (
        "A embalagem é o maior contribuinte para o resultado.",
        "O resultado é dominado pela fase de uso.",
        "O transporte representa a maior parte do total.",
        "O contribuinte principal é a embalagem.",
        "A distribuição é o principal motor do resultado climático.",
        "O predomínio da embalagem é claro em todos os indicadores.",
    ),
}

#: Ordinary report prose, as the other pole. Goal and scope, method, data quality, allocation — the
#: sentence kinds a chapter is mostly *made of*, so that the score measures "more like a claim than
#: like the rest of the report" rather than "vaguely about an LCA".
#:
#: Disjoint from the sentences the evaluation measures on, on purpose: an anti-prototype that is also
#: a test negative would prove nothing about the sentences it has not seen.
_ANTI_PROTOTYPES: dict[str, tuple[str, ...]] = {
    "en": (
        "The study follows ISO 14040 and ISO 14044.",
        "Background data are taken from ecoinvent 3.12, cut-off.",
        "This chapter describes the goal and scope of the study.",
        "The reason for the deviation is documented in the annex.",
        "An important assumption concerns the transport distance.",
        "The results are reported per functional unit.",
    ),
    "de": (
        "Die Studie folgt den Normen ISO 14040 und ISO 14044.",
        "Die Hintergrunddaten stammen aus ecoinvent 3.12, cut-off.",
        "Dieses Kapitel beschreibt Ziel und Untersuchungsrahmen der Studie.",
        "Der Grund für die Abweichung ist im Anhang dokumentiert.",
        "Eine wichtige Annahme betrifft die Transportdistanz.",
        "Die Ergebnisse werden je funktioneller Einheit ausgewiesen.",
    ),
    "fr": (
        "L'étude suit les normes ISO 14040 et ISO 14044.",
        "Les données d'arrière-plan proviennent d'ecoinvent 3.12, cut-off.",
        "Ce chapitre décrit l'objectif et le champ de l'étude.",
        "La raison de l'écart est documentée en annexe.",
        "Une hypothèse importante porte sur la distance de transport.",
        "Les résultats sont rapportés par unité fonctionnelle.",
    ),
    "es": (
        "El estudio sigue las normas ISO 14040 e ISO 14044.",
        "Los datos de fondo proceden de ecoinvent 3.12, cut-off.",
        "Este capítulo describe el objetivo y el alcance del estudio.",
        "El motivo de la desviación está documentado en el anexo.",
        "Una hipótesis importante se refiere a la distancia de transporte.",
        "Los resultados se expresan por unidad funcional.",
    ),
    "pt": (
        "O estudo segue as normas ISO 14040 e ISO 14044.",
        "Os dados de fundo provêm do ecoinvent 3.12, cut-off.",
        "Este capítulo descreve o objetivo e o âmbito do estudo.",
        "O motivo do desvio está documentado no anexo.",
        "Uma hipótese importante diz respeito à distância de transporte.",
        "Os resultados são apresentados por unidade funcional.",
    ),
}

#: How far a sentence must lean towards the claim pole, and the one number here that is *fitted*
#: rather than reasoned. Measured on 96 positives / 87 hard negatives out of the modelling sessions and
#: the V208–V213 audit tables:
#:
#:     margin   positives   unlisted wordings   hard negatives
#:      0.06        97.9 %          100.0 %             6.9 %
#:      0.10        94.8 %           94.1 %             5.7 %
#:      0.16        81.2 %           73.5 %             0.0 %
#:
#: 0.06 is the knee, and the choice of the recall end of it is what "advisory" buys: the arithmetic
#: downstream discards a candidate that points at no ranking or at the leader, so most of those 6.9 %
#: never become a finding at all — while a wording the threshold misses is invisible to everything,
#: which is precisely how V208 reached a delivered PDF.
DEFAULT_MARGIN = 0.06

#: A placeholder is a path, not words. Left in, "{{contribution.groups.1.share_text}}" is a run of
#: subword tokens that says nothing about the claim and drags every sentence towards every other
#: sentence that carries one. Replaced by an ellipsis rather than deleted, so the sentence keeps its
#: shape ("The result is dominated by …").
_PLACEHOLDER = re.compile(r"\{\{.*?\}\}", re.DOTALL)


class _Provider(Protocol):
    def embed(self, texts: list[str], is_query: bool = False) -> Any: ...


def readable(sentence: str) -> str:
    return _PLACEHOLDER.sub("…", sentence).strip()


class ClaimDetector:
    """Prototype similarity over a shared embedding provider.

    The provider is handed in rather than built: the running app already holds one warm model for
    dataset search (`SearchService`), and a checker that ran on every store must not load a second
    copy of a 2 GB model — nor pay its cold start. A caller with no provider gets no candidates,
    which is the right degradation for an advisory: the word list is unaffected.
    """

    def __init__(self, provider: _Provider, margin: float = DEFAULT_MARGIN) -> None:
        self._provider = provider
        self._margin = margin
        self._poles: dict[str, tuple[Any, Any]] = {}
        self._lock = threading.Lock()

    def _poles_for(self, lang: str) -> tuple[Any, Any] | None:
        """The two embedded prototype sets for a language, computed once and kept.

        Twelve short sentences per language is a tenth of a second of the model's time, but it is a
        tenth of a second per chapter otherwise, and the sets never change at runtime.
        """
        if lang not in _PROTOTYPES:
            return None
        cached = self._poles.get(lang)
        if cached is None:
            with self._lock:
                cached = self._poles.get(lang)
                if cached is None:
                    claims = self._provider.embed(list(_PROTOTYPES[lang]))
                    prose = self._provider.embed(list(_ANTI_PROTOTYPES[lang]))
                    cached = (claims, prose)
                    self._poles[lang] = cached
        return cached

    def scores(self, sentences: list[str], lang: str) -> list[float]:
        """Per sentence: how much more it looks like a claim to the top than like report prose.

        All sentences in one `embed` call. Batched is roughly five times faster per sentence than one
        at a time on this CPU, and a chapter arrives as a whole — so the batch is the unit.
        """
        poles = self._poles_for(lang)
        if poles is None or not sentences:
            return [0.0] * len(sentences)
        claims, prose = poles
        vectors = self._provider.embed([readable(s) for s in sentences])
        # Every provider in `search.embeddings` returns L2-normalised rows, so a dot product IS the
        # cosine. Not re-normalised here on purpose: a provider that broke that contract would show
        # up as scores out of range, which is louder than a renormalisation that quietly repairs it.
        near_claim = vectors @ claims.T
        near_prose = vectors @ prose.T
        return [
            float(near_claim[i].max() - near_prose[i].max()) for i in range(len(sentences))
        ]

    def candidates(self, sentences: list[str], lang: str) -> list[str]:
        """The sentences that lean far enough towards the claim pole. Never a verdict, never a veto."""
        try:
            scores = self.scores(sentences, lang)
        except Exception:  # noqa: BLE001 — an advisory that raises would take the gate down with it
            logger.exception("claim detector unavailable; the word list stands alone")
            return []
        return [s for s, score in zip(sentences, scores, strict=True) if score >= self._margin]
