"""Prompts for written chapters, and the gate that decides whether a proposal may be stored.

Two ideas carry this module.

**A chapter's brief is the whole assignment, not just a prompt.** The writer — and equally the check
afterwards — gets the standard prompt for that kind of chapter, the author's own additions, the study
metadata (which *is* the contract of the study), and the numbers. A check against a generic ideal
instead of against what was actually asked for is worth very little.

**Facts may be phrased, never invented.** The author decided that the assistant may formulate the
recorded facts — goal, scope, functional unit, boundaries, cut-off, allocation — rather than quoting
them verbatim. That shifts the burden onto the gate: it no longer asks "are there
free numbers" but "is there a fact here with no basis in what we handed over". A finding is reported
against the chapter for the author to judge; nothing is silently discarded.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from prism_lca.engine import (
    report_checks,
    report_claims,
    report_kinds,
    report_sources,
    report_tokens,
)
from prism_lca.engine import report_data as rd
from prism_lca.engine import report_typst as rt
from prism_lca.engine import units as units_of
from prism_lca.engine.report_i18n import LANGUAGES, kind_title, normalise
from prism_lca.engine.report_model import PROSE_KINDS
from prism_lca.errors import PrismError

#: Language names as they should appear in a prompt — a model writes better German when asked in
#: English for "German" than when handed a BCP-47 tag.
_LANGUAGE_NAMES = {
    "en": "English",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "pt": "Portuguese",
}

#: Standard prompt per chapter kind. Editable per report; this is the starting point. The texts
#: live as Markdown beside the fonts and templates (assets/prompts/<kind>.md) — 300 lines of literal
#: hid this module's logic, and a prompt is reviewed as prose, not as a Python expression. Loaded
#: once at import; the file list IS the kind list, and a missing file crashes the import (packaging
#: error) rather than silently offering fewer chapters.
_PROMPTS_DIR = Path(__file__).resolve().parent.parent / "assets" / "prompts"

DEFAULT_PROMPTS: dict[str, str] = {
    path.stem: path.read_text(encoding="utf-8") for path in sorted(_PROMPTS_DIR.glob("*.md"))
}

# The file list and the registry describe the same population: a prompt file for a kind the registry
# does not flag (or a flagged kind whose file is missing from the bundle) is a packaging error, and
# crashing the import here beats a writer silently working from the generic prose prompt.
assert set(DEFAULT_PROMPTS) == {k.kind for k in report_kinds.KINDS if k.own_prompt}, (
    "assets/prompts/*.md and the ChapterKind registry disagree about which kinds ship a prompt"
)

#: Findings that are shown but do not stop a chapter from being stored: nothing about them can be
#: mechanically fixed, and an obstacle nobody can clear is an obstacle people learn to route around.
#:
#: `value_judgement` and `weak_difference` join it for the same reason from the other direction: both are
#: matters of wording and context. A value word can sit inside a quotation, and the significance threshold
#: is a convention rather than a measurement — blocking on either would make the checker something an
#: author switches off, which costs more than the two findings are worth.
ADVISORY_FINDINGS = frozenset(
    # `antithesis_habit` joins them for the reason the other three are here: it is a matter of wording,
    # and a style rule that blocks is a check an author switches off.
    #
    # `repaired_literal` is different in kind: it reports something the gate already DID. The objection
    # it came from is gone — it is a record, addressed to whoever reads the chapter afterwards, of a
    # binding arithmetic could establish and meaning could not. Blocking on it would undo the repair.
    {
        # The declaration beside its own label (V434): the document folds the pair, the author
        # hears about it; blocking would buy a revision for a sentence that already prints right.
        "declaration_beside_label",
        "unverifiable_claim",
        "value_judgement",
        "weak_difference",
        "antithesis_habit",
        "repaired_literal",
        # Length is a matter for the author's read-through, not for the gate: the writer used to cut
        # a chapter silently at 6 000 characters instead.
        "chapter_long",
        # A study.* placeholder resolving to a whole paragraph, embedded mid-sentence (V295's shape).
        # Advisory, not blocking: the path is legal and the writer may genuinely want the paragraph —
        # what it gets is a pointed second opinion, not a locked door.
        "prose_placeholder_in_sentence",
    }
)

#: Rules every written chapter obeys. Appended to whatever prompt is in force, so an edited prompt
#: cannot accidentally drop them.
_INVARIANTS = (
    "Rules that always apply:\n"
    "- Write in {language}.\n"
    "- Never write a COMPUTED number as a literal. Reference it as a placeholder, e.g. "
    "{{{{results.0.score}}}} or {{{{contribution.groups.0.share_text}}}}. **Why this one rule outranks "
    "the others:** what you write is not a finished document. It is stored as you leave it and "
    "re-typeset every time the study is recomputed — a corrected parameter, one more scenario, a "
    "replaced dataset. A placeholder is read again at that moment and prints the new value; a number "
    "you typed is frozen at today\u2019s and quietly contradicts the table on its own page. Nobody "
    "re-reads a chapter that was already approved, so a stale figure is not caught, it is shipped. "
    "That is why the check refuses a literal outright instead of warning about it, and why a chapter "
    "with one typed number is held back whole. The placeholder paths available to you are listed "
    "below.\n"
    "  The one exception, deliberately: a figure the study's own prose spells out — the goal, the "
    "scope, a process note, \u201cmore than 50 % post-consumer content\u201d from the product "
    "description — is a QUOTATION of the author, not a computation, and you may write it as it "
    "stands (attributing helps: \u201cper the product description\u2026\u201d). Do not reach for a "
    "study.* placeholder just to avoid such a number: those resolve to whole paragraphs, not "
    "values.\n"
    "- **Placeholders under study.* (goal, scope, notes, \u2026) resolve to PARAGRAPHS of the "
    "author's prose, never to a value.** Use one only standing alone — as its own sentence or "
    "quotation — never inside a sentence where a quantity or a name should go; resolved, it would "
    "dump the whole paragraph into your sentence. The value-shaped paths live under results.*, "
    "contribution.*, subjects.*, parameters.* and the derivations.\n"
    "- **Name the product's full trade designation at most once in your chapter** (usually the first "
    "mention), then refer to it generically — \u201cthe watering can\u201d, \u201cthe "
    "product\u201d. A report that repeats a retail name in every paragraph reads like a shop "
    "listing, and the functional unit already records the full designation once.\n"
    "- **A share needs its percent sign, and only the `_text` form carries one.** "
    "`{{{{contribution.groups.0.share_text}}}}` prints \"87.1 %\"; the `_percent` form beside it prints "
    "the bare number 87.1, which in a sentence reads as \"accounts for 87.1 of the total\" — the one "
    "mistake in this report a reader is guaranteed to notice, because the table on the same page has "
    "the sign. So in prose use the `_text` form wherever there is one, and never add a % of your own "
    "next to it. Reach for `_percent` only inside a derivation, where it is arithmetic rather than "
    "words. The same holds for any placeholder whose name ends in `_text`: it already carries its "
    "unit or sign.\n"
    "- Never calculate a figure yourself. A number you worked out goes stale exactly like one you "
    "copied. When you need one, use a **derivation**, which is computed at typesetting time and stays "
    "correct: {{{{sum(a, b, c, \u2026)}}}} (any number of arguments — never nest sums) · {{{{diff(a, b)}}}} · "
    "{{{{percent(a, b)}}}} (a as a percentage of b) · {{{{change(a, b)}}}} (relative change from b to a, in percent) · {{{{factor(a, b)}}}} (how many "
    "times a is b). Arguments are placeholder paths or plain numbers, e.g. "
    "{{{{change(subjects.1.results.0.score, subjects.0.results.0.score)}}}} for \"X higher than the "
    "baseline\". `percent` and `change` print their own % sign, and so does a sum of two shares. "
    "A **`diff` of two shares does not**: it is a number of *percentage points*, so write the words "
    "yourself — \"{{{{diff(a, b)}}}} percentage points apart\", never \"% percentage points\".\n"
    "- If a modelling assumption has no placeholder — that every bag is incinerated, say — state it in "
    "words (\"all bags are assumed to be incinerated\"), not as a figure. The exact value is in the "
    "annex\'s parameter table, where it stays correct by itself. That holds even when a process note "
    "you were given spells the figure out: a note saying \"42 g wood (parameter mass_pallet_share)\" is "
    "quoting the parameter, and the parameter is exactly what changes — name the thing, not the "
    "number.\n"
    "- **\"The thing\" is the quantity in words, never the parameter's name.** Write \"the assumed "
    "coverage\", \"the mixing energy\", \"the share sourced from Norway\" — not "
    "`reichweite_m2_pro_l`, `mischen_kwh_pro_kg`, `share_no`. An identifier is how the software finds "
    "a number, not how a report names one, and the annex's parameter table is where a reader who wants "
    "the identifier finds it. Process comments and lookup answers are full of them because that is "
    "where the modeller wrote them down; they stop at the edge of your sentence.\n"
    "- Reference a table or figure as {{{{ref:t-lcia}}}} or {{{{ref:f-contribution}}}}, never as "
    '"Table 1" — chapters get reordered.\n'
    # Declared instead of inferred. The gate reads a superlative out of prose with word lists in five
    # languages, and that half is where the defects came from — ten measured in four days, one of them
    # in a delivered PDF (V216). A declaration is checked by arithmetic instead: the token is pinned to
    # the member it named, so a ranking that changes hands raises the rank finding on this very
    # sentence. Advice, not an obligation: a bare superlative is still accepted, exactly as before.
    # An obligation with no exception produces a sentence and its retraction in one paragraph. Measured
    # on a wood-stain report: "End-of-life entirely residual waste takes first place on
    # each" and, three sentences later, "such spreads are not evidence of a difference" (V256). The
    # writer was following the rule; the rule had no way to say "there is no rank here".
    "- **Where the spread is below this report's significance threshold, there is no rank to name.** "
    "Say that the variants are comparable and that no preference follows — that IS the finding, and it "
    "is a stronger sentence than a ranking you take back in the next one. The threshold is in the "
    "cautions below where the report sets one.\n"
    "- **When you assert a rank — the largest, the dominant one, the main contributor — name the member "
    "with {{{{rank:contribution.groups.0}}}} and nothing else.** It prints that member's name, and index 0 "
    "is the leader — so it stands IN PLACE of the name, never beside it: „{{{{hotspots.0.name}}}}\" "
    "({{{{rank:hotspots.0}}}}) prints the same name twice. "
    "Written that way, the claim is checked against the data and stays attached to the member you meant "
    "when the ranking moves; written in words alone, nothing in the sentence can be checked. Works on "
    "the size-ordered lists only — `contribution.groups`, `hotspots`, `inventory.flows` and their "
    "per-indicator forms, plus `results.<i>.subjects_by_score` for the variants ordered by that "
    "indicator's score, and only where the paths below show that this report has one; `results` and "
    "`subjects` are in report order, so they carry no rank.\n"
    "- **`renders` lists what this chapter already shows** — the tables and figures printed with it, each "
    "with the reference to use. Point at them; do not retell them. A share that is drawn as a bar does not "
    "need the same share spelled out in your sentence: say what the picture *means* (which group leads, "
    "what that implies for where the uncertainty sits) and reference it. Naming one or two decisive figures "
    "from a table is right; walking through its rows is the table's job, not yours.\n"
    "- Keep dataset names, method names and units exactly as given; they are identifiers.\n"
    "- **Name only datasets you were handed.** If a dataset is not in the hotspot list, the inventory "
    "or the background list above, you do not know that it is in this model — and you certainly do not "
    "know its share. Where the evidence covers one indicator only, say so and write about that one; "
    "\"the two leading datasets are X and Y, together about a quarter\" is an invention unless X, Y and "
    "the quarter are in front of you. The check reads names in quotation marks and in *italics* alike.\n"
    "- Never combine two impact categories into one figure. A sum of kg CO2-Eq and MJ-Eq is a single "
    "score, which ISO 14044 does not permit for a comparative assertion; the derivations refuse it. Give "
    "each category its own placeholder.\n"
    # This used to end at "say so where a figure could otherwise be read as an absolute quantity", and
    # a writer that could not see the other chapters read it as an obligation and restated the whole
    # definition. Five times in one document (V256). `document_plan` now says where each framing fact
    # is settled; this is the sentence that tells the writer to use it.
    "- Every result refers to the functional unit — {functional_unit} — and to the system boundaries as "
    "recorded. Say so where a figure could otherwise be read as an absolute quantity — **in a clause, "
    "not by defining it again**: \u201cper square metre coated\u201d, not the whole definition.\n"
    "- **`document_plan` lists this report's chapters and what each one covers, and `settled_elsewhere` "
    "names the chapter where each framing fact is already fixed.** Those chapters are being written "
    "beside yours and you cannot read them — that is exactly why the list is here. Do not define the "
    "functional unit, the system boundaries, the cut-off, the allocation or the method a second time; "
    "name them and carry on. Where the reader really needs the definition, point at the chapter that "
    "holds it. A document that says the same thing in four chapters has told the reader nothing four "
    "times.\n"
    "- Keep the three levels apart, in this order and never in one sentence: the **result** (what was "
    "computed), the **interpretation** (what it means, and how far the data carries it), and a "
    "**recommendation** (what someone should do). A recommendation only where the prompt asks for one.\n"
    "- No absolute value judgements: not \"environmentally friendly\", \"green\", \"sustainable\", "
    "\"clean\". An LCA reports indicator results, and none of them says a product is good. The "
    "comparative against a named alternative is fine (\"lower climate change impact than …\"). Claims of "
    "climate or carbon neutrality do not belong in this report at all.\n"
    # A report is a document about a product system, not about the session that produced it. Real
    # chapters said "the internal model review found no open findings", "a structural model check
    # (Prism Model Health Check) was carried out" and "web research established that …" — three
    # sentences about the software and the assistant, in a client's PDF, where a human author would
    # have written the fact and cited the source. It reads as a machine explaining itself, and it
    # tells the reader something about the tooling instead of about the study.
    "- **Write as the study's author, about the study.** Never describe how this document came about: "
    "no assistant, no language model, no tool, no automated check, no internal review, no research "
    "run, and no product name of the software. That includes saying that something was *not* done: "
    "\"no automated review was carried out\" is the same sentence with a negation. A fact you were "
    "given from research is stated as a fact with its source — \"typical yields are around X "
    "(source)\" — never as \"research showed\". A weakness the checks or the review surfaced is "
    "stated as a weakness of the study — \"the end-of-life stage rests on a single assumption\" — "
    "never as \"the review found\". A critical review under ISO 14044 §7.3.3 is the one exception "
    "and a different thing entirely: that is a named human reviewer on record, and where the study "
    "records one it is named as such.\n"
    # The invariants forbade every FORM (emoji, heading, table, list, value judgement) and described no
    # REGISTER — and into that gap fell the model's default voice. Measured on a wood-stain
    # report: five "rather than", the antithesis as a habit ("attest to how the model is wired, not to
    # how completely it mirrors"), sentences that only announce what follows, and one that ruled out
    # something nobody had suspected ("Retail price and market data play no role in the assessment").
    # Prohibitions alone produce no voice; the counter-examples are the part that works (V257).
    # Read off four real reports: a company's full comparative LCA and an industry
    # association's eco-profile methodology both run 3–6 sentences per paragraph, one thought each,
    # then a table or a figure. Our own second run had a fifteen-line paragraph answering four
    # questions — the content was right, the portioning was not, and nothing had ever said otherwise
    # (V263). A sentence budget would have the wrong unit: the defect is that nothing divides the text.
    "- **One thought per paragraph, three to six sentences.** A paragraph that answers two questions "
    "is two paragraphs. In an inventory chapter that means one paragraph per process or per group of "
    "processes that belong together; in a results chapter, one per finding.\n"
    "- **Technical prose, not an essay.** Four habits to avoid, each one a real sentence from a real "
    "report:\n"
    "  · **No antithesis as a figure of speech.** Not \"X is not A, but B\" where \"X is B\" says it. "
    "\"What survives this spread is the structure; what does not survive is any absolute figure\" is "
    "one thought dressed as two.\n"
    "  · **No sentence that only announces or only recapitulates.** \"Together with the functional "
    "unit and the allocation conventions, these definitions fix what the following chapters compare\" "
    "carries nothing: the chapters do the comparing, and the reader will see it.\n"
    "  · **Do not rule out what nobody expected.** \"Retail price and market data play no role in the "
    "assessment\" answers a question no reader asked.\n"
    "  · **A sentence you can delete without losing a statement is deleted.** Write the chapter, then "
    "read it once with that question and act on the answer.\n"
    "- Prose, not a slide. **Bold** and *italic* are available and a bullet list (\"- item\") or a "
    "numbered list (\"1. item\") is fine where the content really is a list — use them sparingly: a "
    "paragraph with three bold phrases has emphasised nothing. No headings (the chapter has one), no "
    "tables (they come from the data), no links, no code.\n"
    "- **Never use emojis.** Not one, anywhere, for any reason.\n"
    "- **Quotation marks are the straight ones: \" and '.** The typesetter turns them into the "
    "report language's own pair and tells opening from closing; a typographic mark you type yourself "
    "(„ “ « ») it cannot pair, and the page shows the mismatch.\n"
    # V264 was released as "one model paragraph per chapter kind". Written that way it would be
    # copied: a whole paragraph is a template, and ten reports would come out with one sentence
    # rhythm. What four real reports actually share is not a paragraph but a handful of
    # SHAPES — the moves an author makes, each of which can carry any content. Those transfer the
    # register without transferring the text, so they are what is given here.
    "\n"
    "Four moves that recur across real LCA reports, as shapes rather than sentences. Use them where "
    "the data supports them; none of them is compulsory, and a chapter that needs none is fine:\n"
    "- **Bound a gap:** \u201c<component> is <share> of <the whole>; even an error of an order of "
    "magnitude would move <indicator> by less than <the spread you already report>.\u201d\n"
    "- **Condition a result:** \u201c<A> is ahead of <B> under the assumptions used here, and that "
    "holds until <the parameter> passes <the value the scenario tested>.\u201d\n"
    "- **Declare a proxy with its direction:** \u201cno dataset exists for <thing>; <the stand-in> is "
    "used with <what was adjusted>, which <over- or understates> <indicator> because <reason>.\u201d\n"
    "- **Refuse a comparison:** \u201cthese figures are <what they are>; they cannot be compared with "
    "<the other thing> because <the boundary or method that differs>.\u201d\n"
    "Two moves that appear in published reports and must NOT be used here, because this study has no "
    "evidence for either: converting a result into an everyday equivalent (car kilometres, flights), "
    "and reasoning about what consumers would do instead. Both need data nobody gave you."
)


def effective_prompt(section: dict[str, Any]) -> str:
    """The prompt actually in force: the author's override or the standard one, plus their additions."""
    base = section.get("prompt_override") or DEFAULT_PROMPTS.get(section.get("kind", "prose")) or DEFAULT_PROMPTS["prose"]
    extra = (section.get("extra_instructions") or "").strip()
    return f"{base}\n\nAdditional instructions from the author:\n{extra}" if extra else base


def placeholder_paths(data: dict[str, Any], limit: int = 120) -> list[str]:
    """Every path a placeholder could name, so the writer does not have to guess them.

    Handing over the actual paths is what makes the "no literal numbers" rule followable; without it a
    model invents plausible-looking ones and every single placeholder fails to resolve.
    """
    paths: list[str] = []
    #: Individual linter findings are not prose material — a chapter citing "finding number 4" breaks
    #: the moment the model is edited. The counts under `health.summary` stay reachable. The research
    #: log and the review outcome renumber the same way (a new question shifts every index), so they
    #: are writer context to paraphrase, never placeholder material.
    skip = {"health.findings", "looked_up", "web_research", "review"}
    #: Free text a chapter should *paraphrase*, not print. A placeholder resolving to 700 characters of
    #: ecoinvent description would drop a wall of text into the middle of a sentence.
    skip_keys = {"description", "classification", "comment"}

    def walk(node: Any, prefix: str) -> None:
        if len(paths) >= limit or prefix in skip:
            return
        if isinstance(node, dict):
            for key, value in node.items():
                if key in skip_keys:
                    continue
                walk(value, f"{prefix}.{key}" if prefix else str(key))
        elif isinstance(node, list):
            # One example index is enough: the shape repeats, and 200 sibling paths drown the prompt.
            if node:
                walk(node[0], f"{prefix}.0")
        elif node not in (None, "") and prefix:
            paths.append(prefix)

    # The cap cuts in walk order, and `build_data` inserts `subjects`, `first_result`, `checks` and
    # `trade_offs` *last* — exactly the paths the interpretation prompts tell the writer to quote. A
    # rich study exceeded the cap before reaching them, and the writer invented paths that then failed
    # to resolve. The load-bearing groups therefore walk first; everything else fills what is left.
    # `contributions` sits among them: the per-indicator breakdowns are what lets a chapter say which
    # phase leads *each* indicator, and the interpretation rules tell it to. Left to the general walk
    # it fell past the cap on a three-indicator study, so the instruction named data the writer was
    # never shown — the failure this ordering exists to prevent, repeated.
    first = (
        "results", "subjects", "first_result", "checks", "trade_offs",
        "contribution", "contributions", "hotspots",
    )
    for key in first:
        if key in data:
            walk(data[key], key)
    walk({k: v for k, v in data.items() if k not in first}, "")
    return paths[:limit]


#: What a chapter may ask to be drawn: a source of rows, the numeric field, and the label field.
#: A whitelist, not a query language — the model picks from these, so a figure can only ever plot data the
#: report already contains, and "silent semantic errors" (LIDA's own term for generated chart code that
#: runs and aggregates the wrong thing) have nowhere to enter.
FIGURE_SOURCES: dict[str, tuple[str, str, tuple[str, ...]]] = {
    # source -> (label field, default value field, other allowed value fields)
    "contribution.groups": ("key", "impact", ("share_percent",)),
    "inventory.flows": ("flow", "impact", ("share_percent",)),
    "hotspots": ("name", "direct", ("share_percent",)),
    "subjects": ("label", "", ()),  # value comes from a subject's own results, handled by the renderer
}
#: What a chapter may draw. "bar" and "stacked_bar" plot a source's rows; "heatmap" and "radar" are built
#: from the report's own subjects × indicators and need no source, which is why they are only offered where
#: there is more than one subject to compare.
FIGURE_KINDS = ("bar", "stacked_bar", "heatmap", "radar")
#: Kinds drawn from the report's comparison rather than from a row source.
FIGURE_COMPARISON_KINDS = ("heatmap", "radar")
FIGURE_MAX_ROWS = 15
#: A chapter may ask for more rows than the writer's default, up to a figure that is still a figure: past
#: about forty bars the labels are unreadable and the thing wants to be a table.
FIGURE_ROW_LIMIT = 40


def _caption(text: Any, limit: int = 200) -> str:
    """A figure caption, cut at a word if it must be cut at all.

    The old hard ``[:160]`` chopped a writer's caption mid-word and the PDF printed
    "…several processes of compa" under a real figure (V124). Over the limit the
    caption now ends after its last whole word, with an ellipsis that says something is missing.
    """
    caption = str(text or "").strip()
    if len(caption) <= limit:
        return caption
    cut = caption[:limit].rsplit(" ", 1)[0].rstrip(" ,;:—-")
    return f"{cut} …"


def accept_figure(spec: Any, data: dict[str, Any] | None) -> dict[str, Any] | None:
    """Validate a figure a chapter asks for. Returns the normalised spec, or raises with the reason.

    None means "no figure", which is a perfectly good answer: a chapter that argues in words does not need
    a chart, and one drawn because it was possible is decoration.

    `data` is the report's own numbers, used to refuse a figure that would be empty or would plot something
    that is not a number. `None` means "not available here" — the case when the *user* sets a figure in the
    chapter editor, where the store has no snapshot: the shape of the spec is still checked, and an empty
    source then simply draws nothing rather than failing a render. The writer always passes the data, because
    a model that asks for a chart of an empty list has misread the brief and should be told.
    """
    if not spec:
        return None
    if not isinstance(spec, dict):
        raise PrismError("A figure must be an object with kind and source.", code="report_figure_bad")
    kind = str(spec.get("kind") or "").strip()
    source = str(spec.get("source") or "").strip()
    if kind not in FIGURE_KINDS:
        raise PrismError(
            f"Unknown figure kind '{kind}'.", code="report_figure_bad_kind",
            hint=f"Allowed: {', '.join(FIGURE_KINDS)}.",
        )
    # Presentation, not content: which way the bars run, and whether a split is stacked or set side by side.
    # Kept out of the source/value validation below because they cannot be wrong about the data — they are
    # how the same numbers are drawn. A caption of one's own overrides the generated one.
    presentation = {
        "horizontal": bool(spec.get("horizontal", True)),
        "stacked": bool(spec.get("stacked", kind == "stacked_bar")),
    }
    if kind in FIGURE_COMPARISON_KINDS:
        # Built from subjects × indicators. No source to check, and no rows: the axes *are* the report.
        return {
            "kind": kind,
            "source": "",
            "value": "",
            "label": "",
            "caption": _caption(spec.get("caption")),
            "rows": 0,
            **presentation,
        }
    if source not in FIGURE_SOURCES:
        raise PrismError(
            f"Unknown figure source '{source}'.", code="report_figure_bad_source",
            hint=f"Allowed: {', '.join(sorted(FIGURE_SOURCES))}.",
        )
    label_field, default_value, others = FIGURE_SOURCES[source]
    if source == "subjects":
        # A rule of its own rather than an exception to two others. `subjects` does not draw a column of
        # a table: it draws one bar per variant, scored on the report's leading indicator, so there is no
        # field to plot and no row count to honour. Switching off the value and row checks for it instead
        # left the source with no checks at all — which is how it shipped drawing a row of empty bars.
        if data is not None:
            scored = [
                s for s in (data.get("subjects") or [])
                if isinstance(s, dict) and (s.get("results") or [])
            ]
            if not scored:
                raise PrismError(
                    "This report has no scored variants, so there is nothing to draw.",
                    code="report_figure_no_data",
                    hint="Drop the figure, or add a variant the report can compute.",
                )
        return {
            "kind": kind,
            "source": source,
            "value": "",
            "label": label_field,
            "caption": _caption(spec.get("caption")),
            "rows": 0,
            **presentation,
        }
    value = str(spec.get("value") or default_value).strip()
    if value not in (default_value, *others):
        # Checked with or without data: a spec typed in the editor could otherwise name a field that only
        # fails at render time, in a place with no one to tell.
        raise PrismError(
            f"'{value}' cannot be plotted from {source}.", code="report_figure_bad_value",
            hint=f"Allowed: {', '.join(v for v in (default_value, *others) if v)}.",
        )
    if data is not None:
        rows = rd.lookup(source, data)
        if not isinstance(rows, list) or not rows:
            raise PrismError(
                f"{source} is empty in this report, so there is nothing to draw.",
                code="report_figure_no_data",
                hint="Drop the figure, or choose a source the report actually has.",
            )
        sample = rows[0] if isinstance(rows[0], dict) else {}
        if not isinstance(sample.get(value), (int, float)) or isinstance(sample.get(value), bool):
            raise PrismError(
                f"'{value}' is not a number in {source}.", code="report_figure_bad_value",
            )
    rows = spec.get("rows")
    return {
        "kind": kind,
        "source": source,
        "value": value,
        "label": label_field,
        "caption": _caption(spec.get("caption")),
        "rows": max(1, min(FIGURE_ROW_LIMIT, int(rows))) if isinstance(rows, (int, float)) else FIGURE_MAX_ROWS,
        **presentation,
    }


def accept_figures(specs: Any, data: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """A chapter's whole list of figures, validated one by one.

    A list rather than the single figure a chapter used to carry: one chapter legitimately wants the
    contribution as bars *and* the same comparison as a heatmap, and the writer's own proposal should not be
    the only figure a chapter can have. Order is the order they are drawn in.
    """
    if specs is None:
        return []
    if not isinstance(specs, list):
        raise PrismError("Figures must be a list.", code="report_figure_bad")
    if len(specs) > 6:
        raise PrismError(
            "A chapter can carry at most six figures.", code="report_figure_too_many",
            hint="More than that is a chapter of charts; split it, or make one of them a table.",
        )
    out = []
    for spec in specs:
        one = accept_figure(spec, data)
        if one:
            out.append(one)
    return out


def figure_label(section_id: str, index: int | None) -> str:
    """The label a chapter's own figure carries: indexed inside a `figures` list, bare for the single
    `figure` a report written before that list carries.

    One formula, because three parties have to agree on it — the renderer's chart keys, the gate's
    authority over what the document contains, and the slot a write stores a requested figure into. They
    disagreed once and it cost a paid rewrite (V215).
    """
    return f"f-section-{section_id}-{index}" if index is not None else f"f-section-{section_id}"


def figure_slot(section: dict[str, Any]) -> tuple[str, str]:
    """Where a figure this chapter *asks for* has to be stored, and the label it will then carry.

    Both readers of a chapter's figures — the renderer and `renders_for` — take the single `figure` only
    while `figures` is empty. So on a chapter that already carries a list, a requested figure put into
    the singular was validated, stored and then drawn by nobody, and the label the writer would point at
    never existed: the same wall as V215, one call further on. Appending to the live list instead keeps
    every label the chapter already has (index `n` is free by definition), which renaming the existing
    ones would not — a label change invalidates a reference the stored text may already carry (V203).

    The empty case stays in the singular: that is where a report written before the list has its figure,
    and moving it would rename `f-section-<id>` to `f-section-<id>-0`.
    """
    figures = list(section.get("figures") or [])
    sid = str(section.get("id") or "")
    if figures:
        return "figures", figure_label(sid, len(figures))
    return "figure", figure_label(sid, None)


def cautions(report: dict[str, Any], data: dict[str, Any]) -> list[str]:
    """Warnings the writer needs *before* writing, derived from this report's own situation.

    Every one of these was previously known only to the gate or to the document. A writer told
    afterwards that a sentence was too strong has to rewrite it; a writer told beforehand does not write
    it. Each entry is a fact about this report, not general advice — general advice is in the invariants.
    """
    out: list[str] = []
    options = report.get("options") or {}
    subjects = [s for s in data.get("subjects") or [] if s.get("results")]

    # ISO 14044 §6/§7.3.3: a comparative assertion disclosed to the public needs a critical review. The
    # document already carries the note; the writer needs to know so the wording stays inside the study.
    # Read through the same helper as the note and the limitations chapter — a brief that says the
    # prohibition does not apply while the document prints the note would send the writer past it.
    reviewed = report_checks.critical_review_recorded(data.get("study") or {})
    if options.get("intended_public") and len(subjects) > 1 and not reviewed:
        out.append(
            "This report is marked for disclosure to the public and compares more than one variant, "
            "with no critical review on record. ISO 14044 does not allow a comparative assertion under "
            "those conditions: never write that one variant is better or preferable. Stay inside the "
            "study — \"shows lower indicator values for X in the system assessed here\"."
        )

    # Through the shared reading, not its own: the brief states this number to the author, the gate
    # judges the sentences by it and the staleness record stores what the chapter was written under.
    # Three normalisations of one option could differ on an unset or a zeroed one (V195).
    threshold = report_claims.weak_percent(options)
    if len(subjects) > 1:
        out.append(
            f"Differences below {threshold:.3g} % are not evidence of a difference in this report — no "
            "uncertainty analysis was carried out. Where two variants are that close, write that they "
            "are comparable and name the spread instead of ranking them."
        )

    flips = data.get("trade_offs") or []
    if flips:
        listed = "; ".join(f"{f['method_label']} → {f['highest']}" for f in flips[:4])
        out.append(
            "The ranking turns over between indicators, so no variant leads throughout: "
            f"{listed}. Name this trade-off rather than describing one variant as ahead."
        )

    if not (data.get("subjects") or []) or len(subjects) < 2:
        # The louder half of a contradiction, earlier: this told the writer nothing supports
        # a scenario comparison while the lookup rules offered `compare_scenarios` for exactly that —
        # and the writer obeyed the caution, wrote “the study supports no statement on
        # robustness”, and a computed −17.8 % scenario sat unmentioned in the model (V293).
        scenario_names = [
            str(sc.get("name", "")) for sc in (data.get("scenarios") or []) if sc.get("name")
        ]
        if scenario_names:
            listed = ", ".join(f"“{n}”" for n in scenario_names[:4])
            out.append(
                "Only one variant is assessed in this report, so it supports no comparison with an "
                f"alternative product. The MODEL, however, carries the scenario(s) {listed}: before "
                "you write anything about robustness or sensitivity — including that none exists — "
                "fetch their numbers with compare_scenarios and report the spread as a model-level "
                "sensitivity note. Never state that no sensitivity analysis was carried out while "
                "the annex lists these scenarios."
            )
        else:
            out.append(
                "Only one variant was assessed, so nothing in this report supports a comparison with "
                "any alternative product or scenario."
            )
    return out



#: Chapters whose job is to sum up the others, and which therefore get to read them. Derived from
#: the ChapterKind registry (in registry order, which reproduces the historical tuples exactly), like
#: the two tables below — three of the seven per-kind tables the registry replaced.
_SUMMARISING = tuple(k.kind for k in report_kinds.KINDS if k.summarising)

#: Chapters worth showing them: the results and their interpretation. Not the annex, the references or
#: the glossary — a table of parameters adds length to the brief and nothing to a summary.
_WORTH_READING = tuple(k.kind for k in report_kinds.KINDS if k.worth_reading)


#: What each kind of chapter is for, in one clause — the document plan handed to every writer.
#:
#: Deliberately terse: the point is not to teach a writer what an inventory chapter is (its own prompt
#: does that) but to tell it that one EXISTS, elsewhere, so it can point instead of repeat. The free
#: `prose` chapter has no fixed job and therefore no entry (its `covers` is empty in the registry).
_KIND_COVERS = {k.kind: k.covers for k in report_kinds.KINDS if k.covers}

#: The framing facts the report fixes once, and where. Restated in every chapter, they are four fifths
#: of the document's repetition.
_SETTLED_IN = {
    "functional unit": "goal_scope",
    "system boundaries": "goal_scope",
    "cut-off criteria": "goal_scope",
    "allocation": "goal_scope",
    "impact assessment method": "methods",
    "background database": "goal_scope",
}


def document_plan(section: dict[str, Any], report: dict[str, Any], lang: str) -> dict[str, Any]:
    """The chapters of this report and what each is for — for a writer that cannot read them.

    Seven of nine chapters get no `written_siblings`: they are written blind, in parallel, and a writer
    that does not know a Goal & Scope chapter exists has no choice but to define the functional unit
    again. It did, five times over, in a wood-stain report (V256) — that is not
    carelessness, it is the only move available.

    So each writer is told what stands where. Not the text: the text is what `written_siblings` is for
    and costs a place in the context window. A list of clauses is enough to turn "define it again" into
    "point at chapter 2".
    """
    chapters: list[dict[str, str]] = []
    for other in sorted(report.get("sections") or [], key=lambda x: x.get("order", 0)):
        kind = str(other.get("kind") or "")
        covers = _KIND_COVERS.get(kind)
        if not covers:
            continue
        title = str(other.get("title") or "").strip() or kind_title(kind, lang)
        entry = {"title": title, "covers": covers}
        if other.get("id") == section.get("id"):
            entry["this_one"] = "yes"
        chapters.append(entry)
    present = {str(o.get("kind") or "") for o in (report.get("sections") or [])}
    settled = {
        what: kind_title(where, lang)
        for what, where in _SETTLED_IN.items()
        if where in present and where != section.get("kind")
    }
    return {"chapters": chapters, "settled_elsewhere": settled}


def written_siblings(section: dict[str, Any], report: dict[str, Any]) -> list[dict[str, str]]:
    """The chapters an executive summary or conclusion should have read, in document order.

    Handed over **as stored**, with their placeholders unresolved — `{{results.0.score}}`, not the number
    it prints. That is the whole trick: a summary that copies a placeholder stays correct when the model
    is recomputed, and it also survives the gate, which refuses a literal number that is not in the
    metadata whitelist. Handing over the *rendered* text would produce a chapter full of frozen figures
    that the check then rejects, one revision round at a time.

    Empty until the other chapters exist, which is why "Write all chapters" writes these two last.
    """
    if section.get("kind") not in _SUMMARISING:
        return []
    out: list[dict[str, str]] = []
    for other in sorted(report.get("sections", []), key=lambda x: x.get("order", 0)):
        if other.get("id") == section.get("id") or other.get("kind") not in _WORTH_READING:
            continue
        text = str(other.get("text") or "").strip()
        if text:
            out.append({"title": other.get("title") or other.get("kind") or "", "text": text})
    return out


def _offer_lcia(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    if not (data.get("results") or []):
        return
    results = data.get("results") or []
    subjects = data.get("subjects") or []
    figures = (report.get("options") or {}).get("figures") or {}
    add("t-lcia", "table", "every indicator with its unit and score")
    # The short-name legend under the results table, which exists only where this chapter is the
    # document's only place for the full method paths: a methods chapter owns that mapping, and then
    # the legend is not drawn at all (report_typst._method_legend, which avoids the label `t-methods`
    # for exactly that reason). Shortening has to have hidden something, too — a path of fewer than
    # three segments is printed whole and needs no legend. Withheld from the brief, not from the
    # gate: it is a key, and a comment has nothing to say about a key.
    paths = [" / ".join(r.get("method") or []) or str((r or {}).get("method_label") or "") for r in results]
    if not any(s.get("kind") == "methods" for s in report.get("sections") or []) and any(
        rt.short_method(path) != path for path in paths
    ):
        add("t-method-legend", "table", "which short indicator name stands for which full method path")
    # One chart per indicator, and only where there is something to compare — the renderer draws none
    # for a single subject, because a chart of one bar is decoration. Mirrors the renderer exactly:
    # `per_indicator_charts` decides which indicators get one, and each carries its own label
    # (f-lcia-0, f-lcia-1, …). The gate used to know only f-lcia-0 and to ignore the setting — it
    # refused references the PDF contains and approved references to charts that were switched off.
    # (Headless renders degrade figures to nothing; that known degradation is not modelled here.)
    if len(subjects) > 1:
        charts = str(section.get("per_indicator_charts") or "all")
        shown = [] if charts == "none" else (results[:1] if charts == "lead" else results)
        for i, result in enumerate(shown):
            label = str((result or {}).get("method_label") or f"indicator {i + 1}")
            add(f"f-lcia-{i}", "figure", f"{label} across the variants")
        if figures.get("heatmap"):
            add("f-heatmap", "figure", "variants × indicators, each cell as a share of its column's largest")
        if figures.get("radar") and len(results) > 3:
            add("f-radar", "figure", "the variants over all indicators, each normalised to its own maximum")


def _offer_contribution(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    # The chapter's dimension: the report's own (bare labels) or one of its own (`-d<k>` in every
    # label) — the same rule the renderer applies in `report_render._build_contribution`.
    dims = list(data.get("breakdown_dimensions") or [])
    own_dim = str(section.get("aggregate_by") or "")
    k = dims.index(own_dim) if own_dim and own_dim in dims else 0
    stem = "contribution" if k == 0 else f"contribution-d{k}"
    all_views = (
        (data.get("contributions_by_dimension") or {}).get(dims[k]) or []
        if k
        else data.get("contributions") or []
    )
    if not k and not ((data.get("contribution") or {}).get("groups") or []):
        return
    # One table and one figure per indicator the chapter prints, under the labels the renderer
    # gives them — the lead keeps the bare pair every written report already references. Offering
    # only that pair meant a chapter could not point at the tables it had itself printed, and a
    # reference to one would have been refused as unknown.
    hidden = {str(x) for x in (section.get("hidden_indicators") or [])}
    views = [
        v for v in all_views
        if str(v.get("method_label") or "") not in hidden and v.get("groups")
    ]
    if k and not views:
        return
    for view in views or [{}]:
        index = int(view.get("index", 0))
        suffix = "" if index == 0 else f"-{index}"
        label = str(view.get("method_label") or "")
        named = f" for {label}" if label and len(views) > 1 else ""
        add(f"t-{stem}{suffix}", "table", f"each group with its impact and share{named}")
        # All three shapes the renderer can draw — stacked, grouped, plain bars — carry this one
        # label, so it resolves to whichever was actually drawn.
        add(f"f-{stem}{suffix}", "figure", f"the same groups as bars{named}")
        # The hotspot table under the split, when the chapter prints it (its own switch).
        if section.get("hotspots") and view.get("hotspots"):
            add(f"t-{stem}-hotspots{suffix}", "table", f"the background datasets with the largest direct contribution{named}")


def _offer_inventory(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    parts = section.get("inventory_parts") or ("processes", "datasets")
    if "processes" in parts and data.get("foreground"):
        add("t-foreground", "table", "every foreground process with its reference product and unit")
    if "datasets" in parts and data.get("background_datasets"):
        add("t-datasets", "table", "the background datasets the model links to directly")
    if "parameters" in parts and data.get("parameters"):
        add("t-parameters", "table", "the model's named parameters with their values and sources")
    if "flows" in parts and (data.get("inventory") or {}).get("flows"):
        # The fourth part of the chapter (`LCI_PARTS`), off by default because the annex usually
        # carries it. A study that moved it here prints the same table under the same label, so the
        # offer and the gate have to know it from this chapter too — otherwise the one report shape
        # that keeps its flows in the inventory could not point at them.
        add("t-inventory", "table", "the elementary flows carrying the leading indicator")


def _offer_datasets(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    # The background datasets as a chapter of their own, under the label the inventory chapter's
    # sub-section also uses. Nothing offered this before, so the gate learned `t-datasets` only from
    # an inventory chapter — and refused it in exactly the reports that give the table its own page.
    if data.get("background_datasets"):
        add("t-datasets", "table", "the background datasets the model links to directly")


def _offer_methods(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    if not (data.get("results") or []):
        return
    add("t-methods", "table", "the indicators chosen, with the method family each comes from")


def _offer_interpretation_checks(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    checks = data.get("checks") or {}
    # Only when the check actually *found* something: a clean completeness check renders as a
    # sentence, not as a labelled table, so offering the label promised a target that would not
    # exist — and the first real report duly printed "[missing reference: t-completeness]". The
    # rule this file states at the top of the function is that each condition mirrors the
    # renderer's own; this one did not.
    if (checks.get("completeness") or {}).get("findings"):
        add("t-completeness", "table", "the structural completeness check and its findings")
    if checks.get("consistency"):
        add("t-consistency", "table", "what is held constant across the variants")
    if checks.get("sensitivity"):
        add("t-sensitivity", "table", "the spread per indicator across the scenarios")
    # The per-variant change table prints under the same condition the sensitivity section uses to
    # print anything at all (`report_checks._sensitivity`): two variants, at least one under a scenario.
    subjects = [s for s in data.get("subjects") or [] if s.get("results")]
    if len(subjects) >= 2 and any(s.get("scenario") for s in subjects):
        add("t-deltas", "table", "each variant's change against the first, per indicator, in percent")


def _offer_appendix(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    # In the order the annex prints them (`report_render._appendix_blocks`): the parameters, the
    # scenarios, then the flows. The order is the reader's, and a brief that lists them in another
    # one invites "the table above" to mean the wrong table.
    if data.get("parameters"):
        add("t-parameters", "table", "the model's named parameters with their values and sources")
    if data.get("scenarios"):
        # Printed whenever the report has scenarios, and missing from this list until now — an annex
        # comment could not point at the definitions of the variants the whole comparison is about.
        add("t-scenarios", "table", "each scenario with what it changed")
    if (data.get("inventory") or {}).get("flows"):
        add("t-inventory", "table", "the elementary flows carrying the leading indicator")


def _offer_references(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    # The bibliography itself is unconditional: it carries the background database, the method
    # families and the two standards, so there is always a table under this heading. The two source
    # tables under it are not — one exists where the study's own notes cite something, the other
    # where the research log recorded a source no note cites. Both conditions are the same
    # collectors the renderer calls (`report_sources`), *called* rather than re-derived: a second
    # answer to "which sources count" is an answer waiting to disagree with the document.
    add("t-references", "table", "the background database, the method families and the standards")
    cited = report_sources.cited_sources(data)
    if cited:
        add("t-sources", "table", "the sources the study's own notes cite, and where each is cited")
    if report_sources.researched_sources(data, exclude={url for url, _ in cited}):
        add("t-web-research", "table", "the web sources the study's research consulted")


def _offer_abbreviations(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    # Which acronyms the finished document uses is knowable from the blocks, and this function has
    # only the report and its data — so the condition is the *stored* glossary. That is sound rather
    # than approximate for the case that matters: the stored list was filtered against a rendered
    # document when it was written (`accept_abbreviations` drops anything that was not a candidate),
    # so a non-empty one means a table in any report whose chapters still stand. The residue is
    # narrow and stated: if every stored term has since disappeared the chapter prints a note, and a
    # reference to it would print a gap. Refusing the label outright cost the opposite in *every*
    # report, which is the trade V197 was about.
    if report.get("abbreviations"):
        add("t-abbreviations", "table", "the acronyms the document uses, with their expansions")


def _offer_summary(add: Callable[[str, str, str], None], section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    results = data.get("results") or []
    if len(data.get("subjects") or []) <= 1 or not results:
        return
    add("f-summary", "figure", "every variant side by side for the leading indicator")



#: kind -> what its chapter offers the brief and the gate: the dispatch that replaced the
#: ten-branch if/elif chain. Kinds without an entry offer no renders of their own (goal_scope,
#: limitations, provenance, conclusions, prose) — their chapters carry only their own figures,
#: handled below for every kind alike. Coverage against the ChapterKind registry is pinned by
#: tests/test_report_kinds.py.
def _offer_system_model(add, section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> None:
    if (data.get("system_model") or {}).get("nodes"):
        add("f-system-model", "figure", "the system model: the foreground processes and their direct background datasets")


_RENDER_OFFERS: dict[str, Callable[..., None]] = {
    "lcia": _offer_lcia,
    "system_model": _offer_system_model,
    "contribution": _offer_contribution,
    "inventory": _offer_inventory,
    "datasets": _offer_datasets,
    "methods": _offer_methods,
    "interpretation_checks": _offer_interpretation_checks,
    "appendix": _offer_appendix,
    "references": _offer_references,
    "abbreviations": _offer_abbreviations,
    "summary": _offer_summary,
}


def renders_for(section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> list[dict[str, str]]:
    """What will actually stand above (or under) this chapter's paragraph, and how to point at it.

    A deterministic chapter's instruction says "comment on the analysis below the table" — and until this
    existed, the brief never said *what* that table is, which figures the chapter carries, or what to write to
    reference them. A writer who cannot point at a figure either ignores it or, worse, describes it: the shares
    are already drawn, and repeating them in prose is the one thing a comment should not do.

    Deliberately thin *per entry*. Kind, one phrase, and the reference — not the figure's orientation, row
    count or whether a split is stacked. None of that changes what a comment should *say*, and every extra
    field in a brief is another field a model can misread.

    Complete in its *entries*, though, which is the opposite discipline and was the bug. Two different
    questions read this list: what a writer may be offered (this, filtered — `offered_renders`), and what
    the gate must accept as a cross-reference (`document_labels`, the union over every chapter). While one
    thin list answered both, the tables the annex, the bibliography and the glossary print — `t-scenarios`,
    `t-references`, `t-sources`, `t-web-research`, `t-abbreviations`, and the results chapter's
    `t-method-legend` — were in neither: a chapter writing "the sources are listed in
    {{ref:t-references}}" was refused over a reference the PDF resolves perfectly, and paid a revision
    round for it (V197). Only the *offer* may be narrow, so completeness lives here and the narrowing is
    one explicit set.

    Each entry's condition mirrors the renderer's own, so nothing is promised that will not be drawn: a table
    of results needs results, a contribution figure needs groups, a sensitivity table needs scenarios.
    """
    kind = section.get("kind") or "prose"
    out: list[dict[str, str]] = []

    def add(ref: str, what: str, shows: str) -> None:
        out.append({"ref": "{{ref:" + ref + "}}", "kind": what, "shows": shows})

    offer = _RENDER_OFFERS.get(kind)
    if offer is not None:
        offer(add, section, report, data)

    # The chapter's own figures, in the order it lists them — the ones set in its editor. Keyed by index, so
    # they are the same references the renderer places.
    specs = list(section.get("figures") or []) or ([section["figure"]] if section.get("figure") else [])
    indexed = bool(section.get("figures"))
    for i, spec in enumerate(specs):
        if not spec:
            continue
        ref = figure_label(str(section.get("id") or ""), i if indexed else None)
        source = str(spec.get("source") or "")
        shows = {
            "contribution.groups": "the contribution groups",
            "hotspots": "the largest single processes",
            "inventory.flows": "the elementary flows",
            "subjects": "the variants",
        }.get(source, "this chapter's own figure")
        if spec.get("kind") == "heatmap":
            shows = "variants × indicators as a heatmap"
        elif spec.get("kind") == "radar":
            shows = "the variants over all indicators"
        add(ref, "figure", shows + " (this chapter's own)")
    return out


#: Labels the brief withholds from a writer although the gate accepts a reference to them.
#:
#: The two lists may legitimately differ — what the document contains is arithmetic, what a chapter
#: *should* point at is a judgement — but only in this direction and only here. Anything the renderer
#: emits belongs in `renders_for`, or the gate refuses a reference the PDF resolves (V197); what a
#: writer has no business pointing at is named below, once, with its reason.
#:
#: One entry so far. `t-method-legend` maps a short indicator name to its full method path: a key, not
#: evidence, and present only in reports without a methods chapter. A comment pointing at it would send
#: the reader to a lookup table instead of to a finding.
_WITHHELD_FROM_BRIEF = frozenset({"t-method-legend"})


def _label_in(ref: str) -> str:
    """The bare label inside a `{{ref:…}}` token, or "" for anything else.

    One parser for both readers of `renders_for`, so the gate's set and the brief's filter cannot
    disagree about what the token says.
    """
    return ref[len("{{ref:") : -2] if ref.startswith("{{ref:") and ref.endswith("}}") else ""


def offered_renders(section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> list[dict[str, str]]:
    """The subset of `renders_for` the brief actually offers this chapter.

    Derived rather than maintained: the conditions are written once, in `renders_for`, and this only
    removes what `_WITHHELD_FROM_BRIEF` names. That is the whole reason the offer is a filter and not a
    second list — a second list is how the gate's authority came to be narrower than the renderer in
    the first place, and it drifted silently for five labels.
    """
    return [
        entry
        for entry in renders_for(section, report, data)
        if _label_in(entry.get("ref") or "") not in _WITHHELD_FROM_BRIEF
    ]


def document_labels(report: dict[str, Any], data: dict[str, Any]) -> set[str]:
    """Every `@label` this document will actually contain, across all of its chapters.

    A Typst label is document-wide, so a chapter may legitimately point at another chapter's table —
    "see Table 2" is how a report reads. What it may *not* do is point at a label nobody emits, and
    that is not a matter of opinion: the set is computable, from the same conditions the renderer
    uses. Without it a reference was checked for its *spelling* only, and a well-formed name for a
    table that does not exist sailed through the gate and printed "[missing reference: …]" in the
    client's PDF — which is what happened when an executive summary, handed the results chapter to
    summarise, copied the shape of its figure reference and put its own chapter id inside.

    The *unfiltered* `renders_for`, deliberately: this is the authority on what exists, so it has to be
    at least as wide as the renderer. Narrower is not caution, it is a false refusal — a chapter
    pointing at the bibliography or the glossary was rejected for a reference that renders perfectly,
    and every such rejection buys a paid revision round (V197). What a writer is *offered* is the
    narrow question, and `offered_renders` answers it.
    """
    labels: set[str] = set()
    for section in report.get("sections") or []:
        for entry in renders_for(section, report, data):
            label = _label_in(entry.get("ref") or "")
            if label:
                labels.add(label)
    return labels


#: The comparison figures a report can switch **off**, by the label they carry — each with the name the
#: scope card prints beside its checkbox.
#:
#: Two options, not three. `figures.stacked` picks *how* the contribution is drawn — the renderer
#: supplies `contribution-stacked` or `contribution-grouped` under the one label `f-contribution` — so
#: flipping it removes nothing and must report nothing. These two remove the drawing itself, and with
#: it the only thing a reference to them could resolve to.
SWITCHABLE_FIGURES: dict[str, tuple[str, str]] = {
    "f-heatmap": ("heatmap", "Heatmap of every indicator"),
    "f-radar": ("radar", "Radar across the indicators"),
}


def switched_off_figure(label: str, report: dict[str, Any]) -> str | None:
    """The scope-card name of the figure this label points at, if that box is the reason it is dead.

    Deliberately the narrow question. "Which labels exist" has an answer (`document_labels`); "why is
    this one missing" mostly has not — a table can be absent because its chapter was deleted, because
    the check it reports found nothing, because the data has a single subject. This names the one cause
    that is both certain from the stored report and repairable with a click.

    Only while the chapter that would carry the figure is still there: with the impact assessment
    deleted the checkbox is not the remedy, and sending the author to a switch that changes nothing is
    the same mistake as blaming the wrong thing in the first place.
    """
    entry = SWITCHABLE_FIGURES.get(label)
    if entry is None:
        return None
    key, name = entry
    if ((report.get("options") or {}).get("figures") or {}).get(key):
        return None
    if not any(s.get("kind") == "lcia" for s in report.get("sections") or []):
        return None
    return name


def reference_gap(label: str, report: dict[str, Any]) -> str:
    """Why a cross-reference that will not resolve does not resolve — the cause, not a guess at it.

    There was one sentence for every case, and it named a chapter: "the chapter it points at is no
    longer in this report". Measured (V196) with nothing deleted at all — the heatmap
    checkbox was cleared, two chapters kept quoting `{{ref:f-heatmap}}`, and the export sent the author
    looking for a chapter that was never gone. A reference dies for several reasons and the message has
    to name the one it actually knows.

    Three, in order of how much they know. The switched-off figure carries its own remedy, because it
    has one. Any other `f-` label at least denotes a figure, so it can say so instead of inventing a
    lost chapter. Everything else keeps the old wording: a `t-` label really is a chapter's table, and
    "the contribution chapter was deleted" is the case that produced this sentence.
    """
    name = switched_off_figure(label, report)
    if name:
        return (
            f"the “{name}” figure is switched off for this report; switch it back on under "
            "Scope & indicators, or drop the reference"
        )
    if label.startswith("f-"):
        return "the figure it points at is not part of this report"
    return "the chapter it points at is no longer in this report"


def _cap(text: object, limit: int) -> str:
    value = str(text or "")
    return value if len(value) <= limit else value[: limit - 1] + "…"


#: Fact blocks that only some chapters can use, and which chapters those are. Everything not named
#: here goes to every chapter, which is the safe default: the gate judges a text against the full
#: `data`, so trimming the *brief* can never turn a true sentence into a refused one — it can only
#: leave a writer without material, and that is the failure this map has to stay conservative about.
#:
#: Measured on the LCIA chapter of a wood-stain report: the single largest block in its
#: brief was `web_research` — 12.7k characters, a quarter of everything it was shown — the research
#: log of the MODELLING run, which an impact-assessment chapter has no use for whatever. `review` sat
#: beside it, and since M4.2 a chapter that so much as mentions the internal review is refused: it was
#: handing every writer a trap along with the noise (V259).
_SPECIALIST_FACTS: dict[str, frozenset[str]] = {
    # Where the study's sourced findings are actually printed or cited in words — and where the literature
    # is discussed: the introduction's background, the interpretation's comparison with published studies.
    "web_research": frozenset({"references", "inventory", "limitations", "introduction", "prose"}),
    # The internal review's open findings are limitations material and nothing else's.
    "review": frozenset({"limitations"}),
    # Why each input was chosen — a proxy, a sign, one of two equivalent datasets: the subject of the
    # inventory, of the consistency check and of an interpretation that weighs what its hotspots rest on.
    # Elsewhere they only lengthen the brief.
    "exchange_notes": frozenset({"inventory", "interpretation_checks", "prose"}),
}


def exchange_notes(data: dict[str, Any]) -> list[dict[str, Any]]:
    """The comments on the foreground's exchanges as a chapter is shown them: process by process, capped
    per note and in number, because a large model with a reason on every input would crowd the brief."""
    notes = [
        {"process": p.get("name"), "input": n.get("input"), "location": n.get("location") or None,
         "note": _cap(n.get("note"), 400)}
        for p in data.get("foreground") or [] for n in (p.get("exchange_notes") or []) if n.get("note")
    ]
    return notes[:40]


def brief_facts(data: dict[str, Any], kind: str = "") -> dict[str, Any]:
    """The values a chapter writer is shown — the counterpart of the paths in `placeholder_paths`.

    This selection used to live in the frontend (`reportWriter.ts`, `factsFor`) and had drifted from
    the prompts: the inventory prompt told the writer to read the process notes and the parameter
    comments, the LCIA prompt said trade-offs were "listed for you", the checks prompt said to quote
    `checks` — and none of the three was in what the frontend handed over, while the gate judged the
    text against the full snapshot. The writer could copy placeholder *paths* blind, but every
    judgement ("the spread is narrow", "this rests on an estimate") was a guess. Built server-side
    now, next to the prompts and the gate, so the three cannot drift apart again.

    Capped, not complete: the full snapshot on a rich comparison is bigger than a chapter deserves,
    and the tail of every list is noise for prose. The caps are per-field so no single long
    description can crowd out the numbers.
    """
    facts: dict[str, Any] = {
        "study": data.get("study") or {},
        "activity": data.get("activity"),
        "amount": data.get("amount"),
        "results": data.get("results"),
        "subjects": [
            {"label": s.get("label"), "results": s.get("results")} for s in (data.get("subjects") or [])
        ],
        "contribution": (
            {
                "dimension": (data.get("contribution") or {}).get("dimension"),
                "unit": (data.get("contribution") or {}).get("unit"),
                # The tail of a contribution list is noise for prose; the head is what gets discussed.
                "groups": ((data.get("contribution") or {}).get("groups") or [])[:10],
            }
            if data.get("contribution")
            else None
        ),
        # One breakdown per indicator — which phase leads *each* indicator is the sentence the LCIA
        # prompt asks for, and it cannot be said from the lead indicator's breakdown alone.
        "contributions": [
            {
                "index": c.get("index"),
                "method_label": c.get("method_label"),
                "unit": c.get("unit"),
                "groups": (c.get("groups") or [])[:8],
            }
            for c in (data.get("contributions") or [])[:12]
        ],
        # The evidence a real interpretation rests on: which dataset, which emission — with the
        # leading hotspots' own dataset descriptions and attributed inputs.
        "hotspots": (data.get("hotspots") or [])[:8],
        "inventory": (
            {
                "method": (data.get("inventory") or {}).get("method"),
                "unit": (data.get("inventory") or {}).get("unit"),
                "flows": ((data.get("inventory") or {}).get("flows") or [])[:8],
            }
            if (data.get("inventory") or {}).get("flows")
            else None
        ),
        # The three ISO 14044 §4.5 checks as numbers — whether a spread is wide is a judgement the
        # writer can only make while looking at it.
        "checks": data.get("checks"),
        "trade_offs": data.get("trade_offs"),
        # The model's own documentation: what the inventory chapter is told to read the pattern from.
        "foreground": [
            # The reference product beside the name because the inventory chapter now *writes* these
            # processes rather than printing their notes under them: "what this process
            # makes" is half of what a description has to say, and the writer could not see it.
            {"name": p.get("name"), "product": p.get("product"),
             "description": _cap(p.get("description"), 700)}
            for p in (data.get("foreground") or [])[:20]
        ],
        "parameters": [
            {
                # Its own path, because the writer otherwise counts. `placeholder_paths` shows one
                # example index per list ("the shape repeats"), and a report that wanted a U-value
                # arrived at `parameters.16` by counting the entries of this list (V182) — right that
                # time, and one insertion away from naming another parameter's figure. Stating it is
                # a line of JSON; counting is the part that goes wrong.
                "path": f"parameters.{index}",
                "name": p.get("name"),
                "amount": p.get("amount"),
                "unit": p.get("unit"),
                "formula": p.get("formula"),
                "description": _cap(p.get("description") or p.get("comment"), 300),
            }
            for index, p in enumerate((data.get("parameters") or [])[:30])
        ],
        "scenarios": [
            # Its own path, for the reason `parameters` above has one: the writer otherwise counts this
            # list, and three chapters of a mould-remover report did — "o cenário
            # {{scenarios.1.name}} quase não desloca nenhum indicador" was arrived at by counting
            # (V194). The pin makes the count survive a deletion; stating the path keeps it from being
            # off by one to begin with.
            {"path": f"scenarios.{index}", "name": s.get("name"),
             "description": _cap(s.get("description"), 300)}
            for index, s in enumerate((data.get("scenarios") or [])[:15])
        ],
        "exchange_notes": exchange_notes(data),
        "provenance": data.get("provenance"),
        # Build provenance: what was researched (to say in words where a figure comes from) and what
        # the internal review concluded (open findings are limitations material).
        "web_research": [
            {
                "question": _cap(e.get("question"), 200),
                "findings": [
                    {"text": _cap(f.get("text"), 300), "sources": (f.get("sources") or [])[:3]}
                    for f in (e.get("findings") or [])[:5]
                ],
            }
            for e in (data.get("web_research") or [])[-12:]
        ],
        "review": data.get("review") or None,
    }
    return {
        k: v
        for k, v in facts.items()
        if v not in (None, [], {})
        and (k not in _SPECIALIST_FACTS or not kind or kind in _SPECIALIST_FACTS[k])
    }


def printed_names(report: dict[str, Any], data: dict[str, Any]) -> dict[str, str]:
    """Stored text → the text the document prints, for every study string a translation moved.

    The snapshot a writer is given is already translated, so nothing in the brief carries a German
    name in an English report. A **lookup** does: `get_process_details` answers out of the model, and
    the model's stored names never move. One run is the measurement — with lookups
    encouraged (V258) the inventory chapter made eleven, and four German process names walked out of
    their answers and into its prose, two chapters after the table printed them in English (V260).
    More lookups is the fix working; this is its bill.

    Handed over as pairs so the writer's lookup path can rewrite an answer before the model reads it.
    An instruction would not do: the name in front of a model is the name it writes.
    """
    stored = (report or {}).get("translations") or {}
    mapping = stored.get("map") or {}
    if not mapping or stored.get("lang") != normalise(report.get("lang")):
        return {}
    out: dict[str, str] = {}
    for candidate in ((data.get("translations") or {}).get("candidates") or []):
        source = str(candidate.get("text") or "").strip()
        target = str(mapping.get(candidate.get("key")) or "").strip()
        # Identity answers are stored on purpose (they mark a sentence as checked), and a pair that
        # replaces a string with itself is work for nothing. Short strings are left out too: a
        # two-character source would match inside longer words.
        if source and target and source != target and len(source) > 3:
            out[source] = target
    return out


def build_brief(section: dict[str, Any], report: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    """Everything the writer needs — and exactly what the check will judge against."""
    lang = normalise(report.get("lang"))
    language = _LANGUAGE_NAMES.get(lang, "English")
    kind = section.get("kind") or "prose"
    unit = str((data.get("study") or {}).get("functional_unit") or "").strip()
    return {
        "section_id": section.get("id"),
        "kind": kind,
        # The name the chapter is PRINTED under, not the internal kind. A section usually carries no
        # title of its own — the renderer supplies the default — so this used to fall through to the
        # kind, and the writer was told "Chapter: lcia". The one thing every writer needs to know is
        # which chapter it is writing, and it was being told in a code word.
        "title": str(section.get("title") or "").strip() or kind_title(kind, lang),
        "language": language,
        "lang": lang,
        "prompt": effective_prompt(section),
        # The author's own additions once more, on their own: the writer repeats them after the material,
        # where the last word on audience, length and form belongs (writer/messages.ts `writerUser`).
        "author_instructions": (section.get("extra_instructions") or "").strip(),
        "invariants": _INVARIANTS.format(
            language=language,
            functional_unit=unit or "as recorded in the study metadata (not defined there)",
        ),
        # A deterministic chapter is not written but *commented*: the tables above stay the source, and
        # the paragraph goes underneath them. Saying so is what keeps a comment from restating the table.
        "commentary": kind not in PROSE_KINDS,
        "cautions": cautions(report, data),
        "study": data.get("study") or {},
        "placeholders": placeholder_paths(data),
        # The values behind those paths, capped for prose. The writer used to select these itself
        # (and selected less than its own prompt referred to); selecting them here, beside the
        # prompts and the gate, is what keeps assignment, evidence and check congruent.
        "facts": brief_facts(data, kind),
        "derivations": sorted(rd.DERIVATIONS),
        # What the rest of the document already says, for the two chapters that summarise it. Placeholders
        # intact — see written_siblings. Empty for every other kind, and empty until they are written.
        "written": written_siblings(section, report),
        "document_plan": document_plan(section, report, lang),
        "printed_names": printed_names(report, data),
        "figure_sources": {k: [v[1], *v[2]] for k, v in FIGURE_SOURCES.items() if v[1]},
        "figure_kinds": list(FIGURE_KINDS),
        # The label a figure this write asks for will carry, so it can be pointed at in the same
        # paragraph. It depends on what the chapter already draws (`figure_slot`), so guessing it was
        # never possible — and a writer that guessed wrong bought an `unknown_reference` for a chart it
        # had itself commissioned.
        "figure_ref": figure_slot(section)[1],
        # What the document itself already shows at this point, and how to reference it. Not data — every
        # number in these tables is in `data` below; this says which of them the reader can already see.
        # The offer, not the authority: the gate accepts a reference to anything the document contains
        # (`document_labels`), while this leaves out the few labels a comment has no business pointing at.
        "renders": offered_renders(section, report, data),
        "data": data,
        # Whether this chapter's writer may search the literature: the kind is one that discusses it
        # (`report_kinds.LITERATURE_KINDS`) and the chapter's own switch is not off — on until unticked.
        "literature": section.get("literature_search") is not False and kind in report_kinds.LITERATURE_KINDS,
    }


# ---- the gate ---------------------------------------------------------------

#: Pictographs, symbols and the variation selector that makes them coloured. Ranges rather than a list:
#: a ban with holes in it is a ban a model finds the holes in. Deliberately excludes the characters an
#: LCA text needs — the degree sign, the en dash, superscripts, Greek letters.
#: Wordings in which a chapter stops describing the study and starts describing its own making.
#:
#: Narrow on purpose, because the check blocks. Three families, each with no innocent reading in a
#: chapter about a product system: the DOCUMENT talking about itself ("this report", "the deliverable
#: is", "model-only study"), the MACHINERY ("internal review", "health check", "the assistant", a tool
#: name, a model name), and the RESEARCH RUN narrated instead of cited ("research showed", "the search
#: found"). "The study", "this assessment", "the model" as the product system — all untouched: those
#: are what the document is about.
_SELF_REFERENCE = re.compile(
    r"\b(?:"
    r"this report|the deliverable is|model[- ]only (?:study|assessment)|rather than a report"
    r"|dieser Bericht|kein Bericht|reine[sr]? Modell(?:studie|auftrag)"
    r"|internal (?:model )?review|automated (?:model )?(?:review|check)|health check|linter"
    r"|interne[rs]? (?:Modell[- ]?)?Review|Modellpr\u00fcfung|Gesundheitspr\u00fcfung"
    r"|the assistant|language model|Sprachmodell|Assistent"
    r"|research_web|review_model|research showed|the search found|die Recherche ergab"
    r"|Prism(?:\s?LCA)?"
    r")\b",
    re.IGNORECASE,
)

#: The antithesis, counted. Not judged — a single "rather than" is ordinary English and this must
#: never fire on one. What it catches is the HABIT: a wood-stain report used the figure
#: eight times in nine chapters, which is a voice, not a choice (V257).
_ANTITHESIS = re.compile(
    r"\brather than\b|\bnot [^,.;]{1,40}, but\b|\bnicht [^,.;]{1,40}, sondern\b"
    r"|\bwhat (?:survives|remains|holds)\b[^.]{0,80}\bwhat (?:does not|doesn't)\b",
    re.IGNORECASE,
)

#: Antitheses per thousand words above which the check remarks on it. Three in a 400-word chapter is a
#: tic; one is a sentence. Advisory only — style is the author's, and a blocking style rule would be
#: switched off within a week, which is the trade every check in this module makes.
_ANTITHESIS_PER_1000 = 6.0

_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF\U0000FE0F\U0001F1E6-\U0001F1FF]"
)

#: A bare number typed into the prose. Forbidding every digit produces worse prose than it prevents,
#: so two kinds are left alone: small numbers and years ("the 3 phases", "in 2021"), and numbers that
#: are part of a *designation* rather than a result — "ISO 14044", "ecoinvent 3.12", "CML v4.8". Those
#: cannot go stale when the model is recomputed, which is the only thing this rule protects against.
_LITERAL_NUMBER = re.compile(r"(?<![\w.])\d[\d.,]*(?:[eE][+-]?\d+)?")
_ALLOWED_LITERALS = re.compile(r"^(?:1[0-9]{3}|20[0-9]{2}|1[0-9]|[0-9])$")
_DESIGNATORS = (
    "iso", "en", "din", "iec", "cen", "ipcc", "cml", "recipe", "traci", "pef", "epd",
    "ecoinvent", "gabi", "usetox", "gwp", "version", "v", "no",
)
_DESIGNATED = re.compile(
    r"(?:\b(?:" + "|".join(_DESIGNATORS) + r")\b[\s.:v-]*)(\d[\d.,]*)", re.IGNORECASE
)


def _numbers_in(text: str) -> list[tuple[str, int]]:
    """Numbers that are neither a designation nor obviously harmless, with where each one ends."""
    designated = {m.start(1) for m in _DESIGNATED.finditer(text)}
    return [(m.group(0), m.end()) for m in _LITERAL_NUMBER.finditer(text) if m.start() not in designated]


#: Unit tokens as they follow a figure in prose. Lower-cased; identifiers stay verbatim in reports, so
#: the SI/LCA symbols cover the five languages — the words are a small extra net. Matched as a PREFIX of
#: the token (see `_unit_prefix`), so "kg" also covers "kg CO2-Eq", "kgCO2e", "kg-CO2-eq" and "kg/FU",
#: and "MJ" covers "MJ-eq"; the LCIA method's own units are added per report (`_method_units`).
_UNIT_WORDS = frozenset({
    "kg", "g", "mg", "µg", "ug", "ng", "t", "kt", "mt", "km", "m", "cm", "mm", "l", "ml", "hl", "ha",
    "mol", "kmol", "kwh", "mwh", "gwh", "twh", "mj", "gj", "kj", "tj", "j", "w", "kw", "mw", "wh",
    "ppm", "ppb", "pt", "pts", "mpt", "bq", "kbq", "pa", "kpa", "mpa", "kcal", "cal", "m2", "m3",
    "m²", "m³", "m2a", "m3a", "km2", "km²", "tkm", "pkm", "vkm", "ctuh", "ctue", "daly", "dalys",
    "points", "punkte", "tonne", "tonnes", "tonnen", "toneladas", "tonnellate", "kilogram",
    "kilograms", "kilogramm", "kilogramme", "kilogrammes", "kilogramos", "chilogrammi", "gram",
    "grams", "gramm", "litre", "litres", "liter", "liters", "litros", "megajoule", "megajoules",
    "kilometre", "kilometres", "kilometer", "kilometers", "percent", "prozent", "pourcent",
})

#: What may stand between a figure and its unit: nothing ("12kg", "12%"), a space or a no-break space
#: ("12 kg", "12\u202fkg"), or a hyphen ("a 2-kg bottle").
_UNIT_TOKEN = re.compile(r"[\s-]{0,2}([^\s.,;:)\]]{1,16})")


def _unit_prefix(token: str, extra: frozenset[str] = frozenset()) -> str | None:
    """The physical unit the token begins with — "kg" for "kg", "kgCO2e", "kg-CO2-eq", "Kg" — or None.

    A prefix counts only where the unit ENDS there: what follows is nothing, a non-letter ("kg-eq",
    "g/km") or a reference substance with a digit in it ("kgCO2e", "tCO2eq"). A bare letter run does
    not count, or "m" would start "months", "l" would start "LCA" in "the 2 LCA studies" and "km" would
    start "KMU". Case is folded for the unit itself ("Kg", "MJ"); the longest unit wins ("mj", not "m").
    """
    if token[:1] in ("%", "‰"):
        return token[0]
    if token.startswith("°"):
        return "°"
    low = token.lower()
    for unit in sorted(_UNIT_WORDS | extra, key=len, reverse=True):
        if not low.startswith(unit):
            continue
        rest = token[len(unit):]
        if not rest or not rest[0].isalpha() or any(c.isdigit() for c in rest):
            return unit
    return None


def _method_units(data: dict[str, Any]) -> frozenset[str]:
    """The leading symbol of every unit the report's own results carry — "CTUh", "kBq", "disease".

    The static list cannot know every LCIA method's unit; the results handed to the writer can. Only
    result and contribution units: a parameter's unit may be "piece" or "unit", and "12 pieces" is a
    count, which is what the small-number allowance exists for.
    """
    units = [r.get("unit") for r in data.get("results") or [] if isinstance(r, dict)]
    units.append((data.get("contribution") or {}).get("unit"))
    out: set[str] = set()
    for unit in units:
        if not isinstance(unit, str) or not unit.strip():
            continue
        lead = re.split(r"[\s.,/(]", unit.strip(), maxsplit=1)[0].lower()
        if len(lead) >= 2 and re.search(r"[a-zµ]", lead) and lead not in _DESIGNATORS:
            out.add(lead)
    return frozenset(out)


def _physical_unit_after(text: str, end: int, extra: frozenset[str] = frozenset()) -> str | None:
    """The physical unit written right after a number — "kg" for "12 kg CO2-Eq", "%" for "12 %".

    The strict half of `_unit_follows`, and the only half the small-number allowance asks: "the 3
    LCIA methods" and "2 EPDs" start with capitals and would read as units to the broader test.
    """
    m = _UNIT_TOKEN.match(text[end:])
    return _unit_prefix(m.group(1).rstrip(".,;:!?"), extra) if m else None


def _physical_unit_follows(text: str, end: int, extra: frozenset[str] = frozenset()) -> bool:
    return _physical_unit_after(text, end, extra) is not None


def _written_unit(text: str, end: int) -> str:
    """The unit token after a number as the writer typed it, for quoting it back ("MJ", "kgCO2e")."""
    m = _UNIT_TOKEN.match(text[end:])
    return m.group(1).rstrip(".,;:!?") if m else ""


#: What marks a unit as a characterised LCIA unit when it is written INTO the unit token: "kgCO2e",
#: "kg-CO2-Eq", "kgSO2eq". Read only on the token's own rest — never on the words after it.
_CHARACTERISED = re.compile(r"(?i)eq\b|eq\.|co2|co₂|\d")

#: …and when it follows as its own token: "kg CO2-Eq", "mol H+-Eq", "kBq U235-Eq", "kg SO2 eq",
#: "kg P eq", "m3 world eq. deprived". A reference substance with its "eq", or CO2 alone ("kg CO2").
#: Deliberately narrow: "2 kg and 3 bottles" and "2 kg in 2026" are a mass, and the digit in a later
#: word is no part of the unit.
_SUBSTANCE_EQ = re.compile(
    r"(?i)(?:co2|co₂)(?:[-‑ ]?e(?:q)?\b\.?)?(?![\w])"
    r"|[\w+,₀-₉-]{1,12}?[-‑]eq\b\.?"
    r"|[\w+₀-₉]{1,8}\s+eq\b\.?"
    r"|eq\b\.?"
)


def _unit_signature(text: str, end: int, extra: frozenset[str] = frozenset()) -> tuple[str, bool] | None:
    """The unit after a number and whether it is characterised — ("kg", True) for "1 kg CO2-Eq",
    ("kg", False) for "1 kg of juice". What a quotation must match: the scope's "1 kg" functional unit
    is not the "1 kg CO2-Eq" result.

    Characterised is read inside the unit expression only: the rest of the unit token itself, or the
    token directly after it when that is a reference substance (`_SUBSTANCE_EQ`). Reading "the next two
    words" made "2 kg in 2026" a characterised unit and let a parameter's value through unreported."""
    m = _UNIT_TOKEN.match(text[end:])
    if not m:
        return None
    token = m.group(1).rstrip(".,;:!?")
    if (unit := _unit_prefix(token, extra)) is None:
        return None
    if _CHARACTERISED.search(token[len(unit):]):
        return unit, True
    after = text[end + m.end(1) :]
    # Any whitespace, a line break included ("kg\nCO2-Eq" from a wrapped line, "kg   CO2-Eq"). The
    # token is normalised before it is judged: sentence punctuation off ("kg CO2."), and a per-unit
    # suffix after the substance cut ("CO2-Eq/m2", "CO2-Eq/FU"), so the substance itself decides.
    following = re.match(r"\s+(\S+(?:\s+eq\b\.?)?)", after, re.IGNORECASE)
    if not following:
        return unit, False
    candidate = following.group(1).split("/", 1)[0].rstrip(".,;:!?)")
    return unit, bool(candidate and _SUBSTANCE_EQ.fullmatch(candidate))


def _signature_key(signature: tuple[str, bool]) -> tuple[str, bool]:
    """A unit signature with its symbol normalised through the alias table — "kilometres" is "km"."""
    unit, characterised = signature
    return _UNIT_ALIASES.get(unit, unit), characterised


def _unit_follows(text: str, end: int, extra: frozenset[str] = frozenset()) -> bool:
    """Whether the token right after a number reads as a unit — "1350 MJ" is a figure, not a year.

    The year whitelist below let any 1000–2099 literal through, and four-digit results are routine in
    LCA (MJ, km, L for larger functional units). A token counts as a unit when it begins with a known
    unit (`_physical_unit_follows`), or when it is a short token with an uppercase letter or digit
    *after* its first character ("CO2-Eq") — not on its first, or every German noun and every
    sentence-initial word after a year would match. Designators are excluded: they come before their
    number ("ISO 14044"), and "seit 2006 ISO 14044 gilt …" must stay a year.
    """
    if _physical_unit_follows(text, end, extra):
        return True
    m = re.match(r"\s{1,2}([^\s.,;:)\]]{1,12})", text[end:])
    if not m:
        return False
    token = m.group(1)
    base = token.rstrip(".,;:!?").lower()
    return len(base) <= 6 and base not in _DESIGNATORS and bool(re.search(r"[A-Z0-9µ]", token[1:]))


def _number_key(number: str) -> str:
    """A number normalised for whitelist comparison: trailing punctuation off, decimal mark unified.

    Both sides of the quotation check go through this — the chapter's numbers used to be stripped while
    the whitelist entries were not, so a scope ending in "…of 300." blocked a chapter writing "300",
    and a German chapter quoting "1,5" never matched the metadata's "1.5"."""
    return number.rstrip(".,").replace(",", ".")


def _repair_for(
    text: str,
    number: str,
    end: int,
    named: tuple[str, str],
    data: dict[str, Any],
) -> dict[str, Any]:
    """The exact substitution for one literal, or nothing when it is not beyond argument.

    The number AND the unit beside it are replaced together, by the parameter's own two placeholders.
    That is deliberate, and it is the one place where the repaired sentence does not read exactly as
    it was written: the study's package volume is stored as ``0.25 l`` and the chapter wrote
    ``250 ml``, so the repaired sentence prints ``0.25 l``. The quantity is identical, the wording is
    the parameter's rather than the author's — and the alternative, measured, is losing 853 words that
    were right about everything else (V267). The advisory finding says what it now prints, so the
    trade is visible rather than silent.

    Everything else is refused:

    * an **ambiguous** value — `_parameter_number_keys` yields None where two parameters claim the same
      value and unit family, and a coin toss is not a repair;
    * a value whose own form is **scientific notation** (``4.2e-05 t``), which no report prints in prose;
    * a number with **no unit** after it, because then there is nothing to replace the unit with and
      nothing that made the match specific in the first place;
    * anything inside a **quotation**, which is verbatim by definition.
    """
    if _unit_family_after(text, end) is None:
        return {}
    match = re.match(r"\s{1,2}([^\s.,;:)\]]{1,12})", text[end:])
    if not match:
        return {}
    name, path = named
    try:
        param = (data.get("parameters") or [])[int(path.rsplit(".", 1)[1])]
        amount = f"{float(param['amount']):g}"
        unit = str(param.get("unit") or "")
    except (IndexError, KeyError, TypeError, ValueError):
        return {}
    if "e" in amount.lower() or not unit:
        return {}
    start = end - len(number)
    if _inside_quotes(text, start):
        return {}
    return {
        "repair": {
            "find": text[start : end + match.end()],
            "replace": f"{{{{{path}.amount}}}} {{{{{path}.unit}}}}",
            "parameter": name,
            "prints": f"{amount} {unit}",
        }
    }


def apply_repairs(text: str, findings: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Carry out the substitutions the check itself specified. Returns the new text and what was done.

    The gate used to be a judge and nothing else: it worked out that "250" was the current value of
    `gebinde_volumen_l`, wrote the placeholder that belongs there into its own message — and then threw
    the chapter away. Two of nine chapters of one run died that way, one of them the best
    goal-and-scope text any run had produced, over one number in a product name that the same chapter
    wrote correctly two sentences later (V267).

    Nothing here interprets. A repair is applied only where `_repair_for` has already established that
    the substitution prints the same characters it replaces, and only where the exact string still
    occurs **once** — a second occurrence means the surrounding sentences differ and the check has to
    look at each of them, which it will, because the caller re-checks the result.

    The caller must re-run `check_proposal` on the returned text. This function does not decide that a
    chapter is clean; it removes the objections that had a mechanical answer, and the check says
    whether that was enough.
    """
    applied: list[dict[str, Any]] = []
    out = text
    for finding in findings:
        repair = finding.get("repair") if isinstance(finding, dict) else None
        if not isinstance(repair, dict):
            continue
        find, replace = str(repair.get("find") or ""), str(repair.get("replace") or "")
        if not find or out.count(find) != 1:
            continue
        out = out.replace(find, replace, 1)
        applied.append({**repair, "kind": finding.get("kind")})
    return out, applied


def _literal_number_findings(
    without_placeholders: str, data: dict[str, Any], kind: str = ""
) -> list[dict[str, Any]]:
    """The `literal_number` findings of `check_proposal` — every figure typed out that should be a
    placeholder. Split out of the gate for size only; the rules are documented where they apply."""
    out: list[dict[str, Any]] = []
    # Numbers that appear in the *descriptions* we handed over are quotations, not inventions. A scope
    # saying "a 20 g bag delivered over 300 km" makes those figures part of the contract; so does an
    # ecoinvent dataset description saying a plant burns at 700–875 °C, which two different models quoted
    # and both had refused. Flagging them teaches the writer to hide the very facts that explain a result.
    #
    # Result figures are deliberately NOT in here, and neither are lookup results: those have placeholders
    # (or, for a lookup, no way to stay correct), so they must not be typed out.
    quotable = _quotable_text(data)
    # A chapter shown the research findings may quote their figures: a published figure about something
    # outside this model, sourced, and not one a recalculation moves — the reason a lookup's figure is
    # refused does not apply to it. The same set of chapters that is shown them (`_SPECIALIST_FACTS`).
    researched = report_sources.research_text(data) if kind in _SPECIALIST_FACTS["web_research"] else ""
    method_units = _method_units(data)
    # The exchange notes likewise, where they are shown ("the supplier ships 1200 km by lorry") — but never a
    # figure in an indicator's unit: a producer's "0.42 kg CO2-Eq per bottle" would vouch for the same figure
    # typed as this model's result, and no recalculation would move it.
    noted = " ".join(n["note"] for n in exchange_notes(data)) if kind in _SPECIALIST_FACTS["exchange_notes"] else ""
    indicator_units = {_UNIT_ALIASES.get(u, u) for u in method_units}
    noted_figures = [
        (n, unit) for n, end in _numbers_in(noted)
        if not ((unit := _unit_signature(noted, end, method_units))
                and (unit[1] or _signature_key(unit)[0] in indicator_units))
    ]
    quoted_numbers = {_number_key(n) for text in (quotable, researched) for n, _end in _numbers_in(text)}
    quoted_numbers |= {_number_key(n) for n, _unit in noted_figures}
    # …with one exception to the exception: a figure that is a **parameter's current value** is not a
    # quotation, however often a description spells it out. Parameters are by definition the quantities
    # that move, so a number that says one out loud is precisely the number that will be wrong — and it
    # arrives through this door, because the process notes name the parameter *and* its value. An
    # apple-juice report printed "the EUR pallet — 42 g of softwood allocated to each bottle"
    # in prose; the pallet share is 4 g now, the sentence still says 42, and every check was green
    # (V164's write-time half). The annex prints the parameter table, so there is always somewhere to
    # point instead.
    parameter_numbers = _parameter_number_keys(data)
    # Figure AND unit, for every quotation that carries one. A quotable "1500 km" used to vouch for
    # "1500 kg CO2-Eq" as soon as the figure had four digits — the number was matched, the unit never.
    # Units are compared by symbol through the alias table, so a scope's
    # "1500 kilometres" still covers a chapter's "1500 km".
    def with_units(text: str) -> set[tuple[Any, Any]]:
        return {
            (_number_key(n), _signature_key(unit))
            for n, n_end in _numbers_in(text)
            if (unit := _unit_signature(text, n_end, method_units)) is not None
        }

    research_units = with_units(researched)
    quoted_units = with_units(quotable) | research_units
    quoted_units |= {(_number_key(n), _signature_key(unit)) for n, unit in noted_figures if unit}
    for number, end in _numbers_in(without_placeholders):
        bare = number.rstrip(".,")
        # The year shape only counts when nothing unit-like follows: "amounts to 1350 MJ" used to pass
        # as "the year 1350" and freeze a result figure in the text. Small numbers (0–19) are counts
        # ("the 3 phases", "two of the 4 scenarios") — but only while no physical unit follows: "12 kg
        # CO2-Eq" passed as a count, unbound and never checked for staleness. An input
        # quantity from the scope ("the 2 kg bottle") is still let through below, as a quotation.
        small_unit: tuple[str, bool] | None = None
        if _ALLOWED_LITERALS.match(bare):
            if len(bare) < 4:
                small_unit = _unit_signature(without_placeholders, end, method_units)
                if small_unit is None:
                    continue
                # A small figure with a unit is a quotation only with the SAME unit: every scope names
                # its "1 kg" functional unit or "12 bottles", and matching the number alone would let
                # "1 kg CO2-Eq" or "12 kg" through on the strength of them. "The 2 kg bottle" from the
                # goal stays quotable — unless it is a parameter's current value, like any figure.
            elif not _unit_follows(without_placeholders, end, method_units):
                continue
        named = parameter_numbers.get((_number_key(number), _unit_family_after(without_placeholders, end)))
        if named and not _same_quantity(without_placeholders, end, method_units, named, data):
            # The leading symbol matched and nothing else did: "2 kg CO2-Eq" is a result, not the 2 kg
            # fill mass. Bound to the parameter, it would print "3 kg CO2-Eq" after a recompute with no
            # finding at all. It stays a plain refusal until a result reference is written.
            named = None
        written_unit = (
            small_unit if small_unit is not None else _unit_signature(without_placeholders, end, method_units)
        )
        quoted = (
            (_number_key(number), _signature_key(written_unit)) in quoted_units
            if written_unit is not None
            else _number_key(number) in quoted_numbers
        )
        if quoted and not named:
            continue
        # A researched figure that is ALSO a parameter's current value: the sentence may be about this
        # model or about a source, and only its words can say which. So no repair — a placeholder put
        # into a quotation would print the model's next value under the source's name — and a refusal
        # that names both readings.
        cited = (
            named is not None
            and written_unit is not None
            and (_number_key(number), _signature_key(written_unit)) in research_units
        )
        out.append(
            {
                "kind": "literal_number",
                "names": [bare],
                # How to repair it, when the repair is beyond argument. Present only where every one
                # of the conditions in `_repair_for` holds; absent means "a person or a model has to
                # decide this one". See `apply_repairs` for what is done with it (V267).
                **(_repair_for(without_placeholders, number, end, named, data) if named and not cited else {}),
                "detail": (
                    f"The number {number} is the current value of parameter '{named[0]}' and also a figure "
                    "in a research finding. If the sentence is about this model, write "
                    f"{{{{{named[1]}.amount}}}} {{{{{named[1]}.unit}}}}. If it reports what a source found, "
                    "leave the figure out: while it equals a parameter it cannot be told apart from the "
                    "model's own quantity, and a placeholder would print the model's value under the "
                    "source's name."
                    if named and cited
                    else f"The number {number} is the current value of parameter '{named[0]}'. Write it as "
                    f"{{{{{named[1]}.amount}}}} (the unit is {{{{{named[1]}.unit}}}}), or leave it to "
                    "the parameter table in the annex — spelled out here it stays behind the moment "
                    "the parameter is changed. The placeholder is pinned to the parameter by name, so "
                    "it keeps pointing at this one when another parameter is added."
                    if named
                    # Tested on a model before shipping (CLAUDE.md), with the counter-case: a fill mass
                    # read from an exchange, stated nowhere quotable. The plain message sent the model
                    # to put {{results.0.score}} in its place; a first rewrite made it invent
                    # {{study.fill_mass}}. Hence the last two clauses.
                    else f"The figure {bare} {_written_unit(without_placeholders, end)} is written out. "
                    "If it is a result, write the placeholder from your brief that prints it — typed out, "
                    "it will be wrong the next time the model is recomputed. If it is an input quantity "
                    "(a mass, a distance, a pack size), it may stay only as the study metadata, a process "
                    "note or a parameter states it; where none of them does, leave the figure out of the "
                    "sentence. Never put a placeholder that means a different quantity in its place, and "
                    "never invent a placeholder name."
                    if small_unit
                    else f"The number {number} is written out. Reference it as a placeholder instead, "
                    "or it will be wrong the next time the model is recomputed."
                ),
            }
        )
    return out


def check_proposal(
    text: str,
    section: dict[str, Any],
    data: dict[str, Any],
    lang: str = "en",
    weak_percent: float = report_claims.DEFAULT_WEAK_DIFFERENCE_PERCENT,
    report: dict[str, Any] | None = None,
    bindings: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Judge a proposed chapter text. Returns findings; it never rewrites and never refuses silently.

    `ok` means: every placeholder resolves, every cross-reference points at something, no invented
    number, and every named entity appears in what we handed over. `findings` is what the author sees
    — each one a sentence about a specific problem, because "the text is wrong somewhere" is not
    actionable.

    `report` is needed for the cross-reference check alone: which labels the finished document will
    carry is a property of the whole report, not of one chapter.

    `bindings` are the pins this write would **store** — not the ones the stored chapter carries. They
    decide which member a ranked index means, and the whole gate has to read the document the way the
    renderer will: resolving without them printed the figures by position, so after a rank swap the
    gate judged "Packaging (60.1 %)" while the PDF printed "Packaging (18.9 %)" — the same sentence
    with every number under a different name (V168's neighbour, V165). Passing the *stored* pins
    instead would be wrong in the other direction: a rewrite exists precisely to talk about today's
    ranking, and yesterday's pin would report its own member as missing. Defaults to the section's for
    callers that have nothing better.
    """
    findings: list[dict[str, Any]] = []
    if bindings is None:
        bindings = section.get("bindings")

    # Nothing is not a chapter. `check_proposal("")` answered ok, and with store=True an empty answer
    # replaced a written chapter.
    if not (text or "").strip():
        findings.append(
            {
                "kind": "empty_chapter",
                "detail": (
                    "The proposal is empty: there is nothing to check and nothing that should replace "
                    "a chapter. Write the chapter, or leave the stored text as it is."
                ),
            }
        )
        return {"ok": False, "findings": findings, "resolved": ""}

    resolved, missing = rd.resolve(text, data, lang, bindings)
    # Advisory, not blocking (V434): the declaration beside its own label prints one
    # name in the document (the renderer folds the pair), but the habit is the writer's and the
    # author should see it — an earlier prompt rule ("in place of the name, never beside it") did
    # not end it, and a refusal would cost a revision round for a sentence that prints right.
    for path in report_tokens.declaration_beside_label(text):
        findings.append(
            {
                "kind": "declaration_beside_label",
                "path": path,
                "detail": (
                    f"“{{{{rank:{path}}}}}” stands beside “{{{{{path}.label}}}}” — the declaration prints "
                    "the member's name itself, so the document folds the pair to one name. Write the "
                    "declaration in place of the label, not beside it."
                ),
            }
        )
    for path in sorted(set(missing)):
        findings.append(
            {
                "kind": "unresolved_placeholder",
                # Where the offending thing stands in the text. Not for the author — for the
                # correction brief, which has to hand the model the sentence a refusal is about
                # (report_patch._spans_and_gaps). A finding nobody can point at is a dead end: the
                # staleness check sells a correction, this gate refuses it over a sentence the
                # assignment never mentioned, and no wording can bridge that (V184).
                "path": path,
                "detail": f"“{path}” does not exist in this report's data, so it would print as a gap.",
            }
        )

    # A cross-reference was only ever checked for its spelling. A well-formed name for a table that
    # nobody emits passed, and printed "[missing reference: …]" in the finished PDF — a hole in a
    # client's document, produced by the one part of the pipeline that is supposed to make holes
    # impossible. Which labels exist is arithmetic, so this is a check and not a request to a model.
    if report is not None:
        available = document_labels(report, data)
        # The brief names the label the chapter's OWN chart would carry. A writer that points at it without
        # asking for the chart was told "point at one of the references listed in the brief" — and the
        # brief had listed exactly this one, so the advice read as a contradiction and the next attempt
        # repeated the reference.
        own = figure_slot(section)[1]
        for token in sorted({t for t in rd.placeholders_in(text) if t.startswith("ref:")}):
            label = token[4:].strip()
            if label and label not in available:
                findings.append(
                    {
                        "kind": "unknown_reference",
                        "path": token,
                        "detail": (
                            f"“{label}” is the reference your own chart would carry, but this text asks "
                            "for no chart, so the reference would print as a gap. Append the FIGURE: line "
                            "that asks for the chart, or drop the reference."
                            if label == own
                            else f"“{label}” is not a table or figure this report contains, so the "
                            "reference would print as a gap. Point at one of the references listed in "
                            "the brief, or drop the reference."
                        ),
                    }
                )

    # A {{…}} that does not PARSE as a placeholder is invisible to the whole pipeline: the token
    # regex forbids nested parentheses, so a nested derivation such as {{sum(a, sum(b, c))}} is not
    # a placeholder to the gate, not a placeholder to the renderer — it sails through every check
    # and prints RAW in the client's PDF (measured: two of them in one chapter; `sum`
    # is variadic, so the nesting was never needed). Blocking, because the failure ships otherwise.
    matched_spans = [m.span() for m in rd.PLACEHOLDER.finditer(text or "")]
    pos = 0
    while True:
        start = (text or "").find("{{", pos)
        if start < 0:
            break
        pos = start + 2
        if any(a <= start < b for a, b in matched_spans):
            continue
        end = (text or "").find("}}", start)
        snippet = (text or "")[start : (end + 2 if end >= 0 else start + 60)]
        findings.append(
            {
                "kind": "malformed_placeholder",
                "detail": (
                    f"“{snippet[:80]}” is not a resolvable placeholder — it would print exactly like "
                    "this in the finished PDF. A derivation takes placeholder paths or plain numbers, "
                    "never another derivation: {{factor(sum(a, b), c)}} is refused just like "
                    "{{sum(a, sum(b, c))}}. Nested sums flatten, because `sum` takes any number of "
                    "arguments: {{sum(a, b, c, d)}}. A percent, factor, change or diff OF a sum has no "
                    "placeholder: print the sum as {{sum(…)}} and make the comparison in words without a "
                    "number, or compare single members. For a list's total, prefer the figure that "
                    "already exists (e.g. results.<i>.score)."
                ),
            }
        )

    # A prose placeholder wedged into a sentence. `{{study.goal}}` resolves to the author's whole
    # goal paragraph; written where a value belongs (“a share of more than {{study.goal}}”), the
    # rendered sentence contains the study goal twice, mid-sentence, with a stray full stop — the
    # exact first sentence of a watering-can summary (V295). Legal path, broken result:
    # said as a second opinion (advisory), because the standalone use is legitimate and common.
    for match in rd.PLACEHOLDER.finditer(text or ""):
        token = match.group(1).strip()
        if not token.startswith("study."):
            continue
        # `paragraph`, not `resolved`: the loop used to reuse the name of the whole chapter's resolved
        # text, and the API answered with the last study paragraph instead.
        paragraph = rd.lookup(token, data)
        if not isinstance(paragraph, str) or len(paragraph) <= 100:
            continue
        before = (text or "")[: match.start()].rstrip()
        # Mid-sentence = something wordy directly before it on the same sentence. A colon, a dash or
        # a sentence end before the token reads as deliberate quoting and stays unremarked.
        if before and before[-1] not in '.:!?—–"\'»“”':
            findings.append(
                {
                    "kind": "prose_placeholder_in_sentence",
                    "path": token,
                    "detail": (
                        f"{{{{{token}}}}} resolves to a whole paragraph ({len(paragraph)} characters), "
                        "and it sits in the middle of a sentence — rendered, the paragraph lands "
                        "inside your line. If you meant a figure or a phrase from that paragraph, "
                        "write it out as a quotation instead; keep the placeholder only where it "
                        "stands alone."
                    ),
                }
            )

    # Look for literals in the RAW text with the placeholders removed — searching the resolved text
    # would flag every correctly used placeholder, since resolving one produces exactly a number.
    without_placeholders = rd.PLACEHOLDER.sub(" ", text or "")
    findings += _literal_number_findings(without_placeholders, data, str(section.get("kind") or ""))
    # …and the unit written beside a correctly used placeholder: the figure is right, the placeholder
    # is right, and "{{results.0.score}} tonnes CO2-Eq" over a kg value is wrong in every result
    # sentence it could occur in.
    findings += _unit_mismatch_findings(text or "", data, bindings)
    if len(text or "") > CHAPTER_LONG_CHARS:
        findings.append(
            {
                "kind": "chapter_long",
                "detail": (
                    f"The chapter runs to {len(text):,} characters, about twice what a report chapter "
                    "needs. Nothing is refused — read it for repetition before you release it."
                ),
            }
        )

    # Facts: every dataset, method or group the text names has to appear in what we handed over.
    # All five report languages' quotation marks — checking only "…"/“…” meant a German „…“ or a
    # French «…» quotation was never looked at, in two of the languages this product ships.
    known = _normalise_name(_known_text(data))
    # The length window is a FILTER on what came out, never part of the pairing. When it was part of
    # the pattern, a quoted span outside it made its pair fail — and the scanner then paired that
    # span's CLOSING mark with the next span's OPENING one, turning the prose between two dataset
    # names into a candidate. Measured: a chapter quoted "unsaturated hydrocarbons
    # production, steam cracking operation, average", a real ecoinvent name at 70 characters, and the
    # gate refused the whole chapter for the phantom "at   and the" — the words between it and the
    # next name, with a placeholder stripped out of the middle (V262). It also lost the real name it
    # was meant to check. Ecoinvent identifiers are routinely this long, so this was not an edge case.
    named: list[str] = [
        span
        for quoted in set(re.findall(_QUOTED, without_placeholders))
        if _CANDIDATE_LEN[0] <= len(span := _trim_candidate(next((part for part in quoted if part), ""))) <= _CANDIDATE_LEN[1]
    ]
    # …and the same names written in italics instead of quotation marks. The rule above has caught
    # invented datasets since the first reports, but only inside quotes; a writer that marks them
    # *like this* was never looked at. In an apple-juice run three dataset names that
    # appear nowhere in the brief reached the delivered PDF that way, two of them carrying an invented
    # share of an indicator whose hotspots were never computed (V161). Same rule, same vocabulary,
    # one more way of writing a name down — and only for spans shaped like an identifier, because
    # *use phase* is emphasis, not a dataset.
    named += [
        trimmed
        for span in _EMPHASISED.findall(without_placeholders)
        if _reads_as_dataset_name(trimmed := _trim_candidate(span))
    ]
    for candidate in sorted({name for name in named if name}):
        if _normalise_name(candidate) not in known:
            findings.append(
                {
                    "kind": "unsupported_fact",
                    "names": [candidate],
                    "detail": (
                        f"“{candidate}” does not appear in the study metadata or the results handed over. "
                        "Either it belongs in the metadata, or the sentence should go."
                    ),
                }
            )

    # The report talking about its own production. The invariant forbids it in words; this is the
    # instance that enforces it, and a wood-stain report is why a rule alone is not enough.
    # The `goal_scope` prompt describes this exact case over six lines — an instruction to an assistant
    # sitting in the goal field — and the chapter wove it in anyway, three times: "the deliverable is a
    # model, not a report", "carried out as a model-only study", "delivers a parameterised model rather
    # than a report". A report that says three times that it is not one (V253).
    #
    # Blocking, and deliberately narrow: each pattern names the *document* or the *machinery*, and none
    # of them has an innocent reading in a chapter about a product system. "The study" and "this
    # assessment" are fine and untouched — it is "this report", the tools and the assistant that are
    # not. The correction loop can remove such a clause without touching the finding it sits in.
    if selfref := _SELF_REFERENCE.findall(text or ""):
        seen = sorted({m.strip() for m in selfref})
        findings.append(
            {
                "kind": "self_reference",
                "names": seen,
                "detail": (
                    "The chapter describes how this document came about (" + ", ".join(f"“{n}”" for n in seen[:4])
                    + "). Write about the study, not about the work that produced it: a fact from research is "
                    "stated with its source, a weakness a check surfaced is stated as a weakness of the study, "
                    "and the software, its tools and any model are never named. A critical review under ISO "
                    "14044 §7.3.3 is the one exception, and only where the study records a named reviewer."
                ),
            }
        )

    # The register, counted rather than judged. A remark, never a refusal: what makes prose read like
    # a machine is a habit, and a habit is a frequency. The invariants carry the counter-examples; this
    # only says when one of them has taken over.
    words = len((text or "").split())
    antitheses = _ANTITHESIS.findall(text or "")
    # At least two: a density alone let ONE "rather than" in a 155-word executive summary fire a remark
    # that says in its own words that one is ordinary (V395).
    if words >= 120 and len(antitheses) >= 2 and len(antitheses) * 1000.0 / words > _ANTITHESIS_PER_1000:
        findings.append(
            {
                "kind": "antithesis_habit",
                "names": sorted({a.strip() for a in antitheses})[:4],
                "detail": (
                    f"The chapter builds {len(antitheses)} sentences on the same figure of speech "
                    "(\u201cnot X, but Y\u201d / \u201crather than\u201d) in "
                    f"{words} words. One is ordinary; this many is a voice rather than a choice, and it "
                    "is what makes a text read as written by a machine. Say the thing that is true and "
                    "leave out what it is not — worth a second read, not a correction."
                ),
            }
        )

    # Emojis. A hard ban by the author's instruction, and the one formatting rule with no exception: an
    # LCA report is a document that gets reviewed, cited and occasionally litigated over. Blocking rather
    # than advising, because there is nothing to weigh up — the correction loop simply removes them.
    emojis = sorted(set(_EMOJI.findall(text or "")))
    if emojis:
        findings.append(
            {
                "kind": "emoji",
                "names": emojis,
                "detail": (
                    "The chapter contains emojis (" + " ".join(emojis[:6]) + "). They do not belong in an "
                    "LCA report — remove them; no chapter needs one."
                ),
            }
        )

    # A unit printed twice. Some placeholders carry their own sign — anything named `…_text`, and every
    # `percent`/`change` derivation — so a writer that adds one produces "6.6 % %" in a client document.
    # DeepSeek did exactly that in the sample report's summary. Mechanical, unambiguous, and fixable by
    # the correction loop, so it blocks rather than advises: there is no reading in which it is right.
    for match in rd.PLACEHOLDER.finditer(text or ""):
        token = match.group(1)
        tail = (text or "")[match.end() : match.end() + 3]
        if rd.prints_own_unit(token) and re.match(r"\s*%", tail):
            findings.append(
                {
                    "kind": "duplicated_unit",
                    "path": token,
                    "detail": (
                        f"“{{{{{token}}}}}” already prints its own percent sign, so the “%” after it would "
                        "appear twice. Remove the sign and keep the placeholder."
                    ),
                }
            )

    # What the chapter *asserts*, not only what it quotes. Deterministic: the values are in the snapshot,
    # so a comparison is arithmetic — see report_claims for why that matters.
    findings += report_claims.check_claims(text, data, lang, bindings, weak_percent=weak_percent)

    # Two severities, first needed here. A contradicted comparison is wrong and must not be stored; a
    # causal sentence is unverifiable by nature and only worth a second read — blocking it would make the
    # checker something an author switches off.
    blocking = [f for f in findings if f.get("kind") not in ADVISORY_FINDINGS]
    return {"ok": not blocking, "findings": findings, "resolved": resolved}


#: Fields whose *text* may legitimately contain a number a chapter quotes: the study's own wording and the
#: descriptive parts of a dataset. Nothing computed.
_QUOTABLE_FIELDS = ("description", "classification", "product", "name", "location", "flow", "compartment")

#: Beyond this the gate remarks on the length (advisory). Roughly twice a long chapter of the early
#: practice reports; the writer used to cut silently at 6 000 and lose the last paragraph.
CHAPTER_LONG_CHARS = 12_000

#: Spellings of a unit that mean the same symbol, for the unit-beside-placeholder comparison only.
_UNIT_ALIASES: dict[str, str] = {
    "percent": "%", "prozent": "%", "pourcent": "%",
    "tonne": "t", "tonnes": "t", "tonnen": "t", "toneladas": "t", "tonnellate": "t",
    "kilogram": "kg", "kilograms": "kg", "kilogramm": "kg", "kilogramme": "kg", "kilogrammes": "kg",
    "kilogramos": "kg", "chilogrammi": "kg",
    "gram": "g", "grams": "g", "gramm": "g",
    "litre": "l", "litres": "l", "liter": "l", "liters": "l", "litros": "l",
    "megajoule": "mj", "megajoules": "mj",
    "kilometre": "km", "kilometres": "km", "kilometer": "km", "kilometers": "km",
    "points": "pt", "punkte": "pt", "pts": "pt",
    "m²": "m2", "m³": "m3", "km²": "km2",
}


def _unit_symbol(unit: str | None, extra: frozenset[str]) -> str | None:
    """The leading unit symbol of a stored unit string ("kg" for "kg CO2-eq", "%" for "%"), or None
    when the string carries no unit the gate knows — unknown stays silent, as everywhere here."""
    if not unit:
        return None
    head = unit.split("/")[0].strip()
    if not head:
        return None
    lead = _unit_prefix(head.split(" ", 1)[0], extra)
    return _UNIT_ALIASES.get(lead, lead) if lead else None


def _expected_unit(
    token: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None, extra: frozenset[str]
) -> tuple[str, float] | None:
    """(unit symbol, scale) a numeric placeholder prints in — scale 1 for a plain figure, the factor's
    constant for a converted one — or None where the gate cannot tell and must stay silent."""
    from prism_lca.engine import report_bindings as rb

    if token.endswith(")"):
        name, _, args_text = token[:-1].partition("(")
        args = [a.strip() for a in args_text.split(",") if a.strip()]
        paths = [a for a in args if not rb.is_number(a)]
        constants = [float(a.replace(",", ".")) for a in args if rb.is_number(a)]
        if not paths:
            return None
        symbol = _unit_symbol(rb.bound_unit_of(paths[0], data, bindings), extra)
        if symbol is None:
            return None
        if name.strip() == "factor":
            # factor(a, b) is a / b: a kg figure through factor(x, 0.001) reads in grams, through
            # factor(x, 1000) in tonnes. A constant in front (c / x) has no unit a sentence could write.
            if len(args) == 2 and rb.is_number(args[1]) and constants:
                return symbol, constants[0]
            if constants:
                return None
        if name.strip() == "diff" and symbol == "%":
            return None  # percentage points — the prose names them, and no symbol check applies
        return symbol, 1.0
    value = rb.bound_lookup(token, data, bindings)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    unit = rb.bound_unit_of(token, data, bindings)
    if unit == "share":
        return None
    symbol = _unit_symbol(unit, extra)
    return (symbol, 1.0) if symbol else None


def _units_agree(expected: tuple[str, float], written: str) -> bool:
    """Whether the unit written after the placeholder is the one its figure prints in."""
    symbol, scale = expected
    written = _UNIT_ALIASES.get(written, written)
    if scale == 1.0 and written == symbol:
        return True
    have, want = units_of.base(1.0, written), units_of.base(1.0, symbol)
    if have is None or want is None:
        # Neither convertible: only the same symbol agrees, and a scaled figure never does.
        return scale == 1.0 and written == symbol
    if have[0] != want[0]:
        return False
    # factor(x, c) prints x / c, so the written unit has to be c times the figure's own: a kg figure
    # over 0.001 is in grams (0.001 kg each).
    return abs(have[1] - want[1] * scale) <= max(have[1], want[1] * scale) * 1e-6


def _unit_mismatch_findings(
    text: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None
) -> list[dict[str, Any]]:
    """`unit_mismatch`: a numeric placeholder followed by a unit that is not the one it prints in.

    The literal-number rule guards figures typed out; this guards the figure the placeholder prints
    correctly and the unit the sentence puts beside it. Silent wherever the data does not say what
    unit a value carries, and wherever the placeholder prints its own (`…_text`, shares, percent).
    """
    out: list[dict[str, Any]] = []
    extra = _method_units(data)
    for m in rd.PLACEHOLDER.finditer(text):
        token = m.group(1).strip()
        if token.startswith(("ref:", "rank:", "study.")) or token.endswith("_text") or rd.prints_own_unit(token):
            continue
        expected = _expected_unit(token, data, bindings, extra)
        if expected is None:
            continue
        um = _UNIT_TOKEN.match(text[m.end() :])
        if not um:
            continue
        written_token = um.group(1).rstrip(".,;:!?")
        written = _unit_prefix(written_token, extra)
        if written is None or _units_agree(expected, written):
            continue
        symbol, scale = expected
        prints_in = symbol if scale == 1.0 else f"{symbol} scaled by 1/{scale:g}"
        out.append(
            {
                "kind": "unit_mismatch",
                "path": token,
                "detail": (
                    f"{{{{{token}}}}} prints a figure in {prints_in}, but the sentence writes "
                    f"“{written_token}” right after it. Write the unit the figure carries"
                    + (
                        "; for another unit convert the figure first — factor(x, 0.001) turns a kg "
                        "figure into grams, factor(x, 1000) into tonnes."
                        if scale == 1.0
                        else " after the conversion — a kg figure through factor(x, 0.001) is in grams."
                    )
                ),
            }
        )
    return out


def _unit_family_after(text: str, end: int) -> int | None:
    """Which unit family the token after a number belongs to, or None if it carries no unit we know."""
    m = re.match(r"\s{0,2}(%|[^\s.,;:)\]]{1,6})", text[end:])
    if not m:
        return None
    placed = units_of.base(1.0, m.group(1).rstrip(".,;:!?"))
    return placed[0] if placed else None


def _same_quantity(
    text: str, end: int, extra: frozenset[str], named: tuple[str, str], data: dict[str, Any]
) -> bool:
    """Whether the unit written after a number is the parameter's own kind of unit, in full.

    `_parameter_number_keys` matches by the leading symbol's family, which is right for "42 g" against
    a 0.042 kg parameter and wrong for "2 kg CO2-Eq" against a 2 kg one: a characterised unit is an
    impact, and no mass parameter is ever its value. Characterised on either side — never the same
    quantity; a parameter repair must be beyond argument (`_repair_for`), and this one is not.
    """
    signature = _unit_signature(text, end, extra)
    if signature is not None and signature[1]:
        return False
    try:
        unit = str((data.get("parameters") or [])[int(named[1].rsplit(".", 1)[1])].get("unit") or "")
    except (IndexError, ValueError, AttributeError):
        return False
    base = unit.split("/")[0].strip()
    lead = _unit_prefix(base.split(" ", 1)[0], extra) or ""
    return not _CHARACTERISED.search(base[len(lead):])


def _parameter_number_keys(data: dict[str, Any]) -> dict[tuple[str, int | None], tuple[str, str] | None]:
    """Every way a parameter's current value could be written, keyed by (number, unit family).

    The value is (name, path), because "write it as a placeholder" is only followable if the writer
    knows *which* placeholder. Counting the parameter list is how it went wrong in the first place
    (V182): the list is offered with one example index, the writer counts the entries in the brief,
    and a miscount is a figure printed under another parameter's name.

    A mass of 0.042 kg is "0.042 kg", "42 g" and "4.2e-05 t" — the writer picks whichever reads best,
    and the figure is the same quantity, and equally stale, either way.

    **The unit is what makes this a rule rather than a coincidence.** Keyed on the number alone, the
    first real chapter produced "GWP100" against a transport distance of 100 km, which is exactly the
    kind of finding that gets a checker switched off. A figure only counts as a parameter's value when
    the unit written beside it is of the parameter's own kind — which is also why small values are no
    longer left out: "a 2 kg bottle" matching a 2 kg fill-mass parameter is the parameter, not a
    coincidence, and a small figure with a unit is refused anyway, so naming the
    parameter only makes the refusal followable (and repairable). 0 and 1 are the exception, below.
    """
    out: dict[tuple[str, int | None], tuple[str, str]] = {}
    for index, param in enumerate(data.get("parameters") or []):
        if not isinstance(param, dict) or not isinstance(param.get("amount"), (int, float)):
            continue
        name = str(param.get("name") or "")
        symbol = str(param.get("unit") or "").split("/")[0].strip()
        placed = units_of.base(1.0, symbol) if symbol else (units_of.PERCENT_FAMILY, 1.0)
        if placed is None:
            continue  # a unit this cannot place is a comparison it must not make
        family = placed[0]
        for value in units_of.written_forms(float(param["amount"]), param.get("unit")):
            # 0 and 1 stay out: "1 kg" is how every functional unit is written, and binding it to
            # whichever parameter happens to hold 1 kg would rewrite the functional unit (see `repair`).
            if value in (0, 1):
                continue
            key = (_number_key(f"{value:g}"), family)
            # A key two parameters both claim is not a finding, it is a coin toss. `setdefault` kept
            # the first and named it in the message, so the writer was told to bind its sentence to
            # whichever parameter happened to be earlier in the list. Harmless while this only ever
            # produced advice; not harmless now that `repair` below rewrites the sentence (V267).
            if key in out and out[key] != (name, f"parameters.{index}"):
                out[key] = None
            else:
                out.setdefault(key, (name, f"parameters.{index}"))
    return out


#: Quotation marks in all five report languages, as pairs. A number inside a quoted source sentence
#: is somebody else's wording and is never rewritten — the whole point of quoting is that it is verbatim.
_QUOTE_PAIRS = (("\u201c", "\u201d"), ("\u201e", "\u201c"), ("\u00ab", "\u00bb"), ('"', '"'))


def _inside_quotes(text: str, start: int) -> bool:
    """Whether the position sits inside a quotation. Cheap and deliberately over-cautious: an odd
    number of openers before it counts as inside, so an unbalanced quote suppresses the repair rather
    than risking one inside somebody else's sentence."""
    before = text[:start]
    for opener, closer in _QUOTE_PAIRS:
        if opener == closer:
            if before.count(opener) % 2 == 1:
                return True
        elif before.count(opener) > before.count(closer):
            return True
    return False


def _quotable_text(data: dict[str, Any]) -> str:
    """Descriptions we handed over, where a number is a quotation rather than a claim."""
    parts: list[str] = [str(v) for v in (data.get("study") or {}).values() if isinstance(v, str)]
    for entry in data.get("hotspots") or []:
        if isinstance(entry, dict):
            parts += [str(entry[f]) for f in _QUOTABLE_FIELDS if isinstance(entry.get(f), str)]
    for flow in ((data.get("inventory") or {}).get("flows")) or []:
        if isinstance(flow, dict):
            parts += [str(flow[f]) for f in ("flow", "compartment") if isinstance(flow.get(f), str)]
    # The inventory prompt directs the writer to "the process notes and the parameter comments" — a
    # 450 km transport distance recorded in a note is a quotation, and refusing it taught the writer
    # to hide exactly the provenance the chapter exists to state. Third instance of this class (scope
    # numbers and hotspot descriptions came first); the key lists lag the data model, so keep them
    # adjacent to build_data when a field is added there.
    for process in data.get("foreground") or []:
        if isinstance(process, dict):
            parts += [str(process[f]) for f in ("name", "product", "description") if isinstance(process.get(f), str)]
    for param in data.get("parameters") or []:
        if isinstance(param, dict):
            parts += [
                str(param[f]) for f in ("name", "description", "comment") if isinstance(param.get(f), str)
            ]
    activity = data.get("activity") or {}
    parts += [str(activity.get(k)) for k in ("name", "database") if isinstance(activity.get(k), str)]
    return " ".join(parts)


#: A quoted span, in the marks all five report languages use. No length bound: see the note at the
#: call site — a bound inside the pattern shifts every pair after a span that misses it.
_QUOTED = re.compile(r"“([^”]*)”|\"([^\"]*)\"|„([^“”]*)[“”]|«\s?([^»]*?)\s?»")

#: How long a quoted span may be and still be judged as a name. The lower end keeps ordinary
#: quotation ("no", "yes") out; the upper end is generous because ecoinvent identifiers are long —
#: "unsaturated hydrocarbons production, steam cracking operation, average" is 70 characters and cost
#: a chapter when the limit was 60. Anything longer is left unjudged rather than mispaired.
_CANDIDATE_LEN = (3, 120)

#: A span the writer set in italics or bold. Long enough to be a name, short enough to still be one.
_EMPHASISED = re.compile(r"(?<![*\w])\*{1,2}([^*\n]{8,80}?)\*{1,2}(?![*\w])")

#: What a candidate may be wrapped in and still be the same name. A writer that puts the sentence's
#: comma inside the quotation ("… eiche 5 L,") or sets a name in bold AND quotes (**"name"**) has
#: invented nothing — but both used to reach the comparison verbatim, quote marks and all, so they
#: could never match and the chapter was refused for naming its OWN processes correctly. Measured:
#: five of six blocks on one LCI chapter were the study's own foreground processes, the
#: doubled ““…”” in the message being the tell (V314).
_CANDIDATE_EDGE = " \t“”\"„«»'‘’.,;:!?"


def _trim_candidate(span: str) -> str:
    """A quoted or emphasised span reduced to the name inside it."""
    return span.strip(_CANDIDATE_EDGE)

#: How an ecoinvent identifier announces itself: it opens with a market or treatment phrase, or it
#: carries the comma that separates a process from its qualifiers ("sawing, softwood"). Anything else
#: in italics is emphasis and is left alone — a check that fires on ordinary wording gets switched off.
_DATASET_OPENERS = ("market for ", "market group for ", "treatment of ", "production of ")


def _reads_as_dataset_name(span: str) -> bool:
    """Whether an emphasised span is shaped like a dataset identifier rather than like emphasis."""
    low = span.lower()
    return low.startswith(_DATASET_OPENERS) or "," in span or " production" in low


def _normalise_name(text: str) -> str:
    """Lower-cased, with dashes and whitespace levelled.

    A writer that types an en dash where the dataset has a hyphen — "lorry, 16–32 metric ton" for
    "16-32" — has not invented anything, and reporting it would teach the writer to stop naming its
    sources. The same levelling is applied to both sides, so the comparison stays substring
    containment over the whole brief.
    """
    return re.sub(r"\s+", " ", text.replace("–", "-").replace("—", "-").replace("−", "-")).lower()


def _known_text(data: dict[str, Any]) -> str:
    """One lower-cased haystack of everything the chapter was handed.

    Substring containment, not equality. The check exists to catch an *invented* dataset or method name,
    and a writer quoting "municipal incineration" — a phrase that appears both in the system boundaries
    and in the ecoinvent dataset name — was being told it had made the term up, because the old version
    compared the quotation against whole field values. A phrase present anywhere in the brief is
    supported; an invented one still appears nowhere.
    """
    parts: list[str] = []

    def add(value: Any) -> None:
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, (int, float)):
            parts.append(str(value))
        elif isinstance(value, dict):
            for v in value.values():
                add(v)
        elif isinstance(value, (list, tuple)):
            for v in value:
                add(v)

    # Every part of the brief, "hotspots" included — a term the dataset description introduced is a term
    # we handed over. Leaving it out made the gate reject the very explanations the details enable.
    # `foreground`, `background_datasets` and `checks` joined later, for the same reason: the inventory
    # prompt tells the writer to work from the process notes, and quoting a phrase from one was refused
    # as an unsupported fact.
    for key in ("study", "activity", "results", "subjects", "contribution", "parameters", "scenarios",
                "inventory", "hotspots", "looked_up", "provenance", "foreground", "background_datasets",
                "checks", "web_research", "review", "trade_offs", "contributions"):
        add(data.get(key))
    return " \u0001 ".join(parts).lower()


__all__ = [
    "DEFAULT_PROMPTS",
    "LANGUAGES",
    "build_brief",
    "check_proposal",
    "effective_prompt",
    "placeholder_paths",
]
