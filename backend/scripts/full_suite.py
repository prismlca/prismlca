"""The whole backend suite, the way a commit that leaves the machine needs it.

Run from ``backend/``::

    uv run python scripts/full_suite.py                  # guards and full run
    uv run python scripts/full_suite.py --durations=20   # options go to pytest in both runs

Two things make it more than ``pytest -n auto``:

* **The guards answer first.** A few tests check that generated files and lists are current: the
  third-party notices, the bundle's import list and the modules' size ceilings. They fail more often than
  all the others together, nearly always over a forgotten regeneration step. They run beside the full run
  and answer in about twenty seconds; when one fails, the full run is stopped there instead of reporting
  the same thing minutes later (on Windows, which cannot stop a run with all its workers, they run
  first). The full run leaves them out. Both runs get a temporary directory of their own that goes when
  the script ends, so a stopped run leaves nothing behind.
* **One full run per machine at a time.** Two runs side by side share the cores, so each takes about
  half as long again, and tests with time limits start failing under the load. A second full run waits
  for the first. Its guards do not wait: they are cheap and give their answer in the meantime.

Arguments are pytest options such as ``--durations=20``, ``-x`` or ``-p no:cacheprovider``. A selection of
tests does not belong here; call pytest directly for that. In a git worktree that borrows the main
checkout's venv, run this file with that interpreter and ``PYTHONPATH`` pointing at the worktree's
``backend/src``, the same way pytest itself is run there.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import IO

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None  # type: ignore[assignment]
    import msvcrt

BACKEND = Path(__file__).resolve().parent.parent

#: Tests that check generated files and lists rather than behaviour (see the module docstring).
GUARDS = (
    "tests/test_third_party_notices.py",
    "tests/test_bundle_check.py",
    "tests/test_file_size.py",
)

#: One lock for every checkout and worktree on this machine. The file's text names the holder.
LOCK = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "prismlca" / "full-suite.lock"


#: Only POSIX can stop a run together with all its xdist workers (one process group), so only there do the
#: guards run beside the full run and stop it. On Windows the guards go first.
SIDE_BY_SIDE = os.name == "posix"


def start_pytest(
    *args: str, temp: Path, output: IO[str] | None = None, lock: IO[str] | None = None
) -> subprocess.Popen:
    """``temp`` becomes the run's temporary directory, so that everything the run and its workers create
    there goes when :func:`main` removes it, even after a stop. ``lock``: the open lock file, handed down so
    the run keeps the machine-wide lock held even if this script is killed (a flock belongs to the open
    file, and every process holding it holds the lock). On POSIX the run gets a process group of its own,
    shared by its workers, for :func:`stop`."""
    return subprocess.Popen(
        [sys.executable, "-m", "pytest", "-q", *args],
        cwd=BACKEND,
        env={**os.environ, "TMPDIR": str(temp), "TEMP": str(temp), "TMP": str(temp)},
        stdout=output,
        stderr=subprocess.STDOUT if output is not None else None,
        pass_fds=(lock.fileno(),) if lock is not None and fcntl is not None else (),
        process_group=0 if SIDE_BY_SIDE else None,
    )


def ended(proc: subprocess.Popen, block: bool) -> int | None:
    """The run's exit code once it has ended (waiting for that if ``block``), else None.

    On POSIX the run's process group is killed before the controller is reaped: workers or backends a test
    started can outlive the controller, and while the ended controller is not yet reaped its pid, and so
    the group id, cannot pass to another process. Every wait on a run goes through here or :func:`stop`."""
    if proc.returncode is not None:
        return proc.returncode
    if not SIDE_BY_SIDE:
        return proc.wait() if block else proc.poll()
    flags = os.WEXITED | os.WNOWAIT | (0 if block else os.WNOHANG)
    if os.waitid(os.P_PID, proc.pid, flags) is None:
        return None
    _kill_group(proc)
    return proc.wait()


def stop(proc: subprocess.Popen) -> None:
    """Kill a run with all its workers, unless it has been reaped already (its group went then). Asking
    politely does not work: after SIGINT, xdist's controller and workers were seen to run on for minutes.
    What the run leaves in its temporary directory goes with that directory."""
    if proc.returncode is not None:
        return
    if SIDE_BY_SIDE:
        _kill_group(proc)
    else:
        proc.kill()
    proc.wait()


#: Runs whose group has been killed. Kept apart from ``returncode``: an interrupt inside ``Popen.wait()``
#: can leave a run reaped with its ``returncode`` still unset, and its group id may be someone else's then.
_groups_killed: set[subprocess.Popen] = set()


def _kill_group(proc: subprocess.Popen) -> None:
    """Kill the run's process group, once. Only ever called before the run is reaped, so the controller,
    running or ended, still holds the group id."""
    if proc in _groups_killed:
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGKILL)
    _groups_killed.add(proc)


def _try_lock(fh: IO[str]) -> bool:
    if fcntl is not None:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True
    fh.seek(0)
    try:
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        return False
    return True


def _unlock(fh: IO[str]) -> None:
    if fcntl is not None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    else:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)


@contextlib.contextmanager
def one_at_a_time(give_up: Callable[[], bool]) -> Iterator[IO[str] | None]:
    """Hold the machine-wide lock for the block, after waiting for whoever holds it now, and yield the
    lock file. Yields None, without the lock, if ``give_up`` turns true while waiting."""
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK, "a+", encoding="utf-8") as fh:
        if not _try_lock(fh):
            try:
                fh.seek(0)
                holder = fh.read().strip()
            except OSError:  # Windows refuses to read a locked byte
                holder = ""
            print(f"Waiting for {holder or 'another full run'} to finish ...", flush=True)
            while not _try_lock(fh):
                if give_up():
                    yield None
                    return
                time.sleep(0.5)
        fh.seek(0)
        fh.truncate()
        fh.write(f"the full run of pid {os.getpid()} (since {time.strftime('%H:%M:%S')}, {BACKEND})")
        fh.flush()
        try:
            yield fh
        finally:
            fh.seek(0)
            fh.truncate()
            fh.flush()
            _unlock(fh)


def _interrupt(signum: int, frame: object) -> None:
    raise KeyboardInterrupt


def wind_down(running: list[subprocess.Popen]) -> None:
    """After an interrupt. On POSIX the runs sit in groups of their own, out of reach of the terminal's
    Ctrl+C, and are stopped here. On Windows the Ctrl+C reached them as well, so they get a moment to end
    on their own before they are stopped."""
    for proc in running:
        if not SIDE_BY_SIDE:
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(timeout=10)
        stop(proc)


def guards_failed(code: int, output: IO[str], begun: float) -> int:
    output.seek(0)
    sys.stdout.write(output.read())
    print(
        f"\nThe guards failed after {time.monotonic() - begun:.0f} s, so the full run was called off. "
        "Their messages name the file or list to bring up to date.",
        flush=True,
    )
    return code or 1


def main(args: list[str]) -> int:
    if "--basetemp" in " ".join([*args, os.environ.get("PYTEST_ADDOPTS", "")]):
        print(
            "Leave out --basetemp: the guards and the full run would share that directory and remove "
            "each other's files.",
            file=sys.stderr,
        )
        return 4  # pytest's own exit code for a usage error
    if SIDE_BY_SIDE:
        signal.signal(signal.SIGTERM, _interrupt)
    temp = Path(tempfile.mkdtemp(prefix="prismlca-full-suite-"))
    try:
        return run(args, temp)
    finally:
        remove(temp)


def remove(temp: Path) -> None:
    """Remove the runs' temporary directory. A test stopped inside ``_read_only`` (the workspace carry-over
    tests) leaves directories without write permission, so those are made writable on the way."""

    def writable_again(func: Callable[[str], object], path: str, exc: BaseException) -> None:
        if isinstance(exc, PermissionError):
            with contextlib.suppress(OSError):
                os.chmod(os.path.dirname(path), stat.S_IRWXU)
                func(path)

    shutil.rmtree(temp, onexc=writable_again)
    if temp.exists():
        print(f"[full_suite] Could not remove {temp} completely.", file=sys.stderr, flush=True)


def run(args: list[str], temp: Path) -> int:
    begun = time.monotonic()
    running: list[subprocess.Popen] = []
    with tempfile.TemporaryFile("w+", encoding="utf-8") as guard_output:
        try:
            guards = start_pytest("-n", str(len(GUARDS)), *args, *GUARDS, temp=temp, output=guard_output)
            running.append(guards)
            if not SIDE_BY_SIDE and ended(guards, block=True) != 0:
                return guards_failed(guards.returncode, guard_output, begun)
            with one_at_a_time(give_up=lambda: ended(guards, block=False) not in (None, 0)) as lock:
                if lock is None or ended(guards, block=False) not in (None, 0):
                    return guards_failed(ended(guards, block=True), guard_output, begun)
                locked_at = time.monotonic()
                try:
                    ignored = (f"--ignore={g}" for g in GUARDS)
                    full = start_pytest("-n", "auto", *args, *ignored, temp=temp, lock=lock)
                    running.append(full)
                    if ended(guards, block=True) != 0:
                        stop(full)
                        return guards_failed(guards.returncode, guard_output, begun)
                    print("\n[full_suite] The guards passed.", flush=True)
                    code = ended(full, block=True)
                except KeyboardInterrupt:
                    wind_down(running)
                    return 130
                finally:
                    # Whatever ends this block, no run outlives the lock or its temporary directory.
                    for proc in running:
                        stop(proc)
                finished_at = time.monotonic()
        except KeyboardInterrupt:
            wind_down(running)
            return 130
        finally:
            for proc in running:
                stop(proc)
    print(
        f"\n[full_suite] Waited {locked_at - begun:.0f} s for another full run, "
        f"full run {finished_at - locked_at:.0f} s.",
        flush=True,
    )
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
