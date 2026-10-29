"""Regression tests for the treatment-activity sign convention (external review P01/P02).

ecoinvent models waste treatment with a NEGATIVE reference flow (production amount −1).
``amount=1`` must mean "treat 1 unit" and yield POSITIVE impacts everywhere — score,
contribution tree, stacked comparison, elementary flows, Monte Carlo, background expand.
Also covers descent scaling for foreground activities with production amounts ≠ 1.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd

METHOD = ["t", "gwp"]


def _seed_treatment(bd) -> None:
    """T = waste treatment (production −1, emits 1 kg CO2 per run).
    A produces 1 unit and sends 1 kg waste to T (ecoinvent convention: input amount −1).
    B produces 2 kg per run and consumes 1 kWh of S (which emits 1 kg CO2/kWh)."""
    bd.Database("bio").write(
        {("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("fg").write(
        {
            ("fg", "T"): {
                "name": "treatment of biowaste",
                "unit": "kg",
                "reference product": "biowaste",
                "exchanges": [
                    {"input": ("fg", "T"), "amount": -1, "type": "production"},
                    {"input": ("bio", "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            },
            ("fg", "A"): {
                "name": "A",
                "unit": "unit",
                "reference product": "A-product",
                "exchanges": [
                    {"input": ("fg", "A"), "amount": 1, "type": "production"},
                    {"input": ("fg", "T"), "amount": -1, "type": "technosphere"},
                ],
            },
            ("fg", "S"): {
                "name": "supply",
                "unit": "kWh",
                "reference product": "electricity",
                "exchanges": [
                    {"input": ("fg", "S"), "amount": 1, "type": "production"},
                    {"input": ("bio", "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            },
            ("fg", "B"): {
                "name": "B",
                "unit": "kg",
                "reference product": "B-product",
                "exchanges": [
                    {"input": ("fg", "B"), "amount": 2, "type": "production"},
                    {"input": ("fg", "S"), "amount": 1, "type": "technosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp")).write([(("bio", "co2"), 1.0)])


def test_treatment_score_is_positive(client, token, project):
    """Treating 1 kg of waste must yield +1 kg CO2e, not −1 (P01)."""
    _seed_treatment(get_bd())
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": "fg", "code": "T", "method": METHOD},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(r.json()["score"] - 1.0) < 1e-9


def test_process_sending_waste_to_treatment(client, token, project):
    """A consumes T with amount −1 (send 1 kg waste): total +1, and the T child subtree in the
    contribution tree carries a POSITIVE impact (P02: descent must scale by amt/prod)."""
    _seed_treatment(get_bd())
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "A", "method": METHOD, "cutoff": 0.001},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert abs(body["meta"]["total"] - 1.0) < 1e-9
    children = body["tree"].get("ch") or []
    t_node = next(c for c in children if c["c"] == "T")
    assert abs(t_node["imp"] - 1.0) < 1e-9
    assert abs(t_node["shr"] - 1.0) < 1e-9
    # A itself emits nothing directly.
    assert abs(body["tree"]["dir"]) < 1e-9


def test_treatment_root_contribution_and_flows(client, token, project):
    """Contribution and elementary flows of the treatment itself are positive."""
    _seed_treatment(get_bd())
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "T", "method": METHOD},
        headers=token,
    )
    assert abs(r.json()["meta"]["total"] - 1.0) < 1e-9

    r = client.post(
        "/api/v1/calc/elementary-flows",
        json={"database": "fg", "code": "T", "method": METHOD},
        headers=token,
    )
    body = r.json()
    assert abs(body["total"] - 1.0) < 1e-9
    assert abs(body["flows"][0]["impact"] - 1.0) < 1e-9


def test_treatment_montecarlo_positive(client, token, project):
    """MC without distributions is deterministic — the mean must be +1 (P01 in montecarlo.run)."""
    _seed_treatment(get_bd())
    r = client.post(
        "/api/v1/calc/montecarlo",
        json={"database": "fg", "code": "T", "method": METHOD, "iterations": 3},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(r.json()["mean"] - 1.0) < 1e-9


def test_treatment_stacked_totals_positive(client, token, project):
    _seed_treatment(get_bd())
    r = client.post(
        "/api/v1/calc/compare-stacked",
        json={"subjects": [{"database": "fg", "code": "T"}], "methods": [METHOD], "dimensions": ["geo"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    total = r.json()["subjects"][0]["methods"][" · ".join(METHOD)]["total"]
    assert abs(total - 1.0) < 1e-9


def test_descent_scales_by_production_amount(client, token, project):
    """B produces 2 kg per run and consumes 1 kWh/run of S (1 kg CO2/kWh): per 1 kg of B the
    impact is 0.5 — the S child must carry 0.5, not 1.0 (P02: amt/prod, foreground prod ≠ 1)."""
    _seed_treatment(get_bd())
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "B", "method": METHOD, "cutoff": 0.001},
        headers=token,
    )
    body = r.json()
    assert abs(body["meta"]["total"] - 0.5) < 1e-9
    s_node = next(c for c in (body["tree"].get("ch") or []) if c["c"] == "S")
    assert abs(s_node["imp"] - 0.5) < 1e-9
    assert abs(body["tree"]["dir"]) < 1e-9
