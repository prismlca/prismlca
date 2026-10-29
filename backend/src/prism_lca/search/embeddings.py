"""Pluggable embedding backends.

User-selectable (settings.embedding_backend): local (fastembed, offline CPU), OpenAI, or
OpenRouter. A deterministic offline ``hashing`` provider is the graceful fallback when no
model/network is available and powers the tests. All providers return L2-normalised float32
vectors, so cosine similarity is a plain dot product.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from typing import Protocol, runtime_checkable

import numpy as np

from prism_lca import _log
from prism_lca.config import Settings

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall((text or "").lower())


def _normalize(mat: np.ndarray) -> np.ndarray:
    mat = np.asarray(mat, dtype="float32")
    if mat.ndim == 1:
        mat = mat.reshape(1, -1)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (mat / norms).astype("float32")


@runtime_checkable
class EmbeddingProvider(Protocol):
    name: str
    #: The model actually producing the vectors. Separate from `name`, which is only the backend:
    #: two 1024-dimensional sentence-transformers models pass a backend+dimension check and then
    #: return silently meaningless similarities against each other's index.
    model: str

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        """(n, dim) L2-normalised float32. is_query distinguishes query vs document
        embedding for models that need it (e.g. e5's 'query:' / 'passage:' prefixes)."""
        ...


class HashingEmbedding:
    """Deterministic bag-of-hashed-tokens embedding. Offline, dependency-free. Not as strong
    as a real model, but keeps search working without one — and is fully reproducible for tests."""

    name = "hashing"
    model = "hashing"

    def __init__(self, dim: int = 256) -> None:
        self.dim = dim

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype="float32")
        for i, text in enumerate(texts):
            for token in _tokenize(text):
                digest = int(hashlib.md5(token.encode("utf-8")).hexdigest(), 16)
                out[i, digest % self.dim] += 1.0
        return _normalize(out)


class FastEmbedProvider:
    """Local CPU embeddings via fastembed (ONNX). Model downloaded once on first use."""

    name = "local"

    def __init__(self, model: str) -> None:
        from fastembed import TextEmbedding

        self.model = model
        self._model = TextEmbedding(model_name=model)
        # e5 models expect "query: " / "passage: " prefixes for best retrieval.
        self._is_e5 = "e5" in model.lower()

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        if self._is_e5:
            prefix = "query: " if is_query else "passage: "
            texts = [prefix + t for t in texts]
        vectors = list(self._model.embed(list(texts)))
        return _normalize(np.array(vectors, dtype="float32"))


class SentenceTransformerProvider:
    """bge-m3 (and other) via sentence-transformers (PyTorch). Multilingual; no query/passage
    prefixes needed. Heavier bundle than fastembed but best DE/EN cross-lingual quality."""

    name = "sentence-transformers"

    def __init__(self, model: str, revision: str | None = None, local_files_only: bool = True) -> None:
        from sentence_transformers import SentenceTransformer

        # transformers would otherwise spawn a background "auto_conversion" thread on every load of a
        # .bin checkpoint (bge-m3 at our pin has no safetensors) that asks huggingface.co for a
        # conversion PR — and, on a first download, fetches a second 2.3 GB copy of the weights.
        # server.py sets this too; setdefault here covers every other entry point.
        os.environ.setdefault("DISABLE_SAFETENSORS_CONVERSION", "1")
        self.model = model
        # local_files_only by default: loading never goes to the network. The weights arrive only
        # through search.model_store, after the user agreed to the download.
        self._model = SentenceTransformer(
            model, revision=revision or None, local_files_only=local_files_only
        )

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        vecs = self._model.encode(
            list(texts), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False
        )
        return np.asarray(vecs, dtype="float32")


class OpenAICompatibleProvider:
    """OpenAI or OpenRouter embeddings via the OpenAI client."""

    def __init__(self, name: str, model: str, api_key: str, base_url: str | None = None) -> None:
        from openai import OpenAI

        self.name = name
        self.model = model
        self._model = model
        kwargs: dict = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        self._client = OpenAI(**kwargs)
        # OpenRouter: enforce zero-data-retention on the provider side.
        self._extra = (
            {"extra_body": {"provider": {"data_collection": "deny"}}}
            if name == "openrouter"
            else {}
        )

    def embed(self, texts: list[str], is_query: bool = False) -> np.ndarray:
        resp = self._client.embeddings.create(model=self._model, input=list(texts), **self._extra)
        # Book what this request consumed (V127): the embeddings API reports tokens, and some
        # OpenRouter responses carry a cost in the untyped extras. Best effort, never fatal.
        try:
            from prism_lca.search import embedding_usage

            usage = getattr(resp, "usage", None)
            tokens = int(getattr(usage, "prompt_tokens", 0) or getattr(usage, "total_tokens", 0) or 0)
            extra = getattr(usage, "model_extra", None) or {}
            embedding_usage.record(self._model, tokens, cost=float(extra.get("cost") or 0.0))
        except Exception as exc:  # noqa: BLE001 — accounting must never break an index build
            _log.swallowed(exc, "embed")
        return _normalize(np.array([d.embedding for d in resp.data], dtype="float32"))


def get_embedding_provider(settings: Settings) -> EmbeddingProvider:
    """Construct the CONFIGURED embedding provider — and fail hard if it is unavailable.

    There is deliberately NO silent hashing fallback: it used to swallow missing API keys,
    missing torch/sentence-transformers (PyInstaller!), failed model downloads and even config
    typos, then built a degraded 256-dim index that reported success — and the resulting
    "embedding_mismatch → rebuild" advice would destroy a good index. Hashing is available
    only when explicitly configured (embedding_backend="hashing", e.g. in tests)."""
    backend = settings.embedding_backend
    if backend == "hashing":
        return HashingEmbedding()
    if backend == "sentence-transformers":
        return SentenceTransformerProvider(settings.embedding_model_st, settings.embedding_model_st_revision)
    if backend == "local":
        return FastEmbedProvider(settings.embedding_model_local)
    if backend == "openai":
        if not settings.openai_api_key:
            raise RuntimeError("PRISM_OPENAI_API_KEY is not set.")
        return OpenAICompatibleProvider("openai", settings.embedding_model_api, settings.openai_api_key)
    if backend == "openrouter":
        if not settings.openrouter_api_key:
            raise RuntimeError("PRISM_OPENROUTER_API_KEY is not set.")
        return OpenAICompatibleProvider(
            "openrouter",
            settings.embedding_model_api,
            settings.openrouter_api_key,
            settings.openrouter_base_url,
        )
    raise RuntimeError(f"Unknown embedding backend '{backend}'.")
