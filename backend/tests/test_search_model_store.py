"""The local search model is fetched only on request, and loading never goes to the network.

What these tests hold in place (privacy requirement): the state logic of
`SearchModelStore` against a fake hub cache, the two endpoints, and that `SearchService.warm()`
leaves a missing model alone instead of running into a download. No test downloads anything —
the loader is always a stand-in.
"""
from __future__ import annotations

import threading
from pathlib import Path

import pytest

from prism_lca.config import Settings
from prism_lca.search import model_store
from prism_lca.search.model_store import SearchModelStore

REPO = "ORG/model"
REV = "a" * 40  # a commit hash, so snapshot_download resolves it without refs/


@pytest.fixture
def hub_cache(tmp_path, monkeypatch) -> Path:
    monkeypatch.setattr(model_store, "_cache_dir", lambda: tmp_path)
    return tmp_path


def _repo_root(cache: Path) -> Path:
    return cache / "models--ORG--model"


def _write_snapshot(cache: Path, weights: bytes = b"w" * 100) -> None:
    """Lay out a cache the way huggingface_hub does: blobs, and a snapshot linking to them."""
    root = _repo_root(cache)
    blobs = root / "blobs"
    snap = root / "snapshots" / REV
    blobs.mkdir(parents=True, exist_ok=True)
    snap.mkdir(parents=True, exist_ok=True)
    for name, data in (("modules.json", b"[]"), ("pytorch_model.bin", weights)):
        blob = blobs / f"blob-{name}"
        blob.write_bytes(data)
        link = snap / name
        if not link.exists():
            link.symlink_to(blob)


def _settings(backend: str = "sentence-transformers") -> Settings:
    return Settings(
        auth_token="test-token",
        port=0,
        embedding_backend=backend,
        embedding_model_st=REPO,
        embedding_model_st_revision=REV,
    )


# --- is_cached / bytes_on_disk ------------------------------------------------------------------


def test_is_cached_false_on_empty_cache(hub_cache):
    assert model_store.is_cached(REPO, REV) is False


def test_is_cached_true_with_weights(hub_cache):
    _write_snapshot(hub_cache)
    assert model_store.is_cached(REPO, REV) is True


def test_is_cached_false_when_the_weights_are_missing(hub_cache):
    # A download killed halfway leaves the snapshot folder with only the small files linked.
    snap = _repo_root(hub_cache) / "snapshots" / REV
    snap.mkdir(parents=True)
    (snap / "modules.json").write_text("[]")
    assert model_store.is_cached(REPO, REV) is False


def test_bytes_on_disk_counts_snapshot_and_partial_blobs_only(hub_cache):
    _write_snapshot(hub_cache, weights=b"w" * 100)
    root = _repo_root(hub_cache)
    (root / "blobs" / "next.incomplete").write_bytes(b"p" * 40)
    # Another revision's weights are in the same folder but not part of this download.
    other = root / "snapshots" / ("b" * 40)
    other.mkdir()
    (other / "model.safetensors").write_bytes(b"x" * 1000)
    assert model_store.bytes_on_disk(REPO, REV) == 2 + 100 + 40


# --- state --------------------------------------------------------------------------------------


@pytest.mark.parametrize("backend", ["hashing", "openai", "openrouter", "local"])
def test_other_backends_are_always_ready(hub_cache, backend):
    store = SearchModelStore(_settings(backend), loader=lambda *_: pytest.fail("must not load"))
    assert store.status()["state"] == "ready"
    assert store.start_download()["state"] == "ready"


def test_missing_then_ready(hub_cache):
    store = SearchModelStore(_settings())
    st = store.status()
    assert st["state"] == "missing"
    assert st["repo"] == REPO and st["revision"] == REV
    assert st["bytes_total"] == model_store.EXPECTED_BYTES
    _write_snapshot(hub_cache)
    assert store.status()["state"] == "ready"


def test_download_runs_loader_then_reports_ready_and_warms(hub_cache):
    release = threading.Event()
    calls: list[tuple[str, str | None]] = []
    warmed = threading.Event()

    def loader(repo, revision):
        calls.append((repo, revision))
        release.wait(5)
        _write_snapshot(hub_cache)

    store = SearchModelStore(_settings(), on_ready=warmed.set, loader=loader)
    assert store.start_download()["state"] == "downloading"
    # Idempotent: a second press while it runs starts nothing new.
    assert store.start_download()["state"] == "downloading"
    release.set()
    assert warmed.wait(5)
    store._thread.join(5)
    assert calls == [(REPO, REV)]
    assert store.status()["state"] == "ready"
    # Once on disk, a further request starts nothing either.
    store.start_download()
    assert calls == [(REPO, REV)]


def test_download_error_is_reported_and_retry_clears_it(hub_cache):
    attempts: list[int] = []

    def loader(repo, revision):
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("connection reset")
        _write_snapshot(hub_cache)

    store = SearchModelStore(_settings(), loader=loader)
    store.start_download()
    store._thread.join(5)
    st = store.status()
    assert st["state"] == "error"
    assert "connection reset" in st["error"]
    store.start_download()
    store._thread.join(5)
    assert store.status() == {**store.status(), "state": "ready", "error": None}
    assert len(attempts) == 2


def test_loader_that_leaves_no_files_is_an_error(hub_cache):
    store = SearchModelStore(_settings(), loader=lambda *_: None)
    store.start_download()
    store._thread.join(5)
    assert store.status()["state"] == "error"


# --- warm() -------------------------------------------------------------------------------------


def test_warm_skips_a_missing_model(hub_cache, monkeypatch):
    from prism_lca.search import service

    started: list[str] = []
    monkeypatch.setattr(service.threading, "Thread", lambda *a, **k: started.append("thread"))
    service.SearchService(_settings()).warm()
    assert started == []


def test_warm_loads_a_cached_model(hub_cache, monkeypatch):
    from prism_lca.search import service

    _write_snapshot(hub_cache)

    class _Thread:
        def __init__(self, *a, **k):
            self.name = k.get("name")

        def start(self):
            started.append(self.name)

    started: list[str] = []
    monkeypatch.setattr(service.threading, "Thread", _Thread)
    service.SearchService(_settings()).warm()
    assert started == ["prism-embed-warmup"]


def test_provider_loads_local_files_only(monkeypatch):
    import sys
    import types

    seen: dict = {}

    class _ST:
        def __init__(self, model, **kwargs):
            seen.update(model=model, **kwargs)

    monkeypatch.setitem(sys.modules, "sentence_transformers", types.SimpleNamespace(SentenceTransformer=_ST))
    from prism_lca.search.embeddings import SentenceTransformerProvider

    SentenceTransformerProvider(REPO, REV)
    assert seen == {"model": REPO, "revision": REV, "local_files_only": True}


# --- endpoints ----------------------------------------------------------------------------------


def test_search_model_endpoints_require_token(client):
    assert client.get("/api/v1/system/search-model").status_code == 401
    assert client.post("/api/v1/system/search-model/download").status_code == 401


def test_search_model_ready_under_hashing(client, token):
    r = client.get("/api/v1/system/search-model", headers=token)
    assert r.status_code == 200
    assert r.json()["state"] == "ready"
    r = client.post("/api/v1/system/search-model/download", headers=token)
    assert r.status_code == 200
    assert r.json()["state"] == "ready"


def test_search_model_endpoints_report_and_start(client, token, hub_cache):
    loaded = threading.Event()

    def loader(repo, revision):
        _write_snapshot(hub_cache)
        loaded.set()

    store = SearchModelStore(_settings(), loader=loader)
    client.app.state.search_model = store
    r = client.get("/api/v1/system/search-model", headers=token)
    assert r.json()["state"] == "missing"
    assert r.json()["bytes_total"] == model_store.EXPECTED_BYTES
    r = client.post("/api/v1/system/search-model/download", headers=token)
    assert r.status_code == 200
    assert r.json()["state"] in ("downloading", "ready")
    assert loaded.wait(5)
    store._thread.join(5)
    assert client.get("/api/v1/system/search-model", headers=token).json()["state"] == "ready"
