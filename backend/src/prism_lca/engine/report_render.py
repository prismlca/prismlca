"""Render a **stored** report: walk its sections in order and turn each into blocks.

This is where the pieces meet. The section list decides *what* appears and in *which order* — so
drag & drop is nothing more than a reordered list here. Each `kind` maps to a builder:

* deterministic kinds are built from the live data (goal & scope, LCIA, contribution, annex,
  references, reproducibility) — no model involved, so they cannot invent anything;
* ``prose`` sections carry stored text, whose placeholders are resolved against the same data
  snapshot the tables were built from. Numbers in prose and numbers in tables therefore cannot
  disagree.

An unknown kind is skipped with a visible note rather than aborting the render: a report is more
useful with one section missing and saying so than not at all.
"""
from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, tzinfo
from typing import Any

from prism_lca import _log
from prism_lca.engine import report_checks, report_prompts, report_sources
from prism_lca.engine import report_data as rd
from prism_lca.engine import report_model as rm
from prism_lca.engine import report_translations as rtr
from prism_lca.engine import report_typst as rt
from prism_lca.engine.report_i18n import fmt_column, fmt_number, kind_title, normalise, t
from prism_lca.engine.report_kinds import PROSE_KINDS

#: A break opportunity the typesetter may use and the reader never sees.
_ZWSP = "\u200b"

#: The two standards a report conforms to, cited with their amendments.
#:
#: The bare year is the citation a reviewer sends back: both standards have been amended since 2006,
#: and a bibliography that stops at ":2006" claims conformity with a text that is no longer the whole
#: of it. One line each rather than five rows \u2014 the amendments belong to their standard, and this
#: bibliography had just been cut down from eleven rows of the same URL for the opposite reason.
#:
#: ISO designations, not the EN adoptions (EN ISO 14044:2006+A1:2018+A2:2020): the report says ISO
#: throughout, and mixing the two numbering schemes in one line is how a citation stops being checkable.
ISO_STANDARDS = (
    "ISO 14040:2006 + Amd 1:2020",
    "ISO 14044:2006 + Amd 1:2017 + Amd 2:2020",
)


def _breakable(name: str) -> str:
    """A parameter name — or a formula made of them — the table is allowed to wrap.

    `bottles_per_pallet` is one word to a typesetter: there is nowhere to break it, so the column has to
    be wide enough for the longest name in the study and the comment beside it loses that width. Marking
    the underscores as break opportunities gives the line breaker somewhere to go. Zero-width, so the
    name still reads — and copies — as itself.

    Formulas were left out of this at first, on the grounds that one broken across two lines is a
    different string rather than a wrapped one. That reasoning applies to names just as much, and the
    price of leaving formulas alone turned out to be worse than the principle: the value column is
    right-aligned, so `shampoo_bottle_volume_ml * shampoo_density_kgl / 1000` did not merely stick out,
    it ran back over the parameter name beside it and printed the two on top of each other.
    """
    return name.replace("_", "_" + _ZWSP)


def _parameter_blocks(data: dict[str, Any], lang: str) -> list[dict]:
    """The named parameters with their values and the note recorded against each.

    Its own function because two chapters may legitimately want it: the annex, where it is a reference
    table, and the inventory, where the same rows are the study's data sources — several of these notes
    end in a URL, and a couple say "own estimate, no primary source", which is the honest half of a data
    quality statement. Which chapter carries it is the author's choice, so neither hard-codes it.
    """
    params = data.get("parameters") or []
    if not params:
        return []
    rows = [
        [
            _breakable(str(p.get("name", ""))),
            _breakable(str(p.get("formula") or "")) or fmt_number(float(p.get("amount", 0.0) or 0.0), lang),
            str(p.get("unit") or ""),
            # `description` is what the parameter store calls it (params.list_params); reading
            # `comment` left this column blank in every report ever rendered. Both are accepted, so
            # a caller that hands over the field under either name is served.
            str(p.get("description") or p.get("comment") or ""),
        ]
        for p in params
    ]
    return [
        rm.heading(t("appendix.parameters", lang), 2),
        rm.table(
            [t("table.parameter", lang), t("table.value", lang), t("table.unit", lang), t("table.comment", lang)],
            rows,
            # The value column is numbers and short formulas: right-aligned, and treated as narrow
            # so the comment beside it gets the width the sentences in it need.
            align_right=[1],
            caption=t("caption.parameters", lang),
            label="t-parameters",
        ),
    ]


def _appendix_blocks(data: dict[str, Any], lang: str, title: str) -> list[dict]:
    blocks: list[dict] = [rm.heading(title, 1)]
    blocks += _parameter_blocks(data, lang)
    scenarios = data.get("scenarios") or []
    if scenarios:
        # What the scenario *does*, not how many things it does. The column used to print
        # `len(overrides)`, so a comparative report's annex said "Longer DC distance … 1" — a count of
        # changes, about a table whose entire subject is which change was made. In a comparison the
        # scenarios are the comparison, and a reader cannot check a variant they cannot see.
        # An override is a setting someone typed, not a measurement: `dc_distance_km = 15000` must not
        # come back as "1.50e+04". Integral values print as grouped integers; everything else keeps the
        # score formatting.
        def _fmt_override(value: object) -> str:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return str(value)
            if float(value).is_integer():
                return fmt_number(value, lang, digits=0)
            return fmt_number(value, lang)

        rows = [
            [
                str(s.get("name", "")),
                str(s.get("description") or ""),
                ", ".join(
                    f"{name} = {_fmt_override(value)}"
                    for name, value in sorted((s.get("overrides") or {}).items())
                ),
            ]
            for s in scenarios
        ]
        blocks += [
            rm.heading(t("appendix.scenarios", lang), 2),
            rm.table(
                [t("table.scenario", lang), t("table.description", lang), t("table.overrides", lang)],
                rows,
                caption=t("caption.scenarios", lang),
                label="t-scenarios",
            ),
        ]
    blocks += _inventory_blocks(data, lang)
    if len(blocks) == 1:
        blocks.append(rm.note(t("empty.data", lang)))
    return blocks


def _percent(value: float, lang: str) -> str:
    """A share, at a readable precision: one decimal above 1 %, three below."""
    return f"{fmt_number(value, lang, digits=1 if abs(value) >= 1 else 3)} %"


def _figure_caption(spec: dict[str, Any], data: dict[str, Any], lang: str) -> str:
    """What a chapter's own figure shows, when its author did not say.

    The fallback used to be the words "Figure for this chapter", printed under a real chart in a real
    report — a caption that names the container instead of the content, which is the one thing a
    caption may not do. The spec already says what was drawn, and the report already has wording for
    each of these figures elsewhere; this reuses it rather than inventing a second vocabulary.
    """
    kind = str(spec.get("kind") or "")
    if kind == "heatmap":
        return t("caption.figure_heatmap", lang)
    if kind == "radar":
        return t("caption.figure_radar", lang)
    source = str(spec.get("source") or "")
    if source == "contribution.groups":
        # `tag:` is the internal aggregation prefix, not a word for a caption — every other consumer
        # strips it (the standalone contribution heading, the matrix heading).
        contrib = data.get("contribution") or {}
        dimension = str(
            contrib.get("dimension_label") or str(contrib.get("dimension") or "").removeprefix("tag:")
        )
        key = "caption.figure_contribution_stacked" if spec.get("stacked") else "caption.figure_contribution"
        return t(key, lang, dimension=dimension)
    if source == "inventory.flows":
        return t("caption.inventory", lang)
    if source in ("subjects", "hotspots"):
        # Both are read against the leading indicator, which is what the report's first result is.
        indicator = str(((data.get("results") or [{}])[0]).get("method_label") or "")
        return t("caption.figure_summary", lang, indicator=indicator)
    return t("caption.figure_section", lang)


def _inventory_blocks(data: dict[str, Any], lang: str) -> list[dict]:
    """The elementary flows carrying the leading indicator.

    Deliberately the *characterised* flows rather than the raw inventory: an ISO annex is read to find
    out where a result comes from, and a few thousand uncharacterised rows answer that question worse
    than the twenty-five that actually move the number. The caption says which indicator it is for, so
    the table cannot be mistaken for a complete inventory.
    """
    inventory = data.get("inventory") or {}
    flows = inventory.get("flows") or []
    if not flows:
        return []
    indicator = " / ".join(inventory.get("method") or []) or ""
    impacts = fmt_column([float(f.get("impact") or 0.0) for f in flows], lang)
    rows = [
        [
            str(f.get("flow") or ""),
            " / ".join(str(c) for c in (f.get("categories") or [])),
            str(f.get("unit") or ""),
            impact,
            # Two significant digits' worth: "55.2 %" and "0.094 %" both read at a glance, where
            # "55.1641 %" wrapped onto a second line and said nothing extra.
            _percent(float(f.get("share") or 0.0) * 100.0, lang),
        ]
        for f, impact in zip(flows, impacts, strict=True)
    ]
    return [
        rm.heading(t("appendix.inventory", lang), 2),
        rm.prose(t("inventory.intro", lang).format(count=len(flows), indicator=rm.esc(indicator))),
        rm.table(
            [
                t("table.flow", lang),
                t("table.compartment", lang),
                t("table.unit", lang),
                t("table.impact", lang),
                t("table.share", lang),
            ],
            rows,
            caption=t("caption.inventory", lang),
            align_right=[3, 4],
            label="t-inventory",
            # For one indicator, the leading one: a refresh whose leading indicator is another one finds
            # a gap rather than that indicator's flows under this caption.
            key=f"inventory:{indicator}",
        ),
    ]


def _references_blocks(data: dict[str, Any], lang: str, title: str) -> list[dict]:
    """Sources the study demonstrably used: the background database, each impact method, the standards.

    Assembled from what the model actually references, so it cannot cite something unused. Where the
    renderer supplied it, an impact method carries the reference of the organisation that maintains it —
    naming "IPCC 2013 / climate change / GWP100" without saying where it is published is the citation a
    reviewer sends back.
    """
    prov = data.get("provenance") or {}
    rows: list[list[str]] = []
    seen: set[str] = set()

    def add(source: str, reference: str = "") -> None:
        if source and source not in seen:
            seen.add(source)
            rows.append([source, reference])

    references = {str(m.get("name") or ""): m for m in (data.get("method_references") or [])}
    background = str(prov.get("background") or "")
    add(background, str((references.get(background) or {}).get("url") or ""))
    # One line per method *family*, not per indicator. A bibliography exists to say where something is
    # published, and eleven CML indicators are published in one place: the first real report printed
    # eleven rows carrying the identical URL, under a heading whose whole job is to be checkable at a
    # glance. Which indicator came from which family is the methods chapter's table, once.
    for r in data.get("results") or []:
        label = r.get("method_label") or " / ".join(r.get("method") or [])
        if not label:
            continue
        # The renderer matched a family to its maintainer; the first path segment is that family.
        family = (r.get("method") or [label])[0] or label
        info = references.get(family) or next(
            (v for k, v in references.items() if k and (k in family or family in k)), None
        )
        add(family, str((info or {}).get("url") or ""))
    for standard in ISO_STANDARDS:
        add(standard)
    header = [t("table.source", lang), t("table.reference", lang)]
    blocks = [rm.heading(title, 1), rm.table(header, rows, label="t-references")]

    cited = report_sources.cited_sources(data)
    if cited:
        blocks.append(rm.heading(t("references.cited", lang), 2))
        blocks.append(
            rm.table(
                [t("table.reference", lang), t("references.cited_where", lang)],
                [[url, where] for url, where in cited],
                caption=t("caption.cited_sources", lang),
                label="t-sources",
            )
        )
    researched = report_sources.researched_sources(data, exclude={url for url, _ in cited})
    if researched:
        # The URL only. The question beside it was the one the BUILD asked, in the language the model
        # was thinking in — an English bibliography carried "Weißblech-Dose 0,25 l mit Deckel" three
        # times (V251) — and it is build protocol rather than study content: a bibliography lists what
        # was consulted, not what somebody typed into a search box. Dropping it is the same rule that
        # took the review's bookkeeping out of the limitations chapter (V253).
        blocks.append(rm.heading(t("references.researched", lang), 2))
        blocks.append(
            rm.table(
                [t("table.reference", lang)],
                [[url] for url, _ in researched],
                caption=t("caption.researched_sources", lang),
                label="t-web-research",
            )
        )
    return blocks


def _methods_blocks(data: dict[str, Any], lang: str, title: str) -> list[dict]:
    """Which indicators were computed, from which method family, and where that family is published.

    The reviewer's first question on any comparative study is why these methods. The table answers "which"
    from the results themselves — it cannot cite a method the report did not use — and the chapter's
    written comment answers "why". Split that way on purpose: the choice is a judgement, the list is not.
    """
    references = {str(m.get("name") or ""): m for m in (data.get("method_references") or [])}
    # Grouped by family, in the order the families first appear, and the family and its URL are printed
    # once per group rather than on every row. Three indicators of one family used to carry three
    # identical family names and three copies of the same link — a column of repetition that reads as
    # three sources when it is one, and pushes the indicator names into two lines each to make room.
    grouped: dict[str, list[list[str]]] = {}
    for r in data.get("results") or []:
        label = r.get("method_label") or " / ".join(r.get("method") or [])
        if not label:
            continue
        family = (r.get("method") or [label])[0]
        grouped.setdefault(family, []).append([label, r.get("unit") or ""])
    rows: list[list[str]] = []
    for family, entries in grouped.items():
        info = references.get(family) or next(
            (v for k, v in references.items() if k and (k in family or family in k)), None
        )
        url = str((info or {}).get("url") or "")
        for i, (label, unit) in enumerate(entries):
            rows.append([label, family if i == 0 else "", unit, url if i == 0 else ""])
    header = [
        t("table.indicator", lang),
        t("table.indicator_method", lang),
        t("table.unit", lang),
        t("table.reference", lang),
    ]
    blocks: list[dict] = [rm.heading(title, 1)]
    blocks.append(
        rm.table(header, rows, caption=t("caption.method_choice", lang), label="t-methods")
        if rows
        else rm.note(t("empty.results", lang))
    )
    return blocks


#: What the inventory chapter may show, and what it shows unless the author says otherwise.
#:
#: `processes` and `datasets` by default; the parameters and the elementary flows are off, because the
#: annex already carries both and a chapter that repeats an annex is the padding this module is meant
#: to avoid. Turning them on here (and deleting them from the annex) is the other legitimate shape —
#: which is exactly why it is a setting rather than a rule.
LCI_PARTS = ("processes", "datasets", "parameters", "flows")
LCI_DEFAULT_PARTS = ("processes", "datasets")

#: How the foreground processes are described, and by whom.
#:
#: `written` is the default and the reason this setting grew a fourth value: a process note is a
#: *working* note. It is written while modelling, in the modeller's shorthand, to be true rather than
#: to be read — and printing fifteen of them one after another gave a client document fifteen
#: paragraphs of telegram prose under fifteen headings. That is not an inventory chapter, it is the
#: model's documentation pasted into a report. Written, the notes stay what they
#: are — the raw material — and the chapter is prose about what was modelled.
#:
#: The other three keep the older behaviour for anyone who wants it: the notes verbatim, their opening
#: sentences, or the table alone.
LCI_DETAIL_MODES = ("written", "full", "short", "list")
LCI_DEFAULT_DETAIL = "written"


def _lci_blocks(
    data: dict[str, Any], section: dict[str, Any], lang: str, title: str, written: str = ""
) -> list[dict]:
    """The life cycle inventory: what was modelled, and where each piece of it came from.

    The chapter ISO 14044 §4.3/§5.2 asks for between the method and the results, and the one the first
    real report skipped entirely — it went from "these are the indicators" straight to "these are the
    scores", so a reader could not tell what had been modelled, let alone check it.

    Everything here already existed and was merely not printed. The foreground processes carry a note
    each (`model.report_context`), written by whoever built the model — human or assistant — and in a
    real study those notes are the inventory documentation: what the process represents, which dataset
    stands in for it, why that proxy is defensible, what it biases, and the source with its URL. Which
    parts appear is the chapter's own setting (`LCI_PARTS`), because a study that keeps its parameters
    here rather than in the annex is a legitimate report and not a broken one.
    """
    parts = [p for p in (section.get("inventory_parts") or LCI_DEFAULT_PARTS) if p in LCI_PARTS]
    detail = str(section.get("inventory_detail") or LCI_DEFAULT_DETAIL)
    # The reference process first, then the LIFE CYCLE, then the name. The database hands them over
    # alphabetically, which put "Apple juice, cloudy, at retail" — the product the whole study is about
    # — second, between an aluminium cap and an apple supply, with five "End-of-life …" processes in the
    # middle of the chain. Alphabetical is the database's order; the root of the product system is the
    # study's.
    #
    # `phase_order` is the second key since V249, and it exists because the first fix created the
    # second defect: once processes are named phase-first ("Packaging — tinplate can"), alphabetical
    # order reads Distribution, End-of-Life, Packaging, Production, Use — and the written chapter,
    # which is told to follow the table, opened its narrative with the disposal of the empty container.
    # The number comes from the tag group's own value order (`api/v1/report._context_in_phase_order`);
    # a model with no breakdown dimension has none, and the order is exactly what it always was.
    reference = str((data.get("activity") or {}).get("code") or "")
    foreground = sorted(
        data.get("foreground") or [],
        key=lambda a: (
            str(a.get("code") or "") != reference,
            int(a.get("phase_order") if a.get("phase_order") is not None else 10**6),
            str(a.get("name") or ""),
        ),
    )
    background = str((data.get("provenance") or {}).get("background") or "")
    blocks: list[dict] = [rm.heading(title, 1)]

    if "processes" in parts:
        if not foreground:
            blocks.append(rm.note(t("empty.lci", lang)))
        else:
            described = [a for a in foreground if str(a.get("description") or "").strip()]
            key = "lci.intro" if described and detail in ("full", "short") else "lci.intro_plain"
            # No count in the sentence: "15 foreground process(es)" is the plural hack showing through
            # in a document that goes to a client, and the table below counts itself.
            # `background` is a user-chosen database name and prose is rendered raw — unescaped, a name
            # containing `#let` fails the whole compile and `#`/`@` are swallowed silently.
            # A model drawing on no background says so instead of naming one.
            if background:
                blocks.append(rm.prose(t(key, lang, background=rm.esc(background))))
            else:
                blocks.append(rm.prose(t(key + "_own", lang)))
            blocks.append(
                rm.table(
                    [t("table.process", lang), t("table.product", lang), t("table.unit", lang),
                     t("table.location", lang)],
                    [
                        [str(a.get("name") or ""), str(a.get("product") or ""), str(a.get("unit") or ""),
                         str(a.get("location") or "")]
                        for a in foreground
                    ],
                    caption=t("caption.foreground", lang),
                    label="t-foreground",
                )
            )
            # The chapter's own prose, where the notes used to stand — before the background datasets
            # and the parameter table, not after them at the chapter's foot where a comment normally
            # goes. This paragraph *describes the processes in the table above it*; behind two further
            # tables it would be answering a question the reader stopped asking two pages ago.
            if detail == "written":
                blocks.append(rm.prose(written) if written.strip() else rm.note(t("empty.section", lang)))
            # The notes themselves, one process at a time. `list` leaves them out — the table above is
            # then the whole chapter, which is the right size for a model of three processes.
            elif detail != "list":
                for activity in foreground:
                    note = str(activity.get("description") or "").strip()
                    if detail == "short" and note:
                        note = _first_sentences(note)
                    blocks.append(rm.heading(str(activity.get("name") or ""), 2))
                    # `markup`, not raw: the note is whoever-built-the-model's own words. Raw, a
                    # cut-off remark like "(<1 g)" opened a Typst label that never closes and the
                    # whole document refused to compile ("unclosed label").
                    blocks.append(rm.prose(rm.markup(note) if note else t("lci.no_description", lang)))

    if "datasets" in parts:
        # Level 2, like the sibling parts below: as a level-1 heading this appeared in the TOC as a
        # chapter of its own, mid-chapter.
        blocks += _datasets_blocks(data, lang, t("datasets.title", lang), level=2)
    if "parameters" in parts:
        blocks += _parameter_blocks(data, lang)
    if "flows" in parts:
        blocks += _inventory_blocks(data, lang)
    return blocks


def _first_sentences(note: str, limit: int = 320) -> str:
    """The opening of a note, cut at a sentence end rather than mid-word.

    "How much" is a real question for this chapter: fifteen processes with a paragraph each is four
    pages, which is right for a study under review and too much for a screening report.
    """
    if len(note) <= limit:
        return note
    cut = note[:limit]
    stop = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    if stop > limit // 3:
        return cut[: stop + 1].strip()
    # No sentence ended late enough to cut there without throwing most of the note away. Then it ends
    # in an ellipsis — but at a word boundary: "…, and end-of…" is a typesetting accident, not a cut.
    space = cut.rfind(" ")
    return (cut[:space] if space > 0 else cut).rstrip(" ,;:") + "…"


def _datasets_blocks(data: dict[str, Any], lang: str, title: str, level: int = 1) -> list[dict]:
    """The background datasets the model uses **directly** — tier 1 only.

    Deliberately not the whole upstream tree (the author's instruction): a market dataset pulls in
    hundreds of datasets that the study never chose, and listing those would bury the handful of
    decisions somebody actually made. The intro sentence says so, so the omission is stated rather
    than left to be discovered.
    """
    entries = data.get("background_datasets") or []
    blocks: list[dict] = [rm.heading(title, level)]
    if not entries:
        blocks.append(rm.note(t("empty.datasets", lang)))
        return blocks
    # No count in the sentence, same rule as lci.intro: "12 background dataset(s)" is the plural
    # hack showing through in a client PDF (V125), and the table below counts itself.
    blocks.append(rm.prose(t("datasets.intro", lang)))
    rows = [
        [
            str(e.get("name") or ""),
            str(e.get("product") or ""),
            str(e.get("location") or ""),
            str(e.get("database") or ""),
        ]
        for e in entries
    ]
    blocks.append(
        rm.table(
            [
                t("table.dataset", lang),
                t("table.product", lang),
                t("table.location", lang),
                t("table.database", lang),
            ],
            rows,
            caption=t("caption.datasets", lang),
            label="t-datasets",
        )
    )
    return blocks


def _provenance_blocks(data: dict[str, Any], lang: str, title: str) -> list[dict]:
    """What it takes to reproduce these numbers — the requirement that every result points at
    the model state it came from."""
    prov = data.get("provenance") or {}
    pairs = [
        (t("field.model", lang), data.get("activity", {}).get("database", "")),
        (t("field.reference_process", lang), data.get("activity", {}).get("name", "")),
        (t("field.background", lang), prov.get("background", "")),
        (t("field.app_version", lang), prov.get("app_version", "")),
        (t("field.generated", lang), prov.get("generated", "")),
        (t("field.audit_position", lang), prov.get("audit_position", "")),
    ]
    return [rm.heading(title, 1), rm.kv([(k, str(v)) for k, v in pairs if str(v)])]


@dataclass
class _BuildCtx:
    """What every chapter builder may read (and the two lists all of them write).

    The old if/elif chain shared these as closure locals; the builders share them as one explicit
    bag so each can name, in its first line, exactly which parts of the render state it touches.
    `blocks` and `missing` are the SAME list objects `blocks_for` returns — builders append/extend,
    never rebind.
    """

    report: dict[str, Any]
    study: dict
    lcia_result: dict
    contribution: dict | None
    data: dict[str, Any]
    figures: dict[str, str]
    subjects: list[dict]
    values: dict[str, str] | None
    labels: dict[str, str] | None
    lang: str
    blocks: list[dict]
    missing: list[str]
    #: Set by the abbreviations builder: where the glossary placeholder sits, filled after the loop.
    abbreviation_slot: int | None = None
    #: Set by the abbreviations builder: where the glossary placeholder sits, filled after the loop.


def _build_goal_scope(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, study = ctx.lang, ctx.blocks, ctx.study
    # The written chapter replaces the field list rather than standing under it. The metadata
    # fields are working notes — the author may keep them in bullet points, and turning them
    # into prose is the writer's job — so printing them raw *and* their prose says everything
    # twice. It also put a modelling brief into a client's report: an apple-juice study whose
    # goal field ended "Use web research for orchard yields … and write the source URLs into
    # the description of the process they belong to" printed exactly that.
    #
    # Without prose the fields stay, so a report that nobody has written yet still says what it
    # is about instead of showing an empty chapter.
    if (section.get("text") or "").strip():
        # No field row above the prose — a lone "Critical review: not recorded" box over the
        # chapter text read as a stamp on the whole chapter. The fact is
        # not lost: the writer sees the study fields and states it in prose, the limitations
        # chapter says it deterministically, and for a public comparative assertion
        # `critical_review_note` still fires outside the section list.
        blocks.append(rm.heading(title or t("goal_scope.title", lang), 1))
    else:
        blocks += rt.goal_scope_blocks(study, lang, title or None)
    return False


def _build_inventory(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, missing, data, values = ctx.lang, ctx.blocks, ctx.missing, ctx.data, ctx.values
    # The one deterministic chapter whose written text is not a comment at its foot: in
    # `written` mode it *is* the description of the processes and belongs directly under their
    # table. So it is resolved here and handed in, and the comment appender below is told it
    # has already been spent.
    written = ""
    if (section.get("text") or "").strip():
        # Quotes straightened as on every other written path (V409, V427).
        written, gaps = rd.resolve(
            rm.normalise_quotes(section["text"]), data, lang, section.get("bindings"), values,
            scope=str(section.get("id") or "") or None,
        )
        missing += gaps
    blocks += _lci_blocks(data, section, lang, title or kind_title("inventory", lang), written=written)
    return str(section.get("inventory_detail") or LCI_DEFAULT_DETAIL) == "written"


def _build_methods(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data = ctx.lang, ctx.blocks, ctx.data
    blocks += _methods_blocks(data, lang, title or kind_title("methods", lang))
    return False


def _build_datasets(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data = ctx.lang, ctx.blocks, ctx.data
    blocks += _datasets_blocks(data, lang, title or kind_title("datasets", lang))
    return False


def _build_lcia(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data, figures, subjects, labels, report, study, lcia = ctx.lang, ctx.blocks, ctx.data, ctx.figures, ctx.subjects, ctx.labels, ctx.report, ctx.study, ctx.lcia_result
    # The short-name legend belongs in the document once. When the report carries a methods
    # chapter it already prints exactly that mapping — indicator, family, unit, source — and
    # repeating it under the results was one of three places the same table appeared.
    legend = not any(s.get("kind") == "methods" for s in report.get("sections") or [])
    # More than one subject makes it a comparison. Which way round the matrix is set is the
    # chapter's own choice; "auto" transposes as soon as there are more indicators than
    # variants (report_typst.lcia_matrix_blocks).
    blocks += (
        rt.lcia_matrix_blocks(
            subjects, study, lang, title or None,
            orientation=str(section.get("table_layout") or "auto"),
            legend=legend,
            labels=labels,
        )
        if len(subjects) > 1
        else rt.lcia_blocks(lcia, study, lang, title or None, legend=legend, labels=labels)
    )
    # A comparison that quietly lost a variant reads better than the study is: whoever deleted the
    # process or the scenario has to see it in the document, not only in the app.
    dropped = data.get("dropped_subjects") or []
    if dropped:
        blocks.append(rm.note(t("lcia.dropped_subjects", lang, names=", ".join(dropped))))
    # One figure per indicator, each comparing the subjects. Indicators do not share a unit, so
    # a single chart of all of them put incomparable quantities on one axis; per indicator the
    # axis means something and the comparison is the one a reader wants. With a single subject
    # there is nothing to compare and the renderer sends no chart at all.
    #
    # How many of them is the chapter's choice. Eleven indicators produced eleven charts of the
    # same 3×11 matrix, followed by a heatmap and a radar of it — three drawings of one thing,
    # where practice is an overview plus the table. "lead" keeps the report's first indicator,
    # which is the one its conclusions are usually about; "all" is the old behaviour and stays
    # the default, because a five-indicator study wants all five.
    charts = str(section.get("per_indicator_charts") or "all")
    for index, result in enumerate(data.get("results") or []):
        if charts == "none" or (charts == "lead" and index > 0):
            continue
        # Keyed by the indicator, labelled by its place: the label is what the prose cites and stays put,
        # the key is what the chart shows — after the method list changed, `lcia-1` was another indicator.
        key = rm.chart_key("lcia", str(result.get("method_label") or ""))
        if not figures.get(key):
            continue
        indicator = rt.short_method(result.get("method_label") or "", labels)
        blocks.append(
            rm.figure(
                rm.chart_path(key),
                caption=t("caption.figure_lcia_one", lang, indicator=indicator or "—"),
                label=f"f-lcia-{index}",
                key=key,
            )
        )
    # Comparison figures for the whole report, after the per-indicator ones. Only drawn when the
    # renderer supplied them, which it does when the option is on and the data supports it.
    for name, caption in (("heatmap", "caption.figure_heatmap"), ("radar", "caption.figure_radar")):
        if figures.get(name):
            blocks.append(
                rm.figure(rm.chart_path(name), caption=t(caption, lang), label=f"f-{name}", key=name)
            )
    return False


def _hotspot_rows(view: dict[str, Any], lang: str) -> list[list[str]]:
    hot = list(view.get("hotspots") or [])
    if not hot:
        return []
    impacts = fmt_column([float(h.get("direct") or 0.0) for h in hot], lang)
    return [
        [
            str(h.get("name") or ""),
            str(h.get("location") or ""),
            str(h.get("database") or ""),
            impact,
            str(h.get("share_text") or ""),
        ]
        for h, impact in zip(hot, impacts, strict=True)
    ]


def _build_contribution(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data, figures, labels, contribution = ctx.lang, ctx.blocks, ctx.data, ctx.figures, ctx.labels, ctx.contribution
    # One breakdown per indicator. A report that computes three and breaks down one can say
    # which phase drives its climate score and nothing about where its water or land use sits.
    # Which of them appear is the chapter's own choice (`hidden_indicators`, by method label):
    # a study whose other indicators say the same thing three times should be able to drop them,
    # and a label is a safer handle than a position, which moves when the method list is edited.
    #
    # Which DIMENSION is the chapter's own choice too: a second contribution chapter
    # may split by another tag family (`aggregate_by` on the section — the short report's breakdown
    # list). The report's own dimension keeps the bare keys and labels every stored chapter already
    # references; a further dimension gets `-d<k>` in both, so two chapters never draw or label the
    # same thing twice.
    dims = list(data.get("breakdown_dimensions") or [])
    own_dim = str(section.get("aggregate_by") or "")
    k = dims.index(own_dim) if own_dim and own_dim in dims else 0
    stem = "contribution" if k == 0 else f"contribution-d{k}"
    views = list(
        (data.get("contributions_by_dimension") or {}).get(dims[k]) or []
        if k
        else data.get("contributions") or []
    )
    if not views and not k and contribution and "aggregation" in contribution:
        # A snapshot without per-indicator views — a stored render from before they existed — still
        # gets the chapter it had, built from the raw breakdown it does carry, under the bare labels.
        views = [
            {
                **rd._contribution_view(contribution, lang),
                "index": 0,
                "method_label": "",
                "subjects": list(data.get("contribution_subjects") or []),
                "hotspots": list(data.get("hotspots") or []),
            }
        ]
    hidden = {str(x) for x in (section.get("hidden_indicators") or [])}
    shown = [
        (int(v.get("index", n)), v)
        for n, v in enumerate(views)
        if str(v.get("method_label") or "") not in hidden
    ]
    if shown:
        lead = shown[0][1]
        dimension = str(
            lead.get("dimension_label") or str(lead.get("dimension") or "").removeprefix("tag:")
        )
        blocks.append(rm.heading(title or f"{t('contribution.title', lang)}: {dimension}", 1))
        # Where the foreground-share note goes if one is needed — decided after the loop, because only
        # then is it known which indicators had a split to state and which of them were zero.
        note_at = len(blocks)
        zero_split = nonzero_split = 0
        for index, view in shown:
            label = rt.short_method(str(view.get("method_label") or ""), labels) or str(
                view.get("method_label") or ""
            )
            # The indicator's own sub-heading only where there is more than one to tell apart.
            # The indicator's name goes into the heading AND into the captions when there is more
            # than one indicator to tell apart: three figures called "Contribution by Life-cycle
            # phase, one bar per assessed variant" are indistinguishable in the list of figures, and
            # that list is where a reader looks for one of them (V311).
            named = label if len(shown) > 1 else None
            # The data keys name the dimension and the indicator, never their positions: after the method
            # list changed, `t-contribution-1` is a different indicator, and a refreshed `tables.json`
            # keyed by it would have put that one's numbers under this one's caption.
            # The chart below is keyed by the same identity, through the same function, so the table and
            # the chart of an indicator are both there after a refresh or both a gap.
            identity = rm.indicator_identity(dims[k] if dims else own_dim, str(view.get("method_label") or ""))
            built = rt.indicator_contribution_blocks(
                view, lang, index=index, heading=named, indicator=named, label_prefix=stem,
                data_key=f"contribution:{identity}",
            )
            if not built:
                continue
            blocks += built
            # The coarsest split, in one sentence: what the foreground processes emit themselves and
            # what the background system behind them carries. The tree computed it anyway. Once per
            # indicator, in the report's own dimension: the split does not depend on the dimension, and
            # a second chapter repeating it read as padding.
            #
            # Not for a zero share, though. A foreground that only links background datasets emits nothing
            # itself, and "0.0 % directly in the foreground processes and 100.0 % in the background system"
            # then stood under every one of 15 tables of a 16-indicator report (V426). Said once
            # at the top of the chapter instead; an indicator with a real foreground share keeps its sentence,
            # and so does a snapshot from before `direct_percent` existed (None is "unknown", not zero).
            if k == 0 and view.get("total") and view.get("direct_text") and view.get("direct_percent") == 0:
                zero_split += 1
            elif k == 0 and view.get("total") and view.get("direct_text"):
                nonzero_split += 1
                blocks.append(
                    rm.prose(
                        rm.esc(
                            t(
                                "contribution.direct_upstream",
                                lang,
                                total=fmt_number(float(view["total"]), lang),
                                unit=str(view.get("unit") or ""),
                                direct=str(view.get("direct_text") or ""),
                                upstream=str(view.get("upstream_text") or ""),
                            )
                        )
                    )
                )
            stacked_key = rm.chart_key("contribution-stacked", identity)
            grouped_key = rm.chart_key("contribution-grouped", identity)
            plain_key = rm.chart_key("contribution", identity)
            # Stacked stands in for the other two rather than joining them: the same numbers
            # drawn twice is noise, and the renderer only ever supplies one of the three. The shape is
            # part of the key because the caption names it.
            name, caption = (
                (stacked_key, "caption.figure_contribution_stacked")
                if figures.get(stacked_key)
                else (grouped_key, "caption.figure_contribution_grouped")
                if figures.get(grouped_key)
                else (plain_key, "caption.figure_contribution")
                if figures.get(plain_key)
                else (None, None)
            )
            if name:
                blocks.append(
                    rm.figure(
                        rm.chart_path(name),
                        caption=t(
                            f"{caption}_one" if named else caption,
                            lang,
                            dimension=dimension,
                            **({"indicator": named} if named else {}),
                        ),
                        label=rt._contribution_label("f", index, stem),
                        key=name,
                    )
                )
            # The datasets behind the split: which market or process inside a phase actually carries
            # the burden. The chapter's own switch (`hotspots`) — off, the chapter reads as before.
            hot_rows = _hotspot_rows(view, lang) if section.get("hotspots") else []
            if hot_rows:
                blocks.append(
                    rm.table(
                        [
                            t("table.dataset", lang),
                            t("table.location", lang),
                            t("table.database", lang),
                            f"{t('table.direct_impact', lang)} ({view.get('unit') or ''})",
                            t("table.share", lang),
                        ],
                        hot_rows,
                        caption=(
                            t("caption.hotspots_one", lang, indicator=named)
                            if named
                            else t("caption.hotspots", lang)
                        ),
                        align_right=[3, 4],
                        label=rt._contribution_label("t", index, f"{stem}-hotspots"),
                        key=f"hotspots:{identity}",
                    )
                )
        if zero_split:
            # "No elementary flows of their own" is only true when no indicator found any; next to one that
            # did, the note says the zero applies wherever no sentence under a table claims otherwise.
            key = "contribution.no_direct_rest" if nonzero_split else "contribution.no_direct_all"
            blocks.insert(note_at, rm.prose(rm.esc(t(key, lang))))
    return False


def _build_system_model(ctx: _BuildCtx, section: dict, title: str) -> bool:
    """The system model as a figure: foreground processes, their links, the first background tier.

    Drawn in the renderer from `data["system_model"]` (report_graph) and handed over as
    `figures["system-model"]`, like every other chart. The chapter says in one sentence what the
    picture contains and what it folded, so a reader knows the "+ n further datasets" nodes are a
    choice of the drawing, not a gap in the model.
    """
    lang, blocks, data, figures = ctx.lang, ctx.blocks, ctx.data, ctx.figures
    model = data.get("system_model") or {}
    svg = figures.get("system-model")
    if not svg and not model.get("nodes"):
        return False  # the generic empty note names the reason
    blocks.append(rm.heading(title or t("system_model.title", lang), 1))
    counts = model.get("counts") or {}
    if counts:
        blocks.append(
            rm.prose(
                rm.esc(
                    t(
                        "system_model.counts",
                        lang,
                        processes=fmt_number(float(counts.get("processes") or 0), lang),
                        datasets=fmt_number(float(counts.get("datasets") or 0), lang),
                    )
                )
            )
        )
        if counts.get("folded"):
            blocks.append(
                rm.prose(
                    rm.esc(
                        t(
                            "system_model.folded",
                            lang,
                            per_process=fmt_number(float(model.get("per_process") or 0), lang),
                            folded=fmt_number(float(counts.get("folded") or 0), lang),
                        )
                    )
                )
            )
    if svg:
        blocks.append(
            rm.figure(
                rm.chart_path("system-model"),
                caption=t("caption.figure_system_model", lang),
                label="f-system-model",
                key="system-model",
            )
        )
    else:
        blocks.append(rm.note(t("system_model.no_figure", lang)))
    return False


def _build_appendix(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data = ctx.lang, ctx.blocks, ctx.data
    blocks += _appendix_blocks(data, lang, title or kind_title("appendix", lang))
    return False


def _build_references(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data = ctx.lang, ctx.blocks, ctx.data
    blocks += _references_blocks(data, lang, title or kind_title("references", lang))
    return False


def _build_abbreviations(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks = ctx.lang, ctx.blocks
    # Placeholder now, filled after the loop: which acronyms the document actually uses can only
    # be known once the rest of it exists. Without that, a glossary kept explaining a term whose
    # only chapter had been deleted, and said nothing about one a newly written chapter brought in.
    # Unnumbered like the summary and the generated lists: the abbreviations are front
    # matter by convention (DIN/theses and ISO-style LCA reports alike), and the chapter
    # numbering starts with the first content chapter — goal & scope as "1".
    blocks.append(rm.heading(title or kind_title("abbreviations", lang), 1, numbered=False))
    ctx.abbreviation_slot = len(blocks)
    blocks.append(rm.note(t("empty.abbreviations", lang)))
    return False


def _build_interpretation_checks(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data = ctx.lang, ctx.blocks, ctx.data
    blocks += report_checks.interpretation_blocks(
        data, data.get("health"), lang, title or kind_title("interpretation_checks", lang)
    )
    return False


def _build_limitations(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data = ctx.lang, ctx.blocks, ctx.data
    blocks += report_checks.limitations_blocks(data, lang, title or kind_title("limitations", lang))
    return False


def _build_provenance(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, data = ctx.lang, ctx.blocks, ctx.data
    blocks += _provenance_blocks(data, lang, title or kind_title("provenance", lang))
    return False


def _build_prose_kind(ctx: _BuildCtx, section: dict, title: str) -> bool:
    lang, blocks, missing, data, figures, values, labels = ctx.lang, ctx.blocks, ctx.missing, ctx.data, ctx.figures, ctx.values, ctx.labels
    kind = str(section.get("kind") or "prose")
    # The chapter's own bindings: a ranked index resolves to the member it meant when written.
    # With `values` the figures become `#pval("…")` lookups instead of fixed text, so the
    # compiled document — and an exported project — reads them from a file.
    # Scoped by section: two chapters citing the same ranked token with different bindings
    # used to share one `values` key, and the last-rendered chapter's figure won both places.
    # Quotation marks straightened BEFORE the placeholders are resolved: a resolved value may carry a
    # `#pval("…")` call whose own straight quotes are code, not prose (V409).
    text, gaps = rd.resolve(
        rm.normalise_quotes(section.get("text") or ""), data, lang, section.get("bindings"), values,
        scope=str(section.get("id") or "") or None,
    )
    missing += gaps
    # The executive summary is unnumbered front matter: it opens the
    # document before the contents, and the numbered chapters start after it.
    blocks.append(rm.heading(title or kind_title(kind, lang), 1, numbered=(kind != "summary")))
    blocks.append(rm.prose(text) if text.strip() else rm.note(t("empty.section", lang)))
    # The one standard figure an executive summary may carry: every variant side by side for the
    # leading indicator, because that is the comparison the summary is about. Never with a single
    # variant — a one-bar chart is decoration.
    # Keyed by that indicator: a refresh whose lead is another one leaves a gap under this caption.
    lead_label = str((data.get("results") or [{}])[0].get("method_label") or "")
    summary_key = rm.chart_key("summary", lead_label)
    if kind == "summary" and figures.get(summary_key):
        indicator = rt.short_method(lead_label, labels)
        blocks.append(
            rm.figure(
                rm.chart_path(summary_key),
                caption=t("caption.figure_summary", lang, indicator=indicator or "—"),
                label="f-summary",
                key=summary_key,
            )
        )
    return False


#: kind -> block builder: the dispatch that replaced the thirteen-branch if/elif chain. One entry
#: per ChapterKind — completeness against the registry is pinned by tests/test_report_kinds.py, which
#: is the guarantee the chain used to give by inspection (and failed to give at all for a kind
#: someone forgot: that fell through to the unknown-kind note without anyone noticing in review).
_KIND_BUILDERS: dict[str, Callable[[_BuildCtx, dict, str], bool]] = {
    "goal_scope": _build_goal_scope,
    "system_model": _build_system_model,
    "inventory": _build_inventory,
    "methods": _build_methods,
    "datasets": _build_datasets,
    "lcia": _build_lcia,
    "contribution": _build_contribution,
    "appendix": _build_appendix,
    "references": _build_references,
    "abbreviations": _build_abbreviations,
    "interpretation_checks": _build_interpretation_checks,
    "limitations": _build_limitations,
    "provenance": _build_provenance,
    **{kind: _build_prose_kind for kind in PROSE_KINDS},
}


def _key_tables(blocks: list[dict], section_id: str) -> None:
    """Give every table of one chapter its data key in `tables.json`.

    Scoped by the chapter's id, which a refresh keeps: the appendix and the inventory chapter both print
    the parameter table, and the label dedup below takes the second one's label away — keyed by label,
    that table was left as a literal, the one table in the document a refresh silently skipped. Inside
    the chapter a table is named by what it is (the key its builder gave it, else its label); only a
    table that has neither, or a second one under the same name, falls back to its order.
    """
    seen: dict[str, int] = {}
    for block in blocks:
        if block.get("type") != "table":
            continue
        base = str(block.get("key") or block.get("label") or "table")
        seen[base] = seen.get(base, 0) + 1
        name = base if seen[base] == 1 else f"{base}~{seen[base]}"
        block["key"] = f"{section_id}/{name}" if section_id else name


def blocks_for(
    report: dict[str, Any],
    study: dict,
    lcia: dict,
    contribution: dict | None,
    data: dict[str, Any],
    figures: dict[str, str] | None = None,
    subjects: list[dict] | None = None,
    values: dict[str, str] | None = None,
    labels: dict[str, str] | None = None,
) -> tuple[list[dict], list[str]]:
    """Blocks for a stored report, plus every placeholder that could not be resolved.

    `figures` maps a key to an SVG. Charts are produced where the charting library lives — in the
    renderer — and handed over here; the backend never draws. A figure is attached to the section it
    belongs to, so a section that is reordered or removed takes its chart with it.

    `labels` is `report_typst.indicator_labels` for the method families in play: the one rule for what
    an indicator is *called* in a heading, a table row or a figure caption, decided against the whole
    family rather than against this report's selection. Optional, and with nothing supplied every name
    falls back to the middle segment of the path — see `report_typst.short_method`.
    """
    lang = normalise(report.get("lang"))
    figures = figures or {}
    subjects = subjects or []
    blocks: list[dict] = []
    missing: list[str] = []

    # Contents/figure/table lists are generated by Typst itself — it also localises their titles,
    # which is why neither we nor a model should be writing them. They no longer open the document:
    # the EXECUTIVE SUMMARY renders before them (a reader meets the study's
    # answer before its index), hoisted here regardless of the stored section order, which is also
    # what makes dragging the summary pointless; the chapter list pins it.
    outlines = (report.get("options") or {}).get("outlines")
    outline_block = None
    if outlines:
        args = ", ".join(
            f"{name}: {'true' if outlines.get(name, True) else 'false'}"
            for name in ("contents", "figures", "tables")
        )
        outline_block = rm.raw_block(f"#lca-outlines({args})")

    sections_sorted = sorted(report.get("sections", []), key=lambda s: s.get("order", 0))
    front = [s for s in sections_sorted if s.get("kind") == "summary"]
    # The abbreviations are front matter too: pinned right behind the generated lists, whatever the
    # stored order says — the chapter list shows exactly this order and pins both.
    abbrev = [s for s in sections_sorted if s.get("kind") == "abbreviations"]
    back = abbrev + [s for s in sections_sorted if s.get("kind") not in ("summary", "abbreviations")]
    first_back = back[0] if back else None
    ctx = _BuildCtx(
        report=report, study=study, lcia_result=lcia, contribution=contribution, data=data,
        figures=figures, subjects=subjects, values=values, labels=labels, lang=lang,
        blocks=blocks, missing=missing,
    )
    for section in front + back:
        if outline_block is not None and section is first_back:
            blocks.append(outline_block)
            outline_block = None
        kind = section.get("kind")
        # Empty unless somebody renamed the chapter, which is why every branch below falls back to
        # `kind_title` — the standard heading for the kind, from the string table. That fallback is the
        # same one an error message uses to name a chapter (`chapter_name`), so a refusal calls the
        # chapter what the reader will find above it in the PDF.
        title = section.get("title") or ""
        # Where this section's blocks start, so a written comment can be appended after them rather than
        # before: ISO 14044 puts the finding first and the judgement second, and a paragraph above its own
        # table reads as an introduction to something the reader has not seen yet.
        section_start = len(blocks)
        #: Set by a chapter that printed its own written text itself; see the inventory branch.
        comment_spent = False

        builder = _KIND_BUILDERS.get(kind)
        if builder is not None:
            comment_spent = builder(ctx, section, title)
        else:
            # Skipped visibly: a report missing one section and saying so beats no report at all.
            blocks += [rm.heading(title or kind_title(kind, lang), 1), rm.note(t("empty.unknown_kind", lang))]

        # A deterministic chapter whose data is not there built nothing at all — no heading, no table —
        # and the comment rule below then dropped the author's paragraph with it. The chapter was in the
        # section list, in the drag-and-drop order, and simply absent from the document, without a word
        # anywhere. It happens for real: the contribution chapter needs a breakdown dimension, and a
        # report that has none has no groups to tabulate. So say it. An empty chapter the reader can see
        # is a fixable omission; an invisible one is a lie about what the report covers.
        if kind not in PROSE_KINDS and len(blocks) == section_start:
            blocks.append(rm.heading(title or kind_title(kind, lang), 1))
            blocks.append(rm.note(t(_EMPTY_NOTES.get(kind, "empty.data"), lang)))
        _key_tables(blocks[section_start:], str(section.get("id") or ""))

        # The figures this chapter argues with, in the order it lists them — for *every* kind of chapter, not
        # only the prose ones. That was the first version's mistake: the chapters that argue with charts and
        # tables are precisely the deterministic ones (the impact assessment, the contribution analysis, the
        # annex), and a figure added to one of them was validated, stored, drawn by the renderer and then
        # silently dropped here, because the loop sat inside the prose branch.
        #
        # After the empty-chapter note above, which counts the chapter's own content: a figure is not content,
        # and a chapter with no data still has to say so rather than show a chart under a missing table.
        #
        # A chapter owns a *list*: the contribution as bars and the same comparison as a heatmap are two
        # readings, and one chapter legitimately wants both. `figure` — the writer's single proposal — is drawn
        # when the list is empty, so a report written before the list existed is unchanged. The labels carry
        # the index, which is why reordering a chapter's figures reorders the drawings with them; the data keys
        # carry what each one plots as well (`report_model.section_chart_key`), so a refresh never puts one
        # figure's drawing under another's caption.
        sid = section.get("id", "")
        lead_label = str((data.get("results") or [{}])[0].get("method_label") or "")
        # `contribution.groups` is the report's own breakdown — split by the first dimension.
        lead_dim = str((data.get("breakdown_dimensions") or [""])[0] or "")
        specs = list(section.get("figures") or [])
        labels_of = [f"section-{sid}-{i}" for i in range(len(specs))]
        keys = [
            rm.section_chart_key(str(sid), i, spec or {}, lead_label, lead_dim) for i, spec in enumerate(specs)
        ]
        if not specs and section.get("figure"):
            specs, labels_of = [section["figure"]], [f"section-{sid}"]
            keys = [rm.section_chart_key(str(sid), None, section["figure"], lead_label, lead_dim)]
        for spec, key, stem in zip(specs, keys, labels_of, strict=True):
            if not spec or not figures.get(key):
                continue
            # A caption is prose too: DeepSeek wrote one containing placeholders and a derivation, and without
            # this they would print as literal braces under the chart.
            # Through the captions' own pins — the shared ones only for a chapter stored before
            # captions had any, never a mix (a caption key the caption map lacks must not borrow the
            # text's member for the same index) — and under a scope of their own: text and caption may pin the same
            # index to different members, and one `#pval` key would print whichever was written last.
            # A written caption is prose, quotes included (V427); the generated one is not.
            caption, caption_gaps = rd.resolve(
                rm.normalise_quotes(spec["caption"]) if spec.get("caption") else _figure_caption(spec, data, lang),
                data,
                lang,
                section.get("caption_bindings") if "caption_bindings" in section else section.get("bindings"),
                values,
                scope=f"{sid}-caption" if sid else None,
            )
            missing += caption_gaps
            blocks.append(
                rm.figure(rm.chart_path(key), caption=caption, label=f"f-{stem}", caption_safe=True, key=key)
            )

        # A deterministic chapter may carry a written comment: the tables stay the source, the paragraph
        # underneath says what they mean. ISO 14044 §4.5 asks for exactly that on the interpretation
        # checks, and the same mechanism serves the other deterministic chapters.
        # The prose kinds are excluded because there the text *is* the chapter, already rendered above.
        if (
            kind not in PROSE_KINDS
            and not comment_spent
            and (section.get("text") or "").strip()
            and len(blocks) > section_start
        ):
            # Straightened like the prose chapters' text (V409). This path had been missed: the comment
            # under an LCIA or contribution table printed „Silikonpolymer und -öl„ where the writer typed
            # a German opener and a straight closer, while the summary beside it was fine (V427).
            comment, gaps = rd.resolve(
                rm.normalise_quotes(section["text"]), data, lang, section.get("bindings"), values,
                scope=str(section.get("id") or "") or None,
            )
            missing += gaps
            blocks.append(rm.prose(comment))

    if outline_block is not None:
        blocks.append(outline_block)

    # The glossary, against the finished document: entries whose term no longer appears are dropped, and
    # terms that appear without an explanation are reported (never invented — explaining is a separate,
    # explicit step). Deterministic, so it cannot disagree with the text above it.
    if ctx.abbreviation_slot is not None:
        used = _acronyms_used(blocks, data)
        stored = report.get("abbreviations") or {}
        entries = sorted((k, v) for k, v in stored.items() if k in used)
        blocks[ctx.abbreviation_slot] = (
            rm.table(
                [t("table.abbreviation", lang), t("table.meaning", lang)],
                [[k, v] for k, v in entries],
                label="t-abbreviations",
                key="abbreviations",
            )
            if entries
            else rm.note(t("empty.abbreviations", lang))
        )

    # Cross-references to chapters that are gone. `{{ref:t-contribution}}` becomes `@t-contribution`, and
    # Typst refuses the *whole document* for a label that does not exist ("label `<t-contribution>` does
    # not exist") — so deleting the contribution chapter made every report that mentioned its table
    # unrenderable, with an error naming a label instead of a chapter. Here the reference becomes a visible
    # gap and a reported one, exactly like an unresolved placeholder. Runs after the glossary slot is
    # filled, so `@t-abbreviations` counts as defined. Only an *unescaped* `@` can be a reference we
    # emitted ourselves — prose went through the escaper, which turned a literal `@` into `\@`.
    # A label may exist only once: Typst compiles duplicates happily until something references one,
    # then refuses the whole document ("label occurs multiple times"). Composable sections make
    # duplicates legitimate — an appendix and an inventory chapter both carry the parameter table — so
    # the FIRST occurrence keeps the label and later ones lose theirs. Deterministic ("see Table 2"
    # points at the first, in document order), keeps every stored reference working, and renames
    # nothing — a suffix scheme would have broken old refs and the gate's label set alike.
    seen_labels: set[str] = set()
    for block in blocks:
        label = block.get("label")
        if not label:
            continue
        if label in seen_labels:
            block["label"] = None
        else:
            seen_labels.add(str(label))

    # Defence in depth: should a duplicate ever survive the dedup above, a reference to it degrades to
    # the same visible gap as a missing one instead of killing the compile.
    label_counts = Counter(str(b.get("label")) for b in blocks if b.get("label"))
    defined = {label for label, n in label_counts.items() if n == 1}
    for block in blocks:
        # Only where the resolver writes: prose bodies and resolved figure captions. Heading and note
        # texts are escaped later in render_block, so a raw `@` there is a literal the fixer would
        # wrongly rewrite (a chapter titled "info@example.org" is odd, but it is not a reference).
        fields = ("text",) if block.get("type") == "prose" else ()
        if block.get("type") == "figure" and block.get("caption_safe"):
            fields = ("caption",)
        for field in fields:
            value = block.get(field)
            if not isinstance(value, str) or "@" not in value:
                continue

            def fix(match: re.Match[str], _missing: list[str] = missing) -> str:
                label = match.group(1)
                if label in defined:
                    return match.group(0)
                # Why, not just that. This used to blame a deleted chapter in every case, including the
                # one where nothing was deleted: clearing the heatmap checkbox left two chapters quoting
                # `{{ref:f-heatmap}}` and the refusal sent the author hunting for a chapter that was
                # still there (V196). `report_prompts.reference_gap` owns the wording, so the export and
                # the staleness check cannot say two different things about the same dead reference.
                reason = (
                    "the label appears more than once in this report"
                    if label_counts.get(label, 0) > 1
                    else report_prompts.reference_gap(label, report)
                )
                _missing.append(f"ref:{label} — {reason}")
                return f"[missing reference: {label}]"

            block[field] = re.sub(r"(?<!\\)@([A-Za-z][A-Za-z0-9-]*)", fix, value)

    # Outside the section list on purpose: a comparative assertion meant for publication has to declare
    # a missing critical review (ISO 14044 §7.3.3), and a normative disclosure must not be removable by
    # deleting a chapter. It appears only when the report is marked for publication.
    blocks += report_checks.critical_review_note(data, report, lang)

    return blocks, missing


def _acronyms_used(blocks: list[dict], data: dict[str, Any]) -> set[str]:
    """Acronyms present in the finished document, from the blocks rather than from the Typst source.

    The blocks are what the reader sees, which is the question the glossary answers. Units of the
    computed indicators count as used even where they only appear inside a chart.
    """
    from prism_lca.engine.report_abbreviations import abbreviation_candidates

    parts: list[str] = []
    for block in blocks:
        parts.append(str(block.get("text") or ""))
        parts.append(str(block.get("caption") or ""))
        for row in block.get("rows") or []:
            parts.extend(str(cell) for cell in row)
        parts.extend(str(cell) for cell in block.get("headers") or [])
        for pair in block.get("pairs") or []:
            parts.extend(str(cell) for cell in pair)
    units = [str(r.get("unit") or "") for r in data.get("results") or []]
    return set(abbreviation_candidates(" ".join(parts), extra=[u for u in units if u]))



def _decode_image(value: Any) -> bytes | None:
    """Base64 from the store to bytes. A value that no longer decodes is ignored rather than fatal: a
    broken logo must cost the logo, not the document."""
    import base64

    raw = (value or "").strip() if isinstance(value, str) else ""
    if not raw:
        return None
    try:
        return base64.b64decode(raw, validate=True)
    except Exception as exc:  # noqa: BLE001
        _log.swallowed(exc, "_decode_image")
        return None


def _identity_logo(identity: dict[str, Any] | None) -> bytes | None:
    return _decode_image((identity or {}).get("company_logo"))


#: Why a deterministic chapter came out empty, where we can name the reason. Kinds that build their own
#: "nothing here" note (goal & scope, datasets) never reach the fallback; everything else gets
#: "No data.", which is at least visible.
_EMPTY_NOTES = {"contribution": "empty.contribution", "system_model": "empty.system_model"}


def _squash(text: str) -> str:
    """A name reduced to its letters and digits, for comparing two of them for sameness."""
    return "".join(c for c in text.lower() if c.isalnum())


def _cover_subtitle(report: dict[str, Any], title: str, activity: dict[str, Any]) -> str:
    """The cover's second line: the author's own if they set one, else what the report is about.

    The fallback is only worth printing when it says something the title does not. A report created
    from the canvas is named after its reference process — "Household cling film roll — cradle-to-gate
    report" — so "<same process> (<database>)" underneath repeated the title almost word for word and
    read as a mistake rather than a subtitle. An empty string leaves the key out of the Typst call, so
    the templates fall back to `subtitle: none` and print nothing.
    """
    own = str(report.get("subtitle") or "").strip()
    if own:
        return own
    about = str(activity.get("name") or "").strip()
    # Only the duplicating direction counts: the title *containing* the process name is the case that
    # repeats itself. A title shorter than the process name ("Cling film 2026") is an abbreviation, and
    # then spelling the process out underneath is exactly what a subtitle is for.
    if not about or _squash(about) in _squash(title):
        return ""
    database = str(activity.get("database") or "").strip()
    return f"{about} ({database})" if database else about


def _cover_study(study: dict[str, Any], identity: dict[str, Any] | None, generated: str | None) -> dict[str, Any]:
    """The study metadata as the cover should print it.

    Two fill-ins, both only where the study itself says nothing. The author and the firm come from the
    project's identity, because typing them into every study is how three reports end up crediting three
    different spellings of the same company. The date falls back to the day the document was made: a
    cover without one leaves the reader guessing which version they are holding, and nobody remembers to
    set it by hand.
    """
    out = dict(study or {})
    ident = identity or {}
    for field in ("author", "organisation"):
        if not (out.get(field) or "").strip():
            value = (ident.get(field) or "").strip()
            if value:
                out[field] = value
    if not (out.get("date") or "").strip():
        # `generated` carries a time as well; the cover wants the day — the reader's day, not UTC's.
        out["date"] = _local_day(generated) or out.get("date", "")
    return out


def _local_day(generated: str | None, tz: tzinfo | None = None) -> str:
    """The calendar day of a `generated` stamp on this computer's clock (or `tz`), as YYYY-MM-DD.

    Every producer writes the stamp in UTC: the pipelines as "2026-10-05 23:51 UTC", the preview as the
    report's `updated` cut to "2026-10-05 23:51" (an isoformat in UTC, its zone cut off with it). Taking
    the part before the space therefore printed the UTC day, and a report rendered at 01:51 at night in
    Germany carried yesterday's date on its cover (V428). A stamp without a time is already
    a day and is taken as it stands; one that does not parse falls back to its first word, as before.
    """
    raw = (generated or "").strip()
    if not raw:
        return ""
    stamp = raw.removesuffix("UTC").strip().replace("T", " ").removesuffix("Z")
    try:
        when = datetime.fromisoformat(stamp)
    except ValueError:
        return raw.split(" ")[0]
    if len(stamp) <= 10:  # a bare date — no time of day to move across midnight
        return when.date().isoformat()
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(tz).date().isoformat()


def _cover_image(report: dict[str, Any]) -> bytes | None:
    """The report's cover image as bytes, or None. A stored value that no longer decodes is ignored
    rather than fatal: a broken cover must not make an otherwise finished report unrenderable."""
    import base64

    from prism_lca.engine import typst_render

    raw = (report.get("cover_image") or "").strip()
    if not raw:
        return None
    if raw == typst_render.DEFAULT_COVER:
        try:
            return typst_render.default_cover_bytes()
        except Exception as exc:  # noqa: BLE001 - a missing asset costs the cover, not the document
            _log.swallowed(exc, "_cover_image")
            return None
    try:
        return base64.b64decode(raw, validate=True)
    except Exception as exc:  # noqa: BLE001
        _log.swallowed(exc, "_cover_image")
        return None


def render_sources(
    report: dict[str, Any],
    study: dict,
    lcia: dict,
    contribution: dict | None = None,
    *,
    app_version: str = "",
    template: str | None = None,
    logo: bytes | None = None,
    #: Who carries out the studies in this project — name, firm, its logo and the logo height.
    identity: dict | None = None,
    provenance: dict | None = None,
    parameters: list[dict] | None = None,
    scenarios: list[dict] | None = None,
    figures: dict[str, str] | None = None,
    subjects: list[dict] | None = None,
    health: dict | None = None,
    inventory: dict | None = None,
    hotspots: list[dict] | None = None,
    method_references: list[dict] | None = None,
    model_context: dict | None = None,
    subject_contributions: list[dict] | None = None,
    #: One breakdown per indicator, lead first — see `report_data.build_data`.
    contributions: list[dict] | None = None,
    #: Every dimension's views and the dimension order, plus the system-model figure's data — see
    #: `report_data.build_data`.
    contributions_by_dimension: dict[str, list[dict]] | None = None,
    breakdown_dimensions: list[str] | None = None,
    system_model: dict | None = None,
    dropped_subjects: list[str] | None = None,
    #: Research provenance and the latest internal review's outcome — see `report_data.build_data`.
    web_research: list[dict] | None = None,
    review: dict | None = None,
    #: Every installed method of the families this report uses — `lca.methods_in_families`. What an
    #: indicator's printed name has to be unique against, so the name does not depend on which of the
    #: family's indicators the report happens to have selected (V203). Absent for a caller with no
    #: project open; then every name falls back to the middle segment of its path.
    method_catalog: list[list[str]] | None = None,
    generated: str | None = None,
    #: Stamp every page "Draft" (`RenderRequest.draft`).
    draft: bool = False,
) -> tuple[dict[str, str | bytes], dict[str, Any]]:
    """The Typst project for a stored report, plus a small render report (missing placeholders)."""
    lang = normalise(report.get("lang"))
    # When the document says it was made. `generated` is a caller's override — the preview pins it to the
    # report's own timestamp so paging through it does not reprint a new minute on every page — and
    # otherwise it comes from the provenance the caller already passed, which is where the colophon and the
    # provenance chapter read it from.
    #
    # It used to be *only* the override. Every path but the preview therefore had none, and the cover's date
    # falls back to it when a study leaves the field empty: an exported PDF came out with no date on its
    # title page while the preview beside it showed one.
    generated = generated or (provenance or {}).get("generated") or ""
    data = rd.build_data(
        study,
        lcia,
        contribution,
        lang=lang,
        parameters=parameters,
        scenarios=scenarios,
        provenance=provenance,
        subjects=subjects,
        health=health,
        inventory=inventory,
        hotspots=hotspots,
        method_references=method_references,
        model_context=model_context,
        subject_contributions=subject_contributions,
        contributions=contributions,
        contributions_by_dimension=contributions_by_dimension,
        breakdown_dimensions=breakdown_dimensions,
        system_model=system_model,
        dropped_subjects=dropped_subjects,
        web_research=web_research,
        review=review,
    )
    # Study-borne prose into the report language (engine/report_translations). Candidates are
    # recorded BEFORE substituting — afterwards the sources are gone — and ride the snapshot so the
    # collect endpoint reads them from the cache instead of rebuilding, and so an export bundle
    # says what was translated. Everything downstream (blocks, briefs, bibliography, figures drawn
    # from `subjects`) sees the translated words, which is the point.
    stored_translations = report.get("translations") or {}
    translation_candidates = rtr.candidates(data)
    applied = rtr.apply(data, stored_translations, lang)
    data["translations"] = {
        "candidates": translation_candidates,
        "applied": applied,
        "stored": len(stored_translations.get("map") or {}) if isinstance(stored_translations, dict) else 0,
    }
    # The chapter builders below (goal & scope, the LCIA lead-in, the cover title fallback) read the
    # raw `study` argument, not `data["study"]` — handing them the untranslated dict printed a
    # German critical-review line into an otherwise English report. One source of
    # truth: from here on, the study IS the translated copy.
    study = data["study"]
    # And the same for the variants' printed names. The results matrix reads this list rather than
    # `data["subjects"]` (it needs the raw `lcia` block beside the name), so it was the one place in
    # the document where a variant kept its untranslated name — French prose and a French breakdown
    # table over a German column header, which is what the walk exists to prevent. Copies, never the
    # dicts themselves: this list is the render inputs' own, and `_render_inputs` hands the same
    # objects to the next caller from its memo.
    named, subjects = data.get("subjects") or [], subjects or []
    if len(named) == len(subjects):
        subjects = [
            dict(raw, label=row.get("label") or raw.get("label") or "")
            for raw, row in zip(subjects, named, strict=True)
        ]
    values: dict[str, str] = {}
    # One rule for what an indicator is called, for every heading, table row and caption below. The
    # report's own methods are added to the catalogue rather than replacing it: a method that has since
    # been uninstalled still has to be named, and its family is then judged by what the report carries.
    labels = rt.indicator_labels(
        [list(m) for m in (method_catalog or [])]
        + [r.get("method") or [] for r in data.get("results") or []]
        + [
            r.get("method") or []
            for subject in data.get("subjects") or []
            for r in subject.get("results") or []
        ]
    )
    blocks, missing = blocks_for(
        report, study, lcia, contribution, data, figures, subjects, values, labels
    )
    # Acronyms the finished document uses without explaining them. Reported, never invented: explaining is
    # a separate, explicit step (the Resolve button), and a glossary a model filled in silently would be a
    # glossary nobody checked. Only worth reporting when the report actually carries the chapter.
    unexplained: list[str] = []
    if any(s.get("kind") == "abbreviations" for s in report.get("sections") or []):
        unexplained = sorted(_acronyms_used(blocks, data) - set(report.get("abbreviations") or {}))

    # `data["activity"]`, not `lcia["activity"]`: the walk above translates the snapshot's copy, and
    # the cover reads the raw one. Same defect as the study dict two dozen lines up, one page earlier
    # in the document — an unnamed report of a German model printed its German process name as the
    # cover title and again as the subtitle, under a Spanish document (V193, sibling).
    activity = data.get("activity") or {}
    title = report.get("name") or study.get("goal") or activity.get("name") or "LCA report"
    sources = rt.wrap_document(
        blocks,
        title=title,
        subtitle=_cover_subtitle(report, title, activity),
        study=_cover_study(study, identity, generated),
        lang=lang,
        app_version=app_version,
        template=template,
        # The colour set. `None` (a report written before palettes existed) resolves to the default, which
        # is the values every theme used to hard-code — so an old report renders identically.
        palette=report.get("palette"),
        # The three a report may override by hand. They land in `palette.typ` beside the set's own, so a
        # theme sees colours and never a special case.
        palette_colors=report.get("palette_colors"),
        # The author's mark: the firm's if one is stored, and otherwise none. PrismLCA's own mark used
        # to stand in, which is what made a third state necessary — a "no mark at all" switch, to say what
        # removing the logo already says. A logo handed to this call directly still wins: that is a caller
        # saying "print this one".
        logo=logo if logo is not None else _identity_logo(identity),
        client_logo=_decode_image(report.get("client_logo")),
        logo_height_mm=(identity or {}).get("logo_height_mm"),
        # The report's own cover image, if one was uploaded. Decoded here rather than stored as bytes so
        # the report store stays plain JSON.
        cover_image=_cover_image(report),
        generated=generated,
        values=values,
        # One file per chart the renderer produced, named from its key (`report_model.chart_path`, which
        # also keeps a key from escaping the charts directory), and `figures.json` listing them.
        figures=figures,
        draft=draft,
    )
    return sources, {
        "missing_placeholders": sorted(set(missing)),
        "unexplained_abbreviations": unexplained,
        "data": data,
    }
