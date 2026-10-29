"""The three checks ISO 14044 §4.5 requires of the interpretation phase.

Completeness, sensitivity and consistency. They were missing from the report entirely, which is the
kind of gap a reviewer finds in the first ten minutes — and the building blocks were all already
here: the health linter, the scenario machinery, the subject list.

Two decisions shape this module.

**Deterministic, not written.** Each check states what it examined and what it found. Nothing here
asks a model anything: "were 6 of 7 processes complete" is a fact about the model, and a fact that a
model could get wrong is a fact that should never have been given to one. A written chapter may
*interpret* these tables afterwards — the numbers are addressable as placeholders like any other.

**"Nothing was computed" is a result, not a gap to hide.** Elsewhere in the report absent things stay
silent by default (the author's decision). Here it is inverted, deliberately: §4.5.3 asks for a
sensitivity check, so a report that ran no scenarios has to say that rather than omit the section and
leave a reader to assume one was done. That is the difference between declining to editorialise and
withholding something normative.
"""
from __future__ import annotations

import re
from typing import Any

from prism_lca.engine import report_model as rm
from prism_lca.engine.report_i18n import fmt_column, fmt_number, t
from prism_lca.engine.report_tokens import share_text

#: Findings at or above this severity are what a completeness check is about. `info` findings are
#: style notes and would bury the ones that matter.
_BLOCKING = ("error", "warning")


def _completeness(data: dict[str, Any], health: dict | None, lang: str) -> list[dict]:
    """ISO 14044 §4.5.2 — is the data complete enough for the conclusions drawn?

    Answered from the structural linter: an activity with no reference product, a broken link or a
    treatment process with the wrong sign is exactly an incompleteness, and it is checkable.
    """
    blocks: list[dict] = [rm.heading(t("checks.completeness", lang), 2)]
    if not health:
        blocks.append(rm.note(t("checks.no_health", lang)))
        return blocks

    findings = [f for f in health.get("findings") or [] if f.get("severity") in _BLOCKING]
    checked = int(health.get("activities") or 0)
    # The count of findings used to ride along in this sentence, and at zero it printed "0 findings
    # require attention" — a machine counting to nothing in a client's report (V254). The clean case
    # already has its own sentence below, and where there ARE findings the table beneath names each
    # one; a number in front of it added nothing either way.
    blocks.append(rm.prose(t("checks.completeness_intro", lang).format(count=fmt_number(float(checked), lang))))
    if not findings:
        # A clean linter is a real result and deserves to be stated plainly rather than left as an
        # empty table for a reader to interpret.
        blocks.append(rm.note(t("checks.completeness_clean", lang)))
        return blocks

    rows = [
        [
            t(f"severity.{f.get('severity', 'info')}", lang),
            str((f.get("activity") or {}).get("name") or ""),
            str(f.get("message") or ""),
        ]
        for f in findings
    ]
    blocks.append(
        rm.table(
            [t("table.severity", lang), t("table.process", lang), t("table.finding", lang)],
            rows,
            caption=t("caption.completeness", lang),
            label="t-completeness",
        )
    )
    return blocks


def sensitivity_rows(data: dict[str, Any], lang: str = "en") -> list[dict[str, Any]]:
    """The spread of every indicator across the report's subjects, as plain numbers.

    Separated from the table so three readers see the same figures: the table below, the snapshot (where
    these land under `checks.sensitivity` and become addressable as placeholders), and the brief handed
    to whoever comments on the chapter. A prose sentence disagreeing with the table above it is the
    failure mode this prevents by construction.
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

    rows: list[dict[str, Any]] = []
    for label in order:
        matching = [r for s in subjects for r in s["results"] if (r.get("method_label") or "") == label]
        scores = [float(r.get("score", 0.0)) for r in matching]
        if len(scores) < 2:
            continue
        low, high = min(scores), max(scores)
        # Spread relative to the smaller magnitude — the honest reading of "how far can this move".
        # Guarded because a zero score is possible (a model with no emissions for that indicator).
        base = min(abs(low), abs(high))
        rows.append(
            {
                "method_label": label,
                "unit": next((r.get("unit") for r in matching if r.get("unit")), ""),
                "lowest": low,
                "highest": high,
                "spread_percent": round(abs(high - low) / base * 100.0, 1) if base else None,
                # Ready to print, percent sign included. `spread_percent` is the number for arithmetic;
                # quoted in prose it printed "The range is 93.6 for climate change" under a table that
                # said "93.6 %" — and the prompt had recommended exactly that placeholder (V338).
                "spread_text": share_text(abs(high - low) / base * 100.0, lang) if base else "",
            }
        )
    return rows


def unmoved_variants(data: dict[str, Any]) -> list[str]:
    """Variants under a scenario whose every score equals the baseline's — variation that varied nothing.

    Read off the results rather than off the overrides, because that is the fact a reader can see: an
    apple-juice report printed three bars of the same height because one scenario set a
    distance to the value the model already had. The scenario page now refuses to create one, but a
    baseline can move to meet an override that was meaningful when it was typed — and then only the
    numbers know (improvement 1).
    """
    subjects = [s for s in data.get("subjects") or [] if s.get("results")]
    base = next((s for s in subjects if not s.get("scenario")), None)
    if base is None or len(subjects) < 2:
        return []
    reference = {r.get("method_label"): float(r.get("score", 0.0)) for r in base["results"]}
    out: list[str] = []
    for s in subjects:
        if not s.get("scenario") or not s["results"]:
            continue
        same = all(
            r.get("method_label") in reference
            and abs(float(r.get("score", 0.0)) - reference[r["method_label"]])
            <= abs(reference[r["method_label"]]) * 1e-12
            for r in s["results"]
        )
        if same:
            out.append(str(s.get("label") or ""))
    return [name for name in out if name]


def checks_summary(data: dict[str, Any], health: dict | None = None, lang: str = "en") -> dict[str, Any]:
    """The three checks as numbers rather than tables — for the snapshot and for a written comment.

    ISO 14044 §4.5 asks for a *judgement* here, and a judgement needs the figures it rests on to be
    quotable: without this, a sentence like "6 of 7 processes carried no finding" could only be typed
    out, and the gate would rightly refuse it.
    """
    health = health if health is not None else (data.get("health") or {})
    findings = [f for f in (health.get("findings") or []) if f.get("severity") in _BLOCKING]
    subjects = [s for s in data.get("subjects") or [] if s.get("results")]
    varied = [s for s in subjects if s.get("scenario")]
    return {
        "completeness": {
            "activities": int(health.get("activities") or 0),
            "findings": len(findings),
            "clean": bool(health) and not findings,
        },
        # The same guard the rendered table applies (`_sensitivity`): a spread across two *products* is
        # a comparison, not a sensitivity analysis. Without it the table said "No scenarios were varied"
        # while the snapshot offered `checks.sensitivity.0.spread_percent` for the prose to quote — a
        # sentence disagreeing with the table above it, by construction.
        "sensitivity": sensitivity_rows(data, lang) if varied else [],
        # Named so a chapter can say it too, not only the table (improvement 1).
        "unmoved_variants": unmoved_variants(data),
        "consistency": {
            "subjects": len(subjects),
            "varied": len([s for s in subjects if s.get("scenario")]),
            "background": str((data.get("provenance") or {}).get("background") or ""),
            "functional_unit": str((data.get("study") or {}).get("functional_unit") or ""),
        },
    }


def _sensitivity(data: dict[str, Any], lang: str) -> list[dict]:
    """ISO 14044 §4.5.3 — how much do the results move when the assumptions do?

    Read off the subjects the report already computes: each one carries its own scenario, so the
    spread across them *is* the sensitivity analysis, computed exactly once. Deriving it from what the
    report already contains means the table can never disagree with the results chapter above it.
    """
    blocks: list[dict] = [rm.heading(t("checks.sensitivity", lang), 2)]
    subjects = [s for s in data.get("subjects") or [] if s.get("results")]
    varied = [s for s in subjects if s.get("scenario")]
    if len(subjects) < 2 or not varied:
        blocks.append(rm.note(t("checks.no_scenarios", lang)))
        return blocks

    rows: list[list[str]] = []
    for row in sensitivity_rows(data):
        # Lowest and highest sit side by side in one row, so they get the same decimals — the whole
        # point of the row is comparing them.
        lo_text, hi_text = fmt_column([row["lowest"], row["highest"]], lang)
        spread = row["spread_percent"]
        rows.append(
            [
                row["method_label"],
                row["unit"],
                lo_text,
                hi_text,
                f"{fmt_number(float(spread), lang)} %" if spread is not None else "—",
            ]
        )

    blocks.append(
        rm.prose(
            t("checks.sensitivity_intro", lang).format(
                count=fmt_number(float(len(subjects)), lang),
                scenarios=fmt_number(float(len(varied)), lang),
            )
        )
    )
    if rows:
        blocks.append(
            rm.table(
                [
                    t("table.indicator", lang),
                    t("table.unit", lang),
                    t("table.lowest", lang),
                    t("table.highest", lang),
                    t("table.spread", lang),
                ],
                rows,
                caption=t("caption.sensitivity", lang),
                align_right=[2, 3, 4],
                label="t-sensitivity",
            )
        )
    # A variant that returned the baseline is a row of the table saying nothing, and it looks exactly
    # like a robust result. Said in words, because the table cannot say it (improvement 1).
    unmoved = unmoved_variants(data)
    if unmoved:
        blocks.append(rm.note(t("checks.unmoved_variants", lang).format(names=", ".join(unmoved))))
    # Each variant against the first, per indicator, in percent — the table a reader builds in the
    # margin of the results matrix. Arithmetic on numbers the chapter above already prints, so it
    # cannot disagree with them.
    delta_rows = delta_rows_for(data, lang)
    if delta_rows:
        # One row per indicator and variant, not one column per variant: three variant names as column
        # heads wrapped word by word in columns two centimetres wide and ran over them.
        # A name in a body cell wraps like any other text.
        blocks.append(
            rm.table(
                [
                    t("table.indicator", lang),
                    t("table.unit", lang),
                    t("table.subject", lang),
                    t("table.score", lang),
                    t("table.change", lang),
                ],
                delta_rows,
                caption=t("caption.deltas", lang),
                align_right=[3, 4],
                label="t-deltas",
            )
        )
    # Where the ranking turns over between indicators — the one thing a comparison across categories
    # can honestly say, and it is arithmetic (`report_data.trade_offs`).
    turns = data.get("trade_offs") or []
    if turns:
        items = ", ".join(
            t("checks.trade_off_item", lang, variant=str(x.get("highest") or ""), indicator=str(x.get("method_label") or ""))
            for x in turns
        )
        blocks.append(rm.prose(rm.esc(t("checks.trade_offs", lang, items=items))))
    elif len(subjects) > 1 and len(rows) > 1:
        blocks.append(rm.prose(rm.esc(t("checks.no_trade_offs", lang))))
    return blocks


def delta_rows_for(data: dict[str, Any], lang: str) -> list[list[str]]:
    """Per indicator and variant: the score, and the change against the first variant in percent.

    The first variant's row carries the reference value and no change; every other row of the same
    indicator says how far it moved from it. Rows in indicator order, variants in report order.
    """
    subjects = [s for s in data.get("subjects") or [] if s.get("results")]
    if len(subjects) < 2:
        return []
    rows: list[list[str]] = []
    for base_row in subjects[0]["results"]:
        label = base_row.get("method_label") or ""
        unit = str(base_row.get("unit") or "")
        base = float(base_row.get("score") or 0.0)
        scores = [base]
        for s in subjects[1:]:
            match = next((r for r in s["results"] if (r.get("method_label") or "") == label), None)
            scores.append(float(match.get("score") or 0.0) if match is not None else None)
        # One decimals rule per indicator, so the column reads like the results matrix above it.
        texts = fmt_column([v for v in scores if v is not None], lang)
        it = iter(texts)
        for s, score in zip(subjects, scores, strict=True):
            if score is None:
                rows.append([label, unit, str(s.get("label") or ""), "—", "—"])
                continue
            score_text = next(it)
            if s is subjects[0]:
                rows.append([label, unit, str(s.get("label") or ""), score_text, "—"])
                continue
            if not base:
                rows.append([label, unit, str(s.get("label") or ""), score_text, "—"])
                continue
            change = (score - base) / abs(base) * 100.0
            sign = "+" if change > 0 else ""
            rows.append([label, unit, str(s.get("label") or ""), score_text, f"{sign}{fmt_number(round(change, 1), lang)} %"])
    return rows



def _consistency(data: dict[str, Any], lang: str) -> list[dict]:
    """ISO 14044 §4.5.4 — were assumptions, methods and data applied consistently?

    Only the mechanically checkable part, on purpose. Whether the *modelling* was consistent is a
    judgement; whether every subject was scored with the same indicators, against one background
    database and at the same functional unit is arithmetic — and those are the three ways a comparison
    actually goes wrong in practice.
    """
    blocks: list[dict] = [rm.heading(t("checks.consistency", lang), 2)]
    subjects = [s for s in data.get("subjects") or [] if s.get("results")]
    prov = data.get("provenance") or {}
    checks: list[tuple[str, bool, str]] = []

    if subjects:
        sets = {tuple(sorted((r.get("method_label") or "") for r in s["results"])) for s in subjects}
        first = sorted(sets)[0] if sets else ()
        checks.append(
            (
                t("checks.same_methods", lang),
                len(sets) == 1,
                fmt_number(float(len(first)), lang) if len(sets) == 1 else t("checks.methods_differ", lang),
            )
        )

    background = str(prov.get("background") or "")
    # Only a model that draws on a background can fail to name it; one built without any has nothing
    # to name, and "named: no" read as a failed check.
    if background:
        checks.append((t("checks.one_background", lang), True, background))

    study = data.get("study") or {}
    unit = str(study.get("functional_unit") or "")
    checks.append((t("checks.functional_unit", lang), bool(unit), unit or t("checks.not_defined", lang)))

    amount = data.get("amount")
    checks.append(
        (
            t("checks.same_amount", lang),
            True,  # one amount is applied to every subject by construction — worth stating, not testing
            fmt_number(float(amount or 1.0), lang),
        )
    )

    rows = [[label, t("checks.yes", lang) if ok else t("checks.no", lang), detail] for label, ok, detail in checks]
    blocks.append(
        rm.table(
            [t("table.check", lang), t("table.result", lang), t("table.basis", lang)],
            rows,
            caption=t("caption.consistency", lang),
            label="t-consistency",
        )
    )
    return blocks


#: The LCIA method families PrismLCA ships, as they are spelled in a sentence. Only the stem and its
#: version are needed — the indicator behind it ("GWP100") is not part of the family name.
#:
#: An incomplete list costs a missed finding, never a false one, which is the trade this whole layer
#: makes everywhere: a badge that fires on correct wording stops being read.
_METHOD_FAMILY_IN_PROSE = re.compile(
    r"(?:EF|CML|IPCC|ReCiPe|TRACI|USEtox|EPS|IMPACT World\+|EN15804\+A2|Ecological Scarcity|"
    r"Ecological Footprint|Crustal Scarcity Indicator|Cumulative Energy Demand|Cumulative Exergy Demand)"
    r"(?:\s+v?[\d][\w.]*)?(?:\s+\d{4})?"
)


def _families_in_use(data: dict[str, Any]) -> list[str]:
    """The method families this report was actually computed with."""
    out: list[str] = []
    for result in data.get("results") or []:
        method = result.get("method")
        family = str(method[0]) if isinstance(method, (list, tuple)) and method else ""
        if family and family not in out:
            out.append(family)
    return out


#: A version marker written as "v" before the number, which is spelling rather than meaning: an author
#: writing "EF 3.1" for "EF v3.1" names the study's own method and must not be reported for it.
_VERSION_MARK = re.compile(r"\bv(?=\d)")


def _family_key(name: str) -> str:
    """A method family reduced to what identifies it — case, spaces, hyphens and the "v" dropped.

    The version itself is kept. "ReCiPe 2016" against a study computed with "ReCiPe 2008" is a real
    finding; "EF 3.1" against "EF v3.1" is a typist.
    """
    return _VERSION_MARK.sub("", name.lower()).replace(" ", "").replace("-", "")


def _same_family(named: str, family: str) -> bool:
    """Whether a name in prose and a computed family are the same thing.

    Prefix either way, so a sentence that says only "EF" matches a study computed with "EF v3.1" —
    naming a family without its version is normal prose, not a contradiction.
    """
    a, b = _family_key(named), _family_key(family)
    return bool(a) and bool(b) and (a.startswith(b) or b.startswith(a))


#: The study's own free-text fields, in the order the report prints them. Every one of them is author
#: prose that can name a method, and until V181 only `limitations` was read.
_AUTHOR_TEXT_FIELDS = (
    "goal",
    "scope",
    "functional_unit",
    "system_boundaries",
    "cutoff_criteria",
    "allocation",
    "system_allocation",
    "critical_review",
)

#: Sentence boundaries, coarsely — used only to bound the context a method name is read in. Splitting
#: too eagerly (at "v3.1", at "z. B.") shortens that context and therefore *loses* suppressions below,
#: which is the harmless direction.
_SENTENCE_BREAK = re.compile(r"[.;:!?\n]")

#: Words that turn a method name from a claim into a contrast: "not compared with ReCiPe", "instead of
#: CML 2001". Naming a method one did *not* use is ordinary scoping prose, and a check that fires on
#: ordinary prose is a check that gets switched off.
#:
#: In all five languages a study can be documented in, because these fields are written in the study's
#: documentation language, not the report's. Like the family list above, this can only ever silence a
#: finding, never invent one — which is why the bare Spanish/Portuguese "no" is left out: as the
#: Portuguese contraction ("no relatório") it would silence the check for a whole language.
_CONTRAST_IN_PROSE = re.compile(
    r"\b(?:not|without|instead|rather than|unlike|compared|comparison|comparable|neither|nor|"
    r"nicht|kein\w*|ohne|statt|stattdessen|anstelle|anstatt|weder|vergleich\w*|verglichen|"
    r"pas|sans|au lieu|plut\u00f4t|compar\u00e9\w*|comparaison|"
    r"sin|en lugar|en vez|comparado\w*|comparaci\u00f3n|"
    r"n\u00e3o|sem|em vez|em lugar|compara\u00e7\u00e3o|compar\u00e1vel)\b",
    re.IGNORECASE,
)


#: Words that make a short abbreviation a method name rather than a material. "EPS" is Environmental
#: Priority Strategies to this check and expanded polystyrene to a packaging engineer, and a report on a
#: balcony solar kit says the second one — that was V239. Kept in all five documentation languages, and
#: deliberately wide: an indicator name or the word "impact" near the abbreviation is support enough.
_METHOD_WORD_IN_PROSE = re.compile(
    r"\b(?:method\w*|famil\w*|indicator\w*|impact|assessment|characteri[sz]\w*|LCIA|"
    r"methode\w*|wirkungs\w*|indikator\w*|bewertung\w*|charakterisier\w*|"
    r"m\u00e9thode\w*|famille\w*|indicateur\w*|caract\u00e9risation|"
    r"m\u00e9todo\w*|metodolog\w*|familia\w*|indicador\w*|caracteriza\w*|impacto\w*|"
    r"m\u00e9todo|categoria\w*)\b",
    re.IGNORECASE,
)

#: Below this, an abbreviation is too short to stand on its own — it needs a version, a year or a word
#: from the vocabulary above beside it. Four keeps "IPCC" self-sufficient, which is the point: the
#: families that get named bare in prose are the long ones.
_SELF_SUFFICIENT_LENGTH = 4


def _stands_for_a_method(named: str, context: str) -> bool:
    """Whether a name in prose is long enough, or supported enough, to be read as a method family."""
    stem = re.split(r"\s+(?=[v\d])", named, maxsplit=1)[0]
    if len(stem) >= _SELF_SUFFICIENT_LENGTH or any(ch.isdigit() for ch in named):
        return True
    return bool(_METHOD_WORD_IN_PROSE.search(context))


def _context_of(text: str, index: int) -> str:
    """The sentence a match sits in, as far as a rough split can see it."""
    start = max((m.end() for m in _SENTENCE_BREAK.finditer(text, 0, index)), default=0)
    end = _SENTENCE_BREAK.search(text, index)
    return text[start : end.start() if end else len(text)]


def _foreign_family_in(text: str, used: list[str]) -> str | None:
    """The method family this text names that the study was not assessed with, if there is one.

    Narrow on purpose, and the narrowness is why the check is still worth reading. Two ways out:

    * The text names its **own** family somewhere. "Climate factors follow IPCC 2021 within EF v3.1"
      is correct and common, because EF's climate factors really are IPCC's.
    * The name stands in a sentence that says it was *not* used — "not compared against ReCiPe",
      "rather than CML". A study is allowed to say which methods it did not apply; that is scope,
      not a stale claim.
    * The name is a short abbreviation standing alone, with nothing beside it that reads as a method.
      "EPS" is a method family here and expanded polystyrene everywhere else; see below.
    """
    if not text or any(family in text for family in used):
        return None
    # The version tail of the pattern above is greedy about dots, so a sentence ending in "IPCC 2021."
    # hands back the full stop with the name — and the name is quoted back to the author.
    names = [
        (m.group(0).strip().rstrip(".,;:"), m.start()) for m in _METHOD_FAMILY_IN_PROSE.finditer(text)
    ]
    if any(_same_family(named, family) for named, _ in names for family in used):
        return None
    for named, at in names:
        context = _context_of(text, at)
        if _CONTRAST_IN_PROSE.search(context) or not _stands_for_a_method(named, context):
            continue
        return named
    return None


def declared_method_mismatch(data: dict[str, Any], lang: str) -> list[str]:
    """Study text that names a method family the study was not assessed with — and where it stands.

    A solar-lamp report printed "Ergebnis beruht auf IPCC 2021 GWP100 (Klimawirkung)" in chapter
    8.1 while every figure in it came from EF v3.1 — a leftover from an earlier version of the model,
    carried into the document because declared limitations are author text that nothing checks. The
    report has the method list right there; comparing the two costs nothing and needs no model.

    The PVC window study then made the same mistake one field over (V181): its `goal` declared the
    primary indicator as "Treibhauspotenzial (IPCC 2021, GWP100)", the Goal-and-scope chapter copied
    that faithfully into the printed document, and this check said nothing because it only read the
    limitations. Every ISO free-text field is author prose and every one of them can go stale, so all
    of them are read now — and the sentence names the field, because "a declared limitation" would
    send the author looking in the wrong chapter for a line that sits in the first one.
    """
    used = _families_in_use(data)
    if not used:
        return []
    study = data.get("study") or {}
    sources: list[tuple[str, str]] = [
        (t(f"field.{field}", lang), str(study.get(field) or "")) for field in _AUTHOR_TEXT_FIELDS
    ]
    sources += [
        (t("field.limitations", lang), str((item or {}).get("text") or ""))
        for item in study.get("limitations") or []
    ]

    out: list[str] = []
    for label, text in sources:
        named = _foreign_family_in(text, used)
        if not named:
            continue
        # Escaped: all three parts are outside text — the author's sentence supplies `named`, the
        # method list `used`, our own table the label — and this line ends up in a raw prose block (V170).
        line = t(
            "limits.method_mismatch",
            lang,
            field=rm.esc(label),
            named=rm.esc(named),
            used=", ".join(rm.esc(f) for f in used),
        )
        # Two limitations repeating the same stale method would otherwise print the same sentence twice
        # in one paragraph, which reads as two separate problems.
        if line not in out:
            out.append(line)
    return out


#: Phrases that claim an internal/automated review OF THE MODEL was carried out. Deliberately
#: narrow. "Modellprüfung" on its own is not here, because "strukturelle Modellprüfung (Prism Model
#: Health Check)" names a check that really does run, and flagging it would teach authors to stop
#: writing down what they did. What is caught is the claim of a *review*: a second opinion on the
#: model, which PrismLCA records when it happens and which therefore cannot be claimed for free.
_REVIEW_CLAIM_RE = re.compile(
    r"\b("
    r"modell[- ]?review|automatis(?:ierte|che)\s+modellpr[üu]fung|interne\s+modellpr[üu]fung"
    r"|model\s+review|automated\s+model\s+(?:review|check)|internal\s+review"
    r"|revue\s+(?:interne\s+)?du\s+mod[èe]le|revue\s+interne"
    r"|revisi[óo]n\s+(?:interna\s+)?del\s+modelo|revisi[óo]n\s+interna"
    r"|revis[ãa]o\s+(?:interna\s+)?do\s+modelo|revis[ãa]o\s+interna"
    r")\b",
    re.IGNORECASE,
)

#: A denial reads like a claim to a regex. "Keine automatisierte Modellreview" is the honest form of
#: exactly this sentence, and printing a contradiction under it would be the worst possible lesson.
_REVIEW_DENIAL_RE = re.compile(
    r"\b(kein[a-z]*|ohne|nicht|no|not|none|without|sans|aucune?|sin|ninguna|sem|nenhuma)\b",
    re.IGNORECASE,
)


def claimed_review_not_run(data: dict[str, Any], lang: str) -> list[str]:
    """Study text that claims an internal model review, where none is on record.

    A balcony-solar study declared "Interne Qualitätskontrolle: strukturelle
    Modellprüfung (Prism Model Health Check) und automatisierte Modellreview". The health check had
    indeed run. The review had not — `review_model` was never called in that build — and the
    sentence would have gone into the printed report unchallenged, in the one field a reader
    consults to decide how much the numbers can be trusted (V234).

    This is the same shape as :func:`declared_method_mismatch`: author prose against a fact the
    report already holds. ``data["review"]`` is the outcome of the latest internal review and is
    empty exactly when none was ever recorded for this model.
    """
    if data.get("review"):
        return []
    study = data.get("study") or {}
    sources: list[tuple[str, str]] = [
        (t(f"field.{field}", lang), str(study.get(field) or "")) for field in _AUTHOR_TEXT_FIELDS
    ]
    sources += [
        (t("field.limitations", lang), str((item or {}).get("text") or ""))
        for item in study.get("limitations") or []
    ]

    out: list[str] = []
    for label, text in sources:
        m = _REVIEW_CLAIM_RE.search(text)
        if not m:
            continue
        # Only the words immediately before the claim can negate it; a "nicht" three sentences up
        # belongs to something else.
        if _REVIEW_DENIAL_RE.search(text[max(0, m.start() - 40) : m.start()]):
            continue
        line = t("limits.review_not_run", lang, field=rm.esc(label))
        if line not in out:
            out.append(line)
    return out


def critical_review_recorded(study: dict[str, Any]) -> bool:
    """Whether this study states that a critical review was carried out — read in exactly one place.

    The question is a yes/no, and until V191 it was answered from the free-text field `critical_review`
    by two rules pointing opposite ways: the §7.3.3 note treated *any* text as "there was a review",
    while the limitations chapter treated an *empty* field as "there was none". So a study that wrote
    one honest sentence lost both statements at once.

    And the sentence authors write there is almost always a negation — "Keine kritische Prüfung
    (interne Screening-Studie)". Of every study recorded here, not one filled the field affirmatively;
    one of them wrote out that a public comparative assertion *would* require a review under §7.3.3,
    and that very sentence suppressed the note saying so. The suppression had therefore never once
    fired for the case it exists for.

    The alternative was to read the text and suppress only on positive testimony — negation detection
    in five documentation languages. This project already keeps such a word list (`_CONTRAST_IN_PROSE`)
    under one rule: it may only ever *silence* a finding, never invent one, because a list that
    misfires then costs a finding rather than credibility. Here the direction is inverted — a list that
    misfires switches off a normative disclosure. That is not a trade this module is allowed to make,
    so the fact is asked for as a fact and the prose stays a description.

    Anything but the literal "yes" is "not confirmed", the answer that keeps the note.
    """
    return str((study or {}).get("critical_review_done") or "").strip().lower() == "yes"


def limitations_blocks(data: dict[str, Any], lang: str, title: str) -> list[dict]:
    """What the study did *not* do — and only when the author asked for the chapter.

    The author's decision was that a report should not volunteer negative sentences by default: a
    document full of "this was not calculated" reads defensively and pads the interpretation. So there
    is no hidden switch here — **the chapter is the switch**, and it is visible in the one place the
    author already looks.

    It *is* part of the default structure now, which reverses the second half of that
    earlier decision. The reasoning that changed it: a chapter nobody adds
    is a chapter nobody writes, professional practice gives limitations a section of their own, and a
    study with genuinely nothing to declare can delete the chapter in one click — which is a cheaper
    mistake than a report that never mentions its limits.

    Each item appears only if the thing really is absent, checked against the data rather than
    assumed — otherwise the chapter would start lying the day uncertainty analysis ships.
    """
    blocks: list[dict] = [rm.heading(title, 1)]
    items: list[str] = []

    if not (data.get("uncertainty") or {}):
        items.append(t("limits.no_uncertainty", lang))
    if not (data.get("data_quality") or {}):
        items.append(t("limits.no_data_quality", lang))
    # The same reading as the §7.3.3 note below, from the same helper: these two sentences are the two
    # halves of one fact, and while each read the free text for itself they contradicted each other.
    if not critical_review_recorded(data.get("study") or {}):
        items.append(t("limits.no_critical_review", lang))
    if not [s for s in data.get("subjects") or [] if s.get("scenario")]:
        items.append(t("limits.no_sensitivity", lang))
    # A declared limitation that contradicts the method selection — author text nothing else checks.
    items += declared_method_mismatch(data, lang)
    # And the same shape one field over: a claimed internal review that never ran (V234).
    items += claimed_review_not_run(data, lang)

    # The internal review's OUTCOME is limitations material and is printed below. Its *bookkeeping* is
    # not, and used to be: "An internal model review was carried out on <date>. Of its findings, 3
    # were fixed, 4 rejected with reasons, and 3 remain open. The model has been modified since that
    # review." — three sentences about the tooling, in a client's PDF, in the chapter a critical reader
    # checks first (V253, read out of a wood-stain report).
    #
    # A human author writes what is still open, not how many were closed and when. So the counters, the
    # date and the staleness note are gone; `review.open` below stays, because each entry is a
    # statement about the STUDY. The review is still recorded, still stamped against the model state,
    # and `claimed_review_not_run` still catches a study that claims a review it never ran — this only
    # stops the report narrating its own production.
    review = data.get("review") or {}

    # What the study itself declared, above what the report can check. The four above are the ones
    # arithmetic can answer — whether an analysis was run at all. They can never say that the result
    # rests on how much of a shower belongs to one hair wash, because nothing in the data knows it.
    # That judgement belongs to whoever built the model, and until it had somewhere to go it stayed in
    # a chat nobody reads and the chapter came out saying only what was mechanically absent.
    declared = [str(x.get("text") or "").strip() for x in ((data.get("study") or {}).get("limitations") or [])]
    declared = [x for x in declared if x]
    if declared:
        blocks.append(rm.heading(t("limits.declared", lang), 2))
        # A paragraph each: they are separate statements about separate things, and running them
        # together would read as one hedge. No list block exists, and inventing one to reach the
        # templates would be a lot of machinery for four sentences.
        # `markup`, not raw: this is the study author's own words, and a prose block is handed to the
        # compiler unescaped. A cut-off remark like "<0.2 % surfactants" opened a Typst label that
        # never closes, and the *whole* document then refused to compile ("unclosed label", V170) —
        # no PDF, no preview, no bundle export. `markup` carries their bold, italics and lists over
        # and escapes everything else, which is what the process notes already do.
        blocks += [rm.prose(rm.markup(rm.normalise_quotes(x))) for x in declared]
        if items:
            blocks.append(rm.heading(t("limits.checked", lang), 2))

    blocks.append(rm.prose(" ".join(items)) if items else rm.note(t("limits.none", lang)))

    # Findings the builder marked `open` after the review — acknowledged, unresolved, and exactly
    # what this chapter exists to declare. One paragraph each, like the declared limitations above.
    open_findings = [
        f for f in (review.get("open") or []) if str(f.get("finding") or "").strip()
    ]
    if open_findings:
        blocks.append(rm.heading(t("limits.review_open", lang), 2))
        for f in open_findings:
            text = str(f.get("finding") or "").strip()
            reason = str(f.get("reason") or "").strip()
            # Author text again, and through `markup` for the same reason as the declared items above.
            blocks.append(rm.prose(rm.markup(rm.normalise_quotes(f"{text} — {reason}" if reason else text))))
    return blocks


def critical_review_note(data: dict[str, Any], report: dict[str, Any], lang: str) -> list[dict]:
    """ISO 14044 §7.3.3 — the one statement about something absent that is not the author's to suppress.

    A comparative assertion disclosed to the public requires a critical review by interested parties.
    That is a requirement of the standard, not a matter of tone: a report that makes such a comparison,
    says it is for publication, and stays silent about the review is claiming a conformity it does not
    have. So this note is emitted outside the section list — it cannot be removed by dropping a chapter,
    in the same way the PrismLCA mark cannot be removed from the template.

    It appears only when all three conditions hold, which means an author who never marks a report as
    public never sees it. (Overridable if the author
    disagrees, but it should be a deliberate override.)

    The third condition is the study's *answer*, not the presence of a sentence about reviews — see
    `critical_review_recorded`. Silence and "no" both keep the note: a normative disclosure may be
    removed by a stated fact, never by a guess at what someone's prose meant.
    """
    options = report.get("options") or {}
    if not options.get("intended_public"):
        return []
    if len([s for s in data.get("subjects") or [] if s.get("results")]) < 2:
        return []
    if critical_review_recorded(data.get("study") or {}):
        return []
    return [rm.note(t("limits.iso_review_required", lang))]


def interpretation_blocks(data: dict[str, Any], health: dict | None, lang: str, title: str) -> list[dict]:
    """The whole chapter: heading, then the three checks in the order the standard names them."""
    return [
        rm.heading(title, 1),
        *_completeness(data, health, lang),
        *_sensitivity(data, lang),
        *_consistency(data, lang),
    ]
