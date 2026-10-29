"""Health checks on the shape of the foreground graph: one reference process that everything feeds, and no
process that reaches it twice.

A model is calculated from one process — the functional unit — and only what that process consumes,
directly or further down, is in the result. Every link can be valid on its own and the whole still be wrong
in two ways no per-activity check sees: a process nothing consumes is left out of the result, and a process
the reference process consumes while another step consumes it too is counted twice.

Both return ``(severity, code, message, activity_key)`` tuples; the caller resolves the key.
"""
from __future__ import annotations

from collections.abc import Callable

from prism_lca.engine.model import reference_candidates


def _roots(adjacency: dict[tuple, set]) -> set[tuple]:
    consumed = {p for provs in adjacency.values() for p in provs}
    return {key for key in adjacency if key not in consumed}


def two_ways_in(adjacency: dict[tuple, set], name_of: Callable[[tuple], str]) -> list[tuple[str, str, str, tuple]]:
    """A foreground process the reference process consumes *and* another foreground process does too.

    The signature of a half-finished restructure: a phase is hung under the reference process and
    the edge it used to hang from is never removed, so it is scaled in twice. Nothing per-activity
    can see it — each link is individually valid, and the existing double-count check only looks
    inside one activity's own inputs. The result is simply too high, quietly and by a lot.

    A shared intermediate consumed by two phases is fine and is not this: what makes it wrong is
    that one of the two consumers is the reference process, which is supposed to hold the phases
    and nothing else.
    """
    roots = _roots(adjacency)
    out: list[tuple[str, str, str, tuple]] = []
    for provider in {p for provs in adjacency.values() for p in provs}:
        via_root = {c for c in roots if provider in adjacency.get(c, ())}
        others = {c for c, provs in adjacency.items() if provider in provs and c not in roots}
        if not via_root or not others:
            continue
        root_name = ", ".join(sorted(name_of(r) for r in via_root))
        other_names = ", ".join(sorted(name_of(o) for o in others))
        out.append(
            (
                "warning",
                "counted_twice_via_two_paths",
                f"This process is consumed both by the reference process ('{root_name}') and by "
                f"'{other_names}'. Both amounts are added, so it is counted twice — usually because "
                "it was moved to hang under the reference process and the link it hung from before "
                "was never removed. Keep whichever path is the real one and delete the other.",
                provider,
            )
        )
    return out


def unreached(
    database: str, adjacency: dict[tuple, set], name_of: Callable[[tuple], str]
) -> list[tuple[str, str, str, tuple]]:
    """Processes nothing in the model consumes, apart from the one the model is calculated from.

    Such a process is in the model and on the canvas, and in no result: a life-cycle stage that was
    never hung under the functional unit, or the remains of a rebuild. Each link checks out, the model
    computes, and the stage is simply missing from the total. The reference process is the one the
    results and the report pick (``reference_candidates``), so "not in the result" is literally true.
    A model may hold an alternative on purpose; the message says so rather than calling it an error.
    """
    roots = _roots(adjacency)
    if len(roots) < 2:
        return []
    ranked = [(c["database"], c["code"]) for c in reference_candidates(database) if c["is_root"]]
    reference = next((key for key in ranked if key in roots), None)
    if reference is None:
        return []
    ref = name_of(reference)
    return [
        (
            "warning",
            "disconnected_process",
            f"Nothing in the model consumes this process, so it is not part of the result. The model "
            f"is calculated from '{ref}' (of the processes nothing consumes, the one that pulls in the "
            f"most), and only what '{ref}' consumes, directly or further down, counts. Link it where it "
            f"belongs — a life-cycle stage (delivered product, use, end of life) as an input of '{ref}', a "
            "step of the product's chain as an input of the step after it — or delete it if it is a "
            f"leftover. If it is an alternative you compare with '{ref}' on purpose, leave it.",
            key,
        )
        for key in sorted(roots - {reference}, key=name_of)
    ]
