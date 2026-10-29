"""Every chapter kind, described once — the registry the seven parallel tables grew out of.

Adding a chapter kind used to take seven coordinated edits: the two membership tuples
(``report_model``), the renderer's ``if/elif`` chain (``report_render.blocks_for``), the brief's
offer chain (``report_prompts.renders_for``), the default prompt, four per-kind tables in
``report_prompts`` (what a chapter covers, who summarises, what is worth reading, which facts are
specialist), the title-key map (``report_i18n``) and the reading order (``report_store``). The
string ``"goal_scope"`` alone was declared at fourteen sites in six files, and the one drift that
slipped through reached a user: the brief offered a render label the renderer no longer emitted, and
a commissioned rewrite was thrown away over one token (V215).

This module is deliberately a **pure-data leaf** — it imports nothing of the engine, so the other
leaves (``report_model``, ``report_i18n``, ``report_store``) may derive their tables from it without
bending the module layering. The *callables* stay where they live: the block builders belong to the
renderer and the offer functions to the prompts module, each keyed by kind in a dispatch table whose
completeness against this registry is pinned by ``tests/test_report_kinds.py``. A two-stage registry
(data here, behaviour at the consumer) was chosen over one carrying callables, because a registry
that imports ``report_render`` could never be read by the modules underneath it.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ChapterKind:
    """One chapter kind, as the whole report family sees it."""

    #: The stored `kind` string — the identity, never renamed (stored reports carry it).
    kind: str
    #: The string key of the standard heading. The one place a chapter kind gets a name: the kind is
    #: called `inventory`, the heading "Life cycle inventory" — two names for the same chapter are
    #: exactly why this cannot be ``f"{kind}.title"``.
    title_key: str
    #: What the chapter is for, in one clause — the document plan handed to every writer.
    #: Deliberately terse: the point is not to teach a writer what an inventory chapter is (its own
    #: prompt does that) but to tell it that one EXISTS, elsewhere, so it can point instead of repeat.
    #: Empty for the free `prose` chapter: it has no fixed job, and the document plan says nothing
    #: for it (the historical table simply had no entry).
    covers: str
    #: A model writes it: the text *is* the chapter. Everything else is built by code and may carry a
    #: written comment underneath its tables.
    prose: bool = False
    #: The chapter's job is to sum up the others, so its writer gets to read them.
    summarising: bool = False
    #: Worth showing to a summarising writer: the results and their interpretation. Not the annex,
    #: the references or the glossary — a table of parameters adds length and nothing to a summary.
    worth_reading: bool = False
    #: Ships its own default prompt (assets/prompts/<kind>.md). Kinds without one fall back to the
    #: `prose` prompt when a model is asked to comment on them.
    own_prompt: bool = False
    #: Discusses the world outside the model — the background, published studies — and so may search
    #: the literature, unless the chapter's own switch is off (the section's `literature_search`).
    literature: bool = False


#: Reading order of the finished document — this sequence IS ``report_store.KIND_ORDER``.
#: The comments carry the order's reasons, moved here with it.
KINDS: tuple[ChapterKind, ...] = (
    # The executive summary opens the document — the renderer hoists it BEFORE the table of contents
    # regardless of stored order, and the chapter list pins it.
    ChapterKind("summary", "summary.title", "what the study found, in short",
                prose=True, summarising=True, own_prompt=True),
    # Front matter: a reader meets the acronyms before the chapters that use them.
    ChapterKind("abbreviations", "abbreviations.title", "the abbreviations used"),
    # Where most published LCAs begin: the product, why it is studied, what is already known about it.
    # Written, and the one chapter besides the interpretation whose writer may search the literature.
    ChapterKind("introduction", "introduction.title",
                "the background: the product, why it is studied and what published work says about it",
                prose=True, own_prompt=True, literature=True),
    ChapterKind("goal_scope", "goal_scope.title",
                "the goal, the functional unit, the system boundaries, the cut-off and the allocation",
                worth_reading=True, own_prompt=True),
    # The system model as a picture: the foreground processes, their links and the first tier of
    # background datasets — ISO 14044 §4.2.3.3's flow diagram, drawn from the model rather than by hand.
    # Its own chapter because the figure is usually a page of its own.
    ChapterKind("system_model", "system_model.title",
                "the process network the study models — its own processes and the datasets they draw on directly"),
    # ISO 14040 order: what was modelled comes before what it scores. The first report went from
    # "these are the indicators" straight to "these are the numbers".
    ChapterKind("inventory", "lci.title", "what was modelled and where its data came from",
                own_prompt=True),
    ChapterKind("methods", "methods.title", "which indicators were computed, from which method family",
                worth_reading=True, own_prompt=True),
    ChapterKind("lcia", "lcia.title", "the indicator results and how the variants compare",
                worth_reading=True, own_prompt=True),
    ChapterKind("contribution", "contribution.title", "the breakdown by phase or location",
                worth_reading=True, own_prompt=True),
    ChapterKind("interpretation_checks", "checks.title", "completeness, sensitivity and consistency",
                worth_reading=True, own_prompt=True),
    ChapterKind("limitations", "limits.title", "what the study cannot support",
                worth_reading=True),
    ChapterKind("conclusions", "conclusions.title", "what follows from the results",
                prose=True, summarising=True, own_prompt=True),
    ChapterKind("prose", "interpretation.title", "",
                prose=True, worth_reading=True, own_prompt=True, literature=True),
    ChapterKind("appendix", "appendix.title", "parameters, scenarios and elementary flows",
                own_prompt=True),
    ChapterKind("datasets", "datasets.title", "the background datasets the model links to"),
    ChapterKind("references", "references.title", "the sources"),
    ChapterKind("provenance", "provenance.title", "what it takes to reproduce the numbers"),
)

BY_KIND: dict[str, ChapterKind] = {k.kind: k for k in KINDS}

#: Reading order for the shipped chapter kinds (see the entries above for the reasons) — used to
#: place an added chapter where it belongs instead of at the end.
KIND_ORDER: list[str] = [k.kind for k in KINDS]

#: The chapters whose writer may search the literature (see `ChapterKind.literature`).
LITERATURE_KINDS: tuple[str, ...] = tuple(k.kind for k in KINDS if k.literature)

#: Chapter kind -> the string key that names it. The heading a message uses for a chapter has to be
#: the name the reader will find in the PDF, so ``report_render`` and error messages share this map.
KIND_TITLES: dict[str, str] = {k.kind: k.title_key for k in KINDS}

#: Sections whose content is produced by code, not by a model.
#:
#: "Deterministic" is about where the *content* comes from, not about whether a chapter can hold prose:
#: each of these may carry a written comment underneath its
#: tables. The tables stay the source; the comment says what they mean, which is what ISO 14044 §4.5 asks
#: for on the interpretation checks.
#:
#: A literal rather than a filter over ``KINDS``: the historical tuple order predates the registry and
#: reaches the refusals that list the known kinds, so deriving it from reading order would silently
#: reorder text people and models read. The import-time check below keeps it honest instead.
DETERMINISTIC_KINDS = (
    "goal_scope", "system_model", "inventory", "methods", "lcia", "contribution", "interpretation_checks", "limitations",
    "appendix",
    "datasets", "references", "provenance", "abbreviations",
)
#: Sections a model writes: the text *is* the chapter.
#:
#: `conclusions` is separate from `prose` on the author's decision: the interpretation (what the numbers
#: mean) and the conclusions (what the study therefore says) are two different chapters in practice, and
#: recommendations belong in the second one — sparingly — rather than in a chapter of their own.
PROSE_KINDS = ("prose", "summary", "conclusions", "introduction")

# The two tuples above and the registry describe the same population — a mismatch is a programming
# error worth failing the import over, not a state to limp through.
assert set(DETERMINISTIC_KINDS) == {k.kind for k in KINDS if not k.prose}, "registry/tuple drift"
assert set(PROSE_KINDS) == {k.kind for k in KINDS if k.prose}, "registry/tuple drift"
