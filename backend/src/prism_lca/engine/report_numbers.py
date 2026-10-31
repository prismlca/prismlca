"""The gate's rules about figures in a chapter's prose.

Two rules, both contract findings a second reader cannot overrule (`report_review.CONTRACT_FINDINGS`):

* `literal_number` — a figure typed out where a placeholder belongs. Typed out, it is right on the day
  it was written and wrong after the next recalculation. Where the remedy is beyond argument, the
  finding carries its own substitution and the gate carries it out (`apply_repairs`).
* `unit_mismatch` — a placeholder followed by a unit that is not the one its figure prints in.

How a number and the unit after it are read is `prose_numbers`; what every value of the snapshot prints
as is `report_printed`.
"""
from __future__ import annotations

import re
from typing import Any

from prism_lca.engine import prose_numbers as pn
from prism_lca.engine import report_data as rd
from prism_lca.engine import report_printed
from prism_lca.engine import units as units_of

#: Fields whose *text* may legitimately contain a number a chapter quotes: the study's own wording and the
#: descriptive parts of a dataset. Nothing computed.
_QUOTABLE_FIELDS = ("description", "classification", "product", "name", "location", "flow", "compartment")

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
    if pn.unit_family_after(text, end) is None:
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
    if pn.inside_quotes(text, start):
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

    Nothing here interprets. A repair is applied only where `_repair_for` or `_printed_remedy` has
    already established that the substitution prints the same quantity it replaces, and only where the
    exact string still
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


def _without_placeholders(text: str) -> tuple[str, list[int]]:
    """The text with every placeholder blanked to one space, and where each of its characters stood.

    Literals are looked for in the RAW text with the placeholders removed — searching the resolved text
    would flag every correctly used placeholder, since resolving one produces exactly a number. The
    positions say where a finding stands in the chapter itself (`at`), which is what tells two typed
    "55 %" in two sentences apart.
    """
    parts: list[str] = []
    where: list[int] = []
    pos = 0
    for m in rd.PLACEHOLDER.finditer(text):
        parts.append(text[pos : m.start()])
        where.extend(range(pos, m.start()))
        parts.append(" ")
        where.append(m.start())
        pos = m.end()
    parts.append(text[pos:])
    where.extend(range(pos, len(text)))
    return "".join(parts), where


def literal_number_findings(
    text: str,
    data: dict[str, Any],
    *,
    researched: str = "",
    noted: str = "",
    lang: str = "en",
) -> list[dict[str, Any]]:
    """The `literal_number` findings of `check_proposal` — every figure typed out that should be a
    placeholder, each with where it stands (`at`, an offset into `text`) and the placeholder that prints
    it where one does.

    `researched` and `noted` are the research findings and the exchange notes, for a chapter that is
    shown them (`report_prompts._SPECIALIST_FACTS`): a figure quoted from either is a quotation.
    """
    without_placeholders, where = _without_placeholders(text or "")
    out: list[dict[str, Any]] = []
    # Numbers that appear in the *descriptions* we handed over are quotations, not inventions. A scope
    # saying "a 20 g bag delivered over 300 km" makes those figures part of the contract; so does an
    # ecoinvent dataset description saying a plant burns at 700–875 °C, which two different models quoted
    # and both had refused. Flagging them teaches the writer to hide the very facts that explain a result.
    #
    # Result figures are deliberately NOT in here, and neither are lookup results: those have placeholders
    # (or, for a lookup, no way to stay correct), so they must not be typed out. A research finding's
    # figure is: a published figure about something outside this model, sourced, and not one a
    # recalculation moves — the reason a lookup's figure is refused does not apply to it.
    quotable = _quotable_text(data)
    method_units = pn.method_units(data)
    # The exchange notes likewise ("the supplier ships 1200 km by lorry") — but never a figure in an
    # indicator's unit: a producer's "0.42 kg CO2-Eq per bottle" would vouch for the same figure typed as
    # this model's result, and no recalculation would move it.
    indicator_units = {pn.UNIT_ALIASES.get(u, u) for u in method_units}
    noted_figures = [
        (n, unit) for n, end in pn.numbers_in(noted)
        if not ((unit := pn.unit_signature(noted, end, method_units))
                and (unit[1] or pn.signature_key(unit)[0] in indicator_units))
    ]
    quoted_numbers = {pn.number_key(n) for text in (quotable, researched) for n, _end in pn.numbers_in(text)}
    quoted_numbers |= {pn.number_key(n) for n, _unit in noted_figures}
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
            (pn.number_key(n), pn.signature_key(unit))
            for n, n_end in pn.numbers_in(text)
            if (unit := pn.unit_signature(text, n_end, method_units)) is not None
        }

    research_units = with_units(researched)
    quoted_units = with_units(quotable) | research_units
    quoted_units |= {(pn.number_key(n), pn.signature_key(unit)) for n, unit in noted_figures if unit}
    entries: list[report_printed.Printed] | None = None
    for number, end in pn.numbers_in(without_placeholders):
        bare = number.rstrip(".,")
        # The year shape only counts when nothing unit-like follows: "amounts to 1350 MJ" used to pass
        # as "the year 1350" and freeze a result figure in the text. Small numbers (0–19) are counts
        # ("the 3 phases", "two of the 4 scenarios") — but only while no physical unit follows: "12 kg
        # CO2-Eq" passed as a count, unbound and never checked for staleness. An input
        # quantity from the scope ("the 2 kg bottle") is still let through below, as a quotation.
        small_unit: tuple[str, bool] | None = None
        if pn.ALLOWED_LITERALS.match(bare):
            if len(bare) < 4:
                small_unit = pn.unit_signature(without_placeholders, end, method_units)
                if small_unit is None:
                    continue
                # A small figure with a unit is a quotation only with the SAME unit: every scope names
                # its "1 kg" functional unit or "12 bottles", and matching the number alone would let
                # "1 kg CO2-Eq" or "12 kg" through on the strength of them. "The 2 kg bottle" from the
                # goal stays quotable — unless it is a parameter's current value, like any figure.
            elif not pn.unit_follows(without_placeholders, end, method_units):
                continue
        named = parameter_numbers.get((pn.number_key(number), pn.unit_family_after(without_placeholders, end)))
        if named and not _same_quantity(without_placeholders, end, method_units, named, data):
            # The leading symbol matched and nothing else did: "2 kg CO2-Eq" is a result, not the 2 kg
            # fill mass. Bound to the parameter, it would print "3 kg CO2-Eq" after a recompute with no
            # finding at all. It stays a plain refusal until a result reference is written.
            named = None
        written_unit = (
            small_unit if small_unit is not None else pn.unit_signature(without_placeholders, end, method_units)
        )
        quoted = (
            (pn.number_key(number), pn.signature_key(written_unit)) in quoted_units
            if written_unit is not None
            else pn.number_key(number) in quoted_numbers
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
            and (pn.number_key(number), pn.signature_key(written_unit)) in research_units
        )
        # Not a parameter: perhaps a value the document prints — exactly (a repair, or a refusal that
        # names it) or nearly (a refusal that names the candidates). The index is built once, and only
        # for a chapter that has such a figure at all.
        printed: dict[str, Any] = {}
        if named is None:
            if entries is None:
                entries = report_printed.index(data, lang)
            # Parameters that both hold this value are no ground for a substitution either: whichever
            # value the sentence means, a coin toss between them stays one (`_parameter_number_keys`).
            contested = (pn.number_key(number), pn.unit_family_after(without_placeholders, end)) in parameter_numbers
            printed = _printed_remedy(
                without_placeholders, number, end, written_unit, entries, lang, contested=contested and not (
                    written_unit is not None and written_unit[1]
                )
            )
        out.append(
            {
                "kind": "literal_number",
                "names": [bare],
                "at": where[end - len(number)],
                # How to repair it, when the repair is beyond argument. Present only where every one
                # of the conditions in `_repair_for` or `_printed_remedy` holds; absent means "a person
                # or a model has to decide this one". See `apply_repairs` for what is done with it (V267).
                **(_repair_for(without_placeholders, number, end, named, data) if named and not cited else {}),
                **({"repair": printed["repair"]} if printed.get("repair") else {}),
                **({"candidates": printed["candidates"]} if printed.get("candidates") else {}),
                "detail": printed.get("detail") or (
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
                    else f"The figure {bare} {pn.written_unit(without_placeholders, end)} is written out. "
                    "If it is a result, write the placeholder from your brief that prints it — typed out, "
                    "it will be wrong the next time the model is recomputed. If it is an input quantity "
                    "(a mass, a distance, a pack size), it may stay only as the study metadata, a process "
                    "note or a parameter states it; where none of them does, leave the figure out of the "
                    "sentence. Never put a placeholder that means a different quantity in its place, and "
                    "never invent a placeholder name."
                    if small_unit
                    else f"The number {number} is written out. Reference it as a placeholder instead, "
                    "or it will be wrong the next time the model is recomputed."
                ) + printed.get("hint", ""),
            }
        )
    return out


def sign_before(text: str, start: int) -> str:
    """The sign written right before a figure ("-4.2", "−4.2", "+12") — not the hyphen of a range
    ("10-12") or of a name ("CO2-12")."""
    if start and text[start - 1] in "-\u2212+" and (start < 2 or not text[start - 2].isalnum()):
        return text[start - 1]
    return ""


#: Close values named in one refusal. More is a list to choose from, not a hint.
_NEAR_SHOWN = 3


def _printed_remedy(
    text: str,
    number: str,
    end: int,
    written_unit: tuple[str, bool] | None,
    entries: list[report_printed.Printed],
    lang: str,
    *,
    contested: bool = False,
) -> dict[str, Any]:
    """What the printed-form index offers for a typed figure no parameter claims (V460).

    Returns any of: `repair`, the substitution, when it is beyond argument; `detail`, a refusal naming
    the placeholder(s) that print exactly this figure; `hint`, a sentence naming values close to it, to
    follow the general refusal. Empty when the index knows nothing about the figure.

    The substitution is carried out only when **all** of these hold, and each is a way it went wrong
    or could have:

    * the figure is exactly what one value prints, sign and decimal mark included — a rounded or a raw
      figure ("4 %" for −4.2 %, "55" for 0.548) may mean something else and is only named;
    * the unit after it is that value's own, and there is one — without a unit nothing made the match
      specific;
    * no other value prints the same — two values that do are a choice, and the refusal lists both —
      and no two parameters hold it (`contested`);
    * the value is a result or a share (`report_printed._REPLACEABLE_ROOTS`), never the threshold, a
      check, a trade-off or a derivation;
    * it is not inside a quotation, not in scientific notation, and its exact string occurs once in the
      chapter (`apply_repairs`).

    Every substitution is reported to the reader (`repaired_literal`), because the one thing the
    arithmetic cannot rule out is a sentence about another quantity of the same size.
    """
    bare = number.rstrip(".,")
    start = end - len(number)
    sign = sign_before(text, start)
    unit = pn.signature_key(written_unit)[0] if written_unit is not None else None
    found = report_printed.claim(entries, bare, sign, unit, lang, bool(written_unit and written_unit[1]))
    shown = f"{sign}{bare}" + (f" {pn.written_unit(text, start + len(bare))}" if unit else "")
    threshold = next((e for e in found.exact if e.path == "report.significance_text"), None)
    if threshold is not None:
        # A share or a change of the same size may be what the sentence means ("transport adds 5 %"):
        # named beside the threshold, or the only placeholder on offer would be the wrong one.
        others = [e for e in found.exact if e is not threshold] + found.near[: _NEAR_SHOWN - 1]
        return {
            "candidates": _candidates([threshold, *others]),
            "detail": (
                f"{shown} is this report's significance threshold. Where the sentence names it, write "
                f"{{{{report.significance_text}}}} — it prints “{threshold.prints} %” and follows the report's "
                "setting; typed out, it stays behind when the setting changes."
                + (
                    " If the sentence means another figure of that size, write its placeholder: "
                    + "; ".join(report_printed.describe(e) for e in others)
                    + "."
                    if others
                    else ""
                )
            )
        }
    if len(found.exact) > 1:
        return {
            "candidates": _candidates(found.exact),
            "detail": (
                f"The figure {shown} is typed out, and more than one placeholder prints exactly that: "
                + "; ".join(report_printed.describe(e) for e in found.exact[:4])
                + ". Write the one this sentence is about — typed out, it will be wrong the next time "
                "the model is recomputed."
            )
        }
    if found.exact:
        e = found.exact[0]
        out: dict[str, Any] = {
            "candidates": _candidates([e]),
            "detail": (
                f"The figure {shown} is what {report_printed.describe(e)}. Write that placeholder — typed "
                "out, it will be wrong the next time the model is recomputed."
            )
        }
        repair = None if contested else _printed_repair(text, start - len(sign), start + len(bare), e, unit, bare)
        if repair:
            out["repair"] = repair
        return out
    if found.near:
        near = found.near[:_NEAR_SHOWN]
        # A candidate that prints a sign the sentence did not write: "4.2 % lower" with a placeholder
        # that prints "-4.2 %" reads "-4.2 % lower".
        signed = [e for e in near if e.prints[:1] in "+-\u2212" and not sign]
        return {
            "candidates": _candidates(near),
            "hint": (
                " Close to it in your brief: "
                + "; ".join(report_printed.describe(e) for e in near)
                + (
                    ". If the sentence means one of these, write its placeholder"
                    if len(near) > 1
                    else ". If the sentence means it, write the placeholder"
                )
                + " — it prints the figure as the document shows it"
                + (", sign included, so word the sentence around it (“changes by …”, not “… lower”)" if signed else "")
                + ". If the sentence means something else, leave the figure out of it."
            )
        }
    return {}


def _candidates(entries: list[report_printed.Printed]) -> list[dict[str, Any]]:
    """The placeholders a refusal names, for the author as well: what each prints, and whether it
    prints its own percent sign (a replacement then takes the typed one along)."""
    return [
        {
            "path": e.path,
            "label": e.label,
            "prints": f"{e.prints} %" if e.own_percent else e.prints,
            "own_percent": e.own_percent,
        }
        for e in entries[:_NEAR_SHOWN]
    ]


def _printed_repair(
    text: str, at: int, after: int, e: report_printed.Printed, unit: str | None, bare: str
) -> dict[str, Any] | None:
    """The substitution of the figure at `text[at:after]` (sign included) by `e`'s placeholder, or None
    where one of the conditions in `_printed_remedy` fails."""
    if not e.replaceable or e.fraction or e.symbol is None or unit is None:
        return None
    if "e" in bare.lower() or pn.inside_quotes(text, at):
        return None
    # The unit in full, and only an impact or a percentage: a mass that happens to share the figure and
    # the leading "kg" of a climate result is the mass, and an acidification figure in "kg SO2-Eq" is not
    # the climate result either.
    if not e.own_percent and e.symbol != "%" and not (e.characterised and report_printed.same_unit(text[after:].lstrip(), e)):
        return None
    placeholder = f"{{{{{e.path}}}}}"
    if e.own_percent:
        # The placeholder prints its own percent sign: the typed one goes with the figure.
        m = re.match(r"[ \u00a0\u202f]?%", text[after:])
        if not m:
            return None
        find, replace = text[at : after + m.end()], placeholder
    else:
        m = pn.UNIT_TOKEN.match(text[after:])
        if not m:
            return None
        find, replace = text[at : after + m.end()], placeholder + text[after : after + m.end()]
    shown = f"{e.prints} %" if e.own_percent else e.prints
    return {"find": find, "replace": replace, "path": e.path, "label": e.label, "prints": shown}


def _same_quantity(
    text: str, end: int, extra: frozenset[str], named: tuple[str, str], data: dict[str, Any]
) -> bool:
    """Whether the unit written after a number is the parameter's own kind of unit, in full.

    `_parameter_number_keys` matches by the leading symbol's family, which is right for "42 g" against
    a 0.042 kg parameter and wrong for "2 kg CO2-Eq" against a 2 kg one: a characterised unit is an
    impact, and no mass parameter is ever its value. Characterised on either side — never the same
    quantity; a parameter repair must be beyond argument (`_repair_for`), and this one is not.
    """
    signature = pn.unit_signature(text, end, extra)
    if signature is not None and signature[1]:
        return False
    try:
        unit = str((data.get("parameters") or [])[int(named[1].rsplit(".", 1)[1])].get("unit") or "")
    except (IndexError, ValueError, AttributeError):
        return False
    base = unit.split("/")[0].strip()
    lead = pn.unit_prefix(base.split(" ", 1)[0], extra) or ""
    return not pn.CHARACTERISED.search(base[len(lead):])


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
            key = (pn.number_key(f"{value:g}"), family)
            # A key two parameters both claim is not a finding, it is a coin toss. `setdefault` kept
            # the first and named it in the message, so the writer was told to bind its sentence to
            # whichever parameter happened to be earlier in the list. Harmless while this only ever
            # produced advice; not harmless now that `repair` below rewrites the sentence (V267).
            if key in out and out[key] != (name, f"parameters.{index}"):
                out[key] = None
            else:
                out.setdefault(key, (name, f"parameters.{index}"))
    return out



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


def _unit_symbol(unit: str | None, extra: frozenset[str]) -> str | None:
    """The leading unit symbol of a stored unit string ("kg" for "kg CO2-eq", "%" for "%"), or None
    when the string carries no unit the gate knows — unknown stays silent, as everywhere here."""
    if not unit:
        return None
    head = unit.split("/")[0].strip()
    if not head:
        return None
    lead = pn.unit_prefix(head.split(" ", 1)[0], extra)
    return pn.UNIT_ALIASES.get(lead, lead) if lead else None


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
    written = pn.UNIT_ALIASES.get(written, written)
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


def unit_mismatch_findings(
    text: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None
) -> list[dict[str, Any]]:
    """`unit_mismatch`: a numeric placeholder followed by a unit that is not the one it prints in.

    The literal-number rule guards figures typed out; this guards the figure the placeholder prints
    correctly and the unit the sentence puts beside it. Silent wherever the data does not say what
    unit a value carries, and wherever the placeholder prints its own (`…_text`, shares, percent).
    """
    out: list[dict[str, Any]] = []
    extra = pn.method_units(data)
    for m in rd.PLACEHOLDER.finditer(text):
        token = m.group(1).strip()
        if token.startswith(("ref:", "rank:", "study.")) or token.endswith("_text") or rd.prints_own_unit(token):
            continue
        expected = _expected_unit(token, data, bindings, extra)
        if expected is None:
            continue
        um = pn.UNIT_TOKEN.match(text[m.end() :])
        if not um:
            continue
        written_token = um.group(1).rstrip(".,;:!?")
        written = pn.unit_prefix(written_token, extra)
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
