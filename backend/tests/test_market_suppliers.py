"""Which producers stand behind a market — what the assistant's tools ask before saying a linked market
was never opened. Reading the steel producers and then linking the steel market is having read what the
market is made of; the answer here is what lets the tools see that.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.market_suppliers import suppliers_of


def _steel(code: str, name: str, exchanges: list[dict], product: str = "steel, low-alloyed, hot rolled") -> dict:
    return {
        "name": name, "unit": "kg", "location": "GLO", "reference product": product,
        "exchanges": [{"input": ("bg", code), "amount": 1, "type": "production"}, *exchanges],
    }


def _world(bd) -> None:
    def buys(code: str, amount: float) -> dict:
        return {"input": ("bg", code), "amount": amount, "type": "technosphere"}

    bd.Database("bg").write({
        ("bg", "rolling-rer"): _steel("rolling-rer", "steel production, low-alloyed, hot rolled", []),
        ("bg", "rolling-row"): _steel("rolling-row", "steel production, low-alloyed, hot rolled", []),
        # Listed by the market with an amount of zero: it supplies nothing.
        ("bg", "rolling-idle"): _steel("rolling-idle", "steel production, low-alloyed, hot rolled", []),
        ("bg", "lorry"): _steel("lorry", "transport, freight, lorry", [], product="transport, freight, lorry"),
        ("bg", "steel-market"): _steel(
            "steel-market", "market for steel, low-alloyed, hot rolled",
            [buys("rolling-rer", 0.3), buys("rolling-row", 0.7), buys("lorry", 0.4), buys("steel-market", 0.01),
             buys("rolling-idle", 0)],
        ),
        ("bg", "steel-group"): _steel(
            "steel-group", "market group for steel, low-alloyed, hot rolled", [buys("steel-market", 1.0)]
        ),
        # A waste market draws on its treatment with a negative amount; the treatment still is its supplier.
        ("bg", "scrap-treatment"): _steel("scrap-treatment", "treatment of scrap steel", [], product="scrap steel"),
        ("bg", "scrap-market"): _steel(
            "scrap-market", "market for scrap steel", [buys("scrap-treatment", -1.0)], product="scrap steel"
        ),
    })


def test_a_market_names_every_producer_of_its_own_product_and_nothing_else(project):
    _world(get_bd())
    got = suppliers_of([("bg", "steel-market")])
    assert got == [{
        "database": "bg", "code": "steel-market",
        # Both producers whatever their share; not the lorry (another product), not the market itself,
        # and not the producer the market lists with an amount of zero.
        "suppliers": [{"database": "bg", "code": "rolling-rer"}, {"database": "bg", "code": "rolling-row"}],
    }]


def test_only_markets_have_an_entry_and_only_one_level_is_looked_through(project):
    _world(get_bd())
    asked = [("bg", "rolling-rer"), ("bg", "steel-group"), ("bg", "scrap-market"), ("bg", "nowhere"),
             ("bg", "steel-group")]
    got = {m["code"]: [s["code"] for s in m["suppliers"]] for m in suppliers_of(asked)}
    assert got == {
        # A market group names its member market, not the producers behind that.
        "steel-group": ["steel-market"],
        "scrap-market": ["scrap-treatment"],
    }


def test_the_endpoint_answers_for_a_list(client, token, project):
    _world(get_bd())
    r = client.post(
        "/api/v1/model/market-suppliers",
        json={"datasets": [{"database": "bg", "code": "steel-market"}, {"database": "bg", "code": "lorry"}]},
        headers=token,
    )
    assert r.status_code == 200
    assert [m["code"] for m in r.json()["markets"]] == ["steel-market"]
    assert len(r.json()["markets"][0]["suppliers"]) == 2
