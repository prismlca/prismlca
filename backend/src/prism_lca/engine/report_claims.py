"""Check what a chapter *asserts*, not only what it quotes.

The gate next door checks the building blocks: no free-standing number, no dataset that was never handed
over. Both are properties of a token. Neither looks at the sentence around it — so this passes:

    "…and the thicker variant is {{change(subjects.1…, subjects.0…)}} lower than the baseline."

The number is right by construction (we compute the derivation). The word **lower** is checked by nothing:
no placeholder is missing, no literal appears, no invented dataset is named. The sentence is formally
perfect and factually inverted.

FinGround (arXiv 2604.23588) measures the size of this blind spot for financial reports: generic
hallucination detectors miss **43 % of computational errors**, precisely because they never re-verify
arithmetically against the table. Their remedy is to decompose into atomic claims and route each by type.
That is what this module does, with one deliberate difference: **the numeric path uses no model.** The
values are already in the snapshot, so a comparison is arithmetic, and arithmetic should not be delegated
to a language model.

Three routes, and a fourth that only reports:

* a **direction** claim — a `change`/`diff` derivation plus a comparison word — must match the sign;
* a **comparison between two placeholders** must hold for their values;
* a **superlative** on a ranked list must name index 0, because that is what "largest" means;
* a **causal** claim ("because", "driven by") is unverifiable from the data and is reported once, as a
  note for the author rather than an obstacle.

And one thing this module *suggests* rather than judges: a rank claim written in prose where the report
has a size-ordered member the sentence is demonstrably about is told which `{{rank:…}}` to write, so the
next reader of that sentence is the arithmetic instead of a word list. Advisory, because it rides on the
word list that produced the ten defects above — it may say "declare this", never "this is wrong".

False positives are the real risk of a checker like this, so every rule needs its trigger *and* its
operands in the same sentence, and anything ambiguous is left alone. A rule that cries wolf gets switched
off by its user, which is worse than not having it.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any

from prism_lca import _log
from prism_lca.engine import report_data as rd
from prism_lca.engine import report_sentences
from prism_lca.engine.report_claims_vocab import (
    CAUSAL as _CAUSAL,
)
from prism_lca.engine.report_claims_vocab import (
    COMPARATIVE_SUPERLATIVES as _COMPARATIVE_SUPERLATIVES,
)

# The thirteen language tables live in report_claims_vocab (data beside the matchers that
# read them); the historical underscore names stay bound here because report_staleness, the
# offline word-forms script and the tests read them off this module.
from prism_lca.engine.report_claims_vocab import (  # noqa: F401
    COMPARATORS as _COMPARATORS,
)
from prism_lca.engine.report_claims_vocab import (
    DENIALS as _DENIALS,
)
from prism_lca.engine.report_claims_vocab import (
    NEUTRALITY_WORDS as _NEUTRALITY_WORDS,
)
from prism_lca.engine.report_claims_vocab import (
    NOT_A_DENIAL as _NOT_A_DENIAL,
)
from prism_lca.engine.report_claims_vocab import (
    NOT_AN_ORDINAL as _NOT_AN_ORDINAL,
)
from prism_lca.engine.report_claims_vocab import (
    ORDINAL_INDEX as _ORDINAL_INDEX,
)
from prism_lca.engine.report_claims_vocab import (
    ORDINALS as _ORDINALS,
)
from prism_lca.engine.report_claims_vocab import (
    ORDINALS_BEFORE_SUPERLATIVE as _ORDINALS_BEFORE_SUPERLATIVE,
)
from prism_lca.engine.report_claims_vocab import (
    SUPERLATIVES as _SUPERLATIVES,
)
from prism_lca.engine.report_claims_vocab import (
    THAN as _THAN,
)
from prism_lca.engine.report_claims_vocab import (
    VALUE_WORDS as _VALUE_WORDS,
)
from prism_lca.engine.report_i18n import normalise

#: A share written out in words rather than as a placeholder — "25.2 %", "about a third". A sentence
#: may explain a figure it did not take from a token, and the causal note has to reach that too.
_SHARE_IN_PROSE = re.compile(r"\d[\d.,]*\s*%|\b(?:a|one)[- ]?(?:third|quarter|half|fifth)\b", re.IGNORECASE)




#: A sentence, roughly. Good enough: a rule needs its trigger and operands together, and a split that
#: occasionally keeps two sentences as one only makes the checker more cautious, never wrong.
#:
#: The reverse — splitting one sentence into two — is what makes it wrong, because a rule then loses
#: the words that would have disarmed it. The rule itself (a terminator only ends a sentence at
#: whitespace followed by a capital) and the placeholder masking live in ``report_sentences`` now,
#: shared with ``report_patch`` — the module that judges a sentence and the module that decides which
#: sentence a finding quotes must not carry two copies that merely happen to agree.

#: Below this relative difference a comparison is not evidence of a difference. Convention, not norm:
#: practice puts it near 5 % for climate change and energy and much higher for toxicity or land use, and
#: without an uncertainty analysis every threshold is a judgement. Hence advisory, and configurable.
DEFAULT_WEAK_DIFFERENCE_PERCENT = 5.0


def weak_percent(options: Any) -> float:
    """A report's own threshold, normalised — one reading of the option for everyone who needs it.

    Three places used to read it for themselves: the writing brief tells the author the number, this
    module judges the sentences by it, and the staleness fingerprint records what a chapter was
    written under. They have to agree. A fingerprint that normalises an unset option differently from
    the brief either reports a change nobody made or misses the one it exists for (V195).

    Zero and below are not a tighter threshold but the advice switched off, and an older report stored
    before the option existed carries no value at all — both get the convention.
    """
    value = options.get("significance_percent") if isinstance(options, dict) else None
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_WEAK_DIFFERENCE_PERCENT
    return number if number > 0 else DEFAULT_WEAK_DIFFERENCE_PERCENT


def _sentences(text: str) -> list[str]:
    """Split into sentences without cutting through a placeholder.

    A path is full of dots — `subjects.1.results.0.score` — so splitting the raw text on "." tears the
    tokens apart and every numeric rule silently stops finding its operands. `report_sentences` masks
    them first; every caller here strips its sentence anyway, so span-cut boundaries change nothing.
    """
    return report_sentences.sentences(text)


#: Which field of a ranked member prose actually spells out. A sentence names a dataset, a phase or a
#: flow by its name; nobody writes its database code.
#:
#: `parameters` is absent for a plainer reason than the rest: a parameter is called `uw` or
#: `mass_total`, and prose calls it "the U-value" or "the element mass". `_MIN_NAME` drops most of
#: those identifiers before the rule sees them, and the ones long enough to survive would be matched
#: against a sentence that never spells them out — a name field that never fires is a rule people
#: believe is protecting them. Its *bindings* hold either way, which is what V182 was about; what a
#: parameter has no second opinion on is the pairing of name to figure.
#:
#: `results` and `subjects` are deliberately absent. Their labels are short, translated and paraphrased
#: — a report whose study is documented in German prints "Few cycles (5)" for a subject stored as
#: "Wenige Umläufe (5)" — so the nearest *recognised* name before a subject placeholder is regularly
#: the wrong one, and the rule fired on a correct executive summary. These two are also the lists that
#: carry no rank, which is why nothing else here treats them as rankings either.
#: Keyed by *registry* key, not by the literal head: `contributions.1.hotspots` is one list among
#: several and has to find its field under `contributions.*.hotspots`.
#:
#: `contributions.*.groups` is deliberately **not** here, and the reason is worth keeping. Its members
#: are phase names, and phase names are short: `_MIN_NAME` drops "Filling" (7 characters) from the
#: member list, so a sentence naming four phases offers only three names for four figures and the
#: pairing below cannot line them up. Every attempt then falls back to nearest-name and reports a
#: correct sentence (measured: two findings on an untouched executive summary, which would
#: have refused its correction). Their *bindings* still hold — the figures print under the right name
#: either way, which is what V154 was about; what is missing is only the second, independent check.
_NAME_FIELD: dict[str, str] = {
    "hotspots": "name",
    "contributions.*.hotspots": "name",
    "contribution.groups": "key",
    "inventory.flows": "flow",
}


def _name_field(head: str) -> str | None:
    """Which field spells out a member of the list at `head`."""
    return _NAME_FIELD.get(rd.registry_key(head))

#: Shorter than this, a "name" is a word prose uses for other purposes and matching it is noise.
_MIN_NAME = 8


def _named_members(
    head: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None = None
) -> list[tuple[str, dict[str, Any]]]:
    """(spelled-out name, identity) for every member of a ranked list, longest name first.

    Longest first because member names nest: "market for heat, district or industrial, natural gas"
    contains no other member, but "apple production, organic" would sit inside "apple production,
    organic, plain region", and the nearer-but-shorter match is the wrong one.

    The list itself is resolved through the bindings, because a nested one sits behind a pin:
    `contributions.1.hotspots` is the datasets of whichever indicator that chapter pinned, not of
    whatever sits at position 1 today. Read positionally after the indicators were reordered, the
    member names would be a different indicator's datasets and the sentence's own pinned name would be
    absent from them — a misbound-name finding on a correct sentence (V186).
    """
    field = _name_field(head)
    if not field:
        return []
    out: list[tuple[str, dict[str, Any]]] = []
    for entry in rd.bound_lookup(head, data, bindings) or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get(field) or "").strip()
        if len(name) >= _MIN_NAME:
            out.append((name, rd.identity_of(entry, rd.identity_fields(head))))
    return sorted(out, key=lambda pair: -len(pair[0]))


#: Where the report's data spells out dataset names that are *not* (or no longer) hotspots.
_DATASET_LISTS = ("background_datasets", "foreground")


def _known_dataset_names(data: dict[str, Any]) -> list[str]:
    """Every dataset name the report knows, longest first — the vocabulary a chapter may name.

    Used for the second half of the check (V160): a name that was in the hotspot list when the chapter
    was written and has since fallen out of it is no longer a *member*, so the member scan above cannot
    see it — and that is exactly the name drift leaves behind. It still sits in the report's own
    dataset inventory, which is enough to recognise it as a dataset rather than as prose.
    """
    out: list[str] = []
    for key in _DATASET_LISTS:
        for entry in data.get(key) or []:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name") or "").strip()
            if len(name) >= _MIN_NAME:
                out.append(name)
    return sorted(set(out), key=len, reverse=True)


def _stale_dataset_name(
    head: str,
    before: str,
    sentence: str,
    pin: dict[str, Any],
    data: dict[str, Any],
    names: list[str],
) -> tuple[int, str, dict[str, Any]] | None:
    """A dataset the sentence names that is not in the ranked list at all (V160).

    Kept as narrow as the member rule, for the same reason — three guards:

    * only for `hotspots`, whose members *are* datasets. A dataset name beside a phase share
      ("the use phase, which contains battery production, NiMH, carries {{contribution.groups.1…}}")
      is ordinary and correct wording, not a misbinding.
    * only when the pinned dataset is not itself named in the sentence: if both are spelled out, the
      reader can see which figure belongs to which.
    * only names the report's own dataset inventory contains, so prose ("the polycrystalline cells")
      never matches.

    The case it was written for, verbatim from one run: "the hotspot list is headed by the
    market for silicon, solar grade … with {{hotspots.0.share_text}}" — written *after* the parameter
    change, when hotspots.0 was dysprosium oxide at 7.0 % and silicon had left the list entirely. The
    chapter's own figure two pages later showed dysprosium oxide at 7.00.
    """
    if rd.registry_key(head) not in ("hotspots", "contributions.*.hotspots"):
        return None
    pinned = str(pin.get(_name_field(head) or "", "")).strip()
    if pinned and pinned in sentence:
        return None
    nearest: tuple[int, str, dict[str, Any]] | None = None
    for name in names:
        if name == pinned:
            continue
        at = before.rfind(name)
        if at >= 0 and (nearest is None or at > nearest[0]):
            nearest = (at, name, {"name": name})
    return nearest


def _previous_of(
    head: str, sentence: str, match: re.Match[str], bindings: dict[str, dict[str, Any]]
) -> int:
    """Where the previous bound placeholder of the same list ends, or 0 if this is the first."""
    end = 0
    for other in rd.PLACEHOLDER.finditer(sentence):
        if other.start() >= match.start():
            break
        if rd.is_aggregate(other.group(1)):
            continue
        cited = {s[:2] for s in map(rd.ranked_prefix, rd.paths_in_token(other.group(1))) if s}
        if len(cited) != 1:
            continue
        other_head, other_index = next(iter(cited))
        if other_head == head and f"{other_head}.{other_index}" in bindings:
            end = other.end()
    return end


def _parallel_pairs(
    sentence: str,
    data: dict[str, Any],
    bindings: dict[str, dict[str, Any]],
    members: dict[str, list[tuple[str, dict[str, Any]]]],
) -> dict[tuple[str, int], tuple[int, str, dict[str, Any]]]:
    """Name→placeholder pairing for a sentence that lists the names first and the figures after.

    "In climate change, Packaging and Raw materials & production are a near tie at {{…groups.0…}} and
    {{…groups.1…}}, with Filling ({{…2…}}) and End-of-life ({{…3…}}) trailing." Every figure is under
    the right name, and the nearest-name rule reads it as four mismatches, because the name closest to
    the first placeholder is the *second* name. Left alone this refuses a correction on one of the
    commonest shapes in a contribution chapter (found while widening the rule to the
    per-indicator lists).

    Deliberately only when the sentence names exactly as many members of that list as it carries
    placeholders of it, all names ahead of all figures, and at least two of each: then the pairing is
    the only reading there is. Anything else falls back to nearest-name, defect and all.

    Returns {(head, placeholder start) → (name position, name, identity)}.
    """
    out: dict[tuple[str, int], tuple[int, str, dict[str, Any]]] = {}
    heads: dict[str, list[re.Match[str]]] = {}
    for match in rd.PLACEHOLDER.finditer(sentence):
        if rd.is_aggregate(match.group(1)):
            continue
        cited = {s[:2] for s in map(rd.ranked_prefix, rd.paths_in_token(match.group(1))) if s}
        if len(cited) != 1:
            continue
        head, index = next(iter(cited))
        if f"{head}.{index}" not in bindings:
            continue
        heads.setdefault(head, []).append(match)

    for head, matches in heads.items():
        if len(matches) < 2:
            continue
        if head not in members:
            members[head] = _named_members(head, data, bindings)
        # Where each member is spelled out, longest name first so a nested one cannot claim the spot.
        spots: list[tuple[int, str, dict[str, Any]]] = []
        taken: list[tuple[int, int]] = []
        for name, identity in members[head]:
            at = sentence.find(name)
            while at >= 0:
                if not any(a <= at < b for a, b in taken):
                    spots.append((at, name, identity))
                    taken.append((at, at + len(name)))
                    break
                at = sentence.find(name, at + 1)
        spots.sort()
        if len(spots) != len(matches):
            continue
        # Each name ahead of the figure it is paired with — the ordering that makes "A and B … X and
        # Y" readable at all. It also covers the mixed shape the run actually produced ("…at X and Y,
        # with C (Z) trailing"), which a stricter "all names before all figures" rule would refuse.
        if any(spot[0] >= match.start() for spot, match in zip(spots, matches, strict=True)):
            continue
        for spot, match in zip(spots, matches, strict=True):
            out[(head, match.start())] = spot
    return out


def misbound_names(
    text: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None
) -> list[dict[str, Any]]:
    """A sentence that spells out one member and prints another one's figure.

    The failure this exists for (V146): a correction re-pointed the bindings of sentences it never
    touched, and the chapter then read "the parcel last mile (transport, freight, light commercial
    vehicle, 16.7 %)" where 16.7 % belonged to the natural-gas heat. Every other check was satisfied —
    the placeholder resolved, no gap was printed, and the superlative rule was consistent with the new
    pins — so a document with two swapped figures passed all three gates and rendered.

    Nothing here needs a model. A member's name is in the data, the pin is in the bindings, and the
    text says which name sits in front of which placeholder. Deliberately narrow: only a name that is
    itself a member of that same list counts, and only the nearest one before the placeholder inside
    the same sentence. Prose that describes a dataset without naming it, or names something the list
    does not contain, is left alone — a check that fires on ordinary wording gets switched off.

    The one matcher in this module that deliberately does **not** fold (`folded`), together with
    `_leading_names` and `_superlative_anchors` which match the same way. A word list is vocabulary and
    a chapter may spell it as the language spells it; a member name is a string out of the data that a
    correct chapter copies character for character. Folding it would let two datasets that differ by a
    diacritic — a real distinction in `ecoinvent` names — excuse each other's figures, and this rule
    blocks.
    """
    bindings = bindings or {}
    if not bindings:
        return []
    findings: list[dict[str, Any]] = []
    members: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    names: list[str] = _known_dataset_names(data)
    seen: set[str] = set()

    for sentence in _sentences(text):
        parallel = _parallel_pairs(sentence, data, bindings, members)
        for match in rd.PLACEHOLDER.finditer(sentence):
            # A total belongs to no single name: "Distribution …, followed by Production, and together
            # they account for {{sum(…0…, …1…)}} %" is correct and would otherwise be read as printing
            # Production's figure. Same exemption the superlative rule needs, for the same reason.
            if rd.is_aggregate(match.group(1)):
                continue
            # A `rank:` declaration prints no figure — it prints its own member's name. This rule asks
            # "whose figure is this, and whose name stands in front of it", and a token that answers
            # both with the same member has nothing to mis-bind. Left in, it would raise a *blocking*
            # finding whose sentence reads "prints a figure bound to …" about a token that prints a
            # name, and a refusal that describes the wrong thing is worse than none.
            if rd.rank_path(match.group(1)):
                continue
            # …and neither does a figure *about two members*. "Packaging (x) and Raw materials (y) sit
            # only {{diff(groups.0.share_percent, groups.1.share_percent)}} percentage points apart" is
            # correct prose: the difference belongs to both, so "the nearest name before it" decides
            # nothing — it is simply whichever of the two the sentence happens to mention last. Read
            # naively that is a mismatch, and the rule fired on a correct chapter and **blocked the
            # correction** the staleness check had just asked for (an apple-juice run, V163) —
            # the same failure V145 fixed for the superlative rule, one derivation further along.
            # `sum` above stays: it is the one derivation that may name the same member twice.
            cited = {s[:2] for s in map(rd.ranked_prefix, rd.paths_in_token(match.group(1))) if s}
            if len(cited) > 1:
                continue
            for path in rd.paths_in_token(match.group(1)):
                split = rd.ranked_prefix(path)
                if not split:
                    continue
                head, index, _rest = split
                pin = bindings.get(f"{head}.{index}")
                if not pin:
                    continue
                if head not in members:
                    members[head] = _named_members(head, data, bindings)
                before = sentence[: match.start()]
                # A sentence that lists the names first and their figures after — "Packaging and Raw
                # materials are a near tie at {{…0…}} and {{…1…}}" — pairs them in order, not by
                # nearness: the name closest to the first figure is the *second* name. Worked out for
                # the whole sentence, and only when the two lists are the same length, which is what
                # makes the reading unambiguous.
                pair = parallel.get((head, match.start()))
                nearest: tuple[int, str, dict[str, Any]] | None = pair
                if pair is None:
                    # Otherwise: the nearest member name in front of the placeholder — that is the
                    # thing the reader takes the figure to belong to.
                    for name, identity in members[head]:
                        at = before.rfind(name)
                        if at >= 0 and (nearest is None or at > nearest[0]):
                            nearest = (at, name, identity)
                    # …but only while "in front of" still means "next to". A name that sits before the
                    # *previous* figure of the same list belongs to that one, and this placeholder
                    # simply has no name of its own — which happens whenever a member's name is too
                    # short to be listed at all (`_MIN_NAME` drops "Filling"). Read without this guard,
                    # "Raw materials contributes {{…0…}} …; Packaging ({{…1…}}) and Filling ({{…2…}})"
                    # reports the third figure as Packaging's, and the chapter — correct, freshly
                    # written and paid for — is refused.
                    if nearest is not None and nearest[0] < _previous_of(head, sentence, match, bindings):
                        nearest = None
                    # …but only while "in front of" still means "next to". A name that sits before the
                    # *previous* figure of the same list belongs to that one, and this placeholder
                    # simply has no name of its own — which happens whenever a member's name is too
                    # short to be listed at all (`_MIN_NAME` drops "Filling"). Read without this guard,
                    # "Raw materials contributes {{…0…}} …; Packaging ({{…1…}}) and Filling ({{…2…}})"
                    # reports the third figure as Packaging's, and the chapter — correct, freshly
                    # written and paid for — is refused.
                if nearest is None:
                    nearest = _stale_dataset_name(head, before, sentence, pin, data, names)
                if nearest is None:
                    continue
                _at, name, identity = nearest
                # Compare what identifies the member, the way `identity_matches` reads a stored pin:
                # a pin carries the member's LABEL beside its identity (`@name`, since V240/V248) and
                # the member scan does not — compared raw, the same member never equalled its own pin,
                # and a correct sentence of the shape "Rohstoffe mit {{…share_text}}" was refused with
                # a message naming the same member twice (V297, blocked a whole chapter three times).
                if {k: v for k, v in identity.items() if not k.startswith("@")} == {
                    k: v for k, v in pin.items() if not k.startswith("@")
                }:
                    continue
                key = f"{head}.{index}|{name}"
                if key in seen:
                    continue  # one finding per (placeholder, name) pair, not per field of it
                seen.add(key)
                pinned = str(pin.get(_name_field(head) or "", "")) or "another member"
                findings.append(
                    {
                        "kind": "misbound_name",
                        "sentence": sentence,
                        "detail": (
                            f"“{_clip(sentence)}” names “{name}” and then prints a figure bound to "
                            f"“{pinned}” ({head}.{index}). The number and the name belong to different "
                            "members — point the placeholder at the one the sentence is about, or name "
                            "the one it prints."
                        ),
                    }
                )
    return findings


def _value_of(token: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None) -> float | None:
    """The number a placeholder token resolves to, or None if it is not a number."""
    if token.endswith(")"):
        # The raw number, not the formatted string: parsing the display text back mangled thousands
        # separators and scientific notation into different numbers, and this rule *blocks*.
        value, error = rd.derive_value(token, data, bindings)
        return None if error else value
    return rd.numeric(rd.bound_lookup(token, data, bindings))


def _tokens_in(sentence: str) -> list[str]:
    return [m.group(1) for m in rd.PLACEHOLDER.finditer(sentence)]


#: Every character a model types where the ASCII apostrophe belongs. The word lists carry the ASCII one
#: — `_THAN` has "qu'", `_VALUE_WORDS` has "respectueux de l'environnement" — and a chapter writing
#: "qu’une" made the comparative exemption miss, which turned a genuine French comparison into a
#: value-judgement note (V207). Folded on both sides, so an entry typed with a curly one works too.
#:
#: U+00B4, U+02B9 and U+2032 are here because keyboards and converters emit them *as* apostrophes, not
#: because they mean one. The backtick is deliberately absent: it delimits code rather than joining a
#: word, and folding it would glue two tokens into one.
_APOSTROPHES = str.maketrans(dict.fromkeys("’‘‛ʼʹ′´＇", "'"))


def folded(text: str) -> tuple[str, list[int]]:
    r"""Lower case, apostrophes and accents normalised, plus where each folded character came from.

    One fold and one word list for both rules that read those lists — the write-time superlative rule
    here and the staleness wording rule next door — because two matchers over one list drift into two
    different answers. It is needed at write time too, and not only for the laxer rule it was built
    for: the list has "domine", a model writing French writes *dominé*, and `\bdomine\w{0,2}\b` does
    not match it. An "s" is inflection the pattern already allows; an acute accent is the same word
    spelled the way the language spells it. So an anchored, checkable, false claim — "le bilan est
    dominé par l'emballage ({{…groups.1…}})" — walked through the gate (V208).

    The index map is what lets a verdict quote the word the *chapter* uses instead of the entry the
    list carries. Folding changes the length of the string — "é" decomposes into two characters, one of
    them dropped — so an offset in the folded text is not an offset in the sentence, and a message that
    named “domine” beside a sentence saying “dominé” would send both the author and the correction
    model looking for a word that is not there. Same reason the case is folded per character rather
    than over the whole string: `str.lower` may return two characters for one, and the map has to keep
    indexing the text the caller holds.
    """
    folded: list[str] = []
    index: list[int] = []
    for at, char in enumerate(text or ""):
        for part in unicodedata.normalize("NFKD", char.lower().translate(_APOSTROPHES)):
            if not unicodedata.combining(part):
                folded.append(part)
                index.append(at)
    return "".join(folded), index


def fold(text: str) -> str:
    return folded(text)[0]


#: Entries matched exactly as they are spelled, with no inflection tolerance at all.
#:
#: Two trailing characters carry a paradigm, and for an adjective that is also a verb they carry the
#: verb: `\bclean\w{0,2}\b` reaches *cleaned*, *cleans*, *cleanup* and *cleanse*, so "the inventory
#: was cleaned before use" earned a value-judgement note. The `propre` treatment — narrowing to
#: collocations — is the wrong tool here, because English "clean" has no second everyday meaning; "a
#: clean product" is exactly the boast the rule exists for. So the degrees are **spelled out**
#: instead ("clean", "cleaner", "cleanest") and the tolerance is switched off for the bare one. An
#: English adjective has three degrees and no more, so the set is closed rather than a paradigm that
#: has to be kept up: what it costs is the adverb *cleanly*, which describes a manner and not a
#: product.
#:
#: Only where a form was measured. A sweep of every bare English entry against a system word list says
#: this is the one place the shape is needed: the only other entry whose tolerance reaches words of a
#: different meaning is bare "green" (*greens*, *greened*), and its price — a note on a proper name —
#: is written down at `_VALUE_WORDS` and was accepted there. The ordinals overreach too, but into a
#: different problem with a different fix (`_ORDINALS_BEFORE_SUPERLATIVE`, `_NOT_AN_ORDINAL`).
#:
#: Keyed by the entry rather than by the list because no two lists spell an entry the same way. Read
#: through `_entry_pattern` only, which is what keeps the authoring aid in `scripts/` from telling an
#: author that a form the gate cannot see is already reached; `report_staleness` builds its own
#: pattern but matches only `_SUPERLATIVES`, which has no entry here.
_NO_INFLECTION = frozenset({"clean"})


def _entry_pattern(word: str) -> str:
    """One list entry as a regex: a whole word plus its inflection tolerance, folded like the text."""
    tolerance = "" if word in _NO_INFLECTION else r"\w{0,2}"
    return rf"\b{re.escape(fold(word))}{tolerance}\b"


def _mentions(words: tuple[str, ...], low: str) -> list[str]:
    """The listed words this sentence actually uses, spelled as the *list* spells them.

    Whole words, with two trailing characters' worth of inflection ("grüner", "größten") — plain
    substring matching flagged "greenhouse gas" for "green" and the German "jeweils" for "weil", and a
    note that fires on ordinary LCA vocabulary is a note people switch off. A handful of entries opt
    out of the tolerance (`_NO_INFLECTION`).

    `low` is a sentence through `folded`, and the entries go through the same fold — an entry that
    carries its own accent ("écologique") has to keep working, which it does because both sides lose
    it."""
    return [w for w in words if re.search(_entry_pattern(w), low)]


def _mention_spans(words: tuple[str, ...], low: str) -> list[tuple[int, int]]:
    """Where those words sit, same matching as `_mentions` — offsets into the *folded* sentence.

    A superlative is a claim about *one* member, so the rule below needs to know where the word is,
    not only that it occurred: the member it describes is the one standing next to it. The caller maps
    the offsets back through `folded`'s index, because everything it compares them against — a
    placeholder, a spelled-out member name — was found in the unfolded sentence.
    """
    spans = [(m.start(), m.end()) for w in words for m in re.finditer(_entry_pattern(w), low)]
    return sorted(set(spans))


#: Words that turn a comparison round, per language, read in the few words BEFORE the direction word:
#: "is not higher than" claims lower-or-equal. Folded like the sentence ("não" arrives as "nao").
_NEGATION: dict[str, tuple[str, ...]] = {
    "en": ("not", "no", "never", "neither", "nor"),
    "de": ("nicht", "kein", "keine", "keinen", "keinem", "keiner", "weder"),
    "fr": ("pas", "ne", "n'", "ni", "jamais", "non"),
    "es": ("no", "ni", "nunca", "tampoco"),
    "pt": ("nao", "não", "nem", "nunca", "tampouco"),
}


def _says_at(comparators: tuple[str, ...], low: str) -> int | None:
    """Where the first of these direction words starts in the folded sentence, or None."""
    hits = [m.start() for w in comparators for m in re.finditer(rf"\b{re.escape(fold(w))}\b", low)]
    return min(hits) if hits else None


def _negated(low: str, at: int | None, lang: str) -> bool:
    """Whether a negation stands in the few words before the direction word at `at`.

    "A is not higher than B" claims the opposite relation of "A is higher than B", and the check used
    to read both the same way — accepting the false one and refusing the true one. A short window on
    purpose: a "not" three clauses earlier negates something else.
    """
    if at is None:
        return False
    window = low[max(0, at - 24) : at]
    words = _NEGATION.get(lang, _NEGATION["en"])
    return any(re.search(rf"(?:^|\W){re.escape(fold(w))}(?:\W|$)", window) for w in words)


def rank_wording(sentence: str, lang: str) -> bool:
    """Whether a sentence still makes a size claim in words — a superlative, an ordinal or a comparison.

    The freshness check asks this of a sentence a correction touched: a rank or band
    finding counts as answered when the sentence that carried the claim no longer claims anything —
    "Packaging carries 18.9 %" — and not when it was merely edited around the claim, "The Packaging is
    the largest contributor".
    """
    code = normalise(lang)
    low, _place = folded(sentence)
    higher, lower = _COMPARATORS.get(code, _COMPARATORS["en"])
    if _says(higher, low) or _says(lower, low):
        return True
    words = _SUPERLATIVES.get(code, _SUPERLATIVES["en"]) + _ORDINALS.get(code, _ORDINALS["en"])
    return bool(_mentions(words, low))


def _says(comparators: tuple[str, ...], low: str) -> bool:
    """Whether the sentence carries one of these direction words, as words rather than as substrings.

    A bare `in` test was enough while every entry was a phrase, and wrong for the single verbs the
    romance lists need: `excede` sits inside *excedente* (a surplus, which substitution and credit
    discussions talk about), `supera` inside *superar*, `dépasse` inside *dépassement*. The direction
    then came from a sentence that states none, and the arithmetic contradicted a claim nobody made —
    in a rule that blocks (V213). No inflection tolerance here on purpose: the forms are enumerated in
    the lists, gender and number included, so a tolerance would only re-open the same door.
    """
    return any(re.search(rf"\b{re.escape(fold(w))}\b", low) for w in comparators)






def _blank_non_ordinals(low: str, lang: str) -> str:
    """The folded sentence with everything that looks like a listed ordinal and is not one blanked.

    Blanked rather than skipped: a preposition or a fraction is not an ordinal at all, so the cleanest
    thing is for the matchers below never to see it — and a blank keeps every other offset intact,
    which matters because callers map positions back to the unfolded sentence.
    """
    for pattern in _NOT_AN_ORDINAL.get(lang, ()):
        low = re.sub(pattern, lambda m: " " * len(m.group(0)), low)
    return low


def _ordinal_patterns(
    ordinals: tuple[str, ...], superlatives: tuple[str, ...], lang: str
) -> list[tuple[str, str]]:
    """(entry, regex) for every way an ordinal can rank a superlative — the *one* matcher for both.

    Two readers ask two different questions of the same list: "is this a ranked statement?"
    (`_disarming_ordinal`, which decides whether a rule **blocks**) and "which rank does it name?"
    (`_clause_rank`, which only suggests). Building the patterns once is what keeps the two answers
    from drifting apart, and here the drift would be the expensive kind — advice naming a rank the
    disarming rule had read as something else.

    The entry travels with its pattern because the *number* lives on the entry (`_ORDINAL_INDEX`) and
    the position lives on the match; the arms are explained at `_disarming_ordinal`.
    """
    tail = "|".join(re.escape(fold(w)) for w in superlatives)
    glued = rf"|(?={tail})" if tail else ""
    out = [(w, rf"\b{re.escape(fold(w))}(?:\w{{0,2}}\b{glued})") for w in ordinals]
    if tail:
        out += [
            (w, rf"\b{re.escape(fold(w))}[\s-]+(?:{tail})")
            for w in _ORDINALS_BEFORE_SUPERLATIVE.get(lang, ())
        ]
    return out


def _ordinal_hits(
    ordinals: tuple[str, ...], superlatives: tuple[str, ...], low: str, lang: str = "en"
) -> list[str]:
    """The listed ordinals this sentence uses as a rank word, spelled as the *list* spells them.

    Sentence-wide, which is what disarming has always been: an ordinal anywhere means the sentence is
    talking about rank. Returning every match rather than the first costs the short-circuit
    `_disarming_ordinal` used to have, on the sentences that carry a superlative at all (380 of the
    2 722 in the corpus on disk), and buys one matcher instead of two.
    """
    low = _blank_non_ordinals(low, lang)
    return [w for w, pattern in _ordinal_patterns(ordinals, superlatives, lang)
            if re.search(pattern, low)]


def _disarming_ordinal(
    ordinals: tuple[str, ...], superlatives: tuple[str, ...], low: str, lang: str = "en"
) -> bool:
    """Whether the sentence's superlative is a *ranked* one — "the second largest", "zweitgrößte".

    Read by both rules that judge a superlative, here and in `report_staleness`, because a sentence
    that is a claim about rank rather than about the top has to read the same way at write time and
    afterwards.

    Two ways an ordinal can be there. As a **word**, matched the way `_mentions` matches everything
    else: whole, with two characters' worth of inflection ("deuxième", "segundos"). The closing
    boundary is the fix rather than a detail — as bare prefixes these entries reached *secondary*,
    *secondaire* and *weitere*, so "Secondary data was used, and the dominant group is …" disarmed a
    rule that blocks, and "secondary data" is in nearly every life-cycle-inventory chapter there is
    (V209).

    And as the **front half of a compound**, which is how German writes it: the ordinal is glued to the
    superlative and is not a word at all ("zweitgrößte", "nächsthöchste"). So a stem also counts when a
    listed superlative follows it directly. That arm cannot be incomplete where it matters, because it
    is built from the very list that fires the rule: a compound whose second half is not a listed
    superlative never triggers anything to disarm. And it cannot re-open V209, because a determiner
    stands in front of a noun — "weitere Annahmen" — not in front of a superlative.

    And a third way it can *seem* to be there and not be, which is what `_ORDINALS_BEFORE_SUPERLATIVE`
    answers: a word that is a determiner as often as an ordinal counts only in front of a superlative,
    where its ranked reading is the only one available.

    The matching itself is `_ordinal_hits`, so this reads exactly what the *number* reads.
    """
    return bool(_ordinal_hits(ordinals, superlatives, low, lang))


def _binding_leads(
    head: str, index: int, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None
) -> bool:
    """Is the member this index is *pinned to* the one that leads the ranking today?

    An index is not a rank. A written chapter binds ``hotspots.1`` to a particular dataset, and the
    placeholder keeps resolving to that dataset however the list reorders — that is the whole point of
    bindings. So after a reordering, "the largest" legitimately sits on a non-zero index, and the
    positional rule condemned the only correct wording there is: the staleness check says "hotspots.0
    is no longer rank 1 — fix the sentence", the sole fix is to move the superlative to the member
    that now leads, and the gate then refused exactly that. A correction for a rank change could not
    be written at all.

    Purely arithmetic, like the rest of this module: where the member sits now decides. Chapters with
    no binding for the index fall through to the positional rule unchanged, and a freshly written
    chapter is unaffected either way — its bindings are the ranks it was written against.
    """
    identity = (bindings or {}).get(f"{head}.{index}")
    if not identity:
        return False
    items = rd.bound_lookup(head, data, bindings)
    if not isinstance(items, list) or not items:
        return False
    return rd.identity_matches(items[0], identity)


def _leading_names(
    head: str,
    data: dict[str, Any],
    members: dict[str, list[tuple[str, dict[str, Any]]]],
    bindings: dict[str, dict[str, Any]] | None = None,
) -> list[str]:
    """The spelled-out name(s) of the member that leads this list today.

    Only the leader, and only as a way to *disarm*: a name is never turned into an offender here. The
    sentence "Distribution, the largest phase, is followed by Packaging ({{…groups.1…}})" states the
    superlative about a member it names without a figure, and the nearest figure belongs to the runner-up
    — reading the superlative off that figure condemns a correct sentence. Recognising the leader's name
    as the thing the superlative stands next to is enough to leave it alone, and it cannot invent a
    finding, because a name that is *not* the leader is simply not an anchor: the sentence then falls
    through to the placeholder rule unchanged.
    """
    if head not in members:
        members[head] = _named_members(head, data, bindings)
    items = rd.bound_lookup(head, data, bindings)
    if not isinstance(items, list) or not items:
        return []
    leader = rd.identity_of(items[0], rd.identity_fields(head))
    if not leader:
        return []
    return [name for name, identity in members[head] if identity == leader]


def _superlative_anchors(
    sentence: str,
    data: dict[str, Any],
    members: dict[str, list[tuple[str, dict[str, Any]]]],
    bindings: dict[str, dict[str, Any]] | None = None,
) -> list[tuple[int, int, tuple[tuple[str, int], ...]]]:
    """Everything in the sentence a superlative could be *about*, as (start, end, claimed indices).

    An empty index tuple means "an anchor that carries no claim" — the superlative sits next to it and
    is thereby accounted for, but nothing is asserted about a rank. Two things qualify:

    * an aggregate (`sum`), for the reason the rule already knew: "…and together they account for
      {{sum(groups.0…, groups.1…)}} %" is a figure about several members, not a claim about one;
    * the name of the member that leads the list today (see `_leading_names`).
    """
    anchors: list[tuple[int, int, tuple[tuple[str, int], ...]]] = []
    heads: set[str] = set()
    for match in rd.PLACEHOLDER.finditer(sentence):
        token = match.group(1)
        # `subject_paths`, not `paths_in_token`: an aggregate claims nobody, and a two-operand
        # derivation claims only what it is *about* — its first operand (V334). Either way the token is
        # still an anchor, so a superlative beside it is accounted for rather than left to wander.
        subjects = rd.subject_paths(token)
        if not subjects and rd.paths_in_token(token):
            anchors.append((match.start(), match.end(), ()))
            continue
        cited = {
            (split[0], split[1])
            for path in subjects
            if (split := rd.ranked_prefix(path)) and rd.is_magnitude_ranked(split[0])
        }
        if cited:
            anchors.append((match.start(), match.end(), tuple(sorted(cited))))
            heads.update(head for head, _index in cited)
    for head in heads:
        for name in _leading_names(head, data, members, bindings):
            at = sentence.find(name)
            while at >= 0:
                anchors.append((at, at + len(name), ()))
                at = sentence.find(name, at + len(name))
    return anchors


def _superlative_subjects(
    sentence: str,
    low: str,
    place: list[int],
    superlatives: tuple[str, ...],
    data: dict[str, Any],
    members: dict[str, list[tuple[str, dict[str, Any]]]],
    bindings: dict[str, dict[str, Any]] | None = None,
) -> set[tuple[str, int]]:
    """The ranked members the sentence's superlatives are actually attributed to.

    The rule used to have no notion of a subject at all: any ranked index anywhere in the sentence was
    an offender, so a *true* sentence was refused because of a member it mentioned in passing (V175).
    Measured on a real chapter: "Packaging ({{…groups.0…}}) is important, and Distribution
    ({{…groups.1…}}) dominates, while … contributes only {{…groups.3…}}" — Distribution does lead the
    ranking, the correction that wrote it was right, and the gate condemned it over `groups.3`, which
    the sentence describes with the word *only*.

    So: each superlative belongs to the anchor nearest to it, in either direction — the same reading
    `misbound_names` uses for a figure and the name in front of it, and the same one `_compared_pair`
    uses for the two sides of a comparison. Ties go to the placeholder, so a name can only ever excuse a
    superlative it stands closer to than any figure does.
    """
    anchors = _superlative_anchors(sentence, data, members, bindings)
    if not anchors:
        return set()
    subjects: set[tuple[str, int]] = set()
    for start, end in _mention_spans(superlatives, low):
        # Out of the folded sentence and back into the one the anchors were found in: a dropped
        # combining accent shifts every offset after it, and a superlative measured in the wrong
        # coordinates would be attributed to the wrong anchor.
        start, end = place[start], place[end - 1] + 1
        nearest: tuple[tuple[int, int], tuple[tuple[str, int], ...]] | None = None
        for at, to, claims in anchors:
            # Distance in either direction, 0 when the word sits inside the anchor. The second key
            # breaks a tie towards the figure: a name may only excuse what it is *closer* to.
            rank = (max(at - end, start - to, 0), 0 if claims else 1)
            if nearest is None or rank < nearest[0]:
                nearest = (rank, claims)
        if nearest is not None:
            subjects.update(nearest[1])
    return subjects


#: Ranked lists whose members are the study's **variants**. A superlative beside one is a claim about a
#: variant, and the declaration form for that is `results.<i>.subjects_by_score.<j>` — the same variants
#: ordered by one indicator's score, which is the list a rank claim about a variant may point at (V219).
#: A sentence citing `subjects.0.label` does not cite that list, so there is nothing here to name, and
#: the nearest *magnitude*-ranked figure belongs to somebody else: measured on run 21's comparison
#: chapter, "{{subjects.0.label}} is always the highest, …" would have been told to declare
#: `contributions.0.groups.0` — the phase breakdown that happens to stand in the same sentence. So a
#: variant is an anchor that accounts for the word and suggests nothing.
_VARIANT_LISTS: frozenset[str] = frozenset(
    {"subjects", "contribution_subjects", "contributions.*.subjects"}
)

#: An index in what is left of a path *after* its innermost ranked split — the mark of a figure about a
#: member of an unregistered sub-list. `hotspots.0.inputs.0.name` splits at `hotspots`, because
#: `hotspots.*.inputs` is no registered list, so the citation reads as "the leading hotspot" while the
#: sentence around it says that hotspot's largest *input* is X (three sentences in the reports on disk).
#: Declaring the outer member there would assert a rank the sentence never claimed, so this too is an
#: anchor that accounts for the word and suggests nothing.
_SUB_INDEX = re.compile(r"(?:^|\.)-?\d+(?:\.|$)")


def _declaration_anchors(
    sentence: str,
    data: dict[str, Any],
    members: dict[str, list[tuple[str, dict[str, Any]]]],
    bindings: dict[str, dict[str, Any]] | None = None,
) -> list[tuple[int, int, str | None]]:
    """Everything a superlative could be about, as (start, end, the member a declaration would name).

    `None` is an anchor that carries no *nameable* member: the word beside it is accounted for, and no
    `{{rank:…}}` can be written for it — an aggregate, a variant (`_VARIANT_LISTS`), a figure about a
    member of a sub-list (`_SUB_INDEX`), or a token naming two ranked members at once.

    The **name** of the member that leads today is an anchor with a member, and that is the difference
    that earns this function its existence. `_superlative_anchors` counts such a name as carrying no
    claim, because there its only job is to stop the rule refusing a true sentence (`_leading_names`).
    Here it is the best case there is: "Packaging dominates the result with {{…groups.0.share_text}}"
    becomes right by replacing the word *Packaging* with the declaration, which prints *Packaging* —
    the same document, checked. It is offered only while index 0 still means the leader: a chapter that
    pins `head.0` to some other member is a chapter where the declaration would print that other
    member's name, and a suggestion has to be true about the document it is made about.

    `_superlative_anchors` next door answers a different question — which member the sentence *asserts*
    something about, so that arithmetic can contradict it — and carries the indices for that. This one
    answers "what may the author be told to write", which needs the one member a declaration would name
    and has to fall silent wherever that is not exactly one member. Two functions rather than a wider
    return type, for the reason `ranked_prefix` and `ranked_splits` are two: the call sites then say
    which question they mean.
    """
    anchors: list[tuple[int, int, str | None]] = []
    heads: set[str] = set()
    for match in rd.PLACEHOLDER.finditer(sentence):
        token = match.group(1)
        if rd.is_aggregate(token):
            anchors.append((match.start(), match.end(), None))
            continue
        targets: set[str] = set()
        blind = False
        for path in rd.paths_in_token(token):
            splits = rd.ranked_splits(path)
            if not splits:
                continue
            if any(rd.registry_key(head) in _VARIANT_LISTS for head, _index, _rest in splits):
                blind = True
                continue
            head, index, rest = splits[-1]
            if not rd.is_magnitude_ranked(head):
                continue
            if _SUB_INDEX.search(rest):
                blind = True
                continue
            targets.add(f"{head}.{index}")
        if len(targets) == 1 and not blind:
            target = next(iter(targets))
            anchors.append((match.start(), match.end(), target))
            heads.add(target.rsplit(".", 1)[0])
        elif targets or blind:
            anchors.append((match.start(), match.end(), None))
    for head in heads:
        key = f"{head}.0"
        leads = key not in (bindings or {}) or _binding_leads(head, 0, data, bindings)
        for name in _leading_names(head, data, members, bindings):
            at = sentence.find(name)
            while at >= 0:
                anchors.append((at, at + len(name), key if leads else None))
                at = sentence.find(name, at + len(name))
    return anchors




#: Where a clause ends, for the backward window `_denied_spans` reads. No `.`: inside a sentence a full
#: stop is a placeholder path or an abbreviation, never a clause end — `_sentences` has already cut
#: where prose ends one.
_CLAUSE_EDGE = re.compile(r"[,;:!?()\[\]—–…]|\s-\s")


def _clause_masked(low: str) -> str:
    """The folded sentence with its placeholders blanked, for the clause windows below.

    A path is full of commas and parentheses inside `sum(…)`, and read as clause edges they would cut a
    window to nothing; blanking keeps every offset, which matters because the callers compare positions
    against the spans `_mention_spans` returned.
    """
    return rd.PLACEHOLDER.sub(lambda m: " " * len(m.group(0)), low)


def _clause_start(masked: str, before: int) -> int:
    """Where the clause holding position `before` begins."""
    edge = 0
    for match in _CLAUSE_EDGE.finditer(masked, 0, before):
        edge = match.end()
    return edge


def _denied_spans(
    spans: list[tuple[int, int]], low: str, lang: str
) -> set[tuple[int, int]]:
    """Which of these superlative spans stand behind a denial or a hedge **in their own clause**.

    Per span, not per sentence, and that is the measurement rather than a preference. "The largest
    single dataset is in fact **not** part of the dominant group at all: …" denies one of its two
    superlatives and asserts the other; silencing the sentence would lose a correct advisory, while
    silencing the word leaves the assertion — and `_declaration_target` then answers from the words
    that are left, or falls silent because none are.

    Backward only, and clause-bounded. Both halves were measured against the 252 chapters on disk:

    * **backward**, because a negation after the superlative is regularly about something else — "a
      Embalagem domina com uma nitidez que **não** tem nos outros indicadores" asserts the dominance
      the *não* qualifies. The price is the postposed German negation ("dominiert nicht"), which no
      report has written and which this rule cannot see.
    * **clause-bounded**, because sentence-wide reach costs more than it buys: it suppresses 84 spans
      instead of 29 and silences two correct advisories, one of them the contrastive "nicht von der
      Distribution, sondern von der Produktion dominiert" and one where the negation belongs to a
      different proposition entirely ("shows where they agree and where they do **not**: the use phase
      leads everywhere…"). A character cap on top of the clause buys nothing: at 60 characters it drops
      one true suppression and no false one.

    Named price, measured: a clause may still coordinate two propositions with *and*, and then a denial
    of the first reaches the second — "no Euro 6 petrol car exists in ecoinvent 3.12 and the global
    market for the same service is dominated by rest-of-world processes" is the one such sentence on
    disk. It is the free direction: it silences a note nobody is waiting for. A per-language list of
    conjunctions would fix exactly that one sentence and change no advisory, which is not worth five
    more word lists in this file.
    """
    denials = _DENIALS.get(lang, ())
    if not spans or not denials:
        return set()
    masked = _clause_masked(low)
    for pattern in _NOT_A_DENIAL.get(lang, ()):
        masked = re.sub(pattern, lambda m: " " * len(m.group(0)), masked)
    out: set[tuple[int, int]] = set()
    for start, end in spans:
        clause = masked[_clause_start(masked, start):start]
        if any(re.search(pattern, clause) for pattern in denials):
            out.add((start, end))
    return out


def _clause_rank(
    spans: list[tuple[int, int]],
    low: str,
    lang: str,
    ordinals: tuple[str, ...],
    superlatives: tuple[str, ...],
) -> int | None:
    """The rank the ordinals name, read per superlative and only inside that superlative's own clause.

    `_disarming_ordinal` asks a *sentence-wide* question and must keep asking it: an ordinal anywhere
    means the sentence is talking about rank, and narrowing that would make a blocking rule fire. This
    asks the narrow question the suggestion needs — which rank is this *word* being given — and the
    difference is not a nicety. Measured on the reports on disk, the sentence-wide reading produced one
    piece of advice that was simply false: "…com a embalagem em **segundo** plano
    ({{contribution.groups.1.share_text}}); essa **predominância** remonta…" — where *segundo plano* is
    the idiom "in the background", the predominance belongs to the *distribution* phase two clauses
    earlier, and the two happened to agree on the number 1. Read clause by clause the ordinal is not in
    the superlative's clause at all and nothing is suggested.

    None wherever the reading is not unanimous, which is the module's standing policy and here costs
    nothing: no ordinal in this word's clause, an ordinal with no number of its own (`_ORDINAL_INDEX` —
    "next", "suivant", "nächst"), two ordinals naming different ranks, or two superlatives ranked
    differently ("the largest is A and the second-largest is B" is a sentence about two members).

    The window runs to the **end** of the superlative rather than to its start, because two of the three
    arms match *across* it: `_ORDINALS_BEFORE_SUPERLATIVE` is "next" plus a listed superlative in one
    pattern, and the glued arm is an ordinal with the superlative in a lookahead. Cut at the span's
    start, neither could match at all. The match still has to *begin* before the superlative, which is
    what keeps the window from reading an ordinal that follows it.

    Worth knowing, because it looks like a hole and is not one: the German compound "zweitgrößte" never
    reaches here, and neither does it reach the rule that blocks. `_mentions` needs a word boundary in
    front of "größte" and the glued *t* denies it, so the sentence carries no superlative as far as this
    module is concerned. What German writes that both rules do see is the free-standing ordinal ("der
    zweite Hauptbeitrag"), which the first arm matches as a word.
    """
    if not spans:
        return None
    masked = _blank_non_ordinals(_clause_masked(low), lang)
    patterns = _ordinal_patterns(ordinals, superlatives, lang)
    ranks: set[int | None] = set()
    for start, end in spans:
        edge = _clause_start(masked, start)
        clause = masked[edge:end]
        limit = start - edge
        here = {
            _ORDINAL_INDEX.get(lang, {}).get(word)
            for word, pattern in patterns
            for match in re.finditer(pattern, clause)
            if match.start() < limit
        }
        if len(here) != 1:
            return None
        ranks |= here
    if len(ranks) != 1 or None in ranks:
        return None
    return next(iter(ranks))


def _declaration_target(
    sentence: str,
    place: list[int],
    spans: list[tuple[int, int]],
    data: dict[str, Any],
    members: dict[str, list[tuple[str, dict[str, Any]]]],
    bindings: dict[str, dict[str, Any]] | None = None,
) -> str | None:
    """The one member every superlative in this sentence points at, or None.

    Nearest anchor per word, the same reading `_superlative_subjects` uses to attribute a claim — so a
    sentence can only ever be told to declare the member the blocking rule would have judged.

    The tie-break is the opposite one, and deliberately. There a name may only excuse a superlative it
    stands *closer* to than any figure, because that rule **refuses** a chapter and the doubt belongs to
    the author. Here the finding *asserts* what to write, so equal distance means the sentence has not
    said which member it is about, and nothing is suggested.

    `spans` arrives already found and already filtered, rather than being looked up from the word list
    here, and that is what keeps the suppressor out of the blocking rule: `_superlative_subjects` next
    door goes on calling `_mention_spans` for itself, over the unfiltered list.
    """
    anchors = _declaration_anchors(sentence, data, members, bindings)
    if not anchors:
        return None
    targets: set[str | None] = set()
    for start, end in spans:
        start, end = place[start], place[end - 1] + 1
        best: tuple[int, int] | None = None
        nearest: set[str | None] = set()
        for at, to, target in anchors:
            # Distance in either direction, 0 when the word sits inside the anchor; then a nameless
            # anchor ahead of a nameable one at the same distance. The second key is what makes an
            # unbroken tie answer itself: it can never hold a nameless anchor beside a nameable one, so
            # a tie is always two *members*, the set keeps both, and the check below reads that as "the
            # sentence has not said which".
            key = (max(at - end, start - to, 0), 1 if target else 0)
            if best is None or key < best:
                best, nearest = key, {target}
            elif key == best:
                nearest.add(target)
        targets.update(nearest)
    return next(iter(targets)) if len(targets) == 1 else None


def _as_written(spans: list[tuple[int, int]], sentence: str, place: list[int]) -> str:
    """The first of these spans as the *chapter* spells it — "dominé", not the list's "domine".

    Takes the spans the finding was actually built from, so the word quoted back is one that survived
    the suppressor. Read off the word list instead, the message on "Kein Einzelprozess dominiert: Die
    größten Beiträge … liefern mit {{hotspots.0.share_text}} …" quoted *dominiert* — the one word in the
    sentence that claims nothing — while the advice it carried was about *größten*.
    """
    if not spans:
        return ""
    start, end = spans[0]
    return sentence[place[start] : place[end - 1] + 1]


#: The kind every *suggestion* this module makes carries, and the reason none of them can refuse a
#: chapter: it is one of `report_prompts.ADVISORY_FINDINGS`, which is the set the gate excludes when it
#: works out whether anything blocks. Spelled here rather than imported because `report_prompts` imports
#: *this* module; a test asserts the two agree, so the constant cannot drift into a blocking kind.
#:
#: Reusing the causal note's kind rather than minting a new one is deliberate. A new kind would have
#: to be added to the advisory set in three places — here, and the two copies the frontend keeps by
#: name — and a suggestion that blocks a chapter because one of those was missed is exactly the failure
#: this whole design is built to make impossible. And the kind is honest for both suggestions this
#: module makes: what is unverifiable is not the arithmetic but the *claim* — whether the sentence
#: makes one at all (3a), and whether the one it makes is checkable rather than merely watched (3b).
ADVISORY_KIND = "unverifiable_claim"

#: What 3a's candidates carry. The same kind, kept under its own name because that is what the model
#: path's tests and callers ask for.
MODEL_CANDIDATE_KIND = ADVISORY_KIND


def _lone_offending_index(
    sentence: str,
    data: dict[str, Any],
    members: dict[str, list[tuple[str, dict[str, Any]]]],
    bindings: dict[str, dict[str, Any]] | None = None,
) -> str | None:
    """The one ranked member a *wordless* claim to the top could only be about, or None.

    The word-list path attributes a superlative to the anchor nearest to it (`_superlative_subjects`),
    and it can do that because it knows where the word is. A model candidate has no word — the model
    is asked whether the sentence claims a top rank, never which member it claims it for, because
    that is positional and belongs to the arithmetic.

    So attribution here is by elimination, and only where elimination is total: exactly one anchor in
    the sentence, citing exactly one ranked member, and that member is not the one leading today. Two
    anchors and the sentence is left alone — an aggregate, a named leader or a second figure each give
    the claim somewhere else to sit, and guessing between them is how V175 refused a true sentence.
    """
    anchors = _superlative_anchors(sentence, data, members, bindings)
    if len(anchors) != 1:
        return None
    claims = anchors[0][2]
    if len(claims) != 1:
        return None
    head, index = claims[0]
    if index == 0 or _binding_leads(head, index, data, bindings):
        return None
    return f"{head}.{index}"


def check_claims(
    text: str,
    data: dict[str, Any],
    lang: str = "en",
    bindings: dict[str, dict[str, Any]] | None = None,
    weak_percent: float = DEFAULT_WEAK_DIFFERENCE_PERCENT,
    detector: Any | None = None,
) -> list[dict[str, Any]]:
    """Findings about the chapter's assertions. `kind` says whether it blocks (see report_prompts).

    `detector` is an optional `report_claim_model.ClaimDetector`, and no caller passes one today.
    It can only ever *add* the advisory finding below, and only to sentences where the word list
    matched no superlative at all — see step 3a, which is where that argument is written down.
    """
    lang = normalise(lang)
    higher, lower = _COMPARATORS.get(lang, _COMPARATORS["en"])
    superlatives = _SUPERLATIVES.get(lang, _SUPERLATIVES["en"])
    ordinals = _ORDINALS.get(lang, _ORDINALS["en"])
    causal = _CAUSAL.get(lang, _CAUSAL["en"])
    value_words = _VALUE_WORDS.get(lang, _VALUE_WORDS["en"])
    neutrality = _NEUTRALITY_WORDS.get(lang, _NEUTRALITY_WORDS["en"])
    than = _THAN.get(lang, _THAN["en"])
    comparative = _COMPARATIVE_SUPERLATIVES.get(lang, ())
    findings: list[dict[str, Any]] = []
    # Member names per ranked list, resolved once and shared by every sentence.
    members: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    causal_hits: list[str] = []
    value_hits: list[str] = []
    neutral_hits: list[str] = []
    # Sentences the word list said nothing about, with the ranked member a claim in them could only
    # be about. Collected rather than judged one by one: embedding forty sentences in one call is
    # several times cheaper per sentence than forty calls, and a chapter arrives whole.
    unworded: list[tuple[str, str]] = []

    for raw in _sentences(text):
        sentence = raw.strip()
        if not sentence:
            continue
        low, place = folded(sentence)
        tokens = _tokens_in(sentence)
        says_higher = _says(higher, low)
        says_lower = _says(lower, low)
        negated = False
        if says_higher and says_lower:
            # "higher than the baseline, but lower than variant C" — both directions in one sentence.
            # The direction words are sentence-wide while the rules below judge a single pair, so
            # neither rule can tell which figure each direction belongs to. Such a
            # sentence used to be left alone, and "5 kg is higher than 10 kg and lower than 1 kg" passed
            # the gate with both halves false. Now it is refused with the one instruction that makes it
            # checkable: one comparison per sentence.
            findings.append(
                {
                    "kind": "ambiguous_comparison",
                    "sentence": sentence,
                    "detail": (
                        f"“{_clip(sentence)}” compares in both directions in one sentence, and the "
                        "check cannot tell which figure each direction belongs to. Split it into two "
                        "sentences, one comparison each."
                    ),
                }
            )
            says_higher = says_lower = False
        elif says_higher or says_lower:
            negated = _negated(low, _says_at(higher if says_higher else lower, low), lang)
        # Only where the sentence also carries a FIGURE. The note says the data can show what is large
        # and never why — which is true of "climate change is driven by {{…}}" and false of "the press
        # cake leaves the system burden-free because of the cut-off principle", a methodological
        # explanation with no number in it. Firing on every "because" caught six of nine chapters of the
        # wood-stain report with one identical remark — nearly half of everything the writer
        # report said, and it buried the four findings that meant something (V250). A note that appears
        # under every chapter is one nobody reads by the third time.
        if tokens or _SHARE_IN_PROSE.search(sentence):
            causal_hits += _mentions(causal, low)

        # --- 0. wording: value judgements and neutrality claims ----------------
        # The comparison word disarms the value rule, not the neutrality rule: "more environmentally
        # friendly than" is a statement about two numbers, "climate neutral" is not.
        compares = any(re.search(rf"\b{re.escape(fold(w))}\b", low) for w in than)
        if not compares:
            value_hits += _mentions(value_words, low)
        neutral_hits += _mentions(neutrality, low)

        # --- 1. direction of a change/diff derivation ---------------------------
        for token in tokens:
            if not token.endswith(")"):
                continue
            name = token[: token.index("(")].strip()
            if name not in ("change", "diff"):
                continue
            value = _value_of(token, data, bindings)
            if value is None or not (says_higher or says_lower):
                continue
            if value == 0:
                # Equal is not "higher" — the branch used to skip zero and let the claim stand.
                if not negated:
                    findings.append(
                        {
                            "kind": "contradicted_claim",
                            "relation": True,
                            "sentence": sentence,
                            "detail": (
                                f"“{_clip(sentence)}” says it is {'higher' if says_higher else 'lower'}, "
                                f"but {name} works out to exactly zero — the two are equal. Say so, or "
                                "check the two arguments."
                            ),
                        }
                    )
                continue
            if negated:
                # "not higher" holds for lower-or-equal, "not lower" for higher-or-equal.
                if says_higher and value > 0:
                    findings.append(
                        {
                            "kind": "contradicted_claim",
                            "relation": True,
                            "sentence": sentence,
                            "detail": (
                                f"“{_clip(sentence)}” says it is not higher, but {name} works out positive "
                                f"({value:.4g}) — it is higher. Drop the negation or swap the two arguments."
                            ),
                        }
                    )
                elif says_lower and value < 0:
                    findings.append(
                        {
                            "kind": "contradicted_claim",
                            "relation": True,
                            "sentence": sentence,
                            "detail": (
                                f"“{_clip(sentence)}” says it is not lower, but {name} works out negative "
                                f"({value:.4g}) — it is lower. Drop the negation or swap the two arguments."
                            ),
                        }
                    )
                continue
            if says_higher and value < 0:
                findings.append(
                    {
                        "kind": "contradicted_claim",
                        "relation": True,
                        # The sentence in full, beside the clipped one the message shows. The
                        # correction brief locates a refusal by it: a chapter that cannot be saved
                        # until this sentence changes has to arrive at the model *with* the sentence,
                        # or the correction is a paid round that must fail (V184).
                        "sentence": sentence,
                        "detail": (
                            f"“{_clip(sentence)}” says it is higher, but {name} works out negative "
                            f"({value:.4g}) — it is lower. Reverse the wording or swap the two arguments."
                        ),
                    }
                )
            elif says_lower and value > 0:
                findings.append(
                    {
                        "kind": "contradicted_claim",
                        "relation": True,
                        "sentence": sentence,
                        "detail": (
                            f"“{_clip(sentence)}” says it is lower, but {name} works out positive "
                            f"({value:.4g}) — it is higher. Reverse the wording or swap the two arguments."
                        ),
                    }
                )

        # --- 2. comparison between two placeholders ---------------------------
        if (says_higher or says_lower) and len(tokens) >= 2:
            pair = _compared_pair(sentence, tokens, higher + lower)
            if pair:
                left, right = pair
                a, b = _value_of(left, data, bindings), _value_of(right, data, bindings)
                if a is not None and b is not None:
                    if a == b:
                        # Equal values satisfy "not higher" and contradict "higher": the rule used to
                        # skip equality altogether.
                        if not negated:
                            findings.append(
                                _contradiction(sentence, left, a, right, b, "higher" if says_higher else "lower", equal=True)
                            )
                    elif negated:
                        if says_higher and a > b:
                            findings.append(_contradiction(sentence, left, a, right, b, "not higher"))
                        elif says_lower and a < b:
                            findings.append(_contradiction(sentence, left, a, right, b, "not lower"))
                    elif says_higher and a < b:
                        findings.append(_contradiction(sentence, left, a, right, b, "higher"))
                    elif says_lower and a > b:
                        findings.append(_contradiction(sentence, left, a, right, b, "lower"))
                    else:
                        # The direction is right. The remaining question is whether the difference is
                        # large enough to carry the claim — see DEFAULT_WEAK_DIFFERENCE_PERCENT.
                        base = min(abs(a), abs(b))
                        spread = abs(a - b) / base * 100.0 if base else None
                        if spread is not None and spread < weak_percent:
                            findings.append(
                                {
                                    "kind": "weak_difference",
                                    "sentence": sentence,
                                    "detail": (
                                        f"“{_clip(sentence)}” compares values that differ by "
                                        f"{spread:.2g} %, below the {weak_percent:.3g} % this report "
                                        "treats as the limit of what its data can carry. Without an "
                                        "uncertainty analysis that is not evidence of a difference — "
                                        "say the two are comparable, or name the spread."
                                    ),
                                }
                            )

        # --- 3. superlative on a ranked index ---------------------------------
        # An ordinal anywhere in the sentence disarms this rule: "the second-largest contributor" is a
        # claim about rank, not about the top, and it is the natural way to describe index 1.
        #
        # So does a comparison, but only for the wordings that are comparatives themselves: the
        # sentence "A is more important than B" asserts nothing about the top, while "A dominates, and
        # it is more important than B" asserts it in a word that is not the comparative one. Hence the
        # words are dropped and not the sentence — and only the surviving ones go on to look for a
        # subject, because a wording that claims nothing cannot decide whom the claim is about.
        worded = _mentions(superlatives, low)
        claiming = worded
        if compares and comparative:
            claiming = [w for w in claiming if w not in comparative]
        # --- 3a. the same question, asked of a model, and only where the words said nothing ------
        # The condition is `not worded` rather than `not claiming`: a sentence whose only superlative
        # was dropped by the comparative exemption (V210/V211) has been *judged* — it compares two
        # numbers — and re-opening it here would undo a guard rather than add to it. Every other
        # guard is untouchable in the same way: each one acts on a word the list matched, and this
        # branch only runs where the list matched none.
        #
        # The ordinal still disarms, and it has to: "an zweiter Stelle steht die Distribution" uses
        # no listed superlative at all, so the word list never reaches this sentence — but it is a
        # statement about rank 2 and a candidate on it would be a false alarm the list never made.
        if (
            detector is not None
            and not worded
            and not compares
            and not _disarming_ordinal(ordinals, superlatives, low, lang)
            and (offender := _lone_offending_index(sentence, data, members, bindings))
        ):
            unworded.append((sentence, offender))
        # One reading of the ordinal for this sentence, shared by the rule that blocks and by the two
        # that suggest — `_ordinal_hits` is the matcher `_disarming_ordinal` now delegates to, so
        # "disarmed" and "which rank" cannot answer differently. Kept behind `claiming` because it is a
        # regex sweep and 2 342 of the corpus's 2 722 sentences carry no superlative at all; 3a's own
        # call sits on the mutually exclusive branch (`not worded`), so no sentence is read twice.
        ordinal_hits = _ordinal_hits(ordinals, superlatives, low, lang) if claiming else []
        # The superlative spans, and the ones a denial or a hedge has taken the claim out of. Only the
        # *suggestions* below read the filtered list; the blocking rule calls `_mention_spans` for
        # itself over the unfiltered word list, so its verdict on these sentences is byte for byte what
        # it was. That split is the whole safety argument — see `_DENIALS`.
        spans = _mention_spans(tuple(claiming), low) if claiming else []
        asserting = [s for s in spans if s not in _denied_spans(spans, low, lang)]
        if claiming and not ordinal_hits:
            # Whom the superlative is about decides whether this fires (V175). Before, every ranked
            # index in the sentence was read as a claim to the top, so a sentence could be refused over
            # a member it explicitly called small — and because a rejection discards the whole patch,
            # two unrelated corrections went down with it and the chapter could not be fixed at all.
            claimed = {
                f"{head}.{index}"
                for head, index in _superlative_subjects(
                    sentence, low, place, tuple(claiming), data, members, bindings
                )
                if index != 0 and not _binding_leads(head, index, data, bindings)
            }
            # Every ranked index the sentence cites that is not the top today. A subset question, not
            # the trigger: it is what the message lists, so the writer sees the whole inventory.
            offenders = {
                f"{split[0]}.{split[1]}"
                for token in tokens
                # An operand of an aggregate is not the subject of the superlative. "Distribution is
                # the largest phase, and together they account for {{sum(groups.0.…, groups.1.…)}} %"
                # is ordinary, correct prose, and the rule condemned it over the `groups.1` inside the
                # sum. `diff`/`percent`/`change`/`factor` each name two things, and a superlative
                # beside them is a claim about the FIRST — "the highest is {{change(top, low)}}
                # higher than the lowest" was refused over `low` (V334).
                for path in rd.subject_paths(token)
                # Magnitude-ranked lists only: `results` is method order and `subjects` is report
                # order, so "the largest is subjects.0" was an instruction to assert a falsehood.
                if (split := rd.ranked_prefix(path))
                and split[1] != 0
                and rd.is_magnitude_ranked(split[0])
                and not _binding_leads(split[0], split[1], data, bindings)
            }
            # One finding per sentence, not per placeholder: the same sentence reported nine times is how a
            # useful checker becomes one people switch off.
            if claimed:
                first = sorted(claimed)[0]
                head = first.rsplit(".", 1)[0]
                findings.append(
                    {
                        "kind": "contradicted_claim",
                        "sentence": sentence,
                        "detail": (
                            f"“{_clip(sentence)}” claims the largest, but it references "
                            f"{', '.join(sorted(offenders))} — the largest is {head}.0. Use index 0, say "
                            f"which rank you mean (\"second-largest\"), or drop the superlative."
                        ),
                    }
                )
            # --- 3b. the claim is right, and made in prose where a declaration would do -------
            # A rank claim in words is watched by a word list; the same claim declared is checked by
            # arithmetic, pinned by identity, and repaired by one replacement instead of a paid
            # rewrite — which is what phase 1 measured. What phase 1
            # did not do is *say so* at the one moment the wording is being written, so a sentence
            # that could have declared and did not passed as watched-but-uncheckable.
            #
            # Strictly a suggestion, and strictly a subset of what the rule above already sees: same
            # word list, same ordinal disarming, same attribution. Four things silence it, and each
            # one is "we do not know what to write" rather than "nothing is wrong here":
            #
            # * the sentence already declares — recognised on the exact token, so no language and no
            #   wording is involved (the same test the `ranks` verdict makes);
            # * every superlative it has is denied or hedged (`asserting` is empty) — "Kein
            #   Einzelprozess dominiert", "aucun groupe ne domine", "l'un des principaux contributeurs";
            # * `_declaration_target` cannot name one member — no anchor at all (a claim with no figure
            #   in it), a variant, an aggregate, a sub-list's member, or two members equally close;
            # * the member does not resolve — `rank_name` is the renderer's own answer to "would this
            #   declaration print anything", so a path this report has no such thing as is never
            #   printed as advice.
            #
            # `claimed` takes precedence: where the arithmetic contradicts the sentence there is one
            # problem, the refusal above names it, and telling the author to declare a rank the data
            # denies would be a second finding pointing the other way.
            elif not any(rd.rank_path(token) for token in tokens) and (
                target := _declaration_target(
                    sentence, place, asserting, data, members, bindings
                )
            ):
                declaration = f"{rd.RANK_PREFIX}{target}"
                name = rd.rank_name(declaration, data, bindings)
                if name:
                    findings.append(
                        {
                            "kind": ADVISORY_KIND,
                            "sentence": sentence,
                            "detail": (
                                f"“{_clip(sentence)}” claims a top rank in words "
                                f"(“{_as_written(asserting, sentence, place)}”) without "
                                f"declaring it — write “{{{{{declaration}}}}}” in place of the name "
                                f"(not beside it: it prints “{name}” itself), so the claim is checked by "
                                "arithmetic and one replacement repairs it when the ranking changes hands."
                            ),
                        }
                    )
        # --- 3c. the rank an ordinal named, which phase 2 had inherited as silence ------------
        # An ordinal disarms the rule that blocks because "the second-largest contributor" is a true
        # thing to say about index 1 — but it is also exactly the claim a declaration was built for
        # (V219), and phase 2 inherited the silence along with the disarming. So the *suggestion* asks
        # the one question the disarming does not: which rank did the words name?
        #
        # The blocking rule is not touched. This branch is the `else` of the condition it already had,
        # so a sentence that reaches here is a sentence that rule had already let go.
        #
        # Guarded four ways, and the first two are the ones that make it safe to say a number at all:
        #
        # * the index comes from the ordinal the chapter *wrote*, in the superlative's own clause
        #   (`_clause_rank`), and an ordinal with no number of its own — "next", the romance
        #   "suivant"/"siguiente"/"seguinte", German "nächst" — yields none, so the sentence keeps its
        #   silence. A fraction or a preposition never reaches here at all: the same `_NOT_AN_ORDINAL`
        #   pass the disarming uses runs first, so "ein Drittel", "un cuarto" and "segundo a norma"
        #   cannot produce an index;
        # * the ordinal and the member the sentence points at have to be the **same** index. Where they
        #   disagree the words and the figure disagree, and the ordinal is precisely why nothing here
        #   judges that — suggesting either one would take a side the rule declined to take;
        # * the sentence does not already declare, and the denial/hedge suppressor applies exactly as
        #   in 3b ("nicht die zweitgrößte" claims no rank either);
        # * `rank_name` resolves, so a member this report does not have is never printed as advice.
        elif claiming and (
            rank := _clause_rank(asserting, low, lang, ordinals, superlatives)
        ) is not None:
            if not any(rd.rank_path(token) for token in tokens) and (
                target := _declaration_target(
                    sentence, place, asserting, data, members, bindings
                )
            ):
                if target.rsplit(".", 1)[1] == str(rank):
                    declaration = f"{rd.RANK_PREFIX}{target}"
                    name = rd.rank_name(declaration, data, bindings)
                    if name:
                        findings.append(
                            {
                                "kind": ADVISORY_KIND,
                                "sentence": sentence,
                                "detail": (
                                    f"“{_clip(sentence)}” puts a member at rank {rank + 1} in words "
                                    f"(“{_as_written(asserting, sentence, place)}”) without declaring "
                                    f"it — write “{{{{{declaration}}}}}” in place of the name (not beside "
                                    f"it: it prints “{name}” itself), so the rank is checked by arithmetic and one "
                                    "replacement repairs it when the ranking changes hands."
                                ),
                            }
                        )

    if unworded:
        # One `embed` call for the whole chapter, and one finding per sentence the model picks out.
        # Wrapped even though `ClaimDetector.candidates` already swallows its own failures: this is
        # the last line before the gate's verdict, and an advisory that raises would take away the
        # author's ability to store *anything* over a model that failed to load.
        try:
            suspect = set(detector.candidates([s for s, _o in unworded], lang))
        except Exception as exc:  # noqa: BLE001 — see above; a suggestion is never worth a refusal
            _log.swallowed(exc, "check_claims")
            suspect = set()
        for sentence, offender in unworded:
            if sentence not in suspect:
                continue
            head = offender.rsplit(".", 1)[0]
            findings.append(
                {
                    "kind": MODEL_CANDIDATE_KIND,
                    "sentence": sentence,
                    "detail": (
                        f"“{_clip(sentence)}” reads like a claim to the top, in words this gate has no "
                        f"entry for, and the only ranking it points at is {offender} — the largest is "
                        f"{head}.0. Suggested by a similarity model, so it may be nothing: if the "
                        "sentence does claim the largest, it is wrong; if it does not, ignore this."
                    ),
                }
            )
    if value_hits:
        findings.append(
            {
                "kind": "value_judgement",
                "detail": (
                    "The chapter uses absolute value judgements ("
                    + ", ".join(sorted(set(value_hits))[:4])
                    + "). An LCA reports indicator results; no result in this report says a product is "
                    "good for the environment. The comparative against a named alternative is fine."
                ),
            }
        )
    if neutral_hits:
        findings.append(
            {
                "kind": "value_judgement",
                "detail": (
                    "The chapter claims neutrality ("
                    + ", ".join(sorted(set(neutral_hits))[:4])
                    + "). That is a claim about offsetting, scope and permanence, not an indicator "
                    "result — it belongs in very few reports, and only where those conditions are "
                    "documented. Report the computed figure instead."
                ),
            }
        )
    if causal_hits:
        # Two different notes, because a "because" means two different things depending on whether the
        # chapter went and looked. A writer that opened datasets HAS read mechanisms — that a market
        # draws on a single supplier, that a proxy carries the whole cultivation burden — and telling
        # it that "the data can show what is large, never why" suppresses exactly the sentences the
        # lookups were paid for. What stays true either way is the failure mode: a cause read off a
        # share. So the note points at the distinction instead of at the word.
        opened = len(data.get("looked_up") or [])
        findings.append(
            {
                "kind": "unverifiable_claim",
                "detail": (
                    "The chapter explains causes ("
                    + ", ".join(sorted(set(causal_hits))[:4])
                    + "). "
                    + (
                        f"You opened {opened} lookup{'s' if opened != 1 else ''} for this chapter, so a "
                        "cause you READ there is yours to state. One inferred from a share is not: that "
                        "a phase is large says nothing about why. Check each of these against what came "
                        "back — worth a second read, not a correction."
                        if opened
                        else "Nothing was looked up for this chapter, so every cause here comes from the "
                        "brief or from nowhere. The numbers show what is large, never why — worth a "
                        "second read, not a correction."
                    )
                ),
            }
        )
    # Last, because it is about the pins rather than about the wording: does each figure belong to the
    # member the sentence names? Nothing else in the pipeline asks that, and V146 walked through every
    # other gate because of it.
    findings += misbound_names(text, data, bindings)
    return findings


def _clip(sentence: str, limit: int = 90) -> str:
    return sentence if len(sentence) <= limit else sentence[: limit - 1] + "…"


def _contradiction(
    sentence: str, left: str, a: float, right: str, b: float, claimed: str, *, equal: bool = False
) -> dict[str, Any]:
    return {
        "kind": "contradicted_claim",
        # A claim about the relation of two figures: the freshness check re-asks exactly these after
        # the numbers move (`report_staleness`) and nothing else of this module's.
        "relation": True,
        "sentence": sentence,
        "detail": (
            f"“{_clip(sentence)}” claims {claimed}, but {left} is {a:.4g} and {right} is {b:.4g}"
            + (" — the two are equal. Say so, or check the two values." if equal
               else ". Check the direction or the two values.")
        ),
    }


def _compared_pair(sentence: str, tokens: list[str], words: tuple[str, ...]) -> tuple[str, str] | None:
    """The placeholder before the comparison word and the one after it.

    Returns None when the sentence does not have exactly that shape — a comparison spread over three
    placeholders, or with none on one side, is left to the author.
    """
    # Folded like every other matcher here, and the offset mapped back: the placeholders below are
    # located in the unfolded sentence, so an accent before the comparison word would put the two
    # sides of it on the wrong side.
    low, place = folded(sentence)
    at = min((low.index(f) for w in words if (f := fold(w)) in low), default=-1)
    if at < 0:
        return None
    at = place[at]
    before = [m.group(1) for m in rd.PLACEHOLDER.finditer(sentence) if m.start() < at]
    after = [m.group(1) for m in rd.PLACEHOLDER.finditer(sentence) if m.start() > at]
    if not before or not after:
        return None
    return before[-1], after[0]
