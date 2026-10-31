"""The chapters: what a model is asked to write, and what it is allowed to have written.

Split off from `report.py`, which had grown to twenty endpoints across sixteen hundred lines and was
two jobs wearing one name. What is here is the second job — every place a model touches a report, and
every check that keeps that safe:

* **brief** — the assignment plus the numbers, and nothing else;
* **proposal** — the gate: no literal figures, no unsupported facts, no unresolvable placeholder;
* **patch-brief / patch** — the surgical correction, located mechanically and verified arithmetically;
* **rebind** — the free repair, when a member was only renamed;
* **staleness / reviewed / resolved** — what changed under a written chapter, and what it now says.

What is *not* here is the document: definitions, templates, the PDF, the preview and the hand-off
bundle stay in `report.py`. Neither router imports the other: the shared snapshot
lives in `engine/report_pipeline`/`engine/report_snapshot`, and the gate transaction behind
`section_proposal` in `engine/report_gate` — the routes here are thin callers.

Two rules hold across everything below. A chapter is judged against the same data snapshot it was
written from (`_analysis_snapshot`), and nothing a model produced is stored until an arithmetic check
has passed — the model proposes, the backend decides.
"""
from __future__ import annotations

import logging
import time as _time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import report_audit, report_data, report_gate, report_pipeline
from prism_lca.engine.report_gate import ProposalRequest
from prism_lca.engine.report_i18n import chapter_name
from prism_lca.engine.report_pipeline import RenderRequest
from prism_lca.engine.report_store import ReportStore
from prism_lca.errors import PrismError

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/report", tags=["report"], dependencies=[Depends(require_token)])


def _store() -> ReportStore:
    # Stateless — constructed on use, like the engine does since the store consolidation.
    return ReportStore()


# ---- written chapters: brief and gate ---------------------------------------
@router.post("/one/{database}/{report_id}/sections/{section_id}/brief", summary="The writing brief for a chapter")
def section_brief(request: Request, database: str, report_id: str, section_id: str, body: RenderRequest) -> dict:
    """Everything needed to write this chapter — and exactly what the check afterwards judges against.

    The prompt alone is not enough: without the study metadata and the actual numbers, a writer invents
    and a checker measures against a generic ideal.
    """
    from prism_lca.engine import report_prompts

    # Always the report's own snapshot, exactly like `proposal`: this endpoint used to accept
    # code/method/amount overrides the gate could never mirror, so a brief fetched with them produced
    # text written against one set of numbers and checked against another.
    # Timed apart (V422): the first Write-all wave of the Silikon report waited 125 s in this
    # endpoint on all five lanes, and the writer's own log could only say "brief=125491ms" — whether that
    # was the snapshot (every indicator for every variant, behind the build lock) or the brief itself was
    # not on record.
    t0 = _time.monotonic()
    report, data = report_pipeline.analysis_snapshot(database, report_id, RenderRequest())
    snapshot_ms = round((_time.monotonic() - t0) * 1000)
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
    from prism_lca.engine.report_store import text_version

    t1 = _time.monotonic()
    brief = report_prompts.build_brief(section, report, data)
    brief_ms = round((_time.monotonic() - t1) * 1000)
    if snapshot_ms + brief_ms > 2000:
        _log.info("report brief %s: snapshot %d ms, brief %d ms", section_id, snapshot_ms, brief_ms)
    # What this brief was built from, for the proposal to hand back: the snapshot the numbers
    # come from, and the wording the chapter had. The gate refuses a write whose snapshot has moved,
    # the store one whose text has.
    brief["snapshot_id"] = report_pipeline.snapshot_id_for(database, report_id, report)
    brief["text_version"] = text_version(section.get("text"))
    # What the author answered when a writer asked — every chapter written afterwards knows it.
    from prism_lca.engine.report_review import answered

    brief["author_answers"] = answered(report)
    return brief


class ResolveRequest(RenderRequest):
    #: Fragments to work out instead of the chapter itself — the two halves of each proposed
    #: replacement, so a correction can be read as the document will print it.
    texts: list[str] | None = None


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/resolved",
    summary="A chapter's text with every placeholder worked out (no model)",
)
def section_resolved(
    request: Request, database: str, report_id: str, section_id: str, body: ResolveRequest
) -> dict:
    """What the chapter will actually say, and which member each number belongs to.

    The editor shows `{{contribution.groups.0.share_percent}}` and the document shows `60.2 %`; that
    the row in question is *Packaging* — and that the sentence is pinned to Packaging rather than to
    whatever is largest today — was nowhere on screen. Free and model-free: substitution is arithmetic,
    and the snapshot is shared with the other analysis endpoints.

    With ``texts``, the same substitution runs over fragments against this chapter's pins. That is what
    lets the correction dialog show a replacement as the *document* will read it rather than as
    placeholder source: the swap V146 shipped — a figure printed under another member's name — is
    invisible in the diff and obvious in the resolved line.
    """
    from prism_lca.engine import report_data

    report, data = report_pipeline.analysis_snapshot(database, report_id, body)
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
    lang = report.get("lang", "en")
    bindings = section.get("bindings")
    if body.texts is not None:
        # `plain`: this is read by a person in a dialog, not compiled — see `resolve` (V167).
        return {
            "texts": [
                report_data.resolve(t or "", data, lang, bindings, plain=True)[0] for t in body.texts
            ]
        }
    return {"parts": report_data.explain(section.get("text") or "", data, lang, bindings)}


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/patch-brief",
    summary="What a chapter would have to change, and where",
)
def section_patch_brief(
    request: Request, database: str, report_id: str, section_id: str, body: RenderRequest
) -> dict:
    """The affected sentences plus the findings that condemn them — nothing else.

    A correction is small on purpose, so its brief is too: the model gets the sentences and the
    reason, not the chapter, not the dataset. Which sentence is affected is worked out here from the
    placeholders and the literal names, so no model has to search the prose for judgement words.
    """
    from prism_lca.engine import report_patch, report_staleness

    report, data = report_pipeline.analysis_snapshot(database, report_id, body)
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
    findings = report_staleness.verdicts(section, report, data, report_gate.known_method_families())
    actionable = [f for f in findings if f.get("severity") in ("rewrite", "review")]
    language = report_gate.prompts_language(report)
    # …plus what will refuse the answer. The task and the bar it is measured against are now the same
    # thing; without this the correction loop dead-ends on a sentence nobody named (V184).
    gate = report_gate.gate_refusals(section, report, data, report_pipeline.significance(report))
    out = report_patch.brief(
        section, actionable, language, report_staleness.selection_of(report, data), gate=gate
    )
    out["findings_full"] = actionable
    # Separate from `findings_full`, which is the staleness verdict the panel renders with its own
    # severities. These carry the gate's vocabulary (`kind`/`detail`) and are additive.
    out["gate_findings"] = gate
    return out


class PatchRequest(RenderRequest):
    #: Exact replacements: {find, replace, why}. Verified before anything is applied.
    edits: list[dict] = []
    #: Spans the model refused to patch — each one is a reason to rewrite the chapter instead.
    #: Accepted so one payload shape serves both halves of the flow, but consumed by the *UI* (the
    #: correction dialog lists them from the writer's answer); this endpoint does not read it.
    unfixable: list[dict] = []
    model: str | None = None
    store: bool = False
    #: The snapshot and text version the dry run answered with — handed back on the storing call so a
    #: recalculation or another write in between is refused instead of overwritten.
    snapshot_id: str | None = None
    expected_text_version: str | None = None


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/patch",
    summary="Verify (and optionally store) a surgical correction",
)
def section_patch(
    request: Request, database: str, report_id: str, section_id: str, body: PatchRequest
) -> dict:
    """Apply exact replacements to a chapter, or say precisely why they were refused.

    Every rule is arithmetic: a replacement must match exactly once, must carry the same placeholders,
    must leave a text the gate still accepts, and the lot must stay inside a size bound. What fails is
    never shown to the author as a suggestion — the point of a patch is that it can be trusted at a
    glance, and a suggestion that needs checking as carefully as a rewrite has saved nothing.
    """
    from datetime import UTC
    from datetime import datetime as _dt

    from prism_lca.engine import (
        report_data,
        report_patch,
        report_prompts,
        report_staleness,
    )

    store = _store()
    report, data = report_pipeline.analysis_snapshot(database, report_id, body)
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
    if section.get("locked"):
        raise PrismError(
            f"Section '{chapter_name(section)}' is locked — unlock it first.",
            code="report_section_locked",
            hint="Locking is a promise; a correction may not quietly break it.",
        )
    report_pipeline.require_snapshot(database, report_id, report, body.snapshot_id)
    from prism_lca.engine.report_store import text_version

    original = section.get("text") or ""
    # Echoed on every answer so the storing call can hand them back.
    version = {
        "snapshot_id": report_pipeline.snapshot_id_for(database, report_id, report),
        "text_version": text_version(original),
    }
    # The one placeholder swap the staleness exit offers (ranked token → stable path of the same
    # member) is allowed through; every other placeholder change is still refused.
    swaps = report_patch.rank_swaps(
        report_staleness.verdicts(section, report, data, report_gate.known_method_families())
    )
    result = report_patch.apply_edits(original, body.edits, swaps=swaps)
    if not result["ok"]:
        report_gate.note_correction_refused(request, database, report, section, body, "the replacements do not apply")
        return {**result, **version, "ok": False, "stored": False, "verdict": None}

    # The lookups the chapter was accepted with. Without them the full-text re-check refused a patch
    # over an unsupported_fact in a sentence the patch never touched — the correction loop dead-ended
    # on every chapter that had quoted a lookup. A copy: the snapshot is shared between requests.
    if section.get("lookups"):
        data = dict(data)
        data["looked_up"] = section["lookups"]
    # The chapter's own pins survive the correction: a patch changes the sentences it names and must
    # not re-point the ones it did not touch (see `bindings_for`). New placeholders a patch introduces
    # still get bound against today's data. Computed before the gate so that the gate resolves the
    # figures the way the document will print them — by member, not by position (V165).
    # The text's pins only: figure captions are pinned and recorded apart (`caption_bindings`),
    # and a patch of the text leaves both untouched.
    bindings = report_data.bindings_for(result["text"], data, keep=section.get("bindings") or {})
    verdict = report_prompts.check_proposal(
        result["text"], section, data, report.get("lang", "en"),
        weak_percent=report_pipeline.significance(report), report=report, bindings=bindings,
    )
    if not verdict["ok"]:
        # The corrected text has to clear the same bar as a written one, or a patch would be a way
        # around the gate.
        report_gate.note_correction_refused(
            request, database, report, section, body,
            f"the corrected text was refused by the check ({report_audit.finding_kinds(report_gate.blocking(verdict))})",
        )
        return {**result, **version, "ok": False, "stored": False, "verdict": verdict}

    stored = False
    if body.store:
        # …but only for the sentences it actually corrected. What the model left untouched is still
        # wrong, and a chapter that goes green with five false sentences in it is worse than one that
        # keeps its badge (V162).
        actionable = [
            f
            for f in report_staleness.verdicts(section, report, data, report_gate.known_method_families())
            # A caption's finding belongs to the caption record, which a text patch does not touch;
            # rolled back here it would roll back the TEXT's entry for the same path.
            if f.get("severity") in ("rewrite", "review") and f.get("in") != "caption"
        ]
        untouched = report_patch.unaddressed(original, actionable, result["applied"])
        # Touched is not resolved: a replacement in the condemned sentence used to clear
        # its finding whatever the sentence now says. The corrected text is read instead — the claim
        # gone or demonstrably true clears it, anything else keeps its old record through `keep_stale`.
        touched = [f for f in actionable if f not in untouched]
        left = untouched + report_staleness.unresolved_after(
            touched, result["text"], bindings, report, data, report_gate.known_method_families()
        )
        store.update_section(
            database,
            report_id,
            section_id,
            {
                "text": result["text"],
                "expected_text_version": body.expected_text_version,
                "generated_at": _dt.now(UTC).isoformat(),
                # The corrected text is current for what was corrected, so it gets a current record —
                # otherwise the chapter would keep reporting the finding it was just corrected for.
                "based_on": report_staleness.keep_stale(
                    report_staleness.with_sources(
                        report_staleness.components(result["text"], bindings, report, data),
                        section, report, data, section.get("lookups"),
                    ),
                    section.get("based_on"),
                    left,
                ),
                "bindings": bindings,
                # A legacy chapter's caption pins live in `bindings`, which this write replaces with the
                # text's own — so they are written out first.
                **report_staleness.caption_migration(section),
                # The evidence moves with the text: the advisory findings of the corrected version.
                "findings": [f for f in verdict.get("findings", []) if f],
            },
        )
        stored = True
        # One line per text that actually changed — which is also why the count matters. The panel
        # retries a refused batch one replacement at a time (up to six calls for one chapter), so
        # without the number the log would read as six corrections where there was one round.
        report_audit.note(
            request,
            "correct_report_chapter",
            f"Correct chapter '{report_audit.chapter_label(section)}' in "
            f"report '{report_audit.report_label(report)}' "
            f"({len(result['applied'])} of {len(body.edits)} replacement(s) applied, "
            f"{len(left)} finding(s) left unaddressed{report_audit.with_model(body.model)})",
            database=database,
            source=report_audit.by_model(body.model),
        )
    # `source` is deliberately not touched: a hand-written chapter with three words corrected is
    # still the author's, and relabelling it "ai" would lose that.
    return {**result, **version, "stored": stored, "verdict": verdict}


class CorrectionTriedRequest(RenderRequest):
    #: How many passages the brief handed over (`patch-brief.spans`). The denominator of "refused two
    #: of three" — without it the record cannot say whether the round declined the whole chapter or
    #: one sentence of it.
    spans: int = 0
    #: What the model declined to reword, in its own words: `[{span, why}]`. Empty means there is no
    #: verdict here to keep, and nothing is stored — see the endpoint.
    refused: list[dict] = []
    model: str | None = None


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/correction-tried",
    summary="Keep what a correction round answered about a chapter it could not reword",
)
def section_correction_tried(
    request: Request, database: str, report_id: str, section_id: str, body: CorrectionTriedRequest
) -> dict:
    """Remember that the cheap repair was tried on this chapter, and what it said.

    The two halves of the panel used to send the author in a circle. A `wording` finding is `review`
    by design (V206): the sentence claims a top rank in words, so one replacement could put it right
    and nothing more expensive should be sold. The correction round then answers "nothing here can be
    corrected by rephrasing — the passage needs author rewriting", which is a real answer and was
    thrown away the moment the dialog closed. "Write all chapters" reads the freshness check, which
    still says `review` — correctly, as long as nobody has *tried* — and advises against a rewrite:
    "the cheap answer is Correct… on that row". Observed identically in two modelling sessions (V217).

    So the verdict is kept, and only the verdict: **this is not a second opinion about whether the
    chapter is stale.** The freshness check stays the sole authority on that; what is stored here
    answers one narrower question — has a correction round already run against this text and these
    numbers, and what did it refuse?

    Which is also the expiry rule, and it is deliberately the same idea `based_on` already uses. The
    marker carries the chapter's text and a `report_staleness.components` record of the numbers it was
    formed against, and `_correction_tried` reports it only while both still match. A verdict formed
    against other numbers is an opinion about a report that no longer exists, and it must never be the
    reason the plan offers to discard the author's next version.

    Nothing is stored without a refusal carrying a reason. A round can also come back empty because the
    account has no credits left, because the key is wrong, or because the answer was unparsable — none
    of those is a statement about the chapter, and storing one would sell a paid rewrite on the strength
    of a billing error.
    """
    from datetime import UTC
    from datetime import datetime as _dt

    from prism_lca.engine import report_staleness

    store = _store()
    report, data = report_pipeline.analysis_snapshot(database, report_id, body)
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)

    refused = [
        {"span": str(item.get("span") or ""), "why": str(item.get("why") or "").strip()}
        for item in body.refused
        if isinstance(item, dict) and str(item.get("why") or "").strip()
    ][:report_gate.MAX_REFUSED]
    text = section.get("text") or ""
    if not refused or not text.strip():
        return {"stored": False, "correction_tried": None}

    marker = {
        "at": _dt.now(UTC).isoformat(),
        "model": body.model,
        # Never fewer than what came back: a caller that forgets the count must not turn "one of three"
        # into "none of none".
        "spans": max(int(body.spans or 0), len(refused)),
        "refused": refused,
        # The two halves of "still about this chapter" — see `_correction_tried`.
        "text": text,
        "state": report_staleness.components(text, section.get("bindings") or {}, report, data),
    }
    store.update_section(database, report_id, section_id, {"correction_tried": marker})
    # A paid round that produced no change to the document — the one outcome that would otherwise be
    # invisible, since nothing was written and no replacement was refused. The reasons the model gave
    # are stored on the chapter, not here: they quote its sentences.
    report_audit.note(
        request,
        "decline_report_correction",
        f"Decline to reword chapter '{report_audit.chapter_label(section)}' in "
        f"report '{report_audit.report_label(report)}' "
        f"({len(refused)} of {marker['spans']} passage(s) the correction round would not touch"
        f"{report_audit.with_model(body.model)})",
        database=database,
        source=report_audit.by_model(body.model),
    )
    return {"stored": True, "correction_tried": report_gate.reported_correction(marker)}


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/rebind",
    summary="Re-point a chapter's bindings at renamed members (no model, no text change)",
)
def section_rebind(
    request: Request, database: str, report_id: str, section_id: str, body: RenderRequest
) -> dict:
    """The free repair: the thing a sentence points at was only renamed.

    Nothing about the prose changes — the pointer is updated and the ``[missing: …]`` hole closes.
    Offered only where the identifying fields still agree and exactly one member carries them, so
    this can never quietly make a sentence talk about something else.
    """
    from prism_lca.engine import report_patch, report_staleness

    store = _store()
    report, data = report_pipeline.analysis_snapshot(database, report_id, body)
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
    # Both maps, each on its own: a renamed member a caption is pinned to is the same free
    # repair, and the caption's pins are not in `bindings` any more.
    found = report_patch.rebindings(section.get("bindings") or {}, data)
    caption_pins, caption_record = report_staleness.caption_state(section)
    caption_found = report_patch.rebindings(caption_pins, data) if caption_pins else {}
    if not found and not caption_found:
        return {"rebound": {}, "stored": False}

    # Pins only, never a record: the prose is byte-for-byte unchanged and was written against the
    # numbers recorded there. Refreshing the record against today's data (as the patch path rightly does
    # after the gate re-passed the text) erased any band/rank drift that had accumulated — a rename plus
    # a share collapse, repaired with "Re-link", kept saying "dominates" and never got the review finding.
    # Both baselines are carried as they are; a legacy chapter's caption half is written out with them.
    patch: dict = {"bindings": {**(section.get("bindings") or {}), **found}}
    if caption_pins:
        patch["caption_bindings"] = {**caption_pins, **caption_found}
        patch["caption_based_on"] = caption_record
    store.update_section(database, report_id, section_id, patch)
    found = {**found, **{f"caption:{key}": value for key, value in caption_found.items()}}
    # No prose changed, and that is precisely why this is logged: a pin is what decides which member a
    # printed figure belongs to, so re-pointing one changes what the document says without changing a
    # word of it. Free, and the author is told it happened — the log has to be able to say so too.
    report_audit.note(
        request,
        "rebind_report_chapter",
        f"Re-link {len(found)} pinned figure(s) in chapter '{report_audit.chapter_label(section)}' of "
        f"report '{report_audit.report_label(report)}' (renamed members; the text is unchanged)",
        database=database,
    )
    return {"rebound": found, "stored": True}


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/accepted",
    summary="Accept a chapter's wording as it stands (no model, no text change)",
)
def section_accepted(
    request: Request, database: str, report_id: str, section_id: str, body: RenderRequest
) -> dict:
    """The author's verdict on a finding that could only ever be a suspicion.

    The rank and band checks cannot read a sentence. They report that a bound member changed places or
    that a share left its class and say "*may* no longer be true" — deliberately, because the only
    alternative is a check that stays quiet while "dominates" goes false. That bargain has a second
    half, and it was missing: somebody has to be able to look at the sentence and say "read it, it does
    not make that claim". Measured on a mould-remover study (V179): two incineration datasets
    slipped from rank 3 and 5 to 6 and 10 in a sentence that names them, prints their shares through
    pinned placeholders, and contains no superlative at all. The correction model answered, correctly,
    that there was nothing to rephrase; the panel's only remaining offer was a paid rewrite of a chapter
    with nothing wrong in it, and declining it left the report yellow for good.

    So this re-stamps the record against today's numbers — the same arithmetic `section_patch` performs
    when it stores a correction — and changes nothing else: not a word of the text, not `source`, not
    the read-marker, and above all not the pins. ``bindings`` is passed in as it stands and never
    recomputed, because a chapter that keeps its wording must keep pointing at the members that wording
    is about. Free, and no model is asked anything.

    Refused on a ``rewrite`` verdict, and that limit is the point. A rewrite finding is not a suspicion:
    the chapter names a method this report does not use, or cites a path that no longer resolves and
    will print “[missing: …]” into the PDF. A hole in the deliverable is not a judgement call, and no
    button may stamp one away.

    Refused, too, on anything the *gate* refuses (``_gate_block``) — the verdict alone was not enough.
    The rank and band checks read placeholders and pins; a dataset named in plain prose is invisible to
    them, so a chapter can be graded `review` over one sentence while the store refuses it over
    another. Accepting stamped that green, invented dataset names and all (V190). The author is being
    asked about a claim their sentence may not make; they are not being asked to vouch for facts an
    arithmetic check has already disproved.
    """
    from prism_lca.engine import report_staleness

    store = _store()
    report, data = report_pipeline.analysis_snapshot(database, report_id, body)
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
    if section.get("locked"):
        # Same refusal as a correction, for the same reason: freezing is a promise about the record as
        # much as about the prose, and re-stamping is a change to the record.
        raise PrismError(
            f"Section '{chapter_name(section)}' is locked — unlock it first.",
            code="report_section_locked",
            hint="Locking is a promise; accepting a finding may not quietly break it.",
        )

    text = section.get("text") or ""
    found = (
        report_staleness.verdicts(section, report, data, report_gate.known_method_families())
        if report_data.prose_of(section).strip()
        else []
    )
    remedy = report_staleness.worst(found)
    block = report_gate.gate_block(section, report, data) if remedy == "review" else None
    if block is not None:
        # The same honesty the badge shows: "read it, it is fine" cannot be true of a chapter the
        # store itself would refuse, and stamping the record green would hide a text that has to
        # change. Whether the refusal can be pointed at a sentence decides who repairs it, not
        # whether this button may — so both strengths land here, and the gate's own words come with
        # the refusal: "it cannot be accepted" alone leaves the author guessing which sentence (V190).
        raise PrismError(
            f"Section '{chapter_name(section)}' {block['message']}",
            code="report_accept_refused",
            hint="Correct the sentence the check names, or write the chapter again — accepting is only "
                 "for a wording the check merely suspects.",
        )
    if remedy == "rewrite":
        raise PrismError(
            f"Section '{chapter_name(section)}' asserts something that is no longer true.",
            code="report_accept_refused",
            hint="Correct or rewrite it — accepting is only for a wording the check merely suspects.",
        )
    if remedy != "review":
        # Nothing to accept. Not an error: the check may simply have caught up between the click and
        # the request, and a scolding dialog for "it is already fine" would be the wrong answer.
        return {"accepted": False, "stored": False, "remedy": remedy, "findings": found}

    store.update_section(
        database,
        report_id,
        section_id,
        {
            "based_on": report_staleness.with_sources(
                report_staleness.components(text, section.get("bindings") or {}, report, data),
                section, report, data, section.get("lookups"),
            ),
            # The captions' record too: "read it, it is fine" answers a caption's rank finding as much
            # as a sentence's. Only where a caption cites something to record.
            **(
                {
                    "caption_bindings": report_staleness.caption_bindings(section),
                    "caption_based_on": report_staleness.components(
                        report_staleness.captions_text(section),
                        report_staleness.caption_bindings(section),
                        report,
                        data,
                    ),
                }
                if report_staleness.captions_text(section).strip()
                else {}
            ),
            # And the correction round's verdict goes with it. "Read it, the sentence makes no such
            # claim" answers the question that round was asked, so keeping "it cannot be reworded"
            # would leave the run plan offering to discard a wording the author has just stood behind.
            "correction_tried": None,
        },
    )
    # The author's own verdict, and the only reason a chapter's badge went green without a sentence
    # changing. A reviewer who asks "why is this chapter current?" gets the honest answer: somebody
    # read it and said the wording makes no such claim.
    report_audit.note(
        request,
        "accept_report_chapter",
        f"Accept the wording of chapter '{report_audit.chapter_label(section)}' in "
        f"report '{report_audit.report_label(report)}' as it stands "
        f"({len(found)} finding(s) it was suspected of)",
        database=database,
    )
    # The findings are gone because the record now says what the data says — not because anything was
    # silenced: move the numbers again and the same check reports the next drift from here.
    return {"accepted": True, "stored": True, "remedy": "none", "findings": []}


class ReviewedRequest(BaseModel):
    #: Sections to mark; omit for every chapter that has text.
    section_ids: list[str] | None = None
    #: False forgets the mark again.
    read: bool = True


@router.post("/one/{database}/{report_id}/reviewed", summary="Mark chapters as read")
def mark_reviewed(request: Request, database: str, report_id: str, body: ReviewedRequest) -> dict:
    """Record that the author has read these chapters and stands behind them.

    Softer than freezing on purpose: freezing forbids change, this only remembers a state. It is what
    makes "the report stays as I know it" checkable rather than a hope — before an export, PrismLCA
    can say which chapters have moved since the last read-through, and show exactly how.

    The mark is also the expert release of a model-written chapter: the gate checks
    figures, the author checks meaning, and nothing else can. ``release`` is set here and read by
    `report_staleness.expert_review`, which lets it lapse when the wording or the numbers move.
    """
    from datetime import UTC
    from datetime import datetime as _dt

    # Aliased: `report_staleness` is the name of the staleness ROUTE in this module.
    from prism_lca.engine import report_staleness as rs

    store = _store()
    # The data too, not only the definition: the release records the figures the author released
    # against (`components(...)["values"]`), and that needs the snapshot — cached after the check the
    # author has just looked at, so this costs nothing in the normal case (V393).
    report, data = report_pipeline.analysis_snapshot(database, report_id, RenderRequest())
    # `[]` means "mark none", not "mark all" — only an *omitted* list falls back to every chapter.
    wanted = set(body.section_ids) if body.section_ids is not None else None
    if body.read:
        # A typed number still open is a decision the author has not made yet: releasing the chapter
        # would release a figure nobody checked (`report_typed_numbers`).
        from prism_lca.engine import report_review, report_typed_numbers

        undecided = [
            report_audit.chapter_label(section)
            for section in report.get("sections", [])
            if (section.get("text") or "").strip()
            and (wanted is None or section.get("id") in wanted)
            and report_typed_numbers.typed(report_review.current_review(section), "open")
        ]
        if undecided:
            raise PrismError(
                "Typed numbers are still to be checked in: " + ", ".join(f"'{c}'" for c in undecided)
                + ". Keep or replace each one before approving.",
                code="report_typed_numbers_open",
                status_code=409,
            )
    marked = []
    for section in report.get("sections", []):
        text = (section.get("text") or "").strip()
        if not text or (wanted is not None and section.get("id") not in wanted):
            continue
        values = rs.components(section.get("text") or "", section.get("bindings") or {}, report, data)["values"]
        store.update_section(
            database,
            report_id,
            section.get("id"),
            {"reviewed": {"at": _dt.now(UTC).isoformat(), "text": section.get("text") or "", "release": True, "values": values}}
            if body.read
            else {"reviewed": None},
        )
        marked.append(section.get("id"))
    # One line per click, not per chapter: "the author read the report through on the 24th" is one
    # event, and nine lines saying it would push the model edits around them off the page.
    if marked:
        report_audit.note(
            request,
            "mark_report_chapters_read" if body.read else "unmark_report_chapters_read",
            (f"Release {len(marked)} chapter(s) as read and reviewed in " if body.read
             else f"Withdraw the release on {len(marked)} chapter(s) in ")
            + f"report '{report_audit.report_label(report)}'",
            database=database,
        )
    return {"marked": marked, "read": body.read}


@router.post("/one/{database}/{report_id}/sections/{section_id}/proposal", summary="Check (and optionally store) a written chapter")
def section_proposal(
    request: Request, database: str, report_id: str, section_id: str, body: ProposalRequest
) -> dict:
    """Run the gate over a proposed text — the transaction lives in `engine/report_gate`.

    Findings are returned rather than the text being rewritten or dropped: the author decides whether a
    missing fact belongs in the metadata or the sentence belongs in the bin. Storing only happens when
    the gate is clean, so a chapter in the report always resolves.
    """
    return report_gate.run_section_proposal(request, database, report_id, section_id, body)


@router.post("/one/{database}/{report_id}/staleness", summary="Which written chapters were written against older numbers")
def report_staleness(request: Request, database: str, report_id: str, body: RenderRequest) -> dict:
    """Compare each chapter's fingerprint against the current data.

    Deliberately arithmetic: comparing two hashes costs nothing and cannot be wrong, so no model is
    asked whether a paragraph is still valid. Only once a fingerprint differs is there a reason to look
    at the prose at all — and even then this only *reports*; it never rewrites and never unlocks a
    frozen chapter.
    """
    from prism_lca.engine import report_patch, report_staleness

    # Before the snapshot, not after: with no written text there is nothing to compare, but the
    # snapshot would be built anyway — on a cold cache that was ~7 minutes of LCIA for an empty
    # answer, spent inside the "Write all" dialog of a brand-new report (V121).
    report_def = _store().get(database, report_id)
    wanted = set(body.section_ids) if body.section_ids is not None else None
    if not any(
        report_data.prose_of(s).strip()
        for s in report_def.get("sections", [])
        if wanted is None or s.get("id") in wanted
    ):
        return {"chapters": []}

    report, data = report_pipeline.analysis_snapshot(database, report_id, body)
    known = report_gate.known_method_families()

    chapters = []
    for section in sorted(report.get("sections", []), key=lambda s: s.get("order", 0)):
        # Any chapter carrying text, not only the written ones: a comment under a deterministic table
        # quotes the same numbers and goes just as stale when they move.
        # …and any figure caption, which cites and goes stale like the text.
        if not report_data.prose_of(section).strip():
            continue
        if wanted is not None and section.get("id") not in wanted:
            continue
        found = report_staleness.verdicts(section, report, data, known)
        remedy = report_staleness.worst(found)
        if remedy == "review":
            # Only here: the gate is arithmetic but not free, and "review" is the one verdict that
            # promises a cheap repair. Anything else already says rewrite, or asks for nothing.
            block = report_gate.gate_block(section, report, data)
            if block is not None:
                # Additive on purpose: the panel reads `remedy` and `findings`, and a located refusal
                # changes only the second — it leaves the chapter correctable while telling the row
                # that the text as it stands would not be stored (V190).
                found = [*found, block]
                if block["severity"] == "rewrite":
                    remedy = "rewrite"
        reviewed = section.get("reviewed") or {}
        chapters.append(
            {
                "section_id": section.get("id"),
                "title": section.get("title") or "",
                "locked": bool(section.get("locked")),
                #: What this chapter needs: "rewrite", "review" or "none".
                "remedy": remedy,
                "findings": found,
                # What the cheap repair already answered here, while that answer still applies. The
                # remedy above is untouched by it — this only tells the panel whether "Correct…" is
                # still an offer worth making, or a question the model has already answered (V217).
                "correction_tried": report_gate.correction_tried(section, report, data),
                # A repair that costs nothing and changes no word: the member was only renamed.
                "rebindable": len(report_patch.rebindings(section.get("bindings") or {}, data))
                + len(report_patch.rebindings(report_staleness.caption_bindings(section), data)),
                # Whether the wording has moved since the author last read it, and what it was then.
                "reviewed_at": reviewed.get("at"),
                "changed_since_reviewed": bool(reviewed)
                and (reviewed.get("text") or "") != (section.get("text") or ""),
                "reviewed_text": reviewed.get("text"),
                # The author's release of a model-written chapter, while it still holds — the one
                # verdict here that is about meaning rather than arithmetic, and the one the gate
                # cannot give. None for a chapter no model wrote.
                **dict(
                    zip(
                        ("review", "review_reason"),
                        report_staleness.expert_review_with_reason(
                            section,
                            remedy,
                            report_staleness.components(
                                section.get("text") or "", section.get("bindings") or {}, report, data
                            )["values"],
                        ),
                        strict=True,
                    )
                ),
                # Kept so an older client keeps working: it only ever knew two words.
                "state": "current" if remedy == "none" else "stale",
            }
        )
    return {"chapters": chapters}
