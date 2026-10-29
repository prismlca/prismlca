from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd


def _seed(bd) -> None:
    bd.Database("bg").write(
        {
            ("bg", "elec_de"): {
                "name": "electricity production, hard coal", "unit": "kWh",
                "reference product": "electricity, high voltage", "location": "DE",
                "exchanges": [{"input": ("bg", "elec_de"), "amount": 1, "type": "production"}],
            },
            ("bg", "elec_rer"): {
                "name": "electricity production, hydro", "unit": "kWh",
                "reference product": "electricity, high voltage", "location": "RER",
                "exchanges": [{"input": ("bg", "elec_rer"), "amount": 1, "type": "production"}],
            },
            ("bg", "elec_mj"): {
                "name": "electricity, medium voltage", "unit": "MJ",
                "reference product": "electricity, medium voltage", "location": "DE",
                "exchanges": [{"input": ("bg", "elec_mj"), "amount": 1, "type": "production"}],
            },
            ("bg", "steel"): {
                "name": "steel production", "unit": "kg",
                "reference product": "steel", "location": "GLO",
                "exchanges": [{"input": ("bg", "steel"), "amount": 1, "type": "production"}],
            },
        }
    )


def test_provider_candidates_ranking(client, token, project):
    _seed(get_bd())
    r = client.post(
        "/api/v1/model/providers/candidates",
        json={"product": "electricity high voltage", "unit": "kWh", "location": "DE",
              "databases": ["bg"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    cands = r.json()["candidates"]
    codes = [c["code"] for c in cands]

    # electricity candidates surface; steel (no term overlap) does not
    assert "elec_de" in codes
    assert "steel" not in codes

    # best match = same unit (kWh) + same location (DE)
    assert codes[0] == "elec_de"
    top = cands[0]
    assert any("exact unit match" in reason for reason in top["reasons"])
    assert any("same location" in reason for reason in top["reasons"])

    # the MJ electricity is penalised for the unit mismatch and ranks below the kWh ones
    mj = next(c for c in cands if c["code"] == "elec_mj")
    assert any("unit mismatch" in reason for reason in mj["reasons"])
    assert codes.index("elec_de") < codes.index("elec_mj")
    assert codes.index("elec_rer") < codes.index("elec_mj")
