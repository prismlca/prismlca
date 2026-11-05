"""The reports of a model in a ``.prism`` bundle: which fields of a report travel, and how an imported
report lands in the receiver's store.

A report is its own subject inside a bundle — fields the store accepts, chapters that go their own way,
pictures that pass the checks an upload passes — so it lives here, and ``bundle.py`` keeps the format, the
sections and the reading order.
"""
from __future__ import annotations

from typing import Any

from prism_lca.errors import PrismError

#: Exactly the report fields `ReportStore.update` accepts. Deliberately a list here rather than
#: "everything except a few": `list_reports` adds derived fields (`section_count`), and passing those
#: back made the import fail with "Unknown report fields" — found by exporting a real model and
#: importing it again, which is why that round trip is now a test.
_REPORT_FIELDS = (
    "name",
    "subtitle",
    "lang",
    "template",
    "palette",
    "amount",
    "aggregate_by",
    "subjects",
    "methods",
    "options",
    "abbreviations",
    "palette_colors",
    "cover_image",
    "client_logo",
    # The stored translation table: without it an English report of a German model came back in
    # English with its model texts back in German. `update` validates the shape.
    "translations",
    # The author's answers to the writer's questions — what every later chapter is briefed with.
    "answers",
)


def write_reports(database: str) -> dict:
    """The full reports, chapters included — `list_reports` summarises and drops `sections`."""
    from prism_lca.engine.report_store import ReportStore

    store = ReportStore()
    out = []
    for summary in store.list_reports(database):
        full = store.get(database, summary["id"])
        out.append({k: v for k, v in full.items() if k in _REPORT_FIELDS or k == "sections"})
    return {"reports": out}


def read_reports(database: str, data: Any, scenario_ids: dict[str, str]) -> None:
    """Reports, minus anything the current store no longer accepts.

    A report written months ago can carry option keys that have since been retired (`comparative`,
    `for_publication`, `state_absent` were in a real project) — and `check_options` refuses those. A
    stale switch on one report is no reason to refuse a whole model, so unknown options are dropped
    here rather than fatal. Found by importing a real export; the test that pins it is in test_bundle.
    """
    from prism_lca.engine.report_store import _OPTION_CHECKS, ReportStore

    store = ReportStore()
    for rep in data.get("reports") or []:
        created = store.create(database, name=rep.get("name") or "Report")
        patch = {k: v for k, v in rep.items() if k in _REPORT_FIELDS}
        if scenario_ids and isinstance(patch.get("subjects"), list):
            # …and where a scenario could not keep its id, the variant follows it.
            patch["subjects"] = [
                {**s, "scenario": scenario_ids.get(str(s.get("scenario")), s.get("scenario"))}
                if isinstance(s, dict) and s.get("scenario")
                else s
                for s in patch["subjects"]
            ]
        if isinstance(patch.get("options"), dict):
            patch["options"] = {k: v for k, v in patch["options"].items() if k in _OPTION_CHECKS}
        # Same rule for a template the receiver does not have: the bundle carries the template's
        # NAME, not its source, and `update` refuses a name it cannot find — which undid the whole
        # model import over a report's cover design. The report falls back to the default.
        if patch.get("template"):
            try:
                store.get_template(patch["template"])
            except PrismError:
                patch.pop("template")
        _check_images(patch)
        if patch:
            store.update(database, created["id"], patch)
        sections = rep.get("sections")
        if sections:
            # Chapters go through their own path — `update` says so and refuses them.
            store.replace_sections(database, created["id"], sections)


def _check_images(patch: dict) -> None:
    """Cover and logo pass the checks an upload passes; one that fails is left out, like a missing template."""
    from prism_lca.engine.report_pipeline import image_b64

    for key in ("cover_image", "client_logo"):
        value = patch.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            continue  # no picture stays no picture
        try:
            checked = image_b64(value) if isinstance(value, str) else None
        except PrismError:
            checked = None
        if checked is None:
            patch.pop(key)
        else:
            patch[key] = checked
