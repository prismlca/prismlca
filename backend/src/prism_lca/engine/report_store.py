"""Report definitions, per foreground model.

A report is a stored, versioned object — **not** a file tree and not a one-shot render. That is what
makes iterative work possible: numbers change, the document stays; a chapter is approved and frozen;
the next render picks up the current results without anyone rewriting prose.

Stored as one JSON file in the active project's ``prism_meta`` dir, mirroring how scenarios, chats,
tags and LCIA families are kept. Shape:

    {
      "<database>": [ <report>, … ],          # n reports per model: internal vs. client, de vs. en
      "_defaults": {"sections": [ <section> ]}  # project-wide starting set for NEW reports
    }

A report:  {id, name, created, updated, lang, template, palette, amount, subjects, methods,
            options, sections}
A section: {id, kind, title, order, locked, text, prompt_override, extra_instructions,
            source, model, generated_at, based_on}

`kind` decides who fills the section: the deterministic builders (goal_scope, lcia, contribution,
appendix, …) or a model (prose). Changing the project defaults deliberately does **not** touch
existing reports — a default change must not rewrite finished documents.
"""
from __future__ import annotations

import uuid
from typing import Any

from prism_lca.engine import report_claims
from prism_lca.engine._store import JsonFileStore, now_iso
from prism_lca.engine.report_i18n import chapter_name

# Reading order for the shipped chapter kinds, used to place an added chapter where it belongs
# instead of at the end — "Executive summary" appended after "Abbreviations" is a list nobody can
# hand over, and dragging ten rows to fix it is not a workflow. The sequence itself (and each
# position's reason) lives at the ChapterKind registry, whose declaration order IS this list.
from prism_lca.engine.report_kinds import KIND_ORDER  # noqa: F401

# The section-kind vocabulary lives in the ChapterKind registry — re-imported via report_model
# because the store validates against it and long-standing callers read it off this module.
from prism_lca.engine.report_model import DETERMINISTIC_KINDS, PROSE_KINDS
from prism_lca.errors import PrismError


def _check_db(database: str) -> str:
    """Refuse model names that would collide with the store's own meta keys.

    The file is flat — model names sit beside `_defaults`, `_templates` and `_identity`. A model named
    `_templates` would append a report list where every template reader expects a dict, breaking the
    template management of the whole project. Underscore names are reserved, and saying so beats
    debugging the wreckage."""
    if database.startswith("_"):
        raise PrismError(
            f"'{database}' is a reserved name in the report store — model names must not start with '_'.",
            code="report_database_reserved",
        )
    return database

#: Logo height on the cover, in millimetres. Proportional only — see set_identity.
#: How many inventory rows an appendix lists unless its author says otherwise, and the ceiling on that. 0 is
#: allowed and means every characterised flow — thousands on an ecoinvent-backed model, which is a legitimate
#: thing to want in an annex and a poor default. The ceiling exists so a typo cannot ask for 100 000 rows.
DEFAULT_INVENTORY_ROWS = 25
MAX_INVENTORY_ROWS = 5000

DEFAULT_LOGO_HEIGHT_MM = 9.6
MIN_LOGO_HEIGHT_MM = 5.0
MAX_LOGO_HEIGHT_MM = 25.0


#: The ISO 14044 starting structure. Deliberately short — the user reorders, renames and adds.
#:
#: Titles are left EMPTY on purpose: an empty title means "use the standard heading for this kind in
#: the report's language". Baking English titles in here made a German report carry English headings,
#: because a stored title always wins over the string table. A title is only stored once someone
#: actually renames a section.
#: The starting structure of a new report, in reading order.
#:
#: An LCA report has a shape that ISO 14044 §5 all but dictates — goal and scope, method, results,
#: contribution, interpretation, conclusions — and a document that starts without those chapters is a
#: document somebody has to remember to add them to. The previous default stopped after the contribution
#: analysis, so a cradle-to-grave study opened with no Methods chapter (nothing said which indicator
#: family it used), no interpretation checks, no limitations and no conclusions: four of the parts a
#: reviewer looks for first, absent unless the author knew to add each one.
#:
#: `summary` sits first and is written last — an executive summary is a summary of the finished document.
#: `limitations` joined the list later: it is still the switch for its own content (it states only
#: what is genuinely absent, so it stays quiet in a study that lacks nothing), but off by default meant a
#: chapter nobody added and therefore nobody wrote.
DEFAULT_SECTIONS: list[dict[str, Any]] = [
    # Reading order of the finished document: the executive summary opens it —
    # the renderer hoists it BEFORE the table of contents regardless of stored order, and the
    # chapter list pins it — then contents / figure list / table list (generated, not sections),
    # then the abbreviations as front matter: a reader meets the acronyms before the chapters that
    # use them. The glossary itself is rebuilt against the finished document either way.
    {"kind": "summary"},
    {"kind": "abbreviations"},
    # The background most published LCAs open with: the product, why it is studied, what published
    # work says about it. Its writer searches the literature unless the chapter's switch is off.
    {"kind": "introduction"},
    {"kind": "goal_scope"},
    # The system model as a figure — the flow diagram ISO 14044 §4.2.3.3 expects beside the system
    # boundaries. It is in the starting structure; reports created before keep their list.
    {"kind": "system_model"},
    # The inventory: what was modelled, and where each piece of it came from. ISO 14044 §4.3 puts it
    # between the scope and the results, and a report without it asks the reader to take the numbers
    # on trust.
    {"kind": "inventory"},
    {"kind": "methods"},
    {"kind": "lcia"},
    {"kind": "contribution"},
    {"kind": "interpretation_checks"},
    # The interpretation itself (a written chapter, headed "Interpretation" while untitled): what the
    # results and the checks mean, set against published studies when the literature search finds any.
    {"kind": "prose"},
    # Every study has limits, and a report that does not name them makes the reader find them. It was
    # left out of the starting structure on the grounds that adding the chapter is the switch for its
    # content — but a chapter nobody adds is a chapter nobody writes, and in practice this is a section
    # of its own next to the interpretation. Delete it if a study genuinely has nothing to declare.
    {"kind": "limitations"},
    {"kind": "conclusions"},
    {"kind": "appendix"},
    # A report is read by someone who did not build the model: it needs to say where its methods are
    # published and what its acronyms mean. Both were available as chapters and neither was in the
    # starting structure, so every report began without them — and a bibliography nobody adds is a
    # bibliography the reviewer asks for.
    {"kind": "references"},
]

def _canonical_index(sections: list[dict[str, Any]], kind: str) -> int:
    """Where a chapter of this kind belongs in the current list.

    Appending was the old behaviour and it produced documents whose executive summary sat after the
    abbreviations. Reordering by hand is possible — the list is drag-and-drop — but a default that has to
    be corrected every time is not a default. A kind the order does not know (a free `prose` chapter is
    the common one) keeps going to the end, which is where an unnamed chapter is least surprising.
    """
    if kind not in KIND_ORDER:
        return len(sections)
    rank = KIND_ORDER.index(kind)
    for i, s in enumerate(sections):
        other = s.get("kind", "prose")
        # An unknown kind never displaces a known one: it sorts as "after everything".
        other_rank = KIND_ORDER.index(other) if other in KIND_ORDER else len(KIND_ORDER)
        if other_rank > rank:
            return i
    return len(sections)


def _typst():
    """Imported lazily: report_store is imported by paths that must not pull in the renderer."""
    from prism_lca.engine import typst_render

    return typst_render


def _palettes():
    """Lazily too, for the same reason — the palettes are read while creating a report."""
    from prism_lca.engine import report_palettes

    return report_palettes


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def check_template_name(name: str) -> str:
    """Cheap validation, deliberately callable before the expensive fixture compile — otherwise a bad
    name is reported as a compiler error, which is the wrong thing to tell someone."""
    from prism_lca.engine import typst_render

    name = (name or "").strip()
    # Retired ids are reserved too. Stored reports still carry strings like "default", and `get_template`
    # resolves those from the registry — a project theme under the same name would shadow that resolution, and
    # which of the two won would depend on the order of two `if`s.
    if not name or name in typst_render.BUILTIN_TEMPLATES or name in typst_render.RETIRED_TEMPLATES:
        raise PrismError(
            f"Pick another name for the theme — '{name or 'default'}' is a name the app reserves.",
            code="report_template_name",
            hint="Download a theme as a starting point and upload it under a name of your own.",
        )
    return name


#: What a report's `options` may contain: key -> validator. Kept as a whitelist so a typo ("figuers")
#: or a wrong type ("banana" for a flag) is a 400 at write time instead of silently stored settings
#: that no reader ever picks up.
_OPTION_CHECKS: dict[str, Any] = {
    "intended_public": lambda v: isinstance(v, bool),
    "significance_percent": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "outlines": lambda v: isinstance(v, dict) and all(isinstance(x, bool) for x in v.values()),
    "figures": lambda v: isinstance(v, dict)
    and set(v) <= {"heatmap", "radar", "stacked"}
    and all(isinstance(x, bool) for x in v.values()),
}


def check_options(options: Any) -> None:
    """Refuse unknown option keys and wrong types. `None` values pass — they mean "remove this key"."""
    if not isinstance(options, dict):
        raise PrismError("`options` must be an object.", code="report_options_invalid")
    unknown = sorted(set(options) - set(_OPTION_CHECKS))
    if unknown:
        raise PrismError(
            f"Unknown report options: {', '.join(unknown)}. Known: {', '.join(sorted(_OPTION_CHECKS))}.",
            code="report_options_invalid",
        )
    for key, value in options.items():
        if value is not None and not _OPTION_CHECKS[key](value):
            raise PrismError(f"Report option '{key}' has the wrong shape.", code="report_options_invalid")


#: Every section field beyond the identity fields that `update_section` accepts — kept in one place so
#: that a section rebuilt from a stored spec (`replace_sections`, which the bundle import uses) carries
#: the same things a patch may set. Built from a spec with only the core fields, a chapter came back
#: from a .prism round trip without its figures, its bindings, its lookups and its display options
#: — and a number placeholder that had been pinned to a member followed the list index again.
SECTION_CARRIED_FIELDS = (
    "bindings", "caption_bindings", "caption_based_on", "figure", "figures", "lookups", "findings", "reviewed", "correction_tried",
    "inventory_rows", "table_layout", "per_indicator_charts", "hidden_indicators", "inventory_parts",
    "inventory_detail", "hotspots", "aggregate_by", "background_tier", "per_process", "colour_by",
    "edge_amounts", "literature_search",
)


#: What a stored chapter carries about its own past — restored by `replace_sections`, never taken from a
#: structure (a saved default or an outline must not hand one report's history to the next).
SECTION_HISTORY_FIELDS = ("previous", "written_sha", "ai_review")


def _section(spec: dict[str, Any], order: int) -> dict[str, Any]:
    kind = spec.get("kind", "prose")
    if kind not in DETERMINISTIC_KINDS + PROSE_KINDS:
        raise PrismError(
            f"Unknown section kind '{kind}'.",
            code="report_bad_kind",
            hint=f"Known kinds: {', '.join(DETERMINISTIC_KINDS + PROSE_KINDS)}.",
        )
    out = {
        "id": spec.get("id") or _new_id("sec"),
        "kind": kind,
        # Empty = "localise the standard heading for this kind at render time".
        "title": str(spec.get("title") or ""),
        "order": order,
        "locked": bool(spec.get("locked", False)),
        "text": spec.get("text") or "",
        "prompt_override": spec.get("prompt_override"),
        "extra_instructions": spec.get("extra_instructions") or "",
        "source": spec.get("source"),
        "model": spec.get("model"),
        "generated_at": spec.get("generated_at"),
        "based_on": spec.get("based_on"),
    }
    for key in SECTION_CARRIED_FIELDS:
        if spec.get(key) is not None:
            out[key] = spec[key]
    return out


def text_version(text: str | None) -> str:
    """The version of a chapter's wording, as clients hand it back: a short hash of the text."""
    import hashlib

    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()[:12]


def with_text_versions(report: dict[str, Any]) -> dict[str, Any]:
    """The report with `text_version` on every section — what the client reads and echoes on a write."""
    return {
        **report,
        "sections": [{**s, "text_version": text_version(s.get("text"))} for s in report.get("sections") or []],
    }


class ReportStore(JsonFileStore):
    FILENAME = "reports.json"

    def _load(self) -> dict[str, Any]:
        # A file that exists but cannot be read or parsed must be an error, not an empty store: every
        # mutation is load → modify → save, so treating a corrupt/locked file as `{}` would let the very
        # next "create report" atomically replace every report, template and default in the project.
        # The base's strict default ("propagate") raises too — this override only turns the raw
        # exception into the PrismError with the hint a person can act on.
        path = self._path()
        try:
            data = super()._load()
        except (OSError, ValueError) as exc:
            raise PrismError(
                f"The report store ({path.name}) exists but cannot be read: {exc}",
                code="report_store_unreadable",
                hint="Fix or move the file; overwriting it silently would erase every stored report.",
            ) from exc
        return data if isinstance(data, dict) else {}

    # ---- project-wide default structure -------------------------------------

    # ---- who the study belongs to -------------------------------------------
    #
    # Project-wide, next to the reports: the consultant's own name, firm and logo do not change between
    # the reports of one project, and re-typing them per report is how a cover ends up saying different
    # things about the same study. The CLIENT's logo is not here — it belongs to the individual report,
    # because that is what changes from one commission to the next.

    #: What an identity may hold. A whitelist, so a typo is a 400 rather than a field nobody reads.
    #: `no_logo` is gone: it existed because an empty logo field meant "use PrismLCA's mark", so there had
    #: to be a third state for "none". Now an empty field *is* none, and a stored `no_logo` from before
    #: is simply not read any more.
    IDENTITY_FIELDS = ("author", "organisation", "company_logo", "logo_height_mm")

    def get_identity(self) -> dict[str, Any]:
        stored = self._load().get("_identity") or {}
        return {
            "author": stored.get("author") or "",
            "organisation": stored.get("organisation") or "",
            "company_logo": stored.get("company_logo") or "",
            # Millimetres of logo height on the cover. Only a height: a width as well would let someone
            # squash their own logo, and nobody wants that on the first page of a client report.
            "logo_height_mm": float(stored.get("logo_height_mm") or DEFAULT_LOGO_HEIGHT_MM),
        }

    def set_identity(self, patch: dict[str, Any]) -> dict[str, Any]:
        unknown = sorted(set(patch) - set(self.IDENTITY_FIELDS))
        if unknown:
            raise PrismError(f"Unknown identity fields: {', '.join(unknown)}.", code="identity_field_unknown")
        if "logo_height_mm" in patch and patch["logo_height_mm"] is not None:
            height = float(patch["logo_height_mm"])
            if not MIN_LOGO_HEIGHT_MM <= height <= MAX_LOGO_HEIGHT_MM:
                raise PrismError(
                    f"A logo height of {height:g}mm is outside {MIN_LOGO_HEIGHT_MM:g}–{MAX_LOGO_HEIGHT_MM:g}mm.",
                    code="identity_logo_height",
                    hint="Below that it is unreadable, above it the cover is a letterhead.",
                )
            patch = {**patch, "logo_height_mm": height}
        with self._lock:
            data = self._load()
            current = data.get("_identity") or {}
            for key, value in patch.items():
                if value in (None, ""):
                    current.pop(key, None)
                else:
                    current[key] = value
            data["_identity"] = current
            self._save(data)
        return self.get_identity()

    def default_sections(self) -> list[dict[str, Any]]:
        specs = self._load().get("_defaults", {}).get("sections")
        if not specs:
            return [dict(s) for s in DEFAULT_SECTIONS]
        # Strip ids also on read: defaults saved before 2026-07 still carry them (see set_default_sections).
        return [{k: v for k, v in s.items() if k != "id"} for s in specs]

    def set_default_sections(self, sections: list[dict[str, Any]]) -> dict:
        """Set the starting structure for NEW reports. Existing reports are untouched on purpose."""
        with self._lock:
            data = self._load()
            # Ids are minted per report instance, not stored with the default: a default that carried
            # ids gave every report created from it the SAME section ids.
            stored = []
            for i, s in enumerate(sections):
                section = _section(s, i)
                section.pop("id", None)
                stored.append(section)
            data.setdefault("_defaults", {})["sections"] = stored
            self._save(data)
            return {"sections": data["_defaults"]["sections"]}

    # ---- typesetting templates ----------------------------------------------
    #
    # Stored per project alongside the reports. A template is only accepted after the fixture compiles
    # against it, so a broken one is refused at upload time with the compiler's message instead of
    # destroying a report later. `default` is not stored — it always means the shipped template.

    def list_templates(self) -> list[dict[str, Any]]:
        """The built-in templates first, then this project's uploaded ones.

        Built-ins are listed here rather than hardcoded in the UI, so shipping another one is a registry
        entry instead of an edit in two places — and the dropdown cannot fall out of step with what the
        renderer can actually resolve.
        """
        from prism_lca.engine import typst_render

        out: list[dict[str, Any]] = [
            {
                "name": tid,
                "label": entry["label"],
                "builtin": True,
                "cover_image": entry.get("cover_image", False),
                # Absent means yes: every template but one draws it, so the exception carries the flag.
                "client_logo": entry.get("client_logo", True),
                # Whether the theme typesets on dark paper — the renderer draws the figures and needs it.
                "dark": entry.get("dark", False),
                # …and in which faces, for the same reason: a chart lettered in a different font than the page
                # around it reads as pasted in from somewhere else.
                "fonts": entry.get("fonts") or {"body": "Noto Sans", "mono": "DejaVu Sans Mono"},
            }
            for tid, entry in typst_render.BUILTIN_TEMPLATES.items()
        ]
        templates = self._load().get("_templates", {})
        out += [
            {
                "name": name,
                "label": name,
                "builtin": False,
                # An uploaded template may or may not place either; assume it can, so the fields are offered.
                "cover_image": True,
                "client_logo": True,
                "chars": len(entry.get("source", "")),
                "added": entry.get("added", ""),
            }
            for name, entry in sorted(templates.items())
        ]
        return out

    def get_template(self, name: str) -> str | None:
        """The source to use, or None to mean "whatever the project's default theme is".

        `"default"` is no longer a special case here: it is a retired id like any other, so it
        falls through to the branch below and resolves to the current default theme. Keeping the special case
        would have kept every old report on the picture cover that is no longer in the picker.
        """
        from prism_lca.engine import typst_render

        if not name:
            return None
        if name in typst_render.BUILTIN_TEMPLATES:
            return typst_render.builtin_template_source(name)
        if name in typst_render.RETIRED_TEMPLATES:
            # A theme that shipped once and is gone. The report keeps pointing at it — the id is what it
            # stored — and renders in the current default instead of 404ing on a cover nobody chose.
            return typst_render.builtin_template_source(typst_render.DEFAULT_TEMPLATE)
        entry = self._load().get("_templates", {}).get(name)
        if entry is None:
            raise PrismError(
                f"No theme named '{name}'.",
                code="report_template_not_found",
                status_code=404,
                hint="Upload it again, or pick another theme under Appearance.",
            )
        return entry.get("source") or None

    def put_template(self, name: str, source: str) -> dict:
        name = check_template_name(name)
        with self._lock:
            data = self._load()
            data.setdefault("_templates", {})[name] = {"source": source, "added": now_iso()}
            self._save(data)
        return {"name": name, "chars": len(source)}

    def delete_template(self, name: str) -> dict:
        from prism_lca.engine import typst_render

        with self._lock:
            data = self._load()
            templates = data.get("_templates", {})
            if name not in templates:
                raise PrismError(f"No theme named '{name}'.", code="report_template_not_found", status_code=404)
            del templates[name]
            # Reports pointing at it fall back to the default rather than failing to render.
            for reports in data.values():
                if isinstance(reports, list):
                    for r in reports:
                        if r.get("template") == name:
                            # The *id* of the default theme, not the string "default" — that one is retired.
                            r["template"] = typst_render.DEFAULT_TEMPLATE
            self._save(data)
        return {"deleted": True}

    # ---- reports ------------------------------------------------------------

    def list_reports(self, database: str) -> list[dict[str, Any]]:
        # No sections and no image blobs: a listing is names for a dropdown, and the base64 cover of
        # every report made each list answer megabytes. The full report (`get`) still carries them.
        skip = ("sections", "cover_image", "client_logo")
        return [
            {k: v for k, v in r.items() if k not in skip} | {"section_count": len(r.get("sections", []))}
            for r in self._load().get(database, [])
        ]

    def get(self, database: str, report_id: str) -> dict[str, Any]:
        for r in self._load().get(database, []):
            if r["id"] == report_id:
                return r
        raise PrismError(f"No report '{report_id}' for model '{database}'.", code="report_not_found", status_code=404)

    def create(
        self,
        database: str,
        *,
        name: str | None = None,
        subtitle: str | None = None,
        aggregate_by: str | None = None,
        lang: str = "en",
        # The project's default theme, not the id "default": that one is a template like any other, it just
        # happens to be named after the role it used to have.
        template: str = "",
        subjects: list[dict] | None = None,
        methods: list[list[str]] | None = None,
        amount: float = 1.0,
        sections: list[dict] | None = None,
    ) -> dict[str, Any]:
        # Same rule as update(): a template must exist when it is assigned, not on the next render. A retired
        # id resolves to the default rather than raising, so this accepts one — which is what a report created
        # from a duplicate of an old one carries.
        if template:
            self.get_template(template)
        specs = sections if sections is not None else self.default_sections()
        report = {
            "id": _new_id("rep"),
            "name": name or "LCA report",
            # Printed under the title. Empty means "the reference process and its database", which is
            # what a working document wants; a document for a client usually wants its own line.
            "subtitle": subtitle or "",
            "created": now_iso(),
            "updated": now_iso(),
            "lang": lang,
            "template": template or _typst().DEFAULT_TEMPLATE,
            # The colour set. Separate from the template on purpose: the template decides the
            # layout, the palette the colour, and one choice reaches whichever template is in use.
            "palette": _palettes().DEFAULT_PALETTE,
            "amount": float(amount),
            # The contribution dimension is part of what the report *is*, not a render-time argument.
            # While it lived only in the request, a writing brief said "no contribution analysis was
            # carried out" for a report that has a contribution chapter.
            "aggregate_by": aggregate_by or "",
            # A cover starts with the shipped picture rather than empty: the templates that place one
            # look finished from the first render, and removing it is one click (with "Placeholder" to
            # put it back). Stored as the word, not the bytes — see typst_render.DEFAULT_COVER.
            "cover_image": _typst().DEFAULT_COVER,
            "client_logo": "",
            "subjects": subjects or [],
            "methods": methods or [],
            "options": {
                # Drives the ISO 14044 §7.3.3 note for a public comparative assertion. Three earlier
                # placeholder flags (`state_absent`, `comparative`, `for_publication`) were never read by
                # anything and are gone: `comparative` is derivable from the subject count, and stating
                # absent things turned out to be the presence of the Limitations chapter.
                "intended_public": False,
                # Comparison figures across subjects. Off by default: they only say something when there is
                # more than one subject, and a report of one should not carry an empty chart.
                "figures": {"heatmap": False, "radar": False, "stacked": False},
                # Contents, figure and table lists — Typst generates and localises all three, and the
                # page numbers come from the same outline machinery as the contents, so they cannot
                # drift. Figures/tables are on by default: the template suppresses
                # either list when the document contains none of its kind, so the default costs an
                # empty report nothing.
                "outlines": {"contents": True, "figures": True, "tables": True},
                # Below this relative difference the check advises against calling one variant better.
                # A convention rather than a measurement (see report_claims), hence adjustable per report:
                # 5 % is defensible for climate change and energy, far too tight for toxicity.
                "significance_percent": report_claims.DEFAULT_WEAK_DIFFERENCE_PERCENT,
            },
            "sections": [_section(s, i) for i, s in enumerate(specs)],
        }
        with self._lock:
            data = self._load()
            data.setdefault(_check_db(database), []).append(report)
            self._save(data)
        return report

    def update(self, database: str, report_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        """Merge report-level fields. `sections` is handled by the section methods, not here.

        `None` **clears**: the key is removed from the report, so every reader's default applies again
        (`amount` falls back to 1.0, `subtitle` to nothing). It used to be skipped, which meant no field
        could ever be reset over the API — the request returned 200 and changed nothing. Fields the
        patch does not mention are left alone; the API sends only what the client set (`exclude_unset`).
        """
        allowed = {
            "name", "subtitle", "lang", "template", "palette", "amount", "aggregate_by", "subjects",
            "methods", "options", "abbreviations",
            # Study-borne prose carried into the report language: {"lang": "...", "map": {key: text}}.
            # Written by the translations/set endpoint, which validates keys against the candidates.
            "translations",
            # Accent, deep tone and paper chosen by hand on this one report, replacing the set's three.
            # `None` clears them and the set applies again — which is what the picker's own reset sends.
            "palette_colors",
            # Base64 PNG/JPEG for the cover. Held with the report rather than in a file next to it so a
            # report stays one self-contained thing — it can be duplicated, and its cover travels with it.
            "cover_image",
            # The client's logo: on the report, not on the project, because it changes per commission.
            "client_logo",
            # The author's answers to the writer's questions, by question id: {answer, question, at}.
            # Read into every brief, so an answer reaches each chapter written after it.
            "answers",
        }
        unknown = sorted(set(patch) - allowed)
        if unknown:
            raise PrismError(f"Unknown report fields: {', '.join(unknown)}.", code="report_field_unknown")
        # Own copy: the normalisation below must not write back into the caller's dict.
        patch = dict(patch)
        if "options" in patch and patch["options"] is not None:
            check_options(patch["options"])
        if "translations" in patch and patch["translations"] is not None:
            t = patch["translations"]
            ok = (
                isinstance(t, dict)
                and isinstance(t.get("lang"), str)
                and isinstance(t.get("map"), dict)
                and all(isinstance(k, str) and isinstance(v, str) for k, v in t["map"].items())
            )
            if not ok:
                raise PrismError(
                    '`translations` must be {"lang": "...", "map": {key: text}}.',
                    code="report_field_invalid",
                )
        # Checked on the way in, not at render time: a hex typo would otherwise surface as "the report
        # cannot be typeset", long after the field that caused it went out of view.
        if patch.get("palette_colors"):
            from prism_lca.engine import report_palettes

            patch["palette_colors"] = report_palettes.check_colors(patch["palette_colors"])
        # A template must exist when it is assigned — not first fail on the next render, long after the
        # typo was made. (`get_template` only reads; no lock is held yet.)
        if patch.get("template"):
            self.get_template(patch["template"])
        with self._lock:
            data = self._load()
            for r in data.get(database, []):
                if r["id"] != report_id:
                    continue
                if not patch:
                    # A patch that sets nothing must not pretend something changed.
                    return r
                for key, value in patch.items():
                    if value is None:
                        r.pop(key, None)
                    # `options` merges one level deep. Replacing it wholesale meant a caller setting one
                    # flag silently dropped the others — that is how a report lost its table of contents:
                    # a request that only turned on the comparison figures took `outlines` with it.
                    # A `None` value inside the merge removes that key.
                    elif key == "options" and isinstance(value, dict) and isinstance(r.get(key), dict):
                        merged = dict(r[key])
                        for name, setting in value.items():
                            if setting is None:
                                merged.pop(name, None)
                            elif isinstance(setting, dict) and isinstance(merged.get(name), dict):
                                inner = {**merged[name], **setting}
                                merged[name] = {k: v for k, v in inner.items() if v is not None}
                            else:
                                merged[name] = setting
                        r[key] = merged
                    else:
                        r[key] = value
                r["updated"] = now_iso()
                self._save(data)
                return r
        raise PrismError(f"No report '{report_id}' for model '{database}'.", code="report_not_found", status_code=404)

    def delete(self, database: str, report_id: str) -> dict:
        with self._lock:
            data = self._load()
            before = len(data.get(database, []))
            data[database] = [r for r in data.get(database, []) if r["id"] != report_id]
            if len(data[database]) == before:
                raise PrismError(f"No report '{report_id}'.", code="report_not_found", status_code=404)
            self._save(data)
        return {"deleted": True}

    # ---- sections -----------------------------------------------------------

    def add_section(self, database: str, report_id: str, spec: dict[str, Any], *, at: int | None = None) -> dict:
        with self._lock:
            data = self._load()
            report = self._find(data, database, report_id)
            section = _section(spec, 0)
            sections = report["sections"]
            # A client-supplied id that already exists would create twins: `reorder` keys by id and
            # silently collapses one of them on the next drag, and `delete` removes both.
            if any(s.get("id") == section["id"] for s in sections):
                raise PrismError(
                    f"Section id '{section['id']}' already exists in this report.",
                    code="report_section_duplicate",
                )
            if at is not None:
                index = max(0, min(int(at), len(sections)))
            else:
                index = _canonical_index(sections, section.get("kind", "prose"))
            sections.insert(index, section)
            self._renumber(sections)
            report["updated"] = now_iso()
            self._save(data)
            return section

    def update_section(self, database: str, report_id: str, section_id: str, patch: dict[str, Any]) -> dict:
        """Merge section fields. A **locked** section refuses content changes — that is the whole
        point of the flag: regenerating must not overwrite text a reviewer already signed off."""
        # `lookups` and `findings` are the acceptance evidence: what the writer looked up (the gate
        # accepts a quoted fact only against them, including at patch time) and which advisory findings
        # were on the table when the text was stored.
        content_keys = {"text", "source", "model", "generated_at", "based_on", "bindings", "figure",
                        "lookups", "findings",
                        # What the second reader checked and how each point ended — written with the text
                        # it read, so it is a content key like the evidence above.
                        "ai_review",
                        # The text as last WRITTEN (writer store, hand edit) — what summarising chapters
                        # compare against; a correction leaves it alone (V423).
                        "written_sha"}
        allowed = content_keys | {
            "title", "locked", "prompt_override", "extra_instructions", "kind",
            # "This is how I knew it": the text the author last read, kept so PrismLCA can show what has
            # moved since. Not a content key — marking a chapter read changes no sentence, and it must
            # work on a frozen chapter too, which is exactly where a reviewer works.
            "reviewed",
            # "A correction round has already run against this wording, and here is what it refused."
            # Not a content key either: it changes no sentence, and it is bookkeeping *about* an
            # attempt rather than a claim about the numbers — the freshness record stays the sole
            # authority on whether the chapter is stale (api/v1/report_ai.section_correction_tried).
            "correction_tried",
            # The chapter's own figures, in the order they are drawn. Not a content key: a figure is a
            # drawing *of* the numbers, so adding one to a frozen chapter changes no reviewed sentence —
            # and a reviewer who froze the text should still be able to say how it is illustrated.
            "figures",
            # The captions' own pins and record, written with a caption edit. Not content
            # keys, for the same reason `figures` is not: a caption can be reworded on a frozen
            # chapter, and its pins have to follow it — they touch nothing the text claims.
            "caption_bindings",
            "caption_based_on",
            # Appendix only: how many inventory rows its table lists. 0 = every characterised flow, which is
            # thousands on an ecoinvent-backed model — the author's call, not ours.
            "inventory_rows",
            # Results chapter only: how its matrix is set, and which indicators get a chart of their
            # own. Presentation, like `figures` — it cannot be wrong about a number, so it is not a
            # content key and may be changed on a frozen chapter.
            "table_layout",
            "per_indicator_charts",
            # Contribution chapter only: the indicators it leaves out, by method label. Presentation
            # too — dropping one changes no number, and a label survives a reordered method list.
            "hidden_indicators",
            # Inventory chapter only: which of its parts are shown, and how much of each note.
            "inventory_parts",
            "inventory_detail",
            # Contribution chapter: the hotspot table under each breakdown, and a breakdown dimension
            # of the chapter's own (a second contribution chapter by another tag family; empty = the
            # report's). Presentation and scope of one chapter, never a claim about a number.
            "hotspots",
            "aggregate_by",
            # System-model chapter: what the figure draws and how it is coloured.
            "background_tier",
            "per_process",
            "colour_by",
            "edge_amounts",
            # Introduction and interpretation: whether the writer may search the literature (absent = it
            # may). How the next text is written, not a claim in this one, so a frozen chapter keeps it.
            "literature_search",
        }
        # Same refusal as the report-level update: a misspelt field returned 200 and stored nothing,
        # which is the failure mode the whitelist exists to prevent, not to cause.
        # The text version the writer read before it wrote: not a field, a precondition. A single chapter
        # being written had its text box open for edits; the author's blur-save landed, and three
        # minutes later the writer stored over it with a text computed from the old wording — one
        # person, one window, text gone. Checked under the lock, against the text on disk, and only
        # when the caller states what it read.
        expected = patch.get("expected_text_version")
        patch = {k: v for k, v in patch.items() if k != "expected_text_version"}
        unknown = sorted(set(patch) - allowed)
        if unknown:
            raise PrismError(
                f"Unknown section fields: {', '.join(unknown)}.", code="report_section_field_unknown"
            )
        with self._lock:
            data = self._load()
            report = self._find(data, database, report_id)
            for s in report["sections"]:
                if s["id"] != section_id:
                    continue
                if expected is not None and text_version(s.get("text")) != expected:
                    raise PrismError(
                        f"Section '{chapter_name(s)}' changed while this text was being prepared — another "
                        "write landed first. Nothing was overwritten; reload to see the stored wording.",
                        code="report_text_moved",
                        status_code=409,
                        hint="Read the chapter again and redo the change against its current text.",
                    )
                if s.get("locked") and any(k in patch for k in content_keys) and patch.get("locked") is not False:
                    raise PrismError(
                        f"Section '{chapter_name(s)}' is locked — unlock it first.",
                        code="report_section_locked",
                        hint="Set locked=false in the same call to change the text anyway.",
                    )
                if "inventory_rows" in patch and patch["inventory_rows"] is not None:
                    rows = int(patch["inventory_rows"])
                    if rows < 0 or rows > MAX_INVENTORY_ROWS:
                        raise PrismError(
                            f"An inventory table of {rows} rows is outside 0–{MAX_INVENTORY_ROWS}.",
                            code="report_inventory_rows",
                            hint="0 means every flow; anything above that ceiling is a table nobody reads.",
                        )
                    patch = {**patch, "inventory_rows": rows}
                if "figures" in patch:
                    # Validated here rather than at render time: a spec that names a source we cannot plot
                    # has to be refused while the editor is open and can say so, not silently draw nothing.
                    from prism_lca.engine import report_prompts

                    patch = {**patch, "figures": report_prompts.accept_figures(patch["figures"])}
                if "kind" in patch and patch["kind"] not in DETERMINISTIC_KINDS + PROSE_KINDS:
                    raise PrismError(f"Unknown section kind '{patch['kind']}'.", code="report_bad_kind")
                # Text changed by hand (the writer sends its provenance in the same call): whatever was
                # recorded about the previous wording no longer describes what is stored. Keeping it
                # would let a chapter claim it was checked against numbers it never mentioned, and
                # leave bindings pointing at placeholders the new text may not contain.
                pins_before = s.get("bindings")
                if "text" in patch and "based_on" not in patch:
                    s.pop("based_on", None)
                    s.pop("bindings", None)
                # A correction round's verdict is about the wording that round read. Any new text
                # retires it — a hand edit (the author may have deleted the offending sentence
                # themselves), a rewrite, or a correction that did land — and it must not survive to
                # become the reason the run plan offers to discard the next version. Separate from the
                # block above because a rewrite brings its own `based_on` and would slip through it.
                if "text" in patch and "correction_tried" not in patch:
                    s.pop("correction_tried", None)
                # The wording that is about to be replaced, kept so it can be shown back. A rewrite is
                # the one operation in this panel that destroys something the author may have spent an
                # afternoon on, and "what did it say before?" had no answer at all — the read-marker
                # diff only covers a chapter the author had explicitly marked. One string per chapter,
                # overwritten by the next change: this is a safety net for the last step, not a history.
                # Its pins come along: put back after a recalculation, the old wording has to print
                # the members it was written about, and its indices may no longer say which those are.
                if "text" in patch:
                    was = s.get("text") or ""
                    if was.strip() and was != (patch.get("text") or ""):
                        s["previous"] = {"text": was, "at": now_iso(), "bindings": pins_before or {}}
                for key, value in patch.items():
                    if key in allowed:
                        s[key] = value
                if "figures" in patch and "figure" not in patch:
                    # The list is the authority; the single `figure` is only what a report written
                    # before the list has, and both readers fall back to it *while the list is empty*
                    # (report_render, report_prompts.renders_for). Left in place, emptying the list in
                    # the editor stored `figures: []`, the fallback woke up, and the document kept
                    # drawing the figure the author had just removed — with the proposal path no longer
                    # deleting figures either (V215), the legacy key had no delete path left at all.
                    #
                    # Cleared rather than migrated into the list: migrating renames the label from
                    # `f-section-<id>` to `f-section-<id>-0`, and that is the very reference the brief
                    # offers a chapter for its own figure, so the chapter's stored text may already
                    # carry it — a rename would print `[missing reference: …]` (V203). Clearing renames
                    # nothing: with a non-empty list the singular was already drawn by nobody.
                    s.pop("figure", None)
                report["updated"] = now_iso()
                self._save(data)
                return s
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)

    def delete_section(self, database: str, report_id: str, section_id: str) -> dict:
        with self._lock:
            data = self._load()
            report = self._find(data, database, report_id)
            before = len(report["sections"])
            report["sections"] = [s for s in report["sections"] if s["id"] != section_id]
            if len(report["sections"]) == before:
                raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
            self._renumber(report["sections"])
            report["updated"] = now_iso()
            self._save(data)
        return {"deleted": True}

    def replace_sections(self, database: str, report_id: str, specs: list[dict[str, Any]]) -> dict:
        """Swap the whole chapter list — refused while any chapter holds text.

        The bundle import rebuilds a report's chapters with it. The check lives here, under the same lock
        as the swap, so text stored between a check and the replace cannot be thrown away silently — the
        one thing this module's docstring promises never to do.
        """
        with self._lock:
            data = self._load()
            report = self._find(data, database, report_id)
            written = [s for s in report.get("sections") or [] if (s.get("text") or "").strip()]
            if written:
                raise PrismError(
                    f"{len(written)} chapter(s) already contain text; a new structure would replace them.",
                    code="report_outline_would_discard",
                    hint="Apply a structure to a fresh report, or clear those chapters first.",
                )
            # A chapter restored from a bundle keeps its history too: the wording before the last rewrite
            # (what "compare with the previous version" shows), the fingerprint of the text as written,
            # and what the second reader made of it. `_section` builds chapters from a structure, which
            # has none of these, and so a round trip lost them.
            report["sections"] = [
                {**_section(s, i), **{k: s[k] for k in SECTION_HISTORY_FIELDS if s.get(k) is not None}}
                for i, s in enumerate(specs)
            ]
            report["updated"] = now_iso()
            self._save(data)
            return report

    def reorder_sections(self, database: str, report_id: str, order: list[str]) -> dict:
        """Apply a new order (drag & drop). Ids not listed keep their relative position at the end,
        so a stale client cannot silently drop a section it did not know about."""
        with self._lock:
            data = self._load()
            report = self._find(data, database, report_id)
            by_id = {s["id"]: s for s in report["sections"]}
            unknown = [i for i in order if i not in by_id]
            if unknown:
                raise PrismError(f"Unknown section ids: {', '.join(unknown)}.", code="report_section_not_found")
            if len(set(order)) != len(order):
                # A duplicated id would store the same section dict twice — two JSON copies with one id.
                raise PrismError("Duplicate section ids in the new order.", code="report_order_invalid")
            ordered = [by_id[i] for i in order] + [s for s in report["sections"] if s["id"] not in set(order)]
            report["sections"] = ordered
            self._renumber(ordered)
            report["updated"] = now_iso()
            self._save(data)
            return {"sections": ordered}

    # ---- helpers ------------------------------------------------------------

    @staticmethod
    def _find(data: dict[str, Any], database: str, report_id: str) -> dict[str, Any]:
        for r in data.get(database, []):
            if r["id"] == report_id:
                return r
        raise PrismError(f"No report '{report_id}' for model '{database}'.", code="report_not_found", status_code=404)

    @staticmethod
    def _renumber(sections: list[dict[str, Any]]) -> None:
        for i, s in enumerate(sections):
            s["order"] = i

    def rename_database(self, old: str, new: str) -> None:
        """Follow a model rename, like the tag and parameter stores do."""
        with self._lock:
            data = self._load()
            if old in data:
                # Anything already stored under the new name can only be a leftover — the repository
                # refuses to rename onto an existing model — so dropping it is cleanup, not loss.
                data[_check_db(new)] = data.pop(old)
                self._save(data)

    def remove_database(self, database: str) -> None:
        """Follow a model deletion, like the other stores do.

        Without this, deleting model "X" left its reports in the file, and creating a new model named
        "X" resurrected them — old prose, subjects pointing at deleted process codes and all.
        """
        with self._lock:
            data = self._load()
            if database in data:
                del data[database]
                self._save(data)
