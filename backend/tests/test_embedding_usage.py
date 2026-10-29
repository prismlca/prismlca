"""The backend half of the cost ledger (V127): embeddings bill from here, not from Electron."""
from __future__ import annotations

from prism_lca.search import embedding_usage


def test_record_accumulates_per_month_and_model(tmp_path, monkeypatch):
    monkeypatch.setattr(embedding_usage, "_file", lambda: tmp_path / "embedding-usage.json")
    embedding_usage.record("openai/text-embedding-3-small", 1200)
    embedding_usage.record("openai/text-embedding-3-small", 800, cost=0.0001)
    snap = embedding_usage.snapshot()
    (month, models), = snap.items()
    entry = models["openai/text-embedding-3-small"]
    assert entry["prompt"] == 2000
    assert entry["calls"] == 2
    assert entry["cost"] > 0


def test_record_never_raises_and_skips_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(embedding_usage, "_file", lambda: tmp_path / "missing" / "nope.json")
    embedding_usage.record("m", 100)  # unwritable path → swallowed, not raised
    monkeypatch.setattr(embedding_usage, "_file", lambda: tmp_path / "ok.json")
    embedding_usage.record("", 100)
    embedding_usage.record("m", 0)
    assert embedding_usage.snapshot() == {}


def test_the_system_endpoint_serves_the_ledger(client, token, tmp_path, monkeypatch):
    monkeypatch.setattr(embedding_usage, "_file", lambda: tmp_path / "embedding-usage.json")
    embedding_usage.record("openai/text-embedding-3-small", 500)
    r = client.get("/api/v1/system/embedding-usage", headers=token)
    assert r.status_code == 200
    months = r.json()["months"]
    assert any("openai/text-embedding-3-small" in models for models in months.values())
