"""Typst building blocks the report pipeline shares: template handling, method labels, the colophon,
the goal & scope, results and contribution table builders, and `wrap_document`.

Historically this assembled whole ad-hoc documents; the stored-
report pipeline (report_render + report_kinds) took that job long ago, and the short
report runs on that pipeline too (engine/report_short) — the last ad-hoc builders left with it.

The **colophon** is written here, not in the template, and uses built-in Typst only — a custom
template therefore cannot suppress it. (Inside the exported sources the user owns the files and can
of course delete anything.)
"""
from __future__ import annotations

import json as _json
import re
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime

from prism_lca.engine import report_checks, report_palettes, typst_render
from prism_lca.engine import report_model as rm
from prism_lca.engine.report_i18n import fmt_column, fmt_number, is_plural_authors, t
from prism_lca.engine.report_model import (
    esc,  # re-exported: callers use report_typst.esc
    esc_str,
)
from prism_lca.errors import PrismError

#: Study fields in ISO reporting order; the labels come from the string table per language.
_GOAL_SCOPE_FIELDS = (
    "goal", "scope", "functional_unit", "geography", "reference_year", "system_boundaries",
    "cutoff_criteria",
    # Two allocation decisions, deliberately separate: how a multi-output process is split, and how
    # end-of-life burdens and credits are handled. A critical review asks about the second one, and one
    # field called "allocation" was where that question used to disappear.
    "allocation", "system_allocation",
)


def review_row(study: dict, lang: str) -> str:
    """What the goal & scope table prints beside "Critical review".

    The author's own description when there is one: their sentence says who, when and in what form,
    which no label of ours can. With no description the study's answer stands in for it — otherwise a
    study that confirmed a review without describing it would print "Not recorded" here while the
    limitations chapter two chapters on agrees there was one. A "no" is an answer too and is printed as
    one; only an unanswered question reads "Not recorded".
    """
    text = str(study.get("critical_review") or "").strip()
    if text:
        return text
    if report_checks.critical_review_recorded(study):
        return t("critical_review.carried_out", lang)
    answer = str(study.get("critical_review_done") or "").strip().lower()
    return t("critical_review.not_carried_out" if answer == "no" else "critical_review.none", lang)


def goal_scope_blocks(study: dict, lang: str = "en", title: str | None = None) -> list[dict]:
    pairs = [(t(f"field.{key}", lang), study[key]) for key in _GOAL_SCOPE_FIELDS if study.get(key)]
    # Always stated, recorded or not. Every other field here is left out when it is empty, because an
    # empty row says nothing; this one is the exception, because its absence is itself the reportable
    # fact — a report that omits the line lets the reader assume there was a review.
    #
    # Just the fact, though: "Not recorded", not the standard's requirement. What §7.3.3 demands of a
    # public comparative assertion is already said twice, by `critical_review_note` (which cannot be
    # removed) and by the limitations chapter. Saying it a third time here is the padding this report
    # was criticised for.
    pairs.append((t("field.critical_review", lang), review_row(study, lang)))
    return [rm.heading(title or t("goal_scope.title", lang), 1), rm.kv(pairs)]


def _results_lead(lcia: dict, study: dict, lang: str) -> str:
    """The line that opens a results table: what the numbers are per.

    One amount of one is the ordinary case, and it used to print "Results are reported for **1**
    unit(s) of the reference product" — the plural hack showing through in a client PDF, beside a
    functional unit that already says what one unit is (V254). At an amount of one the count says
    nothing, so it is left out and the sentence is about the functional unit; away from one the count
    is the point and takes a plain plural.
    """
    amount = float(lcia.get("amount", 1.0))
    fu = study.get("functional_unit")
    printed = f"#strong[{fmt_number(amount, lang)}]"
    if fu:
        key = "lead.results_one_fu" if amount == 1.0 else "lead.results_fu"
        return t(key, lang, amount=printed, fu=esc(_clause(fu)))
    key = "lead.results_one" if amount == 1.0 else "lead.results"
    return t(key, lang, amount=printed) + "."


def _clause(text: str) -> str:
    """Free text about to be dropped into a sentence that supplies its own full stop.

    A functional unit is a phrase in the ISO sense ("1 roll, assessed at the factory gate"), but authors
    write it as a sentence just as often — and then the results lead-in came out as "…at the factory
    gate..". Trailing full stops only: an FU may legitimately end in a comma-free abbreviation, and no
    other punctuation belongs at the end of one.
    """
    return text.rstrip().rstrip(".")


def lcia_blocks(
    lcia: dict,
    study: dict,
    lang: str = "en",
    title: str | None = None,
    legend: bool = True,
    labels: dict[str, str] | None = None,
) -> list[dict]:
    lead = _results_lead(lcia, study, lang)
    # Short indicator names here too, with the full paths in a legend below — the same reasoning as the
    # comparison matrix: a full ecoinvent method path wraps over four lines and pushes the number it
    # belongs to out of sight, and the identity of the method still has to be in the document.
    results = lcia.get("results", [])
    columns = [(" / ".join(r.get("method", [])), str(r.get("unit") or "")) for r in results]
    # Per VALUE, not per column: every row here is a different indicator in a different unit, so a shared
    # number of decimals is not consistency but damage. A study with climate change 1.16 kg CO2-Eq beside
    # land use 167 points printed the climate figure as "1" — the column took its precision from the
    # largest magnitude in it, which is right when a column is one unit (a contribution table) and wrong
    # when each row is its own.
    scores = [fmt_number(float(r.get("score", 0.0)), lang) for r in results]
    rows = [
        [short_method(label, labels), unit, score]
        for (label, unit), score in zip(columns, scores, strict=True)
    ]
    return [
        rm.heading(title or t("lcia.title", lang), 1),
        rm.prose(lead),
        rm.table(
            [t("table.indicator", lang), t("table.unit", lang), t("table.score", lang)],
            rows,
            caption=t("caption.lcia", lang),
            align_right=[2],
            label="t-lcia",
        ),
        *(_method_legend(columns, lang, labels) if legend else []),
    ]


def lcia_matrix_blocks(
    subjects: list[dict],
    study: dict,
    lang: str = "en",
    title: str | None = None,
    orientation: str = "auto",
    legend: bool = True,
    labels: dict[str, str] | None = None,
) -> list[dict]:
    """Results for several subjects side by side.

    A comparative study is the normal case in consulting — a product against its alternative, a
    baseline against a scenario. `subjects` is a list of ``{"label": str, "lcia": <compute_multi>}``;
    the method order of the first subject sets the order, so a subject missing an indicator leaves a
    gap rather than shifting the row.

    **Which way round** is `orientation`: ``"subjects"`` puts one row per subject and one column per
    indicator, ``"indicators"`` the other way, and ``"auto"`` — the default — picks indicators as rows
    as soon as there are more indicators than subjects. Eleven indicators as columns on a portrait page
    is what the first real report printed: a header taller than its data, every word broken onto its
    own line, and a column so narrow that 8.35e-6 rendered as "0.0000". Practice with ten-plus
    categories and a handful of variants is the transposed shape, and it is also the one whose numbers
    can be formatted honestly, because a row is then one indicator in one unit.
    """
    if not subjects:
        return [rm.heading(title or t("lcia.title", lang), 1), rm.note(t("empty.data", lang))]

    columns: list[tuple[str, str]] = []  # (method label, unit)
    for r in subjects[0]["lcia"].get("results", []):
        columns.append((" / ".join(r.get("method", [])), str(r.get("unit") or "")))

    by_subject = [
        {" / ".join(r.get("method", [])): r for r in subject["lcia"].get("results", [])}
        for subject in subjects
    ]
    wide = orientation == "indicators" or (orientation == "auto" and len(columns) > len(subjects))

    if wide:
        # One row per indicator: the name and the unit get a column of their own, so nothing is
        # shortened into a header and every score in the row shares one unit — which is exactly the
        # condition under which a shared number of decimals is right rather than damage.
        headers = [t("table.indicator", lang), t("table.unit", lang)] + [
            str(s.get("label") or "") for s in subjects
        ]
        rows = []
        for label, unit in columns:
            hits = [found.get(label) for found in by_subject]
            formatted = iter(fmt_column([float(h.get("score", 0.0)) for h in hits if h], lang))
            rows.append(
                [short_method(label, labels), unit]
                + [next(formatted) if hit else "—" for hit in hits]
            )
        align_right = list(range(2, len(headers)))
    else:
        # Short names in the header, full paths in a legend underneath. A full ecoinvent method path is
        # three long segments; five of them as column headers produced a header taller than the data, with
        # every word on its own line. The impact category is what a reader recognises, and the identity of
        # the method still has to be in the document — hence the legend rather than a truncation.
        headers = [t("table.subject", lang)] + [
            f"{short_method(label, labels)} ({unit})" if unit else short_method(label, labels)
            for label, unit in columns
        ]
        # Column by column, so every cell of one indicator carries the same decimals — mixing 1,201 with
        # 2,3 in one column reads as carelessness, and a comparison table is read by columns.
        cells: list[list[str]] = [[subject.get("label") or ""] for subject in subjects]
        for label, _unit in columns:
            hits = [found.get(label) for found in by_subject]
            formatted = fmt_column([float(h.get("score", 0.0)) for h in hits if h], lang)
            it = iter(formatted)
            for row, hit in zip(cells, hits, strict=True):
                row.append(next(it) if hit else "—")
        rows = cells
        align_right = list(range(1, len(headers)))

    lead = _results_lead(subjects[0]["lcia"], study, lang)
    return [
        rm.heading(title or t("lcia.title", lang), 1),
        rm.prose(lead),
        rm.table(
            headers,
            rows,
            caption=t("caption.lcia", lang),
            align_right=align_right,
            label="t-lcia",
        ),
        *(_method_legend(columns, lang, labels) if legend else []),
    ]


def indicator_labels(methods: Iterable[Sequence[str]]) -> dict[str, str]:
    """Full method path -> the name it is printed under: the shortest form still unique in its family.

    The middle segment alone is only a name where the family gives it to one indicator. ``EF v3.1``
    does — ``("EF v3.1", "climate change", "global warming potential (GWP100)")`` is the only climate
    change it has, and the third part is a technicality. ``ReCiPe 2016 v1.03, endpoint (H)`` does not:
    there the middle part is the *damage category*, so twelve indicators share "ecosystem quality" and
    the third part is the whole distinction. A report of four of them printed two chapters, two table
    rows and two figure captions called "ecosystem quality", with different numbers under them (V203).

    So the decision is made per family and against **every** indicator that family has, never against
    the handful a report or a filtered list happens to show: a name that shrank when a sibling was
    deselected would change from render to render, and the caller could not tell the two apart anyway.
    `methods` is therefore the installed catalogue of the families in play, not the selection.

    Paths of fewer than three segments are left out entirely — see `short_method`, which prints those
    whole. Their middle part is also their last, so no two of them can collide without being the same
    method.
    """
    parsed: list[tuple[str, list[str]]] = []
    for method in methods:
        parts = [str(p).strip() for p in (method or []) if str(p).strip()]
        if len(parts) >= 3:
            parsed.append((" / ".join(parts), parts))
    # Which (family, category) pairs more than one indicator answers to. Counted over distinct paths,
    # so the same method arriving twice — catalogue plus the report's own list — is not a collision.
    kin: dict[tuple[str, str], set[str]] = {}
    for path, parts in parsed:
        kin.setdefault((parts[0], parts[1]), set()).add(path)
    return {
        path: parts[1] if len(kin[(parts[0], parts[1])]) == 1 else " / ".join(parts[1:])
        for path, parts in parsed
    }


def short_method(label: str, labels: dict[str, str] | None = None) -> str:
    """A recognisable name for an indicator: the impact category, not the whole path.

    ecoinvent method tuples read ``("IPCC 2013 no LT", "climate change no LT", "global temperature
    change potential (GTP100) no LT")`` — 90 characters that no table header can carry. The middle
    segment is the one a reader recognises.

    `labels` is `indicator_labels` for the families in play, and it is what makes that true for a
    family whose middle segment names several indicators. Without it — a caller that has no catalogue
    to judge against — the middle segment is used as before, which is right for every family whose
    categories are indicators and no worse than what the document did before V203 for the rest.

    A shorter path is returned unchanged: shortening something that already fits only loses
    information, and it would produce a legend that explains nothing.
    """
    parts = [p.strip() for p in (label or "").split(" / ") if p.strip()]
    if len(parts) < 3:
        return label or ""
    return (labels or {}).get(" / ".join(parts)) or parts[1]


def _method_legend(
    columns: list[tuple[str, str]], lang: str, labels: dict[str, str] | None = None
) -> list[dict]:
    """Which short name stands for which method. Only when shortening actually hid something."""
    pairs = [
        (short_method(label, labels), label)
        for label, _unit in columns
        if short_method(label, labels) != label
    ]
    if not pairs:
        return []
    return [
        rm.table(
            [t("table.indicator", lang), t("table.method", lang)],
            [[short, full] for short, full in pairs],
            caption=t("caption.methods", lang),
            # NOT "t-methods": the methods *chapter* owns that label (report_render), and this legend
            # renders alongside it in the same document — Typst refuses a document with a label twice.
            label="t-method-legend",
        )
    ]


def indicator_contribution_blocks(
    view: dict,
    lang: str = "en",
    *,
    index: int = 0,
    heading: str | None = None,
    indicator: str | None = None,
    #: The label stem — `contribution` for the report's own breakdown, `contribution-d<k>` for a
    #: chapter split by another dimension, so two chapters never emit the same Typst label.
    label_prefix: str = "contribution",
    #: The table's data key in `tables.json` — what it is (dimension and indicator), not where it stands.
    data_key: str | None = None,
) -> list[dict]:
    """One indicator's breakdown, from the **prepared** view in the data snapshot.

    The two builders above take the raw contribution and re-derive what the snapshot already worked
    out — sorting, the dust filter, the shares. They still serve the ad-hoc `/iso` and `/pdf` paths,
    which never build a snapshot. A stored report does, and now carries one view per indicator, so
    this reads the snapshot instead: the table, the chart drawn from the same view in the renderer,
    and any sentence quoting `contributions.N.groups.0.share_text` then cannot disagree.

    With variants it prints the matrix — phases down the side, baseline and every scenario across —
    because that is the comparison the chapter exists to make. With one subject a second column would
    only repeat the first, so it prints impact and share.
    """
    groups = view.get("groups") or []
    if not groups:
        return []
    # With several indicators the table caption has to name which one, or three of them read
    # "Contribution analysis" in the list of tables (V311).
    table_caption = (
        t("caption.contribution_one", lang, indicator=indicator) if indicator else t("caption.contribution", lang)
    )
    subjects = view.get("subjects") or []
    unit = str(view.get("unit") or "")
    blocks: list[dict] = []
    if heading:
        blocks.append(rm.heading(heading, 2))

    if len(subjects) > 1:
        # Matched across variants by `key` and printed by `label`: the key binds, the label follows the
        # report language (V240). A variant that carries a phase the baseline does not brings its own
        # label with it, which is why the fallback is read from wherever the key first appeared.
        order: list[str] = []
        labels: dict[str, str] = {}
        for source in [groups, *(s.get("groups") or [] for s in subjects)]:
            for group in source:
                if group["key"] not in order:
                    order.append(group["key"])
                    labels[group["key"]] = str(group.get("label") or group["key"])
        rows: list[list[str]] = []
        for key in order:
            values = [
                next((g["impact"] for g in (s.get("groups") or []) if g["key"] == key), None) for s in subjects
            ]
            texts = fmt_column([v for v in values if v is not None], lang)
            it = iter(texts)
            rows.append([labels[key]] + [next(it) if v is not None else "—" for v in values])
        header = [t("table.group", lang)] + [
            f"{s['label']} ({unit})" if unit else str(s["label"]) for s in subjects
        ]
        blocks.append(
            rm.table(
                header,
                rows,
                caption=table_caption,
                align_right=list(range(1, len(subjects) + 1)),
                label=_contribution_label("t", index, label_prefix),
                key=data_key,
            )
        )
        return blocks

    impacts = fmt_column([float(g.get("impact", 0.0)) for g in groups], lang)
    rows = [
        [str(g.get("label") or g.get("key") or ""), impact, str(g.get("share_text") or "")]
        for g, impact in zip(groups, impacts, strict=True)
    ]
    blocks.append(
        rm.table(
            [t("table.group", lang), f"{t('table.impact', lang)} ({unit})", t("table.share", lang)],
            rows,
            caption=table_caption,
            align_right=[1, 2],
            label=_contribution_label("t", index, label_prefix),
            key=data_key,
        )
    )
    if view.get("dropped"):
        blocks.append(rm.note(t("contribution.dust", lang).format(count=view["dropped"])))
    return blocks


def _contribution_label(prefix: str, index: int, stem: str = "contribution") -> str:
    """`t-contribution` / `f-contribution` for the leading indicator, suffixed for the rest.

    The lead keeps the bare label every stored chapter already references and the export gate already
    knows. Renaming it to `-0` would have turned every written report in the wild into one that points
    at a table nobody emits — the exact hole the gate exists to prevent, caused by the fix for
    something else.
    """
    return f"{prefix}-{stem}" if index == 0 else f"{prefix}-{stem}-{index}"


WEBSITE_URL = "https://prismlca.com"
WEBSITE_LABEL = "prismlca.com"


def colophon(app_version: str = "", generated: str | None = None, lang: str = "en") -> str:
    """The PrismLCA attribution on the last page. Built-in Typst only, on purpose."""
    stamp = generated or datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    line1 = t("colophon.generated", lang, version=esc(app_version) if app_version else "", date=stamp)
    # An empty version leaves the gap it stood in ("PrismLCA  on …") — collapse it.
    line1 = re.sub(r" {2,}", " ", line1)
    # A real link in the surrounding colophon colour (no theme styling reaches it), underlined so it reads
    # as one. Built-in `link`/`underline` only, like the rest of the block.
    line2 = t("colophon.website", lang, link=f'#link("{WEBSITE_URL}")[#underline[{WEBSITE_LABEL}]]')
    # `v(1fr)` pushes the block to the bottom of the LAST content page when there is room, and lets
    # it flow to a new page only when there is not — a forced pagebreak wasted a whole blank sheet.
    return (
        "\n#v(1fr)\n"
        "#block(width: 100%, breakable: false)[\n"
        "  #block(width: 100%)[\n"
        '    #line(length: 100%, stroke: 0.5pt + rgb("#cbcbcb"))\n'
        "    #v(4pt)\n"
        "    #grid(columns: (auto, 1fr), column-gutter: 8pt, align: horizon,\n"
        '      image("prism-mark.png", height: 8mm),\n'
        '      [#set text(size: 8.5pt, fill: rgb("#8a8a8a"))\n'
        f"       {line1} \\\n"
        f"       {line2}]\n"
        "    )\n"
        "  ]\n"
        "]\n"
    )



#: The table lookup in `main.typ`'s preamble. A key that is gone prints as `[missing table: …]`, the way
#: `pval` prints a vanished value, rather than failing the compile or keeping an old table — and an empty
#: table prints "No data.". Both still carry the table's label when it has one, as a table figure with the
#: marker in place of the grid: the author's `See @t-lcia` must keep a target, or a refresh that lost the
#: table would fail the whole compile ("label does not exist") instead of showing the gap. Options are
#: passed to the theme only when set, so its own defaults apply exactly as they did for the literal call.
#:
#: `cited` is for a table without a caption whose label the text references (the glossary, `@t-abbreviations`).
#: Every theme prints such a table bare and drops the label — a bare table is no reference target — so
#: `See @t-abbreviations` failed the compile. Wrapped in a table figure it becomes one, at the price of a
#: table number; that is why only a cited table pays it, and every other table typesets as before. The
#: renderer sets the flag from the document's own references; an author who cites one by hand sets it too.
#:
#: A table stays whole — caption, column heads and rows on one page — and moves on to the next page as one
#: when it does not fit where it starts; only a table taller than a whole page may break. Every theme lets
#: table figures break (an annex inventory has to), so on its own a twelve-row table split after its head
#: and its rows went to the next page. `_whole` measures each table against the body area, which the
#: placed `layout` records on the first body page — after the cover, whose page has no margins — and
#: makes the block unbreakable when it fits. Until the measure is in (the first layout pass) it may break.
_PTABLE = """#let _tables = json("tables.json")
#let _body-room = state("lca-body-room", none)
#place(layout(size => _body-room.update((w: size.width, h: size.height))))
#let _whole(body) = context {
  let room = _body-room.get()
  block(breakable: room == none or measure(body, width: room.w).height > room.h, body)
}
#let ptable(key, label-name: none, caption: none, cited: false) = {
  let entry = _tables.at(key, default: none)
  let gap(body) = if label-name == none { body } else {
    [#figure(body, caption: caption, kind: table) #label(label-name)]
  }
  if entry == none { gap("[missing table: " + key + "]") } else if entry.rows.len() == 0 { gap(emph[No data.]) } else {
    let right = entry.at("align-right", default: ())
    let grid = lca-table(
      entry.headers,
      entry.rows,
      ..if caption != none { (caption: caption) } else { (:) },
      ..if right.len() > 0 { (align-right: right) } else { (:) },
      ..if label-name != none { (label-name: label-name) } else { (:) },
    )
    _whole(if cited and caption == none and label-name != none {
      [#figure(grid, kind: table) #label(label-name)]
    } else { grid })
  }
}
"""


#: The chart lookup, `ptable`'s sibling. `figures.json` maps a chart's key (what it shows — see
#: `report_model.chart_key`) to its file under `charts/`; a key the file does not list prints as a figure
#: holding `[missing figure: …]`, with the caption and the label the author's text cites. The manifest is
#: what makes the gap visible at all: Typst cannot ask whether a file exists, and after a refresh the old
#: SVG still lies in `charts/` — read directly, it would keep printing last month's chart, or, named by
#: position, another indicator's. Options reach the theme's `lca-figure` exactly as the literal call
#: passed them.
_PFIGURE = """#let _figures = json("figures.json")
#let pfigure(key, caption: none, width: none, label-name: none) = {
  let path = _figures.at(key, default: none)
  if path == none {
    // The gap takes the room the chart would have taken, so the page does not reflow around it.
    let body = block(width: if width == none { 100% } else { width }, align(center, "[missing figure: " + key + "]"))
    if label-name == none and caption == none { body } else if label-name == none {
      figure(body, caption: caption, kind: image)
    } else {
      [#figure(body, caption: caption, kind: image) #label(label-name)]
    }
  } else {
    lca-figure(
      path,
      ..if caption != none { (caption: caption) } else { (:) },
      ..if width != none { (width: width) } else { (:) },
      ..if label-name != none { (label-name: label-name) } else { (:) },
    )
  }
}
"""


def place_charts(figures: dict[str, str] | None) -> dict[str, str]:
    """The chart files and their manifest: `charts/<file>.svg` per drawn chart, plus `figures.json`.

    Every chart the renderer supplied is placed and listed, under the file `report_model.chart_path`
    derives from its key. `figures.json` is always written, like `tables.json` — `main.typ` reads it
    unconditionally, and in a refresh archive it is what tells an old document which charts still exist.
    """
    placed: dict[str, str] = {}
    manifest: dict[str, str] = {}
    owner: dict[str, str] = {}
    for key, svg in sorted((figures or {}).items()):
        # A key is a string the renderer built; one that is empty or absurdly long is not a chart.
        if not svg or not isinstance(svg, str) or not key or len(key) > 1000:
            continue
        path = rm.chart_path(key)
        if path in owner and owner[path] != key:
            # Two charts, one file: the manifest would list both and one drawing would stand under the
            # other's caption. Refused rather than overwritten.
            raise PrismError(
                f"Two figures map to one chart file ({path}): {owner[path]!r} and {key!r}.",
                code="chart_path_collision",
            )
        owner[path] = key
        placed[path] = svg
        manifest[key] = path
    placed["figures.json"] = _json.dumps(manifest, indent=1, ensure_ascii=False)
    return placed


def document_text(sources: dict[str, str | bytes]) -> str:
    """The words of a typeset document: `main.typ` plus every table cell it reads from `tables.json`.

    For whatever scans the document for what it says — the acronym candidates above all. Since the tables
    left `main.typ`, reading that file alone would miss every unit and dataset name that stands only in a
    table, and the glossary would shrink without anything in the document having changed.
    """
    main = str(sources.get("main.typ", ""))
    try:
        tables = _json.loads(str(sources.get("tables.json") or "{}"))
    except ValueError:
        return main
    cells = [
        str(cell)
        for table in tables.values()
        for line in [table.get("headers") or [], *(table.get("rows") or [])]
        for cell in line
    ]
    return main + "\n" + "\n".join(cells)


def _declares(source: str, param: str) -> bool:
    """Does this theme's `lca-report-template` declare `param`?

    Asked before passing an optional argument: Typst rejects one a function does not accept, so handing a
    newly added parameter to every theme would break every theme downloaded before it existed — and a theme
    of your own is a file on disk that nobody migrates.

    Only the parameter list is searched, not the whole file. A plain `"kind:" in source` was true for every
    shipped theme, because they all carry `show figure.where(kind: table)` in the body — which is how Network
    came to be handed a `kind` it does not take.
    """
    return param in _template_params(source)


def _template_params(source: str) -> set[str]:
    """The named parameters of a theme's `lca-report-template`, read from its parameter list alone.

    The list ends at the parenthesis that balances the opening one, wherever that sits — a theme of your own
    may close it on the last parameter's line — so it is scanned rather than cut at a fixed closing line;
    cut there, a theme without that line had its whole body searched, and a `date:` inside its
    `set document(...)` was taken for a parameter the assembler then handed it. Comments and strings are
    skipped (the shipped themes explain their parameters in comments full of parentheses), and only names at
    the list's own level count, never one inside a default value.
    """
    opening = "#let lca-report-template("
    start = source.find(opening)
    if start < 0:
        return set()
    i, n, depth, top = start + len(opening), len(source), 1, []
    while i < n:
        if source.startswith("//", i):
            end = source.find("\n", i)
            i = n if end < 0 else end
            continue
        if source.startswith("/*", i):
            end = source.find("*/", i + 2)
            i = n if end < 0 else end + 2
            continue
        c = source[i]
        if c == '"':
            i += 1
            while i < n and source[i] != '"':
                i += 2 if source[i] == "\\" else 1
            i += 1
            top.append(" ")
            continue
        if c in "([{":
            if depth == 1:
                top.append(" ")
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                break
            if depth == 1:
                top.append(" ")
        elif depth == 1:
            top.append(c)
        i += 1
    return set(re.findall(r"(?:^|,)\s*([A-Za-z_][\w-]*)\s*:", "".join(top)))

def _image_filename(blob: bytes | None, stem: str = "cover") -> str | None:
    """The name an image gets inside the Typst project, or None if there is none.

    The extension has to match the bytes: Typst picks its decoder from the FILE NAME, not from the
    content, so a JPEG called `cover.png` fails the compile with "Invalid PNG signature" — which is
    exactly what a user uploading a JPEG used to get, because everything was written as `cover.png`.
    The same holds for the two logos, which is why they go through here as well.
    """
    if not blob:
        return None
    if blob[:3] == b"\xff\xd8\xff":
        return f"{stem}.jpg"
    # An SVG may open with a BOM, whitespace or a comment before its root element — sniff past those,
    # or a real SVG falls through to `.png` and fails the compile with "Invalid PNG signature".
    head = blob[:256].lstrip(b"\xef\xbb\xbf \t\r\n")
    if head[:4] == b"<svg" or head[:5] == b"<?xml" or head[:4] == b"<!--":
        return f"{stem}.svg"
    return f"{stem}.png"


def wrap_document(
    blocks: list[dict],
    *,
    title: str,
    subtitle: str = "",
    study: dict | None = None,
    lang: str = "en",
    app_version: str = "",
    template: str | None = None,
    #: The report's colour set. The themes import `palette.typ`, which is written from this — so one
    #: choice reaches whichever theme is in use. None = the PrismLCA set.
    palette: str | None = None,
    #: Accent, deep tone and paper chosen on the report itself, replacing the set's three. Validated by
    #: `report_palettes.check_colors`, which is also what the API does on the way in.
    palette_colors: dict | None = None,
    logo: bytes | None = None,
    #: The client's mark, printed opposite the author's at the same height. Absent = nothing there.
    client_logo: bytes | None = None,
    #: Height of BOTH logos in millimetres — one number, so they cannot end up at different sizes.
    logo_height_mm: float | None = None,
    cover_image: bytes | None = None,
    generated: str | None = None,
    values: dict[str, str] | None = None,
    #: The charts the renderer drew, by key (`report_model.chart_key`). Placed under `charts/` and listed in
    #: `figures.json`, which the document's `#pfigure` calls read.
    figures: dict[str, str] | None = None,
    #: Stamp every page, the cover included, with the report language's word for "draft".
    draft: bool = False,
) -> dict[str, str | bytes]:
    """Wrap rendered blocks into a complete Typst project — also exactly what an export bundle holds.

    Shared by the ad-hoc report and the stored one, so the document frame, the template wiring and the
    colophon cannot drift apart between the two paths.
    """
    study = study or {}
    # `esc_str`, not `esc`: these land inside Typst *string literals*, where the markup escaper both
    # prints stray backslashes and leaves `"` unescaped — a quote in the study goal ended the string
    # and handed the rest of the line to the compiler as arguments.
    head = [
        '#import "template.typ": *',
        "",
        # Before the template, so no theme has to know about it: its own `set page` names paper, margins,
        # header and background, never the foreground, and a rule set before any content opens no page.
        # Translucent and diagonal, so it reads on a light and a dark paper and covers no word.
        *(
            [
                "#set page(foreground: place(center + horizon, rotate(-35deg, text(size: 92pt, weight: 700, "
                f'fill: rgb(220, 40, 40, 30%), "{esc_str(t("doc.draft", lang))}"))))',
                "",
            ]
            if draft
            else []
        ),
        "#show: lca-report-template.with(",
        f'  title: "{esc_str(title)}",',
    ]
    if subtitle:
        head.append(f'  subtitle: "{esc_str(subtitle)}",')
    if study.get("author"):
        head.append(f'  author: "{esc_str(study["author"])}",')  # PDF metadata
    # The cover's key/value block. Built here because only Python has the string tables — a template
    # cannot know the report's language, and the previous version's hardcoded English labels appeared on
    # every German, French, Spanish and Portuguese cover. Empty fields are dropped rather than printed
    # as a label with nothing after it.
    # "Authors" when the field names more than one person — in every language, not only in English,
    # where a missing plural is easiest to notice.
    author = str(study.get("author") or "")
    theme_source = template if template is not None else typst_render.default_template_source()
    # A theme that declares `date` sets the date apart — under the title rather than among the details at
    # the foot — and gets it on its own, with the details passed without it so it is not printed twice.
    # Declared rather than assumed, for the reason given at `kind` below.
    own_date = _declares(theme_source, "date")
    pairs = [
        (t("field.authors" if is_plural_authors(author) else "field.author", lang), study.get("author")),
        (t("field.organisation", lang), study.get("organisation")),
        (t("field.commissioner", lang), study.get("commissioner")),
        *([] if own_date else [(t("field.date", lang), study.get("date"))]),
    ]
    meta = ", ".join(f'("{esc_str(label)}", "{esc_str(value)}")' for label, value in pairs if value)
    if meta:
        head.append(f"  meta: ({meta},),")
    if own_date and study.get("date"):
        head.append(f'  date: "{esc_str(study["date"])}",')
    # What the document *is*, translated — the eyebrow over the title on the themes that print one. Here
    # rather than in the template for the same reason as the meta labels: only Python has the string tables.
    #
    # Passed ONLY to a theme that declares the parameter. Typst rejects an argument a function does not
    # accept, so handing `kind:` to every template would break every theme downloaded before this existed —
    # and a theme of your own is a file on disk that nobody migrates. A theme adopts the label by naming it.
    if _declares(theme_source, "kind"):
        head.append(f'  kind: "{esc_str(t("cover.kind", lang))}",')
    # Both marks are named after their real format, for the same reason the cover image is: Typst picks
    # its decoder from the file name. A firm's logo uploaded as a JPEG, written as `.png`, fails the
    # compile with "Invalid PNG signature" — and it is the one image on the page nobody can do without.
    #
    # No logo means no logo. PrismLCA's own mark used to stand in for a missing one — which is why
    # there had to be a switch for "none at all", and why removing an uploaded logo did not remove the mark
    # from the cover. Now the argument is simply left out, the template's `logo: none` default applies and
    # every cover's `if logo != none` guard draws nothing. What still says the document came from PrismLCA is
    # the colophon, which no template can suppress.
    logo_name = _image_filename(logo, "logo")
    if logo_name:
        head.append(f'  logo: "{logo_name}",')
    client_name = _image_filename(client_logo, "client-logo")
    if client_name:
        head.append(f'  client-logo: "{client_name}",')
    if logo_height_mm:
        head.append(f"  logo-height: {float(logo_height_mm):g}mm,")
    # Only wired when there is one: passing a path for a file that is not in the project fails the
    # compile, and the template's no-image cover is a designed layout rather than a fallback.
    cover_name = _image_filename(cover_image)
    if cover_name:
        head.append(f'  cover-image: "{cover_name}",')
    head.append(f'  lang: "{esc_str(lang)}",')
    head.append(")")

    # The figures a chapter quotes live in `values.json`, and the document looks them up while compiling.
    # Inlining them made an exported project's prose fixed text: replacing the data changed the tables and
    # the charts but not a single sentence. `pval` is defined here rather than in the template, so a custom
    # template needs to know nothing about it.
    #
    # The tables, likewise, live in `tables.json`: as literals in `main.typ` they stayed on the
    # export's numbers while a data refresh moved the prose beside them — the text said 200 and the table
    # 100. The cells travel already formatted, so the language, the decimals per column and the scientific
    # notation are decided once, in Python, exactly as for the literal; Typst only places them. `ptable`
    # hands them to the theme's own `lca-table`, which therefore receives the same values as before — no
    # theme, shipped or uploaded, has to know about any of it.
    preamble = (
        '\n#let _values = json("values.json")\n'
        '#let pval(key) = _values.at(key, default: "[missing: " + key + "]")\n'
        + _PTABLE
        + _PFIGURE
    )
    tables: dict[str, dict] = {}
    body = rm.render_blocks(blocks, tables)
    main = "\n".join(head) + preamble + "\n" + body + colophon(app_version, generated, lang)
    images = typst_render.assets_dir() / "images"
    return {
        "main.typ": main,
        "values.json": _json.dumps(values or {}, indent=1, ensure_ascii=False),
        # Always written, like `values.json`: `main.typ` reads it unconditionally.
        "tables.json": _json.dumps(tables, indent=1, ensure_ascii=False),
        # The charts and `figures.json`, their manifest — likewise always (see `place_charts`).
        **place_charts(figures),
        "template.typ": theme_source,
        # The colours, as Typst bindings under the names the themes use. Always written: a theme that
        # imports it must find it, and one that declares its own colours simply ignores the file.
        "palette.typ": report_palettes.palette_typst(palette, palette_colors),
        # Written only when the cover asks for one, or the project would carry an unused 20kB PNG.
        **({logo_name: logo} if logo_name and logo is not None else {}),
        "prism-mark.png": (images / "prism-mark.png").read_bytes(),
        **({cover_name: cover_image} if cover_name else {}),
        **({client_name: client_logo} if client_name else {}),
    }
