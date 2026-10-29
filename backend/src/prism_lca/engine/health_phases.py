"""Health checks on how a model's tags (life-cycle phases) hang together: the structure of the phase
breakdown, as opposed to the inventory checks of ``health``, which reads these findings into its rules."""
from __future__ import annotations

from prism_lca.engine.tags import TagStore


def _phase_findings(database: str, adjacency: dict[tuple, set]) -> list[tuple[str, str, str, tuple]]:
    """Structural checks on how the tagged life-cycle phases hang together.

    The breakdown by tag (``phase_attribution``) follows the nearest tag on the path: a process
    inherits the value of the process that consumes it, its own tag overrides for itself and what
    is below it. A tag on the reference process therefore becomes every untagged process's value, and
    a step left untagged quietly counts under the phase above it.

    Returns ``(severity, code, message, activity_key)`` tuples; the caller resolves the key.
    """
    tag_map = TagStore().load_map()
    # Only dimensions this database actually uses, and only those with more than one value in it —
    # a dimension where every process carries the same value is not a phase split.
    tagged: dict[str, dict[tuple, str]] = {}
    for key, tags in tag_map.items():
        db, _, code = key.rpartition("/")
        if db != database or TagStore.is_exchange_key(key):  # an input's tag is no process of the graph
            continue
        for t in tags:
            tagged.setdefault(t["dimension"], {})[(db, code)] = t["value"]
    out: list[tuple[str, str, str, tuple]] = []

    # Who consumes whom, restricted to the foreground graph the linter already walked.
    consumers: dict[tuple, set] = {}
    for consumer, providers in adjacency.items():
        for provider in providers:
            consumers.setdefault(provider, set()).add(consumer)

    for dimension, values in tagged.items():
        if len(set(values.values())) < 2:
            continue

        # A node nothing else consumes is the reference process. Its tag is the fallback every
        # untagged activity in the model inherits, so a phase name on it is a phase name on the
        # study as a whole.
        mistagged_roots = {
            key
            for key in values
            if not consumers.get(key) and any(p in values for p in adjacency.get(key, ()))
        }
        for key in mistagged_roots:
            out.append(
                (
                    "warning",
                    "phase_tag_on_reference_process",
                    f"Nothing consumes this activity, so it is the reference process — yet it "
                    f"carries the phase tag '{values[key]}' ({dimension}). It is the functional unit, "
                    "not a phase, and every untagged activity in the model inherits this value. Clear it.",
                    key,
                )
            )

        # A chain of phases (Use consuming Distribution consuming Manufacturing) is a valid model: the
        # breakdown follows each process's own tag. What goes wrong silently is a step WITHOUT a tag — it
        # counts under the phase of whoever consumes it, with everything below it. Right for a helper two
        # phases share, wrong for a step that was forgotten; the finding says which phase it falls into.
        roots = {key for key in adjacency if not consumers.get(key)}
        for key, users in consumers.items():
            if key in values or key in roots:
                continue
            inherited = sorted({values[u] for u in users if u in values})
            if not inherited:
                continue
            phases = " and ".join(f"'{v}'" for v in inherited)
            out.append(
                (
                    "info",
                    "untagged_step",
                    f"This activity carries no {dimension} tag, so it counts under {phases} — the phase of "
                    "the process that consumes it — with everything below it. Right for a helper shared by "
                    "two phases; a step of its own (manufacturing, distribution, use, end of life) needs its "
                    "own tag.",
                    key,
                )
            )
    return out
