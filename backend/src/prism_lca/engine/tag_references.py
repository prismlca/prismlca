"""What else in a model names its tag groups and tag values, and how that follows a merge.

A tag group is known by its name alone, and the model's saved choices keep that name: the Results split
(`tag:<group>`), the Detailed results grouping (the bare name), the short report's breakdowns and the colouring of
its system figure, and every stored report — its own breakdown, a contribution chapter's own, the system figure's
colouring, and the record each written chapter keeps of the breakdown it was written for. A merge used to delete
the name and leave all of these behind on a group the model no longer had: the bars became one "untagged"
block, and so did a written report's breakdown.

**A merged group** is the same dimension under the surviving name, so whatever named it follows, as the stores
follow a renamed model. The chapters keep their text and their pins: the values are all still there, because the
merge adds the source's values to the target. Their records follow as well, so the staleness check judges the
figures a chapter cites rather than the rename; a share that moved because the target already held other
processes is reported through the numbers. One exception: a report that splits by both groups keeps its
breakdowns, because making two of them one would move every later breakdown's table labels (`_collapses`).

**A merged value** is not followed. A chapter pinned a breakdown member by its value, and re-pointing the pin at
the target would make a sentence citing both print one figure twice without a word. The pins stay; the reports
whose chapters cite the value are named before and after the merge, and those chapters show the gap the
staleness check reports.

Every change is recorded as the value before and after, and undo puts back only what still holds the value it
wrote — a breakdown chosen again in between is not taken from the user.
"""
from __future__ import annotations

from typing import Any

from prism_lca.engine._store import now_iso
from prism_lca.engine.report_staleness import caption_bindings, captions_text, cited_binding_keys
from prism_lca.engine.report_store import ReportStore
from prism_lca.engine.view_store import ViewStore

#: The fields of a model's view that name a tag group: (section, field, form, how a sentence calls it).
#: Forms: "prefixed" holds `tag:<group>`, "bare" the name alone, "list" a list of prefixed names.
VIEW_FIELDS: tuple[tuple[str, str, str, str], ...] = (
    ("results", "stackBy", "prefixed", "the Results split"),
    ("detailed", "groupBy", "bare", "the Detailed results grouping"),
    ("short_report", "breakdowns", "list", "the short report's breakdowns"),
    ("short_report", "colour_by", "prefixed", "the short report's system figure colours"),
)

#: Where a stored report names a tag group: on the report, on a chapter, and in a chapter's two records of
#: the selection it was written against (`report_staleness.selection_of`). Paths into the dict.
REPORT_PATHS: tuple[tuple[str, ...], ...] = (("aggregate_by",),)
SECTION_PATHS: tuple[tuple[str, ...], ...] = (
    ("aggregate_by",),
    ("colour_by",),
    ("based_on", "selection", "aggregate_by"),
    ("caption_based_on", "selection", "aggregate_by"),
)
#: The one that names a group for colour only: followed even in a report that keeps its breakdowns (`_collapses`).
COLOUR_PATHS: tuple[tuple[str, ...], ...] = (("colour_by",),)


def _renamed(value: Any, form: str, old: str, new: str) -> Any:
    """`value` with the group `old` called `new`, in the field's form; `value` itself when it does not name it."""
    if form == "bare":
        return new if value == old else value
    if form == "list":
        if not isinstance(value, list) or f"tag:{old}" not in value:
            return value
        out: list[Any] = []
        for item in value:
            item = f"tag:{new}" if item == f"tag:{old}" else item
            if item not in out:  # a breakdown by both groups is one breakdown now
                out.append(item)
        return out
    return f"tag:{new}" if value == f"tag:{old}" else value


def _names_group(value: Any, form: str, group: str) -> bool:
    """Whether a field in this form names the group."""
    if form == "list":
        return isinstance(value, list) and f"tag:{group}" in value
    return value == (group if form == "bare" else f"tag:{group}")


def _holder(obj: Any, path: tuple[str, ...] | list[str]) -> dict | None:
    """The dict that holds the last key of `path`, or None when the way there is missing."""
    for key in path[:-1]:
        obj = obj.get(key) if isinstance(obj, dict) else None
    return obj if isinstance(obj, dict) else None


def _follow(obj: Any, path: tuple[str, ...], form: str, old: str, new: str) -> dict | None:
    """Rename the group in one field; the edit as before/after, or None when the field does not name it."""
    holder = _holder(obj, path)
    if holder is None or path[-1] not in holder:
        return None
    before = holder[path[-1]]
    after = _renamed(before, form, old, new)
    if after == before:
        return None
    holder[path[-1]] = after
    return {"path": list(path), "before": before, "after": after}


def _restore(obj: Any, edit: dict) -> bool:
    """Undo one edit where the field still holds what it wrote."""
    holder = _holder(obj, edit["path"])
    key = edit["path"][-1]
    if holder is None or holder.get(key) != edit["after"]:
        return False
    holder[key] = edit["before"]
    return True


def _section(report: dict, section_id: str) -> dict | None:
    return next((s for s in report.get("sections") or [] if s.get("id") == section_id), None)


# ---- following a merged group ------------------------------------------------------------------------------


def follow_group(database: str, old: str, new: str) -> list[dict]:
    """Carry every saved choice of the model that names group `old` over to `new`. The edits made, for `unfollow`.

    The reports first: theirs is the store that refuses to be read when its file is damaged, and then nothing
    has moved yet. A view that cannot be saved afterwards takes the reports' edits back with it.
    """
    edits: list[dict] = []

    def reports(stored: list[dict]) -> bool:
        changed = False
        for report in stored:
            kept = _collapses(report, old, new)
            mine: list[dict] = []
            for path in () if kept else REPORT_PATHS:
                if (edit := _follow(report, path, "prefixed", old, new)) is not None:
                    mine.append({"store": "report", "report": report.get("id"), **edit})
            for section in report.get("sections") or []:
                for path in COLOUR_PATHS if kept else SECTION_PATHS:
                    if (edit := _follow(section, path, "prefixed", old, new)) is not None:
                        mine.append(
                            {"store": "report", "report": report.get("id"), "section": section.get("id"), **edit}
                        )
            if kept:
                edits.append({"store": "report-kept", "report": report.get("id")})
            if mine:
                _stamp(report)
                edits.extend(mine)
                changed = True
        return changed

    def views(entry: dict) -> bool:
        mine = [
            {"store": "view", **edit}
            for section, field, form, _label in VIEW_FIELDS
            if (edit := _follow(entry, (section, field), form, old, new)) is not None
        ]
        edits.extend(mine)
        return bool(mine)

    ReportStore().edit_reports(database, reports)
    try:
        ViewStore().edit(database, views)
    except Exception:
        unfollow(database, edits)
        raise
    return edits


def unfollow(database: str, edits: list[dict]) -> None:
    """Take `follow_group`'s edits back, each only where its field still holds the value it wrote.

    The reports first, for the reason `follow_group` gives: an undo that cannot read them fails before the view
    is touched, and the merge stays whole.
    """
    view_edits = [e for e in edits if e.get("store") == "view"]
    report_edits = [e for e in edits if e.get("store") == "report"]
    if report_edits:

        def reports(stored: list[dict]) -> bool:
            by_id = {r.get("id"): r for r in stored}
            touched: set[str] = set()
            for edit in report_edits:
                report = by_id.get(edit["report"])
                target = report if report is None or "section" not in edit else _section(report, edit["section"])
                if target is not None and _restore(target, edit):
                    touched.add(edit["report"])
            for report_id in touched:
                _stamp(by_id[report_id])
            return bool(touched)

        ReportStore().edit_reports(database, reports)
    if view_edits:
        ViewStore().edit(database, lambda entry: any([_restore(entry, e) for e in view_edits]))


def _collapses(report: dict, old: str, new: str) -> bool:
    """Whether the report splits by both groups — its own breakdown and its contribution chapters' together.

    Such a report keeps its breakdowns. Following the old group would make two of its breakdowns one: the list of
    breakdown dimensions loses an entry, every later chapter's tables and figures move up a place, and a written
    `t-contribution-d2` then names another breakdown's table without anything reporting it. Left alone, the
    chapter split by the old group shows its gap, which the staleness check does report.
    """
    dims = [report.get("aggregate_by")] + [
        s.get("aggregate_by") for s in report.get("sections") or [] if s.get("kind") == "contribution"
    ]
    return f"tag:{old}" in dims and f"tag:{new}" in dims


def _stamp(report: dict) -> None:
    """A changed report is an edited report: a cached preview keyed to its `updated` must not be reused."""
    report["updated"] = now_iso()


def followed(database: str, edits: list[dict]) -> dict:
    """What a merge carried along, as a result names it: the view fields and the reports by name — and the
    reports that split by both groups and were left as they were, with the sentence that says so."""
    labels = {(s, f): label for s, f, _form, label in VIEW_FIELDS}
    views = list(
        dict.fromkeys(labels[tuple(e["path"])] for e in edits if e.get("store") == "view" and tuple(e["path"]) in labels)
    )
    kept_ids = list(dict.fromkeys(e["report"] for e in edits if e.get("store") == "report-kept"))
    report_ids = [r for r in dict.fromkeys(e["report"] for e in edits if e.get("store") == "report") if r not in kept_ids]
    kept = _report_names(database, kept_ids)
    return {
        "views": views, "reports": _report_names(database, report_ids),
        **({"reports_kept": kept, "note": kept_note(kept)} if kept else {}),
    }


def kept_note(kept: list[dict]) -> str:
    """One sentence on the reports a group merge leaves as they are (`_collapses`)."""
    named = ", ".join(f"“{r.get('name') or r.get('id')}”" for r in kept)
    if len(kept) == 1:
        return f"Report {named} already splits by both groups and keeps its breakdowns; change them in the report."
    return f"Reports {named} already split by both groups and keep their breakdowns; change them in the reports."


# ---- what names a group or cites a value, before a merge ---------------------------------------------------


def group_uses(database: str, group: str, into: str | None = None) -> dict:
    """The saved choices of the model that name `group` — what a merge of it into `into` would carry along, and
    the reports that split by both and would keep their breakdowns."""
    entry = ViewStore().get(database)
    views = [
        label
        for section, field, form, label in VIEW_FIELDS
        if (holder := _holder(entry, (section, field))) is not None and _names_group(holder.get(field), form, group)
    ]
    reports = [r for r in ReportStore().snapshot_database(database) or [] if _breaks_down_by(r, group, chapters_too=True)]
    if into is not None:
        kept = [{"id": r.get("id"), "name": r.get("name") or ""} for r in reports if _collapses(r, group, into)]
        reports = [r for r in reports if not _collapses(r, group, into)]
    else:
        kept = []
    return {
        "views": views, "reports": [{"id": r.get("id"), "name": r.get("name") or ""} for r in reports],
        **({"reports_kept": kept, "note": kept_note(kept)} if kept else {}),
    }


def value_citations(database: str, group: str, value: str) -> list[dict]:
    """The model's reports whose written chapters cite `value` of `group` as a breakdown member, with how many
    chapters each — what a merge of the value would leave showing a gap.

    A report counts when it breaks down by the group (its own breakdown or a chapter's) and a chapter's text or
    figure caption cites a breakdown row pinned to the value. A pin the text no longer cites does not count: it
    is nothing the chapter says.
    """
    out: list[dict] = []
    for report in ReportStore().snapshot_database(database) or []:
        if not _breaks_down_by(report, group, chapters_too=False):
            continue
        chapters = sum(1 for section in report.get("sections") or [] if _cites(section, value))
        if chapters:
            out.append({"id": report.get("id"), "name": report.get("name") or "", "chapters": chapters})
    return out


def citations_note(value: str, citing: list[dict]) -> str:
    """One sentence for a value merge's result: which reports now show a gap where they cited the value."""
    def one(r: dict) -> str:
        n = int(r.get("chapters") or 0)
        return f"“{r.get('name') or r.get('id')}” ({n} chapter{'s' if n != 1 else ''})"

    named = ", ".join(one(r) for r in citing)
    return (
        f"Report {named} cites “{value}”" if len(citing) == 1 else f"Reports {named} cite “{value}”"
    ) + "; those figures show as missing until the chapters are updated."


def _breaks_down_by(report: dict, group: str, *, chapters_too: bool) -> bool:
    """Whether the report splits by the group — and, with `chapters_too`, also colours a figure by it."""
    paths = SECTION_PATHS[:2] if chapters_too else SECTION_PATHS[:1]
    if report.get("aggregate_by") == f"tag:{group}":
        return True
    return any(
        section.get(path[0]) == f"tag:{group}" for section in report.get("sections") or [] for path in paths
    )


def _cites(section: dict, value: str) -> bool:
    """Whether the chapter's text or captions cite a breakdown row pinned to `value`."""
    for pins, text in (
        (section.get("bindings") or {}, str(section.get("text") or "")),
        (caption_bindings(section), captions_text(section)),
    ):
        cited = cited_binding_keys(text)
        for key, identity in pins.items():
            head = key.rpartition(".")[0]
            if key in cited and head.rpartition(".")[2] == "groups" and (identity or {}).get("key") == value:
                return True
    return False


def _report_names(database: str, report_ids: list[str]) -> list[dict]:
    stored = {r.get("id"): r for r in ReportStore().snapshot_database(database) or []}
    return [{"id": rid, "name": (stored.get(rid) or {}).get("name") or ""} for rid in report_ids]
