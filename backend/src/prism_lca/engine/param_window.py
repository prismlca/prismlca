"""A crash marker for the reversible parameter windows — so a killed process cannot leave a model
standing in a scenario.

``scenarios.applied`` (and its siblings ``compute``/``compare``) apply a scenario by *writing* its
overrides into the model's parameters and writing the baseline back in a ``finally``. That
``finally`` is not a guarantee. SIGKILL, a power cut, or simply quitting the app while the
background freshness warm-up is solving (V214: five to eighty seconds of unattended computation
after every recalculation) all skip it, and what is left behind is a model whose baseline silently
*is* a variant. Nothing announces it; every later calculation is merely wrong. A "Write all
chapters" run holds such a window open for minutes.

So the window is written down before it is entered, and read back on the next start.

**What the marker can honestly know.** It records the baseline it is about to overwrite *and* the
values it is about to write. The second half is what makes an automatic restore provable rather than
hopeful: if a parameter still holds exactly the value this marker wrote, nobody has touched it since,
and putting the recorded baseline back puts the author's own number back. If it holds anything else —
the author edited it by hand between the crash and the restart — or if the parameter is gone
altogether, the marker cannot know what the author wants, and guessing would overwrite a deliberate
edit with a stale number. Those are named and left alone (see :func:`unresolved`), which is this
module's standing rule: fall silent, never assert what cannot be known.

A scenario also changes *formulas*: an override on a formula-driven parameter takes the formula out
for the window, and a formula override puts its own in. A frame names those under
``formulas`` with the formula before and the one written; the restore puts the old one back, and the
startup restore judges such a parameter by its formula first — the same "ours or theirs" test.

**Only the perturbed parameters are ever written back**, never the whole recorded baseline: a
parameter the window did not touch is none of the restore's business, and a hand edit to one of
those has to survive.

**Two processes are not a case here.** ``engine/instance_lock.py`` refuses a second backend against
the same data directory precisely because of this class of write, so a marker found on disk belongs
to a process that is gone. The pid is recorded for the *message*, never for the decision — the same
reasoning that module gives for not trusting a PID.

**The invariant, and its one limit.** Every path that writes parameter values into a model opens a
frame here first: the three in ``scenarios`` (applied/compute/compare), the three in ``sensitivity``
(tornado/sweep/break-even), the scenario half of ``montecarlo.compare_ab``, the per-subject window in
``compare`` and the one inside ``lca``'s per-subject contribution traversal. That list is pinned by a
test, because the limit of all this is easy to miss: **a missing marker is not evidence that a model
is clean.** It only means no *marked* window was interrupted. A future path that writes parameters
without opening a frame would be invisible to the startup restore and to the health linter alike, and
would look exactly like a model nothing ever touched. Anything added beside these windows belongs in
the list — and in this module.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import UTC, datetime
from pathlib import Path

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

logger = logging.getLogger(__name__)

MARKER_NAME = "param_window.json"
#: Version 2 adds the optional ``formulas`` of a frame (a scenario that took a parameter's formula out,
#: or put its own in). It is written only when a frame carries one, so a marker of a
#: window that touched no formula is exactly the version-1 marker it always was; and an older
#: PrismLCA
#: finding a version-2 marker reports it as unreadable instead of restoring the amounts and leaving the
#: formula out, which is the honest half of what it cannot do.
_VERSION = 2
_READABLE = (1, 2)

#: Guards both the file and the in-process frame stack below.
_LOCK = threading.RLock()

#: The windows THIS process currently holds open, innermost last. Its purpose is to tell "a window
#: is open right now" apart from "a window was left open by a process that died": the file looks
#: identical in both cases, and only the second one is a finding. A window that fails to restore
#: (``scenario_restore_failed``) is popped from here while its marker stays on disk — the model
#: really is still perturbed then, and that is exactly when it must be reportable.
_frames: list[dict] = []


def path() -> Path:
    return Path(get_bd().projects.dir) / "prism_meta" / MARKER_NAME


def _same(a: float, b: float) -> bool:
    """Equal as far as a float round-trip through JSON can tell."""
    return abs(float(a) - float(b)) <= 1e-12 + abs(float(b)) * 1e-9


def _write_frames(frames: list[dict]) -> None:
    """Replace the marker atomically **and durably**.

    The whole point is to survive a kill, so the bytes have to be on the platter before the call
    returns: write a temp file, ``fsync`` it, then rename. Without the fsync the rename can land
    while the content is still in the page cache, which is the one failure that would make this
    file a lie.
    """
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    version = _VERSION if any(f.get("formulas") for f in frames) else 1
    payload = {"version": version, "pid": os.getpid(), "frames": frames}
    tmp = p.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    tmp.replace(p)
    # The rename itself is only durable once the directory entry is — and a directory cannot be
    # opened for fsync on every platform, so this half is best effort.
    try:
        fd = os.open(p.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:  # pragma: no cover - Windows and some network filesystems
        pass


def _formula_entries(formulas: dict | None) -> dict[str, dict]:
    return {
        str(k): {"baseline": v.get("baseline"), "wrote": v.get("wrote")}
        for k, v in (formulas or {}).items()
        if isinstance(v, dict)
    }


def open_window(
    database: str, kind: str, label: str, baseline: dict, overrides: dict, formulas: dict | None = None
) -> dict:
    """Record a window before its overrides are written. Returns the frame, for :func:`close_window`.

    ``formulas`` names the parameters whose *formula* the window changes, as
    ``{name: {"baseline": <the formula it had or None>, "wrote": <the formula written or None>}}`` —
    see ``scenarios.plan``. :func:`restore_and_close` puts those formulas back, and the startup
    restore reads them to tell a formula the window wrote from one the author typed since.

    Raises rather than returning quietly if the marker cannot be written, and the caller must let
    that refuse the calculation. The safer direction is not obvious until the two failures are put
    side by side: without the marker, a refused calculation costs one loud, repeatable error, while
    an unmarked window costs a silently wrong model that nothing will ever announce. And the likely
    reason the marker cannot be written — the project directory gone, full or read-only — is the same
    reason the restore would fail, so this is precisely the moment not to enter the window.
    """
    frame = {
        "kind": kind,
        "label": label or "",
        "database": database,
        "opened": datetime.now(UTC).isoformat(),
        "project": str(getattr(get_bd().projects, "current", "")),
        "baseline": {str(k): float(v) for k, v in (baseline or {}).items()},
        "overrides": {str(k): float(v) for k, v in (overrides or {}).items()},
    }
    # What the model holds right now, beside ``overrides`` (every parameter the window ever touched):
    # only the current step makes a value "ours" — see set_overrides.
    frame["current"] = dict(frame["overrides"])
    if formulas:
        frame["formulas"] = _formula_entries(formulas)
    with _LOCK:
        _frames.append(frame)
        try:
            _write_frames(_frames)
        except Exception as exc:  # noqa: BLE001 - any failure here means we must not proceed
            _frames.pop()
            raise PrismError(
                f"Could not record that “{label}” is being applied to this model, so it was not "
                "applied.",
                code="param_window_marker_failed",
                hint=(
                    "PrismLCA notes a scenario's overrides on disk before writing them into the model, "
                    "so an interrupted calculation can be undone on the next start. Without that "
                    "note a crash would leave the model holding the scenario's values silently, so "
                    "the calculation is refused instead. Check that the workspace folder exists, is "
                    f"writable and has free space. ({type(exc).__name__}: {exc})"
                ),
                status_code=500,
            ) from exc
    return frame


def set_overrides(frame: dict, overrides: dict, formulas: dict | None = None) -> None:
    """Update an open frame's overrides — for a window that applies one scenario after another
    (``scenarios.compare``) without passing through the baseline in between. Same refusal on
    failure, for the same reason as :func:`open_window`. ``formulas`` as there, and unioned the same
    way: a formula an earlier scenario of the window took out stays named."""
    with _LOCK:
        previous = frame.get("overrides")
        previous_current = frame.get("current")
        previous_formulas = frame.get("formulas")
        previous_pending = frame.get("pending")
        # What the model holds until this transition's write is complete — the previous scenario's
        # state. Recorded beside the new one, because the write is row by row: a crash after this marker
        # and before (or in the middle of) the write leaves parameters in the previous state, and the
        # recovery has to accept that as ours too. :func:`settle` drops it
        # once the write is done.
        frame["pending"] = {
            # The previous STEP, not everything the window ever wrote: a value two steps back is no
            # longer in the model, even halfway through this write. A marker without ``current`` (an
            # older one) only has the union.
            "overrides": dict((previous_current if previous_current is not None else previous) or {}),
            "formulas": {str(k): v.get("wrote") for k, v in (previous_formulas or {}).items()},
        }
        if formulas or previous_formulas:
            new = _formula_entries(formulas)
            merged: dict[str, dict] = {}
            # A parameter an earlier scenario of the window touched stays named, and what it now holds is
            # updated on EVERY transition: a scenario whose plan does not name it writes the baseline
            # formula back (every apply writes the whole formula map), so that is what the model holds.
            # Keeping the earlier scenario's formula there made a crash in the next scenario look like a
            # hand edit, and the restore left the parameter perturbed.
            for name, entry in (previous_formulas or {}).items():
                merged[name] = {"baseline": entry.get("baseline"), "wrote": entry.get("baseline")}
            for name, entry in new.items():
                # The baseline is the first one recorded — the author's; what was written is the latest.
                base = merged[name]["baseline"] if name in merged else entry["baseline"]
                merged[name] = {"baseline": base, "wrote": entry["wrote"]}
            frame["formulas"] = merged
        # The union with what the frame already held, not a replacement: the recovery diagnosis
        # treats a parameter the marker does not name as never moved. A crash between "marker says
        # B" and "B is written" left the model in A with a marker that could not see A.
        # Harmless for the reading side — every apply writes the whole baseline plus overrides, so a
        # parameter of A is already back at base when B is in, and the recovery skips it.
        frame["overrides"] = {
            **(previous or {}), **{str(k): float(v) for k, v in (overrides or {}).items()}
        }
        # ...but only this step's values are in the model once it is written (``settle``). Owning a
        # value on the strength of the union let the restore take a hand edit back to the baseline
        # because an EARLIER step had once written the same number (a = 1.5, then b = 4 with a back
        # at 1; the author sets a = 1.5 after the crash).
        frame["current"] = {str(k): float(v) for k, v in (overrides or {}).items()}
        # The step this ``pending`` leads to. The recovery honours ``pending`` only while the frame still
        # describes that step — a pending entry left behind by a step the frame has since moved past is
        # spent, and trusting it would own a value two steps back.
        frame["pending"]["next"] = {
            "overrides": dict(frame["current"]),
            "formulas": {str(k): v.get("wrote") for k, v in (frame.get("formulas") or {}).items()},
        }
        try:
            _write_frames(_frames)
        except Exception as exc:  # noqa: BLE001 - see open_window
            frame["overrides"] = previous
            if previous_current is None:
                frame.pop("current", None)
            else:
                frame["current"] = previous_current
            if previous_pending is None:
                frame.pop("pending", None)
            else:
                frame["pending"] = previous_pending
            if previous_formulas is None:
                frame.pop("formulas", None)
            else:
                frame["formulas"] = previous_formulas
            raise PrismError(
                f"Could not record that “{frame.get('label') or ''}” is being applied to this "
                "model, so it was not applied.",
                code="param_window_marker_failed",
                hint=(
                    "PrismLCA notes a scenario's overrides on disk before writing them into the model. "
                    "Check that the workspace folder exists, is writable and has free space. "
                    f"({type(exc).__name__}: {exc})"
                ),
                status_code=500,
            ) from exc


def settle(frame: dict) -> None:
    """The write a :func:`set_overrides` announced is complete: the previous state is no longer in
    the model, so the marker stops accepting it.

    A marker that cannot be rewritten here is **not** harmless, though it once said so: it keeps
    owning the previous step, and a crash later leaves a hand edit equal to that step (b = 6) to be
    taken back by the recovery. The disk cannot tell that
    marker from one whose write really was interrupted, so the fix has to be here: retry, and if it
    will not go, refuse to go on — the caller's ``finally`` restores the baseline and closes the
    window, the same trade :func:`open_window` makes. What stays uncovered is a crash *during* that
    restore on top of the failed write; that marker then still owns the previous step."""
    import time

    with _LOCK:
        pending = frame.pop("pending", None)
        if pending is None:
            return
        last: Exception | None = None
        for attempt in range(3):
            try:
                _write_frames(_frames)
                return
            except Exception as exc:  # noqa: BLE001 - see open_window
                last = exc
                time.sleep(0.05 * (attempt + 1))
        frame["pending"] = pending  # what the disk still says
        raise PrismError(
            f"Could not record that a step of “{frame.get('label') or ''}” is complete, so the "
            "calculation was stopped and the model put back.",
            code="param_window_marker_failed",
            hint=(
                "PrismLCA notes each step on disk so an interrupted calculation can be undone on the next "
                "start. Check that the workspace folder exists, is writable and has free space. "
                f"({type(last).__name__}: {last})"
            ),
            status_code=500,
        ) from last


def close_window(frame: dict, *, restored: bool) -> None:
    """Drop a frame. The marker is removed only when the baseline is provably back in the model.

    ``restored=False`` is the case the field already produced: ``_restore`` exhausted its retries and
    raised ``scenario_restore_failed``. The overrides are still in the model, so the marker has to
    stay — for the next start, and for the health linter in the meantime.
    """
    with _LOCK:
        try:
            _frames.remove(frame)
        except ValueError:  # pragma: no cover - defensive: a frame closed twice
            pass
        if not restored:
            return
        try:
            if _frames:
                _write_frames(_frames)
            else:
                path().unlink(missing_ok=True)
        except OSError as exc:
            # The model is fine — the baseline is back. Only the note about it is stuck, and the next
            # start will read it, find nothing to restore and clear it.
            logger.warning("Could not clear the parameter-window marker: %s", exc)


def restore_baseline(
    database: str,
    baseline: dict[str, float],
    label: str,
    *,
    kind: str = "scenario",
    formulas: dict[str, str | None] | None = None,
) -> None:
    """Put the baseline parameters back — and never leave the model perturbed without saying so.

    Moved here from ``scenarios._restore`` when the sensitivity and Monte-Carlo windows were marked
    too (V218 follow-up): the retry below is the only thing that turns a transient SQLite lock into
    a restored model, and the longest windows in the app had the weakest restore. One restore for
    every window, so that cannot drift apart again.

    A window is entered by *writing* values into the model's parameters and writing the baseline back
    afterwards. The ``finally`` that does the writing back can itself fail: the parameter store is
    SQLite, and a second process holding the project file (two app instances in development, a stale
    backend after a rough kill) makes every write raise ``OperationalError``. It happened, and the
    consequence is the worst kind: **rendering a report — a read — left the model permanently in a
    scenario.** The study's baseline silently became its heat-pump variant, and the error the user saw
    named the render, not the model.

    A lock is no defence here, because the contention is between processes. So: retry, since these
    locks are transient and usually clear in milliseconds — and if it will not clear, raise an error
    that says the model was left changed and names the parameters, instead of returning quietly.

    ``formulas``: the formulas the window took out or replaced, written back with the amounts.
    """
    import time

    from prism_lca.engine import params

    last: Exception | None = None
    for attempt in range(5):
        try:
            params.apply_values(database, baseline, formulas)
            return
        except Exception as exc:  # noqa: BLE001 — the whole point is that any failure here is fatal to trust
            _log.swallowed(exc, "restore_baseline")
            last = exc
            time.sleep(0.1 * (attempt + 1))
    names = ", ".join(sorted(baseline)[:10]) or "(none)"
    subject = _labels([{"kind": kind, "label": label}])
    raise PrismError(
        f"The {subject} was applied to this model and could not be undone, so its parameters are "
        f"still overridden. Set them back before trusting any result: {names}.",
        # One code for one condition, and deliberately the established one: a sweep that cannot be
        # undone is the same failure as a scenario that cannot be undone, and a second code for it
        # would only split the thing the UI and the assistant already recognise.
        code="scenario_restore_failed",
        hint=(
            "The parameter store could not be written to — usually a second copy of the app, or a "
            f"leftover backend, holding this workspace. Close the other one and try again. ({last})"
        ),
    ) from last


def restore_and_close(database: str, baseline: dict[str, float], frame: dict) -> None:
    """The ``finally`` of every parameter window there is: restore, then drop the crash marker.

    The order is the whole point. :func:`restore_baseline` raises when the baseline could not be
    written, and the marker must survive exactly that — the model is still perturbed then, and the
    marker is what tells the next start (and the health linter in the meantime) which parameters are
    in doubt. Nothing else may close a window: pairing the two calls by hand at eight call sites is
    how one of them ends up closing a marker over a model that was never restored.
    """
    restored = False
    formulas = {str(k): v.get("baseline") for k, v in (frame.get("formulas") or {}).items()}
    try:
        restore_baseline(
            database,
            baseline,
            str(frame.get("label") or ""),
            kind=str(frame.get("kind") or ""),
            formulas=formulas or None,
        )
        restored = True
    finally:
        close_window(frame, restored=restored)


def read() -> dict | None:
    """The marker as it stands, or None if there is none."""
    p = path()
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("The parameter-window marker at %s could not be read: %s", p, exc)
        return {"unreadable": True}
    if not isinstance(data, dict) or not isinstance(data.get("frames"), list):
        return {"unreadable": True}
    if data.get("version") not in _READABLE:
        # A marker written by another version of PrismLCA. Restoring from a shape this code does not
        # know would be guessing with the author's parameters, so it is reported as unreadable —
        # which is what it is, whether the version is newer or older.
        logger.warning("The parameter-window marker has version %r, not one of %r.", data.get("version"), _READABLE)
        return {"unreadable": True}
    return data


def _diagnose(
    frames: list[dict], live: dict[str, float], live_formulas: dict[str, str | None] | None = None
) -> dict:
    """What the recorded window did to each parameter, and what the model holds now.

    ``target`` is the *earliest* recorded baseline (the author's own values, before any window
    touched them); ``written`` is the *last* value a window wrote (what the model must still hold
    for the restore to be provably ours). Nested windows are not reachable in today's code — every
    ``applied`` block holds the LCA lock across its whole span and none of them nests — but the
    marker is a stack anyway, so that if one ever does, this reads it correctly instead of
    interpreting the inner window's baseline as the author's.

    A parameter whose *formula* the window changed (a frame's ``formulas``) is judged by its formula
    first: the author's formula back is "already back", the formula the window wrote (or, where it took
    the formula out for a number, no formula and that number) is "ours", anything else is theirs.

    ``written`` comes from a frame's ``current`` — the step that is in the model — and not from its
    ``overrides``, which name every parameter the window ever touched: a value an earlier step wrote
    and a later one put back is not ours any more. A marker without ``current`` (written before it
    existed) falls back to the union, which is what it always did.
    """
    target: dict[str, float] = {}
    written: dict[str, float] = {}
    formula_base: dict[str, str | None] = {}
    formula_wrote: dict[str, str | None] = {}
    #: A transition still being written (``pending``, see set_overrides): the previous state, which a
    #: parameter may still hold — also ours.
    prev_written: dict[str, float] = {}
    prev_formula: dict[str, str | None] = {}
    for frame in frames:
        baseline = {str(k): float(v) for k, v in (frame.get("baseline") or {}).items()}
        in_model = frame.get("current") if isinstance(frame.get("current"), dict) else frame.get("overrides")
        overrides = {str(k): float(v) for k, v in (in_model or {}).items()}
        for name, value in baseline.items():
            target.setdefault(name, value)
        written.update({**baseline, **overrides})
        for name, entry in (frame.get("formulas") or {}).items():
            if not isinstance(entry, dict):
                continue
            formula_base.setdefault(str(name), entry.get("baseline"))
            formula_wrote[str(name)] = entry.get("wrote")
        pending = frame.get("pending")
        if isinstance(pending, dict) and not _pending_spent(frame, pending):
            before = {str(k): float(v) for k, v in (pending.get("overrides") or {}).items()}
            prev_written.update({**baseline, **before})
            for name, entry in (frame.get("formulas") or {}).items():
                if isinstance(entry, dict):
                    # Not named before this transition: the previous scenario left its baseline formula.
                    prev_formula[str(name)] = (pending.get("formulas") or {}).get(str(name), entry.get("baseline"))
    live_formulas = live_formulas or {}

    restore: dict[str, float] = {}
    restore_formulas: dict[str, str | None] = {}
    gone: list[str] = []
    changed: list[dict] = []
    for name, base in target.items():
        wrote = written.get(name, base)
        if name in formula_wrote:
            fb, fw = formula_base.get(name), formula_wrote[name]
            if name not in live:
                gone.append(name)
                continue
            current, cf = live[name], live_formulas.get(name)
            if cf == fb and (fb is not None or _same(current, base)):
                continue  # the author's formula (or plain value) is back
            prev = prev_written.get(name, base)
            ours_now = cf == fw and (fw is not None or _same(current, wrote))
            ours_before = name in prev_formula and cf == prev_formula[name] and (
                prev_formula[name] is not None or _same(current, prev)
            )
            if ours_now or ours_before:
                restore[name] = base
                restore_formulas[name] = fb
            else:
                changed.append(
                    {"name": name, "current": current, "wrote": wrote, "baseline": base,
                     "formula": {"current": cf, "wrote": fw, "baseline": fb}}
                )
            continue
        prev = prev_written.get(name)
        if _same(wrote, base) and (prev is None or _same(prev, base)):
            continue  # this window never moved this parameter
        if name not in live:
            gone.append(name)
            continue
        current = live[name]
        if _same(current, base):
            continue  # already back — a partial restore, or the author put it back by hand
        if _same(current, wrote) or (prev is not None and _same(current, prev)):
            restore[name] = base
        else:
            changed.append({"name": name, "current": current, "wrote": wrote, "baseline": base})
    return {"restore": restore, "restore_formulas": restore_formulas, "gone": sorted(gone), "changed": changed}


def _pending_spent(frame: dict, pending: dict) -> bool:
    """A ``pending`` whose step is not the one the frame now describes: the transition it guarded is
    over. A pending without ``next`` (an older marker) is taken at its word, as before."""
    nxt = pending.get("next")
    if not isinstance(nxt, dict):
        return False
    current = frame.get("current") if isinstance(frame.get("current"), dict) else frame.get("overrides")
    current = {str(k): float(v) for k, v in (current or {}).items()}
    want = {str(k): float(v) for k, v in (nxt.get("overrides") or {}).items()}
    if set(current) != set(want) or not all(_same(current[k], want[k]) for k in want):
        return True
    wrote = {str(k): v.get("wrote") for k, v in (frame.get("formulas") or {}).items() if isinstance(v, dict)}
    return wrote != {str(k): v for k, v in (nxt.get("formulas") or {}).items()}


def _labels(frames: list[dict]) -> str:
    """How to name the recorded windows in a sentence. A scenario has a name the author chose and
    will recognise; a comparison does not, so it is named by what it was."""
    out: list[str] = []
    for frame in frames:
        kind = str(frame.get("kind") or "")
        label = str(frame.get("label") or "")
        text = f"scenario “{label}”" if kind == "scenario" and label else (label or kind)
        if text and text not in out:
            out.append(text)
    return ", ".join(out) or "a calculation"


def _changed_phrase(entry: dict) -> str:
    formula = entry.get("formula")
    if formula:
        def state(f: str | None, amount: float | None) -> str:
            return f"formula {f}" if f else (f"{amount:g}" if amount is not None else "a plain value")

        wrote_amount = None if formula.get("wrote") else entry["wrote"]
        return (
            f"{entry['name']} (now {state(formula.get('current'), entry['current'])}; the calculation "
            f"set it to {state(formula.get('wrote'), wrote_amount)}, the recorded baseline is "
            f"{state(formula.get('baseline'), entry['baseline'])})"
        )
    return (
        f"{entry['name']} (now {entry['current']:g}; the calculation set it to {entry['wrote']:g}, "
        f"the recorded baseline is {entry['baseline']:g})"
    )


def _unresolved_message(database: str, frames: list[dict], diag: dict) -> str:
    sentences = [
        f"Model '{database}' may still hold the parameter values of {_labels(frames)}: a "
        "calculation was interrupted before it could put the baseline back."
    ]
    if diag["changed"]:
        sentences.append(
            "These have changed since, so PrismLCA has not touched them: "
            + ", ".join(_changed_phrase(e) for e in diag["changed"])
            + "."
        )
    if diag["gone"]:
        sentences.append(
            "These no longer exist, so their recorded baseline has nowhere to go: "
            + ", ".join(diag["gone"])
            + "."
        )
    sentences.append("Check them before trusting any result from this model.")
    return " ".join(sentences)


def open_now() -> dict | None:
    """The windows **this process** is holding open right now, named — or None when there are none.

    The counterpart of :func:`unresolved`, which is about a window some *dead* process left behind.
    Both answer the same question ("is this model standing in a scenario?") for the two halves of
    its lifetime, and both name the window the same way, so an author who reads the health linter's
    finding and an author whose Undo was just refused recognise it as one state and not two.

    Why anything outside this module needs to ask: an ``Undo`` written *into* an open window lands on
    the overridden values, and the ``restore_baseline`` in that window's ``finally`` then writes the
    pre-undo state back — the undo is undone, and nothing says so. So the command bus refuses while
    this returns something.
    """
    with _LOCK:
        if not _frames:
            return None
        return {
            "databases": list(dict.fromkeys(str(f.get("database") or "") for f in _frames)),
            "label": _labels(_frames),
        }


def unresolved(database: str) -> dict | None:
    """What an interrupted window left behind in ``database`` that only the author can settle.

    Read-only, and deliberately re-diagnosed from the live parameter values on every call, so the
    finding disappears by itself once they are back — the check may fall silent, it may never assert
    something it cannot know. Silent while this process holds a window open: the model is perturbed
    then, but on purpose and for the length of one calculation.
    """
    with _LOCK:
        if _frames:
            return None
    data = read()
    if data is None:
        return None
    if data.get("unreadable"):
        return {
            "database": database,
            "parameters": [],
            "message": (
                "A note about an interrupted calculation was left in this workspace but cannot be "
                "read, so PrismLCA cannot tell whether this model still holds a scenario's "
                "parameter values. Compare its parameters against your baseline. "
                f"(prism_meta/{MARKER_NAME})"
            ),
        }
    frames = [f for f in data.get("frames") or [] if isinstance(f, dict) and f.get("database") == database]
    if not frames:
        return None
    from prism_lca.engine import params

    diag = _diagnose(frames, params.snapshot_all(database), params.snapshot_formulas(database))
    stuck = [e["name"] for e in diag["changed"]] + diag["gone"]
    if not stuck and not diag["restore"]:
        return None
    if not stuck:
        # Restorable but not yet restored: the marker was found after startup had already run (a
        # window that failed to restore in this session). Name it too — the model is perturbed now.
        return {
            "database": database,
            "parameters": sorted(diag["restore"]),
            "message": (
                f"Model '{database}' is still holding the parameter values of {_labels(frames)}: a "
                "calculation could not put the baseline back. Restart PrismLCA to restore it, or "
                "set these parameters back by hand: " + ", ".join(sorted(diag["restore"])) + "."
            ),
        }
    return {
        "database": database,
        "parameters": sorted(stuck),
        "message": _unresolved_message(database, frames, diag),
    }


def _set_aside(reason: str) -> None:
    p = path()
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
    try:
        p.replace(p.with_name(f"{p.stem}.{reason}-{stamp}{p.suffix}"))
    except OSError as exc:  # pragma: no cover - defensive
        logger.warning("Could not set the parameter-window marker aside: %s", exc)


def recover(bus=None) -> dict | None:
    """Put back what an interrupted window left behind. Returns None when there was nothing to do.

    Call **before anything reads the model** — at startup and after a project switch, because the
    marker lives in the project directory and a project nobody activated is a project nobody
    checked.

    The restore is **automatic** for every parameter that still holds exactly the value the window
    wrote: that value is not the author's, it is ours, so putting the recorded baseline back cannot
    destroy anything of theirs, and asking for consent to undo our own half-finished write would
    only offer a choice between a correct model and a wrong one. It is **not** silent: it goes into
    the audit trail, where every other model write is, and into the backend log.

    Everything else is left exactly as it is and reported instead (:func:`unresolved`, surfaced by
    the model-health linter): a parameter whose value has moved since could have been edited by hand
    between the crash and this start, and a parameter that no longer exists is the V200 incident —
    a deleted parameter with an applied scenario's overrides still in place. Neither is something
    this marker can settle, so it does not pretend to.
    """
    with _LOCK:
        if _frames:
            # A window is open in this process, so the marker is describing it rather than a
            # leftover, and restoring over a live window would corrupt the calculation that owns it.
            # This is not "nothing to do": activating a project while a background warm-up holds a
            # window open skips the NEW project's recovery, and nothing retries it before the next
            # start. What keeps that from being silent is `unresolved`, which the health linter reads
            # once the window closes — it reports the model as still holding the values and says to
            # restart. Widening this to a per-project frame check would let a restore run while a
            # window is open on another project of the same process, which is the worse trade.
            return None
    data = read()
    if data is None:
        return None
    if data.get("unreadable"):
        _set_aside("unreadable")
        summary = {"unreadable": True, "restored": {}, "unresolved": []}
        if bus is not None:
            bus.note(  # no database: an unreadable marker cannot say which model it was about
                "system",
                "param_window_marker_unreadable",
                "A note about an interrupted calculation could not be read and was set aside. If a "
                "model's parameters look like a scenario's values, compare them with your baseline.",
            )
        logger.warning("Set aside an unreadable parameter-window marker.")
        return summary

    from prism_lca.engine import lca, params

    frames = [f for f in data.get("frames") or [] if isinstance(f, dict)]
    live_databases = set(get_bd().databases)
    restored: dict[str, dict[str, float]] = {}
    #: (database, message) — the model travels with the text so the audit line can be filed under it.
    unresolved_notes: list[tuple[str, str]] = []
    for database in dict.fromkeys(str(f.get("database") or "") for f in frames):
        own = [f for f in frames if f.get("database") == database]
        if database not in live_databases:
            # The model itself is gone, so there is nothing left to be wrong about.
            continue
        diag = _diagnose(own, params.snapshot_all(database), params.snapshot_formulas(database))
        try:
            if diag["restore"]:
                params.apply_values(database, diag["restore"], diag["restore_formulas"] or None)
                restored[database] = diag["restore"]
            # The parameters are back, but that does not say the exchanges are: a restore that died
            # after writing the parameters and before recalculating left them computed from the
            # scenario's values (10*b = 60 with b back at 2). The marker is only cleared over a model
            # recalculated from what it holds now — strictly, because the ordinary recalculation
            # swallows a failing exchange formula and would let the marker go over it.
            #
            # Known limits, documented rather than fixed: a marker that keeps failing
            # here stays on disk and is reported in the log and the audit trail, but the model-health
            # check only reads it as "unresolved" when the parameters differ, and a later window of
            # this process rewrites the marker file with its own frames. (A frame's ``overrides`` keep
            # every value the window ever wrote, but ownership is judged by ``current`` — see
            # _diagnose — so a hand edit equal to an earlier step's value is left alone.)
            params.recalc_database(database, model_change=True, strict=True)
        except Exception as exc:  # noqa: BLE001 - the marker must survive whatever stopped the restore
            _log.swallowed(exc, "recover")
            unresolved_notes.append(
                (
                    database,
                    f"Model '{database}' could not be recalculated after an interrupted calculation for "
                    f"{_labels(own)}, so its exchanges may still hold that calculation's amounts "
                    f"({type(exc).__name__}: {exc}). Check its parameters and recalculate.",
                )
            )
            continue
        if diag["changed"] or diag["gone"]:
            unresolved_notes.append((database, _unresolved_message(database, own, diag)))

    if restored:
        # A real edit relative to what was on disk a moment ago, so it moves the model generation:
        # anything keyed on it — the report data snapshots above all — must not answer for the
        # perturbed state it was built against.
        lca.invalidate_lca_cache(model_change=True)

    if unresolved_notes:
        # The marker stays: it is the only record of which parameters are in doubt, and the linter
        # re-reads it on every lint so the finding clears itself once they are settled.
        for database, note in unresolved_notes:
            logger.warning("%s", note)
            if bus is not None:
                # Attributed: this is a finding *about one model*, and its own history is where the
                # author will be standing when they ask why its numbers moved.
                bus.note("system", "param_window_unresolved", note, database=database)
    else:
        with _LOCK:
            try:
                path().unlink(missing_ok=True)
            except OSError as exc:  # pragma: no cover - defensive
                logger.warning("Could not clear the parameter-window marker: %s", exc)

    for database, values in restored.items():
        message = (
            f"Restored {len(values)} parameter(s) of model '{database}' to the recorded baseline "
            f"after a calculation for {_labels([f for f in frames if f.get('database') == database])} "
            f"was interrupted: {', '.join(sorted(values))}."
        )
        logger.warning("%s", message)
        if bus is not None:
            bus.note("system", "restore_param_window_baseline", message, database=database)

    if not restored and not unresolved_notes:
        return None
    return {"restored": restored, "unresolved": [note for _database, note in unresolved_notes]}


def reset_for_tests() -> None:
    """Forget the in-process frame stack and delete the marker."""
    with _LOCK:
        _frames.clear()
        try:
            path().unlink(missing_ok=True)
        except OSError:
            pass
