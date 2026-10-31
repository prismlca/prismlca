"""The report's data snapshot: everything a placeholder can name, built once per render.

The placeholder *language* lived here too until it was split; it is two modules now —
``report_tokens`` (the grammar, binding-free) and ``report_bindings`` (identity pins and the
evaluation under them) — and this module keeps its third job: building ``data.json``. The moved
names are re-exported below, verbatim: `report_data as rd` is how every engine module, router and
test addresses the language, and that façade is the contract — the split must not ripple.
"""
from __future__ import annotations

from typing import Any

# Top-level on purpose: an earlier comment here claimed report_checks imports this module back —
# it never has (it reads only report_i18n and report_model), so the call-time import it justified
# was a workaround for a cycle that does not exist.
from prism_lca.engine import report_checks

# The façade: the split halves, re-exported under their long-standing addresses (`as`-form so the
# linter reads them as deliberate re-exports, not unused imports).
from prism_lca.engine.report_bindings import (
    IDENTITY_LABELS as IDENTITY_LABELS,
)
from prism_lca.engine.report_bindings import (
    LABEL_KEY as LABEL_KEY,
)
from prism_lca.engine.report_bindings import (
    MAGNITUDE_RANKED as MAGNITUDE_RANKED,
)
from prism_lca.engine.report_bindings import (
    MEMBER_LABEL_FIELDS as MEMBER_LABEL_FIELDS,
)
from prism_lca.engine.report_bindings import (
    RANKED_LISTS as RANKED_LISTS,
)
from prism_lca.engine.report_bindings import (
    bindings_for as bindings_for,
)
from prism_lca.engine.report_bindings import (
    bound_lookup as bound_lookup,
)
from prism_lca.engine.report_bindings import (
    captions_of as captions_of,
)
from prism_lca.engine.report_bindings import (
    derive as derive,
)
from prism_lca.engine.report_bindings import (
    derive_value as derive_value,
)
from prism_lca.engine.report_bindings import (
    describe_identity as describe_identity,
)
from prism_lca.engine.report_bindings import (
    explain as explain,
)
from prism_lca.engine.report_bindings import (
    identity_fields as identity_fields,
)
from prism_lca.engine.report_bindings import (
    identity_matches as identity_matches,
)
from prism_lca.engine.report_bindings import (
    identity_of as identity_of,
)
from prism_lca.engine.report_bindings import (
    is_magnitude_ranked as is_magnitude_ranked,
)
from prism_lca.engine.report_bindings import (
    member_label as member_label,
)
from prism_lca.engine.report_bindings import (
    numeric as numeric,
)
from prism_lca.engine.report_bindings import (
    prose_of as prose_of,
)
from prism_lca.engine.report_bindings import (
    rank_claim as rank_claim,
)
from prism_lca.engine.report_bindings import (
    rank_name as rank_name,
)
from prism_lca.engine.report_bindings import (
    ranked_prefix as ranked_prefix,
)
from prism_lca.engine.report_bindings import (
    ranked_splits as ranked_splits,
)
from prism_lca.engine.report_bindings import (
    registry_key as registry_key,
)
from prism_lca.engine.report_bindings import (
    resolve as resolve,
)
from prism_lca.engine.report_i18n import dimension_name, t
from prism_lca.engine.report_tokens import (
    AGGREGATES as AGGREGATES,
)
from prism_lca.engine.report_tokens import (
    DERIVATIONS as DERIVATIONS,
)
from prism_lca.engine.report_tokens import (
    PLACEHOLDER as PLACEHOLDER,
)
from prism_lca.engine.report_tokens import (
    RANK_PREFIX as RANK_PREFIX,
)
from prism_lca.engine.report_tokens import (
    is_aggregate as is_aggregate,
)
from prism_lca.engine.report_tokens import (
    lookup as lookup,
)
from prism_lca.engine.report_tokens import (
    paths_in_token as paths_in_token,
)
from prism_lca.engine.report_tokens import (
    placeholders_in as placeholders_in,
)
from prism_lca.engine.report_tokens import (
    prints_own_unit as prints_own_unit,
)
from prism_lca.engine.report_tokens import (
    rank_path as rank_path,
)
from prism_lca.engine.report_tokens import (
    render_value as render_value,
)
from prism_lca.engine.report_tokens import (
    share_text as share_text,
)
from prism_lca.engine.report_tokens import (
    subject_paths as subject_paths,
)
from prism_lca.engine.report_tokens import (
    unfence as unfence,
)
from prism_lca.engine.report_tokens import (
    unit_of as unit_of,
)


def _inventory(inventory: dict | None, lang: str = "en") -> dict[str, Any]:
    """The inventory, with each flow's share as a percentage.

    Prose wants "55.2 %", and a placeholder can only print what exists — without this the writer had to
    calculate the percentage itself, which is exactly what it must not do.
    """
    inventory = dict(inventory or {})
    flows = []
    for f in inventory.get("flows") or []:
        entry = dict(f)
        # The flow's `unit` is its physical unit (kg, MJ); `impact` is characterised in the method's
        # unit. Stated per value so `unit_of` cannot attribute the wrong one.
        if inventory.get("unit"):
            entry["impact_unit"] = inventory["unit"]
        entry["share_percent"] = round(float(entry.get("share") or 0.0) * 100.0, 1)
        # A placeholder that means "a share" has to print one. The numeric key alone produced sentences
        # like "contributes 55.1641 of the score" — no percent sign, four decimals nobody asked for —
        # because a writer cannot append a unit to a number it never sees.
        entry["share_text"] = share_text(entry["share_percent"], lang)
        entry["compartment"] = " / ".join(str(c) for c in (entry.get("categories") or []))
        flows.append(entry)
    if flows:
        inventory["flows"] = flows
        inventory["top"] = flows[0]
    return inventory


def _hotspot_view(hotspots: list[dict] | None, lang: str = "en") -> list[dict[str, Any]]:
    """A hotspot list with its shares rounded and printable — the flat one and every per-indicator one."""
    return [
        {
            **h,
            "share_percent": round(float(h.get("share_percent", 0.0)), 1),
            "share_text": share_text(float(h.get("share_percent", 0.0)), lang),
        }
        for h in (hotspots or [])
    ]


#: How many groups a breakdown prints before the rest are folded into one row. A split by location on
#: an ecoinvent-backed model has a hundred groups, most under one percent; the table ran to thirteen
#: pages in an early short report and the grouped chart was a hundred slivers. Fifteen
#: keeps everything a reader can tell apart; the rest is one honest row with its summed impact.
MAX_GROUPS = 15
#: The folded row's key. Like `RESIDUAL_KEY`, ours and never a tag value.
OTHER_KEY = "(other)"


def _fold_groups(groups: list[dict[str, Any]], lang: str, keep: set[str] | None = None) -> list[dict[str, Any]]:
    """The groups to print: the largest `MAX_GROUPS` (or exactly `keep`), the rest summed into one row.

    `keep` is the lead view's kept keys: a variant's rows are folded to the SAME members, so the matrix
    and the grouped chart line up row for row, and "(other)" means the same set in every column.
    """
    if keep is None:
        if len(groups) <= MAX_GROUPS:
            return groups
        kept, rest = groups[:MAX_GROUPS], groups[MAX_GROUPS:]
    else:
        kept = [g for g in groups if g["key"] in keep]
        rest = [g for g in groups if g["key"] not in keep]
        if not rest:
            return kept
    impact = sum(float(g["impact"]) for g in rest)
    share = sum(float(g.get("share") or 0.0) for g in rest)
    kept.append(
        {
            "key": OTHER_KEY,
            "label": t("contribution.other", lang, count=len(rest)),
            "impact": impact,
            "share": share,
            "share_percent": round(share * 100.0, 1),
            "share_text": share_text(share * 100.0, lang),
            "folded": len(rest),
        }
    )
    return kept


def kept_keys(view: dict[str, Any]) -> set[str] | None:
    """The member keys a folded view kept — or None when nothing was folded (then variants fold nothing)."""
    groups = view.get("groups") or []
    if not any(g.get("key") == OTHER_KEY for g in groups):
        return None
    return {str(g["key"]) for g in groups if g.get("key") != OTHER_KEY}


def _contribution_view(contribution: dict | None, lang: str = "en") -> dict[str, Any]:
    """One breakdown, as a document needs it: sorted, dust removed, every share ready to print.

    Its own function because a report now carries one of these *per indicator* as well as the lead
    one flat at the top. Building it twice was the alternative, and the two copies would have drifted
    the first time a field was added — which is exactly how `share_text` came to exist on the hotspots
    and not on the groups.
    """
    groups: list[dict[str, Any]] = []
    dropped = 0
    if contribution and "aggregation" in contribution:
        agg = contribution["aggregation"]
        groups = [
            {
                "key": g.get("key") or "",
                # What the tables and the chart axes print. A copy of the key until the translation step
                # rewrites it, and separate from the key for the reason `subjects` keeps `variant` beside
                # `label`: the key is this row's binding identity (RANKED_LISTS), and a binding that moves
                # with the report language is no binding. A tag value is the modeller's own wording —
                # study text like a scenario name — so an English report of a German model printed its
                # whole contribution chapter in German (V240).
                "label": g.get("key") or "",
                "impact": float(g.get("impact") or 0.0),
                "share": float(g.get("share") or 0.0),
                "share_percent": round(float(g.get("share") or 0.0) * 100.0, 1),
                # Same key on groups, hotspots and inventory flows. It was missing here, and a writer
                # that had learnt `share_text` from the hotspots reasonably assumed a group had one too —
                # the chapter was then refused for a placeholder that did not exist.
                "share_text": share_text(float(g.get("share") or 0.0) * 100.0, lang),
            }
            for g in agg.get("groups", [])
        ]
        groups.sort(key=lambda g: abs(g["impact"]), reverse=True)
        # Numerical dust out *here*, once. It used to be filtered while building the table, so the chart —
        # drawn in the renderer from this snapshot — still carried a -2.8e-10 bar labelled "-0.0000" and
        # had one row more than the table beside it.
        keep = [g for g in groups if g["impact"] == 0.0 or abs(g["share"]) >= 5e-4]
        dropped = len(groups) - len(keep)
        groups = _fold_groups(keep, lang)
    dimension = str((contribution or {}).get("aggregation", {}).get("dimension", "") or "")
    meta = (contribution or {}).get("meta") or {}
    total = float(meta.get("total") or 0.0)
    # The foreground's OWN emissions where the engine reports them (lca.contribution, V411); the tree's
    # `direct` — the remainder its cutoff left unexplained — only for a snapshot made before that key
    # existed. The sentence this feeds says "directly in the foreground processes", and for a foreground
    # that links background datasets and emits nothing itself the honest figure is zero.
    direct = float(meta.get("foreground_direct", meta.get("direct")) or 0.0)
    # Percentages that print: a background-only foreground gives -3e-14 % "direct", which read as
    # "−0.0 %" in the first short report. Below a twentieth of a percent it is zero.
    direct_pct = direct / total * 100.0 if total else 0.0
    if abs(direct_pct) < 0.05:
        direct_pct = 0.0
    upstream_pct = (100.0 - direct_pct) if total else 0.0
    return {
        "dimension": dimension,
        # Where the burden arises at the coarsest split: in the foreground processes themselves
        # (their own emissions) or in the background system behind them. Arithmetic the tree already
        # did; printed as one sentence under the breakdown.
        "total": total,
        "direct": direct,
        "upstream": float(meta.get("upstream") or (total - direct)),
        "direct_percent": round(direct_pct, 1) if total else None,
        "direct_text": share_text(direct_pct, lang) if total else "",
        "upstream_text": share_text(upstream_pct, lang) if total else "",
        # The heading and the figure captions print this one: the "tag:" marker is ours and has no
        # business in a heading, and the name behind it is the modeller's — translated like the values
        # under it (V240). `dimension` keeps the raw marker, because that is what the aggregation was
        # asked for and what an author's placeholder may already quote.
        "dimension_label": dimension_name(dimension.removeprefix("tag:"), lang),
        "unit": (contribution or {}).get("meta", {}).get("unit", ""),
        "groups": groups,
        #: How many groups were below 0.05 % and left out — stated in the document, never silently.
        "dropped": dropped,
        "top": groups[0] if groups else None,
    }


def build_data(
    study: dict,
    lcia: dict,
    contribution: dict | None = None,
    *,
    parameters: list[dict] | None = None,
    scenarios: list[dict] | None = None,
    provenance: dict | None = None,
    subjects: list[dict] | None = None,
    health: dict | None = None,
    inventory: dict | None = None,
    hotspots: list[dict] | None = None,
    method_references: list[dict] | None = None,
    model_context: dict | None = None,
    subject_contributions: list[dict] | None = None,
    #: One breakdown per indicator, lead first — `contribution` above is `contributions[0]`'s. Each entry
    #: carries the indicator's label, its own groups, and the same for every variant of the report.
    contributions: list[dict] | None = None,
    #: Every dimension's views (same shape as `contributions`) keyed by dimension, and the dimensions in
    #: document order. `contributions` is the first dimension's; a chapter with its own reads its entry.
    contributions_by_dimension: dict[str, list[dict]] | None = None,
    breakdown_dimensions: list[str] | None = None,
    #: The system-model figure's data — `report_graph.system_model`. None when no chapter asked for it.
    system_model: dict | None = None,
    dropped_subjects: list[str] | None = None,
    #: What the build researched: ``[{question, findings: [{text, sources}], asked}]`` from the
    #: research log. Prose material for the writers and rows for the bibliography — not placeholders.
    web_research: list[dict] | None = None,
    #: The latest internal review's outcome (dates, staleness, the builder's per-finding verdicts) —
    #: `ReviewLogStore.for_report`. None when no review was ever run.
    review: dict | None = None,
    lang: str = "en",
) -> dict[str, Any]:
    """The report's data snapshot — what gets written to ``data.json`` in an export bundle.

    Flat and boring on purpose: every value a placeholder can name has to be findable by a person
    reading this dict, because that is what makes the placeholders writable at all. `lang` formats the
    ready-made `…_text` values — they print verbatim, so an f-string with "." put English decimal
    marks into German prose right next to a correctly localised derivation.
    """
    activity = lcia.get("activity", {}) or {}
    results = [
        {
            "method": r.get("method", []),
            "method_label": " / ".join(r.get("method", [])),
            "unit": r.get("unit") or "",
            "score": float(r.get("score") or 0.0),
        }
        for r in lcia.get("results", [])
    ]

    view = _contribution_view(contribution, lang)

    data: dict[str, Any] = {
        "study": dict(study or {}),
        "activity": {
            "name": activity.get("name") or "",
            "database": activity.get("database") or "",
            "code": activity.get("code") or "",
        },
        "amount": float(lcia.get("amount", 1.0)),
        "results": results,
        "contribution": view,
        "parameters": parameters or [],
        "scenarios": scenarios or [],
        "provenance": provenance or {},
        # The structural linter's verdict. Lives in the snapshot rather than being fetched by the
        # checks chapter itself, so the completeness table and a prose chapter that comments on it are
        # talking about the same run — and so the export bundle carries the evidence with it.
        "health": health or {},
        # The elementary flows behind the leading indicator — the annex material a reviewer asks for
        # first. Characterised, not raw: the raw inventory is thousands of rows and says far less about
        # where the result comes from.
        "inventory": _inventory(inventory, lang),
        # Where the burden actually arises, process by process. Aggregated phases answer "which stage",
        # the hotspots answer "which dataset inside it" — and that is the difference between a chapter
        # that says something and one that paraphrases the table above it.
        "method_references": method_references or [],
        # The model's own documentation and the background datasets it uses directly. Not a calculation
        # result, which is why nothing produced it before: the descriptions come from whoever built the
        # model, and they are what lets a chapter explain a process instead of naming it.
        "foreground": (model_context or {}).get("foreground") or [],
        "background_datasets": (model_context or {}).get("background") or [],
        "undocumented_processes": int((model_context or {}).get("undocumented") or 0),
        # The same breakdown per variant, for the grouped chart and for a matrix table: one bar per
        # variant within each phase answers "where does the difference come from", which a chart of the
        # baseline alone cannot.
        "contribution_subjects": _contribution_subjects(subject_contributions, lang, kept_keys(view)),
        # Per indicator: its own groups plus one set per variant. The lead indicator's are also carried
        # flat above (`contribution`, `contribution_subjects`) — that pair is what every stored chapter
        # and every placeholder path already names, and renaming it would break them for one shape.
        "contributions": [_indicator_view(c, lang) for c in (contributions or [])],
        "contributions_by_dimension": {
            dim: [_indicator_view(c, lang) for c in views]
            for dim, views in (contributions_by_dimension or {}).items()
        },
        "breakdown_dimensions": list(breakdown_dimensions or []),
        "system_model": dict(system_model or {}),
        # Variants the report asks for but the model can no longer supply (process or scenario deleted).
        # Named rather than dropped: a comparison missing a variant has to say so.
        "dropped_subjects": list(dropped_subjects or []),
        # Provenance from the build itself. Both are excluded from the placeholder paths (their
        # entries renumber whenever a question or finding is added), but the References chapter
        # prints the researched sources and the Limitations chapter states the review's outcome —
        # and the writers see both, so "where does this figure come from" has an answer in words.
        "web_research": list(web_research or []),
        "review": dict(review) if review else {},
        "hotspots": _hotspot_view(hotspots, lang),
    }
    # Comparative studies: every subject with its own results, so prose can name them
    # ({{subjects.1.results.0.score}}) while `results` stays the first subject's for the common case.
    data["subjects"] = [
        {
            "label": printed_label(s.get("label"), lang),
            "code": s.get("code") or "",
            "scenario": s.get("scenario") or "",
            # What identifies the variant (RANKED_LISTS), through the one function that builds this key
            # anywhere — `results.<i>.subjects_by_score` carries the same field with the same value, so
            # both lists mean one thing by "which variant". The pair above stays beside it: it is what
            # the writer's paths and `report_patch.STABLE_IDENTITY` read, and dropping it would unbind
            # the chapters this composite exists to leave alone.
            "variant": variant_key(s.get("code"), s.get("scenario")),
            "results": [
                {
                    "method": r.get("method", []),
                    "method_label": " / ".join(r.get("method", [])),
                    "unit": r.get("unit") or "",
                    "score": float(r.get("score") or 0.0),
                }
                for r in (s.get("lcia") or {}).get("results", [])
            ],
        }
        for s in (subjects or [])
    ]
    # Convenience aliases the prose will reach for constantly.
    if results:
        # A copy, not the same object: the rows below gain a nested size-ordered list, and this alias is
        # not a registered path — a citation through it would index a ranking with no pin behind it,
        # which is V182 exactly. The alias stays what its name says, the first result's own fields.
        data["first_result"] = dict(results[0])
    # …and, on each indicator's own row, the variants ordered by *its* score. This is the list a
    # sentence claiming "the highest variant" declares against (V219), and it hangs off `results.<i>`
    # for three reasons: the row *is* the indicator, so the path says which score does the ordering and
    # no second "leading indicator" rule has to be invented (index 0 is the lead one, like everywhere
    # else); the row is already pinned by `method_label`, so reordering the report's methods cannot
    # slide another indicator's ranking under a sentence (V186); and `results` exists in every report,
    # while the per-indicator breakdowns under `contributions` only exist once a breakdown dimension is
    # set — which has nothing to do with whether the variants can be ranked.
    #
    # Absent below two variants rather than present and short: "the highest of one" is not a rank, and
    # leaving the key out makes the declaration an unknown path, which is the honest refusal.
    for row in results:
        ranked = subjects_by_score(data["subjects"], row["method_label"])
        if len(ranked) > 1:
            row["subjects_by_score"] = ranked
    # The three ISO 14044 §4.5 checks as numbers, so a comment on that chapter can *quote* them instead
    # of typing them out — and so the table and the sentence under it cannot disagree.
    data["checks"] = report_checks.checks_summary(data, lang=lang)
    # Where the ranking turns over between indicators. Computed, not asked of a model: this is the one
    # thing a comparison across categories can honestly say, and it is arithmetic.
    data["trade_offs"] = trade_offs(data)
    # After every view is built, because the decision needs the baseline and all its variants at once.
    for view, subjects in [
        (data.get("contribution") or {}, data.get("contribution_subjects") or []),
        *((c, c.get("subjects") or []) for c in (data.get("contributions") or [])),
        *(
            (c, c.get("subjects") or [])
            for views in (data.get("contributions_by_dimension") or {}).values()
            for c in views
        ),
    ]:
        _drop_empty_residual(view, subjects)
    return data


#: The residual bucket of a tag breakdown. A real phase that comes out at zero is a statement — a
#: coating's use phase carries no climate impact, and the reader should see that — but the residual
#: is not: "(untagged) = 0" says only that everything was tagged. Printed anyway it cost a row in the
#: table, an empty group on the chart axis and one of six legend colours, and it was the row that
#: printed "—" for three variants and "0" for the fourth (V312).
RESIDUAL_KEY = "(untagged)"


def _indicator_view(c: dict, lang: str) -> dict[str, Any]:
    """One indicator's breakdown as the document needs it — its groups, its variants, its datasets.

    Per indicator: its own groups plus one set per variant. The lead indicator's are also carried flat
    (`contribution`, `contribution_subjects`) — that pair is what every stored chapter and every
    placeholder path already names, and renaming it would break them for one shape. `hotspots` is this
    indicator's own dataset list: the flat `hotspots` is the lead's and nothing else, and a chapter told
    to compare three indicators had evidence for one (V161).
    """
    view = _contribution_view((c.get("contribution") or {}), lang)
    return {
        "index": int(c.get("index") or 0),
        "method_label": str(c.get("method_label") or ""),
        **view,
        "subjects": _contribution_subjects(c.get("subjects"), lang, kept_keys(view)),
        "hotspots": _hotspot_view(c.get("hotspots"), lang),
    }


def _drop_empty_residual(view: dict[str, Any], subjects: list[dict[str, Any]]) -> None:
    """Take the residual group out of a breakdown where it contributes nothing anywhere.

    Anywhere means the baseline AND every variant: a residual that is zero in three of four is still
    a fact about the fourth. Absent counts as nothing, so the vacuous case falls out on its own.
    """

    def empty(groups: list[dict[str, Any]]) -> bool:
        return all(float(g.get("impact") or 0.0) == 0.0 for g in groups if g.get("key") == RESIDUAL_KEY)

    if not empty(view.get("groups") or []) or not all(empty(s.get("groups") or []) for s in subjects):
        return
    view["groups"] = [g for g in (view.get("groups") or []) if g.get("key") != RESIDUAL_KEY]
    if (view.get("top") or {}).get("key") == RESIDUAL_KEY:
        view["top"] = view["groups"][0] if view["groups"] else None
    for subject in subjects:
        subject["groups"] = [g for g in (subject.get("groups") or []) if g.get("key") != RESIDUAL_KEY]


def _contribution_subjects(
    entries: list[dict] | None, lang: str = "en", keep: set[str] | None = None
) -> list[dict[str, Any]]:
    """Per-variant contribution groups, filtered by the same dust rule as the single breakdown — and
    folded to the same members when the lead view was folded (`keep`), so the matrix lines up."""
    out: list[dict[str, Any]] = []
    for entry in entries or []:
        agg = (entry.get("contribution") or {}).get("aggregation") or {}
        groups = [
            {
                "key": g.get("key") or "",
                #: Printed; see `_contribution_view`. The matrix matches rows across variants by `key`.
                "label": g.get("key") or "",
                "impact": float(g.get("impact") or 0.0),
                # The fraction itself, because `_fold_groups` sums it for the "other" row: without it
                # every folded variant reported its rest at 0 % beside a non-zero impact.
                "share": float(g.get("share") or 0.0),
                "share_percent": round(float(g.get("share") or 0.0) * 100.0, 1),
                # The per-subject groups were missed when `share_text` was given to the others, so a
                # comparison chapter reaching for the form that carries its percent sign found it on
                # `contribution.groups` and not on `subjects.0.contribution.groups`.
                "share_text": share_text(float(g.get("share") or 0.0) * 100.0, lang),
            }
            for g in agg.get("groups", [])
            if float(g.get("impact") or 0.0) == 0.0 or abs(float(g.get("share") or 0.0)) >= 5e-4
        ]
        groups.sort(key=lambda g: abs(g["impact"]), reverse=True)
        if keep is not None:
            groups = _fold_groups(groups, lang, keep)
        out.append(
            {
                # Through the same function `subjects` uses: these rows head the contribution matrix
                # and the grouped chart while `subjects` heads the results table, and one German
                # report called the same variant "Basisfall" in the one and "Baseline" in the other.
                "label": printed_label(entry.get("label"), lang),
                # What identifies the variant here, the same key and the same builder `subjects` and
                # `results.<i>.subjects_by_score` use — see RANKED_LISTS (V223). The label stays beside
                # it because it is what the matrix table and the grouped chart print. It is no longer
                # what a pin can rely on: the name now follows the report language and is qualified
                # when two variants would read the same, so a binding written on the label before the
                # key existed can stop matching — and then the chapter says it needs writing again,
                # instead of answering for the sister variant it used to resolve to in silence.
                # The one producer of these rows (`api/v1/report.py`) always
                # supplies the code, so the key is never empty; a caller that supplied neither half
                # would get *no* pin rather than an ambiguous one, which is the honest of the two.
                "variant": variant_key(entry.get("code"), entry.get("scenario")),
                "groups": groups,
            }
        )
    return out


def printed_label(label: Any, lang: str = "en") -> str:
    """A variant's name as the document prints it.

    "Baseline" is our own default label — the frontend writes it when a comparison is set up — so it
    is a fixed string like any other and follows the report language; it stood in English in every
    chart legend and table of a German report. A label the author typed stays verbatim. Identity is
    the `variant` key, never this, so the wording is free to localise (RANKED_LISTS).

    One function rather than the rule spelled out per list: the variants appear under three names in
    the snapshot (`subjects`, `results.<i>.subjects_by_score`, `contribution_subjects` and the
    per-indicator copies of the last), and a report that translated the word in one of them and not
    in the next put two names for one variant on facing pages.
    """
    text = str(label or "")
    return t("subject.baseline", lang) if text == "Baseline" else text


def variant_key(code: Any, scenario: Any) -> str:
    """The report's own key for one variant of the comparison: a process under a parameter state.

    The pair is the identity; this is the pair written as one value, so that the half that is
    legitimately absent — the baseline runs no scenario — cannot fall out of the identity and leave a
    pin that matches every other variant of the same process (see RANKED_LISTS). Formatted the way a
    variant's label is composed, so a message quoting the key stays readable.
    """
    code, scenario = str(code or "").strip(), str(scenario or "").strip()
    return f"{code} · {scenario}" if scenario else code


def subjects_by_score(subjects: list[dict] | None, method_label: str) -> list[dict[str, Any]]:
    """The report's variants ordered by one indicator's score, highest first.

    A *derived* view, and the only thing derived about it is the order: the members are the same
    variants `subjects` holds, identified by the same pair — process and parameter state, written as
    one key so neither half can fall out of it. That is what makes "the highest variant" declarable — the claim is about a member, the member is pinned, and a variant that
    loses the top spot raises the same `ranks` verdict a contribution group does (V219).

    Ordered by the **signed** score, not by magnitude, unlike the contribution groups: a group's share
    measures how much it contributes and a credit contributes in the other direction, but a variant's
    score is the number the comparison table prints, and a variant whose net result is negative is
    lower than one at zero rather than larger than it. Ties keep report order — the sort is stable, and
    where two variants score the same "the highest" is a claim nobody can settle for the author.
    """
    rows: list[dict[str, Any]] = []
    for subject in subjects or []:
        for result in subject.get("results") or []:
            if (result.get("method_label") or "") != method_label:
                continue
            rows.append(
                {
                    # What identifies the variant — see RANKED_LISTS.
                    "variant": variant_key(subject.get("code"), subject.get("scenario")),
                    # The label as `subjects` carries it, so the two lists name a variant the same way
                    # and `report_translations` can rewrite both (it is the printed name, not the
                    # identity). Falls back to the code for the same reason `trade_offs` always did:
                    # a variant with no label still has to be nameable.
                    "label": subject.get("label") or subject.get("code") or "",
                    # The score that put it here, so a chapter can name the highest variant *and* its
                    # figure without counting the report-ordered list to find out which index it is —
                    # the count that turned a U-value into an element mass (V182). Four fields and no
                    # more: every one of them costs a line of the writer's path list, and the variant's
                    # own results are already reachable under `subjects.<j>.results`.
                    "score": float(result.get("score") or 0.0),
                    "unit": result.get("unit") or "",
                }
            )
            break
    rows.sort(key=lambda row: row["score"], reverse=True)
    return rows


def trade_offs(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Indicators whose highest-scoring subject differs from the first indicator's.

    A comparison over several categories has exactly one interesting structural fact: whether the
    variant that leads on climate change also leads everywhere else. If it does not, saying so is
    mandatory in practice and impossible to get wrong — the argmax is arithmetic. Empty list means
    "one variant is highest throughout", which is itself worth telling a writer.
    """
    subjects = [s for s in data.get("subjects") or [] if s.get("results")]
    if len(subjects) < 2:
        return []
    order: list[str] = []
    for s in subjects:
        for r in s["results"]:
            label = r.get("method_label") or ""
            if label and label not in order:
                order.append(label)

    # Through the same ordering the snapshot publishes as `results.<i>.subjects_by_score`, because the
    # two answer one question — which variant is highest for this indicator — and two implementations
    # of it would eventually let a chapter's declaration and the trade-off table name different
    # variants in the same report.
    leaders: list[dict[str, Any]] = []
    for label in order:
        ranked = subjects_by_score(subjects, label)
        if len(ranked) < 2:
            continue
        leaders.append(
            {"method_label": label, "highest": ranked[0]["label"], "score": ranked[0]["score"]}
        )
    if not leaders:
        return []
    first = leaders[0]["highest"]
    return [item for item in leaders if item["highest"] != first]
