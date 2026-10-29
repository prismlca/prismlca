"""The property/unit/CPC vocabulary is scanned from the read-only inventory. An EMPTY scan — the app
started before any background was imported — must not be cached for good."""

from __future__ import annotations

from prism_lca.engine import lca, model


def test_an_empty_vocabulary_is_neither_persisted_nor_kept_past_a_model_change(monkeypatch, client, token, project):
    cache = model._vocab_cache_file()
    cache.unlink(missing_ok=True)
    monkeypatch.setattr(model, "_VOCAB", None)
    monkeypatch.setattr(model, "_scan_vocab", lambda: {"properties": {}, "units": ["kg"], "cpc": {}})
    try:
        assert model.property_vocabulary() == {}
        assert not cache.exists()
        monkeypatch.setattr(
            model, "_scan_vocab", lambda: {"properties": {"dry mass": "kilogram"}, "units": ["kg"], "cpc": {}}
        )
        assert model.property_vocabulary() == {}  # same generation: no rescan yet
        lca.invalidate_lca_cache(model_change=True)  # what an import does
        assert model.property_vocabulary() == {"dry mass": "kilogram"}
        assert cache.exists()
    finally:
        cache.unlink(missing_ok=True)
