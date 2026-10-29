"""Study-borne prose, carried into the report's language.

The chapters a model writes follow the report language, but the words the model of the *product*
was documented in do not: the functional unit, the process notes, the scenario names on the chart
axes, the declared limitations. An English report of a German study printed half its inventory
chapter in German (V123) — not a rendering bug, the study data simply *is* German.

The shape mirrors the abbreviations: collecting is deterministic (this module walks the snapshot),
a model only supplies the translations for a fixed list, and the store drops anything that was not
a candidate. Keys are hashes of the source text, so a translation dies with the sentence it
translated — edit the note and the stale translation simply stops matching. The stored map carries
the language it was made for; changing the report language orphans the whole map at once rather
than serving French prose in a Spanish report.

Deliberately NOT walked:
* contribution group **keys** — the key *is* the group's binding identity (`RANKED_LISTS`:
  ``contribution.groups: ("key",)``); translating it would unbind every chapter that pins a group.
  The `label` beside it is walked, and is what the tables and chart axes print (V240).
* hotspot and background dataset names and products — ecoinvent's own names, and the hotspot's
  identity fields. A foreground process *is* walked, name and reference product both (V193): those
  two strings are the modeller's, and its binding identity is its `code`, which no walk here touches.
* units and locations — "kg", "unit", "DE". They read like untranslated words in a Spanish table and
  are not: the claim checker places a figure's unit by symbol (`units_of.base`), so a translated one
  would stop matching the parameter it belongs to.
* people and organisations (author, commissioner) — names are not prose.
* **background** dataset names and products, still — but a FOREGROUND process that appears in the
  hotspot list is walked, because the same process is walked in `foreground` and printing it in two
  languages in one document is the defect this whole module exists to prevent (V255).
"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from typing import Any

#: The study's prose fields. Dates, people and identifiers stay untouched.
_STUDY_PROSE = (
    "goal", "scope", "functional_unit", "geography", "reference_year", "system_boundaries",
    "allocation", "system_allocation", "cutoff_criteria", "critical_review", "notes",
)


def source_key(text: str) -> str:
    """The stored key of a source string — content-addressed, so edits invalidate silently."""
    return hashlib.sha1(text.strip().encode("utf-8")).hexdigest()[:16]


def _sites(data: dict[str, Any]) -> Iterator[tuple[dict, str]]:
    """Every (container, field) whose value is study-borne prose the report prints.

    One walk shared by `candidates` and `apply`: two lists would drift the first time a field is
    added, and a field that is collected but never substituted (or the reverse) is exactly the kind
    of gap nobody notices until a client PDF does.
    """
    study = data.get("study") or {}
    for field in _STUDY_PROSE:
        yield study, field
    for item in study.get("limitations") or []:
        if isinstance(item, dict):
            yield item, "text"
    # The review's open findings print under the limitations in the builder's words — the reviewer's
    # English title and the resolution note. In a German report they stood as "Backbone datasets … not
    # opened — als Limitation vermerkt" (V408a): the same study-borne prose as the declared
    # limitations above, and translated the same way. Left out, page 18 of an English report carried
    # three German paragraphs in workshop shorthand (V252).
    for entry in (data.get("review") or {}).get("open") or []:
        if isinstance(entry, dict):
            yield entry, "finding"
            yield entry, "reason"
    yield data.get("activity") or {}, "name"
    for entry in data.get("foreground") or []:
        yield entry, "name"
        # The reference product sits in the column next to the name, and it is the same kind of string:
        # what the modeller called the thing this process makes. Left out, the inventory table read
        # line by line half in the report's language and half in the study's — "Tubo Neutrogena —
        # Suministro de glicerina | Glycerin, kosmetiktauglich" in a Spanish report, in all seven rows
        # (V193). Its safety is that none of these three strings identifies the entry: `foreground` is
        # bound by `code` (report_data.RANKED_LISTS), which this walk never touches, and the only
        # vocabulary built from these entries reads `name` alone (report_claims `_known_dataset_names`).
        # The *background* datasets keep their product: those are ecoinvent's.
        yield entry, "product"
        yield entry, "description"
        # The reasons recorded on its exchanges, read by the inventory and interpretation writers — and the
        # name of an input that is itself a foreground process, which is walked above under `name` too.
        for note in entry.get("exchange_notes") or []:
            yield note, "note"
            if note.get("own"):
                yield note, "input"
    for entry in data.get("parameters") or []:
        yield entry, "description"
        yield entry, "comment"
    for entry in data.get("scenarios") or []:
        # Safe for the same reason, and the reason it took two attempts to see: a scenario is bound by
        # its store `id`, not by the name this line rewrites. While `scenarios` was unregistered the
        # rewrite here *was* the argument for leaving it that way (V182, V186) — a pin on the name would
        # have reported itself missing in every translated report. The id was in the snapshot all along.
        yield entry, "name"
        yield entry, "description"
    yield from _variant_label_sites(data)
    yield from _breakdown_sites(data)


def _variant_label_sites(data: dict[str, Any]) -> Iterator[tuple[dict, str]]:
    """The variant names, in every list that repeats them: subjects, score-ordered rows, breakdown rows."""
    for subject in data.get("subjects") or []:
        yield subject, "label"
    for row in data.get("results") or []:
        # The same variant labels once more, in the score-ordered view each indicator's row carries
        # (`results.<i>.subjects_by_score`). Those rows are copies, so a walk that stopped at `subjects`
        # would print a variant's name translated in the chart legend and untranslated in the sentence
        # that declares it the highest. Safe for the reason `subjects` is: both lists bind a variant by
        # its `variant` key, which this walk never touches — and the source strings are identical, so
        # `candidates` deduplicates them away and no translator is asked twice.
        for entry in row.get("subjects_by_score") or []:
            yield entry, "label"
    # The same variant names a third time, on the per-variant breakdown rows: the header of the
    # contribution matrix and the legend of the grouped and stacked charts. They were left out while
    # the label *was* the identity of these two lists — a pin on a string this walk rewrites would
    # report itself missing in every translated report. Since the rows carry the `variant` key
    # (V223) that reason is gone, and what was left of it was a French report whose prose said "la
    # fenêtre PVC 100×120" over a table headed in German: one object, two languages, facing pages —
    # V187 and V193's class. The group keys *beside* these labels stay put, and deliberately: those
    # are the binding identity of `contributions.*.groups`, and nothing here touches them.
    for entry in data.get("contribution_subjects") or []:
        yield entry, "label"
    for view in data.get("contributions") or []:
        for entry in view.get("subjects") or []:
            yield entry, "label"


def _breakdown_sites(data: dict[str, Any]) -> Iterator[tuple[dict, str]]:
    """The breakdown chapters: dimension headings, group labels and the foreground hotspots."""
    # The breakdown's own dimension and the values under it. A tag dimension is a name the modeller
    # typed ("Bauteil") and its values are more of the same ("Wechselrichter", "Montagegestell") —
    # study text exactly like a scenario name, and until V240 the only text in the walk's reach that
    # was left out. An English report of a German model printed its contribution chapter, its chart
    # axes and its heading in German.
    #
    # The `label` beside each `key` is what made this possible: the key is the row's binding identity
    # (`RANKED_LISTS`: ``contribution.groups: ("key",)``) and nothing here touches it, so a chapter
    # pinned to a group goes on resolving in every language. `dimension` keeps its raw "tag:" marker
    # for the same reason.
    # …and the extra breakdown dimensions: a second contribution chapter by another tag family is
    # rendered from `contributions_by_dimension`, which held its own objects and was walked by nothing
    # — its groups and heading stayed in the model's language.
    by_dimension = [v for views in (data.get("contributions_by_dimension") or {}).values() for v in views]
    for view in [data.get("contribution") or {}, *(data.get("contributions") or []), *by_dimension]:
        yield view, "dimension_label"
        for group in view.get("groups") or []:
            yield group, "label"
        for entry in view.get("subjects") or []:
            for group in entry.get("groups") or []:
                yield group, "label"
    for entry in data.get("contribution_subjects") or []:
        for group in entry.get("groups") or []:
            yield group, "label"
    # A FOREGROUND process that shows up as a hotspot. Background datasets keep their ecoinvent names
    # — that is why this list is otherwise left alone — but a foreground process appears in BOTH lists,
    # and it was translated in the inventory table and German in the hotspot sentence two chapters on
    # (V255). Bound by `database`+`code`, neither of which this touches.
    foreground_db = str((data.get("activity") or {}).get("database") or "")
    hotspot_lists = [data.get("hotspots") or []]
    hotspot_lists += [view.get("hotspots") or [] for view in (data.get("contributions") or [])]
    for hotspots in hotspot_lists:
        for hit in hotspots:
            if foreground_db and str(hit.get("database") or "") == foreground_db:
                yield hit, "name"
                yield hit, "product"


def candidates(data: dict[str, Any]) -> list[dict[str, str]]:
    """The source strings a translation could cover, deduplicated, in walk order.

    Collected from the *untranslated* snapshot — after `apply` the sources are gone, which is why
    the render records this list before substituting (``data["translations"]["candidates"]``).

    A candidate that comes from the review's open findings carries ``"origin": "review"`` (V425): the
    reviewer writes English whatever the study's language, so those texts can need translating when the
    study and the report share a language and nothing else does — see `foreign_review`.
    """
    review_entries = {id(entry) for entry in (data.get("review") or {}).get("open") or [] if isinstance(entry, dict)}
    seen: dict[str, str] = {}
    from_review: set[str] = set()
    for container, field in _sites(data):
        text = str(container.get(field) or "").strip()
        if len(text) < 2:
            continue
        key = source_key(text)
        seen.setdefault(key, text)
        if id(container) in review_entries:
            from_review.add(key)
    return [
        {"key": key, "text": text, **({"origin": "review"} if key in from_review else {})}
        for key, text in seen.items()
    ]


def text_language(text: str) -> str:
    """A short text's language by its function words, or "" when it says too little to tell.

    `detect_language` judges the study's prose as a whole and wants a dozen recognised words; a review
    finding's title has five or six words ("Datasets carrying 31 % of the result were not opened"), so
    this asks less: one recognised word, and strictly more of them than any other language has.
    """
    words = [w.lower() for w in _WORD.findall(text or "")]
    scores = {lang: sum(1 for w in words if w in markers) for lang, markers in _MARKERS.items()}
    best, runner_up = sorted(scores.values(), reverse=True)[:2]
    if best < 1 or best == runner_up:
        return ""
    return next(lang for lang, score in scores.items() if score == best)


def foreign_review(candidate: dict[str, Any], lang: str) -> bool:
    """Whether a review-finding candidate is written in another language than the report (V425).

    The reviewer writes English by its prompt, whichever language the study is in, so chapter 8.3 of a
    German report printed "Fill loss purchased but not disposed — …" while the study → report
    translation step stayed off (study and report were both German). A text whose language reads as the
    report's is left alone — the builder's resolution note is in the study's language; one that reads as
    another language is foreign; one too short to tell is foreign unless the report is English, because
    English is what the reviewer writes.
    """
    if candidate.get("origin") != "review":
        return False
    guess = text_language(str(candidate.get("text") or ""))
    if guess:
        return guess != lang
    return lang != "en"


def stored_map(report: dict[str, Any]) -> dict[str, str]:
    """The report's stored translations — only when they were made for its current language."""
    stored = report.get("translations") or {}
    same_lang = isinstance(stored, dict) and stored.get("lang") == report.get("lang", "en")
    return (stored.get("map") or {}) if same_lang else {}


def foreign_open(candidates: list[dict[str, Any]], report: dict[str, Any]) -> list[dict[str, str]]:
    """The review findings among `candidates` the report would still print in another language (V425).

    Still means: no stored answer, or one that is the source unchanged. Returned as ``{key, text}``, the
    shape the client hands to a model.
    """
    mapping = stored_map(report)
    lang = report.get("lang", "en")
    return [
        {"key": c["key"], "text": c["text"]}
        for c in candidates
        if (c["key"] not in mapping or mapping.get(c["key"]) == c["text"]) and foreign_review(c, lang)
    ]


def apply(data: dict[str, Any], stored: dict[str, Any], lang: str) -> int:
    """Substitute stored translations in place; a miss keeps the original. Returns the hit count.

    The map is honoured only for the language it was made for: after a language switch the old
    translations are not merely stale, they are in the wrong language, and printing them would be
    worse than printing the source.
    """
    if not isinstance(stored, dict) or stored.get("lang") != lang:
        return 0
    mapping = stored.get("map") or {}
    if not mapping:
        return 0
    hits = 0
    for container, field in _sites(data):
        text = str(container.get(field) or "").strip()
        if not text:
            continue
        translated = mapping.get(source_key(text))
        if isinstance(translated, str) and translated.strip():
            container[field] = translated
            hits += 1
    return hits


#: A figure as prose writes it, whatever the language's separators: "1 500", "1.500", "1,500" are one
#: run of digits, "1,5" and "1.5" another; "300, 400" is two (a separator is a thousands separator only
#: when exactly three digits follow it). Compared digits-only, so a translation may change the
#: separators and may not change the figure.
_DIGIT_RUN = re.compile(r"\d{1,3}(?:[.,\u202f\u00a0 ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?")


def _digit_runs(text: str) -> list[str]:
    return sorted(re.sub(r"\D", "", m.group(0)) for m in _DIGIT_RUN.finditer(text or ""))


def unfaithful(source: str, value: str) -> str | None:
    """Why a translation may not be stored, or None when it keeps its source's figures.

    A translation is a source once stored: the gate quotes numbers from the translated study texts,
    so "Transport über 300 km" accepted as "Transport over 900 km" let a chapter cite 900 km. The key
    proves which text was translated, not that the translation is true to
    it — this is the one part of that which is arithmetic.
    """
    a, b = _digit_runs(source), _digit_runs(value)
    if a != b:
        return (
            f"numbers differ — the source has {', '.join(a) or 'none'}, the translation has "
            f"{', '.join(b) or 'none'}"
        )
    return None


def accept_with_reasons(
    known: dict[str, str], resolved: dict[str, Any]
) -> tuple[dict[str, str], dict[str, str]]:
    """(entries safe to store, entries refused with the reason): known candidates only, non-empty
    strings only, and the figures of the source intact (`unfaithful`).

    Identity answers are kept on purpose: a model asked to translate a sentence that is already in
    the report language returns it unchanged, and storing that marks the sentence as *checked* — the
    open count reaches zero instead of offering the same English text for translation forever. The
    endpoint reports translated and identical separately, so nobody reads "20 translated" over a
    study that needed 8.
    """
    out: dict[str, str] = {}
    refused: dict[str, str] = {}
    for key, value in (resolved or {}).items():
        source = known.get(key)
        if source is None or not isinstance(value, str) or not value.strip():
            continue
        reason = unfaithful(source, value)
        if reason:
            refused[key] = reason
            continue
        out[key] = value.strip()
    return out, refused


def accept(known: dict[str, str], resolved: dict[str, Any]) -> dict[str, str]:
    """The entries safe to store — `accept_with_reasons` without the reasons."""
    return accept_with_reasons(known, resolved)[0]


#: Function words that separate the five report languages, as whole words. Deliberately small and
#: deliberately boring: these are the words every paragraph of prose contains and no dataset name does.
#: Single letters ("o", "a", "e") are left out — they collide with everything, including units.
_MARKERS: dict[str, frozenset[str]] = {
    "en": frozenset(
        "the and of is are was were with from for this that not been which have has been also".split()
    ),
    "de": frozenset(
        "der die das und nicht wird werden eine einer für mit von dem den ist sind auf aus durch "
        "keine wurde wurden über nach bei sich als auch".split()
    ),
    "fr": frozenset(
        "le la les des une dans pour avec est sont pas sur par aux cette ainsi été plus ont "
        "que qui au du".split()
    ),
    "es": frozenset(
        "el los las una del para con por que son este esta se ha han más como pero sin "
        "sobre entre".split()
    ),
    "pt": frozenset(
        "os as uma do da para com por que não são este esta foi foram mais como mas sem "
        "sobre entre pelo pela".split()
    ),
}

#: Below this many recognised words the sample is a label, not prose, and any answer is a coin toss.
_MIN_WORDS = 12

#: The winner must be this far ahead of the runner-up. Spanish and Portuguese share most of their
#: function words; a narrow win between them means "I do not know", which is a usable answer here
#: because the point is to *ask* the author rather than to decide for them.
_MARGIN = 1.25

_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def detect_language(data: dict[str, Any]) -> str:
    """Which of the report languages the study's own prose is written in, or "" if unclear.

    Deterministic and modelless, like everything else that decides *whether* to spend a model call.

    It exists because the language was a silently defaulted field. `study.language` is set by hand in
    Model info, and a model built without touching it reads as English — so an English report of a
    thoroughly German study never translated anything, never showed the translation step, and printed
    a full page of German under "Declared by the study" plus German section headings and chart legends
    (V158, a solar-lamp study). Nothing was broken; nothing had been asked either.

    A guess is not a decision: the caller offers it, the author confirms it.
    """
    words = [w.lower() for w in _WORD.findall(" ".join(text for _, text in _prose_of(data)))]
    if len(words) < _MIN_WORDS:
        return ""
    scores = {lang: sum(1 for w in words if w in markers) for lang, markers in _MARKERS.items()}
    best, runner_up = sorted(scores.values(), reverse=True)[:2]
    if best < 3:
        return ""
    if runner_up and best < runner_up * _MARGIN:
        return ""
    return next(lang for lang, score in scores.items() if score == best)


def _prose_of(data: dict[str, Any]) -> Iterator[tuple[str, str]]:
    """(field, text) over the study's own prose — the same sites a translation would cover."""
    study = (data.get("study") or data) if isinstance(data, dict) else {}
    for field in _STUDY_PROSE:
        text = str(study.get(field) or "").strip()
        if text:
            yield field, text
    for item in study.get("limitations") or []:
        text = str((item or {}).get("text") or "").strip() if isinstance(item, dict) else str(item or "").strip()
        if text:
            yield "limitations", text
