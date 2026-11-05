"""Where the backend's settings come from, and the address it may listen on (config.py)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from backend_process import DOTENV_VALUES, dotenv_folder
from pydantic import ValidationError

from prism_lca import config
from prism_lca.config import Settings


def test_settings_do_not_read_a_dotenv_in_the_working_directory(tmp_path, monkeypatch):
    for name in DOTENV_VALUES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.chdir(dotenv_folder(tmp_path / "somewhere"))
    settings = Settings()
    assert settings.auth_token != "token-from-file"
    assert settings.port == 0
    assert settings.embedding_backend == "sentence-transformers"
    assert settings.openrouter_base_url == "https://openrouter.ai/api/v1"


def test_a_developers_dotenv_is_read_from_the_backend_folder_and_not_in_the_bundle(monkeypatch):
    backend = Path(config.__file__).resolve().parents[2]
    assert (backend / "pyproject.toml").is_file()
    assert config.dev_env_file() == backend / ".env"
    assert Settings.model_config["env_file"] == backend / ".env"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert config.dev_env_file() is None


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.1.1", "::1", "localhost"])
def test_loopback_hosts_are_accepted(host):
    assert Settings(host=host).host == host


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "example.com", ""])
def test_the_backend_listens_on_this_computer_only(host, monkeypatch):
    with pytest.raises(ValidationError, match="loopback"):
        Settings(host=host)
    monkeypatch.setenv("PRISM_HOST", host)
    with pytest.raises(ValidationError, match="loopback"):
        Settings()
