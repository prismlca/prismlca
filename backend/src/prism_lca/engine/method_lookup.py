"""Which installed LCIA method a caller means.

A method is named by a tuple of three strings, and nobody types them exactly: a model writes "EF 3.1 climate
change", a report stores "family / category / indicator", a user picks from a list. This module turns what was
written into the installed tuple, says which indicator of a category is the standard one (``recommended``), lists
a family, and — when nothing matches — names the nearest candidates, best first. Every caller resolves here: the
calculation, the report writer, the method editor and the HTTP API.
"""
from __future__ import annotations

import re

from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

# Method-name markers of SPECIALIST VARIANTS (not the standard reporting indicator of their
# category): sub-split climate indicators, long-term-exclusion variants, alternative time horizons.
# Everything else — the EF/ReCiPe/CML core categories and IPCC 'total' GWP100 — is `recommended`.
# The wrong variant is the single most error-prone step of a study (a 'biogenic'-only GWP is ~20x
# off), so both the UI picker and the AI assistant get this flag to steer the default choice.
_VARIANT_MARKERS = (
    "no lt",                       # long-term emissions excluded — specialist choice
    "climate change: biogenic",    # sub-split climate indicators
    "climate change: fossil",
    "climate change: land use",
    "biogenic emissions",
    "biogenic removals",
    "(incl. biogenic",             # the 'IPCC 2021 (incl. biogenic CO2)' family
    "slcf",                        # short-lived climate forcers
    "gwp20", "gwp500", "gtp",      # non-standard horizons / metrics
    "obsolete",
)


def _is_recommended(name: str) -> bool:
    low = name.lower()
    if any(marker in low for marker in _VARIANT_MARKERS):
        return False
    # Sub-split climate indicators, by SHAPE rather than by name. A climate CATEGORY (the middle
    # segment) is either plain ("climate change") or an aggregate ("climate change: total …");
    # anything else after the colon is one contribution of it. Naming the splits one by one kept
    # missing them — ecoinvent 3.12's IPCC 2021 family added "aircraft emissions" and spells land
    # use as "direct land use change", which the "climate change: land use" marker above does not
    # match. Five IPCC 2021 indicators came out `recommended` that way, and the first of them
    # alphabetically ("aircraft emissions") is ~7 orders of magnitude below the total.
    # Only the category is tested: ReCiPe's endpoint INDICATORS are named "climate change: human
    # health" etc. and are the reporting indicator of their own category ("human health").
    parts = [p.strip().lower() for p in name.split("·")]
    category = parts[1] if len(parts) > 2 else ""
    if category.startswith("climate change:") and not category[len("climate change:"):].lstrip().startswith("total"):
        return False
    # Within climate methods, GWP100 is the reporting standard.
    if "global warming potential" in low and "gwp100" not in low:
        return False
    return True


def _fold(text: str) -> str:
    """A method name reduced to what a human meant by it: lower case, no punctuation, "v3.1" as "3.1".

    Kept deliberately close to the same fold in the assistant's `list_methods` tool. Two copies of an
    algorithm is a cost; a name that the search finds and the calculation then rejects is a bigger one.
    """
    out = re.sub(r"\bv(\d)", r"\1", text.lower())
    out = re.sub(r"[^a-z0-9.]+", " ", out)
    return re.sub(r"\s+", " ", out).strip()


def _matches(words: list[str], name: str) -> bool:
    """Whether every word of a folded query appears in this method's name.

    Compared twice, as written and with spaces and dots squeezed out, so "ef3.1" finds "EF v3.1" and
    "GWP 100" finds "GWP100" — vendors write versions both ways and nobody should have to know which.
    """
    return _word_hits(words, name) == len(words)


def _word_hits(words: list[str], name: str) -> int:
    """How many words of a folded query appear in this name, compared the way `_matches` compares."""
    folded = _fold(name)
    squashed = folded.replace(" ", "").replace(".", "")
    return sum(1 for w in words if w in folded or w.replace(" ", "").replace(".", "") in squashed)


def _closest(words: list[str], n: int = 5) -> list[tuple]:
    """The installed methods nearest to a query that matched none, best first.

    Ranked by how many of the query's words a name carries, then by how many its FAMILY carries, the
    recommended indicator before its variants. Taking the first word alone offered Cumulative Energy Demand
    for an "EF v3.1 · acidification …" that missed by one word: "ef" is a substring of half the catalogue.
    """
    if not words:
        return []
    scored = []
    for order, m in enumerate(get_bd().methods):
        name = " · ".join(m)
        hits = _word_hits(words, name)
        if hits:
            family = _word_hits(words, str(m[0])) if m else 0
            scored.append(((-hits, -family, not _is_recommended(name), order), tuple(m)))
    scored.sort(key=lambda s: s[0])
    return [m for _rank, m in scored[:n]]


def list_methods(query: str | None = None, limit: int = 100) -> list[dict]:
    bd = get_bd()
    out: list[dict] = []
    for m in bd.methods:
        name = " · ".join(m)
        if query and query.lower() not in name.lower():
            continue
        meta = bd.methods[m]
        out.append(
            {
                "method": list(m),
                "name": name,
                "unit": meta.get("unit", ""),
                "num_cfs": meta.get("num_cfs"),
                "recommended": _is_recommended(name),
            }
        )
        if len(out) >= limit:
            break
    return out


def methods_in_families(methods) -> list[list[str]]:
    """Every installed method that shares a family with one of `methods`.

    What a printed indicator name has to be unique against (V203): the middle segment of a path is a
    name only where the *family* gives it to a single indicator, and that question cannot be answered
    from the handful of indicators a report selected. Takes the report's methods in either shape they
    are stored in — a tuple, or one "family / category / indicator" string.
    """
    families: set[str] = set()
    for m in methods or []:
        parts = m.split("/") if isinstance(m, str) else [str(p) for p in (m or [])]
        first = (parts[0] if parts else "").strip()
        if first:
            families.add(first)
    if not families:
        return []
    bd = get_bd()
    return [list(m) for m in bd.methods if m and str(m[0]) in families]


def _as_tuple(method) -> tuple:
    """A method as written, as a tuple of its parts.

    A string is a name, not a sequence of characters. Without this, `method="IPCC 2021 · …"` became
    `('I', 'P', 'C', 'C', …)` and the error read "LCIA method ['I','P','C','C',…] not found" — true,
    unusable, and the single most repeated mistake an assistant made in an earlier modelling session.
    """
    if isinstance(method, str):
        parts = [p.strip() for p in method.split("·") if p.strip()]
        return tuple(parts) if len(parts) > 1 else (method.strip(),)
    return tuple(str(p) for p in method)


def resolve_method(method) -> tuple:
    bd = get_bd()
    if not method:
        raise PrismError(
            "No LCIA method specified.",
            code="no_method",
            hint="Pass 'method' as a list of strings (see GET /api/v1/calc/methods).",
        )
    t = _as_tuple(method)

    if t in bd.methods:
        return t

    # Not an exact triple. The AI's `list_methods` has folded matching — punctuation, case and a "v"
    # before a version are ignored — and promises as much in its description, but resolution did not,
    # so a name that was found a moment ago failed to compute. Same rule here, and it is the *resolver*
    # that has it now, so every caller gets it: the tools, the report writer and the HTTP API.
    query = _fold(" ".join(t))
    words = query.split()
    if words:
        hits = [m for m in bd.methods if _matches(words, " · ".join(m))]
        if len(hits) == 1:
            return tuple(hits[0])
        # The same name spelt otherwise is not ambiguous because a longer name also carries its words:
        # "EF 3.1 · acidification · …" is the EF v3.1 indicator, not also its "no LT" twin.
        same = [m for m in hits if _fold(" ".join(m)) == query]
        if len(same) == 1:
            return tuple(same[0])
        if hits:
            # Several: naming them is the useful answer. Guessing is not — picking one of five climate
            # indicators for the user is how a study ends up reporting the wrong one.
            # The recommended ones first, the others still named: filtering to the recommended alone
            # answered "matches 4 methods — say which" with ONE candidate, and the variant a user asked
            # for by name (fossil only, GWP20) was not on the list to pick.
            names = [" · ".join(m) for m in hits]
            recommended = [n for n in names if _is_recommended(n)]
            others = [n for n in names if n not in recommended]
            if recommended:
                hint = "Recommended: " + " | ".join(recommended[:5])
                if others:
                    hint += ". Also matching: " + " | ".join(others[:5])
            else:
                hint = "Candidates: " + " | ".join(names[:5])
            raise PrismError(
                f"LCIA method {list(t)} matches {len(hits)} methods — say which.",
                code="method_ambiguous",
                status_code=404,
                hint=hint,
            )

    near = _closest(words)
    raise PrismError(
        f"LCIA method {list(t)} not found.",
        code="method_not_found",
        status_code=404,
        hint=(
            "Closest: " + " | ".join(" · ".join(m) for m in near)
            if near
            else "List available methods via GET /api/v1/calc/methods."
        ),
    )


#: Family-name markers of the twin variants an indicator set ships with. Asking for "EF v3.1" means the
#: standard family; the "no LT" twin (long-term emissions cut) and the "(incl. biogenic CO2)" family are
#: answers to a different question and appear only when named. Its own name on purpose: the module
#: already has `_VARIANT_MARKERS` for the per-INDICATOR recommendation flag, and a second definition
#: under that name silently replaced it — GTP100 came out "recommended".
_FAMILY_VARIANT_MARKERS = ("no lt", "no-lt", "incl. biogenic", "including biogenic")


def methods_in_family(family: str, include_variants: bool = False) -> list[list[str]]:
    """Every installed indicator of ONE method family, standard variants only unless asked.

    The whole-family read (all EF 3.1 categories, all of IPCC 2021) used to take two rounds — the family
    listing, then a methods list copied back by hand — and was therefore skipped for a single GWP. An
    exact family name wins; otherwise a case-insensitive substring match ("ef v3.1" finds "EF v3.1").
    """
    fam = (family or "").strip().lower()
    if not fam:
        return []
    bd = get_bd()
    names = sorted({str(m[0]) for m in bd.methods if m})
    hits = [n for n in names if n.lower() == fam] or [n for n in names if fam in n.lower()]
    if not include_variants and not any(k in fam for k in _FAMILY_VARIANT_MARKERS):
        hits = [n for n in hits if not any(k in n.lower() for k in _FAMILY_VARIANT_MARKERS)]
    keep = set(hits)
    return [list(m) for m in bd.methods if m and str(m[0]) in keep]


def resolve_methods(methods) -> tuple[list[tuple], list[dict]]:
    """Several methods, each resolved on its own: the installed tuples of those that resolve, and for each one
    that does not, what was asked, why it failed and the way out (``{method, code, error, hint}``).

    One misspelt indicator among five used to fail all five — the four valid scores were never computed, and
    the caller learned only of the first mistake. A caller that can use a partial answer takes both lists.
    """
    found: list[tuple] = []
    missing: list[dict] = []
    for m in methods or []:
        try:
            found.append(resolve_method(m))
        except PrismError as exc:
            missing.append(
                {"method": m if isinstance(m, str) else list(m or []), "code": exc.code, "error": exc.message, "hint": exc.hint}
            )
    return found, missing


def none_resolved(missing: list[dict]) -> PrismError:
    """The error for a request in which no method resolved: every failure named, each with its way out."""
    if len(missing) == 1:
        only = missing[0]
        status = 400 if only["code"] == "no_method" else 404
        return PrismError(only["error"], code=only["code"], status_code=status, hint=only["hint"])
    ambiguous = all(m["code"] == "method_ambiguous" for m in missing)
    return PrismError(
        f"None of the {len(missing)} LCIA methods resolved, so nothing was computed: "
        + " ".join(f"({i}) {m['error']}" for i, m in enumerate(missing, 1)),
        code="method_ambiguous" if ambiguous else "method_not_found",
        status_code=404,
        hint=" ".join(f"({i}) {m['hint']}" for i, m in enumerate(missing, 1) if m.get("hint")) or None,
    )


def require_installed(methods: list, owner: str, hint: str) -> None:
    """Refuse a stored list of methods (a report's indicators) in which some no longer stand for themselves,
    naming each one, so the owner of the list can choose again rather than guess.

    Stricter than :func:`resolve_method`, which is forgiving on purpose — for what someone types now. A
    stored identity that is gone (a custom method deleted, a family the background does not ship) must
    not quietly become the one installed method that still carries all its words: a deleted "EF v3.1"
    indicator would resolve to its "no LT" twin and print another indicator's numbers under the report's
    name for it. Accepted are the installed tuple itself and the same name spelt differently (case,
    punctuation, "v3.1" for "3.1").
    """
    reasons: list[str] = []
    for m in methods or []:
        try:
            found = resolve_method(m)
        except PrismError as exc:
            reasons.append(exc.message)
            continue
        asked = _as_tuple(m)
        if found != asked and _fold(" ".join(asked)) != _fold(" ".join(found)):
            reasons.append(
                f"LCIA method {list(asked)} is not installed; the only near match, '{' · '.join(found)}', has "
                "another name and may be another indicator."
            )
    if not reasons:
        return
    raise PrismError(
        f"{owner} include {len(reasons)} method(s) that do not resolve to one installed method: "
        + " ".join(reasons),
        code="method_not_installed",
        hint=hint,
        details={"reasons": reasons},
    )
