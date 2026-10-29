"""Finding scenarios by the ids a caller passes, and saying what exists when one is not there.

Scenario ids are 32 hex characters, and the assistant copies them out of earlier answers deep into a long
context — a character dropped or swapped is the usual way a comparison fails. A bare "not found" sent it to
retry the same id; so the refusal names the closest id with its scenario's name, and the scenarios of the
model, which settles it in one step. It suggests and never substitutes: a near id may be another variant.
"""
from __future__ import annotations

import difflib

from prism_lca.errors import PrismError

#: How many of the model's scenarios the refusal lists by name; the rest are counted.
LISTED = 12
#: A shared start this long is a copy of that id with a slip in it, not chance (ids are random hex).
SAME_START = 8


def require(data: dict[str, dict], scenario_ids: list[str], database: str | None) -> list[dict]:
    """The scenarios behind ``scenario_ids``, in order — or one refusal naming every id that is not there,
    before anything is calculated."""
    missing = [sid for sid in scenario_ids if sid not in data]
    if missing:
        raise not_found(data, missing, database, before_calculation=True)
    return [data[sid] for sid in scenario_ids]


def not_found(
    data: dict[str, dict], missing: list[str], database: str | None, *, before_calculation: bool = False
) -> PrismError:
    """The refusal for ids that name no scenario: per id the closest one (or the scenario of that NAME, when a
    name was passed for an id), and the model's scenarios as ``'name' = id``."""
    pool = [e for e in data.values() if database is None or e.get("database") == database]
    quoted = ", ".join(f"'{sid}'" for sid in missing)
    lines = [
        (f"Scenario {quoted} does not exist" if len(missing) == 1 else f"Scenarios {quoted} do not exist")
        + (" — nothing was calculated." if before_calculation else ".")
    ]
    for sid in missing:
        named = [e for e in pool if str(e.get("name", "")).casefold() == sid.casefold()]
        if len(named) == 1:
            lines.append(f"'{sid}' is the name of a scenario, not its id: its id is '{named[0]['id']}'.")
            continue
        near = _closest(sid, pool)
        if near:
            lines.append(
                f"Closest id to '{sid}': '{near['id']}' ('{near.get('name', '')}') — use it only if that is the "
                "scenario you meant."
            )
    if database is None:  # no model to list: the scenarios of every model would mislead
        hint = "list_scenarios lists the scenarios of a model with their ids."
    elif pool:
        shown = "; ".join(f"'{e.get('name', '')}' = {e['id']}" for e in pool[:LISTED])
        # Whether this is the whole list: told it is, a scenario that is not on it is one to create.
        count = f"first {LISTED} of {len(pool)}" if len(pool) > LISTED else f"all {len(pool)}"
        more = "; the rest via list_scenarios" if len(pool) > LISTED else ""
        hint = f"Scenarios of '{database}' ({count}): {shown}{more}. Copy ids exactly from here or from list_scenarios."
    else:
        hint = f"'{database}' has no scenarios yet. Create one with edit_scenario."
    return PrismError(" ".join(lines), code="scenario_not_found", status_code=404, hint=hint)


def _closest(sid: str, pool: list[dict]) -> dict | None:
    """The scenario whose id ``sid`` is most plausibly a slipped copy of, if any."""
    def start(e: dict) -> int:
        n = 0
        for a, b in zip(sid, e["id"], strict=False):
            if a != b:
                break
            n += 1
        return n

    best = max(pool, key=start, default=None)
    if best is not None and start(best) >= SAME_START:
        return best
    ids = {e["id"]: e for e in pool}
    hit = difflib.get_close_matches(sid, list(ids), n=1, cutoff=0.75)
    return ids[hit[0]] if hit else None
