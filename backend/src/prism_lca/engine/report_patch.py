"""Correcting a sentence instead of a chapter.

When a finding says a chapter's wording no longer holds (``report_staleness``), the expensive answer
is to regenerate the chapter: the author then has to re-read two thousand characters because three
words went false, and every phrasing they had settled on is gone. The cheap answer is a **patch** —
a handful of exact string replacements, shown as a diff, accepted one by one.

Two things make that safe rather than clever:

**The spot is found mechanically.** No model searches the prose for judgement words. A finding
already names the data path whose class or rank moved, and that path *sits in the text* as a
placeholder; a selection finding names the literal strings the prose spells out. So this module can
hand the model the affected sentences and nothing else.

**The reply is verified without a model.** A replacement must match exactly once, must carry exactly
the same placeholders, must leave a text the existing gate still accepts, and must stay inside a
size bound — beyond it, a "patch" is a rewrite wearing a smaller coat, and the honest move is to say
so. A model may also declare a span unfixable, which escalates cleanly instead of papering over the
damage with three words.

The replacement contract is deliberately the one the in-app assistant already speaks — ``{old, new}``,
exact bytes, no fuzzy matching, ambiguity refused rather than guessed at (``main/ai/reportWriter.ts``
``applyPatch``). One vocabulary for "change exactly this passage",
whether the request comes from the assistant or from a staleness finding.
"""
from __future__ import annotations

import difflib
import re
from typing import Any

from prism_lca.engine import report_data as rd
from prism_lca.engine import report_sentences

#: More than this many replacements is not a correction any more.
MAX_EDITS = 6

#: …and neither is one that rewrites more than this share of the chapter. Measured on the whole text
#: rather than per edit, because six small edits can still add up to a different chapter.
MAX_CHANGED_FRACTION = 0.25

#: Below this length the share is meaningless and only `MAX_EDITS` counts. A three-sentence executive
#: summary is a few hundred characters, and one legitimate correction in it — "dominates" to
#: "is the largest single contributor" — is a quarter of the chapter by character count while being
#: exactly the surgical change this module exists for. The bound is there to catch a rewrite wearing a
#: correction's coat, and a rewrite of a short chapter is caught by the edit count instead.
MIN_TEXT_FOR_FRACTION = 600

def sentences(text: str) -> list[tuple[int, int]]:
    """(start, end) of each sentence, so a finding can be reported with its own words around it.

    The rule lives in ``report_sentences`` — one implementation for the module that judges a
    sentence (``report_claims``) and this one, which decides which sentence gets quoted.
    """
    return report_sentences.sentence_spans(text)


def sentence_at(text: str, offset: int) -> str:
    for start, end in sentences(text):
        if start <= offset < end:
            return text[start:end].strip()
    return text.strip()


def _binding_keys(text: str) -> set[str]:
    """The `head.index` keys a piece of text pins — the same keys `bindings_for` would store for it.

    "The same keys" is the whole contract, so this walks every level of a path exactly as
    `bindings_for` does. Taking only the innermost would leave a surviving sentence's *indicator* pin
    out of `surviving_bindings`, and a typo fixed elsewhere would then re-point it at today's method
    order — the V180 failure, one level up.
    """
    keys: set[str] = set()
    for token in rd.placeholders_in(text):
        for path in rd.paths_in_token(token):
            for head, index, _rest in rd.ranked_splits(path):
                keys.add(f"{head}.{index}")
    return keys


def surviving_bindings(
    before: str, after: str, bindings: dict[str, dict[str, Any]] | None
) -> dict[str, dict[str, Any]]:
    """The pins a hand edit may not move: those cited by a sentence the edit left standing.

    ``bindings_for`` puts it as the rule — "a pin only moves when the author rewrites the sentence that
    made the claim" — and this is the sentence-level reading of it, for the one path that had no reading
    at all. A hand edit used to re-bind the whole chapter against today's ranking (V180): fixing a typo
    three paragraphs above a sentence that named two incineration datasets by hand and cited
    ``{{hotspots.2.share_text}}`` moved that figure onto whatever sits at position two today, under the
    names the author had typed. Nothing looked broken — the yellow badge went with it.

    Comparison is by whole sentence, stripped, so reflowing whitespace is not a rewrite. A key cited by
    any surviving sentence keeps its member even if a rewritten sentence cites it too: the surviving
    claim is still on the page and still means what it meant.

    What this deliberately does not catch: a typo fixed *inside* the pinned sentence itself re-points
    it. That is the price of having no other signal for "the author retargeted this claim", and it is
    the one case where the author is looking straight at the sentence in question.
    """
    if not bindings:
        return {}
    standing = {before[a:b].strip() for a, b in sentences(before)}
    survived: set[str] = set()
    for start, end in sentences(after):
        sentence = after[start:end].strip()
        if sentence in standing:
            survived |= _binding_keys(sentence)
    return {key: value for key, value in bindings.items() if key in survived}


def surviving_caption_bindings(
    before: dict[str, Any], after: dict[str, Any], bindings: dict[str, dict[str, Any]] | None
) -> dict[str, dict[str, Any]]:
    """The pins cited by a figure caption that `after` still carries word for word.

    `surviving_bindings` for a chapter's figure captions, over their own pins (`caption_bindings`): a
    caption is one unit, so "unchanged" is the whole caption. Used when captions change in the figure
    editor — the member an untouched caption was written about must not follow the list's position
    just because a neighbouring caption was edited.
    """
    if not bindings:
        return {}
    standing = {c.strip() for c in rd.captions_of(before)}
    survived: set[str] = set()
    for caption in rd.captions_of(after):
        if caption.strip() in standing:
            survived |= _binding_keys(caption)
    return {key: value for key, value in bindings.items() if key in survived}


def _bounds_at(text: str, offset: int) -> tuple[int, int]:
    """The sentence around `offset` as a range, for asking whether a replacement overlapped it."""
    for start, end in sentences(text):
        if start <= offset < end:
            return start, end
    return 0, len(text)


def unaddressed(
    original: str, findings: list[dict[str, Any]], applied: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """The findings no applied replacement went near.

    A correction round hands the model every finding of the chapter and gets back replacements for
    some of them. Storing the result used to re-stamp the chapter's whole record against today's data,
    which declared the *untouched* sentences current as well: five demonstrably false sentences went
    out under a green badge, two of them contradicting the corrected sentence beside them (V162,
    an apple-juice run). What the model did not fix is still wrong, and the chapter has to keep
    saying so.

    "Went near" is deliberately generous — sentence overlap, not claim identity. A replacement inside
    the condemned sentence is taken as an answer to the finding even if it phrases around it, because
    the alternative (demanding that the finding stop firing) can never be satisfied for a rank change:
    the rank moved whatever the sentence now says. A finding that could not be located at all counts as
    unaddressed, which is the same thing the brief already tells the author under "no sentence to point
    at".

    Located the same three ways `_spans_and_gaps` locates one — path, name, and the sentence a finding
    carries verbatim. The third was missing here while the brief already had it, so a finding whose only
    handle is its own sentence could be handed to the model, corrected, and still counted as untouched:
    a permanent badge on a chapter that had just been put right. The one kind that has no other handle
    is a claim to the top made in words, with no placeholder in the sentence at all (V206).
    """
    replaced: list[tuple[int, int]] = []
    for edit in applied:
        find = str(edit.get("old") or "")
        if not find:
            continue
        at = original.find(find)
        while at >= 0:
            replaced.append((at, at + len(find)))
            at = original.find(find, at + 1)

    out: list[dict[str, Any]] = []
    for finding in findings:
        offsets: list[int] = []
        if finding.get("path"):
            offsets = _offsets_of_path(original, str(finding["path"]))
        for name in finding.get("names") or []:
            offsets.extend(_offsets_of_literal(original, str(name)))
        if finding.get("sentence"):
            at = original.find(str(finding["sentence"]))
            if at >= 0:
                offsets.append(at)
        if not offsets:
            out.append(finding)
            continue
        # EVERY sentence that reads the path, not any one of them: two sentences drawing the same false
        # conclusion from one share, one of them corrected, left the other standing while the finding
        # was counted as addressed and the chapter went green.
        touched = all(
            any(a < end and b > start for a, b in replaced)
            for start, end in (_bounds_at(original, offset) for offset in offsets)
        )
        if not touched:
            out.append(finding)
    return out


def _offsets_of_path(text: str, path: str) -> list[int]:
    """Where a data path is read in the text — inside a plain placeholder or a derivation's arguments.

    A path also matches the paths *below* it, and that is not a convenience: a rank finding names the
    ranked member, ``hotspots.0``, while prose can only ever cite a leaf of it —
    ``{{hotspots.0.name}}``, ``{{hotspots.0.share_percent}}``. Requiring the path to end where the
    placeholder ends meant "the largest may no longer be true" — the one finding this whole module was
    built for — never located a sentence, so every rank change came back "no sentence to point at" and
    the only remedy left was rewriting the chapter. The boundary is still a component boundary, so
    ``hotspots.0`` does not match ``hotspots.01``.
    """
    hits = []
    for match in rd.PLACEHOLDER.finditer(text):
        token = match.group(1)
        if token == path or re.search(rf"(?<![\w.]){re.escape(path)}(?![\w])", token):
            hits.append(match.start())
    return hits


def _offsets_of_literal(text: str, needle: str) -> list[int]:
    """Where a name is spelled out, tolerating the punctuation prose puts inside it.

    A strict match finds "EF v3.1" and walks past "Environmental Footprint (EF) v3.1" — which in a real
    report was the sentence that mattered, the one calling it the European Commission's reference
    method. The parts of the name must still appear in order; only what sits between them is allowed
    to vary.
    """
    parts = [re.escape(p) for p in re.split(r"\W+", needle) if p]
    if not parts:
        # Nothing word-shaped in it — an emoji, a lone symbol. The gate reports those literally, and
        # a finding that cannot be pointed at costs a correction round (V184), so fall back to the
        # plain occurrence rather than giving up.
        return [m.start() for m in re.finditer(re.escape(needle), text)] if needle else []
    pattern = r"(?<![\w])" + r"\W{0,3}".join(parts) + r"(?![\w])"
    return [m.start() for m in re.finditer(pattern, text)]


def spans_for(text: str, findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The sentences a finding actually touches, with the finding that points at them.

    This is what replaces a heuristic: the model is never asked to find the problem, only to phrase
    its way out of one that has already been located.
    """
    out, _unlocated = _spans_and_gaps(text, findings)
    return out


def unlocated_in(text: str, findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The other half of `spans_for`: the findings this text offers no sentence for.

    Worth having on its own because "can this be corrected at all?" is a question asked before a
    correction is offered, not only while one is written. A blocking gate finding nobody can point at
    is not a rephrasing job — see the staleness endpoint (V184).
    """
    _located, unlocated = _spans_and_gaps(text, findings)
    return unlocated


def _spans_and_gaps(
    text: str, findings: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The located sentences, and the findings nothing could be located for.

    A finding is found through a placeholder or a literal name. One carrying neither — or one whose
    path the chapter cites nowhere — has no sentence to hand over, and it used to fall out of the
    brief without a word: the correction then silently addressed fewer problems than the badge
    promised, and a chapter could come back "corrected" still carrying the finding. Handing the gaps
    back means the answer can say so.
    """
    out: list[dict[str, Any]] = []
    unlocated: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for finding in findings:
        offsets: list[int] = []
        if finding.get("path"):
            offsets = _offsets_of_path(text, str(finding["path"]))
        for name in finding.get("names") or []:
            offsets.extend(_offsets_of_literal(text, str(name)))
        if finding.get("sentence"):
            # A gate finding about an assertion knows no path and no name — it judged a whole
            # sentence ("claims the largest, but…"), and carries it verbatim. Exact match on
            # purpose: the sentence came out of this same text, and a fuzzy fallback would point the
            # model at a neighbour.
            at = text.find(str(finding["sentence"]))
            if at >= 0:
                offsets.append(at)
        if not offsets:
            unlocated.append(finding)
            continue
        for offset in offsets:
            sentence = sentence_at(text, offset)
            key = (finding.get("kind", ""), sentence)
            if sentence and key not in seen:
                seen.add(key)
                out.append({"sentence": sentence, "finding": finding.get("message", ""),
                            "kind": finding.get("kind", ""),
                            # Which claim in the sentence the finding is about. A sentence often makes
                            # two: "no single process dominates — the largest, X, contributes
                            # {{hotspots.0.share_text}} — but taken as a chain the NiMH cells form the
                            # largest supply chain". Handed the whole sentence and nothing else, a model
                            # softens both, and the report loses a statement that was never wrong
                            # (V159). The path is already in the finding; passing it on costs nothing.
                            "about": str(finding.get("path") or "")})
    return out, unlocated


def brief(
    section: dict[str, Any],
    findings: list[dict[str, Any]],
    language: str,
    selection: dict[str, Any] | None = None,
    gate: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Everything the model needs, and deliberately nothing else — no data dump, no other chapter.

    ``gate`` is the second half of the job, and it used to be missing. The staleness check says what
    to change; ``report_prompts.check_proposal`` decides whether the corrected chapter may be stored
    — and it reads the *whole* text, not the sentences the assignment named. So a chapter could be
    graded "one rephrasing away" and then refuse every correction over a sentence nobody had
    mentioned: measured on the PVC window report, where a strong parameter change dropped a named
    dataset out of the results and the gate rejected each attempt with “… does not appear in the
    study metadata”, while the brief only ever spoke about a rank (V184). The two checks now hand
    over the same task: what will refuse the answer is part of the assignment, with its sentence,
    and it is fixed in the same round — no second model call, no second dialogue.

    ``selection`` is what the report actually uses now. Without it a correction can only swap the
    name it was told about and will leave everything downstream of it standing: in the first real
    run, the method family was corrected from EF v3.1 to CML while the sentence naming EF's own
    water and land-use indicators stayed, which is a more convincing wrong chapter than the one we
    started with. With the true selection in hand, a model can see there is nothing to rename those
    to and mark the passage unfixable, which is the honest escalation.
    """
    text = section.get("text") or ""
    # The gate speaks `detail`, this module speaks `message`; one vocabulary from here on. Only
    # blocking findings belong here — an advisory one is a second read, not a repair job, and putting
    # it in a correction assignment asks the model to file down a chapter nobody objected to.
    refusals = [{**f, "message": f.get("detail") or f.get("message") or ""} for f in (gate or [])]
    all_findings = [*findings, *refusals]
    located, unlocated = _spans_and_gaps(text, all_findings)
    # A named thing can be referred to in ways no search can enumerate — "the EF method", "the
    # Commission's footprint method", a whole paragraph explaining it. So for a selection finding the
    # chapter itself comes along and the model may find the other mentions. That is a different job
    # from judging whether "dominates" still holds: the finding is still arithmetic, and every
    # replacement still has to survive the same verification.
    names_involved = any(f.get("names") for f in findings)
    out: dict[str, Any] = {
        "language": language,
        "chapter": section.get("title") or section.get("kind") or "",
        "findings": [f.get("message", "") for f in all_findings],
        "spans": located,
        # Repeated here because it is the rule the verification enforces, and a model told the rule
        # produces fewer refusals than one corrected by them.
        "rules": [
            "Change only the wording that the findings make wrong. Nothing else.",
            "A span's 'about' names the placeholder the finding is about. Change only the claim that "
            "refers to that placeholder — a sentence can carry a second claim about something else, "
            "and weakening it as well throws away a statement that is still true.",
            "Never touch a placeholder: {{…}} must appear in your replacement exactly as in the "
            "original, in the same order. Numbers are the placeholders' job, not yours.",
            "Never type a figure of your own.",
            f"At most {MAX_EDITS} replacements, together no more than "
            f"{int(MAX_CHANGED_FRACTION * 100)} % of the chapter.",
            "Answer with {\"edits\": [{\"old\": …, \"new\": …, \"why\": …}], \"unfixable\": […]}.",
            "'old' must occur exactly once in the chapter — include enough words around it — and must "
            "match verbatim, spaces and punctuation included.",
            "If a span cannot be put right by rephrasing — the passage explains something that is no "
            "longer the case — list it under 'unfixable' instead of forcing an edit.",
            # Two languages meet in one answer, and the model used to guess which was which: in two
            # real German reports the reasons came back German in one dialogue and mixed German and
            # English inside the next one (V188). The reason is the only field here that is *not* part
            # of the report — so it is the only field that is English. Spelled out in both directions
            # because getting this backwards is the expensive mistake: an English sentence patched into
            # a German chapter is a defect in the document a client receives.
            f"Write 'old' and 'new' in the chapter's language, which is {language}: the replacement is "
            f"printed. A chapter in {language} stays in {language} — a sentence in another language "
            "patched into it is a defect in the document a client receives.",
            "'why' is the exception, in 'edits' and in 'unfixable' alike: always English, whatever the "
            "chapter's language. It is a note to the author, shown beside the English labels of the "
            "correction dialogue, and it is never printed.",
        ],
        "unfixable_means": "the chapter needs rewriting; saying so is the right answer, not a failure",
        # Findings with no sentence to point at. Named rather than dropped: a correction that quietly
        # leaves one out looks like a clean job, and the badge would be back the moment it ran again.
        "unlocated": [f.get("message", "") for f in unlocated],
    }
    if names_involved:
        out["chapter_text"] = text
        out["rules"].insert(
            1,
            "The names in the finding may also appear spelled differently or paraphrased "
            "(“Environmental Footprint (EF) v3.1”, “the EF method”). Correct those mentions too — the "
            "full chapter is given for that reason, and for no other.",
        )
    if selection:
        out["report_uses"] = selection
        out["rules"].insert(
            2,
            "'report_uses' is what the study actually applies. A sentence that describes an indicator "
            "or a variant which is not in it cannot be repaired by renaming — there is nothing to "
            "rename it to. Put such a passage under 'unfixable'.",
        )
    if refusals:
        # Last insert, so it stands at the head of the list: it is the rule that decides whether the
        # round was worth paying for. A model that fixes only the findings it was previously shown
        # writes a correction the store refuses in one piece — a patch is all or nothing.
        out["rules"].insert(
            1,
            "Some findings are refusals from the check that runs on your answer, not suspicions: the "
            "chapter cannot be saved while any of them stands, even where they sit in a sentence the "
            "other findings never mention. Repair them in the same answer, or the whole correction is "
            "rejected.",
        )
    return out


#: The part of a ranked list's identity that is an *identifier* rather than a description.
#:
#: A dataset keeps its database and code when someone renames it; a subject keeps its code and its
#: scenario id. Those are the only lists where "the thing this sentence points at was renamed" can be
#: established rather than guessed. `contribution.groups` is keyed by the tag value itself and
#: `results` by the method label — rename one of those and there is no id left to recognise it by, so
#: nothing is offered and the author decides.
#:
#: The `subjects` entry never fires, and it is worth knowing why, because it looks like the natural home
#: for V221's "state a weak pin more strongly". It is not, in two independent ways. Its fields *were* the
#: whole identity a subjects pin carried, so a pin the full identity cannot find is a pin these fields
#: cannot find either — there is never anything to offer. And this function is the repair for a **hole**:
#: it runs where the member is gone and the sentence prints "[missing: …]", the panel counts it, and a
#: button says "the member was only renamed". A weak pin has no hole — it resolves, to *something* — so
#: strengthening it here would put that button on a chapter that looks fine and, in the ambiguous case
#: that actually matters, would move which variant a sentence resolves to with nothing on the page to
#: show for it. The strengthening therefore lives where a pin is legitimately re-stated anyway, on save
#: (`report_bindings._strengthened`), and only where it cannot change the answer.
STABLE_IDENTITY: dict[str, tuple[str, ...]] = {
    "hotspots": ("database", "code"),
    "subjects": ("code", "scenario"),
}


def rebindings(bindings: dict[str, dict[str, Any]], data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Bindings whose member only changed its name — the free repair.

    The text stays byte for byte; only the pointer is updated, and the ``[missing: …]`` hole closes.
    Offered exclusively where the match is certain: the identifying fields still agree and exactly one
    member carries them. Anything less is a guess about what a sentence is talking about, and a wrong
    guess is silent.
    """
    out: dict[str, dict[str, Any]] = {}
    for key, identity in (bindings or {}).items():
        head, _, _index = key.rpartition(".")
        fields = STABLE_IDENTITY.get(head)
        if not fields:
            continue
        stable = {f: identity[f] for f in fields if f in identity}
        if not stable or len(stable) != len([f for f in fields if f in identity]):
            continue
        items = rd.lookup(head, data)
        if not isinstance(items, list):
            continue
        # Still there under the full identity? Then nothing is broken and nothing is offered.
        if any(rd.identity_matches(i, identity) for i in items):
            continue
        matches = [
            i for i in items
            if isinstance(i, dict) and all(i.get(k) == v for k, v in stable.items())
        ]
        if len(matches) == 1:
            out[key] = rd.identity_of(matches[0], rd.identity_fields(head) or tuple(identity))
    return out


def rank_swaps(findings: list[dict[str, Any]]) -> dict[str, str]:
    """The placeholder swaps a correction may make: ranked token → the same member's stable path.

    A rank finding whose member has a stable path (`report_staleness._stable_path`) tells the model to
    cite `{{subjects.N.label}}` instead of `{{rank:results.0.subjects_by_score.0}}` once the sentence
    stops claiming the position. That swap changes the placeholder set, which `apply_edits` otherwise
    refuses — rightly, because a swapped placeholder usually means a swapped figure. Here the two
    tokens print the same member's name, so the exchange is allowed, and only this one (V423 follow-up:
    the first run after the exit was added refused every chapter's correction with "the
    placeholders differ between find and replace").
    """
    swaps: dict[str, str] = {}
    for f in findings or []:
        path, stable = str(f.get("path") or ""), str(f.get("stable") or "")
        if f.get("kind") != "ranks" or not path or not stable:
            continue
        swaps[f"rank:{path}"] = f"{stable}.label"
        swaps[f"{path}.label"] = f"{stable}.label"
        # The ranked member's figures have a stable home too: `results.I.subjects_by_score.K.score` is
        # `subjects.N.results.I.score` (the LCI chapter cited the score, and its correction was refused
        # three times because only the label was mapped).
        m = re.match(r"^results\.(\d+)\.subjects_by_score\.\d+$", path)
        if m and stable.startswith("subjects."):
            for field in ("score", "unit"):
                swaps[f"{path}.{field}"] = f"{stable}.results.{m.group(1)}.{field}"
    return swaps


def _swapped(tokens: list[str], swaps: dict[str, str] | None) -> list[str]:
    return [swaps.get(t, t) for t in tokens] if swaps else list(tokens)


def _placeholders_agree(before: list[str], after: list[str], swaps: dict[str, str] | None) -> bool:
    """Whether the placeholder sequence after an edit is the one before it — or one the swaps allow.

    Allowed beyond identity: any ranked token mapped to its member's stable path (`rank_swaps`), and
    a declaration `{{rank:…}}` DROPPED where the same member's label stays in the sentence — the
    writer's habit of `„{{…label}}“ ({{rank:…}})` (V402) leaves two tokens for one name, and the
    correction the finding asks for keeps the name and drops the declaration (measured:
    three rounds refused with "the placeholders differ" over exactly this)."""
    if before == after:
        return True
    if not swaps:
        return False

    def fits(xs: list[str], ys: list[str]) -> bool:
        return len(xs) == len(ys) and all(x == y or swaps.get(x) == y for x, y in zip(xs, ys, strict=True))

    if fits(before, after):
        return True
    declared = {t for t in swaps if t.startswith("rank:")}
    without = [
        t for t in before
        if not (t in declared and (swaps[t] in after or t[len("rank:"):] + ".label" in after))
    ]
    return fits(without, after)


def apply_edits(
    text: str, edits: list[dict[str, Any]], swaps: dict[str, str] | None = None
) -> dict[str, Any]:
    """Apply the replacements, refusing any that is not exactly what it claims to be.

    Every rule here is arithmetic. Nothing is asked of a model, and nothing that fails a rule is
    shown to the author as if it were a suggestion. ``swaps`` (see `rank_swaps`) names the one kind
    of placeholder change a correction may make — a ranked token for the same member's stable path.
    """
    problems: list[str] = []
    if len(edits) > MAX_EDITS:
        return {
            "ok": False,
            "text": text,
            "applied": [],
            "problems": [f"{len(edits)} replacements — more than {MAX_EDITS} is a rewrite, not a "
                         "correction"],
        }

    current = text
    applied: list[dict[str, Any]] = []
    for index, edit in enumerate(edits, start=1):
        find = str(edit.get("old") or "")
        replace = str(edit.get("new") or "")
        if not find:
            problems.append(f"edit {index}: nothing to find")
            continue
        if find == replace:
            # Same refusal as the assistant's tool: a replacement that changes nothing is a mistake,
            # not a no-op, and silently accepting it hides that the model missed the point.
            problems.append(f"edit {index}: the replacement is identical to what it replaces")
            continue
        occurrences = current.count(find)
        if occurrences != 1:
            problems.append(
                f"edit {index}: “{find[:60]}” occurs {occurrences} times — a replacement has to be "
                "unambiguous"
            )
            continue
        if not _placeholders_agree(rd.placeholders_in(find), rd.placeholders_in(replace), swaps):
            problems.append(
                f"edit {index}: the placeholders differ between find and replace — figures are the "
                "placeholders' job"
            )
            continue
        current = current.replace(find, replace, 1)
        applied.append({"old": find, "new": replace, "why": str(edit.get("why") or ""),
                        "kind": str(edit.get("kind") or "")})

    # The whole chapter's placeholder sequence, not only each edit's halves: an edit INSIDE a
    # placeholder ("results.0.score" → "results.1.score") carries no complete placeholder on either
    # side, so the rule above let it through — and the sentence went on printing another indicator's
    # figure under the first one's unit, formally valid. Every placeholder the
    # chapter had has to be there afterwards, unchanged and in order; a correction never moves one.
    if not problems and not _placeholders_agree(rd.placeholders_in(text), rd.placeholders_in(current), swaps):
        problems.append(
            "the chapter's placeholders changed — an edit that alters the inside of a {{…}} is not a "
            "correction. Leave every placeholder exactly as it is and change the words around it."
        )

    changed = 1.0 - difflib.SequenceMatcher(None, text, current).ratio()
    if problems:
        # Nothing half-applied leaves this function. Some edits may have gone in before one was
        # refused, and `current` carries them; returning that text would break the promise this module
        # makes at the top of the file, and would hand a caller a chapter nobody wrote.
        # Checked before the size limit: the per-edit diagnoses are what the model can act on, and the
        # fraction of a partially-applied text that is being discarded describes nothing.
        return {"ok": False, "text": text, "applied": applied, "problems": problems,
                "changed_fraction": round(changed, 4)}

    if len(text) >= MIN_TEXT_FOR_FRACTION and changed > MAX_CHANGED_FRACTION:
        return {
            "ok": False,
            "text": text,
            "applied": [],
            "problems": [
                f"the replacements change {round(changed * 100)} % of the chapter — beyond "
                f"{int(MAX_CHANGED_FRACTION * 100)} % this is a rewrite and should be one"
            ],
        }

    return {"ok": bool(applied), "text": current, "applied": applied,
            "problems": problems, "changed_fraction": round(changed, 4)}


__all__ = ["MAX_CHANGED_FRACTION", "MAX_EDITS", "MIN_TEXT_FOR_FRACTION", "STABLE_IDENTITY",
           "apply_edits", "brief", "rank_swaps",
           "rebindings", "sentence_at", "sentences", "spans_for", "surviving_bindings",
           "surviving_caption_bindings"]
