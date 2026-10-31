"""Why a written chapter is out of date — and how cheaply it can be put right.

The report is built so that numbers do *not* live in the prose: they are placeholders, resolved at
render time, bound to the identity they meant when the chapter was written (``report_data``). A
figure that moves therefore needs no new text at all. What does go wrong is the wording *around* the
numbers, and the names the prose spells out — a method family, a scenario, a unit.

The old check could not tell those apart. It hashed every number in the whole dataset plus the
ranking order into one value, so "41.2 % became 41.3 %" and "the study switched from EF v3.1 to CML"
produced the same verdict, and a chapter with no placeholders at all (``goal_scope``) was called
stale by a number it never cited.

This module answers two questions per chapter instead:

* **what did it cite** — only those paths are its business, and
* **which kind of change happened** — because each kind has a different, and much cheaper, remedy.

Everything here is arithmetic. No model is asked whether a paragraph is still true; a model is only
ever asked *how to phrase* a discrepancy this module has already established.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from prism_lca.engine import report_claims, report_prompts, report_sentences, report_typed_numbers
from prism_lca.engine import report_data as rd
from prism_lca.engine.report_i18n import chapter_name, normalise

#: Edges of the size classes for a share, by absolute value, in percent.
#:
#: Deliberately coarse. "Dominates" going false is worth a look; 41.2 % becoming 41.3 % is not, and a
#: check that fires on it teaches the author to ignore the badge. Classes rather than a single
#: threshold, because a bare threshold flickers for a value sitting on it.
BAND_EDGES: tuple[float, ...] = (5.0, 20.0, 50.0)

#: Paths whose value is a share and therefore has a size class. Everything else numeric is watched
#: for its sign only — a direction word ("higher", "reduces") flips with the sign, not with the size.
_SHARE_HINTS = ("share_percent", "share_text", "percent")

#: Derivations that return a percentage (mirrors report_data.DERIVATIONS' third field).
_PERCENT_DERIVATIONS = ("percent", "change")


def _sha(payload: Any) -> str:
    return hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:16]


def cited_paths(text: str) -> list[str]:
    """Every data path a chapter's text actually reads, derivation arguments included.

    This is what makes the verdict specific: a chapter is judged against what it cites, not against
    the whole report. ``goal_scope`` cites nothing and can therefore never be stale for numeric
    reasons — which is true, and the old whole-dataset hash said otherwise.
    """
    paths: list[str] = []
    for token in rd.placeholders_in(text):
        if token.startswith("ref:"):
            continue
        if token.endswith(")"):
            _name, _, args = token.partition("(")
            paths.extend(a.strip() for a in args.rstrip(")").split(",") if a.strip())
        else:
            # A `rank:` declaration cites the member it names, so the prefix comes off here too: the
            # rank verdict, the orphan filter and the "no longer resolves" loop all key off this list,
            # and a declaration has to be in it or the very claim it makes would go unchecked.
            paths.append(rd.rank_path(token) or token)
    return sorted(set(paths))


def cited_binding_keys(text: str) -> set[str]:
    """The ranked indices this text reads right now, as ``hotspots.0`` — the keys of its bindings.

    ``report_data.bindings_for`` binds only indices that appear in the text, "a binding for an unused
    index would be noise, and would go stale for no reason". That invariant holds at *writing* time,
    and hand-editing breaks it: a chapter's bindings are only rewritten by the writer and the patch,
    so deleting the sentence that cited the largest process leaves its binding behind. Without this
    filter that orphan keeps reporting "points at something that no longer exists" about a claim the
    chapter no longer makes — a permanent "out of date" badge, and a rewrite of a chapter that is fine.
    """
    keys: set[str] = set()
    for path in cited_paths(text):
        # Every level the path crosses. `contributions.3.groups.0.share_text` cites the indicator *and*
        # the phase inside it, and treating the indicator's pin as orphaned would drop the one finding
        # that reports a deleted indicator (V186).
        for head, index, _rest in rd.ranked_splits(path):
            keys.add(f"{head}.{index}")
    return keys


def _is_share(path: str, data: dict[str, Any], percent_args: set[str]) -> bool:
    """Whether this figure is a share, and therefore has a size class worth watching.

    Two things disqualify a number. It is not a share if the data gives it a **unit**: a U-value in
    W/m2K and a mass in kg are quantities, and sorting them into percentage classes produced
    "parameters.15.amount moved from 20–50 % to <5 % — wording like “dominates” may no longer hold"
    about an element mass (V182). A band nobody can act on is worse than no band: it is the finding
    that teaches an author the badge means nothing.

    And the percent-derivation clause only covers that derivation's **own arguments**. It exists
    because nothing records the band of the *derived* figure, so an argument's band is the only trace
    "X of the total" leaves — but it was read off the whole chapter, so one `percent(…)` anywhere gave
    a size class to every unrelated number the chapter cited. That is where the U-value got its band
    from; the sentence about it contained no derivation at all.
    """
    unit = rd.unit_of(path, data)
    if unit not in (None, "", "%", "share"):
        return False
    return any(hint in path for hint in _SHARE_HINTS) or path in percent_args


def _band(value: float) -> str:
    """Which size class an absolute value falls into, as a label the message can print."""
    magnitude = abs(value)
    if magnitude < BAND_EDGES[0]:
        return f"<{BAND_EDGES[0]:g} %"
    for low, high in zip(BAND_EDGES, BAND_EDGES[1:], strict=False):
        if magnitude < high:
            return f"{low:g}–{high:g} %"
    return f">{BAND_EDGES[-1]:g} %"


def _percentage_arguments(text: str) -> set[str]:
    """The paths this text reads *inside* a derivation that returns a percentage."""
    out: set[str] = set()
    for token in rd.placeholders_in(text):
        if token.endswith(")") and token.partition("(")[0].strip() in _PERCENT_DERIVATIONS:
            out.update(rd.paths_in_token(token))
    return out


def _rank_of(
    head: str,
    identity: dict[str, Any],
    data: dict[str, Any],
    bindings: dict[str, dict[str, Any]] | None = None,
) -> int | None:
    """Where the bound member sits in its ranked list today, or None if it is gone.

    The *list* is resolved through the bindings too, because it may sit behind one: the groups of
    `contributions.3` are the groups of whichever indicator that pin names, not of whatever sits at
    position 3 today. Read positionally, a phase kept a plausible rank inside the wrong indicator's
    breakdown, and the check stayed silent (V186).
    """
    items = rd.bound_lookup(head, data, bindings)
    if not isinstance(items, list):
        return None
    for index, item in enumerate(items):
        if rd.identity_matches(item, identity):
            return index
    return None


def _stable_path(head: str, identity: dict[str, Any] | None, data: dict[str, Any]) -> str | None:
    """A positional path for the bound member that does not move with the ranking, or None.

    Only the variants have one: `results.N.subjects_by_score.M` ranks the same members that
    `subjects` lists in a fixed order, so the member can be cited as `subjects.<i>`. Contribution
    groups and hotspots are ranked lists only; a sentence that must stop claiming their rank has to
    name them in words.
    """
    if not identity or not head.endswith("subjects_by_score"):
        return None
    subjects = data.get("subjects")
    if not isinstance(subjects, list):
        return None
    for index, item in enumerate(subjects):
        if isinstance(item, dict) and rd.identity_matches(item, identity):
            return f"subjects.{index}"
    return None


def _aggregate_cover(text: str, key: str) -> set[int] | None:
    """Which sibling indices this text always folds ``key`` into — None if it ever reads it alone.

    A ranked index is a *subject* of the prose when the text prints its figure. As an operand of a
    fold it is not: ``{{sum(inventory.flows.0.share_percent, …1…, …2…)}}`` says something about the
    three together and nothing about any one of them, least of all about their order. So the set
    returned here is the set a rank may move around inside without touching a word of the chapter.

    None whenever that reading is not available: the path also stands bare somewhere, or the fold
    takes only this one member of its list (``percent(inventory.flows.0.x, study.total)`` folds two
    figures but one member, and "X of the total" is a claim about that member).

    Only the rank check uses this. A *band* on the same operand is not exempt: nothing records the
    band of the derived figure, so the member's own band is the only trace the aggregate's magnitude
    leaves, and exempting it would leave "almost entirely" unwatched.
    """
    head, _, index_text = key.rpartition(".")
    if not index_text.lstrip("-").isdigit():
        return None
    index = int(index_text)
    covered: set[int] | None = None
    for token in rd.placeholders_in(text):
        cited = {s[1] for s in map(rd.ranked_prefix, rd.paths_in_token(token)) if s and s[0] == head}
        if index not in cited:
            continue
        if len(cited) < 2 or not rd.is_aggregate(token):
            return None
        covered = cited if covered is None else covered & cited
    return covered


def _method_label(method: Any) -> str:
    """A stored method as one string, however it was stored.

    The API takes a method as a tuple *or* as one "family / category / indicator" string
    (`deps.MethodRef`), and both end up on the report verbatim. Joining a string character by
    character produced "C / M / L / …" — and the family below would have been "C".
    """
    if isinstance(method, str):
        return method.strip()
    if isinstance(method, (list, tuple)):
        return " / ".join(str(p) for p in method)
    return str(method or "")


def _family_of(method: Any) -> str:
    """Just the family — the first part, on either shape."""
    return _method_label(method).split("/")[0].strip()


def _amount_of(report: dict[str, Any], data: dict[str, Any]) -> float:
    """The multiplier every absolute figure in the document carries.

    Taken from the snapshot first and from the definition only as a fallback: `data` is what the
    printed numbers were actually computed with, a render request's override included, and this
    record has to answer for the numbers in the text rather than for the field's current value.
    """
    for value in (data.get("amount"), report.get("amount")):
        try:
            return round(float(value), 10)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
    return 1.0


def selection_of(report: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    """What the prose states in words, rather than through a placeholder.

    A method family, a scenario label, the functional unit: the gate deliberately allows these as
    literal text, because a designation does not go stale when the model is recomputed. It goes
    stale when the *selection* changes, and nothing checked that until now.

    The same is true of two settings that never appear in the prose as themselves and are all over it
    in words: the **amount**, which every absolute figure is multiplied by ("every figure below refers
    to one window element"), and the **significance threshold**, which chapters quote as a number
    ("below the 5 % threshold this report treats as a difference"). Neither has a placeholder to
    resolve them, so neither can heal itself.
    """
    methods = [_method_label(m) for m in (report.get("methods") or [])]
    subjects = [
        str(s.get("scenario_name") or s.get("label") or s.get("code") or "")
        for s in (report.get("subjects") or [])
    ]
    study = data.get("study") or {}
    activity = data.get("activity") or {}
    first_subject = (report.get("subjects") or [{}])[0]
    return {
        "methods": sorted(methods),
        "subjects": sorted(x for x in subjects if x),
        # The reference process by code, because the subject labels above cannot see it: every variant
        # of a report carries the *same* code and differs only by its scenario, so switching the
        # process leaves "Baseline" and every scenario name exactly where they were.
        "reference": str(activity.get("code") or first_subject.get("code") or ""),
        # Display only, deliberately not compared: a dataset that was renamed is still the same
        # dataset, and condemning a chapter for a rename would be a verdict about nothing. The name is
        # kept so the message can say *which* process instead of quoting a code at the author.
        "reference_name": str(activity.get("name") or ""),
        "functional_unit": str(study.get("functional_unit") or ""),
        "amount": _amount_of(report, data),
        "aggregate_by": str(report.get("aggregate_by") or ""),
        # Normalised through the one reading everybody uses, so an unset option and an explicit 5 %
        # are the same selection — otherwise clearing the field would report a change nobody made.
        "significance_percent": report_claims.weak_percent(report.get("options")),
        "lang": str(report.get("lang") or "en"),
    }


#: The rankings a chapter may claim a top place in without citing them — the report's own, the ones
#: every chapter's prose can be about ("the dominant group", "the largest process").
#:
#: The per-indicator siblings (`contributions.*.groups` and friends) are deliberately not in here.
#: Five indicators × their phases re-rank on every recompute, and a sentence that names no figure
#: cannot be attributed to one of them — recording all of them would turn "some ranking moved" into a
#: permanent state and the remark into noise. Where a chapter *does* cite one, `leaders_of` records it
#: for that chapter, which is the only case in which the attribution is honest.
PRIMARY_RANKED: tuple[str, ...] = tuple(sorted(h for h in rd.MAGNITUDE_RANKED if "*" not in h))


#: One word list needs one matcher, so the fold lives beside the lists it folds and this rule borrows
#: it (V208). It started here, for the laxer reading this rule needs; then the same hole turned out to
#: be in the write-time rule as well — `\bdomine\w{0,2}\b` never matched *dominé* there either — and a
#: second copy would have been two answers to one question.
_folded = report_claims.folded
_fold = report_claims.fold


#: What a member is *called*. One question, one answer: this rule started here for a message and is now
#: also what a `{{rank:…}}` declaration prints into the document, and two copies would eventually name
#: the same member two ways in the same report — the drift `_folded` was consolidated to avoid (V208).
_member_label = rd.member_label


def _leader_of(
    head: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None = None
) -> dict[str, Any] | None:
    """Which member leads this ranking today — None where the list is empty or gone.

    Through the bindings like every other lookup here: the groups of `contributions.3` are the groups
    of whichever indicator that pin names (V186).
    """
    items = rd.bound_lookup(head, data, bindings)
    if not isinstance(items, list) or not items:
        return None
    return rd.identity_of(items[0], rd.identity_fields(head)) or None


def leaders_of(
    text: str, bindings: dict[str, dict[str, Any]] | None, data: dict[str, Any]
) -> dict[str, Any]:
    """Who led each size-ordered ranking when this chapter was written.

    The one part of the record that is deliberately *not* limited to what the chapter cites. Everything
    else here is: a chapter is judged against its own placeholders, and that is what makes the verdicts
    specific. But a claim to the top can be made in words alone — "l'emballage, premier poste", "le
    groupe prépondérant" — and then there is no citation to judge it by. Such a sentence is invisible to
    every check that works by matching a path or a spelled-out member name, and the group labels are
    deliberately untranslated (`contribution.groups` is pinned by its `key`), so a report written in
    French states the claim in words the identifier never contains.

    Measured on a mould-remover report (V206): the distribution distance went from
    1 200 to 12 000 km, Distribution took first place from Packaging, five chapters were flagged and
    corrected, and two sentences survived the whole round — the executive summary's "dominé par
    l'emballage, premier poste devant la distribution" and, three paragraphs below a dominance sentence
    the correction *did* soften, "le groupe prépondérant, l'emballage". Both were wrong, both went into
    the delivered PDF, and the only difference from the sentence that was repaired is that the repaired
    one stood next to a placeholder.

    So the record keeps the leaders themselves. Then "did the ranking flip" is a question about the
    report, answerable for a chapter that cites nothing at all.
    """
    heads = set(PRIMARY_RANKED)
    for path in cited_paths(text):
        heads.update(h for h, _index, _rest in rd.ranked_splits(path) if rd.is_magnitude_ranked(h))
    out: dict[str, Any] = {}
    for head in sorted(heads):
        leader = _leader_of(head, data, bindings)
        if leader:
            out[head] = leader
    return out


def _leader_change(head: str, was: dict[str, Any], data: dict[str, Any], bindings) -> str:
    """"`head` is now led by A, not B" — and never "led by A, not A".

    Two members can share a display name: `inventory.flows` carries "Carbon dioxide, fossil" once per
    compartment, and a real report (run 21) produced the sentence *"inventory.flows is now led by Carbon
    dioxide, fossil, not Carbon dioxide, fossil"*, which tells the author nothing at all. The label is
    not the identity — the lesson of V203, here inside a message — so where the two labels match, the
    identity is what has to be spelled out instead.
    """
    now = _leader_of(head, data, bindings) or {}
    label_now, label_was = _member_label(now), _member_label(was)
    if label_now != label_was:
        return f"{head} is now led by {label_now}, not {label_was}"
    # Same name, different member. `describe_identity` prints the fields that actually differ, which is
    # the only thing that can tell the two apart on the page.
    return (
        f"{head} is now led by another member with the same name, {label_now} "
        f"({rd.describe_identity(now)} instead of {rd.describe_identity(was)})"
    )


def _flipped_leaders(
    bindings: dict[str, dict[str, Any]], data: dict[str, Any], stored: dict[str, Any]
) -> dict[str, Any]:
    """Rankings whose top member changed since this chapter was written → what led back then.

    A *flip*, not any movement. "The numbers moved" asks for nothing and a remark that appears every
    time carries no information (the reason written on `_CAUSAL` in `report_claims`), and a swap of
    ranks 2 and 3 falsifies nothing anybody calls dominance. Only the first place changing hands does.

    Two sources, one meaning. A record that carries `leaders` answers directly. A record written before
    that field existed answers through its own ranks: a cited member stored at rank 0 *was* the leader,
    so if it is not the leader today the ranking flipped and the record even knows who led. That
    fallback is what makes the check work on the reports already on disk; its limit is the one every
    transitional rule here has — it sees only the lists the chapter cites, and only a flip in which the
    chapter's own pinned member lost the lead.
    """

    def flipped(head: str, was: Any) -> bool:
        # A leader this snapshot cannot name is not a flip anybody can report: an empty list is the
        # members check's business, and a member with no identity left would produce a verdict with a
        # blank where the name belongs. `identity_matches` rather than equality, so a record written
        # with fewer identity fields still recognises its own member.
        now = _leader_of(head, data, bindings)
        return bool(isinstance(was, dict) and was and now and not rd.identity_matches(now, was))

    out: dict[str, Any] = {}
    recorded = stored.get("leaders")
    if isinstance(recorded, dict):
        return {str(head): was for head, was in recorded.items() if flipped(str(head), was)}
    for key, was_rank in (stored.get("ranks") or {}).items():
        if was_rank != 0:
            continue
        head, _, _index = str(key).rpartition(".")
        was = (bindings or {}).get(key)
        if head not in out and rd.is_magnitude_ranked(head) and flipped(head, was):
            out[head] = was
    return out


def _anchored(sentence: str) -> bool:
    """Does this sentence cite a size-ordered list at all?

    Where it does, the claim is somebody else's already: the write-time superlative rule reads the
    figure the word stands next to and settles arithmetically whether "dominates" is attributed to the
    member that leads (V175, `report_claims._superlative_subjects`), and the store refuses the chapter
    while it is not. The rule below is for the sentences that rule cannot see — the ones with no figure
    in them, where there is nothing to attribute the word to and nothing to check it against.
    """
    for token in rd.placeholders_in(sentence):
        for path in rd.paths_in_token(token):
            if any(rd.is_magnitude_ranked(head) for head, _index, _rest in rd.ranked_splits(path)):
                return True
    return False


def unanchored_claims(text: str, lang: str) -> list[tuple[str, str]]:
    """(sentence, the word it uses — as written) for every sentence claiming a top rank alone.

    The vocabulary is `report_claims._SUPERLATIVES` and the disarming ordinals are its `_ORDINALS` —
    the same lists the write-time rule judges by, because this is that rule's question asked at the
    other moment, and two word lists would drift into two different answers. The matching is that
    rule's too, down to the fold (`_folded`): what differs between the two is only which sentences
    they look at — the ones with a figure in them, and the ones without.

    An ordinal disarms the sentence, as it does at write time: "le deuxième poste le plus important" is
    a statement about rank 2 and the natural way to write it — through the same matcher too
    (`_disarming_ordinal`), because an ordinal read one way here and another way there is the drift
    this docstring promises not to have.
    """
    code = normalise(lang)
    words = report_claims._SUPERLATIVES.get(code, report_claims._SUPERLATIVES["en"])
    ordinals = report_claims._ORDINALS.get(code, report_claims._ORDINALS["en"])
    comparative = report_claims._COMPARATIVE_SUPERLATIVES.get(code, ())
    than = report_claims._THAN.get(code, report_claims._THAN["en"])
    out: list[tuple[str, str]] = []
    for raw in report_sentences.sentences(text):
        sentence = raw.strip()
        if not sentence:
            continue
        low, place = _folded(sentence)
        # The same exemption the write-time rule makes (V210/V211), for the same reason and by the same
        # test: in French, Spanish and Portuguese "plus grand" is both the comparative and half of the
        # superlative, so "A est plus grand que B" is a statement about two numbers and not a claim to
        # the top. It is excused only where the *matched* word is one of those — a sentence that
        # compares and also says "domine" still claims the top, and that claim is the one worth naming.
        compares = any(re.search(rf"\b{re.escape(_fold(w))}\b", low) for w in than)
        hit = None
        for word in words:
            if compares and word in comparative:
                continue
            found = re.search(rf"\b{re.escape(_fold(word))}\w{{0,2}}\b", low)
            if found:
                # As the chapter spells it, not as the list does.
                hit = sentence[place[found.start()] : place[found.end() - 1] + 1]
                break
        if hit is None or _anchored(sentence):
            continue
        if report_claims._disarming_ordinal(ordinals, words, low, code):
            continue
        out.append((sentence, hit))
    return out


def components(
    text: str, bindings: dict[str, dict[str, Any]] | None, report: dict[str, Any], data: dict[str, Any]
) -> dict[str, Any]:
    """The record stored with a chapter, against which a later state is compared.

    ``text`` is the chapter text for ``based_on`` and the joined figure captions (`captions_text`) for
    ``caption_based_on`` — two records, because a text write must not re-stamp a caption.

    Only ``values`` is a hash. Bands, ranks and the selection are stored as themselves: a verdict has
    to be able to say *"from >50 % to 5–20 %"*, and a hash can only ever say "different".
    """
    bindings = bindings or {}
    percent_args = _percentage_arguments(text)

    values: dict[str, float] = {}
    bands: dict[str, dict[str, Any]] = {}
    for path in cited_paths(text):
        number = rd.numeric(rd.bound_lookup(path, data, bindings))
        if number is None and path.endswith(".share_text"):
            # `share_text` is the formatted twin of `share_percent` — the form the prose is told to
            # use — and a string has no band. Read the number off its sibling, or the one placeholder
            # the writer is steered to was the one nothing watched.
            sibling = path[: -len("share_text")] + "share_percent"
            number = rd.numeric(rd.bound_lookup(sibling, data, bindings))
        if number is None:
            continue
        values[path] = round(number, 10)
        entry: dict[str, Any] = {"sign": 0 if number == 0 else (1 if number > 0 else -1)}
        if _is_share(path, data, percent_args):
            entry["band"] = _band(number)
        bands[path] = entry
    # The RESULT of a derivation, not only its arguments: `change(a, b)` keeps both arguments positive
    # while the difference flips sign when they swap order — and "A is higher than B" stood with no
    # verdict. Keyed by the token itself; `_offsets_of_path` matches a whole token, so a
    # correction can locate the sentence.
    for token in rd.placeholders_in(text):
        if not token.endswith(")"):
            continue
        result, error = rd.derive_value(token, data, bindings)
        if error or result is None:
            continue
        values[token] = round(result, 10)
        bands[token] = {"sign": 0 if result == 0 else (1 if result > 0 else -1)}

    ranks: dict[str, int] = {}
    cited = cited_binding_keys(text)
    for key, identity in bindings.items():
        if key not in cited:
            continue  # an orphaned binding is not something this text can be wrong about
        head, _, index = key.rpartition(".")
        if not rd.is_magnitude_ranked(head):
            # `results`, `subjects`, `parameters`, `scenarios`, `foreground` and `background_datasets`
            # are structure-ordered: a reorder of the report's subject list is not a rank change, and
            # recording one produced "'the largest' may no longer be true" findings about a list that
            # never expressed size. A parameter moves for a reason emptier still — someone added one
            # whose name sorts earlier, or renamed a scenario ahead of it — and the binding above has
            # already put the sentence back on its own member.
            continue
        rank = _rank_of(head, identity, data, bindings)
        if rank is not None:
            ranks[key] = rank

    selection = selection_of(report, data)
    if any(p == "first_result" or p == "results.0" or p.startswith(("first_result.", "results.0.")) for p in cited_paths(text)):
        # The method list is compared as a set, so reordering it is no selection change — except for a
        # chapter that cites the FIRST indicator: `results.0` and `first_result` then mean another
        # method, and its number printed under the old unit. Recorded only where cited, so
        # a goal-and-scope chapter is not condemned for an order it never relied on.
        methods = report.get("methods") or []
        selection["lead_method"] = _method_label(methods[0]) if methods else ""
    return {
        "values": _sha(sorted(values.items())),
        "bands": bands,
        "ranks": ranks,
        "selection": selection,
        "leaders": leaders_of(text, bindings, data),
    }


#: Study texts a chapter draws on in words rather than through a placeholder — the ones a critical review
#: asks about, and the ones whose change makes "the system ends at the factory gate" wrong without any
#: number moving. The functional unit and the language are in `selection_of` already.
STUDY_SOURCE_FIELDS: tuple[str, ...] = (
    "goal",
    "scope",
    "geography",
    "reference_year",
    "system_boundaries",
    "cutoff_criteria",
    "allocation",
    "system_allocation",
    "limitations",
    "data_quality",
    "critical_review",
)


def _dataset_fingerprint(database: str | None, code: str | None) -> str | None:
    """What a `get_process_details` lookup can have told the writer, as one hash — None if unreadable."""
    if not database or not code:
        return None
    try:
        from prism_lca.engine.model import get_activity

        act = get_activity(str(database), str(code))
        return _sha(
            [act.get(k) for k in ("name", "unit", "location", "reference product", "comment", "classifications")]
        )
    except Exception:  # noqa: BLE001 — a dataset this cannot read is a source this cannot watch
        return None


def sources_of(
    section: dict[str, Any], report: dict[str, Any], data: dict[str, Any], lookups: Any = None
) -> dict[str, Any]:
    """The TEXTS a chapter drew on, fingerprinted: study prose, looked-up datasets, sibling chapters.

    `components` records what a chapter cites — numbers, bands, ranks, the selection. It never recorded
    what the chapter *read*: the system boundaries it describes, the dataset documentation a lookup
    handed it, the chapters a summary summarises. All three could change under a chapter with no verdict.
    Stored beside the record; compared by `_judge`.
    """
    import json

    study = data.get("study") or {}
    fields = {
        k: _sha(study.get(k)) for k in STUDY_SOURCE_FIELDS if study.get(k) not in (None, "", [], {})
    }
    # The exchange notes, where the chapter is shown them: a reason rewritten under it is a source changed —
    # recorded when there are none too, so the first note added under the chapter counts as a change.
    if section.get("kind") in report_prompts._SPECIALIST_FACTS["exchange_notes"]:
        fields["exchange_notes"] = _sha(report_prompts.exchange_notes(data))
    datasets: dict[str, str] = {}
    for lookup in lookups or []:
        if not isinstance(lookup, dict) or lookup.get("name") != "get_process_details":
            continue
        try:
            args = json.loads(lookup.get("args") or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(args, dict):
            continue
        database = args.get("database") or (data.get("activity") or {}).get("database")
        codes = [args["code"]] if args.get("code") else list(args.get("codes") or [])
        for code in codes:
            fingerprint = _dataset_fingerprint(database, code)
            if fingerprint:
                datasets[f"{database}:{code}"] = fingerprint
    siblings: dict[str, str] = {}
    if section.get("kind") in report_prompts._SUMMARISING:
        for other in report.get("sections") or []:
            if other.get("id") == section.get("id") or other.get("kind") not in report_prompts._WORTH_READING:
                continue
            text = str(other.get("text") or "").strip()
            if text:
                siblings[str(other.get("id"))] = written_fingerprint(other)
    return {"study": fields, "datasets": datasets, "siblings": siblings}


def written_fingerprint(section: dict[str, Any]) -> str:
    """The sibling fingerprint a summary records — the text as it was last WRITTEN, not last corrected.

    An earlier version hashed the sibling's current text, so every accepted correction in a source chapter
    (one verb softened, one superlative dropped) made the summary and the conclusions stale again,
    and the loop never closed: on the Silikon report four rounds of Correct all ended at the same
    "4 to check" (V423). A correction keeps the chapter's claims — the gate verified the
    corrected text against the same data — so the chapters written from it have nothing new to
    read. `written_sha` is set by the writer's store and by a hand edit of the text and left alone
    by the patch route; a chapter without it (stored by an older version) falls back to its text.
    """
    return str(section.get("written_sha") or _sha(str(section.get("text") or "").strip()))


def with_sources(
    record: dict[str, Any], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any], lookups: Any = None
) -> dict[str, Any]:
    """`components(…)` plus the sources — what every store of a text record writes."""
    return {**record, "sources": sources_of(section, report, data, lookups)}


def keep_stale(
    fresh: dict[str, Any], stored: Any, unaddressed: list[dict[str, Any]]
) -> dict[str, Any]:
    """A fresh record with the entries of the findings nobody answered rolled back to the old ones.

    A correction re-stamps the chapter, and that is right for the sentences it changed. For the ones it
    left alone it is a lie: the rank still moved, the share still left its class, and declaring the
    record current buries the finding for good. In an apple-juice run one round of
    corrections took a chapter from five findings to none while five false sentences stayed in the
    document — two of them contradicting the corrected sentence in the next line (V162).

    Only the entries a finding names are rolled back, and only the kinds a record can carry: a band and
    a rank live under their path, the method selection is one value for the chapter, and a wording
    finding names the rankings whose lead changed under it. `values` is deliberately refreshed either
    way — "the numbers moved" asks for nothing and would otherwise report itself forever.
    """
    if not isinstance(stored, dict) or not unaddressed:
        return fresh
    out = {
        **fresh,
        "bands": dict(fresh.get("bands") or {}),
        "ranks": dict(fresh.get("ranks") or {}),
        "leaders": dict(fresh.get("leaders") or {}),
    }
    old_bands = stored.get("bands") or {}
    old_ranks = stored.get("ranks") or {}
    for finding in unaddressed:
        kind, path = finding.get("kind"), str(finding.get("path") or "")
        if kind == "bands" and path in old_bands:
            out["bands"][path] = old_bands[path]
        elif kind == "ranks" and path in old_ranks:
            out["ranks"][path] = old_ranks[path]
        elif kind == "selection" and "selection" in stored:
            out["selection"] = stored["selection"]
        elif kind == "wording":
            # The finding carries the leaders it was raised against — from the record or, on a record
            # written before the field existed, reconstructed from its ranks. Keeping them is what makes
            # the second dominance sentence survive a round that only repaired the first one: the
            # correction re-stamps the chapter, and a fresh record would say the ranking never moved
            # (V162's lesson, V206's case).
            out["leaders"] = {**out["leaders"], **(finding.get("was") or {})}
        elif kind == "sources" and isinstance(stored.get("sources"), dict):
            # A patch elsewhere in the chapter must not re-stamp the study text or the sibling the
            # finding is about — the same lesson as the bands and ranks above.
            old_sources = stored["sources"]
            new_sources = dict(out.get("sources") or {})
            if path.startswith("study."):
                study_fields = dict(new_sources.get("study") or {})
                if path[6:] in (old_sources.get("study") or {}):
                    study_fields[path[6:]] = old_sources["study"][path[6:]]
                new_sources["study"] = study_fields
            elif finding.get("source") in ("datasets", "siblings"):
                new_sources[finding["source"]] = old_sources.get(finding["source"]) or {}
            out["sources"] = new_sources
    return out


def _number(value: Any) -> str:
    """A stored setting as the author typed it — 1, 10, 0.5 — not as a float repr."""
    try:
        return f"{float(value):g}"  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "none"


def _selection_message(old: dict[str, Any], new: dict[str, Any]) -> str | None:
    """Name the first field that moved, in the words the author will recognise.

    The dict below is the comparison itself, not decoration: it decides which fields are compared at
    all — `reference_name` is in the record and not in here, so a rename is never a verdict — and in
    which order, because one message is reported per chapter. Most specific cause first, so switching
    the reference process is not reported as a changed language.
    """
    labels = {
        "methods": "impact methods",
        "lead_method": "leading indicator",
        "subjects": "subjects",
        "reference": "reference process",
        "functional_unit": "functional unit",
        "amount": "amount",
        "aggregate_by": "contribution breakdown",
        "significance_percent": "significance threshold",
        "lang": "language",
    }

    def show(value: Any) -> str:
        if isinstance(value, list):
            return ", ".join(str(v) for v in value) or "none"
        return str(value) or "none"

    for field, label in labels.items():
        if field not in old:
            # A record written before this field was watched cannot answer for it. Compared anyway, an
            # absent value differs from every real one — which would have condemned every chapter of
            # every report on disk the moment a field was added, with a verdict ("written for an
            # amount of none") that is wrong about a change that never happened.
            continue
        if field not in new:
            # …and the same the other way: a record that no longer watches a field (a chapter that
            # stopped citing the first indicator) says nothing about it — "now uses none" is no change.
            continue
        before, after = old.get(field), new.get(field)
        if before == after:
            continue
        if field == "reference":
            # By name on both sides: the code is what makes the comparison honest, the name is what
            # makes the verdict readable.
            was = str(old.get("reference_name") or before or "")
            now = str(new.get("reference_name") or after or "")
            return f"written for reference process {show(was)}; the report now uses {show(now)}"
        if field == "amount":
            # Spelled out rather than left to the generic sentence, because this one field is not a
            # designation the author can rename: the amount multiplies every absolute figure, so the
            # numbers are all *correct* and the sentences around them ("per window element") are all
            # wrong. Naming the functional unit says what the amount counts — 696 kg CO2-Eq became
            # 6,955 with four chapters still claiming one element (V195).
            unit = str(new.get("functional_unit") or old.get("functional_unit") or "").strip()
            counts = f" (functional unit: {unit.rstrip('.')})" if unit else ""
            return (
                f"written for an amount of {_number(before)}{counts}; the report now computes "
                f"{_number(after)} — every absolute figure is multiplied by it, only the shares are "
                "unaffected"
            )
        if field == "significance_percent":
            return (
                f"written against a significance threshold of {_number(before)} %; the report now uses "
                f"{_number(after)} % — a chapter that names the old figure, or calls a difference too "
                "small to report, is measuring by a rule this report no longer applies"
            )
        return f"written for {label} {show(before)}; the report now uses {show(after)}"
    return None


def method_families_in_prose(
    text: str, report: dict[str, Any], known: list[str], based_on: dict[str, Any] | None = None
) -> list[str]:
    """Method families a chapter names although the report no longer uses them.

    With a stored ``based_on.selection``, only the families the chapter was *written under* are
    candidates: those are the ones its prose legitimately spelled out, and the ones that go wrong
    when the selection moves. Matching against every family registered in the project condemned
    ordinary vocabulary permanently — "IPCC 2021" as the stated factor source of an EF study, the
    plain phrase "cumulative energy demand" — with a rewrite badge from the moment the chapter was
    written. Whether a *fresh* chapter names a method it should not is the gate's question, not this
    one's; this asks whether the world moved under the text.

    Chapters without a stored selection keep the full scan — the transitional rule: their prose still
    spells the family out, and a name that is not in the current selection is wrong no matter when it
    was written.
    """
    selected = {f for f in (_family_of(m) for m in (report.get("methods") or [])) if f}
    if based_on is not None:
        stored_labels = [str(m) for m in (based_on.get("selection") or {}).get("methods") or []]
        if stored_labels:
            known = [f for f in known if any(label.startswith(f) for label in stored_labels)]
    hits = []
    for family in known:
        if family in selected or not family:
            continue
        # The root name of a selected family, with the variant said elsewhere in the text, is that
        # family said short: "from IPCC 2013 … both are the no LT variants" in a report on "IPCC 2013
        # no LT". Counting it condemned a freshly written Methods chapter to "rewrite" on every check.
        # Without the variant anywhere in the text the root name still counts — "CML v4.8 2016, which
        # includes long-term emissions" names the other family, and that is the error this catches.
        lowered = text.lower()
        if any(
            name.startswith(f"{family} ") and name[len(family) + 1 :].strip().lower() in lowered
            for name in selected
        ):
            continue
        for match in re.finditer(rf"(?<![\w]){re.escape(family)}(?![\w])", text):
            # A family name can be the *prefix* of a sibling: ecoinvent ships "CML v4.8 2016" and
            # "CML v4.8 2016 no LT" as two families, and the word boundary after "2016" is a space, so
            # prose naming the selected one contains the other one whole. Unguarded, a report on
            # "CML v4.8 2016 no LT" condemned every chapter that named its own method — permanently,
            # from the moment it was written, which is exactly what it looked like.
            #
            # A hit therefore only counts where no *selected* family starts in the same place. The
            # reverse mix-up (report on the short name, prose naming the long variant) is let through
            # by the same rule; that is the cheaper mistake by far — a missed finding costs a
            # re-read, a false one costs the badge its meaning.
            if any(text.startswith(name, match.start()) for name in selected):
                continue
            hits.append(family)
            break
    return sorted(set(hits))


#: Table labels this check refuses to judge, because the stored report does not decide them.
#:
#: One entry. The glossary's table is printed for the acronyms the *finished blocks* use
#: (`report_render._acronyms_used`), so a stored glossary whose terms have all left the document prints
#: a note and no table. `report_prompts.renders_for` can only read the stored list, which it states as
#: an honest approximation — and approximate is enough to *accept* a reference and too little to
#: *refuse* one. A glossary that is stored but not yet filled is a normal stage of writing a report; a
#: rewrite badge sitting on a chapter through it would be the permanent, unclearable bar V190 is about.
#: The export knows the blocks, so that case stays the export's.
_UNJUDGED_TABLES = frozenset({"t-abbreviations"})


def _printed_tables(report: dict[str, Any], data: dict[str, Any]) -> set[str] | None:
    """Which tables this report will print — or ``None`` where this snapshot cannot say.

    `report_prompts.document_labels` is the authority on what the document contains, and since V197 it
    mirrors the renderer label for label (a guard test holds the two sides equal). Refusing a reference
    needs more than completeness, though: it needs the authority to never be *narrower* than the
    renderer, because that is the direction that hangs a rewrite badge on a reference the PDF resolves
    perfectly — the mistake V197 had to undo, and the one V190 says costs more than the gap it reports.

    Compared shape by shape against the renderer's own labels (28 report shapes: chapters deleted,
    parts switched off, no scenarios, no health, no sources, hidden indicators, an empty glossary), the
    authority is never narrower except in two, and both are named here rather than trusted:

    * **No results.** The results table is labelled whatever its row count (`report_typst.lcia_blocks`),
      while every condition in the authority that mentions an indicator is switched off — so a report
      that computed nothing would report `t-lcia` as a gap the document actually prints.
    * **No `checks` summary.** The three ISO §4.5 tables are drawn from the data, not from the summary,
      so without it they are printed and not listed. `report_data` builds the summary into every
      snapshot, which makes this half an invariant rather than a case — stated because relying on an
      invariant silently is how the authority drifted the first time.
    """
    if not (data.get("results") and data.get("checks")):
        return None
    return {label for label in report_prompts.document_labels(report, data) if label.startswith("t-")}


def _dead_reference(label: str, report: dict[str, Any], tables: set[str] | None) -> bool:
    """Whether this cross-reference is certainly a gap in the printed document.

    Two causes, both certain from the stored report: a comparison figure whose box is cleared, and a
    table no chapter of this report prints any more — the case a deleted chapter leaves behind. Figures
    beyond the switchable two are not asked about: which of them the document carries is decided at
    export time by the charts the renderer hands over (`blocks_for` draws a figure only for an SVG it
    was given), so nothing here can tell a deleted chapter's figure from one this render simply did not
    draw. The export sees the blocks and keeps that half.
    """
    if report_prompts.switched_off_figure(label, report):
        return True
    if tables is None or not label.startswith("t-") or label in _UNJUDGED_TABLES:
        return False
    return label not in tables


def captions_text(section: dict[str, Any]) -> str:
    """A chapter's figure captions as one text, for pinning and recording them."""
    return "\n\n".join(rd.captions_of(section))


def caption_state(section: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], Any]:
    """The captions' pins and the record they are judged against — their own, or the legacy ones.

    A chapter stored before captions had a namespace of their own carries its caption
    pins in the shared `bindings` and their ranks in the shared `based_on`. That IS the caption's
    baseline: it is what the caption was written against, and rebuilding one from today's data would
    re-point it and clear every finding it has. So a chapter without `caption_bindings` is read
    through those — the pins restricted to the keys a caption cites — until a write materialises them
    (`caption_migration`).
    """
    if "caption_bindings" in section:
        return dict(section.get("caption_bindings") or {}), section.get("caption_based_on")
    cited = cited_binding_keys(captions_text(section))
    pins = {k: v for k, v in (section.get("bindings") or {}).items() if k in cited}
    return pins, _caption_baseline(section.get("based_on"), captions_text(section))


def _cites_first_result(text: str) -> bool:
    return any(
        p == "first_result" or p == "results.0" or p.startswith(("first_result.", "results.0."))
        for p in cited_paths(text)
    )


def _caption_baseline(record: Any, captions: str) -> Any:
    """A shared legacy record cut down to what the captions themselves cite.

    The shared `based_on` also answers for the text: a text citing `{{first_result.score}}` recorded
    `lead_method`, and a caption reading "The life cycle phases." then inherited it and was told it
    was "written for t / gwp; the report now uses none" with nothing changed. Bands and ranks only for
    the caption's own paths and keys, `lead_method` only where a caption reads the first indicator.
    """
    if not isinstance(record, dict):
        return record
    paths = set(cited_paths(captions)) | set(rd.placeholders_in(captions))
    keys = cited_binding_keys(captions)
    out = {
        **record,
        "bands": {k: v for k, v in (record.get("bands") or {}).items() if k in paths},
        "ranks": {k: v for k, v in (record.get("ranks") or {}).items() if k in keys},
    }
    selection = record.get("selection")
    if isinstance(selection, dict) and "lead_method" in selection and not _cites_first_result(captions):
        out["selection"] = {k: v for k, v in selection.items() if k != "lead_method"}
    return out


def caption_bindings(section: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The pins a chapter's captions resolve through (`caption_state`)."""
    return caption_state(section)[0]


def caption_migration(section: dict[str, Any]) -> dict[str, Any]:
    """The caption half of a legacy chapter, written out — for every write to a chapter.

    Every write that replaces `bindings` (a proposal, a patch, a hand edit, a rebinding) would
    otherwise take the legacy caption pins with it: the text keeps only the keys IT cites, so
    "Packaging: {{contribution.groups.0.share_text}}" fell back to position 0 and printed Transport's
    share with no finding. Empty once the chapter has its own caption fields, or no caption cites
    anything.
    """
    if "caption_bindings" in section or not captions_text(section).strip():
        return {}
    pins, record = caption_state(section)
    return {"caption_bindings": pins, "caption_based_on": record}


#: What a caption can be judged for. The method families and the values hash are one fact about the
#: chapter and are reported by the text's judgement; the selection is judged against the caption's own
#: baseline (a caption alone may cite `first_result`), and only an identical message is merged.
_CAPTION_KINDS = ("members", "bands", "ranks", "selection")


def caption_verdicts(section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> list[dict[str, Any]]:
    """What changed under the chapter's figure captions — its own record, its own findings.

    A caption resolves placeholders like prose, so it goes stale like prose; but it is not a sentence a
    text correction can reach, and a text rewrite answers nothing it claims. So it is judged against
    its own baseline (`caption_state`), and every finding says where it sits (`in: caption`), also
    where text and caption cite the same path — they are two claims.
    """
    joined = captions_text(section).strip()
    if not joined:
        return []
    pins, stored = caption_state(section)
    found = _judge(joined, "", pins, stored, report, data, None)
    return [
        {**f, "in": "caption", "raw": f["message"], "message": f"a figure caption {f['message']}"}
        for f in found
        if f.get("kind") in _CAPTION_KINDS
    ]


def verdicts(
    section: dict[str, Any],
    report: dict[str, Any],
    data: dict[str, Any],
    known_families: list[str] | None = None,
) -> list[dict[str, Any]]:
    """What changed under this chapter, and what each change costs to put right.

    ``severity`` is the remedy, not a mood: ``none`` means the placeholders already handle it,
    ``review`` means a sentence should be read, ``rewrite`` means the text asserts something that is
    no longer true. The text and the figure captions are judged separately (`caption_verdicts`).
    """
    text = (section.get("text") or "").strip()
    found = (
        _judge(
            text, text, section.get("bindings") or {}, section.get("based_on"), report, data, known_families,
            section=section,
        )
        if text
        else []
    )
    # Merged only after both judgements: a selection change the text already reports is one fact, and
    # the caption's copy goes; one the caption alone sees (it alone cites the first indicator) stays.
    said = {(f.get("kind"), f.get("message")) for f in found}
    captions = [
        {k: v for k, v in f.items() if k != "raw"}
        for f in caption_verdicts(section, report, data)
        if not (f["kind"] == "selection" and (f["kind"], f["raw"]) in said)
    ]
    return found + captions + report_typed_numbers.verdicts(section, data)


def _judge(  # noqa: C901 — the verdict per kind of finding is one decision table; splitting it hides the table
    text: str,
    words: str,
    bindings: dict[str, dict[str, Any]],
    stored: Any,
    report: dict[str, Any],
    data: dict[str, Any],
    known_families: list[str] | None,
    section: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """`verdicts` for one cited text against one record. `words` is what the sentence-level wording
    check reads — the text itself, or nothing for captions (a caption is not a correctable sentence).
    `section` is the chapter whose sources are compared; captions pass none."""
    current = components(text, bindings, report, data)
    found: list[dict[str, Any]] = []

    # A vanished binding needs no stored record: the binding itself is the claim, and the data
    # either still contains that member or it does not. Only for a binding the text still reads,
    # though — see `cited_binding_keys`.
    cited = cited_binding_keys(text)
    gone: list[str] = []
    # Sorted so an outer key comes before the keys nested inside it — `contributions.3` sorts ahead of
    # `contributions.3.groups.0` — which is what lets the loop below name a loss once.
    for key in sorted(bindings):
        identity = bindings[key]
        if key not in cited:
            continue
        head, _, _index = key.rpartition(".")
        if _rank_of(head, identity, data, bindings) is None:
            # A deleted indicator takes its own breakdown with it. Reporting the phases as well would
            # say the same loss five more times, in the vocabulary of the wrong list ("key=Packaging"
            # for a report that lost land use), and the author would read the noise instead of the fact.
            if any(key.startswith(f"{parent}.") for parent in gone):
                continue
            gone.append(key)
            shown = rd.describe_identity(identity)
            found.append(
                {
                    "kind": "members",
                    "severity": "rewrite",
                    "path": key,
                    "message": f"points at something that no longer exists ({shown}) — it renders as "
                               "“[missing: …]”",
                }
            )

    # A cited path that no longer resolves is a hole in the deliverable, not a "the numbers moved".
    # Only the bound ranked keys used to be checked; a vanished `checks.sensitivity.0.spread_percent`
    # (deleted scenario) fell out of the values hash and was reported as remedy "none" while the PDF
    # printed "[missing: …]". Pure arithmetic: resolve each cited path once. Paths whose ranked key
    # already produced a members finding above are skipped — one problem, one report.
    reported = {f["path"] for f in found if "path" in f}
    for path in cited_paths(text):
        # Any level of the path, not only the innermost: the hole a deleted indicator leaves is
        # reported against the indicator's key, and the phase path underneath it is the same hole.
        if any(f"{head}.{index}" in reported for head, index, _rest in rd.ranked_splits(path)):
            continue
        try:
            float(path.replace(",", "."))
            continue  # a numeric derivation constant, not a path
        except ValueError:
            pass
        if rd.bound_lookup(path, data, bindings) is None:
            found.append(
                {
                    "kind": "members",
                    "severity": "rewrite",
                    "path": path,
                    "message": f"cites {path}, which no longer resolves — it renders as “[missing: …]”",
                }
            )

    # A cross-reference that will not resolve. Same class as the two loops above — the document prints a
    # visible gap — and until now nothing but the export saw it: this function compares numbers, bands,
    # ranks and the selection, and neither `options.figures` nor the chapter list is in any of them.
    # Clearing the "Heatmap of every indicator" box left two chapters quoting `{{ref:f-heatmap}}` (V196),
    # and deleting the results chapter left the conclusions quoting `{{ref:t-lcia}}` (V198), both while
    # the check reported "Every chapter written" and the export refused the PDF. The author asks "is this
    # report finished?" here, so it has to be the same answer.
    #
    # The deleted chapter is the second half of V196, held back then because the authority was narrower
    # than the renderer (`t-abbreviations`, `t-references`, `t-scenarios`, `t-sources`, `t-web-research`
    # were emitted and not listed) and comparing against it would have hung a permanent rewrite badge on
    # a reference the PDF resolves perfectly. V197 closed that gap and put a guard test on it, so the
    # comparison is sound now — `_dead_reference` and `_printed_tables` state what is still not asked.
    #
    # A chapter is judged on its own text, so only the chapters that really carry the reference are
    # named — a dead reference invalidates a sentence, not a chapter that never mentioned it. The
    # chapter that was deleted carries nothing at all: it is gone from `report["sections"]`, so the one
    # place the missing table was its own is the one place with nobody left to tell. And both causes are
    # read afresh every time rather than from the stored record, so ticking the box again — or bringing
    # the chapter back — makes the finding disappear on the next pass; there is nothing to stamp away.
    refs = sorted({t for t in rd.placeholders_in(text) if t.startswith("ref:")})
    # Once per chapter, and only where a table is actually referenced: the authority walks every section.
    tables = _printed_tables(report, data) if any(t.startswith("ref:t-") for t in refs) else None
    for token in refs:
        label = token[4:].strip()
        if not label or not _dead_reference(label, report, tables):
            continue
        found.append(
            {
                "kind": "members",
                # `rewrite`, like every other gap in the deliverable, and it is also the *cheaper* of
                # the two verdicts here. "Correct all" buys a model call for `review` chapters only, and
                # the one edit a model could make to this sentence is deleting the reference — the wrong
                # repair when the remedy is a checkbox, and a guess at the author's intent when the
                # remedy is to bring a chapter back. `rewrite` keeps the chapter out of the paid run,
                # states the cause for free in the dialog that explains why, and withholds "Accept as it
                # is" — which must not be offered for a hole the export refuses to print (V190).
                "severity": "rewrite",
                "path": token,
                "message": f"cites {{{{{token}}}}}, which renders as “[missing reference: …]” — "
                           + report_prompts.reference_gap(label, report),
            }
        )

    families = method_families_in_prose(
        text, report, known_families or [], stored if isinstance(stored, dict) else None
    )
    if families:
        found.append(
            {
                "kind": "selection",
                "severity": "rewrite",
                "names": families,
                "message": f"names {', '.join(families)} in its text, which this report does not use",
            }
        )

    # A direction claim between two figures that no longer holds. The record
    # above watches signs, bands and ranks; the relation between two ordinary placeholders was
    # watched by nothing, so "{{A}} is higher than {{B}}" went from 20 > 10 to 5 < 10 under "the text
    # stays valid" while the gate would have refused the same sentence. Asked afresh of the
    # current numbers rather than kept in the record — the gate's own rule, at the other moment — so it
    # clears itself the moment the sentence is put right. Captions carry no such sentence (`words`).
    #
    # Not for a chapter the second reader read against these very figures: the check is a word reading,
    # the reader has judged it for this text, and raising it again unchanged is a false alarm on a
    # chapter just written (`report_review`). Once the figures move, the reading no longer covers them.
    from prism_lca.engine import report_review

    read = bool(section and report_review.current_review(section)) and (
        isinstance(stored, dict) and stored.get("values") == current["values"]
    )
    if words and not read:
        lang = str(report.get("lang") or "en")
        for claim in report_claims.check_claims(words, data, lang, bindings):
            if claim.get("kind") != "contradicted_claim" or not claim.get("relation"):
                continue
            found.append(
                {
                    "kind": "comparison",
                    "severity": "review",
                    "sentence": claim.get("sentence"),
                    "message": claim.get("detail"),
                }
            )

    if isinstance(stored, dict):
        message = _selection_message(stored.get("selection") or {}, current["selection"])
        # Only when the prose check has not already said it, so one problem is reported once.
        #
        # `rewrite` for every field of the selection, the amount included. `review` means "read this
        # sentence": it names one path and the correction loop offers a rewording of the claim about
        # it. A moved selection has no such sentence — the amount is in the *frame of reference* of
        # every absolute figure the chapter prints, and a chapter written for one window element that
        # now prints the numbers for ten is not a rephrasing away from being right; it is a different
        # study. Switching the reference process has always been treated this way, and multiplying the
        # whole study by ten is not the milder of the two.
        if message and not families:
            found.append({"kind": "selection", "severity": "rewrite", "message": message})

        for path, now in current["bands"].items():
            before = (stored.get("bands") or {}).get(path)
            if not isinstance(before, dict):
                continue
            if before.get("sign") != now.get("sign"):
                found.append(
                    {
                        "kind": "bands",
                        "severity": "review",
                        "path": path,
                        "message": f"{path} changed direction — wording like “higher” may now be wrong",
                    }
                )
            # Both sides need a band: a path that stopped (or started) being a share has no band on one
            # side, and comparing against the missing one raised KeyError and took the whole out-of-date
            # check down with it (seen on a stored report).
            elif before.get("band") and now.get("band") and before["band"] != now["band"]:
                found.append(
                    {
                        "kind": "bands",
                        "severity": "review",
                        "path": path,
                        "message": f"{path} moved from {before['band']} to {now['band']} — wording like "
                                   "“dominates” may no longer hold",
                    }
                )

        for key, now_rank in current["ranks"].items():
            before_rank = (stored.get("ranks") or {}).get(key)
            if isinstance(before_rank, int) and before_rank != now_rank:
                # A rank the text only ever reads inside a fold is not a claim the chapter makes.
                # Measured (V172): two chapters cited `inventory.flows.0` and `.1` solely
                # as operands of one `sum(0, 1, 2)` — the same elementary flow in two compartments —
                # and a parameter change swapped their places. The sum moved by nothing, no sentence
                # said "the largest", and the finding still escalated one chapter to a paid full
                # rewrite of prose with nothing wrong in it and left a second stuck on `review` with
                # no correction to propose: there was no wording to change. Same rule as the
                # aggregate exemptions in `report_claims` — the operands of a fold are not its
                # subjects.
                #
                # Exempt only for a permutation *inside* the folded indices. A member that leaves
                # the set (rank 1 → rank 4 under `sum(0, 1, 2)`) may genuinely have falsified the
                # sentence around it — "over its three air compartments" then describes different
                # members — so that keeps its finding.
                covered = _aggregate_cover(text, key)
                if covered is not None and now_rank in covered:
                    continue
                # "May" is the honest word for a claim in prose: this check cannot read a sentence, so
                # it can only suspect that "the largest" was meant. A **declaration** removes the doubt
                # — `{{rank:contribution.groups.0}}` says in machine-readable form that this member
                # leads, so when it no longer does, the sentence is wrong rather than possibly wrong.
                # Two states deserve two words: the author decides what to fix first by how certain the
                # finding is. Matched on the exact token, so no word list and no language is involved.
                declared = f"{{{{rank:{key}}}}}" in (text or "")
                # A declaration does not always claim the *top*. Measured in run 21: a chapter wrote
                # `{{rank:hotspots.1}}` for "the second largest is …", which is a rank claim like any
                # other and just as checkable — the pin notices when that member leaves position 2.
                # So the sentence has to name the position the chapter declared, not assume the first;
                # the version before this said "as the leader" and would have been plainly wrong there.
                # The declared position is the one the member held when the chapter was stored.
                claimed = (
                    "the leader" if before_rank == 0 else f"rank {before_rank + 1}"
                )
                verdict = (
                    f"the sentence declares this member as {claimed}, and it is not any more"
                    if declared
                    else "“the largest” may no longer be true"
                )
                # The exit, named (V423): a correction that keeps the ranked placeholder
                # keeps this finding — the pin still says "was rank 1" whatever the sentence now
                # claims, and the model, told only what is wrong, softened the same sentence three
                # rounds in a row. Where the member has a stable path (a variant: `subjects.N`), the
                # finding says so; the correction brief hands this message to the model verbatim.
                stable = _stable_path(head, (bindings or {}).get(key), data)
                exit_ = (
                    f" If the sentence no longer claims the position, cite the member by its stable "
                    f"path {{{{{stable}.label}}}} instead of the ranked one (or declare the new rank "
                    f"with {{{{rank:{head}.{now_rank}}}}} if it does claim it)."
                    if stable
                    else " If the sentence no longer claims the position, name the member in words "
                         "and drop the ranked placeholder."
                )
                found.append(
                    {
                        "kind": "ranks",
                        "severity": "review",
                        "path": key,
                        "declared": declared,
                        "message": f"{key} was rank {before_rank + 1} and is now rank {now_rank + 1} — "
                                   f"{verdict}.{exit_}",
                        # Structured for the patch route: the ONE placeholder swap a correction may
                        # make for this finding (`report_patch.apply_edits` swaps). Without it the
                        # exit above was an invitation the patch rule then refused — "the placeholders
                        # differ between find and replace" on all five chapters.
                        **({"stable": stable} if stable else {}),
                    }
                )

        # A claim to the top made in words only, under a ranking that has changed hands. Everything
        # above judges a chapter by what it cites; this is the one thing a chapter can be wrong about
        # without citing anything, and it went out in a client PDF twice in one report (V206 — see
        # `leaders_of`). Tied to a flip that really happened, and to a sentence that really carries the
        # wording, so it cannot become the permanent remark a moved number would make of it.
        #
        # `review`, not `rewrite`: the sentence is handed over verbatim, so a correction can reach it
        # for the price of one replacement — and the author can still answer "read it, it makes no such
        # claim", which for a rule that cannot parse a sentence has to stay possible (V179).
        flipped = _flipped_leaders(bindings, data, stored)
        if flipped:
            changes = "; ".join(
                _leader_change(head, was, data, bindings) for head, was in sorted(flipped.items())
            )
            for sentence, word in (
                unanchored_claims(words, str(current["selection"].get("lang") or "en")) if words else []
            ):
                found.append(
                    {
                        "kind": "wording",
                        "severity": "review",
                        # Verbatim, because it is the only handle there is: the sentence cites no path
                        # and spells out no member name, so `report_patch` can locate it by nothing
                        # else. Same field a gate finding about an assertion carries, and
                        # `_spans_and_gaps` already reads it.
                        "sentence": sentence,
                        # What the record has to keep saying while this stands — see `keep_stale`.
                        "was": dict(flipped),
                        "message": (
                            f"“{report_claims._clip(sentence)}” claims a top rank in words (“{word}”) "
                            f"with no figure in it, and {changes} — nothing in the sentence resolves, "
                            "so no placeholder can put it right: name what leads now, or drop the claim"
                        ),
                    }
                )

        # The texts the chapter drew on: study prose, looked-up datasets, the sibling
        # chapters a summary read. Compared against the record's fingerprints where the record has them.
        if section is not None:
            found.extend(_source_verdicts(section, stored, report, data))

        if stored.get("values") != current["values"]:
            # Reported even beside a finding that costs something. It used to be suppressed then, on
            # the grounds that one problem should be reported once — but "the numbers moved" is not
            # the same problem as "a share left its class", and the tooltip lists every finding. The
            # remedy is unaffected either way: this one asks for nothing.
            found.append(
                {
                    "kind": "values",
                    "severity": "none",
                    "message": "the numbers moved; the placeholders resolve them, the text stays valid",
                }
            )
    else:
        # Either a pre-components fingerprint or none at all (text written by hand). Neither can be
        # compared field by field, and inventing a verdict would cry wolf or miss the real case —
        # the prose check above is what covers these, and it has already run.
        found.append(
            {
                "kind": "unknown",
                "severity": "none",
                "message": "no record of what this text was written against — its wording has not "
                           "been checked",
            }
        )

    return found


def _sentences_citing(text: str, path: str) -> list[str]:
    """The sentences of `text` whose placeholders read `path` (or a leaf below it)."""
    out: list[str] = []
    for raw in report_sentences.sentences(text):
        sentence = raw.strip()
        for token in rd.placeholders_in(sentence):
            if any(p == path or p.startswith(f"{path}.") for p in rd.paths_in_token(token)):
                out.append(sentence)
                break
    return out


def unresolved_after(
    touched: list[dict[str, Any]],
    text: str,
    bindings: dict[str, dict[str, Any]] | None,
    report: dict[str, Any],
    data: dict[str, Any],
    known_families: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Of the findings a correction *touched*, the ones it did not demonstrably answer.

    "Touched" used to be "resolved": a replacement anywhere in the condemned sentence re-stamped the
    record, and "Packaging is" → "The Packaging is" cleared a rank finding while the false claim stood.
    The generosity was deliberate — a rank finding can never stop firing by
    itself, the rank moved whatever the sentence says — so the answer is not to demand that, but to
    look at what the corrected sentence now claims. Three outcomes, each mechanical:

    * **demonstrably right** — the sentence declares the member's rank (`{{rank:…}}`) and the member
      holds it now; or the chapter names no method the report does not use any more;
    * **demonstrably gone** — no sentence reads the path any more, or the ones that do make no size
      claim in words (`report_claims.rank_wording`); a wording claim's sentence is gone;
    * **not decidable** — the sentence still cites the member and still says "largest" (or "dominates",
      or compares): it may well be right, and this check cannot know. It stays open, and the author
      answers it with "Accept as it is".

    What is not decided here keeps its old record entry through `keep_stale`, so the finding stands.
    """
    bindings = bindings or {}
    lang = str(report.get("lang") or "en")
    out: list[dict[str, Any]] = []
    for finding in touched:
        kind, path = finding.get("kind"), str(finding.get("path") or "")
        if kind == "ranks" and path:
            if path not in cited_binding_keys(text):
                continue  # gone
            head, _, index = path.rpartition(".")
            if f"{{{{rank:{path}}}}}" in text:
                identity = bindings.get(path)
                now = _rank_of(head, identity, data, bindings) if identity else None
                if now is not None and str(now) == index:
                    continue  # declared, and true again
                out.append(finding)
                continue
            if not any(report_claims.rank_wording(s, lang) for s in _sentences_citing(text, path)):
                continue  # cited, but claims nothing about size any more
            out.append(finding)
        elif kind == "bands" and path:
            citing = _sentences_citing(text, path)
            if not citing or not any(report_claims.rank_wording(s, lang) for s in citing):
                continue
            out.append(finding)
        elif kind == "wording":
            still = {s for s, _w in unanchored_claims(text, lang)}
            if str(finding.get("sentence") or "") not in still and not still:
                continue
            out.append(finding)
        elif kind == "selection" and finding.get("names"):
            if not method_families_in_prose(text, report, known_families or [], None):
                continue
            out.append(finding)
        else:
            # A moved selection, a vanished member, a contradiction: nothing a touched sentence can
            # prove about them here. They stay until the record says otherwise.
            out.append(finding)
    return out


def _source_verdicts(
    section: dict[str, Any], stored: dict[str, Any], report: dict[str, Any], data: dict[str, Any]
) -> list[dict[str, Any]]:
    """What changed among the texts a chapter drew on — see `sources_of`."""
    recorded = stored.get("sources")
    if not isinstance(recorded, dict):
        # A record from an older version carries no sources: nothing to compare, nothing to say. A note
        # here would stand on every chapter of every older report at every check — the remark nobody
        # reads by the third time (V250). The next write or correction records them.
        return []
    now = sources_of(section, report, data, section.get("lookups"))
    out: list[dict[str, Any]] = []
    for field, sha in (recorded.get("study") or {}).items():
        if (now.get("study") or {}).get(field) != sha:
            out.append(
                {
                    "kind": "sources",
                    "severity": "review",
                    "path": f"study.{field}",
                    "source": "study",
                    "message": f"the study's {field.replace('_', ' ')} changed since this chapter was "
                               "written — read what the chapter says about it",
                }
            )
    changed_datasets = [
        key
        for key, sha in (recorded.get("datasets") or {}).items()
        if (now.get("datasets") or {}).get(key) not in (None, sha)
    ]
    if changed_datasets:
        out.append(
            {
                "kind": "sources",
                "severity": "review",
                "source": "datasets",
                "message": "a dataset this chapter looked up changed since it was written "
                           f"({', '.join(changed_datasets[:3])}{'…' if len(changed_datasets) > 3 else ''}) — "
                           "what the chapter says about it may no longer match its documentation",
            }
        )
    titles = []
    for other_id, sha in (recorded.get("siblings") or {}).items():
        if (now.get("siblings") or {}).get(other_id) != sha:
            other = next((s for s in report.get("sections") or [] if str(s.get("id")) == other_id), None)
            titles.append(chapter_name(other) if other else other_id)
    if titles:
        out.append(
            {
                "kind": "sources",
                "severity": "review",
                "source": "siblings",
                "message": "the chapters this one was written from have changed since: "
                           + ", ".join(titles),
            }
        )
    return out


def worst(found: list[dict[str, Any]]) -> str:
    """The remedy the chapter as a whole needs: the most expensive one any finding asks for."""
    for severity in ("rewrite", "review"):
        if any(f["severity"] == severity for f in found):
            return severity
    return "none"



def expert_review(section: dict[str, Any], remedy: str, current_values: str | None = None) -> str | None:
    """Whether a model-written chapter stands released by its author, or still waits for that.

    The gate verifies figures, placeholders and simple relations; it cannot verify what a sentence means.
    That remains the author's job, and this is the record of it: ``None`` for a chapter no model wrote
    (the author wrote it, there is nobody else to release it), ``"released"`` while the author's mark
    holds, ``"pending"`` otherwise.

    The mark holds only while two things are true. The wording is the one the author released — a patch,
    a rewrite or a hand edit lapses it — and the check reports nothing under it: the same placeholder text
    prints other figures after a recalculation, and a release that survived that would be a release of
    numbers the author never saw. Marks from older versions carry no ``release``
    flag; they record a reading, not a release, and count as pending until the author confirms once more.

    "Nothing under it moved" is read off the figures, not off the remedy: the first real use of this
    rule (V393) changed a parameter, five chapters reported "the numbers moved" at severity
    none, and every release stood — the remedy was still "none". So the mark records the ``values`` hash
    of the chapter's cited figures at release time (`components`), and the release holds only while the
    chapter's figures hash to the same. A mark without that hash is a reading, not a release.
    """
    status, _reason = expert_review_with_reason(section, remedy, current_values)
    return status


def expert_review_with_reason(
    section: dict[str, Any], remedy: str, current_values: str | None = None
) -> tuple[str | None, str | None]:
    """`expert_review` plus WHY a chapter is pending — the tooltip's text (V396).

    In the first real use of this rule three chapters stood on "expert review pending" with no visible finding
    at all: their release had lapsed because the figures had moved since it was given, and nothing on
    the row said so. Reasons: ``never`` (no release yet, or a reading from before the release existed),
    ``text`` (the wording changed since the release), ``values`` (the figures the chapter cites moved
    since the release), ``findings`` (the check reports something under it). None when released or when
    no model wrote the chapter.
    """
    if not (section.get("model") or section.get("source") == "ai"):
        return None, None
    reviewed = section.get("reviewed") or {}
    if not reviewed.get("release") or not reviewed.get("values"):
        return "pending", "never"
    if (reviewed.get("text") or "") != (section.get("text") or ""):
        return "pending", "text"
    if current_values is not None and reviewed["values"] != current_values:
        return "pending", "values"
    if remedy != "none":
        return "pending", "findings"
    return "released", None

__all__ = [
    "BAND_EDGES",
    "PRIMARY_RANKED",
    "cited_binding_keys",
    "cited_paths",
    "components",
    "leaders_of",
    "method_families_in_prose",
    "selection_of",
    "unanchored_claims",
    "caption_bindings",
    "caption_migration",
    "caption_state",
    "caption_verdicts",
    "captions_text",
    "expert_review",
    "expert_review_with_reason",
    "sources_of",
    "with_sources",
    "unresolved_after",
    "verdicts",
    "worst",
]
