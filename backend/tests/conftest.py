from __future__ import annotations

import atexit
import gc
import os
import tempfile

# BRIGHTWAY2_DIR must be set before bw2data is ever imported. Point it at a throwaway
# directory so tests never touch a real user project.
#
# One per *process*, which is what makes `pytest -n auto` safe: every xdist worker imports this module and
# so gets a directory of its own, and every test creates a uniquely named project inside it.
_BW_DIR = tempfile.mkdtemp(prefix="prism-bw-test-")
os.environ["BRIGHTWAY2_DIR"] = _BW_DIR
os.environ["PRISM_DATA_DIR"] = _BW_DIR

# ...and removed when the process ends. Without this every run left 0.3–2MB of sqlite behind in /tmp, one
# directory per run and, under xdist, one per worker: a few hundred of them had piled up unnoticed.
# `ignore_errors` because Brightway may still hold a handle at interpreter exit, and a test run must not
# fail over its own cleanup.
atexit.register(lambda: __import__("shutil").rmtree(_BW_DIR, ignore_errors=True))

# One directory for the whole run, shared by all xdist workers: the process that starts the run creates it,
# the workers inherit the variable, and it goes when that process ends.
if "PRISM_TEST_RUN_DIR" not in os.environ:
    os.environ["PRISM_TEST_RUN_DIR"] = tempfile.mkdtemp(prefix="prism-test-run-")
    atexit.register(
        lambda: __import__("shutil").rmtree(os.environ["PRISM_TEST_RUN_DIR"], ignore_errors=True)
    )

import uuid  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from prism_lca.app import create_app  # noqa: E402
from prism_lca.config import Settings  # noqa: E402

#: How many tests run between two collections that see the frozen objects too (see below).
FULL_COLLECTION_EVERY = 20
_tests_since_full_collection = 0


@pytest.fixture(autouse=True)
def _freeze_survivors():
    """bw2data calls ``gc.collect()`` twice on every project switch, and a full collection walks every
    object the process holds — the app, numpy, scipy, pydantic's models — at ~90 ms a time. Every test
    creates a project, so that alone was half of the suite's CPU time. Collecting once here and freezing
    what survives (modules, caches) takes it out of the collector's reach; what a test creates is still
    collected as before, and the previous test's garbage is gone before the freeze.

    A frozen object that is abandoned later is never collected, though: the SQLite connection a test
    opened on the main thread stays with the old database object when a request on another thread
    switches the project — about 1.4 open files per test. So every few tests the freeze is lifted for one
    full collection, which bounds that to a few dozen files at ~5 ms per test."""
    global _tests_since_full_collection
    _tests_since_full_collection += 1
    if _tests_since_full_collection >= FULL_COLLECTION_EVERY:
        _tests_since_full_collection = 0
        gc.unfreeze()
    gc.collect()
    gc.freeze()


@pytest.fixture(autouse=True, scope="session")
def _core_migrations_once():
    """The ecoinvent import writes bw2io's 171 MB of core migrations into every project it touches; this
    run writes them once and links them everywhere else (see :mod:`shared_core_migrations`)."""
    from pathlib import Path

    import bw2io
    from shared_core_migrations import sharing

    run_dir = Path(os.environ["PRISM_TEST_RUN_DIR"])
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(bw2io, "create_core_migrations", sharing(bw2io.create_core_migrations, run_dir))
        yield


@pytest.fixture
def settings() -> Settings:
    # "hashing" keeps embeddings deterministic and offline (no model download) in tests.
    return Settings(auth_token="test-token", port=0, embedding_backend="hashing")


@pytest.fixture
def client(settings: Settings) -> TestClient:
    return TestClient(create_app(settings))


@pytest.fixture
def token() -> dict[str, str]:
    return {"X-Prism-Token": "test-token"}


@pytest.fixture
def project(client: TestClient, token: dict[str, str]) -> str:
    """Create and activate a uniquely named project for the test."""
    name = "test-" + uuid.uuid4().hex[:8]
    r = client.post("/api/v1/projects", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    return name
