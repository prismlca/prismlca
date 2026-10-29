"""The gate over written chapters: what may be stored, what a correction must clear, what blocks.

Moved out of `api/v1/report_ai.py`: the `section_proposal` transaction — snapshot,
figure validation, claim check, literal repair, second pass, gate journal, store, audit — is the
report module's most consequential use-case and was a 238-line route body. Here it is an engine
function with explicit inputs; the route is a thin caller. The helpers around it (`gate_refusals`,
`gate_block`, the correction-tried marker) are the same policy read by the staleness, patch and
accept endpoints, so they live beside the transaction rather than in a router the others import.

`audit` is whatever `report_audit.note` accepts — the routers pass their `Request`; the module is
deliberately web-free (see `report_audit`'s own docstring).
"""

from __future__ import annotations

from pydantic import BaseModel

from prism_lca.engine import report_audit, report_pipeline
from prism_lca.engine.report_pipeline import RenderRequest, significance
from prism_lca.engine.report_store import ReportStore
from prism_lca.errors import PrismError


class ProposalRequest(BaseModel):
    #: The proposed chapter text, with placeholders rather than literal numbers.
    text: str
    #: What the writer looked up while writing (`[{name, args, result}]`). The gate judges a chapter
    #: against what it was given, so a lookup has to be declared here — otherwise a correct explanation
    #: drawn from a real dataset comes back flagged as an unsupported fact.
    lookups: list[dict] | None = None
    #: The figure this chapter argues with: `{kind, source, value, caption}`, validated against a
    #: whitelist. A declarative spec rather than code — see report_prompts.accept_figure.
    figure: dict | None = None
    #: Store it when the gate passes. False = check only, which is what a preview does.
    store: bool = False
    #: Recorded with the text so a stale patch can be spotted later.
    model: str | None = None
    #: Which run this judgement belongs to, and the how-many-th attempt it is. Diagnostics only —
    #: they go into the gate journal so the lines of one "Write all chapters" run can be told apart
    #: from the eleven lanes it fans out into. Absent for a hand-made check, which is fine.
    run: str | None = None
    attempt: int | None = None
    #: The snapshot the brief was built from and the wording the chapter had then (both on the brief).
    #: A proposal whose snapshot has moved is refused (409 `report_snapshot_moved`) before anything is
    #: judged; a store whose text has moved is refused by the store (409 `report_text_moved`). Absent =
    #: unconditional, as before.
    snapshot_id: str | None = None
    expected_text_version: str | None = None
    #: The second model that read this text before it was proposed. Present, only the contract decides
    #: (`report_review.CONTRACT_FINDINGS`): the reader has already judged the rest.
    reviewed_by: str | None = None
    #: What the reader and the writer settled between them — kept with the chapter as `ai_review`, so the
    #: editor can show what was checked and how each point ended.
    review: dict | None = None


def known_method_families() -> list[str]:
    """Every method family registered in the project, for the prose check.

    A chapter that names a family the report does not use is wrong regardless of what it was written
    against — which is how chapters written before this check existed still get judged.
    """
    from prism_lca.engine.bootstrap import get_bd

    return sorted({str(m[0]) for m in get_bd().methods if m})


def prompts_language(report: dict) -> str:
    """The language the correction has to be written in, by its English name."""
    from prism_lca.engine.report_i18n import normalise
    from prism_lca.engine.report_prompts import _LANGUAGE_NAMES

    return _LANGUAGE_NAMES.get(normalise(report.get("lang")), "English")


def gate_refusals(section: dict, report: dict, data: dict, weak_percent: float) -> list[dict]:
    """What the gate would refuse about this chapter *as it stands today* — nothing advisory.

    The two checks used to be strangers. `report_staleness` says what a chapter has to change and
    what that costs; `check_proposal` decides whether the corrected chapter may be stored — and it
    reads the whole text, so it judges sentences the assignment never mentioned. On the PVC window
    report a parameter change dropped a named dataset out of the results: the chapter was graded
    "one rephrasing away", the model delivered exactly the rephrasing it was asked for, and the
    store refused it over a different sentence naming the vanished dataset. Every further attempt
    would have failed the same way, because nobody had told the model that sentence existed (V184).

    Mirrors the patch path exactly — the declared lookups, and pins kept for the sentences a patch
    does not touch — because a refusal predicted here has to be the refusal that actually happens.
    Advisory findings are filtered out by the callers' contract (`ADVISORY_FINDINGS`): they are a
    second read, not a repair job.
    """
    from prism_lca.engine import report_data, report_prompts

    text = section.get("text") or ""
    if not text.strip():
        return []
    if section.get("lookups"):
        # The evidence the chapter was accepted with. Without it every quoted fact comes back as an
        # invention — the same copy `section_patch` makes, and for the same reason.
        data = {**data, "looked_up": section["lookups"]}
    bindings = report_data.bindings_for(text, data, keep=section.get("bindings") or {})
    verdict = report_prompts.check_proposal(
        text,
        section,
        data,
        report.get("lang", "en"),
        weak_percent=weak_percent,
        report=report,
        bindings=bindings,
    )
    return [
        f for f in verdict.get("findings", []) if f.get("kind") not in report_prompts.ADVISORY_FINDINGS
    ]


def blocking(verdict: dict) -> list[dict]:
    """The findings that are the reason nothing was stored.

    An advisory finding (`unverifiable_claim`, `value_judgement`, `weak_difference`) is shown to the
    author and deliberately does not stop a chapter, so naming one in a refusal line would send a
    reader after the wrong sentence — the same conflation that cost two model calls per chapter when
    the writer revised on `findings.length` instead of `ok`.
    """
    from prism_lca.engine.report_prompts import ADVISORY_FINDINGS

    return [
        f for f in verdict.get("findings") or []
        if isinstance(f, dict) and f.get("kind") not in ADVISORY_FINDINGS
    ]


def gate_block(section: dict, report: dict, data: dict) -> dict | None:
    """What the store itself would refuse about this chapter as it stands — one question, two offers.

    A `review` verdict is an offer with two halves, and both are promises about the *store*: "Correct"
    says one rephrasing puts the chapter right, "Accept as it is" says the wording is already fine and
    only the record has to catch up. The store reads the whole text, so neither promise can be made
    without asking the gate what it thinks of the chapter that exists today.

    The answer comes in two strengths, and the difference is whether a sentence carries the reason:

    * A refusal nothing can be pointed at is not a rephrasing job at all. The model would be told the
      message and nothing else, the patch is verified against the whole text, and a patch is all or
      nothing — selling a paid correction round for that is selling a coin flip (V184). Severity
      `rewrite`, and the verdict follows it.
    * A *located* refusal can be handed over, so the correction offer stands (that is what V184 built).
      What does not stand is the other half. The author confirming "read it, the sentence makes no such
      claim" answers a rank finding; it says nothing about a dataset that has left the results. On the
      Neutrogena run the inventory chapter named two vanished rape-seed datasets in plain prose, the
      rank check graded it `review`, and "Accept as it is" stamped it green on its way into a client
      PDF (V190). Severity `review`: a finding the offer has to see, not a change of verdict.

    Only ever consulted on a `review` verdict. The gate is arithmetic but not free, and a chapter
    nobody was asked about is left alone — this makes an existing offer honest, it does not open a new
    front on prose the author never complained about.
    """
    from prism_lca.engine import report_patch, report_review

    refusals = gate_refusals(section, report, data, significance(report))
    # A chapter the second reader read was stored on the contract alone (`report_review.decided`), and
    # the store would decide the same way today: the word readings are the reader's, not a refusal.
    if report_review.current_review(section):
        refusals = report_review.contract(refusals)
    if not refusals:
        return None
    blind = report_patch.unlocated_in(section.get("text") or "", refusals)
    if blind:
        return {
            "kind": "gate",
            "severity": "rewrite",
            "message": "cannot be stored as it stands, and no sentence carries the reason: "
                       + refusal_text(blind[0])
                       + " A correction would be refused whatever it changes.",
        }
    return {
        "kind": "gate",
        "severity": "review",
        "message": "cannot be stored as it stands: "
                   + refusal_text(refusals[0])
                   + " A correction can reach that sentence; standing behind the wording cannot.",
    }


def refusal_text(finding: dict) -> str:
    """The gate's own words for one refusal. `detail` is what it writes for a person; `message` is
    what the staleness vocabulary uses, so a finding from either side reads the same way."""
    return str(finding.get("detail") or finding.get("message") or "")


#: How many refused passages a correction-tried marker keeps. The same bound a correction round works
#: under (`report_patch.MAX_EDITS`): a round that hands back more than six refusals is not saying
#: anything more precise than the first six, and the record is read by a person in one plan row.
MAX_REFUSED = 6


def reported_correction(marker: dict) -> dict:
    """The half of the marker a reader needs. The text and the record are bookkeeping for the expiry
    rule; what a plan row shows is when the round ran, how much of the chapter it refused, and why."""
    return {key: marker.get(key) for key in ("at", "model", "spans", "refused")}


def correction_tried(section: dict, report: dict, data: dict) -> dict | None:
    """The stored correction verdict, or nothing once it stopped being about this chapter.

    Two questions, both of them "is this still the thing the round looked at": the text, byte for byte,
    and the numbers, through the same `components` record a chapter's `based_on` is made of. Anything
    else — a hand edit, a rewrite, an applied correction, `Accept as it is` — clears the marker where it
    is stored (`report_store.update_section`, `section_accepted`), because those change the chapter
    rather than the data under it and a comparison cannot see all of them.

    Reported on every chapter that carries one rather than only on a `review` verdict: the marker costs
    one arithmetic record to check and says nothing about the remedy, so there is no reason for it to
    disagree with itself depending on what the check found today.
    """
    from prism_lca.engine import report_staleness

    marker = section.get("correction_tried")
    if not isinstance(marker, dict) or not marker.get("refused"):
        return None
    text = section.get("text") or ""
    if not text.strip() or (marker.get("text") or "") != text:
        return None
    if marker.get("state") != report_staleness.components(
        text, section.get("bindings") or {}, report, data
    ):
        return None
    return reported_correction(marker)


def note_correction_refused(
    audit, database: str, report: dict, section: dict, body, why: str
) -> None:
    """A correction round that came back and changed nothing.

    Logged although the endpoint is free — it is arithmetic over a snapshot the panel already holds —
    because the *round* that produced these replacements was not, and this refusal is the only
    server-side evidence that it happened. Without it a chapter that kept its findings looks like a
    chapter nobody ever tried to fix.

    Only on a storing call. The panel asks the same endpoint with `store=false` to show the author what
    would apply, and a dry run is not an event.
    """
    if not body.store:
        return
    report_audit.note(
        audit,
        "refuse_report_correction",
        f"Refuse the correction of chapter '{report_audit.chapter_label(section)}' in "
        f"report '{report_audit.report_label(report)}' "
        f"({len(body.edits)} replacement(s) proposed, {why}; nothing was stored"
        f"{report_audit.with_model(body.model)})",
        database=database,
        source=report_audit.by_model(body.model),
    )


def caption_record(before: dict, after: dict, report: dict, data: dict) -> dict:
    """The caption half of a chapter's record after a write that may change its figure captions.

    Captions are pinned and recorded in their own namespace — `caption_bindings`, `caption_based_on` —
    beside the text's `bindings`/`based_on`. One map for both let a kept caption pin
    decide what an index in freshly written text meant, and one record for both let a text rewrite
    re-stamp a caption nobody touched.

    When the captions did not change, nothing is recorded — a reorder of figures must not restamp
    anything — except that a legacy chapter's caption pins are materialised (`caption_migration`):
    the write this goes with replaces `bindings`, and they would go with them. Otherwise a caption left word for word keeps its pins, a new or reworded one is
    bound against today's data, and every finding still open about the OLD captions stays open
    (`keep_stale`) — editing one caption answers nothing the others claim.
    """
    from prism_lca.engine import report_data, report_patch, report_staleness

    captions = report_data.captions_of(after)
    if sorted(report_data.captions_of(before)) == sorted(captions):
        return report_staleness.caption_migration(before)
    # The baseline is the chapter's own caption record, or — on a legacy chapter — the shared one it
    # was stored with; never one rebuilt from today's data (`caption_state`).
    old_pins, old_record = report_staleness.caption_state(before)
    joined = report_staleness.captions_text(after)
    keep = report_patch.surviving_caption_bindings(before, after, old_pins)
    pins = report_data.bindings_for(joined, data, keep=keep)
    fresh = report_staleness.components(joined, pins, report, data)
    # Open findings are kept only for the captions that survive word for word. A caption written anew
    # is written against today's data, like a proposed text — keeping its predecessor's findings made
    # a replacement caption "written for t / gwp" after the methods had moved to tox.
    standing = {c.strip() for c in captions}
    survivors = [
        spec for spec in (list(before.get("figures") or []) or ([before["figure"]] if before.get("figure") else []))
        if isinstance(spec, dict) and str(spec.get("caption") or "").strip() in standing
    ]
    still = [
        f for f in report_staleness.caption_verdicts({**before, "figures": survivors, "figure": None}, report, data)
        if f.get("severity") in ("rewrite", "review")
    ]
    return {
        "caption_bindings": pins,
        "caption_based_on": report_staleness.keep_stale(fresh, old_record, still),
    }


def run_section_proposal(
    audit, database: str, report_id: str, section_id: str, body: ProposalRequest
) -> dict:
    """Run the gate over a proposed text — the whole transaction, from snapshot to audit line.

    Findings are returned rather than the text being rewritten or dropped: the author decides whether a
    missing fact belongs in the metadata or the sentence belongs in the bin. Storing only happens when
    the gate is clean, so a chapter in the report always resolves.
    """
    from datetime import UTC
    from datetime import datetime as _dt

    from prism_lca.engine import (
        gate_journal,
        report_data,
        report_prompts,
        report_review,
        report_staleness,
    )

    store = ReportStore()
    # One load for the section AND the data: read separately, an edit landing between the two loads
    # made the stored patch carry the stale section's kind. Through the module attribute on purpose —
    # `report_pipeline.analysis_snapshot` is the ONE seam the tests replace to fake the numbers.
    report, shared = report_pipeline.analysis_snapshot(database, report_id, RenderRequest())
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
    # The brief's snapshot has to be this one, or the pins below bind against numbers the writer never
    # saw. Checked for store=false too: a check against moved numbers is a wrong answer.
    report_pipeline.require_snapshot(database, report_id, report, body.snapshot_id)
    # A copy, because the snapshot is shared between requests now and `looked_up` belongs to this one.
    data = dict(shared)
    if body.lookups:
        # Read-only lookups the writer made. They belong in the snapshot the gate checks against, but not
        # in the fingerprint: what the text has to stay true to is the *numbers*, and a dataset
        # description does not change when the model is recomputed.
        data["looked_up"] = body.lookups
    # A figure the chapter asked for. Validated before anything is stored, and a bad spec is an error the
    # writer can act on rather than a silently dropped chart. On the writer's own pre-check
    # (store=false) it becomes a *finding* instead of a 400: the 4xx arrived only at the final store,
    # after the revision loop had concluded the chapter was clean — the one party that could have fixed
    # the spec never saw the objection. Advisory, because the prose around it may be fine.
    #
    # A write that names none keeps the figure the chapter already has. Reading the empty field as "no
    # figure" made the brief a trap and lost the drawing: the offer is computed from the stored chapter,
    # so it named `f-section-<id>`; the write then produced a chapter without it, and the gate refused
    # the very reference the brief had handed over — a commissioned rewrite thrown away over one token
    # (V215). The brief does not hand the spec over either, so re-requesting it is not something a
    # writer could do. Deleting a figure belongs where the author can see what disappears (the chapter
    # editor's `figures`); a proposal is about the text and may only *add* one.
    #
    # It lands in the slot the readers actually read. A chapter that already carries a `figures` list
    # gets the request appended to it: the singular is ignored while the list is non-empty, so a figure
    # stored there was validated, saved and drawn by nobody, and `f-section-<id>` — the label the writer
    # was told to point at — existed in no document. Appending keeps every label the chapter already has;
    # renaming them would break a reference its stored text may already carry (V203). See
    # `report_prompts.figure_slot`, which is also what the brief names the label from, so offer and
    # authority cannot drift the way they did in V215.
    figure = section.get("figure")
    figures = list(section.get("figures") or [])
    listed = False
    figure_refused: dict[str, str] | None = None
    if body.figure:
        try:
            one = report_prompts.accept_figure(body.figure, data)
            if report_prompts.figure_slot(section)[0] == "figures":
                # Data-less on purpose: the specs already in the list were accepted against the numbers
                # once, and re-judging them here would let today's data refuse a write about the prose.
                # What this call adds is the six-per-chapter cap, as a finding rather than a late 400.
                figures = report_prompts.accept_figures([*figures, one])
                # The singular is dead the moment the list has an entry, and leaving a dead spec behind
                # is how it came back to life in the editor (see report_store.update_section).
                figure, listed = None, True
            else:
                figure = one
        except PrismError as exc:
            if body.store:
                raise
            figure_refused = {"kind": "figure_refused", "detail": exc.message}

    # The gate judges the chapter this write would PRODUCE, not the one on disk — one decision about the
    # figures, made above and used both for this judgement and for the store below, so the document that
    # is checked is the document that is written. Checking the stored section instead let a write that
    # changed the chapter's own figure pass a reference to a label the result would not carry, and
    # printed "[missing reference: f-section-…]" in the finished PDF, which is exactly the hole
    # `document_labels` exists to prevent.
    candidate = {**section, "figure": figure, "figures": figures}
    proposed = {**report, "sections": [candidate if s.get("id") == section_id else s for s in report.get("sections", [])]}
    # Which member each ranked index will mean *once this text is stored*. Without this, a sentence
    # about the dominant process would follow position 0 into a different dataset the day the ranking
    # changes — and the gate above would judge a different document than the renderer prints (V165).
    # Computed before the gate, stored unchanged after it: one answer, used twice.
    #
    # The TEXT only. Figure captions are pinned in their own namespace (`caption_bindings`):
    # a caption this write leaves standing keeps the member it was written about, and sharing one map
    # made that pin override what the same index means in the fresh text — a correct proposal using
    # today's index 0 then resolved to the caption's member and was refused as misbound.
    #
    # By position, an update included: its writer was handed the chapter rebased into today's positions
    # (`report_rebase`), so an untouched sentence's index already names the member its old pin named.
    bindings = report_data.bindings_for(body.text, data)
    text = body.text
    # Who decides: a chapter a second model has read passes on the contract alone (`report_review`).
    reviewed = bool(body.reviewed_by)
    verdict = report_review.decided(
        report_prompts.check_proposal(
            text,
            candidate,
            data,
            report.get("lang", "en"),
            weak_percent=significance(report),
            report=proposed,
            bindings=bindings,
        ),
        reviewed,
    )
    # The gate is a corrector before it is a judge. Where a finding carries its own substitution —
    # a literal that is one parameter's current value, in that parameter's own written form and unit,
    # outside any quotation, claimed by no other parameter — the substitution is carried out and the
    # text checked again. It prints the same characters it replaced, so nothing a reader sees moves
    # today; what changes is that the figure follows the parameter tomorrow, which is the whole reason
    # the literal was refused.
    #
    # This is not leniency. Before it, the gate worked out the placeholder that belonged there, wrote
    # it into its own message, and threw the chapter away: two of nine chapters in one report, one of
    # them 853 words that were right about everything else (V267). A refusal whose remedy the refusing
    # party already knows is a refusal that should have been a repair.
    #
    # Every substitution is reported. The one thing arithmetic cannot rule out is a sentence that is
    # about a *different* quantity which happens to share this value and unit — so the chapter carries
    # an advisory finding naming each binding that was made, and a reader can see it in the writer
    # report rather than discovering it after a recompute.
    repaired: list[dict] = []
    if not verdict["ok"]:
        candidate_text, applied = report_prompts.apply_repairs(text, verdict.get("findings") or [])
        if applied:
            bindings_after = report_data.bindings_for(candidate_text, data)
            second = report_review.decided(
                report_prompts.check_proposal(
                    candidate_text,
                    candidate,
                    data,
                    report.get("lang", "en"),
                    weak_percent=significance(report),
                    report=proposed,
                    bindings=bindings_after,
                ),
                reviewed,
            )
            # Only if it actually helped. A repair that leaves the chapter refused anyway buys nothing
            # and would hide the author's own wording behind an edit nobody asked for.
            if second["ok"]:
                text, bindings, verdict, repaired = candidate_text, bindings_after, second, applied
    # One line per judgement, refused ones included — see engine/gate_journal. This is the only place
    # that sees a refused attempt at all: the revision loop asks with store=false and nothing else
    # records the answer.
    gate_journal.note(
        database=database,
        report_id=report_id,
        section_id=section_id,
        kind=str(section.get("kind") or "prose"),
        store=bool(body.store),
        ok=bool(verdict["ok"]),
        findings=verdict.get("findings"),
        # Read by a second model, only the contract blocked; every other kind was the reader's to judge.
        advisory_kinds=(
            frozenset(str(f.get("kind")) for f in report_review.hints(verdict.get("findings")))
            | report_prompts.ADVISORY_FINDINGS
            if reviewed
            else report_prompts.ADVISORY_FINDINGS
        ),
        text_chars=len(text or ""),
        lookups=len(body.lookups or []),
        model=body.model,
        run=body.run,
        attempt=body.attempt,
        repaired=len(repaired),
        reviewer=body.reviewed_by,
        hint_outcomes=(body.review or {}).get("hints") if reviewed else None,
    )
    for done in repaired:
        verdict = {
            **verdict,
            "findings": [
                *verdict.get("findings", []),
                {
                    "kind": "repaired_literal",
                    "detail": (
                        f"“{done['find']}” was bound to the parameter '{done['parameter']}' and now "
                        f"prints “{done.get('prints')}” — the same quantity, written as the parameter "
                        "stores it, and correct from here on whenever it changes. Two things worth a "
                        "glance: the wording is the parameter's rather than yours, and the check "
                        "matched a value and a unit, not a meaning. If this sentence is about some "
                        "other quantity that happens to be the same size, write the figure "
                        "differently or state it in words."
                    ),
                },
            ],
        }
    if figure_refused:
        verdict = {**verdict, "findings": [*verdict.get("findings", []), figure_refused]}

    stored = False
    if body.store and verdict["ok"]:
        store.update_section(
            database,
            report_id,
            section_id,
            {
                "kind": section.get("kind", "prose"),
                "text": text,
                "expected_text_version": body.expected_text_version,
                "source": "ai" if body.model else "user",
                "model": body.model,
                "generated_at": _dt.now(UTC).isoformat(),
                # The fingerprint the chapters written from this one compare against (V423): a later
                # correction changes `text` but not this, so it does not stale the summary.
                "written_sha": report_staleness.written_fingerprint({"text": text}),
                # Components rather than one hash over everything: the remedy for a share that
                # changed class is not the remedy for a study that changed its impact methods, and a
                # single fingerprint cannot tell them apart (engine/report_staleness).
                "based_on": report_staleness.with_sources(
                    report_staleness.components(text, bindings, report, shared), section, report, shared, body.lookups
                ),
                "bindings": bindings,
                # The captions' own record, only when this write changed a caption (an appended
                # figure). A text write answers nothing a caption claims, so an unchanged caption
                # keeps its pins AND its open findings.
                **caption_record(section, candidate, report, shared),
                "figure": figure,
                # Only when this write appended one. Sending the list on every store would re-validate
                # and re-save a list nothing here touched, and a chapter whose figure lives in the
                # singular must keep it (V215).
                **({"figures": figures} if listed else {}),
                # The acceptance evidence, kept with the chapter. The lookups are what made a quoted
                # fact pass — without them stored, every later surgical patch was refused over an
                # unsupported_fact in a sentence it never touched. The advisory findings answer "what
                # did the gate wave through here", which an author or reviewer could not reconstruct.
                "lookups": body.lookups or [],
                "findings": [f for f in verdict.get("findings", []) if f],
                # What the second reader checked and how each point ended; none for an unread write, so
                # an old reading cannot stand beside a text it never saw.
                "ai_review": report_review.record(body.review, body.reviewed_by, text) if reviewed else None,
            },
        )
        stored = True
    if body.store:
        # The line Phase 3 exists for: *who wrote this sentence, and when*. One per stored chapter and
        # nothing else — the writer asks this same endpoint with `store=false` up to four times per
        # chapter while it revises, so the log follows what the document ended up carrying, not what
        # was paid for. A "Write all chapters" run over a standard structure therefore leaves nine
        # lines (measured: 12 sections, 9 of them prose a model writes).
        #
        # No text, no prompt, no answer — the chapter's name, its kind, its size, and the model.
        model = body.model
        if verdict["ok"]:
            report_audit.note(
                audit,
                "write_report_chapter",
                f"Write chapter '{report_audit.chapter_label(section)}' in "
                f"report '{report_audit.report_label(report)}' "
                f"({section.get('kind', 'prose')}, {report_audit.size(text)}"
                f"{report_audit.with_model(model)})",
                database=database,
                source=report_audit.by_model(model),
            )
        else:
            # A paid call that produced nothing storable. The writer only asks to store after it has
            # revised as far as it will go, so this is the end of a chapter that cost money and left
            # the report unchanged — the one outcome that must not be missing from the trail. Only the
            # finding *kinds*: a detail quotes the sentence it condemns.
            report_audit.note(
                audit,
                "refuse_report_chapter",
                f"Refuse the proposed chapter '{report_audit.chapter_label(section)}' in "
                f"report '{report_audit.report_label(report)}' "
                f"({report_audit.size(text)} refused by the check: "
                f"{report_audit.finding_kinds(report_review.contract(verdict.get('findings')) if reviewed else blocking(verdict))}"
                f"; nothing was stored"
                f"{report_audit.with_model(model)})",
                database=database,
                source=report_audit.by_model(model),
            )
    # The repaired text travels back, so the caller writes what was stored rather than what it sent.
    # Without it the writer keeps its own copy, the renderer paints it, and the chapter on screen
    # disagrees with the chapter in the file until the next reload.
    return {**verdict, "stored": stored, **({"text": text} if repaired else {})}
