"""Result ranking: type-boost, adaptive cutoff, and geography-as-ranking.

Ported from the ecoinvent-bw MCP server: markets/market groups get a score boost so they aren't
crowded out by production datasets, and when nothing scores well (a "weak match", e.g. a proxy
query) the cutoff is disabled so the best available options still surface.

**Geography outranks relevance, and that is deliberate — say so wherever it is described.** This
file used to claim geography was "a ranking signal, not a hard filter". That describes `rank()`
below, which adds a bonus; but `search_hybrid` is on by default, and `finalize_hybrid` sorts by the
geography chain FIRST and by score only within it. So with one region asked for, EVERY hit in that
region precedes every hit outside it, however badly it fits — a weak German neighbour comes before
the dataset you meant in RER. Nothing is dropped, it is a queue rather than a filter; with two or
more regions it is a real filter and the rest is dropped.

Kept that way on purpose: naming a region should decide, not merely nudge. The
cost is that a query whose answer lives one region over reads as "nothing fits" unless you look
past the requested region — which is why every description of this behaviour has to state it, and
why the answer carries `outside_geography_filter`.
"""
from __future__ import annotations

import re
import unicodedata

from prism_lca.search import transport_modes, vocabulary

TYPE_BOOST = {"P": 1.0, "M": 1.20, "G": 1.25}
SLOT_CUTOFF = 0.40
WEAK_TRIGGER = 0.429

#: Letters and digits of any script: "Gütertransport" is one word to these checks, not "g" and "tertransport".
_TOKEN_RE = re.compile(r"[^\W_]+")


def _tokens(text: str) -> set[str]:
    """Lowercase alphanumeric tokens, with digit/letter runs split apart so that
    ``EURO6`` and ``EURO 6`` tokenize alike."""
    out: set[str] = set()
    # Compatibility forms first: "CO₂" and "m²" are "CO2" and "m2" to the datasets.
    for raw in _TOKEN_RE.findall(unicodedata.normalize("NFKC", text).lower()):
        out.add(raw)
        # "euro6" -> {"euro6", "euro", "6"}; harmless for pure words, and it is what makes the
        # spelling of a norm irrelevant to the check below.
        for part in re.findall(r"\d+|[^\W\d_]+", raw):
            out.add(part)
    return out


def unmatched_terms(query: str, hit_texts: list[str]) -> list[str]:
    """Query terms that appear in **no** result — the honest "not found" the score cannot give.

    ``weak_match`` only fires when *every* candidate is below the similarity threshold, which
    catches gibberish and misses the case that actually costs a study: a well-formed query for a
    dataset that does not exist. Measured on ecoinvent 3.12, "EURO 6 passenger car petrol" scores
    0.61 and confidently returns a **EURO 5** car — the specifier that made the query wrong is the
    one part of it nothing matched, and nothing said so.

    Only digit-bearing terms are reported: emission norms, years and size classes are where a
    near-miss changes the dataset's meaning, while ordinary words differ harmlessly between a query
    and a dataset title ("car" vs "passenger car"). Conservative on purpose — a warning that fires
    on normal prose would be read past, and then it protects nothing.
    """
    if not query:
        return []
    hay: set[str] = set()
    for text in hit_texts:
        hay |= _tokens(text)
    missing = [t for t in _tokens(query) if any(c.isdigit() for c in t) and t not in hay]
    # Deterministic order so the field is stable across identical requests (and in tests).
    return sorted(missing)


# Words that say nothing about whether a MATERIAL exists: ecoinvent's own structural vocabulary,
# plus the words a practitioner wraps a query in. Kept deliberately small — this list only has to
# suppress the terms that would otherwise fire on almost every query.
_GENERIC_TERMS = frozenset({
    "production", "market", "group", "treatment", "process", "processing", "manufacture",
    "manufacturing", "waste", "disposal", "recycling", "incineration", "landfill", "burned",
    "transport", "freight", "electricity", "heat", "energy", "water", "fuel",
    "average", "generic", "material", "product", "unspecified", "other", "mixture",
    "granulate", "sheet", "profile", "profiles", "powder", "liquid", "solid",
    "typical", "conventional", "modern", "small", "large", "medium", "high", "low",
    # What a component is FOR is not what it is MADE OF, and a query says both:
    # "stainless steel sheet for hardware" fired on "hardware" until these were listed.
    "hardware", "fitting", "fittings", "component", "components", "packaging", "building",
    "construction", "industrial", "reinforcement", "insulation", "coating", "sealant",
    # Six-letter measures and qualifiers, listed when _MIN_CONTENT_WORD dropped from 7 to 6: they
    # occur in ecoinvent's own product names, so they are not exotic, but none of them names a
    # MATERIAL — a query carrying them is describing a dataset, not asking whether a substance exists.
    "amount", "annual", "change", "impact", "metric", "system", "volume", "weight",
})

# Geography is a SEPARATE field in every hit and a ranking signal, not part of a dataset's name —
# ecoinvent names locations by ISO code ("DE"), so a query that spells the country out ("…, Germany")
# has a term that no name can ever contain. Measured: this was one of two false-alarm classes when
# the check below was first tried, and the only one with a clean fix.
_GEO_WORDS = frozenset({
    "germany", "france", "italy", "spain", "austria", "switzerland", "netherlands", "belgium",
    "poland", "portugal", "sweden", "norway", "denmark", "finland", "ireland", "greece",
    "hungary", "czechia", "slovakia", "slovenia", "croatia", "romania", "bulgaria", "estonia",
    "latvia", "lithuania", "luxembourg", "britain", "kingdom", "england", "scotland", "wales",
    "europe", "european", "eu", "rer", "glo", "row", "global", "world",
    "china", "india", "japan", "korea", "brazil", "canada", "mexico", "australia", "russia",
    "usa", "us", "america", "american", "turkey", "africa", "asia",
    "national", "regional", "domestic", "local", "without",
})

#: An abbreviation shorter than this is not treated as a content term even in upper case.
_MIN_ABBREVIATION = 3
#: A lower-case word shorter than this is ordinary prose, not a material name.
#:
#: Was 7 earlier, and a wall-paint study showed what that cost. Four searches for ground
#: calcium carbonate returned *precipitated* calcium carbonate, calcium acetate and cobalt, every one
#: of them with ``terms_not_in_results: []`` — because "ground", the word carrying the whole meaning,
#: has six letters. The model concluded the database has no ground CaCO3, wrote that into a
#: limitation, and built a ±32 % uncertainty band around a gap that does not exist: `market for
#: limestone, milled, loose` [RER] is exactly the material and moves the result by 0.39 %.
#:
#: Measured over the reference-product names of ecoinvent 3.12 cut-off: **311 distinct six-letter
#: words**, 11.5 % of all content-word occurrences, among them `carbon`, `cement`, `copper`, `sodium`,
#: `sulfur`, `gypsum`, `veneer`, `starch`, `diesel`, `ground`, `milled`. At 7 the check could never
#: report a single one of them. Five is a step too far: that band is half prose (`green`, `dried`,
#: `scale`, `state`, `light`, `based`) and would trade a silent check for a noisy one.
_MIN_CONTENT_WORD = 6


#: Coverage (below) may use a shorter word than :data:`_MIN_CONTENT_WORD`, because the two make
#: different claims. "No result carries this word" is an absolute statement about the database and
#: has to be conservative; "the best single result carries 1 of your 2 words" is a statement about
#: THESE results, obviously soft, and cheap to be wrong about. At 6 the measured case would have
#: stayed silent: "cellulose ether" has one qualifying word, and one of one is no signal.
_MIN_COVERAGE_WORD = 4

#: Words the search reads in its own way — the everyday words it replaces, the words that name a transport
#: mode. They count as content however short: "truck" missing from every result is worth saying, and
#: "car" and "van" make two different searches.
_RECOGNISED = vocabulary.WORDS | transport_modes.WORDS


#: Words that are generic as MATERIAL names and decisive as QUALIFIERS. `_GENERIC_TERMS` drops them,
#: rightly: "high" names no substance, so "is high in the database" is a question worth nobody's time.
#: For :func:`query_signature` the question is a different one — *is this the same query* — and there
#: they are the whole difference. Measured: "treatment of waste **low** density polyethylene
#: municipal incineration" and the same line with **high** both signatured as
#: ``["density", "municipal", "polyethylene"]``, so a search for HDPE incineration was told it had
#: already searched LDPE incineration — inside the same batched call (V276).
_CONTRASTIVE_TERMS = frozenset({
    "high", "low", "virgin", "recycled", "primary", "secondary", "tertiary",
    "small", "large", "medium", "wet", "dry", "dried", "green",
})


def content_terms(
    query: str, min_len: int = _MIN_CONTENT_WORD, keep: frozenset[str] = frozenset()
) -> list[str]:
    """The words of a query that name something, alphabetically and without duplicates.

    The same filtering :func:`unanchored_terms` applies before it asks "is this word anywhere":
    digits belong to :func:`unmatched_terms`, generic vocabulary and geography say nothing about a
    material, and a word must clear ``min_len`` unless the query SHOUTED it.
    """
    if not query:
        return []
    shouted = {m.group(0).lower() for m in re.finditer(r"\b[A-Z][A-Z0-9]{1,}\b", query)}
    out: list[str] = []
    for term in sorted(_tokens(query)):
        if term in keep:
            out.append(term)
            continue
        if any(c.isdigit() for c in term) or term in _GENERIC_TERMS or term in _GEO_WORDS:
            continue
        if len(term) >= (_MIN_ABBREVIATION if term in shouted else min_len):
            out.append(term)
    return out


def query_signature(query: str) -> list[str]:
    """The words that make this query *this* query — what two searches must share to be the same one.

    Returned so the caller can recognise that a search has already been run in this conversation.
    Deliberately the coverage-level vocabulary rather than the stricter
    :data:`_MIN_CONTENT_WORD` band: "apple juice" is two five-letter words and would otherwise
    signature as the empty list, i.e. identical to every other query.

    Measured on an apple-sauce run, which spent three rounds re-asking for two materials
    that are not in the database: "apple juice production" and "apple juice" both reduce to
    ``["apple", "juice"]``, and "tinplate production", "tinplate production RER" and "tinplate" all
    reduce to ``["tinplate"]`` — because "production" is generic vocabulary and "RER" is geography.
    The byte-level guard in the agent loop cannot see any of that: those queries travelled inside
    different batches, so no two tool calls were ever identical.

    This makes no claim about the database. It says only what the run has already asked.

    The contrastive qualifiers are kept even though `_GENERIC_TERMS` drops them everywhere else:
    "high" names no material, but it is exactly what separates two of them (V276).
    """
    return content_terms(query, _MIN_COVERAGE_WORD, keep=_CONTRASTIVE_TERMS | _RECOGNISED)


def best_hit_coverage(query: str, hit_texts: list[str]) -> tuple[int, int]:
    """How many of the query's content words the BEST SINGLE result carries, and how many there are.

    ``terms_not_in_results`` asks the question per word against the whole list, and that is the wrong
    question when a query names a compound. Measured on a wall-paint run: "market for
    cellulose ether" returned *diisopropyl ether*, *chloromethyl methyl ether*, *dimethyl ether*,
    *cellulose fibre* and *ethylene glycol diethyl ether*. Both content words occur — in different
    datasets, none of which is a cellulose ether — so every honesty field stayed silent and the model
    lost a round before giving up without documenting the gap.

    ``list_methods`` has answered this since it learned to fall back ("matched_words": "4 of 5"); the
    background search, where the stakes are a wrong material rather than a wrong indicator, did not.
    """
    terms = content_terms(query, _MIN_COVERAGE_WORD)
    if not terms or not hit_texts:
        return (0, len(terms))
    best = 0
    for text in hit_texts:
        hay = _tokens(text)
        best = max(best, sum(1 for t in terms if t in hay))
    return (best, len(terms))


def unanchored_terms(query: str, hit_texts: list[str]) -> list[str]:
    """Content terms of the query that occur in **no** result's name or reference product.

    This is deliberately *evidence*, not a verdict, and the difference was settled by measurement.
    A verdict ("this material is not in the database") is wrong often enough to do harm: a query for
    "PVC" returns exactly the right datasets, which are all named "polyvinyl chloride", so the
    abbreviation appears in no name — a tool that concluded "not present" would lie about a dataset
    the model is holding in its hand. The true statement is the narrower one, "no result carries this
    word", and it happens to lead to the right action in both cases: for "PVC" the model looks for the
    full name it can already see, for "EPDM" it learns there is nothing to find and documents a proxy.

    Why it is needed at all: ``unmatched_terms`` above only reports digit-bearing terms, so the entire
    class of "is this MATERIAL in ecoinvent?" — pure letters, every time — could never raise anything.
    Measured on ecoinvent 3.12: "polyisobutylene production" returns *straw production*,
    *soybean production* and *grass production* while ``weak_match`` says the match is strong, because
    one adjacent hit ("isobutyl acetate", 0.59) clears the threshold for the whole list. And the score
    cannot be taught to separate the two cases — EPDM, which does not exist, scores 0.634 while
    polyvinyl chloride, which does, scores 0.626.

    Three filters keep it quiet on ordinary queries, each for a measured reason:
    generic vocabulary (:data:`_GENERIC_TERMS`) because "production" matches nothing in particular;
    geography (:data:`_GEO_WORDS`) because locations live in their own field under an ISO code;
    and length, unless the query wrote the term in CAPITALS — which is how a model writes the
    abbreviations that matter ("EPDM", "TPS") and is what lets this catch them without also firing
    on every short word of prose.
    """
    if not query:
        return []
    hay: set[str] = set()
    for text in hit_texts:
        hay |= _tokens(text)
    # Upper-case runs in the ORIGINAL query: abbreviations are content however short they are.
    shouted = {m.group(0).lower() for m in re.finditer(r"\b[A-Z][A-Z0-9]{1,}\b", query)}
    out: set[str] = set()
    restated = vocabulary.restated(query)
    for term in _tokens(query):
        if any(c.isdigit() for c in term) or term in restated:
            continue  # digits are unmatched_terms' business; a restated word's reading stands in the query
        if term in _GENERIC_TERMS or term in _GEO_WORDS:
            continue
        long_enough = term in _RECOGNISED or len(term) >= (_MIN_ABBREVIATION if term in shouted else _MIN_CONTENT_WORD)
        if long_enough and term not in hay:
            out.add(term)
    return sorted(out)


# European geographies (ISO codes as used by ecoinvent, plus the European aggregates):
# only these get the RER / "Europe without Switzerland" proxies inserted into their chain —
# a Chinese or Brazilian target must fall back to GLO/RoW, not to European datasets.
_EUROPEAN = frozenset({
    "AL", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
    "FR", "GB", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MD", "ME",
    "MK", "MT", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "UA", "XK",
    "RER", "Europe without Switzerland", "Europe without Austria", "UCTE", "ENTSO-E",
})


def geo_chain(target: str | None) -> list[str]:
    """Proxy chain for a target region: exact match, then regional aggregates (European
    targets only), then the global proxies. Non-European targets skip RER — previously the
    chain was hardcoded Euro-centric for every target."""
    if not target:
        return []
    chain = [target]
    if target in _EUROPEAN:
        chain += ["RER", "Europe without Switzerland"]
    chain += ["GLO", "RoW"]
    seen: list[str] = []
    for g in chain:
        if g not in seen:
            seen.append(g)
    return seen


def geo_rank(loc: str | None, target: str | None) -> int:
    chain = geo_chain(target)
    if loc in chain:
        return chain.index(loc)
    return len(chain) + 1


def _geo_bonus(loc: str | None, target: str | None) -> float:
    if not target:
        return 0.0
    rank = geo_rank(loc, target)
    if rank == 0:
        return 0.15
    if rank <= len(geo_chain(target)):
        return max(0.0, 0.10 - 0.02 * rank)
    return -0.05


def _weak(hits: list[dict], field: str) -> bool:
    """Whether the hits ACTUALLY RETURNED are all below the similarity bar.

    Measured against the delivered list on purpose. Both rankers used to ask this of the
    whole candidate pool instead — 600 to 2 400 rows for a `limit` of 25 to 50, grown further when
    collapsing needed more. Among that many nearest neighbours of a 26 533-row corpus something
    almost always clears 0.429, so the flag said "strong match" while every row the caller could see
    was weak. A flag that is nearly always False protects nobody.

    An empty list is weak: nothing came back, so nothing resembled the query.
    """
    return not any(h.get(field, 0.0) >= WEAK_TRIGGER for h in hits)


def _passes(meta: dict, types: set | None, geos: set | None) -> bool:
    """Multi-select filters: keep the item if its type / geography is among the selected ones
    (empty selection = no filter on that facet)."""
    if types and meta.get("atype") not in types:
        return False
    if geos and (meta.get("geo") or "") not in geos:
        return False
    return True


def finalize_hybrid(
    candidates: list[dict],
    *,
    target_geo: str | None = None,
    types: set | None = None,
    geos: set | None = None,
    limit: int = 50,
) -> tuple[list[dict], bool]:
    """Order fused (dense+BM25) hybrid candidates. Each candidate carries ``fused`` (RRF score),
    ``dense`` (cosine, for weak-match + display) and ``atype``/``geo``. ``types``/``geos`` are
    multi-select hard filters; the type boost applies on the rest.

    **``target_geo`` is the primary sort key, ahead of the score.** Everything in the requested
    region comes first, then the proxy chain (RER / Europe without Switzerland / GLO / RoW), then
    the rest — and only within each of those bands does the score decide. A hit that barely matches
    but sits in the right region therefore outranks a much better one outside it. See the module
    docstring: deliberate, and to be stated wherever this is described."""
    items = [c for c in candidates if _passes(c, types, geos)]
    for c in items:
        c["final"] = c.get("fused", 0.0) * TYPE_BOOST.get(c.get("atype"), 1.0)
    if target_geo:
        items.sort(key=lambda c: (geo_rank(c.get("geo"), target_geo), -c["final"]))
    else:
        items.sort(key=lambda c: -c["final"])
    out = items[:limit]
    return out, _weak(out, "dense")


def rank(
    raw: list[tuple[float, dict]],
    *,
    target_geo: str | None = None,
    types: set | None = None,
    geos: set | None = None,
    limit: int = 50,
) -> tuple[list[dict], bool]:
    items = [{"score": score, **meta} for score, meta in raw if _passes(meta, types, geos)]

    # Two different questions, and conflating them is what made `weak_match` useless. THIS one is
    # "did the retrieval find anything at all", and it gates the cutoff below: when nothing in the
    # candidate pool clears the bar, cutting at SLOT_CUTOFF would return an empty list instead of
    # the best available options. The flag the ANSWER carries is a different question — see below.
    nothing_retrieved = not any(x["score"] >= WEAK_TRIGGER for x in items)

    for x in items:
        boosted = x["score"] * TYPE_BOOST.get(x.get("atype"), 1.0)
        x["final"] = boosted + _geo_bonus(x.get("geo"), target_geo)

    if not nothing_retrieved:
        items = [x for x in items if x["score"] >= SLOT_CUTOFF]

    items.sort(key=lambda x: x["final"], reverse=True)
    out = items[:limit]
    return out, _weak(out, "score")

#: Words that ask a question rather than name a dataset. A query built from these is aimed at the
#: literature, not at ecoinvent — the search will still return its closest activities, which is the
#: unhelpful part: plausible rows for a question the database was never going to answer.
_RESEARCH_WORDS = frozenset(
    {
        "what", "which", "how", "why", "when", "default", "typical", "average", "share",
        "rate", "ratio", "fraction", "factor", "guideline", "guidelines", "standard",
        "recommended", "value", "values", "per", "quota", "statistics", "study", "report",
    }
)

#: Bodies and standards that publish figures, never dataset names.
_SOURCE_WORDS = frozenset(
    {"ipcc", "emep", "eea", "iso", "din", "en", "uba", "oecd", "fao", "eurostat", "who", "epa"}
)


def looks_like_a_research_question(query: str) -> bool:
    """True when the query reads as a request for a FIGURE rather than for a dataset.

    Kept deliberately narrow. It fires on the combination — a question/quantity vocabulary AND a
    citable body, or an outright interrogative — because ordinary dataset queries are noun phrases
    ("market for horn meal", "transport, freight, lorry") and must never trip this. The cost of a
    false positive is a misleading nudge on a perfectly good search, which is worse than silence.
    """
    if not query:
        return False
    words = {w for w in _tokens(query) if not w.isdigit()}
    if not words:
        return False
    asks = len(words & _RESEARCH_WORDS)
    cites = len(words & _SOURCE_WORDS)
    # An interrogative on its own is enough; otherwise it takes a body plus question vocabulary.
    if words & {"what", "which", "how", "why"}:
        return True
    return bool(cites and asks)
