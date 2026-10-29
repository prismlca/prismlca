from __future__ import annotations

from prism_lca.search.indexer import build_embed_text, classify_type
from prism_lca.search.ranking import rank, unanchored_terms, unmatched_terms


def test_classify_type():
    assert classify_type("electricity, low voltage") == "P"
    assert classify_type("market for electricity, low voltage") == "M"
    assert classify_type("market group for electricity, low voltage") == "G"


def test_embed_text_strips_market_prefix_and_tags_type():
    text = build_embed_text("market for electricity", "electricity", "")
    assert not text.lower().startswith("market for")
    assert text.endswith("market")


def test_type_boost_orders_market_above_production_at_equal_score():
    raw = [(0.5, {"atype": "P", "geo": "GLO"}), (0.5, {"atype": "M", "geo": "GLO"})]
    ranked, weak = rank(raw)
    assert ranked[0]["atype"] == "M"
    assert weak is False


def test_geography_boost_prefers_target():
    raw = [(0.5, {"atype": "P", "geo": "GLO"}), (0.5, {"atype": "P", "geo": "DE"})]
    ranked, _ = rank(raw, target_geo="DE")
    assert ranked[0]["geo"] == "DE"


def test_type_filter_keeps_only_requested():
    raw = [(0.6, {"atype": "M", "geo": "x"}), (0.5, {"atype": "P", "geo": "x"})]
    ranked, _ = rank(raw, types={"M"})
    assert [x["atype"] for x in ranked] == ["M"]


def test_weak_match_disables_cutoff():
    raw = [(0.2, {"atype": "P", "geo": "x"})]
    ranked, weak = rank(raw)
    assert weak is True
    assert len(ranked) == 1


def test_cutoff_drops_low_scores_when_strong_present():
    raw = [(0.8, {"atype": "P", "geo": "x"}), (0.1, {"atype": "P", "geo": "y"})]
    ranked, weak = rank(raw)
    assert weak is False
    assert len(ranked) == 1
    assert ranked[0]["score"] == 0.8


def test_unmatched_terms_names_a_norm_no_result_has():
    """The failure the similarity score cannot see: a well-formed query for a dataset that does
    not exist, answered with a confidently-scored near-miss (ecoinvent 3.12 has no EURO 6 car)."""
    hits = [
        "market for transport, passenger, car, petrol, medium size, EURO 5 transport GLO",
        "transport, passenger, car, petrol, medium size, EURO 3 transport RER",
    ]
    assert unmatched_terms("transport passenger car petrol EURO 6", hits) == ["6"]


def test_unmatched_terms_is_quiet_when_the_specifier_is_there():
    hits = ["market for transport, passenger, car, petrol, medium size, EURO 5 transport GLO"]
    assert unmatched_terms("transport passenger car petrol EURO 5", hits) == []


def test_unmatched_terms_ignores_ordinary_words():
    """Only digit-bearing terms are reported: prose differs harmlessly between a query and a
    dataset title, and a warning that fires on that would be read past."""
    hits = ["market for electricity, medium voltage electricity DE"]
    assert unmatched_terms("typical household electricity supply", hits) == []


def test_unmatched_terms_reads_euro6_and_euro_6_alike():
    hits = ["market for transport, passenger, car, petrol, medium size, EURO 5 transport GLO"]
    assert unmatched_terms("EURO6 passenger car", hits) == ["6", "euro6"]


def test_unmatched_terms_survives_an_empty_result_set():
    assert unmatched_terms("EURO 6 car", []) == ["6"]
    assert unmatched_terms("", ["anything"]) == []


def test_research_question_detected_but_dataset_queries_are_left_alone():
    """The nudge must fire on a question and stay silent on every real dataset query.

    A warning that goes off on "market for horn meal" would be read past within a day, which is
    exactly how it stops protecting anything — so this pins both directions.
    """
    from prism_lca.search.ranking import looks_like_a_research_question as asks

    assert asks("IPCC 2019 refinement FracLEACH nitrogen managed soils default value")
    assert asks("what is the recycling rate of LDPE film in Germany")

    for dataset_query in (
        "market for horn meal",
        "market for electricity, medium voltage",
        "transport, freight, lorry, 16-32 metric ton, EURO 5",
        "treatment of waste polyethylene, municipal incineration",
        "market for transport, passenger, car, fleet average",
    ):
        assert not asks(dataset_query), dataset_query


# --- unanchored_terms: the material-existence signal (V64) -------------------------------------
# The corpus below is the measured one from an earlier test run (36 labelled queries against
# ecoinvent 3.12). What these tests protect is not a heuristic's score but a DESIGN DECISION: the
# field reports that no result carries a word, and never that the database lacks the material. The
# two are different, and the difference was measured — see test_..._does_not_claim_a_material_is_absent.

_PIB_HITS = [
    "isobutyl acetate production isobutyl acetate",
    "straw production, stand-alone production straw",
    "propylene oxide production, from isobutene, PO/TBA process propylene oxide",
    "soybean production, Swiss integrated production soybean",
    "grass production, Swiss integrated production grass",
]


def test_unanchored_terms_catches_a_material_that_is_not_there():
    """The case the digit-based check structurally cannot see: a material name is pure letters.

    Measured: this query returns straw, soybean and grass production while `weak_match` reports a
    strong match, because one adjacent hit clears the threshold for the whole list.
    """
    assert unanchored_terms("polyisobutylene production", _PIB_HITS) == ["polyisobutylene"]


def test_unanchored_terms_catches_a_shouted_abbreviation():
    """EPDM is four letters, so only the upper-case rule can reach it — and it is the real case.

    The hits are the measured ones: "ethylene" and "propylene" DO occur (in a propylene dataset), so
    only the abbreviation is left unanchored. That is the honest answer — ecoinvent has no EPDM.
    """
    hits = [
        "synthetic rubber production synthetic rubber",
        "market for synthetic rubber synthetic rubber",
        "styrene butadiene rubber production, solution polymerization styrene butadiene rubber",
        "propylene production, from methanol-to-propylene conversion ethylene",
    ]
    assert unanchored_terms("ethylene propylene diene rubber EPDM", hits) == ["epdm"]


def test_unanchored_terms_does_not_claim_a_material_is_absent():
    """A query for "PVC" returns exactly the right datasets, all named "polyvinyl chloride".

    The word really is in none of them, so reporting it is TRUE — and that is the whole point of the
    field's name. A future change that suppressed this by concluding "PVC exists, stay quiet" would
    be tuning; one that reported "no dataset for PVC" would be a lie. Keep the narrow statement.
    """
    hits = [
        "polyvinyl chloride production, suspension polymerisation polyvinyl chloride",
        "market for polyvinyl chloride, emulsion polymerised polyvinyl chloride",
    ]
    assert unanchored_terms("PVC", hits) == ["pvc"]


def test_unanchored_terms_ignores_geography_spelled_out():
    """Locations live in their own field under an ISO code, so a spelled-out country never matches."""
    hits = ["market for electricity, medium voltage electricity, medium voltage DE"]
    assert unanchored_terms("market for electricity, medium voltage, Germany", hits) == []


def test_unanchored_terms_ignores_what_a_part_is_for():
    """"stainless steel sheet for hardware" — the purpose is not the material."""
    hits = ["market for selective coat, stainless steel sheet, black chrome"]
    assert unanchored_terms("stainless steel sheet for hardware", hits) == []


def test_unanchored_terms_stays_quiet_on_ordinary_prose():
    """The docstring's own worry: a signal that fires on normal queries gets read past."""
    for query, hits in (
        ("passenger car", ["transport, passenger, car, petrol, medium size"]),
        ("flat glass coated", ["market for flat glass, coated flat glass, coated"]),
        ("polypropylene granulate", ["polypropylene production, granulate polypropylene"]),
        ("tap water", ["market for tap water tap water"]),
    ):
        assert unanchored_terms(query, hits) == [], query


def test_unanchored_terms_leaves_the_digit_signal_alone():
    """Digits are `unmatched_terms`' business; saying them twice adds nothing."""
    hits = ["transport, passenger, car, petrol, medium size, EURO 5"]
    assert unmatched_terms("EURO 6 passenger car petrol", hits) == ["6"]
    assert unanchored_terms("EURO 6 passenger car petrol", hits) == []


def test_unanchored_terms_survives_an_empty_result_set():
    assert unanchored_terms("polyisobutylene", []) == ["polyisobutylene"]
    assert unanchored_terms("", []) == []


def test_a_six_letter_material_word_is_reportable():
    """V88: "ground" carries the whole meaning of the query and had six letters, so nothing said it.

    Four searches of a wall-paint run asked for ground calcium carbonate and got
    *precipitated* calcium carbonate back, every time with `terms_not_in_results: []`. The model
    concluded the database has no ground CaCO3 and wrote a +32 % uncertainty band around a gap that
    does not exist — `market for limestone, milled, loose` is exactly the material, and it moves the
    result by 0.39 %.
    """
    from prism_lca.search.ranking import unanchored_terms

    hits = [
        "market for calcium carbonate, precipitated",
        "calcium carbonate production, precipitated",
        "calcium nitrate production",
    ]
    assert unanchored_terms("ground calcium carbonate production", hits) == ["ground"]
    assert unanchored_terms("milled calcium carbonate", hits) == ["milled"]
    # Still quiet where the word IS there, and still quiet on the measures that name no material.
    assert unanchored_terms("calcium carbonate", hits) == []
    assert unanchored_terms("annual volume of calcium carbonate", hits) == []


def test_coverage_says_when_the_words_are_spread_over_different_hits():
    """V89: every other honesty field asks its question against the whole list.

    "market for cellulose ether" returned four ethers and one cellulose fibre. Both words occur, in
    different datasets, none of which is a cellulose ether — so `terms_not_in_results` was empty,
    `weak_match` false, and the run lost a round before giving up. `list_methods` has reported
    "matched_words: 4 of 5" since it learned to fall back; the background search did not.
    """
    from prism_lca.search.ranking import best_hit_coverage

    hits = [
        "market for diisopropyl ether",
        "market for chloromethyl methyl ether",
        "market for dimethyl ether",
        "market for cellulose fibre",
        "market for ethylene glycol diethyl ether",
    ]
    assert best_hit_coverage("market for cellulose ether", hits) == (1, 2)
    # An ordinary good search must not trip it: two of three is what those look like.
    assert best_hit_coverage(
        "acrylic binder dispersion", ["market for acrylic binder, with water, in 54% solution state"]
    ) == (2, 3)
    assert best_hit_coverage("titanium dioxide", ["market for titanium dioxide"]) == (2, 2)


def test_query_signature_recognises_the_same_search_worded_differently():
    """V112: a search repeated inside a batch is invisible to the agent's byte-level repeat guard.

    An apple-sauce run asked for apple juice six times and tinplate six times, across
    five different `search_background` calls — no two of which were identical tool calls, so nothing
    noticed. The signature is what makes "tinplate production" and "tinplate" the same question.
    """
    from prism_lca.search.ranking import query_signature

    # The run's real queries, verbatim.
    assert query_signature("apple juice production") == query_signature("apple juice") == ["apple", "juice"]
    assert (
        query_signature("tinplate production")
        == query_signature("tinplate production RER")
        == query_signature("tinplate")
        == ["tinplate"]
    )
    # A genuinely narrower query is NOT the same search, and must not be reported as one.
    assert query_signature("apple juice at plant") == ["apple", "juice", "plant"]
    assert query_signature("tinplate unalloyed production") == ["tinplate", "unalloyed"]
    # Order never decides.
    assert query_signature("juice apple") == query_signature("apple juice")


def test_query_signature_is_empty_when_a_query_names_nothing_specific():
    """The caller must skip empty signatures — otherwise every generic query is "the same search".

    `market for tap water` carries no word that survives the generic-vocabulary filter, and neither
    does `market for the box`; treating those two as one question would fire the repeat note on
    unrelated searches all run long.
    """
    from prism_lca.search.ranking import query_signature

    assert query_signature("market for tap water") == []
    assert query_signature("market for the box") == []


def test_weak_match_is_about_the_hits_that_come_back():
    """It used to ask the whole candidate pool, and the pool is 600 to 2 400 rows.

    Among that many nearest neighbours of a 26 533-row corpus something almost always clears
    0.429, so the flag reported a strong match while every row the caller could see was weak. The
    question it has to answer is about the ANSWER, not about what the retriever looked at.
    """
    from prism_lca.search.ranking import finalize_hybrid

    candidates = [
        {"dense": 0.30, "fused": 0.9, "atype": "P", "geo": "GLO", "code": "a"},
        {"dense": 0.31, "fused": 0.8, "atype": "P", "geo": "GLO", "code": "b"},
        {"dense": 0.32, "fused": 0.7, "atype": "P", "geo": "GLO", "code": "c"},
        # Strong, but ranked far down: the caller never sees it.
        {"dense": 0.95, "fused": 0.01, "atype": "P", "geo": "GLO", "code": "deep"},
    ]
    hits, weak = finalize_hybrid(candidates, limit=3)
    assert [h["code"] for h in hits] == ["a", "b", "c"]
    assert weak is True

    hits, weak = finalize_hybrid(candidates, limit=4)
    assert weak is False  # now it IS in the answer


def test_the_dense_cutoff_still_needs_the_pool_to_decide():
    """`rank` cuts everything under SLOT_CUTOFF — unless nothing in the pool cleared the bar, in
    which case cutting would return an empty list instead of the best available options. That gate
    is a question about the pool and stays one; only the flag handed to the caller moved."""
    from prism_lca.search.ranking import rank

    strong = [(0.30, {"code": "a", "atype": "P", "geo": "GLO"}),
              (0.95, {"code": "d", "atype": "P", "geo": "GLO"})]
    hits, weak = rank(strong, limit=5)
    assert [h["code"] for h in hits] == ["d"]  # the 0.30 was cut
    assert weak is False

    all_weak = [(0.30, {"code": "a", "atype": "P", "geo": "GLO"}),
                (0.20, {"code": "b", "atype": "P", "geo": "GLO"})]
    hits, weak = rank(all_weak, limit=5)
    assert [h["code"] for h in hits] == ["a", "b"]  # nothing cut, or there would be nothing left
    assert weak is True
