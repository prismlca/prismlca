"""What a chapter asserts, checked arithmetically.

The blind spot this closes, in one sentence: "the thicker variant is {{change(a, b)}} lower than the
baseline" used to pass everything. The number is right — we compute it. The word *lower* was checked by
nothing. FinGround (arXiv 2604.23588) measures that generic detectors miss 43 % of computational errors for
exactly this reason: they never re-verify against the table. Here the numeric path uses no model at all.

The second thing these tests protect is restraint. A checker that fires on correct prose gets switched off,
so every rule needs its trigger and its operands in one sentence, and the honest cases below must stay
silent.
"""
from __future__ import annotations

from prism_lca.engine import report_claims as rc
from prism_lca.engine import report_prompts as rp

DATA = {
    "study": {},
    "results": [{"method_label": "IPCC", "unit": "kg CO2-eq", "score": 0.1195}],
    "subjects": [
        {"label": "Baseline", "code": "a", "results": [{"method_label": "IPCC", "score": 0.1195}]},
        {"label": "Thicker bag", "code": "b", "results": [{"method_label": "IPCC", "score": 0.179}]},
    ],
    "hotspots": [
        {"name": "incineration", "database": "d", "code": "i", "share_percent": 51.9, "direct": 0.062},
        {"name": "granulate", "database": "d", "code": "g", "share_percent": 41.6, "direct": 0.0497},
    ],
    "contribution": {"groups": [{"key": "End of life", "share_percent": 51.9}, {"key": "Raw materials", "share_percent": 41.6}]},
}
CHANGE = "{{change(subjects.1.results.0.score, subjects.0.results.0.score)}}"


def kinds(text: str, lang: str = "en") -> list[str]:
    return [f["kind"] for f in rc.check_claims(text, DATA, lang)]


def refusing(findings: list[dict]) -> list[str]:
    """The kinds among these findings that would refuse the chapter — the rest are notes.

    Needed since the declaration advisory: a rank claim that is *true* and written in prose now gets a
    suggestion to declare it (`{{rank:…}}`), so "this sentence is not refused" and "this sentence
    produces nothing at all" stopped being the same assertion. Where a test means the first — every
    case below that exists to prove a correct wording is allowed — it says so through this.
    """
    return [f["kind"] for f in findings if f["kind"] not in rp.ADVISORY_FINDINGS]


def blocking(text: str, lang: str = "en") -> list[str]:
    return refusing(rc.check_claims(text, DATA, lang))



def test_a_correct_name_beside_its_own_pinned_figure_is_not_misbound(  # V297
):
    """The pin carries the member's label beside its identity (`@name`); the member scan does not.
    Compared raw, the same member never equalled its own pin, and "Rohstoffe mit {{…share_text}}"
    was refused with a message naming the same member twice — three findings, one blocked chapter."""
    from prism_lca.engine import report_claims as rc
    from prism_lca.engine import report_data as rd

    data = {
        "contribution": {
            "dimension": "Life-cycle phase",
            "unit": "kg",
            "groups": [
                {"key": "End-of-Life", "label": "End-of-Life", "share_text": "38.1 %"},
                {"key": "Rohstoffe", "label": "Rohstoffe", "share_text": "30.0 %"},
            ],
        }
    }
    text = "Auf End-of-Life folgen Rohstoffe mit {{contribution.groups.1.share_text}}."
    findings = rc.misbound_names(text, data, rd.bindings_for(text, data))
    assert findings == []

    # The check itself stays alive: the same sentence pinned to the OTHER member is still refused.
    wrong = "Auf End-of-Life folgen Rohstoffe mit {{contribution.groups.0.share_text}}."
    findings = rc.misbound_names(wrong, data, rd.bindings_for(wrong, data))
    assert [f["kind"] for f in findings] == ["misbound_name"]

def test_an_inverted_direction_is_caught_and_the_correct_one_is_not():
    assert kinds(f"The thicker variant is {CHANGE} higher than the baseline.") == []
    findings = rc.check_claims(f"The thicker variant is {CHANGE} lower than the baseline.", DATA)
    assert [f["kind"] for f in findings] == ["contradicted_claim"]
    # The message has to name the fix, not just the fault.
    assert "swap the two arguments" in findings[0]["detail"]


def test_a_comparison_between_two_placeholders_is_checked_against_the_values():
    wrong = "{{subjects.0.results.0.score}} is higher than {{subjects.1.results.0.score}}."
    right = "{{subjects.1.results.0.score}} is higher than {{subjects.0.results.0.score}}."
    assert kinds(wrong) == ["contradicted_claim"]
    assert kinds(right) == []


def test_a_superlative_must_name_the_top_of_the_ranking():
    assert blocking("The dominant process is {{hotspots.0.name}}.") == []
    assert kinds("The dominant process is {{hotspots.1.name}}.") == ["contradicted_claim"]
    # …and it applies to the other ranked lists too.
    assert kinds("The largest share falls on {{contribution.groups.2.key}}.") == ["contradicted_claim"]


def test_a_causal_sentence_is_reported_once_and_never_blocks():
    # Placeholders, not typed digits: a literal figure is refused by a different rule, and what is
    # under test is that three causal sentences produce ONE remark.
    share = "{{hotspots.0.share_percent}} %"
    text = (
        f"The result is driven by the incineration, at {share}. Raw materials matter because the "
        f"polymer is fossil, {share}, and the score is high due to the feedstock, {share}."
    )
    findings = rc.check_claims(text, DATA)
    assert [f["kind"] for f in findings] == ["unverifiable_claim"]  # one finding, not three
    verdict = rp.check_proposal(text, {"kind": "prose"}, DATA)
    assert verdict["ok"], "an unverifiable claim must not stop a chapter from being stored"
    assert verdict["findings"]


def test_a_because_that_explains_a_method_and_not_a_number_is_left_alone():
    """V250. The note says the data can show what is large and never why — true of a sentence about a
    result, false of one about a convention. Firing on every "because" caught six of the nine chapters
    of a wood-stain report with one identical remark, which is how a note stops being read
    and buries the findings beside it."""
    for sentence in (
        "The press cake leaves the system burden-free because of the cut-off principle.",
        "The system boundary ends at the store because the customer trip depends on the individual.",
        "Refining is omitted because cold pressing is customary for natural paints.",
    ):
        findings = rc.check_claims(sentence, DATA)
        assert not [f for f in findings if f["kind"] == "unverifiable_claim"], sentence


def test_a_contradiction_does_block():
    verdict = rp.check_proposal(f"It is {CHANGE} lower than the baseline.", {"kind": "prose"}, DATA)
    assert not verdict["ok"]


def test_placeholders_are_not_torn_apart_by_the_sentence_split():
    """The bug that made every numeric rule silently useless: a path is full of dots, so splitting the raw
    text on "." cut the tokens in half and no rule ever found its operands."""
    sentences = rc._sentences(f"First {CHANGE} sentence. Second one.")
    assert len(sentences) == 2
    assert CHANGE in sentences[0]


def test_honest_prose_stays_silent():
    """Restraint, case by case: no comparison word, a comparison with only one operand, a superlative with
    no ranked index. (Equal numbers under "higher" used to be on this list; they are now a
    contradiction — see `test_equal_values_contradict_a_direction_claim`.)"""
    for text in [
        "The bag scores {{results.0.score}} {{results.0.unit}} per functional unit.",
        "The score is higher than expected for such a light product.",
        "Incineration is the dominant pathway in this study.",
    ]:
        assert kinds(text) == [], text


def test_the_check_works_in_the_report_language():
    """The comparison vocabulary is per language, like everything else in the report."""
    assert kinds(f"Die dickere Variante liegt {CHANGE} niedriger als die Baseline.", "de") == ["contradicted_claim"]
    assert kinds(f"Die dickere Variante liegt {CHANGE} höher als die Baseline.", "de") == []
    assert kinds("Der dominante Prozess ist {{hotspots.1.name}}.", "de") == ["contradicted_claim"]


# ---- what the field found: two false positives, caught by Nemotron's own prose ------------------
def test_an_ordinal_disarms_the_superlative_rule():
    """"The raw-materials phase is the second-largest contributor at {{contribution.groups.1.…}}" is
    correct, natural, and was the checker's first false positive in a real run. An ordinal in the sentence
    means the claim is about rank, not about the top.

    Asserted through `blocking`, because since the ordinal half of the declaration advisory such a
    sentence is *advised* to declare the rank it names — a note, never a refusal. What must not happen
    is the refusal, and that is what this test is about."""
    assert blocking("Raw materials are the second-largest contributor at {{contribution.groups.1.share_percent}}.") == []
    assert blocking("Der zweitgrößte Beitrag ist {{contribution.groups.1.key}}.", "de") == []
    # The real error is still caught.
    assert kinds("The largest contributor is {{contribution.groups.1.key}}.") == ["contradicted_claim"]


def test_a_version_number_in_a_dataset_name_does_not_split_the_sentence():
    """"ecoinvent-3.12-cutoff" used to end a sentence at "3." and start a new one at "12-cutoff".

    That is the split direction that makes the checker *wrong* rather than cautious: the ordinal that
    disarms the superlative rule stayed in the first half while "largest" moved to the second, so a
    correct sentence was reported as a contradiction. The database name is in nearly every report.
    """
    text = (
        "The second-largest contributor is incineration from ecoinvent-3.12-cutoff "
        "({{hotspots.1.share_percent}} %), the largest is granulate."
    )
    assert len(rc._sentences(text)) == 1
    assert kinds(text) == []


def test_an_operand_of_a_sum_is_not_the_subject_of_the_superlative():
    """"X is the largest, and together they account for {{sum(…0…, …1…)}} %" is ordinary prose.

    The rule flattened the derivation's arguments and condemned the sentence over the index-1
    operand inside the sum — an aggregate is not a claim about either of the things it adds up.
    """
    ok = (
        "End of life is the largest phase, and together with raw materials it accounts for "
        "{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} %."
    )
    assert kinds(ok) == []
    # A plain citation of the wrong index is still caught, alone or beside a sum.
    assert kinds("The largest contributor is {{contribution.groups.1.key}}.") == ["contradicted_claim"]
    assert kinds(
        "The largest is {{contribution.groups.1.key}}, together "
        "{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} %."
    ) == ["contradicted_claim"]


def test_a_superlative_may_sit_on_the_index_whose_member_now_leads():
    """An index is not a rank — it is pinned to a member, and members change places.

    After a reordering the only correct wording puts "the largest" on the index bound to the member
    that now leads. The positional rule refused exactly that, so a rank change could not be corrected
    at all: the staleness check demanded the fix and the gate rejected it.
    """
    text = "The largest single contributor is {{hotspots.1.name}}."
    # Unbound, the positional rule stands.
    assert kinds(text) == ["contradicted_claim"]
    # Bound to the member that leads the list today: true, and allowed.
    bound_to_leader = {"hotspots.1": {"database": "d", "code": "i"}}
    allowed = rc.check_claims(text, DATA, bindings=bound_to_leader)
    assert refusing(allowed) == []
    # …and the declaration the advisory offers is the *pinned* index, not index 0: what the sentence is
    # about is the member, and the pin is where the member lives.
    assert [f["kind"] for f in allowed] == [rc.ADVISORY_KIND]
    assert "{{rank:hotspots.1}}" in allowed[0]["detail"]
    # Bound to the runner-up: still false, still caught.
    bound_to_second = {"hotspots.1": {"database": "d", "code": "g"}}
    assert [f["kind"] for f in rc.check_claims(text, DATA, bindings=bound_to_second)] == [
        "contradicted_claim"
    ]


# --- the superlative belongs to one member, not to the sentence (V175) ------------------

#: The phase breakdown after a parameter change that swapped the top two: Distribution now leads, and
#: the chapter's pins still point each index at the member it was written about.
RANK_SWAP = {
    "results": [{"method_label": "IPCC", "unit": "kg CO2-eq", "score": 0.3}],
    "contribution": {
        "groups": [
            {"key": "Distribution", "share_percent": 61.1, "share_text": "61.1 %"},
            {"key": "Packaging", "share_percent": 22.4, "share_text": "22.4 %"},
            {"key": "End-of-life", "share_percent": 8.2, "share_text": "8.2 %"},
            {"key": "Raw materials & production", "share_percent": 8.3, "share_text": "8.3 %"},
        ]
    },
}
RANK_SWAP_PINS = {
    "contribution.groups.0": {"key": "Packaging"},
    "contribution.groups.1": {"key": "Distribution"},
    "contribution.groups.3": {"key": "Raw materials & production"},
}


def test_a_superlative_is_judged_on_the_member_it_is_attributed_to():
    """A sentence may mention a small member without claiming it is the largest.

    Measured on a real chapter: after the ranks swapped, the correction moved "dominates"
    onto Distribution — which does lead the list — and the gate refused the result anyway, over
    `groups.3`, the member the very same sentence describes with the word *only*. The rule condemned
    every ranked index in the sentence because it had no notion of which one the superlative was about.
    The cost was not one sentence: a rejection discards the whole patch, so two unrelated and correct
    corrections went down with it, and the chapter was stuck between a staleness check demanding the fix
    and a claim check refusing it.
    """
    true_sentence = (
        "Climate change, expressed as global warming potential (GWP100), amounts to "
        "{{results.0.score}} {{results.0.unit}}; in the life-cycle phase breakdown Packaging "
        "({{contribution.groups.0.share_text}}) is important, and Distribution "
        "({{contribution.groups.1.share_text}}) dominates, while the formulation chemistry itself "
        "(Raw materials & production) contributes only {{contribution.groups.3.share_text}}."
    )
    assert refusing(rc.check_claims(true_sentence, RANK_SWAP, "en", RANK_SWAP_PINS)) == []
    # The superlative on the member that does *not* lead is still a contradiction — and the sentence
    # naming the true leader elsewhere does not excuse it.
    wrong = (
        "Raw materials & production ({{contribution.groups.3.share_text}}) dominates, while "
        "Distribution ({{contribution.groups.1.share_text}}) is a smaller part of the profile."
    )
    findings = rc.check_claims(wrong, RANK_SWAP, "en", RANK_SWAP_PINS)
    assert [f["kind"] for f in findings] == ["contradicted_claim"]
    assert "contribution.groups.3" in findings[0]["detail"]


def test_the_leader_named_without_a_figure_still_carries_the_superlative():
    """"Distribution, the largest phase, is followed by Packaging ({{…groups.1…}})" is correct prose.

    The superlative stands next to a name, not next to a figure, and the nearest figure belongs to the
    runner-up. Read off that figure the rule condemns a true sentence — so the name of the member that
    leads the list today counts as the subject when it is closer than any placeholder. Only the leader's
    name, and only to disarm: a name can never make a *refusal*, and a tie goes to the figure.

    It can make a suggestion, and this is the sentence where that suggestion is worth most: the word
    *Distribution* is exactly what `{{rank:contribution.groups.0}}` prints, so declaring the claim is a
    replacement that changes no printed word.
    """
    ok = "Distribution, the largest phase, is followed by Packaging ({{contribution.groups.1.share_text}})."
    found = rc.check_claims(ok, RANK_SWAP, "en")
    assert refusing(found) == []
    assert [f["kind"] for f in found] == [rc.ADVISORY_KIND]
    assert "{{rank:contribution.groups.0}}" in found[0]["detail"]
    assert "“Distribution”" in found[0]["detail"]
    # A *non*-leading name in that position changes nothing: the sentence falls back to the figure
    # beside the superlative, and the false claim is still caught.
    wrong = "Packaging, the largest phase, is followed by End-of-life ({{contribution.groups.2.share_text}})."
    assert [f["kind"] for f in rc.check_claims(wrong, RANK_SWAP, "en")] == ["contradicted_claim"]


def test_one_finding_per_sentence_not_per_placeholder():
    """The same sentence was reported nine times, once per placeholder in it. A checker that repeats itself
    is one people switch off."""
    text = (
        "The largest share falls on {{contribution.groups.1.key}} with "
        "{{contribution.groups.1.share_percent}} and {{hotspots.1.name}}."
    )
    findings = rc.check_claims(text, DATA)
    assert len(findings) == 1
    # …and it names every offending reference, so nothing is hidden by the deduplication.
    assert "contribution.groups.1" in findings[0]["detail"] and "hotspots.1" in findings[0]["detail"]
    assert "second-largest" in findings[0]["detail"]  # the message offers the honest alternative


# ---- value judgements and neutrality claims ------------------------------------------
def test_an_absolute_value_judgement_is_reported_as_a_note():
    """An LCA reports indicator results. "environmentally friendly" is not one of them, and nothing in
    the report supports it — but it can sit inside a quotation, so it advises rather than blocks."""
    from prism_lca.engine.report_claims import check_claims

    found = check_claims("The bag is environmentally friendly.", {}, "en")
    assert [f for f in found if f["kind"] == "value_judgement"]


def test_the_comparative_is_allowed():
    """The rule: "umweltfreundlicher" is a statement about two numbers, "umweltfreundlich" is not.
    German morphology cannot separate them ("umweltfreundlicher Prozess" is a positive form), so the
    comparison word is the signal."""
    from prism_lca.engine.report_claims import check_claims

    assert not [
        f
        for f in check_claims("Variante A ist umweltfreundlicher als Variante B.", {}, "de")
        if f["kind"] == "value_judgement"
    ]
    assert [
        f for f in check_claims("Die Tüte ist umweltfreundlich.", {}, "de") if f["kind"] == "value_judgement"
    ]


def _value_hits(text: str, lang: str) -> list[str]:
    return [f["detail"] for f in rc.check_claims(text, {}, lang) if f["kind"] == "value_judgement"]


#: The six sentences that made the French list fire in a real report — in all six "propre" means "own".
_OWN_NOT_CLEAN = (
    "Les valeurs de fond reposent sur des estimations propres.",
    "Nous avons utilisé des estimations propres pour l'emballage.",
    "Le tableau combine des données ecoinvent et des estimations propres.",
    "Les facteurs manquants ont été remplacés par des estimations propres.",
    "La masse de l'emballage repose sur des estimations propres.",
    "Les indicateurs sont exprimés dans leurs unités propres.",
)


def test_french_propre_no_longer_reads_our_own_estimates_as_a_boast():
    """Seven notes in one run, all false, five of them the same phrase: "des estimations propres".

    French "propre" is "own" before it is "clean", so the bare word could only be wrong here — the
    sentences it fired on were the honest ones, admitting where the data came from."""
    for sentence in _OWN_NOT_CLEAN:
        assert _value_hits(sentence, "fr") == [], sentence


def test_french_propre_still_catches_the_boast_it_exists_for():
    """Next to the thing being praised, the same word is the claim the rule is for."""
    for sentence in (
        "Cette technologie propre réduit les émissions de l'usine.",
        "Les technologies propres sont privilégiées dans ce scénario.",
        "Le mix du scénario B repose sur une énergie propre.",
        "Le procédé propre remplace l'incinération.",
        "Le scénario B est plus propre.",
    ):
        assert _value_hits(sentence, "fr"), sentence


def test_the_french_comparative_drops_out_like_the_german_one():
    """The entry "plus propre" leaves the comparison word to do the work, as "umweltfreundlicher" does
    in German — verified rather than assumed, because the French `_THAN` is the everyday "que"."""
    assert _value_hits("Le scénario B est plus propre que le scénario A.", "fr") == []


def test_a_neutrality_claim_is_flagged_even_as_a_comparison():
    """Not loose wording but a claim with a definition (offsetting, scope, permanence) that an
    indicator result cannot carry."""
    from prism_lca.engine.report_claims import check_claims

    found = check_claims("Das Produkt ist klimaneutraler als das Vergleichsprodukt.", {}, "de")
    detail = " ".join(f["detail"] for f in found if f["kind"] == "value_judgement")
    assert "neutrality" in detail


# ---- differences too small to carry a claim -------------------------------------------
_CLOSE = {
    "subjects": [
        {"code": "a", "results": [{"method_label": "climate change", "score": 0.1000, "unit": "kg CO2-Eq"}]},
        {"code": "b", "results": [{"method_label": "climate change", "score": 0.1020, "unit": "kg CO2-Eq"}]},
    ]
}


def test_a_two_percent_difference_is_advised_against():
    from prism_lca.engine.report_claims import check_claims

    found = check_claims(
        "{{subjects.1.results.0.score}} is higher than {{subjects.0.results.0.score}}.", _CLOSE, "en"
    )
    weak = [f for f in found if f["kind"] == "weak_difference"]
    assert weak and "2 %" in weak[0]["detail"] and "5 %" in weak[0]["detail"]


def test_the_threshold_is_configurable_and_a_large_gap_stays_silent():
    from prism_lca.engine.report_claims import check_claims

    assert not [
        f
        for f in check_claims(
            "{{subjects.1.results.0.score}} is higher than {{subjects.0.results.0.score}}.",
            _CLOSE,
            "en",
            weak_percent=1.0,
        )
        if f["kind"] == "weak_difference"
    ]
    far = {
        "subjects": [
            {"code": "a", "results": [{"method_label": "m", "score": 0.10, "unit": "kg"}]},
            {"code": "b", "results": [{"method_label": "m", "score": 0.20, "unit": "kg"}]},
        ]
    }
    assert not [
        f
        for f in check_claims(
            "{{subjects.1.results.0.score}} is higher than {{subjects.0.results.0.score}}.", far, "en"
        )
        if f["kind"] == "weak_difference"
    ]


def test_a_contradiction_still_wins_over_the_weak_difference_note():
    """Direction first: a sentence claiming the wrong direction gets the blocking finding, not the
    advisory one — otherwise the real error would read as a matter of taste."""
    from prism_lca.engine.report_claims import check_claims

    found = check_claims(
        "{{subjects.0.results.0.score}} is higher than {{subjects.1.results.0.score}}.", _CLOSE, "en"
    )
    kinds = {f["kind"] for f in found}
    assert "contradicted_claim" in kinds and "weak_difference" not in kinds


def test_a_sentence_carrying_both_directions_is_left_alone():
    """"higher than the baseline, but lower than variant C" — the direction words are sentence-wide
    while the rules judge a single pair, so one branch was guaranteed to fire on a correct sentence.
    Ambiguous is left alone, the module's standing policy."""
    data = {
        "subjects": [
            {"label": "Baseline", "results": [{"score": 1.0}]},
            {"label": "B", "results": [{"score": 2.0}]},
            {"label": "C", "results": [{"score": 3.0}]},
        ]
    }
    text = (
        "Variant B scores {{subjects.1.results.0.score}}, higher than the baseline's "
        "{{subjects.0.results.0.score}} but lower than variant C's {{subjects.2.results.0.score}}."
    )
    findings = rc.check_claims(text, data, "en")
    assert not [f for f in findings if f["kind"] == "contradicted_claim"], findings


def test_a_superlative_about_a_subject_is_not_a_rank_claim():
    """`subjects`/`results` are structure-ordered; the checker used to reply "the largest is
    subjects.0" — an instruction to assert a falsehood. Magnitude-ranked lists keep the rule."""
    data = {
        "subjects": [
            {"label": "Baseline", "results": [{"score": 1.0}]},
            {"label": "B", "results": [{"score": 5.0}]},
        ],
        "hotspots": [
            {"name": "a", "direct": 5.0},
            {"name": "b", "direct": 1.0},
        ],
    }
    ok = rc.check_claims("The highest impact falls on {{subjects.1.label}}.", data, "en")
    assert not [f for f in ok if f["kind"] == "contradicted_claim"], ok
    still = rc.check_claims("The largest contributor is {{hotspots.1.name}}.", data, "en")
    assert [f for f in still if f["kind"] == "contradicted_claim"], still


# --- the figure and the name must belong to the same member (V146) ---------------------

MISBOUND_DATA = {
    "hotspots": [
        {
            "name": "transport, freight, light commercial vehicle, fleet average",
            "database": "ecoinvent-3.12-cutoff",
            "code": "lcv",
            "share_text": "30.7 %",
        },
        {
            "name": "heat production, natural gas, at industrial furnace >100kW",
            "database": "ecoinvent-3.12-cutoff",
            "code": "heat",
            "share_text": "16.7 %",
        },
    ],
    "contribution": {
        "groups": [
            {"key": "Distribution", "share_percent": 58.9},
            {"key": "Production", "share_percent": 33.7},
        ]
    },
}
LCV = {
    "database": "ecoinvent-3.12-cutoff",
    "code": "lcv",
    "name": "transport, freight, light commercial vehicle, fleet average",
}
HEAT = {
    "database": "ecoinvent-3.12-cutoff",
    "code": "heat",
    "name": "heat production, natural gas, at industrial furnace >100kW",
}
SWAPPED = (
    "The second-largest contributing dataset is heat production, natural gas, at industrial furnace "
    ">100kW ({{hotspots.0.share_text}}); the largest contributing dataset is transport, freight, "
    "light commercial vehicle, fleet average ({{hotspots.1.share_text}})."
)


def test_a_name_and_a_figure_from_different_members_is_caught():
    """The defect that walked through every other gate: the pins were swapped under the prose.

    The placeholder resolved, no gap was printed, and the superlative rule was consistent with the new
    pins — so a chapter claiming "the second-largest … (30.7 %) … the largest … (16.7 %)" rendered.
    """
    findings = rc.misbound_names(SWAPPED, MISBOUND_DATA, {"hotspots.0": LCV, "hotspots.1": HEAT})
    assert len(findings) == 2
    assert all(f["kind"] == "misbound_name" for f in findings)
    assert "heat production" in findings[0]["detail"]


def test_the_same_sentence_with_the_right_pins_is_silent():
    assert rc.misbound_names(SWAPPED, MISBOUND_DATA, {"hotspots.0": HEAT, "hotspots.1": LCV}) == []
    # No pins at all: nothing is claimed about which member a figure belongs to.
    assert rc.misbound_names(SWAPPED, MISBOUND_DATA, {}) == []


def test_a_misbound_name_blocks_the_gate():
    """Advisory would be the wrong severity: a wrong figure under a right name must not be stored."""
    from prism_lca.engine import report_prompts as _rp

    assert "misbound_name" not in _rp.ADVISORY_FINDINGS


def test_a_total_belongs_to_no_single_name():
    """"Distribution …, followed by Production, and together they account for {{sum(…)}}" is correct.

    The nearest name before the placeholder is Production, and the sum's first operand is pinned to
    Distribution — read naively that is a mismatch, and the rule fired on a correct executive summary.
    """
    text = (
        "The climate impact concentrates in two phases: Distribution leads, followed by Production, "
        "and together they account for "
        "{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} %."
    )
    pins = {
        "contribution.groups.0": {"key": "Distribution"},
        "contribution.groups.1": {"key": "Production"},
    }
    assert rc.misbound_names(text, MISBOUND_DATA, pins) == []


def test_a_difference_belongs_to_both_names_it_compares():
    """V163: `diff(a, b)` is about two members, so the nearest name in front of it decides nothing.

    "Packaging (x) and Raw materials & production (y) sit only {{diff(…0…, …1…)}} percentage points
    apart" is correct prose. Read naively, the nearest name before the derivation is the *second*
    member while its first operand is pinned to the first — a mismatch that is an artefact of word
    order. In an apple-juice run this fired on an untouched sentence and refused the
    correction the staleness check had asked for; the chapter was left needing a full rewrite.
    """
    text = (
        "Packaging ({{contribution.groups.0.share_text}}) and Raw materials "
        "({{contribution.groups.1.share_text}}) sit only "
        "{{diff(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} "
        "percentage points apart."
    )
    pins = {
        "contribution.groups.0": {"key": "Packaging"},
        "contribution.groups.1": {"key": "Raw materials"},
    }
    # The ranking has swapped under the chapter — which is exactly when this fired.
    data = {
        "contribution": {
            "groups": [
                {"key": "Raw materials", "share_percent": 60.1},
                {"key": "Packaging", "share_percent": 18.9},
            ]
        }
    }
    assert rc.misbound_names(text, data, pins) == []
    # The protection itself is untouched: a plain single-member placeholder under the wrong name is
    # still caught.
    swapped = "Raw materials contributes {{contribution.groups.0.share_text}} of the total."
    assert len(rc.misbound_names(swapped, data, pins)) == 1


def test_prose_that_names_nothing_from_the_list_is_left_alone():
    """Restraint: a sentence describing a dataset without naming it says nothing to contradict."""
    text = "The parcel last mile carries {{hotspots.0.share_text}} of the climate score."
    assert rc.misbound_names(text, MISBOUND_DATA, {"hotspots.0": HEAT}) == []


def test_subject_labels_are_not_matched():
    """Subject and method labels are translated and paraphrased in prose — matching them is noise.

    A German study printed in an English report says "Few cycles (5)" for a subject stored as
    "Wenige Umläufe (5)", so the nearest recognised label before a subject placeholder was regularly
    the wrong one and the rule fired on a correct summary.
    """
    data = {
        "subjects": [
            {"label": "Baseline", "code": "a"},
            {"label": "Wenige Umläufe (5)", "code": "a", "scenario": "s1"},
        ]
    }
    text = "It is 1.21 in the Baseline; Few cycles (5) reaches {{subjects.1.label}}."
    assert rc.misbound_names(text, data, {"subjects.1": {"code": "a", "scenario": "s1"}}) == []


# --- V160: a name the list no longer contains ----------------------------------------------------
#
# The member scan above only sees names that are *members today*. Drift produces the opposite: a
# dataset the chapter named while it led the ranking, which has since dropped out of the list
# altogether. In a solar-lamp run a freshly written LCIA chapter said "the hotspot list
# is headed by the market for silicon, solar grade … with {{hotspots.0.share_text}}" while hotspots.0
# was pinned to dysprosium oxide at 7.0 % and silicon had left the top ten. The printed sentence
# contradicted the chapter's own figure two pages later, and every check was green.

DYSPROSIUM = {"database": "ecoinvent-3.12-cutoff", "code": "dy", "name": "market for dysprosium oxide"}

DRIFTED_DATA = {
    "hotspots": [DYSPROSIUM | {"share_text": "7.0 %"}],
    "background_datasets": [
        {"database": "ecoinvent-3.12-cutoff", "code": "si", "name": "market for silicon, solar grade"},
        DYSPROSIUM,
    ],
    "contribution": {"groups": [{"key": "Production"}, {"key": "Use"}]},
}


def test_a_dataset_that_left_the_list_is_still_recognised_as_a_name():
    text = (
        "the hotspot list is headed by the market for silicon, solar grade — the feedstock of the "
        "polycrystalline cells — with {{hotspots.0.share_text}} of the score"
    )
    findings = rc.misbound_names(text, DRIFTED_DATA, {"hotspots.0": DYSPROSIUM})
    assert len(findings) == 1, findings
    assert "market for silicon, solar grade" in findings[0]["detail"]
    assert "market for dysprosium oxide" in findings[0]["detail"]


def test_naming_the_pinned_dataset_too_is_not_a_misbinding():
    """Both spelled out: the reader can see which figure belongs to which, so this is prose, not a trap."""
    text = (
        "the market for silicon, solar grade has left the list; the market for dysprosium oxide now "
        "leads with {{hotspots.0.share_text}}"
    )
    assert rc.misbound_names(text, DRIFTED_DATA, {"hotspots.0": DYSPROSIUM}) == []


def test_a_dataset_name_beside_a_phase_share_is_ordinary_wording():
    """Groups are phases, not datasets — naming what sits inside one is how the chapter explains it."""
    text = (
        "the use phase, whose only input is the market for silicon, solar grade, carries "
        "{{contribution.groups.1.share_text}}"
    )
    assert rc.misbound_names(text, DRIFTED_DATA, {"contribution.groups.1": {"key": "Use"}}) == []


def test_prose_that_names_no_dataset_is_left_alone():
    text = "the polycrystalline cells behind it carry {{hotspots.0.share_text}} of the score"
    assert rc.misbound_names(text, DRIFTED_DATA, {"hotspots.0": DYSPROSIUM}) == []


def test_the_pinned_dataset_named_before_its_own_figure_is_correct():
    text = "the market for dysprosium oxide carries {{hotspots.0.share_text}} of the score"
    assert rc.misbound_names(text, DRIFTED_DATA, {"hotspots.0": DYSPROSIUM}) == []


def test_names_listed_first_and_figures_after_are_paired_in_order():
    """The commonest shape in a contribution chapter, and the nearest-name rule reads it backwards.

    "Packaging and Raw materials are a near tie at {{…0…}} and {{…1…}}" puts the *second* name closest
    to the *first* figure. Found while extending the rule to the per-indicator breakdowns:
    it refused a correction on an untouched, entirely correct sentence.
    """
    data = {
        "contribution": {
            "groups": [
                {"key": "Packaging", "share_percent": 43.0},
                {"key": "Raw materials", "share_percent": 40.6},
                {"key": "Filling", "share_percent": 10.6},
            ]
        }
    }
    pins = {
        "contribution.groups.0": {"key": "Packaging"},
        "contribution.groups.1": {"key": "Raw materials"},
        "contribution.groups.2": {"key": "Filling"},
    }
    listed = (
        "Packaging and Raw materials are a near tie at {{contribution.groups.0.share_text}} and "
        "{{contribution.groups.1.share_text}}."
    )
    assert rc.misbound_names(listed, data, pins) == []

    # The pairing is only read where it is the only reading: same count, all names ahead of all
    # figures. A genuinely swapped pair in that shape is still caught.
    swapped = {
        "contribution.groups.0": {"key": "Raw materials"},
        "contribution.groups.1": {"key": "Packaging"},
    }
    assert len(rc.misbound_names(listed, data, swapped)) == 2

    # And the classic name-then-figure shape keeps the nearest-name reading.
    inline = (
        "Packaging ({{contribution.groups.0.share_text}}) leads Raw materials "
        "({{contribution.groups.1.share_text}})."
    )
    assert rc.misbound_names(inline, data, pins) == []
    assert rc.misbound_names(inline, data, swapped)


def test_a_figure_with_no_name_of_its_own_is_not_given_the_previous_one_s():
    """The false alarm that refused a freshly written, correct chapter and cost a paid rewrite.

    "Raw materials & production contributes {{…0…}} …; Packaging ({{…1…}}) and Filling ({{…2…}}) are
    comparable" — every figure under its own name. But `_MIN_NAME` drops "Filling" (7 characters), so
    the third placeholder has no name in front of it except Packaging's, which belongs to the second.
    A name that sits before the *previous* figure of the same list is not this figure's name.
    """
    data = {
        "contribution": {
            "groups": [
                {"key": "Raw materials & production", "share_percent": 60.1},
                {"key": "Packaging", "share_percent": 18.9},
                {"key": "Filling", "share_percent": 17.6},
            ]
        }
    }
    pins = {
        "contribution.groups.0": {"key": "Raw materials & production"},
        "contribution.groups.1": {"key": "Packaging"},
        "contribution.groups.2": {"key": "Filling"},
    }
    text = (
        "In the lead indicator Raw materials & production contributes "
        "{{contribution.groups.0.share_text}} of the score; Packaging "
        "({{contribution.groups.1.share_text}}) and Filling ({{contribution.groups.2.share_text}}) "
        "are comparable with each other."
    )
    assert rc.misbound_names(text, data, pins) == []

    # The protection is unchanged where the name really does sit next to the figure it labels.
    swapped = {
        "contribution.groups.0": {"key": "Packaging"},
        "contribution.groups.1": {"key": "Raw materials & production"},
        "contribution.groups.2": {"key": "Filling"},
    }
    assert rc.misbound_names(text, data, swapped)


# ---- one matcher, one word list, and the accents that used to defeat it (V207/V208) --------
#
# Run 16 delivered a French report and its fix round measured four holes in this module, two of which
# cost a finding on the PDF that went out. Three of them are the same defect seen from three sides: the
# matcher compared a word list against the raw sentence, and French spells its words with accents and
# its apostrophes with a curly one.


def test_an_accented_superlative_beside_a_figure_no_longer_walks_through_the_gate():
    """V208b, verbatim from the run. The claim is anchored, checkable and false — `contribution.groups.1`
    is not the largest — and `\\bdomine\\w{0,2}\\b` did not match “dominé”, so nothing reported it. The
    laxer staleness rule could not see it either: the sentence carries a figure, which is precisely the
    case it leaves to this one."""
    text = "Le bilan est dominé par l'emballage ({{contribution.groups.1.share_percent}} %)"
    assert kinds(text, "fr") == ["contradicted_claim"]
    # …and the true version of the same sentence stays silent, which is what makes the finding worth
    # anything.
    assert blocking(text.replace("groups.1", "groups.0"), "fr") == []


#: One phrasing per language that the list could not reach before, each one what an LCA author actually
#: writes for "this is the biggest contributor". `contribution.groups.1` is never the largest in `DATA`,
#: so every one of these is a false claim and has to be caught.
_REACHED_NOW = (
    ("en", "The result is dominated by {{contribution.groups.1.key}}."),
    ("en", "The highest share falls on {{contribution.groups.1.key}}."),
    ("en", "The main driver is {{contribution.groups.1.key}}."),
    ("de", "Der dominierende Beitrag ist {{contribution.groups.1.key}}."),
    ("de", "Den höchsten Anteil trägt {{contribution.groups.1.key}}."),
    ("de", "Hauptverursacher ist {{contribution.groups.1.key}}."),
    ("fr", "Le groupe prépondérant est {{contribution.groups.1.key}}."),
    ("fr", "Le premier poste est {{contribution.groups.1.key}}."),
    ("fr", "Le contributeur principal est {{contribution.groups.1.key}}."),
    ("es", "El grupo preponderante es {{contribution.groups.1.key}}."),
    ("es", "La mayor contribución es de {{contribution.groups.1.key}}."),
    ("pt", "O grupo preponderante é {{contribution.groups.1.key}}."),
    ("pt", "A maior contribuição é de {{contribution.groups.1.key}}."),
)


def test_the_superlative_list_reaches_the_phrasings_a_report_really_uses():
    """V208a. The list had one or two words per language and the report wrote a third — measured
    coverage before this was fr 3/5 and de 2/3. A word list that falls silent costs a finding, and this
    one fell silent on a sentence that was printed."""
    for lang, text in _REACHED_NOW:
        assert kinds(text, lang) == ["contradicted_claim"], (lang, text)


def test_the_same_phrasings_are_silent_on_the_member_that_leads():
    """The other half: a list that only ever fires is not conservative, it is broken.

    Nothing *refuses* the true version — the advisory that offers it a declaration is a note, and the
    test next door is the one that asserts it.
    """
    for lang, text in _REACHED_NOW:
        assert blocking(text.replace("groups.1", "groups.0"), lang) == [], (lang, text)


def test_the_typographic_apostrophe_no_longer_defeats_the_comparative_exemption():
    """V207a. "qu’une" is the comparison the exemption exists for, and `_THAN` carries "qu'" with the
    ASCII apostrophe — so a genuine comparison was reported as a boast, on every French chapter that
    made one, because a model does not type the ASCII one."""
    assert _value_hits("Ce scénario est plus propre qu’une autre solution.", "fr") == []
    # Every member of the family a keyboard or a converter emits, and the plain one it stands in for.
    for mark in ("'", "’", "‘", "‛", "ʼ", "ʹ", "′", "´", "＇"):
        assert _value_hits(f"Ce scénario est plus propre qu{mark}une autre solution.", "fr") == [], mark
    # …and the dangling comparative of marketing prose still fires, which is the entry's whole point.
    assert _value_hits("Ce scénario propose une solution plus propre.", "fr")


def test_an_entry_that_carries_its_own_accent_or_apostrophe_keeps_working():
    """What the fold must not break. Both sides lose the accent, so an entry spelled with one matches
    the same words it always did — and one spelled with an apostrophe now matches either spelling."""
    assert _value_hits("Cette solution est écologique.", "fr")
    assert _value_hits("Este producto es ecológico.", "es")
    assert _value_hits("Le produit est respectueux de l'environnement.", "fr")
    assert _value_hits("Le produit est respectueux de l’environnement.", "fr")


def test_the_narrowed_green_still_catches_the_boast_it_exists_for():
    """V207b, the half that must keep firing. Next to the thing being praised, the word is the claim."""
    for lang, sentence in (
        ("fr", "Le scénario B repose sur une énergie verte."),
        ("fr", "L'usine achète de l'électricité verte."),
        ("fr", "Les technologies vertes sont privilégiées dans ce scénario."),
        ("de", "Die Anlage wird mit grünem Strom betrieben."),
        ("de", "Grüner Strom deckt den Bedarf des Werks."),
        ("de", "Die grüne Lösung ersetzt die Verbrennung."),
        ("es", "Se utiliza energía verde en el escenario B."),
        ("pt", "O cenário B utiliza energia verde."),
    ):
        assert _value_hits(sentence, lang), sentence


#: Sentences a report writes while boasting about nothing at all. Each one is a measured or an obvious
#: false positive of a bare colour word, and two of them are what V207b was raised for.
_ORDINARY_PROSE = (
    ("fr", "Les calculs sont faits en vertu de la norme ISO 14044."),
    ("fr", "En vertu des règles de coupure, les flux inférieurs à 1 % sont exclus."),
    ("fr", "Les espaces verts autour du site ne sont pas modélisés."),
    ("fr", "L'emballage porte le point vert."),
    ("de", "Die Gründe für die Abweichung sind dokumentiert."),
    ("de", "Der Grund ist eine fehlende Datenquelle."),
    ("de", "Die Gründung des Unternehmens liegt vor dem Bezugsjahr."),
    ("de", "Die Berechnung gründet auf den Angaben des Herstellers."),
    ("es", "Los datos reflejan la verdadera composición del envase."),
    ("pt", "Na verdade, os dados de fundo são estimativas."),
)


def test_the_colour_words_stay_silent_on_ordinary_report_prose():
    """The two the finding names — "en vertu de la norme ISO 14044" and "die Gründe für die Abweichung"
    — plus the neighbours the same tolerance reached.

    This is also the proof that the fold does not conflate two different words: folding *widens*
    `grün` from "Gründe" to "Grund" itself, so the bare word had to go rather than be folded, and the
    Spanish and Portuguese "verde" could stay because *verdadera* and *verdade* part company inside the
    two characters the pattern allows."""
    for lang, sentence in _ORDINARY_PROSE:
        assert _value_hits(sentence, lang) == [], sentence


def test_the_staleness_wording_rule_matches_through_the_very_same_fold():
    """One list needs one matcher (V208b). This rule and the staleness wording rule are the same
    question asked at two moments — at write time beside a figure, later without one — and a fold in
    only one of them makes the shared word list mean two different things."""
    from prism_lca.engine import report_staleness as rs

    assert rs._folded is rc.folded and rs._fold is rc.fold
    words = "Le groupe prépondérant est l'emballage."
    # No figure in it: the staleness rule's business, and it reads this module's list.
    assert rs.unanchored_claims(words, "fr") == [(words, "prépondérant")]
    # The same word beside a figure: this module's business, from the same list and the same fold.
    assert kinds("Le groupe prépondérant est {{contribution.groups.1.key}}.", "fr") == [
        "contradicted_claim"
    ]


# ---- V209/V210: the two ways the superlative rule was disarmed by accident ----------------------
def test_secondary_data_does_not_switch_the_superlative_rule_off():
    """V209. The ordinals were matched as prefixes with no closing boundary, so "second" reached
    *secondary*, "second" (fr) *secondaire* and "weiter" *weitere* — and "secondary data" is in nearly
    every life-cycle-inventory chapter there is. Measured: all three sentences below returned no
    finding, which means the blocking rule was off for a large share of real chapters."""
    for lang, sentence in (
        ("en", "Secondary data was used, and the dominant group is {{contribution.groups.1.key}}."),
        (
            "fr",
            "Les données secondaires ont été utilisées et le poste prépondérant est "
            "{{contribution.groups.1.key}}.",
        ),
        ("de", "Weitere Annahmen: der dominierende Beitrag ist {{contribution.groups.1.key}}."),
    ):
        assert kinds(sentence, lang) == ["contradicted_claim"], sentence


#: A genuine "the second/third largest …" per language — including the German compounds, where the
#: ordinal is glued to the superlative and is not a word of its own.
_RANKED_PROSE = (
    ("en", "Raw materials are the second largest contributor at {{contribution.groups.1.key}}."),
    ("en", "Raw materials are the second-largest contributor at {{contribution.groups.1.key}}."),
    ("en", "The third largest contributor is {{contribution.groups.1.key}}."),
    ("en", "The next largest contributor is {{contribution.groups.1.key}}."),
    ("de", "Der zweitgrößte Beitrag ist {{contribution.groups.1.key}}."),
    ("de", "Die zweithöchste Belastung entfällt auf {{contribution.groups.1.key}}."),
    ("de", "Der drittgrößte Posten ist {{contribution.groups.1.key}}."),
    ("de", "Der nächstgrößte Beitrag ist {{contribution.groups.1.key}}."),
    ("de", "Der zweite Hauptbeitrag ist {{contribution.groups.1.key}}."),
    ("fr", "Le deuxième plus grand contributeur est {{contribution.groups.1.key}}."),
    ("fr", "Le second poste le plus important est {{contribution.groups.1.key}}."),
    ("fr", "Le troisième poste le plus important est {{contribution.groups.1.key}}."),
    ("es", "El segundo mayor contribuyente es {{contribution.groups.1.key}}."),
    ("es", "La segunda mayor contribución es {{contribution.groups.1.key}}."),
    # "tercer", not "tercero": the apocopated form is the one Spanish writes in front of the noun, and
    # it was missing from the list, so this sentence was refused before V209 too.
    ("es", "El tercer mayor contribuyente es {{contribution.groups.1.key}}."),
    ("pt", "O segundo maior contribuinte é {{contribution.groups.1.key}}."),
    ("pt", "A segunda maior contribuição é {{contribution.groups.1.key}}."),
    ("pt", "O terceiro maior contribuinte é {{contribution.groups.1.key}}."),
)


def test_a_genuine_ordinal_still_disarms_the_rule_in_every_language():
    """The other half of V209, and the expensive half: the closing boundary must not cost a single one
    of the phrasings the exemption exists for. A refusal here blocks a chapter that is telling the
    truth."""
    for lang, sentence in _RANKED_PROSE:
        assert blocking(sentence, lang) == [], sentence


def test_the_ordinal_disarms_the_staleness_rule_the_same_way():
    """The two rules share the list, so they have to share the matcher — "secondary data" silenced this
    one as well, and it is the rule that has no figure to fall back on."""
    from prism_lca.engine import report_staleness as rs

    silenced = "Secondary data was used, and the packaging is the dominant contributor."
    assert rs.unanchored_claims(silenced, "en") == [(silenced, "dominant")]
    assert rs.unanchored_claims("Packaging is the second largest contributor.", "en") == []
    assert rs.unanchored_claims("Die Verpackung ist der zweitgrößte Beitrag.", "de") == []


def test_a_two_way_comparison_is_not_a_claim_to_the_top():
    """V210. "Le poste A est plus important que le poste B" is a statement about two numbers — and it
    was refused, which stops the chapter from being stored at all.

    Three of the listed superlatives are comparatives with an article missing in front of them, so the
    comparison word is the only thing that tells the two readings apart — the same reasoning
    `_VALUE_WORDS` already writes down for "more environmentally friendly than"."""
    compared = "Le poste A est plus important que le poste {{contribution.groups.1.key}}."
    assert kinds(compared, "fr") == []
    # This one blocked: it is the kind of finding that stops the chapter from being stored.
    assert rp.check_proposal(compared, {"kind": "prose"}, DATA, "fr")["ok"]
    # Without the comparison the same wording claims the top, and the claim is false.
    assert kinds("Le poste A est plus important, puis {{contribution.groups.1.key}}.", "fr") == [
        "contradicted_claim"
    ]
    # The other two comparative-shaped entries, same story.
    assert kinds("El poste A es más grande que el poste {{contribution.groups.1.key}}.", "es") == []
    assert kinds("O poste A é mais importante que o poste {{contribution.groups.1.key}}.", "pt") == []


def test_a_sentence_that_compares_and_also_claims_the_top_is_still_caught():
    """The failure the exemption must not introduce. It is about the *matched wording* being the
    comparative one, not about the sentence containing a comparison anywhere: a sentence can compare
    and claim the top in one breath, and that claim is still checkable."""
    assert kinds("A dominates, and it is larger than {{contribution.groups.1.key}}.") == [
        "contradicted_claim"
    ]
    assert kinds(
        "Le poste {{contribution.groups.1.key}} est prépondérant et plus important que le poste B.",
        "fr",
    ) == ["contradicted_claim"]
    assert kinds(
        "Der dominierende Beitrag ist {{contribution.groups.1.key}} und größer als Poste B.", "de"
    ) == ["contradicted_claim"]


def test_the_three_held_back_comparatives_now_cover_without_blocking(): 
    """V211. `plus élevé`, `plus gros` and `más importante` were left out twice — first because they
    would have refused honest comparisons, then because the exemption did not exist yet. Both halves
    have to hold at once: they must find a false claim to the top, and stay silent on a comparison."""
    for sentence, lang in (
        ("Le poste A est plus élevé, puis {{contribution.groups.1.key}}.", "fr"),
        ("Le poste A est plus gros, puis {{contribution.groups.1.key}}.", "fr"),
        ("El poste A es más importante, luego {{contribution.groups.1.key}}.", "es"),
    ):
        assert kinds(sentence, lang) == ["contradicted_claim"], sentence
    for sentence, lang in (
        ("Le poste A est plus élevé que le poste {{contribution.groups.1.key}}.", "fr"),
        ("Le poste A est plus gros que le poste {{contribution.groups.1.key}}.", "fr"),
        ("El poste A es más importante que el poste {{contribution.groups.1.key}}.", "es"),
    ):
        assert kinds(sentence, lang) == [], sentence
        assert rp.check_proposal(sentence, {"kind": "prose"}, DATA, lang)["ok"], sentence


def test_the_staleness_rule_makes_the_same_comparative_exemption():
    """V211. The wording rule asks the write-time rule's question at the other moment, so it has to
    make the same exemption — otherwise an honest comparison is silent at write time and reported
    afterwards, which reads as the check having changed its mind."""
    from prism_lca.engine import report_staleness as rs

    compared = "Le poste A est plus important que le poste B."
    assert rs.unanchored_claims(compared, "fr") == []
    # Without the comparison the same wording is a claim to the top, with nothing in it to check.
    claimed = rs.unanchored_claims("Le poste A est plus important, et B suit.", "fr")
    assert [word for _sentence, word in claimed] == ["plus important"]
    # A sentence that compares *and* claims the top is still reported — the exemption is about the
    # matched word, here and at write time alike.
    both = rs.unanchored_claims("Le poste A domine et il est plus important que le poste B.", "fr")
    assert [word for _sentence, word in both] == ["domine"]


def test_according_to_is_not_an_ordinal_in_portuguese():
    """V213. Portuguese `segundo` is both "second" and the preposition "according to", and the second
    reading disarmed a rule that blocks: "segundo a norma ISO 14044, o grupo dominante é X" said
    nothing at all. What separates them is the next word — a determiner after the preposition, a noun
    or a superlative after the ordinal."""
    claimed = "Segundo a norma ISO 14044, o grupo dominante é {{contribution.groups.1.key}}."
    assert kinds(claimed, "pt") == ["contradicted_claim"]
    # The ordinal reading still disarms, which is the whole reason the list has the word.
    assert blocking("O segundo maior contribuinte é {{contribution.groups.1.key}}.", "pt") == []


def test_a_comparator_is_a_word_and_not_a_substring():
    """V213. The direction words were matched with a bare `in`, which was fine while every entry was a
    phrase and wrong for the romance single verbs: `excede` sits inside *excedente* — the surplus a
    substitution discussion talks about — `supera` inside *superar*, `dépasse` inside *dépassement*.
    A sentence that states no direction then had one, and the arithmetic contradicted a claim nobody
    made."""
    from prism_lca.engine import report_claims as rc

    for text, lang in (
        ("o excedente de eletricidade é vendido à rede", "pt"),
        ("para superar el límite de calidad", "es"),
        ("le dépassement du seuil n est pas documenté", "fr"),
    ):
        low, _place = rc.folded(text)
        assert not rc._says(rc._COMPARATORS[lang][0], low), text
    # And the verbs they were listed for still register.
    for text, lang in (
        ("o valor excede o limite", "pt"),
        ("el valor supera el límite", "es"),
        ("la valeur dépasse le seuil", "fr"),
    ):
        low, _place = rc.folded(text)
        assert rc._says(rc._COMPARATORS[lang][0], low), text


def test_the_lemma_a_delivered_portuguese_report_used_is_found():
    """V216, and it is a *lemma* gap rather than a form gap.

    A delivered report wrote "a embalagem permanece como maior contribuidora" — and after the ranking
    had flipped that sentence was false. `contribuinte` and `contribuidor` are different nouns, so no
    inflection tolerance on the one can ever reach the other: the paradigm tool proposes other forms of
    a word that is listed and cannot propose a word nobody listed. Found by reading a printed PDF."""
    from prism_lca.engine import report_staleness as rs

    found = rs.unanchored_claims("mesmo dentro dela, a embalagem permanece como maior contribuidora.", "pt")
    assert [word for _s, word in found] == ["maior contribuidora"]
    # Added to Spanish by symmetry, not by sighting — the same two nouns exist there.
    assert [w for _s, w in rs.unanchored_claims("el envase sigue siendo el mayor contribuidor.", "es")] == [
        "mayor contribuidor"
    ]
    # The sentences that stand beside it in the same report stay silent.
    for quiet in (
        "Os dados provêm do ecoinvent 3.12 segundo o método cutoff.",
        "A densidade é 1,1 g/cm³ segundo a ficha técnica.",
    ):
        assert rs.unanchored_claims(quiet, "pt") == [], quiet


def test_the_portuguese_singular_contraction_carries_a_direction():
    """V216. V213 added the plural contractions (`superiores às`) and stopped there, so the singular —
    written just as often — had its direction checked by nothing. My own fix, half done."""
    from prism_lca.engine import report_claims as rc

    for text in ("As emissões são superior às da referência.", "O valor é inferior aos do cenário A."):
        low, _place = rc.folded(text)
        assert rc._says(rc._COMPARATORS["pt"][0], low) or rc._says(rc._COMPARATORS["pt"][1], low), text
    # And the V213 guard still holds: a surplus is not a comparison.
    low, _place = rc.folded("o excedente de eletricidade é vendido à rede")
    assert not rc._says(rc._COMPARATORS["pt"][0], low)


def test_the_comparative_exemption_only_ever_names_a_listed_superlative():
    """It exempts words the rule can match; an entry that is not in the list exempts nothing and would
    be a note to a reader that lies about what the checker does."""
    for lang, words in rc._COMPARATIVE_SUPERLATIVES.items():
        assert set(words) <= set(rc._SUPERLATIVES[lang]), lang


# ---- V212: how much of a paradigm two characters carry, and in which language -------------------
#: The two sentences out of the Spanish PDF of a real report, verbatim. Both claim the top for a
#: group that had lost it, both went through two correction rounds and a rewrite, and both were
#: invisible: `dominando` is three characters past *domina*, and `predominio` is not *predominante*.
#: Measured before the fix: `unanchored_claims` returned `[]` for each.
_PDF_SPANISH = (
    ("La fase de uso sigue dominando el resultado en todas las variantes.", "dominando"),
    ("Su efecto sobre el total queda amortiguado por el predominio del uso.", "predominio"),
)


def test_the_two_spanish_sentences_from_the_delivered_pdf_are_now_seen():
    """The defect V212 is: the same word list was three lists of different strengths, because two
    characters of tolerance are most of the German and French paradigm and a third of the Spanish one.
    The French "reste prédominante" and the German "bleibt dominierend" beside these two were caught,
    which is why nobody noticed that the Spanish ones were not."""
    from prism_lca.engine import report_staleness as rs

    for sentence, word in _PDF_SPANISH:
        # As the chapter spells it, not as the list does — a verdict naming a word that is not in the
        # sentence sends the correction model looking for it.
        assert rs.unanchored_claims(sentence, "es") == [(sentence, word)], sentence
    # The control from the probe: the form that was already covered still is.
    control = "La fase de uso domina el resultado."
    assert rs.unanchored_claims(control, "es") == [(control, "domina")]


def test_the_same_spanish_wordings_are_checked_beside_a_figure_too():
    """One list, two moments (V208b). A form the staleness rule cannot see is a form the *blocking*
    rule cannot see either, and this is the half that keeps a false claim out of the PDF."""
    assert kinds("La fase de uso sigue dominando {{contribution.groups.1.key}}.", "es") == [
        "contradicted_claim"
    ]
    assert kinds("El predominio del uso se ve en {{contribution.groups.1.key}}.", "es") == [
        "contradicted_claim"
    ]
    # …and refuses nothing where the claim is true.
    assert blocking("La fase de uso sigue dominando {{contribution.groups.0.key}}.", "es") == []


def test_the_english_gerund_is_reached_as_well():
    """"dominate" carries *dominates* and *dominated* and stops one character short of *dominating* —
    the same arithmetic as the Spanish gerund, in the language nobody thought to probe."""
    from prism_lca.engine import report_staleness as rs

    sentence = "Use keeps dominating the result."
    assert rs.unanchored_claims(sentence, "en") == [(sentence, "dominating")]
    assert kinds("Use keeps dominating {{contribution.groups.1.key}}.") == ["contradicted_claim"]


#: Every form the audit added to `_SUPERLATIVES`, per language, as (language, sentence, quoted word).
#: A sentence with no figure in it, so `unanchored_claims` is the rule under test — the one that has
#: nothing to fall back on when the wording is missing from the list.
_ADDED_SUPERLATIVE_FORMS = (
    ("en", "Use keeps dominating the result.", "dominating"),
    ("en", "The dominance of the use phase is unchanged.", "dominance"),
    ("en", "Packaging is the predominant contributor.", "predominant"),
    ("en", "Packaging is predominantly responsible.", "predominantly"),
    ("en", "The predominance of packaging is clear.", "predominance"),
    ("de", "Die Dominanz der Nutzungsphase bleibt bestehen.", "Dominanz"),
    ("de", "Die Nutzungsphase ist die vorherrschende Ursache.", "vorherrschende"),
    ("fr", "La phase d'utilisation prédomine dans le bilan.", "prédomine"),
    ("fr", "Les émissions liées à l'énergie prédominent.", "prédominent"),
    ("fr", "La prédominance de l'emballage est nette.", "prédominance"),
    ("fr", "La prépondérance du transport reste visible.", "prépondérance"),
    ("fr", "La dominance de l'emballage est nette.", "dominance"),
    ("fr", "Les principaux contributeurs sont l'emballage et le transport.", "principaux contributeurs"),
    ("fr", "Les contributeurs principaux sont l'emballage et le transport.", "contributeurs principaux"),
    ("fr", "Les premiers postes sont l'emballage et le transport.", "premiers postes"),
    ("fr", "Les postes principaux sont l'emballage et le transport.", "postes principaux"),
    ("es", "La fase de uso sigue dominando el resultado.", "dominando"),
    ("es", "Los resultados están dominados por la fase de uso.", "dominados"),
    ("es", "Las categorías están dominadas por la fase de uso.", "dominadas"),
    ("es", "El uso predomina en todas las categorías.", "predomina"),
    ("es", "El predominio del uso es claro.", "predominio"),
    ("es", "El uso predominó en el resultado.", "predominó"),
    ("es", "La fase de uso sigue predominando en el resultado.", "predominando"),
    ("es", "La preponderancia del uso es clara.", "preponderancia"),
    ("es", "Los mayores contribuyentes son el envase y el transporte.", "mayores contribuyentes"),
    ("es", "Las mayores contribuciones son del envase y del transporte.", "mayores contribuciones"),
    ("es", "Los mayores aportes son del envase y del transporte.", "mayores aportes"),
    ("es", "Los principales contribuyentes son el envase y el transporte.", "principales contribuyentes"),
    ("pt", "A fase de uso continua dominando o resultado.", "dominando"),
    ("pt", "Os resultados são dominados pela fase de uso.", "dominados"),
    ("pt", "O uso predomina em todas as categorias.", "predomina"),
    ("pt", "O predomínio do uso é claro.", "predomínio"),
    ("pt", "A fase de uso continua predominando no resultado.", "predominando"),
    ("pt", "A predominância do uso é clara.", "predominância"),
    ("pt", "A preponderância do uso é clara.", "preponderância"),
    ("pt", "Os maiores contribuintes são a embalagem e o transporte.", "maiores contribuintes"),
    ("pt", "As maiores contribuições são da embalagem e do transporte.", "maiores contribuições"),
    ("pt", "Os maiores contributos são da embalagem e do transporte.", "maiores contributos"),
    ("pt", "Os principais contribuintes são a embalagem e o transporte.", "principais contribuintes"),
)


def test_every_superlative_form_the_audit_added_fires():
    """The table is the audit: one line per form an LCA author writes, in the spelling the chapter
    uses. It reads as long because a romance plural inflects in the middle of the phrase ("mayores
    contribuyentes"), where the trailing tolerance cannot reach — English needs none of these, and
    that asymmetry is the whole finding."""
    from prism_lca.engine import report_staleness as rs

    for lang, sentence, word in _ADDED_SUPERLATIVE_FORMS:
        assert rs.unanchored_claims(sentence, lang) == [(sentence, word)], sentence


#: Ordinary prose the shortened Spanish and Portuguese entries must not touch. `predomin` earns the
#: noun and the past tense in one entry because nothing else in either language starts that way;
#: `domin` would have earned them too, and taken *dominio*/*domínio* — the word a scope chapter uses
#: for its own field of application — with it. So the verb costs four entries and this stays silent.
_DOMAIN_NOT_DOMINANCE = (
    ("es", "El dominio de aplicación del estudio es la producción de envases."),
    ("es", "Los datos de dominio público se documentan en el anexo B."),
    ("es", "El efecto dominó de la sustitución no se modela."),
    ("es", "El consumo dominical de los hogares no se modela por separado."),
    ("pt", "O domínio de aplicação do estudo é a produção de embalagens."),
    ("pt", "Os dados de domínio público constam do anexo B."),
)


def test_the_shortened_entries_stop_short_of_the_domain():
    """The trap on the other side of V212: a shorter stem buys coverage and can buy false positives
    with it, and this list *blocks* a chapter. Both rules have to stay silent here — at write time
    beside a figure and afterwards without one."""
    from prism_lca.engine import report_staleness as rs

    for lang, sentence in _DOMAIN_NOT_DOMINANCE:
        assert rs.unanchored_claims(sentence, lang) == [], sentence
        assert kinds(sentence, lang) == [], sentence
        # …and the same sentence next to a figure that is not the leader is still not a claim.
        beside = sentence[:-1] + " ({{contribution.groups.1.key}})."
        assert kinds(beside, lang) == [], beside


#: The value judgements and neutrality claims the audit added, as (language, sentence, word listed).
#: These two lists only ever advise, which is why the superlative degree and the romance feminine are
#: worth having: the cost of a miss is a boast in a delivered PDF, the cost of a hit is a note.
_ADDED_WORDING_FORMS = (
    ("en", "The greenest option was chosen.", "greenest"),
    ("en", "The cleanest process was chosen.", "cleanest"),
    ("en", "The material is sustainably produced.", "sustainably"),
    ("de", "Das umweltfreundlichste Produkt gewinnt.", "umweltfreundlichste"),
    ("de", "Die nachhaltigste Variante gewinnt.", "nachhaltigste"),
    ("de", "Die sauberste Variante gewinnt.", "sauberste"),
    ("fr", "Une solution respectueuse de l'environnement.", "respectueuse de l'environnement"),
    ("fr", "Une solution inoffensive pour le milieu.", "inoffensive"),
    ("es", "Una solución ecológica para el envase.", "ecológica"),
    ("es", "Una solución respetuosa con el medio ambiente.", "respetuosa con el medio ambiente"),
    ("es", "Una tecnología limpia para el proceso.", "limpia"),
    ("es", "Una sustancia inocua para el suelo.", "inocua"),
    ("pt", "Uma solução ecológica para a embalagem.", "ecológica"),
    ("pt", "Uma solução respeitadora do ambiente.", "respeitadora do ambiente"),
    ("pt", "Duas opções sustentáveis para a embalagem.", "sustentáveis"),
    ("pt", "Uma tecnologia limpa para o processo.", "limpa"),
    ("pt", "Uma substância inócua para o solo.", "inócua"),
    ("en", "The site reached carbon neutrality in 2030.", "carbon neutrality"),
    ("en", "The site reached climate neutrality in 2030.", "climate neutrality"),
    ("de", "Die Klimaneutralität des Werks ist erreicht.", "klimaneutralität"),
    ("de", "Die CO2-Neutralität des Werks ist erreicht.", "co2-neutralität"),
    ("fr", "La neutralité climatique du site est atteinte.", "neutralité climatique"),
    ("fr", "Les procédés sont neutres en carbone.", "neutres en carbone"),
    ("es", "La neutralidad de carbono está alcanzada.", "neutralidad de carbono"),
    ("es", "La planta es neutra en carbono.", "neutra en carbono"),
    ("es", "La planta es climáticamente neutra.", "climáticamente neutra"),
    ("pt", "A neutralidade de carbono está alcançada.", "neutralidade de carbono"),
    ("pt", "A fábrica é neutra em carbono.", "neutra em carbono"),
    ("pt", "A fábrica é climaticamente neutra.", "climaticamente neutra"),
)


def test_every_wording_form_the_audit_added_is_noted():
    """The note names the entries it matched, so the table checks the spelling the author is shown as
    well as the fact that it fired."""
    for lang, sentence, word in _ADDED_WORDING_FORMS:
        detail = " ".join(_value_hits(sentence, lang))
        assert word in detail, (lang, sentence, detail)


def test_the_subscript_spelling_is_not_reported_twice():
    """`_folded` runs NFKD, which turns "CO₂" into "CO2" — so the separate "co₂-neutral" entry matched
    exactly the same text as "co2-neutral" and the note told the author about two words where the
    chapter had used one. The note has four slots; two of them were the same word."""
    detail = " ".join(_value_hits("Das Produkt ist CO₂-neutral.", "de"))
    assert "co2-neutral" in detail and "co₂-neutral" not in detail


def test_the_discipline_is_not_a_boast():
    """What stays deliberately out of `_VALUE_WORDS`: the noun that names the field. A goal-and-scope
    chapter writes it as a matter of course, and a note that fires on every report is one nobody
    reads. The adverb is a claim and does fire (see the table above)."""
    for lang, sentence in (
        ("en", "The sustainability assessment follows ISO 14040."),
        ("de", "Die Nachhaltigkeit des Systems wird nicht bewertet."),
        ("es", "La sostenibilidad se evalúa según la norma ISO 14040."),
        ("pt", "A sustentabilidade é avaliada segundo a norma ISO 14040."),
        # The nouns for data cleaning, which is what these languages actually write.
        ("es", "La limpieza de los datos se documenta en el anexo B."),
        ("pt", "A limpeza dos dados está documentada no anexo B."),
    ):
        assert _value_hits(sentence, lang) == [], sentence


#: The causal connectives the audit added. Advisory only — reported once per chapter, never blocking.
_ADDED_CAUSAL_FORMS = (
    ("en", "The shift led to a different ranking.", "led to"),
    ("en", "The assumptions lead to a different ranking.", "lead to"),
    ("en", "The assumptions are leading to a different ranking.", "leading to"),
    ("de", "Die Unterschiede führen zu Verschiebungen.", "führen zu"),
    ("de", "Das Ergebnis wird getrieben von der Nutzungsphase.", "getrieben von"),
    ("es", "Los supuestos conducen a resultados distintos.", "conducen a"),
    ("pt", "Os pressupostos conduzem a resultados distintos.", "conduzem a"),
)


def test_every_causal_form_the_audit_added_is_reported():
    """"leads to" carries no other tense at all: the two characters of tolerance come after the *to*,
    so the inflection of the verb sits where nothing reaches it. Each tense is an entry."""
    # Each sentence carries a figure, because since V250 the note only fires where one is explained —
    # what is under test here is the word list, not that gate.
    for lang, sentence, word in _ADDED_CAUSAL_FORMS:
        detail = " ".join(
            f["detail"]
            for f in rc.check_claims(f"{sentence.rstrip('.')} , 12 %.", {}, lang)
            if f["kind"] == "unverifiable_claim"
        )
        assert word in detail, (lang, sentence, detail)
    # The form that was already there keeps working — it was not replaced by its stem, because a stem
    # cannot reach it either way round.
    detail = " ".join(
        f["detail"] for f in rc.check_claims("The shift leads to a ranking change of 12 %.", {}, "en")
        if f["kind"] == "unverifiable_claim"
    )
    assert "leads to" in detail


#: change(new, old) over the two subjects in DATA: the thicker bag is the higher of the two, so this
#: derivation is positive and the reverse one negative. A comparator that is *not* matched leaves the
#: direction unset and the sentence silent, so each of these has to be the wrong direction to prove
#: the entry is read at all.
_CHANGE_DOWN = "{{change(subjects.0.results.0.score, subjects.1.results.0.score)}}"

#: The romance gender and number forms of `_COMPARATORS`, each with the direction it contradicts.
#: This is the one list matched by plain substring, so it has no tolerance whatsoever — and the audit
#: found the masculine singular was all any of the three languages had.
_ADDED_COMPARATOR_FORMS = (
    ("fr", f"Les émissions sont supérieures à celles de la référence, {_CHANGE_DOWN}."),
    ("fr", f"Les postes sont supérieurs à ceux de la référence, {_CHANGE_DOWN}."),
    ("fr", f"Les valeurs sont plus élevées que celles de la référence, {_CHANGE_DOWN}."),
    ("fr", f"Les émissions sont inférieures à celles de la référence, {CHANGE}."),
    ("fr", f"Les postes sont inférieurs à ceux de la référence, {CHANGE}."),
    ("fr", f"Les charges sont plus faibles que celles de la référence, {CHANGE}."),
    ("es", f"Las emisiones son superiores a las de la referencia, {_CHANGE_DOWN}."),
    ("es", f"Las emisiones son mayores que las de la referencia, {_CHANGE_DOWN}."),
    ("es", f"La carga es más alta que la de la referencia, {_CHANGE_DOWN}."),
    ("es", f"Las cargas son más altas que las de la referencia, {_CHANGE_DOWN}."),
    ("es", f"Las emisiones son inferiores a las de la referencia, {CHANGE}."),
    ("es", f"Las emisiones son menores que las de la referencia, {CHANGE}."),
    ("es", f"La carga es más baja que la de la referencia, {CHANGE}."),
    ("es", f"Las cargas son más bajas que las de la referencia, {CHANGE}."),
    ("pt", f"As emissões são superiores às da referência, {_CHANGE_DOWN}."),
    ("pt", f"As emissões são maiores que as da referência, {_CHANGE_DOWN}."),
    ("pt", f"A carga é mais elevada que a da referência, {_CHANGE_DOWN}."),
    ("pt", f"As emissões são inferiores às da referência, {CHANGE}."),
    ("pt", f"As emissões são menores que as da referência, {CHANGE}."),
    ("pt", f"A carga é mais baixa que a da referência, {CHANGE}."),
    ("en", f"The emissions exceed the baseline, {_CHANGE_DOWN}."),
    ("en", f"The emissions exceeded the baseline, {_CHANGE_DOWN}."),
)


def test_the_romance_comparators_carry_a_direction_in_every_gender_and_number():
    """A French chapter writing "les émissions sont supérieures à celles du scénario A" had its
    direction checked by nothing, while the German and English sentences beside it were checked. Each
    line here states the wrong direction, so a silent one means the entry is still unread."""
    for lang, sentence in _ADDED_COMPARATOR_FORMS:
        assert kinds(sentence, lang) == ["contradicted_claim"], sentence


def test_the_bare_stem_of_exceed_stays_out():
    """"exceedingly" contains "exceed", and this rule blocks: a substring of the stem would set a
    direction for a sentence that states none, and the arithmetic would then contradict it."""
    assert kinds(f"An exceedingly small share of the total, {_CHANGE_DOWN}.") == []


def test_the_v209_and_v211_controls_survive_the_new_entries():
    """The two rules the audit was most likely to break: an ordinal that must not disarm, and a
    comparison that must not be blocked. Re-checked against the *new* wordings, because a longer list
    is a bigger surface for both."""
    from prism_lca.engine import report_staleness as rs

    # V209: "secondary data" is in nearly every inventory chapter and must not switch the rule off —
    # here with a wording that only exists since this audit.
    assert kinds(
        "Secondary data was used, and use keeps dominating {{contribution.groups.1.key}}.", "en"
    ) == ["contradicted_claim"]
    assert kinds(
        "Los datos secundarios se usaron y el predominio del uso se ve en "
        "{{contribution.groups.1.key}}.",
        "es",
    ) == ["contradicted_claim"]
    # …and a genuine ordinal still disarms, with the new plural collocations in the list.
    assert blocking("El segundo mayor contribuyente es {{contribution.groups.1.key}}.", "es") == []
    assert rs.unanchored_claims("Los segundos contribuyentes son el envase y el transporte.", "es") == []

    # V210/V211: an honest two-way comparison is not a claim to the top, and must still be storable.
    for sentence, lang in (
        ("El poste A es más grande que el poste {{contribution.groups.1.key}}.", "es"),
        ("Le poste A est plus important que le poste {{contribution.groups.1.key}}.", "fr"),
        ("O poste A é mais importante que o poste {{contribution.groups.1.key}}.", "pt"),
    ):
        assert kinds(sentence, lang) == [], sentence
        assert rp.check_proposal(sentence, {"kind": "prose"}, DATA, lang)["ok"], sentence


#: English "clean" spelled out instead of grown by the tolerance: what must fire, and what must not.
#: The three degrees are the boast; the verb, the noun and the adverb are data work.
_CLEAN_FORMS = (
    ("It is a clean product.", True),
    ("This is a cleaner process.", True),
    ("This is the cleanest option.", True),
    ("The inventory was cleaned before use.", False),
    ("The tool cleans the inventory before use.", False),
    ("The cleanup of the dataset removed duplicates.", False),
    ("The routine cleanse of the inventory ran overnight.", False),
)


def test_the_english_adjective_clean_no_longer_reaches_the_verb():
    """`\\bclean\\w{0,2}\\b` reached *cleaned*, *cleans*, *cleanup* and *cleanse*, so "the inventory
    was cleaned before use" — data work, not a boast — earned a value-judgement note. Measured before
    the fix: all four returned `["value_judgement"]`.

    Narrowing to collocations the way "propre" was narrowed would cost real coverage here, because
    English "clean" has no second everyday meaning. So the three degrees are listed and the bare entry
    keeps no tolerance (`_NO_INFLECTION`) — the paradigm of an adjective is closed, unlike a verb's.
    """
    for sentence, noted in _CLEAN_FORMS:
        assert bool(_value_hits(sentence, "en")) is noted, sentence


def test_switching_the_tolerance_off_is_done_per_entry_and_nowhere_else():
    """The mechanism must not quietly narrow the rest of the list. A sweep of every bare English entry
    against a system word list found one other overreach — "green" into *greens*/*greened* — and that
    price is written down at `_VALUE_WORDS` and stays paid: it buys the marketing adjective on a noun
    nobody predicted."""
    assert rc._NO_INFLECTION == frozenset({"clean"})
    assert _value_hits("A greener process was chosen.", "en")
    assert _value_hits("Die grünen Strom nutzende Variante gewinnt.", "de")


#: The two English determiners, in the position where they rank something and in the position where
#: they are ordinary prose. Both sentences on the right were measured silent before the fix.
_DETERMINER_NOT_ORDINAL = (
    ("The other main contributor is {{contribution.groups.1.key}}.", []),
    ("The next largest contributor is {{contribution.groups.1.key}}.", []),
    ("The next-highest contributor is {{contribution.groups.1.key}}.", []),
    ("In other words, the dominant group is {{contribution.groups.1.key}}.", ["contradicted_claim"]),
    (
        "The next chapter discusses the dominant group {{contribution.groups.1.key}}.",
        ["contradicted_claim"],
    ),
)


def test_next_and_other_rank_only_in_front_of_a_superlative():
    """"next" and "other" are determiners first, and as bare entries in `_ORDINALS` they switched the
    **blocking** rule off for ordinary prose: "In other words, the dominant group is X" and a sentence
    about the next chapter both returned `[]`.

    Dropping them would have cost the genuine ranked reading ("the other main contributor"), so the
    position decides instead: only a listed superlative right after them makes them a rank.
    """
    for sentence, expected in _DETERMINER_NOT_ORDINAL:
        assert kinds(sentence) == expected, sentence


def test_the_determiners_read_the_same_way_after_the_chapter_is_stored():
    """The staleness rule shares the list, so it has to share the reading — and it is the rule with no
    figure to fall back on."""
    from prism_lca.engine import report_staleness as rs

    prose = "In other words, the dominant group is packaging."
    assert rs.unanchored_claims(prose, "en") == [(prose, "dominant")]
    assert rs.unanchored_claims("The other main contributor is packaging.", "en") == []
    assert rs.unanchored_claims("The next largest contributor is packaging.", "en") == []


#: A fraction is a quantity, not a rank — and these sentences claim the top for a member that does not
#: hold it, so every one of them must be a finding. Measured `[]` for all four before the fix.
_FRACTION_NOT_A_RANK = (
    ("de", "Ein Drittel entfällt auf den dominierenden Beitrag {{contribution.groups.1.key}}."),
    ("de", "Ein Viertel entfällt auf den dominierenden Beitrag {{contribution.groups.1.key}}."),
    ("de", "Ein Fünftel entfällt auf den dominierenden Beitrag {{contribution.groups.1.key}}."),
    ("es", "Un cuarto del impacto corresponde al grupo dominante {{contribution.groups.1.key}}."),
    ("es", "Una cuarta parte corresponde al grupo dominante {{contribution.groups.1.key}}."),
    ("es", "Tres cuartos del total corresponden al grupo dominante {{contribution.groups.1.key}}."),
    ("pt", "Um quarto do impacto corresponde ao grupo dominante {{contribution.groups.1.key}}."),
    ("pt", "Uma quarta parte corresponde ao grupo dominante {{contribution.groups.1.key}}."),
)

#: …and the ranks the same words still carry. The German entries are stems, so the fraction noun is
#: blanked and nothing else; the romance ones are the ordinal itself, told apart by the article.
_FRACTION_CONTROLS = (
    ("de", "An dritter Stelle steht der dominierende Beitrag {{contribution.groups.1.key}}."),
    ("de", "Der drittgrößte Posten ist {{contribution.groups.1.key}}."),
    ("de", "An vierter Stelle steht der dominierende Beitrag {{contribution.groups.1.key}}."),
    ("es", "El cuarto grupo es el dominante {{contribution.groups.1.key}}."),
    ("es", "El cuarto mayor contribuyente es {{contribution.groups.1.key}}."),
    ("pt", "O quarto grupo é o dominante {{contribution.groups.1.key}}."),
)


def test_a_fraction_is_not_an_ordinal():
    """The tolerance carried German `dritt` into *Drittel* and `viert` into *Viertel*, and in Spanish
    and Portuguese the ordinal *is* the word a quarter is written with. So a sentence stating a
    quantity disarmed a rule that blocks."""
    for lang, sentence in _FRACTION_NOT_A_RANK:
        assert kinds(sentence, lang) == ["contradicted_claim"], sentence


def test_the_ordinal_reading_of_the_same_words_survives():
    """The expensive half: this list *suppresses*, so a blanking pattern that reaches too far refuses a
    chapter that is telling the truth."""
    for lang, sentence in _FRACTION_CONTROLS:
        assert kinds(sentence, lang) == [], sentence


def test_a_fraction_on_its_own_is_still_no_claim_at_all():
    """Blanking removes an exemption, never adds a rule: a sentence with no superlative in it has
    nothing to disarm and stays silent either way."""
    for lang, sentence in (
        ("de", "Ein Drittel der Daten stammt aus ecoinvent."),
        ("es", "Un cuarto de los datos proviene de ecoinvent."),
        ("pt", "Um quarto dos dados provém do ecoinvent."),
    ):
        assert kinds(sentence, lang) == [], sentence


# --- V334: the second operand of a comparison is not the subject of the superlative -------------


def test_the_second_operand_of_a_change_is_what_the_top_is_measured_against():
    """A summary — "X has the highest result and Y the lowest; the highest is
    {{change(X, Y)}} higher than the lowest" — was refused twice over Y, the operand the comparison
    needs. A two-operand derivation is ABOUT its first operand; the second is the yardstick."""
    text = (
        "{{hotspots.0.name}} carries the largest share; the largest is "
        "{{change(hotspots.0.direct, hotspots.1.direct)}} above the runner-up."
    )
    assert blocking(text) == []
    # The same shape with the operands swapped IS a claim about the second-ranked member — refused.
    wrong = (
        "{{hotspots.1.name}} carries the largest share; the largest is "
        "{{change(hotspots.1.direct, hotspots.0.direct)}} above the rest."
    )
    assert "contradicted_claim" in kinds(wrong)


def test_equal_values_contradict_a_direction_claim():
    """Equality was skipped altogether, so "A is higher than B" stood at A = B."""
    same = "{{subjects.0.results.0.score}} is higher than {{subjects.0.results.0.score}}."
    findings = rc.check_claims(same, DATA)
    assert [f["kind"] for f in findings] == ["contradicted_claim"]
    assert "equal" in findings[0]["detail"]
    # …and satisfies a negated one.
    assert kinds("{{subjects.0.results.0.score}} is not higher than {{subjects.0.results.0.score}}.") == []


def test_a_negated_comparison_is_read_the_other_way_round():
    """"not higher" claims lower-or-equal; it was read as "higher" and refused when true."""
    assert kinds("{{subjects.0.results.0.score}} is not higher than {{subjects.1.results.0.score}}.") == []
    assert kinds("{{subjects.1.results.0.score}} is not higher than {{subjects.0.results.0.score}}.") == [
        "contradicted_claim"
    ]
    assert kinds("{{subjects.1.results.0.score}} ist nicht niedriger als {{subjects.0.results.0.score}}.", "de") == []


def test_two_directions_in_one_sentence_are_refused_instead_of_ignored():
    """Both direction words in one sentence switched the check off, and "5 is higher than 10 and lower
    than 1" passed with both halves false. The refusal names the fix: split it."""
    text = (
        "{{subjects.0.results.0.score}} is higher than {{subjects.1.results.0.score}} and lower than "
        "{{subjects.1.results.0.score}}."
    )
    findings = rc.check_claims(text, DATA)
    assert [f["kind"] for f in findings] == ["ambiguous_comparison"]
    assert "two sentences" in findings[0]["detail"]
    assert not rp.check_proposal(text, {"kind": "prose"}, DATA)["ok"]
