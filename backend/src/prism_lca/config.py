"""Runtime configuration.

All settings can be overridden via ``PRISM_``-prefixed environment variables, which is
how the Electron shell injects a fixed port/token when it spawns the backend.
"""
from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path

from platformdirs import user_data_dir
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from prism_lca import __version__

# The data directory's name, not the product's spelling: renaming it would orphan every user's data.
APP_NAME = "Prism LCA"
API_VERSION = "v1"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PRISM_", env_file=".env", extra="ignore")

    #: Loopback only — never bind a public interface (avoids Windows firewall prompts).
    host: str = "127.0.0.1"
    #: 0 means "let the OS assign a free port"; the chosen port is sent in the handshake.
    port: int = 0
    #: Shared secret required on every non-public request; regenerated per process unless set.
    auth_token: str = Field(default_factory=lambda: secrets.token_urlsafe(32))
    #: Per-user data directory (Brightway projects live here from M2 on).
    data_dir: Path = Field(default_factory=lambda: Path(user_data_dir(APP_NAME, appauthor=False)))

    app_version: str = __version__
    api_prefix: str = f"/api/{API_VERSION}"

    # --- Search / embeddings ------------------------------------------------
    #: "sentence-transformers" (bge-m3, multilingual, PyTorch) | "local" (fastembed, ONNX, no torch)
    #: | "openai" | "openrouter" | "hashing" (offline fallback/tests)
    embedding_backend: str = "sentence-transformers"
    #: sentence-transformers backend model — multilingual, best DE/EN cross-lingual.
    embedding_model_st: str = "BAAI/bge-m3"
    #: Pinned Hugging Face revision of that model (MIT). The weights are downloaded at first use, not
    #: bundled; the pin keeps licence and behaviour tied to one known commit. Empty = whatever "main" is.
    embedding_model_st_revision: str = "5617a9f61b028005a4858fdac845db406aefb181"
    #: fastembed backend model (no PyTorch) — also multilingual.
    embedding_model_local: str = "intfloat/multilingual-e5-large"
    embedding_model_api: str = "text-embedding-3-large"
    openai_api_key: str = ""
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # --- Report -------------------------------------------------------------
    #: The three hex fields under the report's colour sets, for trying colours of your own on one report
    #: without adding a set. Off — which is now the default — hides the fields and nothing else: colours a
    #: report already stores are still typeset. They have to be, because the "White page background"
    #: checkbox under the sets writes the paper of exactly these colours and is offered everywhere. Nine
    #: reviewed sets are the offer; a hand-picked colour is the exception, and an exception does not belong
    #: in the panel by default.
    #:
    #: Deliberately not a UI switch: whether a document may be typeset in colours nobody reviewed is a
    #: decision for whoever hands the app out, not a checkbox to find mid-report. `PRISM_REPORT_CUSTOM_COLORS=1`
    #: brings the fields back.
    report_custom_colors: bool = False

    # --- Hybrid search ------------------------------------------------------
    #: fuse dense (embeddings) + BM25 (lexical) via RRF. Off → dense-only.
    search_hybrid: bool = True
    #: How much of its biggest suppliers' meaning a market's vector borrows for the ranking (0 = off) —
    #: Set, not tuned; the switch is for evaluation runs and for taking the blend back.
    search_market_blend: float = 0.5


@lru_cache
def get_settings() -> Settings:
    return Settings()
