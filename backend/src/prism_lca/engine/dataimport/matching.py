"""Deciding what a foreign flow is, in our vocabulary — and when to decide nothing.

The order matters and it is the opposite of what "AI import" suggests:

1. **Identifiers.** EcoSpold 2, ILCD and JSON-LD carry UUIDs. Where one hits, there is nothing to
   judge and no model is asked.
2. **Rules.** Exact name plus exact compartment plus a convertible unit is a match. So is the
   compartment rule of :mod:`compartments`, one band lower.
3. **Only then a model**, and only over a shortlist this module produced — never over free text.

The confidence band is assigned **here, by rule**, not by the model. A model's own confidence is
known to be overconfident and uncalibrated; it is one input among several, never the verdict.

And the asymmetry that runs through the whole feature: **not matching is cheap, matching wrongly is
not.** A flow left open is visible in the review table, in the health check and in the report's
limitations. A flow matched to the wrong substance is a number that looks finished.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum

from prism_lca import _log
from prism_lca.engine.dataimport import compartments, units
from prism_lca.engine.dataimport.model import FlowProperty, ForeignDataset, ForeignExchange

BIOSPHERE_DB = "biosphere3"

#: Where a match target lives when it is a dataset of the package being imported, not of any
#: database yet. Not a Database: the commit rewrites it to the dataset's final code in the library,
#: which only exists once every dataset of the package has been written.
PACKAGE_DB = "prism_import_package"


class Confidence(StrEnum):
    """How much a match may be trusted. ``open`` means no match was made at all."""

    good = "good"
    medium = "medium"
    low = "low"
    open = "open"


#: How many regions of one activity go onto the shortlist. A cap, because ecoinvent has electricity
#: in eighty of them and eighty is not a choice anybody makes. The number is the search's own
#: ``VARIANTS_SHOWN``: the same activity should not offer more regions here than the process search
#: shows for it.
REGIONS_PER_HIT = 12


def searched_why(why: str, hit: dict) -> str:
    """The shortlist reason, plus what the search read an abbreviation as. A source dataset called
    "PET resin" is also searched as "polyethylene terephthalate resin"; a reviewer weighing the candidates
    should see that reading — and catch it when it is wrong (search/abbrev.py)."""
    searched_as = hit.get("searched_as")
    return f"{why} (also searched as “{searched_as}”)" if searched_as else why


@dataclass(frozen=True)
class Candidate:
    database: str
    code: str
    name: str
    unit: str
    categories: tuple[str, ...] = ()
    location: str = ""
    reference_product: str = ""
    #: What put this on the shortlist — shown beside it so a reviewer can weigh it.
    why: str = ""
    #: The candidate makes the wanted product only as a CO-PRODUCT. Linking to it buys its whole
    #: process — reference product and all — so it cannot be chosen until somebody has allocated it;
    #: ``decide`` refuses it without an explicit confirmation (``import_allocation_required``).
    allocation_required: bool = False
    #: The candidate's reference production is negative — a treatment, the kind of dataset a waste
    #: output is booked against. None when nobody looked (only waste rows and hand searches do).
    treatment: bool | None = None

    @property
    def label(self) -> str:
        parts = [self.name]
        if self.categories:
            parts.append(" / ".join(self.categories))
        if self.location:
            parts.append(self.location)
        return " · ".join(parts)


@dataclass
class Match:
    exchange: ForeignExchange
    target: Candidate | None = None
    confidence: Confidence = Confidence.open
    #: Why this target, or why none. Always filled — a match without a reason cannot be reviewed.
    evidence: str = ""
    #: What the source amount must be multiplied by to mean the same in the target's unit.
    factor: float = 1.0
    scale_note: str = ""
    #: The shortlist, kept even after a decision so the review table can offer the alternatives.
    candidates: list[Candidate] = field(default_factory=list)
    #: True when rules could not decide and a model should look at the shortlist.
    needs_model: bool = False
    #: True when a process target stands but its REGION was nobody's decision: the dataset exists in
    #: several regions, the source named none, and neither the model nor a rule may pick a country —
    #: a forced region is a guess dressed as a decision. The reviewer chooses, and until they do the
    #: import refuses to commit. Cleared by an explicit region choice (see session.decide).
    region_open: bool = False

    @property
    def matched(self) -> bool:
        return self.target is not None


#: An ion or oxidation-state suffix, as ecoinvent writes it: "Antimony ion", "Cadmium II",
#: "Selenium IV" — and as a source writes it the other way round: "Cadmium, ion".
_ION_SUFFIX = re.compile(r"(?:,?\s*(?:ion|i{1,3}|iv|v|vi|vii))$", re.IGNORECASE)


#: A CAS index name: the parent compound first, the substituent after a comma and ending in a
#: hyphen — "Methane, bromo-", "Ethane, 1,2-dibromo-", optionally trailed by a trade code
#: ("…, HCFC-22"). ecoinvent writes the systematic name instead, so the two never share enough
#: words for any lexical search and mean exactly the same substance.
_CAS_INDEX_NAME = re.compile(r"^([A-Za-z][A-Za-z ]*?),\s*(.+?-)(?:,\s*[^,]*)?$")


def spaceless(name: str) -> str:
    """A comparison key where "Ethyl benzene" and "ethylbenzene" are the same string."""
    return re.sub(r"\s+", "", name.strip().lower())


def invert_indexed_name(name: str) -> str | None:
    """"Methane, bromo-" → "bromomethane". None when the name is not in index form.

    Measured on the US LCI ABS resin: nine flows, every one of them correct — 1,1,1-Trichloroethane,
    1,2-Dibromoethane, Bromomethane, Chlorodifluoromethane, Chlorotrifluoromethane, Dichloromethane,
    Ethyl benzene (twice) and 2,4-Dimethylphenol.
    """
    found = _CAS_INDEX_NAME.match(name.strip())
    return spaceless(found.group(2)[:-1] + found.group(1)) if found else None


#: Qualifiers that say "we did not narrow this down" rather than naming a different substance.
#: Deliberately short and content-free: "non-fossil" or "biogenic" WOULD change the substance
#: (ecoinvent keeps "Methane, fossil" and "Methane, non-fossil" apart), so they are not here.
_EMPTY_QUALIFIERS = frozenset(
    {"unspecified", "unspecified origin", "total", "unspecified isomers", "all isomers"}
)


def drop_empty_qualifier(name: str) -> str | None:
    """"Nitrogen, total" → "Nitrogen"; "NMVOC …, unspecified origin" → "NMVOC …".

    A qualifier that only says "not narrowed down" is not part of the substance. Every LCA source
    adds its own — ", total", ", unspecified", ", unspecified origin" — and the receiving database
    usually carries the bare name. General, not a rule for one file.
    """
    head, _, tail = name.rpartition(",")
    if not head:
        return None
    return head.strip() if tail.strip().lower() in _EMPTY_QUALIFIERS else None


def collective_name(name: str) -> tuple[str, ...]:
    """The unspeciated collective a vocabulary may keep instead of the single substance.

    ecoinvent (and ILCD, and SimaPro) carry "Xylenes, unspecified" where a source writes "Xylene",
    "Phenols, unspecified" where it writes a phenol it did not identify. Only reached when the bare
    name has no match of its own, so a source naming a substance the vocabulary HAS never lands on
    the collective.
    """
    stem = name.strip()
    return (f"{stem}s, unspecified", f"{stem}es, unspecified", f"{stem}, unspecified")


def strip_ion_suffix(name: str) -> str:
    """"Cadmium II" and "Cadmium, ion" and "Cadmium" all reduce to "cadmium"."""
    text = normalise_name(name)
    while True:
        stripped = _ION_SUFFIX.sub("", text).strip().rstrip(",").strip()
        if stripped == text or not stripped:
            return text
        text = stripped


#: The two spellings chemistry never settled on. Our vocabulary is inconsistent about it itself —
#: "Aluminium" and "Caesium" the British way, "sulfate" and "sulfuron" the American — so this is not
#: about the source being foreign. Folding both to one form is what lets the ion rule see that
#: US LCI's "Aluminum" in water is our "Aluminium III"; without it the match dies on a vowel.
_SPELLINGS = (("aluminum", "aluminium"), ("cesium", "caesium"), ("sulph", "sulf"))


def normalise_name(text: str) -> str:
    """Lower-case, collapse whitespace, level the dash zoo.

    A writer that types an en dash where the vocabulary has a hyphen has not named a different
    substance, and treating those as two things would leave half a SimaPro export unmatched for a
    reason no user could see.
    """
    levelled = (text or "").replace("–", "-").replace("—", "-").replace("−", "-")
    folded = re.sub(r"\s+", " ", levelled).strip().lower()
    for british, american in _SPELLINGS:
        folded = folded.replace(british, american)
    return folded


@dataclass
class BiosphereIndex:
    """Our elementary flows, in the three shapes matching needs to look them up.

    Built once per import run: 9 850 flows (measured on ecoinvent 3.12) is nothing to hold in
    memory and everything to avoid scanning per exchange.
    """

    by_code: dict[str, Candidate] = field(default_factory=dict)
    by_name_categories: dict[tuple[str, tuple[str, ...]], list[Candidate]] = field(default_factory=dict)
    by_name: dict[str, list[Candidate]] = field(default_factory=dict)
    #: (name, compartment) — the same name anywhere under that compartment, whatever the
    #: subcompartment. What makes "the only one there is" answerable.
    by_name_compartment: dict[tuple[str, str], list[Candidate]] = field(default_factory=dict)
    #: (normalised synonym, compartment) — the names ecoinvent itself records for a flow. Worth
    #: more than any convention we can write down: 2 818 of 9 850 flows carry them, and they already
    #: hold the cases we had reasoned out by hand — "Aluminium III" lists "Aluminum", "Bromomethane"
    #: lists "Methane, bromo-", "Barium II" lists "Barium". Data instead of rules.
    by_synonym_compartment: dict[tuple[str, str], list[Candidate]] = field(default_factory=dict)
    #: (spaceless lowercase name, compartment) — for the CAS-index inversion below, where
    #: "Ethyl benzene" and "ethylbenzene" have to meet.
    by_key_compartment: dict[tuple[str, str], list[Candidate]] = field(default_factory=dict)
    #: (base name, compartment) — the name with an ion or oxidation-state suffix removed. ecoinvent
    #: names a metal EMISSION as its ion ("Antimony ion", "Cadmium II", "Selenium IV") and keeps the
    #: bare element for the RESOURCE; a source that writes "Antimony" to air means the ion, and no
    #: amount of word overlap will ever say so (measured on the US LCI ABS resin: 38 of 105 flows).
    by_base_compartment: dict[tuple[str, str], list[Candidate]] = field(default_factory=dict)

    @classmethod
    def build(cls, flows) -> BiosphereIndex:
        index = cls()
        for flow in flows:
            categories = tuple(str(c) for c in (flow.get("categories") or ()))
            candidate = Candidate(
                database=BIOSPHERE_DB,
                code=str(flow.get("code") or ""),
                name=str(flow.get("name") or ""),
                unit=str(flow.get("unit") or ""),
                categories=categories,
            )
            index.by_code[candidate.code] = candidate
            key = normalise_name(candidate.name)
            index.by_name.setdefault(key, []).append(candidate)
            index.by_name_categories.setdefault((key, categories), []).append(candidate)
            if categories:
                compartment = categories[0]
                index.by_name_compartment.setdefault((key, compartment), []).append(candidate)
                index.by_base_compartment.setdefault(
                    (strip_ion_suffix(key), compartment), []
                ).append(candidate)
                index.by_key_compartment.setdefault(
                    (spaceless(candidate.name), compartment), []
                ).append(candidate)
                for synonym in flow.get("synonyms") or ():
                    alias = normalise_name(str(synonym))
                    # A synonym that IS another flow's name would make the two indistinguishable —
                    # "Aluminium III" lists plain "Aluminium", which exists in its own right as the
                    # resource. The real name always wins; a synonym only fills a gap.
                    if alias and alias != key:
                        index.by_synonym_compartment.setdefault(
                            (alias, compartment), []
                        ).append(candidate)
        return index

    def lookup(self, name: str, categories: tuple[str, ...]) -> list[Candidate]:
        return list(self.by_name_categories.get((normalise_name(name), categories), []))

    def search(self, query: str, limit: int = 40) -> list[Candidate]:
        """Word-overlap search over ALL compartments — for the reviewer, not for the matcher.

        Deliberately unfiltered where :meth:`by_compartment` filters: the matcher must never be
        offered a flow from the wrong medium, but a person looking one up may well be correcting
        the compartment itself, and an empty result would leave them no way to say so.
        """
        words = {w for w in re.split(r"[^a-z0-9]+", normalise_name(query)) if len(w) > 1}
        if not words:
            return []
        scored: list[tuple[int, int, Candidate]] = []
        for key, entries in self.by_name.items():
            key_words = {w for w in re.split(r"[^a-z0-9]+", key) if len(w) > 1}
            overlap = len(words & key_words)
            if not overlap:
                continue
            for candidate in entries:
                # Whole-phrase hits first, then more shared words, then the shorter name: a search
                # for "carbon dioxide" should not open with "carbon disulfide".
                exact = 0 if normalise_name(query) in key else 1
                scored.append((exact, -overlap, candidate))
        scored.sort(key=lambda t: (t[0], t[1], len(t[2].name), t[2].name))
        return [candidate for _e, _o, candidate in scored[:limit]]

    def by_compartment(self, name: str, compartment: str, limit: int = 20) -> list[Candidate]:
        """Everything in one compartment whose name shares a word with this one.

        The compartment is a **filter and not a feature**: a candidate from the wrong medium never
        reaches the shortlist, because CO₂ to air and CO₂ to water are two flows with two different
        characterisation factors and a model shown both will sometimes take the wrong one.
        """
        words = {w for w in re.split(r"[^a-z0-9]+", normalise_name(name)) if len(w) > 2}
        if not words:
            return []
        scored: list[tuple[int, Candidate]] = []
        for key, entries in self.by_name.items():
            overlap = len(words & {w for w in re.split(r"[^a-z0-9]+", key) if len(w) > 2})
            if not overlap:
                continue
            for candidate in entries:
                if candidate.categories and candidate.categories[0] == compartment:
                    scored.append((overlap, candidate))
        scored.sort(key=lambda pair: (-pair[0], len(pair[1].name)))
        return [candidate for _score, candidate in scored[:limit]]


def property_bridge(exchange: ForeignExchange, to_unit: str) -> units.Rescale | None:
    """A conversion across two quantities, using a property the source itself states.

    A flow given in m³ whose file also records its mass per m³ has told us its density; a waste in
    kg with a stated calorific value has told us its MJ. Using those numbers is reading the file,
    not assuming — which is why this outranks a model-supplied bridge and lands one band higher.
    Only exact steps qualify: chaining one assumption onto another would compound two guesses.
    """
    usable: list[tuple[FlowProperty, float]] = []
    for prop in exchange.properties:
        step = units.rescale(prop.unit, to_unit)
        if step.ok and step.kind is units.EXACT and prop.amount > 0:
            usable.append((prop, prop.amount * step.factor))
    if not usable:
        return None
    # Several properties can reach the same unit. A dry mass is a *fraction* of the flow where the
    # plain mass IS the flow, and a gross calorific value books condensation heat the receiving
    # inventory usually does not — whole basis first, net before gross, then the plainer name.
    usable.sort(key=lambda pair: ("dry" in pair[0].name.lower(), "gross" in pair[0].name.lower(), len(pair[0].name)))
    prop, quantity = usable[0]
    return units.with_assumption(
        exchange.unit,
        to_unit,
        quantity=quantity,
        what=f"the source's own “{prop.name}” ({prop.amount:g} {prop.unit} per {exchange.unit})",
    )


def _scaled(exchange: ForeignExchange, candidate: Candidate) -> units.Rescale:
    rescale = units.rescale(exchange.unit, candidate.unit)
    if rescale.ok or not exchange.properties:
        return rescale
    return property_bridge(exchange, candidate.unit) or rescale


def match_biosphere(exchange: ForeignExchange, index: BiosphereIndex, *, search=None) -> Match:
    """Rules first. Whatever they cannot settle comes back with a shortlist and ``needs_model``.

    ``search`` is the project's semantic index over ``biosphere3`` — the one the background build has
    been filling all along and nobody ever queried. Without it the shortlist is word overlap, and
    word overlap cannot see that "Nitrous oxide" is our "Dinitrogen monoxide" or that "Hydrogen
    chloride" is our "Hydrochloric acid": no shared word, no candidate, no chance for the model.
    """
    match = Match(exchange=exchange)

    # 1 — the source's own identifier, where our biosphere happens to use the same one.
    if exchange.uuid and exchange.uuid in index.by_code:
        candidate = index.by_code[exchange.uuid]
        rescale = _scaled(exchange, candidate)
        if rescale.ok:
            return Match(
                exchange=exchange,
                target=candidate,
                confidence=Confidence.good,
                evidence=f"same flow identifier ({exchange.uuid})",
                factor=rescale.factor,
                scale_note=rescale.note if rescale.factor != 1.0 else "",
                candidates=[candidate],
            )
        # An identifier that hits but whose unit will not convert is a contradiction worth naming.
        match.evidence = (
            f"the identifier {exchange.uuid} points at “{candidate.name}”, but {rescale.note}"
        )
        match.candidates = [candidate]
        return match

    placed = compartments.resolve(exchange.compartment)
    if placed.categories is None and not placed.compartment:
        match.evidence = placed.reason
        return match

    if placed.categories is None:
        # The compartment is known, the subcompartment is not — "resource, unspecified", where our
        # biosphere has no bare "natural resource" to fall back on. Not a dead end: if the substance
        # exists in exactly one subcompartment there is nothing left to guess. Coal is in the
        # ground, and ecoinvent has it nowhere else.
        settled = _place_in_compartment(exchange, index, placed.compartment, placed.reason)
        if settled is not None and (settled.target or settled.candidates):
            return settled
        # And when the name does not hit, this row goes to the shortlist like every other — it must
        # NOT end here. It did, and "Coal, lignite, in ground" reached nobody: no candidates, so
        # never asked, and counted as a settled non-match. A missing
        # subcompartment is the one thing a reader can supply — the name usually says it outright.
        match.candidates = _shortlist(exchange, index, placed.compartment, search)
        match.needs_model = bool(match.candidates)
        match.evidence = (
            f"{placed.reason} — {len(match.candidates)} candidates across its subcompartments"
            if match.candidates
            else f"nothing in {placed.compartment} shares a word with “{exchange.name}”"
        )
        return match

    # 2 — exact name in exactly that compartment.
    exact = index.lookup(exchange.name, placed.categories)
    convertible = [(c, _scaled(exchange, c)) for c in exact]
    usable = [(c, r) for c, r in convertible if r.ok]
    if len(usable) == 1:
        candidate, rescale = usable[0]
        band = Confidence.medium if rescale.kind is units.ASSUMED else Confidence.good
        return Match(
            exchange=exchange,
            target=candidate,
            confidence=band,
            evidence=f"same name in {placed.reason}",
            factor=rescale.factor,
            scale_note=rescale.note if rescale.factor != 1.0 else "",
            candidates=[c for c, _ in convertible],
        )
    if exact and not usable:
        match.evidence = f"“{exchange.name}” exists in {placed.reason}, but {convertible[0][1].note}"
        match.candidates = [c for c, _ in convertible]
        return match

    # 2b/2c — the same name, or the same substance under ecoinvent's ion naming, somewhere else in
    # this compartment. Both are conventions rather than guesses, and both are invisible to word
    # overlap: "Fluorene" exists only in water/surface water, "Antimony" in air only as "Antimony
    # ion". Together they settle 42 of the 105 flows in the US LCI ABS resin.
    settled = _place_in_compartment(
        exchange, index, placed.categories[0], placed.reason, match, categories=placed.categories
    )
    if settled is not None:
        return settled

    # 3 — a shortlist for the model, from the right compartment only.
    match.candidates = _shortlist(exchange, index, placed.categories[0], search)
    match.needs_model = bool(match.candidates)
    match.evidence = (
        f"no exact name in {placed.reason} — {len(match.candidates)} candidates to judge"
        if match.candidates
        else f"nothing in {placed.reason} shares a word with “{exchange.name}”"
    )
    return match


def _regions_first(variants: list[dict], wanted: str | None, representative: str = "") -> list[dict]:
    """Order an activity's regions so the best-justified one comes first.

    It comes first for two reasons: it is what the dropdown shows before anyone touches it, and it
    is the one candidate the matching model is shown for this activity — the model is asked whether
    the *activity* is the same thing, never which country, because the source usually does not say
    and a forced country is a guess dressed as a decision.

    Ties keep the order the search returned. An earlier version sorted the rest alphabetically and
    made **AE** the default for a European dataset — order by name is not order by relevance, and a
    default nobody chose is still a default somebody ships.
    """
    def rank(pair: tuple[int, dict]) -> tuple[int, int]:
        position, variant = pair
        geo = (variant.get("geography") or "").strip()
        if wanted and geo and geo.upper() == wanted.strip().upper():
            tier = 0
        elif representative and variant.get("code") == representative:
            # What the search itself picked when it collapsed the regions: its answer to "which
            # one of these did you mean" is better evidence than any rule of ours.
            tier = 1
        elif geo == "GLO":
            tier = 2
        elif geo == "RoW":
            tier = 3
        else:
            tier = 4
        return (tier, position)

    return [variant for _, variant in sorted(enumerate(variants), key=rank)]


def _trigrams(text: str) -> set[str]:
    packed = re.sub(r"[^a-z0-9]", "", text.lower())
    return {packed[i : i + 3] for i in range(len(packed) - 2)}


#: How much of two names' character trigrams must overlap before one is worth showing. Low, because
#: this is candidate generation and the model still has to say yes; not zero, because a shortlist
#: padded with noise is an invitation to pick something.
_TRIGRAM_FLOOR = 0.2


def _by_trigram(exchange: ForeignExchange, index: BiosphereIndex, compartment: str) -> list[Candidate]:
    """Names that LOOK like this one, letter by letter — the third way to find a candidate.

    Word overlap needs a shared word and the embedding needs a shared meaning; a chemical synonym
    often has neither. "Hydrogen chloride" and "Hydrochloric acid" share no word and no obvious
    semantic neighbourhood, but they share most of their letters, and so do "Nitrous oxide" and
    "Dinitrogen monoxide". Measured on the US LCI ABS resin: six of the nine synonyms the other two
    ways missed come into reach this way.
    """
    wanted = _trigrams(exchange.name)
    if not wanted:
        return []
    scored: list[tuple[float, int, Candidate]] = []
    for (name, comp), candidates in index.by_name_compartment.items():
        if comp != compartment:
            continue
        theirs = _trigrams(name)
        if not theirs:
            continue
        similarity = len(wanted & theirs) / len(wanted | theirs)
        if similarity < _TRIGRAM_FLOOR:
            continue
        for candidate in candidates:
            scored.append((-similarity, len(candidate.name), candidate))
    scored.sort(key=lambda row: (row[0], row[1], row[2].name))
    return [candidate for _s, _l, candidate in scored]


def _one_per_substance(candidates) -> list[Candidate]:
    """One row per substance, and the row is the one in the BARE compartment where there is one.

    Keeping whichever came first looked harmless and was not: the model recognised the substance
    every time and then refused, because the only candidate it was shown carried a specific
    subcompartment while the imported line said "unspecified" — which is precisely the rule we give
    it. "Ethylene dibromide is 1,2-Dibromoethane, but the matching candidate has a specific
    non-urban air subcompartment". The shortlist was asking a question the
    instructions forbid answering.
    """
    best: dict[str, Candidate] = {}
    for candidate in candidates:
        key = normalise_name(candidate.name)
        current = best.get(key)
        if current is None or len(candidate.categories) < len(current.categories):
            best[key] = candidate
    return list(best.values())


def _shortlist(
    exchange: ForeignExchange,
    index: BiosphereIndex,
    compartment: str,
    search,
    limit: int = 30,
) -> list[Candidate]:
    """Three ways of finding a candidate, each with a quota — inside this compartment.

    Word overlap needs a shared word, the embedding a shared meaning, the trigrams shared letters.
    A chemical synonym often has only the last of the three, so the order alone is not enough: word
    overlap fills twenty slots on its own and the other two never get asked. Hence quotas rather
    than a queue — measured on the US LCI ABS resin, where a plain queue let three of nine synonyms
    through and quotas let six.
    """
    found: list[Candidate] = []
    seen: set[str] = set()

    def take(candidates, quota: int) -> None:
        """One slot per SUBSTANCE, not per flow.

        A name exists in every subcompartment of its compartment, so a list keyed by flow spent its
        twenty slots on six substances repeated four times each — measured on "Hydrogen chloride",
        whose shortlist was Hydrogen ×4, Vinyl chloride ×4, Benzal chloride ×4. The subcompartment
        is not the question being asked here; which substance it is, is.
        """
        taken = 0
        for candidate in _one_per_substance(candidates):
            if taken >= quota or len(found) >= limit:
                return
            key = normalise_name(candidate.name)
            if key in seen:
                continue
            seen.add(key)
            found.append(candidate)
            taken += 1

    # Word overlap first and widest: a shared word is a hard fact, a similarity is not.
    take(index.by_compartment(exchange.name, compartment, limit=limit * 4), 10)

    if search is not None:
        try:
            hits = search(exchange.name, BIOSPHERE_DB, limit * 2) or []
        except Exception as exc:  # noqa: BLE001 — no index is "fewer candidates", not a failure
            _log.swallowed(exc, "biosphere shortlist")
            hits = []
        # Every code a hit stands for, not only its representative: the search collapses one name
        # across compartments (its group key carries none), and the representative may be the water
        # flow while the air flow the row needs sits under `variants`.
        codes: list[str] = []
        for hit in hits:
            codes.append(str(hit.get("code") or ""))
            codes.extend(str(v.get("code") or "") for v in (hit.get("variants") or []))
        semantic = [
            candidate
            for candidate in (index.by_code.get(code) for code in codes)
            if candidate is not None
            and candidate.categories
            and candidate.categories[0] == compartment
        ]
        take(semantic, 4)

    # The largest quota of the three: a chemical synonym shares letters and nothing else, so
    # this is the only way it can be reached at all, and the good answers sit deeper in this
    # list than in the other two (measured: ranks 2, 3, 8, 13, 16).
    take(_by_trigram(exchange, index, compartment), 16)
    # Whatever is left over goes to word overlap again: a quota is a floor for the others, not a
    # ceiling for the one that usually knows best.
    take(index.by_compartment(exchange.name, compartment, limit=limit * 4), limit)
    # Last: swap every substance for its bare-compartment variant. Preferring it inside each source
    # was not enough — the sources are drained in turn against one shared "already seen" set, so
    # whichever source ran first fixed the variant and the bare one was skipped as a duplicate.
    # "Nitrous oxide" was offered only "Dinitrogen monoxide · urban air close to ground" while the
    # plain "· air" sat in the vocabulary, and the model refused it exactly as instructed.
    return [_bare_variant(c, index, compartment) for c in found]


def _bare_variant(candidate: Candidate, index: BiosphereIndex, compartment: str) -> Candidate:
    same = index.by_name_compartment.get((normalise_name(candidate.name), compartment)) or []
    return min(same, key=lambda c: len(c.categories)) if same else candidate


def _place_in_compartment(
    exchange: ForeignExchange,
    index: BiosphereIndex,
    compartment: str,
    reason: str,
    carry: Match | None = None,
    categories: tuple[str, ...] | None = None,
) -> Match | None:
    """Same name, or same substance under ecoinvent's ion naming, somewhere in this compartment.

    ``categories`` is the source's full, resolved compartment: when it names a subcompartment and a
    flow carries exactly that one, that flow wins over the bare one.

    Two questions, in order, and the second only if the first found nothing:

    1. is there a flow of this **name** under this compartment, whatever the subcompartment?
    2. is there one whose name is this substance with an **ion or oxidation-state suffix**?
       ecoinvent keeps the bare element for the RESOURCE and names the EMISSION as its ion, so
       "Antimony" to air means "Antimony ion" — a convention no word overlap can see.

    What counts as settled is **one substance**, not one row: a name usually exists in several
    subcompartments, and that is not ambiguity. When the source gave no subcompartment the bare
    one wins (the convention every importer follows, see compartments.py); when it exists only in
    specific ones, several of them ARE a decision and go to the shortlist.

    Returns a finished Match, a Match carrying a shortlist, or ``None`` for "neither applied".
    """
    match = carry or Match(exchange=exchange)
    inverted = invert_indexed_name(exchange.name)
    unqualified = drop_empty_qualifier(exchange.name)
    collective: list[Candidate] = []
    for shape in collective_name(exchange.name):
        collective += index.by_name_compartment.get((normalise_name(shape), compartment)) or []
    lookups = (
        (index.by_name_compartment.get((normalise_name(exchange.name), compartment)), "name"),
        (index.by_key_compartment.get((inverted, compartment)) if inverted else None, "inverted"),
        (
            index.by_name_compartment.get((normalise_name(unqualified), compartment))
            if unqualified
            else None,
            "qualifier",
        ),
        (
            index.by_synonym_compartment.get((normalise_name(exchange.name), compartment)),
            "synonym",
        ),
        (index.by_base_compartment.get((strip_ion_suffix(exchange.name), compartment)), "ion"),
        (collective or None, "collective"),
    )
    for found, by_ion in lookups:
        if not found:
            continue
        convertible = [(c, r) for c, r in ((c, _scaled(exchange, c)) for c in found) if r.ok]
        if not convertible:
            continue
        names = {c.name for c, _ in convertible}
        # One candidate carries the source's own name once both sides are normalised — "Copper, ion"
        # against "Copper ion" beside a bare "Copper". That is not a collision, it is the answer.
        spelled = [
            (c, r) for c, r in convertible
            if strip_ion_suffix(c.name) == strip_ion_suffix(exchange.name)
            and normalise_name(c.name) != normalise_name(exchange.name)
            and ("ion" in normalise_name(c.name)) == ("ion" in normalise_name(exchange.name))
        ]
        if len(names) > 1 and len({c.name for c, _ in spelled}) == 1:
            convertible = spelled
            names = {c.name for c, _ in convertible}
        chosen = None
        if len(names) == 1 and categories and len(categories) > 1:
            exact = [(c, r) for c, r in convertible if tuple(c.categories) == tuple(categories)]
            if len(exact) == 1:
                chosen = exact[0]
        if chosen is None and len(names) == 1:
            bare = [(c, r) for c, r in convertible if len(c.categories) == 1]
            if len(bare) == 1:
                chosen = bare[0]
            elif len(convertible) == 1:
                chosen = convertible[0]
        if chosen is not None:
            candidate, rescale = chosen
            where = " / ".join(candidate.categories) or compartment
            if by_ion == "ion":
                # A convention, not an identifier: medium at best, so a reviewer filtering by band
                # still sees every one of them.
                band = Confidence.medium
                note = f"our biosphere names this emission as its ion — “{candidate.name}” in {where}"
            elif by_ion == "qualifier":
                band = Confidence.medium
                note = (
                    f"the source adds a qualifier our vocabulary omits — “{candidate.name}” "
                    f"in {where}"
                )
            elif by_ion == "collective":
                # A widening, and it says so: the vocabulary keeps no entry for the single
                # substance, only the group. Never better than medium, and never reached while an
                # exact name exists.
                band = Confidence.medium
                note = (
                    f"our vocabulary keeps only the unspeciated group “{candidate.name}” "
                    f"in {where}"
                )
            elif by_ion == "synonym":
                band = Confidence.medium if rescale.kind is units.ASSUMED else Confidence.good
                note = (
                    f"our biosphere records “{exchange.name}” as a synonym of “{candidate.name}” "
                    f"in {where}"
                )
            elif by_ion == "inverted":
                band = Confidence.medium if rescale.kind is units.ASSUMED else Confidence.good
                note = (
                    f"the source writes the CAS index name and our biosphere the systematic one — "
                    f"“{candidate.name}” in {where}"
                )
            else:
                band = Confidence.medium if rescale.kind is units.ASSUMED else Confidence.good
                note = f"same name, and “{where}” is the only place in {compartment} it exists"
            return Match(
                exchange=exchange,
                target=candidate,
                confidence=band,
                evidence=note,
                factor=rescale.factor,
                scale_note=rescale.note if rescale.factor != 1.0 else "",
                candidates=[c for c, _ in convertible],
            )
        # Capped like every other shortlist: a list of sixty is not a choice, and the model reads
        # it as one long invitation to pick something.
        match.candidates = [c for c, _ in convertible][:20]
        match.needs_model = True
        match.evidence = (
            f"{len(names)} substance(s) in {compartment} carry this name or its ion form, in "
            f"{len(convertible)} subcompartment(s) — which one it is, is a decision"
        )
        return match
    if carry is not None:
        return None
    match.evidence = reason
    return match


def match_technosphere(
    exchange: ForeignExchange,
    *,
    search,
    background: str,
    limit: int = 15,
    prefer_location: str = "",
) -> Match:
    """Technosphere links always go through the shortlist: there is no exact vocabulary to hit.

    ``search`` is the project's own semantic index — the same one the process search and the
    modelling assistant use. It is passed in rather than imported so this module stays testable
    without an embedding model, and so the import can never quietly build a second index.
    """
    match = Match(exchange=exchange)
    hits = search(exchange.name, background, limit) or []
    candidates: list[Candidate] = []
    for hit in hits:
        name = hit.get("name", "")
        unit = hit.get("unit", "")
        product = hit.get("product") or hit.get("reference_product", "")
        # The search collapses an activity's regions into one row and hands the rest over under
        # `variants`. Offering only the collapsed representative would bind whichever region the
        # collapse happened to pick — for electricity or transport that IS the answer, not a
        # detail — so every region becomes a candidate of its own, and the reviewer picks.
        variants = hit.get("variants") or [
            {"code": hit.get("code", ""), "geography": hit.get("geography") or hit.get("location") or ""}
        ]
        # The exchange's own region if the source gave one, else the dataset's: a German dataset
        # buying "electricity" is buying German electricity unless it says otherwise.
        ordered = _regions_first(
            variants, exchange.location or prefer_location, hit.get("code", "")
        )
        for variant in ordered[:REGIONS_PER_HIT]:
            candidates.append(
                Candidate(
                    database=variant.get("database") or hit.get("database", background),
                    code=variant.get("code") or hit.get("code", ""),
                    name=name,
                    unit=unit,
                    location=variant.get("geography") or "",
                    reference_product=product,
                    why=searched_why("semantic search", hit),
                )
            )
    match.candidates = candidates
    match.needs_model = bool(match.candidates)
    if not match.candidates:
        match.evidence = f"the background database has nothing like “{exchange.name}”"
    else:
        regions = len({c.location for c in match.candidates if c.location})
        match.evidence = (
            f"{len(match.candidates)} candidates from the background database"
            + (f", across {regions} regions" if regions > 1 else "")
        )
    return match


@dataclass(frozen=True)
class PackageIndex:
    """The package's own datasets, by the two things an input can name its supplier with.

    ``by_provider`` holds what the source links explicitly (EcoSpold 2 ``activityLinkId``, JSON-LD
    ``defaultProvider``); ``by_product_flow`` holds each dataset under the flows it gives off — the
    one fact an ILCD package offers, since its exchanges point at flows and never at processes.
    Both keep CO-PRODUCTS too, flagged: a supplier that makes the flow as a by-product is still the
    supplier the source meant, and forgetting it let another dataset of the package take its place
    unannounced.
    """

    #: name → (dataset, the named product is a co-product of it)
    by_provider: dict[str, tuple[ForeignDataset, bool]]
    by_product_flow: dict[str, list[tuple[ForeignDataset, bool]]]

    @classmethod
    def build(cls, datasets: list[ForeignDataset]) -> PackageIndex:
        by_provider: dict[str, tuple[ForeignDataset, bool]] = {}
        by_product_flow: dict[str, list[tuple[ForeignDataset, bool]]] = {}
        for dataset in datasets:
            for name in dataset.provides:
                by_provider.setdefault(name, (dataset, False))
            activity = dataset.provides[0].split(":", 1)[0] if dataset.provides else ""
            for exchange in dataset.exchanges:
                if not exchange.uuid:
                    continue
                if exchange.kind == "production":
                    by_product_flow.setdefault(exchange.uuid, []).append((dataset, False))
                elif exchange.coproduct:
                    by_product_flow.setdefault(exchange.uuid, []).append((dataset, True))
                    if activity:
                        by_provider.setdefault(f"{activity}:{exchange.uuid}", (dataset, True))
        return cls(by_provider=by_provider, by_product_flow=by_product_flow)


def match_in_package(exchange: ForeignExchange, index: PackageIndex, *, own_key: str) -> Match | None:
    """The supplier the package itself delivers for this input, or None when it delivers none.

    Checked before any search, because a supplier that came along in the same file is not a proxy to
    be found — it is the answer, and binding a background dataset instead replaces a delivered supply
    chain with somebody else's. Two routes, in this order: the link the source
    wrote, then the only dataset of the package that makes this very flow. Two producers of one flow
    are a choice, and a choice is the reviewer's.

    Two things are never decided here. A supplier the source NAMED is never swapped for another one:
    named but not in the package, the flow route is not tried (the background search runs, and the
    reviewer sees it). And a supplier that makes the product only as a co-product is offered, not
    bound — its burden belongs to its reference product until somebody allocates it.
    """
    # A waste going out asks for its treatment: the package dataset whose reference is that waste
    # flow is its supplier just as a producer is for an input.
    if exchange.kind != "technosphere" or exchange.coproduct:
        return None
    if exchange.direction != "input" and not exchange.waste:
        return None
    found: tuple[ForeignDataset, bool] | None = None
    how = ""
    if exchange.provider:
        named = index.by_provider.get(exchange.provider)
        if named is None or named[0].key == own_key:
            return None
        found, how = named, "the source names this supplier, and it is in this package"
    elif exchange.uuid:
        producers = [p for p in index.by_product_flow.get(exchange.uuid, []) if p[0].key != own_key]
        if len(producers) == 1:
            found = producers[0]
            how = "the only dataset in this package that produces this flow (same flow identifier)"
    if found is None:
        return None
    supplier, as_coproduct = found
    candidate = Candidate(
        database=PACKAGE_DB,
        code=supplier.key,
        name=supplier.name,
        # The supplier's OWN reference unit, always: that is what one unit of it is. The input's
        # unit here made a kWh process read as "kilogram" with factor 1.
        unit=supplier.unit,
        location=supplier.location,
        reference_product=supplier.reference_product,
        why="this package",
        allocation_required=as_coproduct,
    )
    match = Match(exchange=exchange, candidates=[candidate])
    if as_coproduct:
        match.evidence = (
            f"{how}, but it makes “{exchange.name}” only as a co-product of “{supplier.reference_product}” "
            "— linking to it would buy that whole process; allocate it first, then decide"
        )
        return match
    rescale = _scaled(exchange, candidate)
    if not rescale.ok:
        # Offered, not bound: the supplier is right there, but an amount that cannot be converted
        # would land meaning something else — the reviewer sees the candidate and the reason.
        match.evidence = f"{how}, but {rescale.note}"
        return match
    match.target = candidate
    match.confidence = Confidence.good if rescale.kind is units.EXACT else Confidence.low
    match.factor = rescale.factor
    match.scale_note = rescale.note if rescale.factor != 1.0 or rescale.kind is not units.EXACT else ""
    match.evidence = how
    return match
