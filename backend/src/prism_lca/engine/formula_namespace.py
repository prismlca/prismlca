"""The namespace formulas are evaluated in: asteval's default one, without file access and without output.

Three kinds of interpreter evaluate formulas: ours (``params.evaluate_formula``, ``sensitivity_fast``), bw2data's
recalculation and bw2parameters' ``ParameterSet``. Brightway takes no namespace from us, but every one of them
builds its own from asteval's module tables when it is created. So the entries that read or write files or print
are taken out of those tables, once, before anything evaluates a formula: the same tables with fewer entries, no
function of asteval or Brightway replaced. ``params`` does it when it is imported, and every formula the backend
evaluates is evaluated through that module or through ``sensitivity_fast``, which imports it.

The asteval and bw2parameters versions these tables were reviewed for are pinned in
``tests/test_formula_namespace.py``.
"""

from __future__ import annotations

import asteval.asteval
from asteval import Interpreter, astutils

#: Entries of asteval's default tables that read files (Python's ``open``, numpy's readers) or print (``info``).
REMOVED_NAMES: tuple[str, ...] = ("open", "fromfile", "fromregex", "genfromtxt", "loadtxt", "info")

#: Methods that write an array or a numpy scalar to a file: refused on every object, not on arrays only.
REFUSED_ATTRIBUTES: tuple[str, ...] = ("tofile", "dump")


def restrict() -> None:
    """Take file access and output out of every asteval interpreter created from now on. Idempotent.

    Raises if asteval no longer keeps these tables where they are expected: an interpreter that might still
    reach files is not one to evaluate formulas with.
    """
    astutils.LOCALFUNCS.pop("open", None)
    for name in REMOVED_NAMES:
        astutils.NUMPY_TABLE.pop(name, None)
    # Keyed by ``object``, the refusal applies to every value and every class a formula can name.
    refused = astutils.UNSAFE_ATTRS_DTYPES.get(object, ())
    astutils.UNSAFE_ATTRS_DTYPES[object] = tuple(dict.fromkeys((*refused, *REFUSED_ATTRIBUTES)))
    # ``print`` is put into each interpreter's table by its constructor, which copies its switch from these.
    asteval.asteval.DEFAULT_CONFIG["print"] = False
    asteval.asteval.MINIMAL_CONFIG["print"] = False
    _check()


def _check() -> None:
    for interp in (Interpreter(), Interpreter(minimal=True)):
        offered = sorted(n for n in REMOVED_NAMES if n in interp.symtable)
        if interp.config.get("print", True):
            offered.append("print")
        if offered:
            raise RuntimeError(f"asteval still offers {', '.join(offered)} to formulas: its tables have moved.")
