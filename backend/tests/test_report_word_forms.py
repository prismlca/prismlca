"""The offline list-authoring aid (`scripts/report_word_forms.py`) — two things worth nailing down.

The script itself is a proposal generator for a human and its output is deliberately not asserted
here: a test that pins the proposed forms would have to be edited every time a word list changes,
which is exactly the wrong direction of dependency. What is worth a test is the boundary it must not
cross, and the one place where it re-implements the gate.
"""
from __future__ import annotations

import functools
import importlib.util
import re
import sys
from pathlib import Path

import pytest

from prism_lca.engine import report_claims as rc

_ROOT = Path(__file__).resolve().parent.parent
_SCRIPT = _ROOT / "scripts" / "report_word_forms.py"


@functools.cache
def _tool():
    """Load the script by path — it lives in `scripts/`, which is deliberately not importable."""
    spec = importlib.util.spec_from_file_location("report_word_forms", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # Registered before execution because `@dataclass` resolves its annotations through
    # `sys.modules[cls.__module__]`, and an unregistered module has none.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_no_runtime_module_reaches_for_the_stemmer():
    """The rejected experiment, kept rejected.

    Snowball's German stemmer collapses *bedeutendste*/*wichtigste*/*höchste* to
    *bedeut*/*wichtig*/*hoch*, so stemming at match time blocked "Das bedeutet, dass…" — and 979
    tests stayed green while it happened. The conclusion was that the stemmer is an authoring aid and
    nothing else, which is a property of the import graph: no module the app ships may name it, and
    none may import the script either.
    """
    offenders = [
        path.relative_to(_ROOT)
        for path in (_ROOT / "src").rglob("*.py")
        if re.search(r"\b(snowballstemmer|report_word_forms)\b", path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


@pytest.mark.parametrize(
    ("entry", "sentence", "hit"),
    [
        # The tolerance, and where it stops — the arithmetic the whole script is about.
        ("domina", "el uso domina el resultado", True),
        ("domina", "los resultados están dominados por el uso", False),
        ("domina", "el uso sigue dominando el resultado", False),
        ("predomin", "el predominio del uso", True),
        # The fold: an entry without the accent still reaches the word with it.
        ("domine", "le bilan est dominé par l'emballage", True),
        # And the closing boundary that V209 put back.
        ("second", "secondary data was used", False),
    ],
)
def test_the_script_reads_the_tolerance_the_way_the_gate_does(entry, sentence, hit):
    """`_matches` mirrors `report_claims._mentions`; if it drifted, every "already reached" is a lie."""
    tool = _tool()
    spec = tool.BY_NAME["superlatives"]
    assert tool._matches(entry, sentence, spec, "es") is hit
    assert bool(rc._mentions((entry,), rc.fold(sentence))) is hit
