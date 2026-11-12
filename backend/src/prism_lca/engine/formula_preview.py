"""What a formula would come to, before anything is written: the preview behind ``evaluate_formula`` and
the check an add runs before it links an input with its formula.

It evaluates expressions only — arithmetic, the maths functions and the conditional ``a if c else b``, the
forms a formula takes — in the namespace ``formula_namespace`` hardens (importing ``params`` applies it). Loops,
function definitions and the like are refused: the preview runs on the API's event loop, and a ``while True``
there would stop every other request.
"""

from __future__ import annotations

import ast
import keyword
import re

from prism_lca.engine.params import list_params
from prism_lca.errors import PrismError

#: asteval's own limit (``max_statement_length``), checked before anything parses the text.
MAX_FORMULA_CHARS = 50_000

#: Identifiers in a formula, so the answer can say which parameters it actually leaned on.
_IDENT_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")


def evaluate_formula(
    database: str,
    formula: str,
    overrides: dict[str, float] | None = None,
) -> dict:
    """Work out what a formula would come to, without touching the model.

    Building a parameterised exchange used to be a one-way step: write the expression, store it,
    recalculate, and only then see the number. The safe move was therefore to compute it by hand
    first and check afterwards — exactly the hand-arithmetic the parameters exist to remove. This
    answers "what would this be worth?" before anything is written, using the same parameter values
    the engine would.

    ``overrides`` replaces individual parameter values for this evaluation only — nothing is saved —
    which is what a what-if question needs: "and if the distance were 20 km?".

    A name the formula uses but the model does not define is reported as such: a mistyped parameter
    is the common case, and being told which name is unknown beats a stack trace.
    """
    from asteval import Interpreter

    values: dict[str, float] = {}
    for p in list_params(database):
        amount = p.get("amount")
        if isinstance(amount, (int, float)):
            values[str(p["name"])] = float(amount)

    unknown_overrides = sorted(set(overrides or {}) - set(values))
    values.update({k: float(v) for k, v in (overrides or {}).items()})

    text = formula or ""
    # asteval refuses a statement longer than this before it parses; the name check below parses first,
    # so the same limit stands in front of it.
    if len(text) > MAX_FORMULA_CHARS:
        raise PrismError(
            f"The formula is {len(text)} characters long; at most {MAX_FORMULA_CHARS} are evaluated.",
            code="formula_error",
            hint="A formula is one expression; split a long calculation into parameters.",
        )
    referenced = _names(text)
    # A minimal interpreter (no loops, no definitions) with the conditional switched back on: the write
    # accepts `p if p > 0 else 0`, and a preview that refused it would block a formula the write takes.
    interp = Interpreter(usersyms=dict(values), minimal=True, config={"ifexp": True})

    # Checked before evaluating: asteval reports an undefined name as a generic error, and the one
    # thing worth saying is WHICH name it was. Anything the interpreter already knows (min, max, abs,
    # the maths functions) is not a missing parameter — and neither is syntax: `p if p > 0 else 0`
    # used to be refused with "define 'if' and 'else' as parameters first".
    missing = sorted(n for n in referenced if n not in interp.symtable and not keyword.iskeyword(n))
    if missing:
        raise PrismError(
            f"Unknown name(s) in the formula: {', '.join(missing)}.",
            code="formula_error",
            hint="Define them as parameters first, or check the spelling against list_parameters.",
        )

    value = interp(text)
    errors = [err.get_error()[1] for err in getattr(interp, "error", [])]
    if errors:
        raise PrismError(
            f"Formula error: {errors[0]}",
            code="formula_error",
            hint="Use valid parameter names and operators.",
        )
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise PrismError(
            f"The formula did not produce a number (got {type(value).__name__}).",
            code="formula_error",
            hint="A formula must evaluate to a single numeric value.",
        )

    used = {n: values[n] for n in sorted(referenced & set(values))}
    out = {
        "formula": text,
        "value": float(value),
        "used": used,
        "overrides_applied": {k: float(v) for k, v in (overrides or {}).items()},
    }
    if unknown_overrides:
        # Overriding a name the model does not have is almost always a typo, and silently ignoring
        # it would make the answer look authoritative while it answered a different question.
        out["unknown_overrides"] = unknown_overrides
    return out


def _names(text: str) -> set[str]:
    """The names a formula reads, from its syntax tree: ``clip(p, a_min=0)`` reads ``clip`` and ``p``; the
    keyword ``a_min`` is no parameter. A formula that does not parse falls back to the words in it, and the
    interpreter then reports the syntax."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, RecursionError, ValueError, MemoryError):
        return set(_IDENT_RE.findall(text))
    return {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}

