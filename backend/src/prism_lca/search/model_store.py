"""The local search model: is it on disk, and fetching it once — only when the user said yes.

The default embedding backend (``sentence-transformers``, bge-m3) needs about 2.3 GB of weights that
are not part of the installer. The first start used to fetch them silently from
huggingface.co the moment the warm-up thread built the provider. Now the normal loading path is
``local_files_only`` (see `SentenceTransformerProvider`) and never touches the network; the one and
only way the weights arrive is `SearchModelStore.start_download`, which the Electron shell calls
after the user pressed "Download" in the consent dialog (see PRIVACY.md).

Backends other than ``sentence-transformers`` need no local model, so the store reports ``ready``
for them and the shell never asks.
"""
from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from prism_lca.config import Settings

logger = logging.getLogger(__name__)

#: Size of the files sentence-transformers fetches for BAAI/bge-m3 at the pinned revision
#: (5617a9f6…): pytorch_model.bin 2 271 145 830 B, tokenizer.json 17 098 108 B,
#: sentencepiece.bpe.model 5 069 051 B, README and seven small configs. Measured on the
#: snapshot folder of a populated cache: 2 293 331 623 B in total. Only a progress denominator — a
#: different revision pin may be off by a few MB, which the progress bar survives.
EXPECTED_BYTES = 2_293_331_623

#: The weight file one of which must be in the snapshot for it to count as usable. snapshot_download
#: with local_files_only only checks that the snapshot FOLDER exists; a download killed halfway
#: leaves the folder with the small files linked and the weights missing.
_WEIGHT_FILES = ("pytorch_model.bin", "model.safetensors")


def _cache_dir() -> Path:
    from huggingface_hub import constants

    return Path(constants.HF_HUB_CACHE)


def repo_cache_folder(repo: str) -> Path:
    """The hub cache folder of one model repo (``models--ORG--NAME``)."""
    from huggingface_hub.file_download import repo_folder_name

    return _cache_dir() / repo_folder_name(repo_id=repo, repo_type="model")


def is_cached(repo: str, revision: str | None) -> bool:
    """Are the model's files for this revision in the local hub cache? Never goes to the network."""
    try:
        from huggingface_hub import snapshot_download

        folder = Path(
            snapshot_download(
                repo, revision=revision or None, cache_dir=_cache_dir(), local_files_only=True
            )
        )
    except Exception as exc:  # noqa: BLE001 - LocalEntryNotFoundError, or no hub library at all
        logger.debug("search model %s@%s not cached: %s", repo, revision, exc)
        return False
    return (folder / "modules.json").is_file() and any((folder / f).is_file() for f in _WEIGHT_FILES)


def bytes_on_disk(repo: str, revision: str | None) -> int:
    """How much of this revision has arrived: its completed files plus every partial blob.

    Completed files are the snapshot's links (the hub creates a link only once a blob is complete);
    partial ones are ``blobs/*.incomplete``. Counting the whole repo folder instead would include
    other revisions' weights — on a machine that once loaded "main" that doubles the number.
    """
    root = repo_cache_folder(repo)
    total = 0
    blobs = root / "blobs"
    if blobs.is_dir():
        for p in blobs.glob("*.incomplete"):
            try:
                total += p.stat().st_size
            except OSError:
                pass
    snapshot = _snapshot_folder(root, revision)
    if snapshot is not None:
        for dirpath, _dirs, files in os.walk(snapshot):
            for name in files:
                try:
                    total += (Path(dirpath) / name).stat().st_size  # follows the link to the blob
                except OSError:
                    pass
    return total


def _snapshot_folder(root: Path, revision: str | None) -> Path | None:
    snapshots = root / "snapshots"
    if not snapshots.is_dir():
        return None
    ref = revision or "main"
    candidate = snapshots / ref
    if candidate.is_dir():
        return candidate
    ref_file = root / "refs" / ref  # a branch name resolves to a commit hash through refs/
    if ref_file.is_file():
        try:
            commit = ref_file.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        if (snapshots / commit).is_dir():
            return snapshots / commit
    return None


def _default_loader(repo: str, revision: str | None) -> None:
    # The very same constructor the provider uses, minus local_files_only: so exactly the files the
    # later offline load needs are the ones that arrive — no separate file list to keep in step.
    from sentence_transformers import SentenceTransformer

    SentenceTransformer(repo, revision=revision or None)


class SearchModelStore:
    """State of the local search model and the one background download of it."""

    def __init__(
        self,
        settings: Settings,
        on_ready: Callable[[], None] | None = None,
        loader: Callable[[str, str | None], None] | None = None,
    ) -> None:
        self._settings = settings
        self._on_ready = on_ready
        self._loader = loader or _default_loader
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._error: str | None = None

    # -- what is needed ----------------------------------------------------------------------
    def needs_local_model(self) -> bool:
        return self._settings.embedding_backend == "sentence-transformers"

    @property
    def repo(self) -> str:
        return self._settings.embedding_model_st

    @property
    def revision(self) -> str | None:
        return self._settings.embedding_model_st_revision or None

    def is_ready(self) -> bool:
        return not self.needs_local_model() or is_cached(self.repo, self.revision)

    # -- state -------------------------------------------------------------------------------
    def status(self) -> dict[str, Any]:
        base: dict[str, Any] = {
            "repo": self.repo,
            "revision": self.revision,
            "bytes_done": 0,
            "bytes_total": EXPECTED_BYTES,
            "error": None,
        }
        if not self.needs_local_model():
            return {**base, "state": "ready", "bytes_total": 0}
        with self._lock:
            running = self._thread is not None and self._thread.is_alive()
            error = self._error
        if running:
            done = min(bytes_on_disk(self.repo, self.revision), EXPECTED_BYTES)
            return {**base, "state": "downloading", "bytes_done": done}
        if is_cached(self.repo, self.revision):
            return {**base, "state": "ready", "bytes_done": EXPECTED_BYTES}
        done = min(bytes_on_disk(self.repo, self.revision), EXPECTED_BYTES)
        if error is not None:
            return {**base, "state": "error", "bytes_done": done, "error": error}
        return {**base, "state": "missing", "bytes_done": done}

    def downloading(self) -> bool:
        """Whether the download thread is alive — without the disk reads `status()` makes."""
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    # -- download ----------------------------------------------------------------------------
    def start_download(self) -> dict[str, Any]:
        """Start the download on a daemon thread — idempotent: a running one is left alone, a model
        already on disk starts nothing. Returns the state right after."""
        if not self.needs_local_model():
            return self.status()
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                pass
            elif is_cached(self.repo, self.revision):
                pass
            else:
                self._error = None
                self._thread = threading.Thread(
                    target=self._run, name="prism-search-model-download", daemon=True
                )
                self._thread.start()
        return self.status()

    def _run(self) -> None:
        repo, revision = self.repo, self.revision
        logger.info("downloading search model %s@%s (user consented)", repo, revision)
        try:
            self._loader(repo, revision)
        except Exception as exc:  # noqa: BLE001 - reported to the shell, which offers Retry
            logger.exception("search model download failed")
            with self._lock:
                self._error = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
            return
        if not is_cached(repo, revision):
            with self._lock:
                self._error = "The download finished but the model files are not in the cache."
            return
        logger.info("search model downloaded")
        if self._on_ready is not None:
            try:
                self._on_ready()
            except Exception:  # noqa: BLE001 - the model is there; warming is an optimisation
                logger.exception("warm-up after the search model download failed")
