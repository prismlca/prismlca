"""The identity model — and the placeholder language evaluated under its pins.

Split out of ``report_data``. Everything that reads or writes a *binding*
lives here: the registry of ranked lists and their identity fields, pinning (`bindings_for`),
pin-honouring resolution (`bound_lookup`), and with it the whole evaluation of the language —
``derive``, ``resolve``, ``explain``, ``rank_name`` — because evaluating a chapter WITHOUT its pins
is positional resolution, which is the failure class (V154/V182/V186/V221…) this model exists
against. The binding-free grammar is ``report_tokens``; ``report_data`` builds the snapshot and
re-exports both halves, so `report_data as rd` stays the stable façade.
"""
from __future__ import annotations

import re
from typing import Any

from prism_lca.engine.report_i18n import fmt_number, ref_phrase
from prism_lca.engine.report_model import drop_code_fences, esc
from prism_lca.engine.report_model import markup as esc_markup
from prism_lca.engine.report_tokens import (
    DERIVATIONS,
    PERCENT_ARG_SUFFIXES,
    PLACEHOLDER,
    RANK_PREFIX,
    collapse_declaration_pairs,
    is_number,
    lookup,
    paths_in_token,
    placeholders_in,
    rank_path,
    render_value,
    unfence,
    unit_of,
)

#: Lists whose members are identified by content rather than by position. Each entry lists the fields
#: that identify a member, so a stored chapter can be re-resolved by identity instead of by index —
#: a sentence saying "the dominant process is {{hotspots.0.name}}" would otherwise quietly become a
#: statement about a different dataset the moment the ranking changed.
#:
#: NOT all of these are sorted by magnitude. `hotspots`, `contribution.groups` and `inventory.flows`
#: are (index 0 = "the largest one today" — see MAGNITUDE_RANKED); `results` is method order,
#: `subjects` is report order, `scenarios` is creation order and `foreground`/`background_datasets`
#: are sorted by name. Treating the structure-ordered ones as rankings made the superlative check
#: instruct the model that "the largest is subjects.0" — an assertion about a position that means
#: nothing. `subjects` keeps its order and keeps refusing rank claims; a chapter that means "the
#: highest variant" names `results.<i>.subjects_by_score` instead, the same variants sorted by one
#: indicator's score, which is a derived view and says so in its name.
#: A key may carry `*` where the path has an index of its own: `contributions.<i>.groups` is one
#: ranked list *per indicator*, and each of them ranks separately. See `registry_key`.
#:
#: A path can cross *several* of these, and then it carries one identity per level:
#: `contributions.3.groups.0.share_text` says which indicator (`method_label`) and which phase inside
#: it (`key`). Both are pinned — see `ranked_splits` — because both move on their own, and only the
#: inner one used to be.
#:
#: `parameters` is the model author's own list, and it is the worst case of the lot — worse than a
#: ranking, because nothing has to be *recomputed* for it to move. The parameter list is sorted by
#: name, so creating a parameter or renaming one re-sorts everything after it, and that is a daily
#: modelling action. Unregistered, a PVC-window report printed "Uw = {{parameters.16.amount}}
#: {{parameters.16.unit}}, an element mass of {{parameters.15.amount}}"; one added parameter sorting
#: ahead of the rest turned the same sentence into "Uw = 30 kg, an element mass of 0.85 kg", and
#: nothing reported it, because a list nobody registered has no member to lose
#: (V182). Its index is where a name happens to sort, so it carries no rank — see MAGNITUDE_RANKED.
#:
#: `scenarios`, `foreground` and `background_datasets` were held back twice with the same reason: their
#: members read as a *name*, and `report_translations` rewrites that name **in this very snapshot**
#: before the chapters resolve, so a pin on it would report itself missing in every translated report.
#: The reason was answered by opening the snapshot rather than by reasoning about it: all three carry an
#: identifier next to the name, and the translation walk never touches an identifier. A scenario has the
#: store's own `id` (a uuid written once at creation into `prism_meta/scenarios.json`), a foreground
#: process has its `code`, and a background dataset has the `database` + `code` pair the snapshot already
#: deduplicates it by. So the identity is the identifier and the blocker is gone (V194).
#:
#: That choice also settles what a *rename* is here, and it is the exact opposite of `parameters`: the
#: id stays, so the sentence keeps its own scenario and simply prints the new name — a rename is not a
#: loss and must not be reported as one. Only a deletion is, which is what was silent. Measured on a
#: mould-remover report: three chapters cited `scenarios.<i>.name` inside claims about a named
#: variant ("o cenário X quase não desloca nenhum indicador"), the list stands in creation order, and
#: deleting the *first* scenario turned "cenario 1 = Alta taxa de reciclagem de plástico (80 %)" into
#: "cenario 1 = AAA Kontrolle" — a scenario those chapters never wrote about. The staleness check
#: reported four other things about that edit and nothing about this one, because a list nobody
#: registered has no member to lose. `foreground` and `background_datasets` are the `parameters` case
#: exactly: sorted by name, so a rename re-sorts everything after it, and that is a daily action.
#:
#: An id survives a recompute, a restart and a language switch. It does not survive a bundle round trip
#: — `bundle.read_scenarios` creates the scenarios afresh — so an imported report's scenario pins point
#: at ids that are gone. That is not new (the report's own `subjects` have pinned scenario ids all
#: along) and it is the honest failure: the chapter says the variant is missing instead of quietly
#: printing another one's name.
RANKED_LISTS: dict[str, tuple[str, ...]] = {
    "hotspots": ("database", "code", "name"),
    "contributions.*.hotspots": ("database", "code", "name"),
    "contribution.groups": ("key",),
    "contributions.*.groups": ("key",),
    # The same breakdown per variant of the comparison, flat and per indicator. Both were unregistered
    # entirely — not merely unpinned at the outer level — so a sentence citing
    # `contribution_subjects.1.groups.0.share_text` had no member at all.
    #
    # Then both were pinned by the variant's `label`, and that was `subjects`' defect once more, one
    # list further on and a degree worse (V223). A variant with no label of its own is *called* by its
    # process name (`api/v1/report.py` falls back to `activity.name`), so two variants of one process —
    # the shape every scenario comparison has — carry the identical label, and a pin on the second one
    # matched the first. Measured: `{{contribution_subjects.1.groups.0.share_text}}` printed 40.0 %
    # where index 1 held 80.0 %, with no gap and no verdict. Unlike V221 this needed no reordering to go
    # wrong — it was wrong the moment the chapter was written, which makes it the worse of the two.
    #
    # So the identity is the same never-empty composite the other two variant lists carry, and for the
    # same reason it costs no migration: the rows keep their `label`, so a pin already on disk goes on
    # matching exactly what it matches today. See `subjects` below.
    "contribution_subjects": ("variant",),
    "contribution_subjects.*.groups": ("key",),
    "contributions.*.subjects": ("variant",),
    "contributions.*.subjects.*.groups": ("key",),
    "inventory.flows": ("flow", "compartment"),
    "results": ("method_label",),
    # One never-empty key rather than the (code, scenario) pair it is composed of, and the pair is the
    # reason: the baseline runs no scenario, `identity_of` drops empty values, so the pair collapsed to
    # the process **code** — which every other variant of the same process carries too. The baseline's
    # pin then matched whichever of them the list offered first, the declaration printed the runner-up's
    # name the moment the two swapped places, and no verdict fired at all (V221 — the silent wrong
    # referent of V182/V186/V194, in the one list nobody had checked).
    #
    # Changing this does **not** unbind the chapters already written against it, which is what held the
    # fix up for a run: `identity_matches` compares the fields a *stored* pin names, not the fields this
    # registry names today, and the rows keep their `code` and `scenario` beside the new key. So an old
    # pin `{"code": "w"}` goes on matching exactly what it matches today — no better, no worse — and
    # nothing on disk is rewritten. It is only re-stated in this key when the chapter is next saved and
    # the answer is not a guess (`_strengthened`); disambiguating it by its own index would be the
    # positional guess every entry in this registry exists to refuse.
    "subjects": ("variant",),
    # A variant's own scores, in method order — `results` for one subject of the comparison, and the
    # prompts tell a writer to quote `subjects.1.results.0.score` by name.
    "subjects.*.results": ("method_label",),
    # The same variants as `subjects`, ordered by *this indicator's* score — the derived view a rank
    # claim about a variant can point at (V219). Identity is the variant, exactly as in `subjects`:
    # the position is what the claim is about, so it can never be what identifies the member (V182,
    # V186, V194, V203). Which is also why the printed name is not in here — the label follows the
    # report language (`report_translations` rewrites it), and a pin on it would report itself missing
    # after a language switch. It is stored beside the identity instead, see IDENTITY_LABELS.
    #
    # The *same* key `subjects` above is pinned by, and deliberately the same field name: one notion of
    # "which variant" for both lists, so a pin cannot mean the process-and-state pair in the comparison
    # table's list and something else in the score-ordered view of the same variants. `variant_key`
    # builds it in both places (V219 measured the collapse here first, V221 fixed it in `subjects`).
    "results.*.subjects_by_score": ("variant",),
    # Which indicator a per-indicator breakdown belongs to. `contributions.*.groups` above pins *which
    # phase* a figure is about; this pins *whose breakdown it was taken from*, and it is the half that
    # was missing. Measured on a mould-remover report (V186): reordering the five indicators of
    # a finished report — same set, nothing recomputed — turned "acidification (61.0 %)" into
    # "acidification (41.4 %)", which is particulate matter formation's packaging share. The phase pin
    # held, so the figure was plausible; no member had gone; seven of nine chapters stayed silent.
    "contributions": ("method_label",),
    # One row per indicator, method order, same identity as `results` and for the same reason: the
    # same reordering moved "the spread for acidification" from 16.5 to particulate matter's 35.6.
    "checks.sensitivity": ("method_label",),
    # Only the indicators whose leading variant differs from the first one's — a *filtered* list, so an
    # index moves as soon as any other indicator starts or stops flipping, with nothing recomputed.
    "trade_offs": ("method_label",),
    # The bibliography rows for the methods, in the order the caller sends them: adding a family shifts
    # every index behind it, exactly the way adding a parameter does.
    "method_references": ("name",),
    # The name is the whole identity here, which also settles what a *rename* is: the member the
    # sentence was written about is gone, and it is reported as gone. There is no second stable field
    # to re-match on the way `report_patch.STABLE_IDENTITY` re-matches a renamed dataset by its code,
    # and inventing one would be a guess about which parameter a sentence meant.
    "parameters": ("name",),
    # The three where the name is *not* the identity: a scenario keeps its store uuid, a process its
    # code. So a rename keeps the sentence on its own member and needs no re-matching at all, which is
    # why none of them appears in `report_patch.STABLE_IDENTITY` — their whole identity is already
    # stable, and there is nothing for a "renamed, re-point it?" offer to repair.
    "scenarios": ("id",),
    "foreground": ("code",),
    "background_datasets": ("database", "code"),
}

#: A key inside a stored binding that describes the member instead of identifying it. Prefixed so it can
#: never collide with a snapshot field, and skipped by every comparison (`identity_matches`).
#:
#: It exists because a pin on an opaque identifier cannot report its own loss in words: "points at
#: something that no longer exists (id=913c47f1e1024cd9…)" names the defect and not the scenario, and by
#: the time the loss is noticed the name is gone from the snapshot. So the name is stored *with* the pin,
#: beside the identity and outside it — the lists whose identity spells itself out (`hotspots`,
#: `parameters`) need nothing here.
LABEL_KEY = "@name"

#: registry key -> the field that says, in words, which member a pin was made on. See LABEL_KEY.
IDENTITY_LABELS: dict[str, str] = {
    "scenarios": "name",
    "foreground": "name",
    "background_datasets": "name",
    # A variant is identified by its process-and-state key and *called* by its label. The other three
    # entries here exist so a lost pin can name itself; this one is also what a declaration prints,
    # because a sentence saying "variant=fef2… is the highest" would name the defect, not the variant.
    "results.*.subjects_by_score": "label",
    # The same variants in report order, for the same reason as every other entry here: their new pin
    # is one opaque key, and "points at something that no longer exists (variant=fef2… · 6ab1…)" names
    # the defect rather than the variant the chapter was written about. Only pins written from now on
    # carry it — a stored pin says what it always said.
    "subjects": "label",
    # And the same variants inside a breakdown, flat and per indicator (V223). These two used to *be*
    # their label, so a lost pin named itself for free; now that the label is beside the identity rather
    # than in it, it has to be carried here or the message would name the key instead of the variant.
    "contribution_subjects": "label",
    "contributions.*.subjects": "label",
    # And the breakdown groups, for exactly the reason the four above are here — they used to *be*
    # their label too, until V240 gave them one beside the key so the chapter could be translated.
    # Without these four lines a `{{rank:contribution.groups.0}}` prints the KEY, which never follows
    # the report language: a wood-stain report said "the climate dominance of
    # Manufacturing" in its prose and declared "Herstellung" three sentences and three chapters over,
    # in one English document (V248). The pin is still on the key and does not move.
    "contribution.groups": "label",
    "contributions.*.groups": "label",
    "contribution_subjects.*.groups": "label",
    "contributions.*.subjects.*.groups": "label",
}

#: The subset of RANKED_LISTS where index really is rank: superlative claims and rank-drift verdicts
#: apply here and only here. `results`, `subjects`, `parameters`, `scenarios`, `foreground` and
#: `background_datasets` keep their identity bindings but carry no rank — the last three are ordered by
#: creation or by name, and none of those orders ever expressed size.
#: For a parameter that is not a nicety: "parameters.16 was rank 16 and is now rank 17
#: — “the largest” may no longer be true" is a sentence about a U-value, and a checker that says that
#: about a U-value is one an author stops reading.
MAGNITUDE_RANKED: frozenset[str] = frozenset(
    {
        "hotspots",
        "contributions.*.hotspots",
        "contribution.groups",
        "contributions.*.groups",
        "contribution_subjects.*.groups",
        "contributions.*.subjects.*.groups",
        "inventory.flows",
        # The variants, ordered by score. `subjects` is not in here and must not be — index there is
        # report order, chosen by the author — so a claim about "the highest variant" had no
        # declaration form at all and stayed in the prose-only regime, which cost run 21 a paid
        # rewrite of one chapter for one sentence (V219). Ranking variants needs an indicator to rank
        # them by, and this is the list of one indicator's ranking: the path names the indicator, so
        # nothing here has to *decide* which score counts.
        "results.*.subjects_by_score",
    }
)

_INDEX_SEGMENT = re.compile(r"(?<=\.)-?\d+(?=\.|$)")


def registry_key(head: str) -> str:
    """The RANKED_LISTS key a concrete head belongs to — `contributions.1.groups` → `contributions.*.groups`.

    The *literal* head stays the binding key, so `contributions.0.groups.1` and `contributions.2.groups.1`
    are pinned separately; only the lookup of "which fields identify a member" is shared.
    """
    return head if head in RANKED_LISTS else _INDEX_SEGMENT.sub("*", head)


def identity_fields(head: str) -> tuple[str, ...]:
    """Which fields identify a member of the list at `head` (empty if it is not a ranked list)."""
    return RANKED_LISTS.get(registry_key(head), ())


def is_magnitude_ranked(head: str) -> bool:
    """True when index really is rank for this list, so a superlative about it means something."""
    return registry_key(head) in MAGNITUDE_RANKED


def ranked_splits(path: str) -> list[tuple[str, int, str]]:
    """Every ranked index in `path`, outermost first — everything the path depends on.

    `contributions.3.groups.0.share_text` yields two levels: ("contributions", 3,
    "groups.0.share_text") for *which indicator*, and ("contributions.3.groups", 0, "share_text") for
    *which phase inside it*. Both need a pin, because each moves for its own reason — the phases
    re-rank when the model is recomputed, the indicators re-order when somebody edits the report's
    method list. Only the inner one was pinned, and that is the whole of V186: reordering the five
    indicators of a finished report printed particulate matter's figure under "acidification", with
    the phase pin holding (so the number looked plausible) and no member missing (so nothing was
    reported).

    The literal head stays in every level, so the key a level produces — `contributions.3.groups.0` —
    names a *citation site in the text* and not a position in today's data. That is what lets the outer
    level move without invalidating the inner pin.
    """
    parts = path.split(".")
    out: list[tuple[str, int, str]] = []
    for i, part in enumerate(parts):
        if not part.lstrip("-").isdigit():
            continue
        head = ".".join(parts[:i])
        if registry_key(head) in RANKED_LISTS:
            out.append((head, int(part), ".".join(parts[i + 1 :])))
    return out


def ranked_prefix(path: str) -> tuple[str, int, str] | None:
    """The *innermost* ranked index of `path` — the member a sentence citing it is about.

    `hotspots.0.share_text` splits into ("hotspots", 0, "share_text"). `contributions.0.groups.1.
    share_text` splits at the *second* index into ("contributions.0.groups", 1, "share_text"): the
    first index selects which indicator's breakdown, the second is the rank inside it, and a claim
    ("the largest phase") is about the phase. Leaving that list unregistered cost a printed report its
    meaning (V154): after the phases swapped places, five figures appeared under the wrong group's
    name because nothing pinned them.

    Innermost rather than first because `contributions` is a registered list in its own right now
    (V186). A left-to-right scan that stopped at the first hit would split at the indicator and undo
    V154 exactly. Two functions rather than one with a wider return type: this one answers "what is
    this sentence claiming", `ranked_splits` answers "what does this path depend on", and the call
    sites — the claim gate asks the first, bindings and resolution ask the second — then say which
    question they mean instead of indexing into a tuple of tuples and hoping.
    """
    splits = ranked_splits(path)
    return splits[-1] if splits else None


def rank_claim(token: str) -> tuple[str, int] | None:
    """The (list, index) a declaration asserts the top rank of — None when it may not assert one.

    Two refusals, and both are "unknown path" rather than a rule of their own, because that is what
    they are: the token names something this report has no such thing as.

    * The path must end at a *member*: ``rank:contribution.groups.0`` is a member,
      ``rank:contribution.groups.0.share_text`` is a figure, and a figure already has a placeholder.
    * The list must be **magnitude-ranked** (`MAGNITUDE_RANKED`). `results` is method order, `subjects`
      is report order and `parameters` is alphabetical, so "the member at index 0 leads" is not a claim
      about those lists — it is a claim about nothing. Accepting it silently would print a name under a
      sentence asserting a rank that the list never expressed, which is the mistake the superlative rule
      made before that set existed.
    """
    path = rank_path(token)
    if not path:
        return None
    split = ranked_prefix(path)
    if split is None or split[2] or not is_magnitude_ranked(split[0]):
        return None
    return split[0], split[1]


#: Fields of an identity that read as a *name*, most name-like first. The printed form of a member is
#: drawn from its identity and from nothing else, which is the point: what the sentence prints is the
#: thing the sentence is pinned to (V193 — a group label is untranslated because the label *is* the
#: binding identity). Separating the printed name from the identity is a real improvement and a
#: different change; this design is what makes it possible, since only this function would move.
MEMBER_LABEL_FIELDS: tuple[str, ...] = (LABEL_KEY, "name", "key", "flow", "label", "method_label")


def member_label(identity: dict[str, Any]) -> str:
    """A member in the words the author reads on the page, or its identity where it has no name."""
    for field in MEMBER_LABEL_FIELDS:
        value = str(identity.get(field) or "").strip()
        if value:
            return value
    return describe_identity(identity)


def identity_of(entry: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    """The fields that say *which* member this is — everything else may change without changing it."""
    if not isinstance(entry, dict):
        return {}
    return {f: entry[f] for f in fields if entry.get(f) not in (None, "")}


def identity_matches(item: Any, identity: dict[str, Any]) -> bool:
    """Is `item` the member this binding names? The one place that reads a stored binding.

    Every LABEL_KEY-style entry is skipped: it describes the member for the author's benefit and says
    nothing about which one it is, so comparing it would make a rename look like a deletion — the very
    thing the identifier identity was chosen to avoid.
    """
    return isinstance(item, dict) and all(
        item.get(k) == v for k, v in identity.items() if not k.startswith("@")
    )


def describe_identity(identity: dict[str, Any]) -> str:
    """A binding in the words an author can act on — the label first, where there is one.

    "id=913c47f1e1024cd9…" is true and useless; “Alta taxa de reciclagem de plástico (80 %)” is the
    thing the sentence was written about. The identity fields stay on, because two scenarios may well
    have carried the same name.
    """
    fields = ", ".join(f"{k}={v}" for k, v in identity.items() if not k.startswith("@"))
    label = str(identity.get(LABEL_KEY) or "").strip()
    if not label:
        return fields
    return f"“{label}”, {fields}" if fields else f"“{label}”"


def captions_of(section: dict[str, Any]) -> list[str]:
    """The captions a chapter's figures print, in drawing order — the author's own, not the fallback.

    The same choice of list the renderer makes (`report_render`): `figures` when it has entries, else
    the legacy single `figure`. A spec without a caption prints a caption WE word, which cites nothing.
    """
    specs = list(section.get("figures") or []) or ([section["figure"]] if section.get("figure") else [])
    return [
        str(spec["caption"])
        for spec in specs
        if isinstance(spec, dict) and isinstance(spec.get("caption"), str) and spec["caption"].strip()
    ]


#: Between the text and each caption in `prose_of`. A paragraph break, so no placeholder can straddle
#: the seam and no caption can be read as the continuation of the text's last sentence by a pattern.
PROSE_SEAM = "\n\n"


def prose_of(section: dict[str, Any]) -> str:
    """Everything a chapter prints that may carry placeholders: its text, then its figure captions.

    For the one question "does this chapter cite anything at all" (the staleness filters). Pins and
    records are NOT formed from it: text and captions each have their own (`bindings`/`based_on` and
    `caption_bindings`/`caption_based_on`) — one map let a kept caption pin decide what an
    index in freshly written text meant, and one record let a text rewrite re-stamp a caption.
    """
    text = str(section.get("text") or "")
    captions = captions_of(section)
    return PROSE_SEAM.join([text, *captions]) if captions else text


def bindings_for(
    text: str, data: dict[str, Any], keep: dict[str, dict[str, Any]] | None = None
) -> dict[str, dict[str, Any]]:
    """Which member each ranked index pointed at when the text was written.

    Stored with the chapter, so a later render finds the same process even if it has slipped to third
    place. Only paths that actually appear in the text are bound — a binding for an unused index would
    be noise, and would go stale for no reason.

    ``keep`` are the bindings the text already had, and an index it still cites keeps the member it
    was written about. Without it, re-binding after a *correction* re-pointed every sentence the
    correction never touched: two cosmetic edits elsewhere in a chapter silently moved four named
    datasets onto other datasets' numbers — "the parcel last mile (…, 16.7 %)" where 16.7 % belonged
    to the natural-gas heat, and a containerboard that had dropped out of the list entirely printing
    the share of natural gas. The honest "[missing: …]" and the staleness badge both disappeared with
    it, so the report looked current and shipped the wrong figures. A pin only moves when the author
    rewrites the sentence that made the claim.
    """
    out: dict[str, dict[str, Any]] = {}
    keep = keep or {}
    for token in placeholders_in(text):
        for path in paths_in_token(token):
            # Every level, not just the innermost: a path across two ranked lists makes two claims,
            # and pinning only the phase left the indicator free to move under it (V186).
            for head, index, _rest in ranked_splits(path):
                key = f"{head}.{index}"
                if key in out:
                    continue
                if key in keep:
                    # The same member, said in today's identity fields where saying it costs no guess —
                    # never a different member, which is what `_strengthened` guarantees and what keeps
                    # the promise in the paragraph above.
                    out[key] = _strengthened(head, keep[key], data, keep)
                    continue
                # By position, which is correct by definition here: this is the data the text was
                # written against, so the index and the member still agree.
                entry = lookup(f"{head}.{index}", data)
                identity = identity_of(entry, identity_fields(head))
                if identity:
                    out[key] = {**identity, **_label_of(head, entry)}
    return out


def _strengthened(
    head: str, identity: dict[str, Any], data: dict[str, Any], bindings: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """A carried-over pin re-stated in the fields that identify its member today — or left as it is.

    A pin is written in the identity fields of its moment (`RANKED_LISTS`), and one of those sets has
    since changed: `subjects` was pinned by the (code, scenario) pair and is pinned by the never-empty
    composite `variant` now, because for the baseline the pair collapsed to the code and then matched a
    sister variant of the same process (V221). Nothing stored is rewritten to repair that. An old pin
    naming only a code is *genuinely ambiguous* — that ambiguity is the bug — and resolving it by the
    pin's own index would be the positional guess bindings exist to refuse, however faithfully it
    reproduced what the old code did by accident. So the weak pin keeps matching what it matches today,
    and only a chapter that is being saved anyway gets the strong form, where the strong form is not a
    guess.

    Three conditions, and each one is what keeps this from guessing:

    * The pin names **none** of the fields that identify a member now. That is this case — a pin
      written against a *different* set of fields — and it deliberately excludes the *partial* one: a
      `hotspots` pin lacking `name` would be hardened into a pin a rename can break, turning a free
      re-link (`report_patch.rebindings`) into a lost member and a rewrite verdict.
    * Exactly **one** member answers to the stored pin. Two is the ambiguity itself, zero is a loss the
      verdict has to report; in both cases the pin stays exactly as it stands.
    * The strong pin lands on that same one member. Otherwise it would be a different claim wearing the
      same sentence — the failure this whole mechanism is against.

    Idempotent by the first condition: a pin already written in today's fields names one of them and
    comes back untouched, so saving a chapter twice cannot walk it anywhere.
    """
    fields = identity_fields(head)
    named = {k for k in identity if not k.startswith("@")}
    if not fields or not named or named & set(fields):
        return identity
    # Through the bindings, because the list itself may sit behind one: the groups of `contributions.3`
    # are the groups of whichever indicator that pin names (V186).
    items = bound_lookup(head, data, bindings)
    if not isinstance(items, list):
        return identity
    matches = [item for item in items if identity_matches(item, identity)]
    if len(matches) != 1:
        return identity
    strong = identity_of(matches[0], fields)
    if not strong or [item for item in items if identity_matches(item, strong)] != matches:
        return identity
    return {**strong, **_label_of(head, matches[0])}


def _label_of(head: str, entry: Any) -> dict[str, str]:
    """The LABEL_KEY entry for a pin on this list, or nothing — see LABEL_KEY."""
    field = IDENTITY_LABELS.get(registry_key(head))
    if not field or not isinstance(entry, dict):
        return {}
    label = str(entry.get(field) or "").strip()
    return {LABEL_KEY: label} if label else {}


def _by_identity(items: Any, identity: dict[str, Any]) -> Any:
    """The member of `items` matching `identity`, wherever it now sits — None if it is gone.

    Takes the list rather than a path, because the list itself may sit behind a binding: the groups of
    `contributions.3` are found by the indicator's identity first and only then indexed.
    """
    if not isinstance(items, (list, tuple)):
        return None
    for item in items:
        if identity_matches(item, identity):
            return item
    return None


#: The constants `factor` may scale a figure by: unit conversions, and nothing else. A `factor` with any
#: other constant turns a figure from the data into a figure from nowhere — `factor(x, 0.001)` printed a
#: 5 kg result as 5 000 and the sentence called it a climate impact. The sentence
#: still has to write the converted unit; the gate checks that (`report_prompts._unit_mismatch_findings`).
CONVERSION_FACTORS: tuple[float, ...] = (1000.0, 0.001, 100.0, 0.01, 1_000_000.0, 0.000001)


def is_conversion_factor(value: float) -> bool:
    return any(abs(value - k) <= k * 1e-9 for k in CONVERSION_FACTORS)


def _category_in(node: Any, tail: str) -> str | None:
    """The impact category a node or one of the containers along `tail` inside it names."""
    current = node
    for part in [""] + tail.split("."):
        if part:
            current = current.get(part) if isinstance(current, dict) else None
        if not isinstance(current, dict):
            break
        label = current.get("method_label")
        if isinstance(label, str) and label.strip():
            return label.strip()
        method = current.get("method")
        if isinstance(method, str) and method.strip():
            return method.strip()
    return None


def category_of(
    path: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None = None
) -> str | None:
    """The impact category a numeric path belongs to (its method label), or None when the data does not say.

    The unit alone is not the quantity: two human-toxicity categories both print CTUh, two climate
    indicators both print kg CO2-Eq, and summing either pair is the single score ISO 14044 forbids —
    which the unit check waved through. Read through the bindings like
    `bound_unit_of`: the groups of `contributions.3` belong to whichever indicator that pin names.
    The flat `contribution`, `hotspots` and `inventory` views are the leading indicator's — the first
    result's. None means unknown, never "no category": a check on this stays silent then.
    """
    walked = _bound_walk(path, data, bindings)
    if walked is not None and walked[0] is not None:
        node, tail = walked
        found = _category_in(node, tail)
        if found:
            return found
    parts = path.split(".")
    for cut in range(len(parts) - 1, 0, -1):
        node = lookup(".".join(parts[:cut]), data)
        if isinstance(node, dict):
            found = _category_in(node, "")
            if found:
                return found
    if parts[0] in ("contribution", "hotspots", "inventory"):
        results = data.get("results") or []
        lead = results[0] if results and isinstance(results[0], dict) else None
        label = (lead or {}).get("method_label")
        return str(label).strip() if isinstance(label, str) and label.strip() else None
    return None


def _derive_raw(
    token: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None = None
) -> tuple[str, list[str], float | None, str | None]:
    """Evaluate a derivation to its raw number. Returns (name, args, result, error).

    Arguments resolve through `bound_lookup`, like every plain placeholder: a chapter that binds
    `hotspots.0` to a member keeps deriving from *that* member after the ranking changes. Positional
    lookup here let one sentence print the bound member's share next to a percentage computed from
    whoever now occupies the index."""
    name, _, args_text = token[:-1].partition("(")
    name = name.strip()
    spec = DERIVATIONS.get(name)
    if spec is None:
        return name, [], None, f"unknown derivation '{name}'; available: {', '.join(sorted(DERIVATIONS))}"
    arity, fn, _is_percent = spec
    args = [a.strip() for a in args_text.split(",") if a.strip()]
    if arity is None:
        if len(args) < 2:
            return name, args, None, f"{name} needs at least two values"
    elif len(args) != arity:
        return name, args, None, f"{name} needs exactly {arity} values, got {len(args)}"

    numbers: list[float] = []
    units: dict[str, str] = {}
    for arg in args:
        if is_number(arg):
            numbers.append(float(arg.replace(",", ".")))
            continue
        value = bound_lookup(arg, data, bindings)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            split = ranked_prefix(arg)
            if value is None and split and bindings and bindings.get(f"{split[0]}.{split[1]}"):
                return name, args, None, (
                    f"'{arg}' is bound to a member that is no longer in this report's data"
                )
            return name, args, None, f"'{arg}' is not a number in this report's data"
        numbers.append(float(value))
        unit = bound_unit_of(arg, data, bindings)
        if unit:
            units[arg] = unit

    # Constants, and where they are allowed. A derivation with no data operand at all is a figure the
    # check cannot stand behind ({{sum(999, 0)}} resolved to 999 against an empty snapshot); a constant
    # added to a kg figure changes the quantity, a constant added to a share is percentage points and
    # fine; `percent` and `change` compare two data figures and take no constant; `factor` scales, and
    # the only scaling a sentence can write a correct unit for is a unit conversion.
    paths = [a for a in args if not is_number(a)]
    constants = [float(a.replace(",", ".")) for a in args if is_number(a)]
    if not paths:
        return name, args, None, (
            f"{name}({', '.join(args)}) uses only constants. A derivation needs at least one value from "
            "this report's data — a figure with nothing behind it is a figure the check cannot stand "
            "behind. Write the placeholder that carries the result, or leave the number out."
        )
    if constants:
        if name in ("percent", "change") and not all(
            a.endswith(PERCENT_ARG_SUFFIXES) or units.get(a) == "%" for a in paths
        ):
            return name, args, None, (
                f"{name} takes two values from the data, not a constant: it says how one figure relates "
                "to another. For a fixed share, write the figure the data carries."
            )
        if name in ("sum", "diff") and not all(
            a.endswith(PERCENT_ARG_SUFFIXES) or units.get(a) == "%" for a in paths
        ):
            shown = next((f"{a} in {u}" for a, u in units.items()), paths[0])
            return name, args, None, (
                f"{name} adds a constant ({constants[0]:g}) to {shown}, which changes the quantity. A "
                "constant may only be added to or taken from a share (percentage points). Use the figure "
                "the data carries; for a unit conversion use factor with 1000 or 0.001."
            )
        if name == "factor" and not all(is_conversion_factor(c) for c in constants):
            return name, args, None, (
                f"factor scales a figure by {constants[0]:g}, and only unit conversions are allowed here "
                f"({', '.join(f'{k:g}' for k in CONVERSION_FACTORS)}) — the sentence then has to write the "
                "converted unit. For a share of a figure write percent(part, whole); for a quantity per "
                "other reference, name the parameter that carries it."
            )

    # Indicators do not share a unit, and combining them is not a formatting problem but a normative one:
    # a figure adding kg CO2-Eq to MJ-Eq is a single score, which ISO 14044 does not permit for a
    # comparative assertion. Every derivation is affected, not only `sum` — a percentage of an unlike
    # quantity is just as meaningless as a total of one. Silent when a unit is unknown.
    if len(set(units.values())) > 1:
        listed = ", ".join(f"'{arg}' in {unit}" for arg, unit in units.items())
        return name, args, None, (
            f"{name} mixes units ({listed}). Impact categories cannot be combined into one figure — "
            "that would be a single score, which ISO 14044 does not allow for a comparative assertion. "
            "Give each category its own placeholder and let the sentence name them separately."
        )

    # …and the same unit is not the same quantity: cancer and non-cancer toxicity
    # both print CTUh. Shares are exempt as above; silence wherever a category is unknown.
    categories = {
        a: c
        for a in paths
        if not (a.endswith(PERCENT_ARG_SUFFIXES) or units.get(a) == "%")
        and (c := category_of(a, data, bindings)) is not None
    }
    if len(set(categories.values())) > 1:
        listed = "; ".join(f"'{a}' belongs to {c}" for a, c in categories.items())
        return name, args, None, (
            f"{name} combines two impact categories ({listed}). The same unit does not make them one "
            "quantity — combining categories is a single score, which ISO 14044 does not allow for a "
            "comparative assertion. Give each category its own placeholder and let the sentence name "
            "them separately."
        )

    result = fn(*numbers)
    if result is None:
        return name, args, None, f"{name} cannot divide by zero here"
    return name, args, float(result), None


def derive_value(
    token: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None = None
) -> tuple[float | None, str | None]:
    """The raw number a derivation evaluates to — for checkers that compare rather than print.

    The claims checker used to parse the number back out of the *formatted English string*, where the
    thousands separator became a decimal point (2,500 → 2.5) and scientific notation lost its exponent
    (1.50e+04 → 1.5004) — false blocking contradictions on correct sentences."""
    _name, _args, result, error = _derive_raw(token, data, bindings)
    return result, error


def derive(
    token: str,
    data: dict[str, Any],
    lang: str,
    *,
    raw: bool = False,
    bindings: dict[str, dict[str, Any]] | None = None,
) -> tuple[str | None, str | None]:
    """Evaluate a derivation. Returns (text, error) — exactly one of them is set.

    Errors name the next step, the same rule as everywhere else: a rejection a model cannot learn from
    produces a repeat loop.
    """
    name, args, result, error = _derive_raw(token, data, bindings)
    if error:
        return None, error
    assert result is not None
    # A sum of percentages is itself a percentage; nothing else in the data says so, and a
    # bare "93.5" in a sentence about shares is exactly the kind of naked number the gate exists to stop.
    # A *difference* of two shares is not a share but a count of percentage points (V168), so it prints
    # the bare number and the sentence supplies the words — `prints_own_unit` says the same.
    # Judged over the path arguments only, the same set `prints_own_unit` reads: a numeric constant has
    # no unit to disagree, and counting it made the two sides contradict each other — the gate waved the
    # sentence through without a unit while the document printed a naked number.
    paths = [a for a in args if not is_number(a)]
    percentage = DERIVATIONS[name][2] or (
        name == "sum" and bool(paths) and all(a.endswith(PERCENT_ARG_SUFFIXES) for a in paths)
    )
    if percentage:
        return f"{fmt_number(result, lang, digits=1)} %", None
    if name == "factor":
        return fmt_number(result, lang, digits=2), None
    return render_value(result, lang, raw=raw), None


def resolve(
    text: str,
    data: dict[str, Any],
    lang: str = "en",
    bindings: dict[str, dict[str, Any]] | None = None,
    values: dict[str, str] | None = None,
    scope: str | None = None,
    plain: bool = False,
) -> tuple[str, list[str]]:
    """Substitute placeholders in `text`.

    Returns the resolved text plus the paths that could not be resolved. Unresolved ones stay visible
    as ``[missing: path]`` so a hole is obvious in the PDF instead of being an invisible gap.

    `bindings` pins ranked indices to the member they meant when the chapter was written, so a sentence
    about the dominant process keeps talking about that process after the ranking changes. A bound member
    that has vanished from the list is reported as missing rather than silently replaced by whoever now
    occupies the index — that would be the same sentence about a different thing.

    `plain` renders for a **reader** instead of for the compiler. For the document, translating the
    author's markup to Typst is the whole job; for a *preview* it is noise — the correction dialog
    promises the replacement "as the document will read it" and printed
    `#emph[packaging glass production, white]` under a diff that showed the same words in italics
    (V167). The same promise binds everything else the compiler alone understands: a cross-reference
    names its table rather than showing `@t-sensitivity` (V183), an escaped name loses its
    backslashes, and a gap marker prints the path the author wrote. What `plain` may never do is
    change the *document* — the render path is the other half, and it still emits Typst.

    Pass `values` to emit `#pval("token")` calls and collect the formatted strings there instead of
    inlining them. The compiled document then reads them from a file, which is what makes an exported
    Typst project pick up new numbers on its own — inlined figures are fixed text the moment they are
    written.
    """
    missing: list[str] = []
    text = unfence(text)
    # The declaration beside its own label prints one name, not two (V434) — the stored
    # text keeps both tokens, so the checks still see the declaration; only the print is folded.
    text = collapse_declaration_pairs(text)
    # The scope lands inside a Typst string literal; anything outside this charset would end it.
    scope = re.sub(r"[^A-Za-z0-9_-]", "-", scope) if scope else None

    def emit(token: str, text: str) -> str:
        # A preview shows the figure, never the call that fetches it: `#pval("results.0.score")` is
        # the same kind of leak as `@t-sensitivity`, and it would also write preview strings into a
        # values file meant for the compiler. No caller asks for both today; this makes sure the
        # first one that does gets the harmless half.
        if values is None or plain:
            return text
        # The bare token stays in the file for compatibility: chapter files in an exported bundle are
        # the user's, and "update only the data" must keep satisfying the `#pval` calls they already
        # contain. It is last-write-wins across sections — which is exactly the collision `scope`
        # exists to end: two chapters citing the same ranked token with different bindings each print
        # their own value only if their `#pval` keys are their own.
        values[token] = text
        # The trailing `;` is Typst's explicit end of an embedded expression. Without it the compiler
        # takes the author's own semicolon as that terminator and drops it: `{{rank:…}}; es erhöht` printed
        # "Ersatzschlauch nach 5 Jahren es erhöht" in an earlier modelling session (V401). With it, whatever
        # follows the call — a semicolon, a full stop, a word — is markup again and prints as written.
        if scope is None:
            return f'#pval("{token}");'
        values[f"{scope}:{token}"] = text
        return f'#pval("{scope}:{token}");'

    def sub(match: re.Match[str]) -> str:
        token = match.group(1)
        if token.startswith("ref:"):
            label = token[4:].strip()
            # Only what a Typst label may be: the placeholder charset is wider (it allows `[`/`]` for
            # paths), and emitting those raw after `@` can close a surrounding block instead of being
            # reported as a bad reference.
            if not label or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", label):
                missing.append(token)
                return "[missing reference]"
            # A preview is read, not compiled: `@t-sensitivity` is the instruction, "Table 8" is the
            # result, and the dialog showed the instruction (V183). The number is Typst's and only
            # exists once the whole document is set, so the preview names the table instead.
            return ref_phrase(label, lang) if plain else f"@{label}"
        if token.startswith(RANK_PREFIX):
            name = rank_name(token, data, bindings)
            if name is None:
                # An unknown path, reported as one — whether the member is gone, the path names a
                # figure instead of a member, or the list was never magnitude-ranked. The gate turns
                # this into its `unresolved_placeholder` refusal and the export gate into a reported
                # gap, both without knowing what a declaration is.
                missing.append(token)
                return f"[missing: {token if plain else esc(token)}]"
            return emit(token, render_value(name, lang, raw=values is not None or plain))
        if token.endswith(")"):
            text, error = derive(token, data, lang, raw=values is not None, bindings=bindings)
            if error:
                missing.append(f"{token} — {error}")
                return f"[missing: {token if plain else esc(token)}]"
            return emit(token, text or "")
        value = bound_lookup(token, data, bindings)
        if value is None:
            missing.append(token)
            return f"[missing: {token if plain else esc(token)}]"
        # `raw` here means "do not escape for Typst". True for the values file because Typst inserts a
        # string literally, and true for a preview for the same reason V167 exists: a dataset called
        # `PVC_window` is `PVC\_window` to the compiler and `PVC_window` to a reader.
        return emit(token, render_value(value, lang, raw=values is not None or plain))

    # Placeholders out first, then the author's own words are escaped and their markup translated, then
    # the placeholders back in. Masking rather than working segment by segment, so emphasis *across* a
    # placeholder ("**{{results.0.score}} kg**") still works — and so `markup` never sees, and therefore
    # cannot escape, the Typst that `sub` deliberately emits.
    emitted: list[str] = []

    def stash(match: re.Match[str]) -> str:
        emitted.append(sub(match))
        return f"\x00{len(emitted) - 1}\x00"

    masked = PLACEHOLDER.sub(stash, text or "")
    # A preview shows what the document will read like. Everything the compiler alone understands is
    # therefore worked out here instead of shown — the translation to Typst above all, and with it the
    # one construct the translation *deletes*: a code fence, whose backticks the page never prints
    # (`report_model.drop_code_fences`). What survives the render survives the preview, which is why
    # the author's emphasis markers stay put: the page prints those words, in italics (V167).
    rendered = drop_code_fences(masked) if plain else esc_markup(masked)
    restored = re.sub(r"\x00(\d+)\x00", lambda m: emitted[int(m.group(1))], rendered)
    return restored, missing


def explain(
    text: str,
    data: dict[str, Any],
    lang: str = "en",
    bindings: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """The chapter split into the author's words and its placeholders, each worked out.

    What this answers is "which number is that, and where does it come from?" — a question the editor
    could not answer at all: the chapter shows `{{contribution.groups.0.share_percent}}` and the
    document shows `60.2 %`, and nothing said that the row in question is *Packaging*, still less that
    the sentence is pinned to Packaging rather than to whatever is largest today.

    Resolution goes through ``resolve`` one placeholder at a time rather than reimplementing it, so
    what the editor shows and what the document prints cannot drift apart — a second implementation of
    the substitution rules is exactly the kind of thing that agrees for a year and then does not.
    """
    parts: list[dict[str, Any]] = []
    position = 0
    # The same de-fencing the document gets, or the editor would show backticks the page will not.
    text = unfence(text)
    for match in PLACEHOLDER.finditer(text):
        if match.start() > position:
            parts.append({"kind": "text", "text": text[position:match.start()]})
        token = match.group(1)
        # `plain`: this is the editor's "what does it actually say" view, read by a person and never
        # compiled — the same audience as the correction dialog, so the same rule (V167, V183). It
        # used to show `@t-sensitivity` for a reference and backslashes in a dataset name.
        rendered, missing = resolve(match.group(0), data, lang, bindings, plain=True)
        entry: dict[str, Any] = {
            "kind": "ref" if token.startswith("ref:") else "value",
            "token": token,
            "text": rendered,
            "missing": bool(missing),
        }
        # Which member of a ranked list the sentence is talking about. The binding first: that is the
        # promise the chapter was written under, and it is the whole point of showing this.
        # Through `rank_path` so a declaration shows its member and its pin like any other citation:
        # the editor's whole job here is saying which member a sentence is tied to, and a declaration
        # is the token that says so out loud.
        split = ranked_prefix(rank_path(token) or token)
        if split:
            head, index, _rest = split
            identity = (bindings or {}).get(f"{head}.{index}")
            if identity is None:
                member = lookup(f"{head}.{index}", data)
                # Label included, so an unpinned index reads the same way a pinned one does: the
                # editor's line for a scenario says its name, not the uuid behind it.
                identity = (
                    {**identity_of(member, identity_fields(head)), **_label_of(head, member)}
                    if member
                    else None
                )
            if identity:
                entry["member"] = describe_identity(identity)
                entry["pinned"] = bool((bindings or {}).get(f"{head}.{index}"))
        parts.append(entry)
        position = match.end()
    if position < len(text or ""):
        parts.append({"kind": "text", "text": text[position:]})
    return parts


def bound_lookup(
    path: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None
) -> Any:
    """Resolve a path, honouring a stored identity binding at every ranked index it crosses.

    Outermost first, and each level is entered through the member its own pin names: the indicator is
    found by `method_label`, and only inside *that* entry is the phase found by `key`. Resolving the
    inner pin against a positionally-taken outer list is how a correct phase pin came to print the
    wrong indicator's figure (V186) — the group "Packaging" exists in every indicator's breakdown, so
    the wrong list still had an answer.
    """
    walked = _bound_walk(path, data, bindings)
    if walked is None:
        return lookup(path, data)
    node, tail = walked
    if node is None:
        return None
    return lookup(tail, node) if tail else node


def bound_unit_of(
    path: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None
) -> str | None:
    """`unit_of` through the stored bindings: the unit of the member the pin names, not of whatever sits
    at that position today. Read by position, a `sum` of two pinned mass parameters compared metres
    with kilograms once a length parameter sorted in above them — and refused a correct figure as a
    unit mix."""
    walked = _bound_walk(path, data, bindings)
    if walked is None:
        return unit_of(path, data)
    node, tail = walked
    if node is None or not tail or not isinstance(node, dict):
        return None
    return unit_of(tail, node)


def _bound_walk(
    path: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None
) -> tuple[Any, str] | None:
    """Walk a path through its ranked levels, honouring the pins — `(node, tail)`, where `tail` is what
    is left to look up inside `node`; None when the path crosses no ranked list (plain lookup applies);
    `(None, …)` when a pinned member is gone."""
    splits = ranked_splits(path) if bindings else []
    if not splits or not bindings:
        return None
    node: Any = data
    walked = ""
    tail = path
    for head, index, rest in splits:
        # The step from the level already entered to this level's list — `groups`, not
        # `contributions.3.groups`, because `node` is already the indicator.
        step = head[len(walked) + 1 :] if walked else head
        items = lookup(step, node) if step else node
        identity = bindings.get(f"{head}.{index}")
        if identity:
            node = _by_identity(items, identity)
            if node is None:
                return None, tail  # bound member gone — reported, never substituted by position
        else:
            # No pin at this level: by position, which is what a chapter written before this level was
            # registered has. Such a chapter keeps the old behaviour until it is next written or
            # corrected — `bindings_for` binds the missing key then, against the data of that moment,
            # because nothing in the snapshot records which indicator the sentence *meant*.
            node = lookup(str(index), items)
        if node is None:
            return None, tail
        walked = f"{head}.{index}"
        tail = rest
    return node, tail


def rank_name(
    token: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None = None
) -> str | None:
    """What a ``{{rank:…}}`` declaration prints — the declared member's name, or None for a gap.

    Through `bound_lookup` like every other placeholder, so the pin decides which member is printed.
    That is not a detail: a declaration is a claim about a *member*, and printing whoever occupies the
    index today would be the same sentence about a different thing — the failure bindings exist to
    prevent. So after a ranking flips, the sentence keeps naming the member it was written about and
    the rank verdict says the claim no longer holds; the author sees a wrong claim, not a silently
    rewritten one.

    A member that has vanished returns None and prints ``[missing: …]``, exactly as a vanished member
    does for `{{contribution.groups.0.share_text}}`.

    The name comes out of the member's **identity** (`member_label`), so what is printed is what the
    binding is on — the key as the data spells it, deliberately untranslated (V193). Where the identity
    is an identifier and the name sits beside it (`IDENTITY_LABELS`), that name is read too, the same
    merge `bindings_for` and `explain` already make: a variant is pinned by its process-and-state key
    and *called* by its label, and printing "variant=fef2…" would name the defect, not the variant.
    """
    claim = rank_claim(token)
    if claim is None:
        return None
    head, index = claim
    entry = bound_lookup(f"{head}.{index}", data, bindings)
    identity = {**identity_of(entry, identity_fields(head)), **_label_of(head, entry)}
    if not identity:
        return None
    return member_label(identity) or None


def numeric(value: Any) -> float | None:
    """A snapshot value that counts as a number — bools excluded, everything else refused as None.

    One definition beside `bound_lookup`, whose results it judges: the claim gate and the staleness
    verdicts each carried a copy, and a rule that disagrees with its sibling about what a number is
    reports drift nobody caused."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
