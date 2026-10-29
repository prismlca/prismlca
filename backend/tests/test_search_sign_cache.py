"""The reference-sign cache behind search hits is stamped with project and model generation
a switch or a model change must not serve the old sign."""

from __future__ import annotations

from types import SimpleNamespace

from prism_lca.api.v1 import search as api_search
from prism_lca.engine import lca


def _bd(project: str):
    return SimpleNamespace(projects=SimpleNamespace(current=project))


def test_the_sign_cache_forgets_on_a_project_switch_and_on_a_model_change():
    cache = api_search._ref_sign_cache(_bd("A"))
    cache[("db", "x")] = 1.0
    assert api_search._ref_sign_cache(_bd("A")) is cache and cache
    assert not api_search._ref_sign_cache(_bd("B"))
    api_search._ref_sign_cache(_bd("B"))[("db", "x")] = -1.0
    lca.invalidate_lca_cache(model_change=True)
    assert not api_search._ref_sign_cache(_bd("B"))
