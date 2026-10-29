"""bw2io's core migrations, written once per test run and hard-linked into every project that needs them.

They are 13 JSON files, 171 MB, that the ecoinvent import writes into every project it touches: ~8 s
through bw2data's pure-Python ``json.dump``, twice that under xdist, and 171 MB of tmpfs each time. Their
content never changes, so the first project to need them publishes its files and every later one — in
any worker of the run — links them.

Two directories carry the coordination, both created atomically: a lock directory says "someone is
writing them", and the cache directory appears complete in one rename. A worker that finds the lock waits
for the cache; if the writer fails, or takes implausibly long, it writes its own copy as before.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

#: bw2io's ``migrations.json`` entries for the cached files; no migration file has this name.
REGISTRY = "_registry.json"
#: How long a worker waits for another one's copy before writing its own.
WAIT_SECONDS = 300.0


def sharing(real: Callable[[], None], run_dir: Path) -> Callable[[], None]:
    """A drop-in for ``bw2io.create_core_migrations`` that writes through ``real`` at most once per run."""
    cache = run_dir / "core-migrations"
    lock = run_dir / "core-migrations.lock"

    def create_core_migrations() -> None:
        from bw2data import projects

        target = Path(projects.request_directory("migrations"))
        if not cache.is_dir():
            try:
                os.mkdir(lock)
            except FileExistsError:
                deadline = time.monotonic() + WAIT_SECONDS
                while lock.is_dir() and not cache.is_dir() and time.monotonic() < deadline:
                    time.sleep(0.1)
            else:
                try:
                    if not cache.is_dir():  # not published while this worker took the lock
                        real()
                        _publish(target, cache)
                        return
                finally:
                    os.rmdir(lock)
        if cache.is_dir():
            _link(cache, target)
        else:
            real()

    return create_core_migrations


def _publish(target: Path, cache: Path) -> None:
    """Offer this project's freshly written files to the rest of the run. A failure only costs the
    cache — the project itself already has its migrations — so it never fails the test."""
    from bw2io.migrations import migrations

    staging = Path(tempfile.mkdtemp(dir=cache.parent))
    try:
        for f in target.iterdir():
            os.link(f, staging / f.name)
        (staging / REGISTRY).write_text(json.dumps(migrations.data))
        os.rename(staging, cache)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)


def _link(cache: Path, target: Path) -> None:
    from bw2io.migrations import migrations

    for f in cache.iterdir():
        if f.name == REGISTRY:
            continue
        try:
            os.link(f, target / f.name)
        except FileExistsError:
            pass
        except OSError:  # another filesystem: a copy is still faster than writing them
            shutil.copyfile(f, target / f.name)
    migrations.data.update(json.loads((cache / REGISTRY).read_text()))
    migrations.flush()
