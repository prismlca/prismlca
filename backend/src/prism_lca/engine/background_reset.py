"""Starting over: what background data a workspace holds, and removing it on purpose.

Kept apart from the import (``ecoinvent.py``): these functions only delete, and they share with the
import nothing but its job state — a reset must not run under an import, and sets the job idle after.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable

from prism_lca import _log
from prism_lca.engine import geography_names
from prism_lca.engine.backgrounds import common as backgrounds
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.ecoinvent import (
    BIO_REVISION_KEY,
    BIO_SOURCE_KEY,
    BIOSPHERE_DB,
    COMPLETE_KEY,
    JobState,
    _assert_idle,
    _update,
)
from prism_lca.engine.guardrails import is_read_only, set_read_only
from prism_lca.engine.library import is_library
from prism_lca.errors import PrismError

#: How long an issued reset code stays valid. Short enough that a code cannot be lying around
#: from an earlier session, long enough to read the warning it belongs to.
RESET_CODE_TTL_SECONDS = 300

_reset_code: str | None = None
_reset_code_issued_at: float = 0.0


def _doomed_databases(bd) -> list[str]:
    """Every database a reset removes: the read-only backgrounds plus the biosphere."""
    names = [name for name in bd.databases if is_read_only(name)]
    if BIOSPHERE_DB in bd.databases and BIOSPHERE_DB not in names:
        names.append(BIOSPHERE_DB)
    return sorted(names)


def background_overview() -> dict:
    """What background data this project holds — and what starting over would cost.

    The cost is the point: a reset keeps the user's own models but leaves every exchange that
    pointed into the background dangling, so the numbers must be on screen *before* the
    confirmation, not in a sentence afterwards.
    """
    bd = get_bd()
    doomed = set(_doomed_databases(bd))

    biosphere = None
    if BIOSPHERE_DB in bd.databases:
        meta = bd.databases[BIOSPHERE_DB]
        biosphere = {
            "name": BIOSPHERE_DB,
            "flows": len(bd.Database(BIOSPHERE_DB)),
            "revision": meta.get(BIO_REVISION_KEY),
            "source": meta.get(BIO_SOURCE_KEY),
        }

    # ``complete``: a database imported before PrismLCA recorded the flag is not suspect — only an
    # empty one is, so the activity count decides and the flag merely confirms.
    background = []
    for name in doomed:
        if name == BIOSPHERE_DB:
            continue
        info = backgrounds.registry(name)
        background.append(
            {
                "name": name,
                "activities": len(bd.Database(name)),
                "complete": bool(bd.databases[name].get(COMPLETE_KEY))
                or len(bd.Database(name)) > 0,
                **(info.as_dict() if info else {"provider": None, "label": name, "version": ""}),
            }
        )

    # ``prism_custom`` is the only thing that marks a user's own method (see lcia_methods).
    methods = list(bd.methods)
    custom = sum(1 for m in methods if bd.methods[m].get("prism_custom"))

    models = []
    for name in sorted(bd.databases):
        if name in doomed:
            continue
        dangling = 0
        for activity in bd.Database(name):
            for exchange in activity.exchanges():
                if exchange.input[0] in doomed:
                    dangling += 1
        models.append(
            {
                "name": name,
                "activities": len(bd.Database(name)),
                "dangling_exchanges": dangling,
                # The library is writable like a model and would be left dangling like one, so it
                # belongs in this list — but it is not a study, and calling it one miscounts the
                # models on screen.
                "kind": "library" if is_library(name) else "foreground",
            }
        )

    return {
        "project": bd.projects.current,
        "biosphere": biosphere,
        "background": background,
        #: Providers that may still be imported: both on a bare project, the
        #: missing one when one is present, none when both are.
        "offered": backgrounds.offered_providers(),
        "methods": {"total": len(methods), "custom": custom},
        "models": models,
    }


def remove_background(name: str, drop_index: Callable[[str], bool] | None = None) -> dict:
    """Remove ONE background database — the way back when a second import failed
    or was the wrong one, without taking the other background down with it.

    Refuses while any model or the library still points into it (names them). Leaves the
    biosphere and the methods alone, except for the flows this import created that nothing
    references any more.
    """
    bd = get_bd()
    if not backgrounds.is_background(name):
        raise PrismError(
            f"'{name}' is not a background database of this workspace.",
            code="not_a_background",
            status_code=404,
        )
    users: dict[str, int] = {}
    for other in bd.databases:
        if other == name or other == BIOSPHERE_DB or backgrounds.is_background(other):
            continue
        n = 0
        for activity in bd.Database(other):
            for exchange in activity.exchanges():
                if exchange.input[0] == name:
                    n += 1
        if n:
            users[other] = n
    if users:
        raise PrismError(
            f"'{name}' is still used by {', '.join(f'{k} ({v} exchanges)' for k, v in users.items())}.",
            code="background_in_use",
            status_code=409,
            hint="Re-point or remove those exchanges first; a dangling background would leave "
            "them without numbers.",
        )
    was_ecoinvent = backgrounds.database_of(backgrounds.PROVIDER_ECOINVENT) == name
    set_read_only(name, False)
    bd.Database(name).delete(warn=False)
    try:
        del bd.databases[name]
    except Exception as exc:  # noqa: BLE001 - already gone
        _log.swallowed(exc, "remove_background")
    if was_ecoinvent:
        geography_names.forget()
    if drop_index is not None:
        drop_index(name)
    removed_flows = 0
    if BIOSPHERE_DB in bd.databases:
        from bw2data.backends import ExchangeDataset

        referenced = {
            row.input_code
            for row in ExchangeDataset.select(ExchangeDataset.input_code)
            .where(ExchangeDataset.input_database == BIOSPHERE_DB)
            .distinct()
        }
        for node in list(bd.Database(BIOSPHERE_DB)):
            if node.get("prism_origin") == name and node["code"] not in referenced:
                node.delete()
                removed_flows += 1
    bd.databases.flush()
    from prism_lca.engine.lca import invalidate_lca_cache

    invalidate_lca_cache()
    return {"database": name, "flows_removed": removed_flows}


def issue_reset_code() -> dict:
    """Hand out a fresh four-digit code that :func:`reset_background` will demand.

    Issued by the backend rather than the window, so the confirmation is a real gate: nothing
    can delete the background data without having asked for a code first and read what came
    back with it.
    """
    global _reset_code, _reset_code_issued_at
    _reset_code = f"{secrets.randbelow(10000):04d}"
    _reset_code_issued_at = time.monotonic()
    return {"code": _reset_code, "expires_in": RESET_CODE_TTL_SECONDS}


def _check_reset_code(code: str) -> None:
    global _reset_code
    if _reset_code is None:
        raise PrismError(
            "No reset code has been issued.",
            code="reset_code_missing",
            status_code=409,
            hint="Request a code first (POST /api/v1/setup/background/reset-code) — it is what "
            "makes this deletion deliberate.",
        )
    if time.monotonic() - _reset_code_issued_at > RESET_CODE_TTL_SECONDS:
        _reset_code = None
        raise PrismError(
            "The reset code has expired.",
            code="reset_code_expired",
            status_code=409,
            hint="Request a new one and confirm within five minutes.",
        )
    # The code is NOT cleared on a mismatch: a typo should cost a retry, not a new warning.
    if (code or "").strip() != _reset_code:
        raise PrismError(
            "That is not the code shown.",
            code="reset_code_invalid",
            status_code=403,
            hint="Type the four digits exactly as displayed.",
        )


def reset_background(code: str, drop_index: Callable[[str], bool] | None = None) -> dict:
    """Delete this project's background data so it can be imported again.

    Removes the read-only background databases, the biosphere, every impact method and the
    search indexes of the deleted databases. Keeps the user's own models — including the
    exchanges that now point nowhere, which is why the overview reports them beforehand.

    Every method goes, not only the imported ones: a custom method's factors are stored against
    biosphere flow ids that are about to disappear, so keeping it would leave a method that
    silently characterises nothing.
    """
    global _reset_code
    # Deleting the background under a running import would also set the job idle without stopping
    # it — and idle is what lets a workspace switch through (assert_no_import_running), so the import
    # would write on into whatever workspace came next.
    _assert_idle()
    _check_reset_code(code)

    bd = get_bd()
    doomed = _doomed_databases(bd)

    removed_methods = 0
    for method in list(bd.methods):
        bd.Method(method).deregister()
        removed_methods += 1

    removed_databases = []
    for name in doomed:
        # These are read-only by design, so this goes around the guardrail deliberately rather
        # than through the repository's delete, which refuses exactly this.
        set_read_only(name, False)
        bd.Database(name).delete(warn=False)
        try:
            del bd.databases[name]  # deregister if delete() kept the entry
        except Exception as exc:  # noqa: BLE001 - already gone
            _log.swallowed(exc, "reset_background")
        if drop_index is not None:
            drop_index(name)
        removed_databases.append(name)
    geography_names.forget()

    bd.databases.flush()
    from prism_lca.engine.lca import invalidate_lca_cache

    invalidate_lca_cache()

    _reset_code = None  # single use
    _update(state=JobState.idle, step="", detail="", project=bd.projects.current, database=None)
    return {"databases": removed_databases, "methods": removed_methods}
