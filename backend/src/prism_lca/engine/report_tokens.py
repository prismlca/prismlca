"""The placeholder grammar: what a token IS, and what it evaluates to without any pins.

Split out of ``report_data``: this module is the leaf — the token shapes
(`PLACEHOLDER`, `rank:`/`ref:` prefixes), the fixed derivation table, plain dotted-path lookup, unit
attribution and value formatting. Nothing here knows what a *binding* is: evaluating the language
UNDER the pins — which is most of its real use — lives in ``report_bindings``, and the report's data
snapshot itself is built in ``report_data``, which re-exports both halves so `report_data as rd`
stays the stable façade every consumer and test already imports.

Two names became public at this cut (`is_number`, `PERCENT_ARG_SUFFIXES`): they were module-privates
shared with the evaluation half, and a private imported across a module boundary is the pattern
an earlier refactor removed everywhere else.
"""
from __future__ import annotations

import re
from typing import Any

from prism_lca.engine.report_i18n import fmt_number, t
from prism_lca.engine.report_model import esc

#: `{{ path }}`, `{{ ref:label }}` or a derivation `{{ sum(a, b) }}`.
#:
#: Deliberately not a template language: a fixed set of named derivations over data paths, no operators,
#: no nesting, no user-defined anything. The reason it exists at all is that a comparative LCA sentence
#: needs arithmetic — "half of the footprint", "50 % higher than the baseline" — and the alternative was
#: what we had: the writer calculated it, wrote a literal, and the gate refused the chapter. Every
#: reproducible-reporting tool (Quarto's inline code, Evidence's SQL) lets the document compute; this is
#: that, reduced to what a report actually needs.
PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_.:\-\[\]]+(?:\([^{}()]*\))?)\s*\}\}")

#: The prefix that turns a member path into a *declared* claim to the top rank:
#: ``{{rank:contribution.groups.0}}`` in the sentence that makes the claim reads "I assert that the
#: member currently at index 0 of this magnitude-ranked list is the one this sentence is about", and it
#: prints that member's name.
#:
#: It exists because the alternative is reading intent out of prose, and that half of the claim gate is
#: where the defects came from: ten measured ones in four days (V205, V207–V213, V216), all in the
#: *matching* — an ambiguous word, a word inside a word, a typographic apostrophe, an inflection
#: tolerance that reaches unevenly per language, and finally a missing lemma that reached a delivered
#: PDF. A declaration needs none of it. Everything that judges a ranked citation — the identity pin, the
#: `based_on` comparison, the rank verdict, the correction brief, the renderer, the export gate — works
#: on the *path*, so a declaration is checked by machinery that already exists (`paths_in_token` hands
#: the path over and the prefix disappears), and the arithmetic decides instead of a word list.
#:
#: A prefix rather than a side channel for the same reason `ref:` is one: it sits in the sentence it is
#: about, so a rewritten sentence takes its claim with it and a moved sentence cannot leave it behind.
#:
#: The word lists keep their authority unchanged — a bare superlative is still flagged exactly as before
#: (`report_staleness.unanchored_claims`), never refused. Declaring is the better way to write it, not a
#: new obligation.
RANK_PREFIX = "rank:"

#: name -> (arity, function, returns_percentage). Arity None means "two or more".
#: A percentage carries its own sign, like the `…_text` values: a writer cannot append a unit it never saw.
DERIVATIONS: dict[str, tuple[int | None, Any, bool]] = {
    "sum": (None, lambda *v: sum(v), False),
    "diff": (2, lambda a, b: a - b, False),
    # a as a percentage of b — "end of life is X of the total". Deliberately SIGNED (a/b, not |a|/|b|):
    # with a credit in a credit total, percent(-5, -10) = +50 % reads right, and
    # with mixed signs the negative share ("recycling contributes -30 %") is exactly how contribution
    # tables state a burden that pulls the other way. Same reasoning for `factor`. Only `change` needed
    # |b| — it makes a *direction* claim.
    "percent": (2, lambda a, b: (a / b * 100.0) if b else None, True),
    # relative change from b to a — "X higher than the baseline". Divided by |b|: a baseline can be
    # negative in LCA (EoL credits, net-negative GWP), and (a-b)/b would then flip the sign — "-50 %"
    # for a value that *rose* from -20 to -10.
    "change": (2, lambda a, b: ((a - b) / abs(b) * 100.0) if b else None, True),
    # how many times a is b — "twice as much"
    "factor": (2, lambda a, b: (a / b) if b else None, False),
}

#: Derivations that fold several members into one figure, so their arguments are operands rather than
#: subjects: the result says nothing about any one of them, and nothing about their order. Variadic
#: arity *is* that property — every fixed-arity derivation above compares exactly two things, and a
#: comparison does go wrong when its two members swap places.
AGGREGATES: frozenset[str] = frozenset(name for name, spec in DERIVATIONS.items() if spec[0] is None)


def is_aggregate(token: str) -> bool:
    """Is this placeholder token a derivation that folds several members into one figure?"""
    return token.endswith(")") and token.partition("(")[0].strip() in AGGREGATES


def rank_path(token: str) -> str | None:
    """The member path inside a ``{{rank:…}}`` declaration, or None for any other token.

    Kept deliberately dumb — it only takes the prefix off. Whether the path *may* carry a rank claim is
    `rank_claim`'s question, and the two are separate because the answers have different jobs: every
    mechanism that walks paths (bindings, cited paths, the correction brief) wants the path whatever it
    turns out to name, and only resolution has to refuse a path that names the wrong kind of thing.
    """
    if not token.startswith(RANK_PREFIX):
        return None
    return token[len(RANK_PREFIX) :].strip() or None


def lookup(path: str, data: dict[str, Any]) -> Any:
    """Resolve a dotted path. Integer segments index into lists: ``results.0.score``."""
    node: Any = data
    for part in path.split("."):
        if part == "":
            return None
        if isinstance(node, dict):
            if part not in node:
                return None
            node = node[part]
        elif isinstance(node, (list, tuple)):
            if not part.lstrip("-").isdigit():
                return None
            index = int(part)
            if not -len(node) <= index < len(node):
                return None
            node = node[index]
        else:
            return None
    return node


def render_value(value: Any, lang: str, *, raw: bool = False) -> str:
    """Format a resolved value: numbers localised, text escaped unless `raw`.

    `raw` is for the values file that the compiled document reads: Typst inserts a string literally
    rather than re-parsing it, so escaping there would print the backslashes.
    """
    if isinstance(value, bool):
        # Localised like every other fixed string — "yes" stood untranslated in German prose.
        return t("bool.yes" if value else "bool.no", lang)
    if isinstance(value, (int, float)):
        return fmt_number(float(value), lang)
    if isinstance(value, (list, tuple)):
        joined = " / ".join(str(v) for v in value)
        return joined if raw else esc(joined)
    return str(value) if raw else esc(value)


def unit_of(path: str, data: dict[str, Any]) -> str | None:
    """The unit a numeric path is expressed in, or None when the data does not say.

    Shares are dimensionless by construction, but they come in two scales that must not mix: `…_percent`
    values are 0–100 and print a % sign, bare `share` values are 0–1 fractions. Labelling both "%" let
    `sum(g.0.share, g.1.share_percent)` pass the mixing check and add 0.5 to 30.0.

    For everything else the value's own companion key wins — `hotspots.0.direct` reads
    `hotspots.0.direct_unit` — because the *container's* `unit` can describe a different quantity
    entirely: a hotspot's `unit` is the process's physical unit while `direct` is an impact score, and
    attributing "kilogram" to it refused correct same-category arithmetic as an ISO violation. Only
    failing that is the unit read from the containers, which is right for the common table shape
    (`results.0.score` → the row's `unit`). None means "unknown", never "dimensionless": a check built
    on this must stay silent when it cannot tell, or it starts refusing correct sentences.
    """
    leaf = path.rsplit(".", 1)[-1]
    if leaf.endswith("_percent") or leaf == "percent":
        return "%"
    if leaf.endswith("_share") or leaf == "share":
        return "share"
    parts = path.split(".")
    if len(parts) > 1:
        parent = lookup(".".join(parts[:-1]), data)
        if isinstance(parent, dict):
            companion = parent.get(f"{leaf}_unit")
            if isinstance(companion, str) and companion.strip():
                return companion.strip()
    for cut in range(len(parts) - 1, 0, -1):
        node = lookup(".".join(parts[:cut]), data)
        if isinstance(node, dict):
            unit = node.get("unit")
            if isinstance(unit, str) and unit.strip():
                return unit.strip()
    return None


#: Suffixes that make a value a share, and therefore its own percentage. Kept next to the rule in
#: `derive`, which uses the same test to decide whether to print a sign.
PERCENT_ARG_SUFFIXES = ("_percent", "share_percent")


def prints_own_unit(token: str) -> bool:
    """Whether resolving this placeholder already produces a unit or a percent sign.

    `…_text` values do, `percent`/`change` do by definition, and a **`sum`** of shares does because the
    sum of two shares is a share. Anything else resolves to a bare number that a sentence still has to
    give a unit to.

    A **`diff`** of two shares deliberately does not: the difference between 18.9 % and 60.1 % is
    41.2 *percentage points*, not 41.2 %. Printing the sign made the writer add the words anyway, and
    the document read "sit only 2.4 % percentage points apart" — twice in an apple-juice
    run (V168). The bare number is the honest one, and the prose then has to name the unit, which the
    gate checks.
    """
    name = token.split("(")[0].strip()
    if token.endswith("_text"):
        return True
    if name in ("percent", "change"):
        return True
    if name == "sum":
        args = paths_in_token(token)
        return bool(args) and all(a.endswith(PERCENT_ARG_SUFFIXES) for a in args)
    return False


def paths_in_token(token: str) -> list[str]:
    """The data paths a placeholder token reads — one for a plain path, several inside a derivation.

    A ``rank:`` declaration reads the member it names, and this is the one line that makes the prefix
    disappear for everything downstream: the identity pin (`bindings_for`), the cited-path comparison
    (`report_staleness.cited_paths` asks the same question its own way), the rank verdict, the anchor
    the claim gate attributes a superlative to, and the sentence the correction brief locates by path
    (`report_patch._offsets_of_path`) all see `contribution.groups.0` and need to know nothing about
    declarations at all.
    """
    if token.startswith("ref:"):
        return []
    if (path := rank_path(token)) is not None:
        return [path]
    if not token.endswith(")"):
        return [token]
    _name, _, args = token[:-1].partition("(")
    return [a.strip() for a in args.split(",") if a.strip() and not is_number(a.strip())]



def subject_paths(token: str) -> list[str]:
    """The ranked members a superlative beside this token can be ABOUT — a subset of `paths_in_token`.

    A plain path or a `rank:` declaration is about itself. An aggregate (`sum`) is about nobody — the
    figure folds several members. A two-operand derivation is about its FIRST operand only: in
    "{{change(a, b)}} higher than …" the sentence speaks of `a`, and `b` is what `a` is measured
    against. Reading both operands as subjects refused a correct summary twice —
    "X has the highest result and Y the lowest; the highest is {{change(X, Y)}} higher than the lowest"
    was blocked over Y, the operand that had to be there for the comparison to exist (V334).
    """
    if is_aggregate(token):
        return []
    paths = paths_in_token(token)
    if token.endswith(")") and rank_path(token) is None:
        spec = DERIVATIONS.get(token.partition("(")[0].strip())
        if spec and spec[0] == 2:
            return paths[:1]
    return paths

def is_number(text: str) -> bool:
    try:
        float(text.replace(",", "."))
        return True
    except ValueError:
        return False


#: A backtick pair with a single placeholder inside it, and nothing else.
_FENCED = re.compile("`\\s*(" + PLACEHOLDER.pattern + ")\\s*`")


def unfence(text: str) -> str:
    """Drop backticks that wrap nothing but a placeholder.

    Writers set placeholders in code spans out of habit — `{{results.0.method_label}}` between
    backticks — and a score printed between backticks in the middle of a sentence is not what
    anybody meant. Removed here rather than forbidden in the prompt, because it fixes the chapters
    already written and does not depend on a model reading one more rule.

    ``report_model`` drops the fence around *any* span now, so for a rendered document this is the
    same answer reached twice. It still runs first, and on purpose: it takes the fence off before
    the placeholder is masked, so a mask can never end up inside a code span and the two rules can
    never meet. And it is the only one of the two that ``explain`` has — the editor does not go
    through the markup translator, and it has to show what the page will show.
    """
    return _FENCED.sub(r"\1", text or "")


def placeholders_in(text: str) -> list[str]:
    return [m.group(1) for m in PLACEHOLDER.finditer(text or "")]


#: `„{{X.label}}“ ({{rank:X}})` or `{{rank:X}} ({{X.label}})` — the same member named twice, once by its
#: label and once by the declaration that prints its name as well. Quotes and one pair of parentheses
#: may sit between; nothing else.
_DECLARATION_BESIDE_LABEL = re.compile(
    r"""(?P<q1>["„“”']?)\{\{\s*(?P<p1>[A-Za-z0-9_.\-\[\]]+)\.label\s*\}\}(?P<q2>["„“”']?)\s*\(\s*\{\{\s*rank:(?P<p2>[A-Za-z0-9_.\-\[\]]+)\s*\}\}\s*\)"""
    r"""|(?P<r1>["„“”']?)\{\{\s*rank:(?P<p3>[A-Za-z0-9_.\-\[\]]+)\s*\}\}(?P<r2>["„“”']?)\s*\(\s*\{\{\s*(?P<p4>[A-Za-z0-9_.\-\[\]]+)\.label\s*\}\}\s*\)"""
)


def declaration_beside_label(text: str) -> list[str]:
    """The ranked paths this text declares right beside their own label — the V402 habit."""
    out = []
    for m in _DECLARATION_BESIDE_LABEL.finditer(text or ""):
        if m.group("p1") and m.group("p1") == m.group("p2"):
            out.append(m.group("p2"))
        elif m.group("p3") and m.group("p3") == m.group("p4"):
            out.append(m.group("p3"))
    return out


def collapse_declaration_pairs(text: str) -> str:
    """Print `„{{X.label}}“ ({{rank:X}})` as one name — the declaration, which prints the label itself.

    The writer keeps putting the declaration BESIDE the label it declares, whatever the rule says
    (V402, again as V434: „Glykolether 5 % in der Rezeptur“ (Glykolether 5 %
    in der Rezeptur)). The stored text is left alone — the staleness check still sees both tokens, the
    declaration still pins the claim — only the printed sentence drops the duplicate. The quotes that
    wrapped the label wrap the declaration instead.
    """

    def fold(m: re.Match) -> str:
        if m.group("p1") and m.group("p1") == m.group("p2"):
            return f"{m.group('q1')}{{{{rank:{m.group('p2')}}}}}{m.group('q2')}"
        if m.group("p3") and m.group("p3") == m.group("p4"):
            return f"{m.group('r1')}{{{{rank:{m.group('p3')}}}}}{m.group('r2')}"
        return m.group(0)

    return _DECLARATION_BESIDE_LABEL.sub(fold, text or "")


def share_text(percent: float, lang: str) -> str:
    """A ready-to-print share: localised decimal mark, one decimal, percent sign.

    The one rule for shares that print INSIDE prose or a brief (`…share_text` fields everywhere).
    `report_render._percent` is deliberately a different rule (adaptive precision for table cells,
    where 0.4 % rounding to "0.4" and 0.04 % to "0.040" both have to stay readable in a column)."""
    return f"{fmt_number(round(percent, 1), lang, digits=1)} %"
