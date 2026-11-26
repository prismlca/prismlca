"""What a failed LCA build means to the person who asked for it.

Brightway raises its own exceptions while it builds and solves a system; left alone they reach the window as
"Unexpected server error". The builders (``lca.get_lca`` and Monte Carlo) run ``lci()``/``lcia()`` inside these
translators, which turn the cases a model can be in into a ``PrismError`` that says what is missing.
"""
from __future__ import annotations

from contextlib import contextmanager

from prism_lca.errors import PrismError


@contextmanager
def explaining_an_empty_system():
    """Nothing in the system emits or takes anything — a new model whose processes have no flows yet — and
    Brightway refuses an empty characterisation with EmptyBiosphere; this says what is missing instead."""
    from bw2calc.errors import EmptyBiosphere

    try:
        yield
    except EmptyBiosphere as exc:
        raise PrismError(
            "Nothing to calculate yet: none of the processes in this calculation has an elementary flow "
            "(an emission or a resource), so there is nothing for an impact method to count.",
            code="no_elementary_flows", status_code=422,
            hint="Add an emission or a resource to a process (inspector → Outputs or Inputs), or link a "
            "background dataset that has them, then calculate again.",
        ) from exc
