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


def _coating_world(bd, produced: float = 1.0) -> None:
    """A coating market billed per square metre, two producers behind it, and the steel world beside it."""
    _world(bd)

    def plain(name: str, unit: str, location: str = "GLO") -> dict:
        return {"name": name, "unit": unit, "location": location, "reference product": name, "exchanges": []}

    def uses(code: str, amount: float) -> dict:
        return {"input": ("cg", code), "amount": amount, "type": "technosphere"}

    def coating(code: str, location: str) -> dict:
        return {
            "name": "zinc coating, coils", "unit": "square meter", "location": location,
            "reference product": "zinc coat, coils",
            "exchanges": [
                {"input": ("cg", code), "amount": produced, "type": "production"},
                uses("gas", 17.544341 * produced), uses("water", 4.03 * produced),
                uses("zinc", 0.679 * produced), uses("acid", 0.34 * produced),
                uses("power-ras", 0.2339 * produced), uses("power-rna", 0.12 * produced),
                uses("nitrogen", 0.05 * produced),
                uses("degreaser", 0.001 * produced),
            ],
        }

    bd.Database("cg").write({
        ("cg", "gas"): plain("market for heat, natural gas", "megajoule"),
        ("cg", "water"): plain("market for water, deionised", "kilogram"),
        ("cg", "zinc"): plain("market for zinc", "kilogram"),
        ("cg", "acid"): plain("market for hydrochloric acid", "kilogram"),
        # One input bought in two regions, as a RoW producer buys its electricity.
        ("cg", "power-ras"): plain("market group for electricity, medium voltage", "kilowatt hour", "RAS"),
        ("cg", "power-rna"): plain("market group for electricity, medium voltage", "kilowatt hour", "RNA"),
        ("cg", "nitrogen"): plain("market for nitrogen, liquid", "kilogram"),
        ("cg", "degreaser"): plain("market for degreaser", "kilogram"),
        ("cg", "coat-row"): coating("coat-row", "RoW"),
        ("cg", "coat-rer"): coating("coat-rer", "RER"),
        ("cg", "coat-market"): {
            "name": "market for zinc coat, coils", "unit": "square meter", "location": "GLO",
            "reference product": "zinc coat, coils",
            "exchanges": [
                {"input": ("cg", "coat-market"), "amount": 1, "type": "production"},
                {"input": ("cg", "coat-row"), "amount": 0.6694, "type": "technosphere"},
                {"input": ("cg", "coat-rer"), "amount": 0.3306, "type": "technosphere"},
            ],
        },
    })


def test_a_market_per_square_metre_shows_what_its_main_supplier_consumes_for_one(project):
    """The zinc per square metre is what says which square metre is meant; the market's own inputs are
    only its two producers. The six largest inputs of the main one, per unit, largest first — and one
    input bought in two regions counted once, summed, so it does not take two of the six places."""
    from prism_lca.engine.market_suppliers import market_main_supplier_inputs

    bd = get_bd()
    _coating_world(bd)
    got = market_main_supplier_inputs(bd.get_node(database="cg", code="coat-market"))
    assert got is not None
    assert (got["name"], got["location"], got["share"], got["per"]) == (
        "zinc coating, coils", "RoW", 0.6694, "1 square meter"
    )
    assert [(i["name"], i["amount"], i["unit"], i["location"]) for i in got["biggest_inputs"]] == [
        ("market for heat, natural gas", 17.54, "megajoule", "GLO"),
        ("market for water, deionised", 4.03, "kilogram", "GLO"),
        ("market for zinc", 0.679, "kilogram", "GLO"),
        ("market group for electricity, medium voltage", 0.3539, "kilowatt hour", "RAS and 1 more"),
        ("market for hydrochloric acid", 0.34, "kilogram", "GLO"),
        ("market for nitrogen, liquid", 0.05, "kilogram", "GLO"),
    ]


def test_supplier_inputs_are_per_one_unit_of_what_the_supplier_produces(project):
    """A producer that states its inventory for two square metres still answers per one."""
    from prism_lca.engine.market_suppliers import market_main_supplier_inputs

    bd = get_bd()
    _coating_world(bd, produced=2.0)
    got = market_main_supplier_inputs(bd.get_node(database="cg", code="coat-market"))
    assert {i["name"]: i["amount"] for i in got["biggest_inputs"]}["market for zinc"] == 0.679


def test_material_markets_and_producers_get_no_supplier_inputs(project):
    """A market in kilograms is its material — its supplier says what it is, the inputs add nothing — and
    a producer's inputs are already its own; neither carries the block, nor the market detail of either."""
    from prism_lca.engine.market_suppliers import market_main_supplier_inputs
    from prism_lca.engine.model import activity_detail

    bd = get_bd()
    _coating_world(bd)
    steel = bd.get_node(database="bg", code="steel-market")
    producer = bd.get_node(database="cg", code="coat-row")
    assert market_main_supplier_inputs(steel) is None
    assert market_main_supplier_inputs(producer) is None
    assert "main_supplier_inputs" not in activity_detail(steel)["activity"]
    assert "main_supplier_inputs" not in activity_detail(producer)["activity"]
    market = activity_detail(bd.get_node(database="cg", code="coat-market"))["activity"]
    assert market["main_supplier_inputs"]["biggest_inputs"][2]["amount"] == 0.679


def test_the_detail_endpoint_carries_the_supplier_inputs_of_a_market_per_square_metre(client, token, project):
    _coating_world(get_bd())
    r = client.get("/api/v1/model/activity?database=cg&code=coat-market", headers=token)
    assert r.status_code == 200
    block = r.json()["activity"]["main_supplier_inputs"]
    assert block["per"] == "1 square meter"
    assert len(block["biggest_inputs"]) == 6


def test_inputs_of_the_same_name_but_another_product_stay_apart(project):
    """Summing is for one product bought in several regions. Two allocated outputs of one process share
    its name; bought both, they are two inputs and say which product they are."""
    from prism_lca.engine.market_suppliers import market_main_supplier_inputs

    bd = get_bd()

    def output(code: str, product: str) -> dict:
        return {"name": "chlor-alkali electrolysis", "unit": "kilogram", "location": "RER",
                "reference product": product, "exchanges": []}

    bd.Database("ag").write({
        ("ag", "chlorine"): output("chlorine", "chlorine, gaseous"),
        ("ag", "lye"): output("lye", "sodium hydroxide"),
        ("ag", "etch"): {
            "name": "etching, glass", "unit": "square meter", "location": "RER", "reference product": "etched glass",
            "exchanges": [
                {"input": ("ag", "etch"), "amount": 1, "type": "production"},
                {"input": ("ag", "chlorine"), "amount": 0.2, "type": "technosphere"},
                {"input": ("ag", "lye"), "amount": 0.3, "type": "technosphere"},
            ],
        },
        ("ag", "etch-market"): {
            "name": "market for etched glass", "unit": "square meter", "location": "GLO",
            "reference product": "etched glass",
            "exchanges": [
                {"input": ("ag", "etch-market"), "amount": 1, "type": "production"},
                {"input": ("ag", "etch"), "amount": 1, "type": "technosphere"},
            ],
        },
    })
    got = market_main_supplier_inputs(bd.get_node(database="ag", code="etch-market"))
    assert [(i["product"], i["amount"]) for i in got["biggest_inputs"]] == [
        ("sodium hydroxide", 0.3), ("chlorine, gaseous", 0.2)
    ]


def test_a_market_group_per_square_metre_shows_no_supplier_inputs(project):
    """A market group buys from markets. Their inputs are producers again — listing them as what one
    square metre consumes would claim an answer the block does not have, so there is no block."""
    from prism_lca.engine.market_suppliers import market_main_supplier_inputs

    bd = get_bd()
    _coating_world(bd)
    bd.Database("gg").write({
        ("gg", "coat-group"): {
            "name": "market group for zinc coat, coils", "unit": "square meter", "location": "GLO",
            "reference product": "zinc coat, coils",
            "exchanges": [
                {"input": ("gg", "coat-group"), "amount": 1, "type": "production"},
                {"input": ("cg", "coat-market"), "amount": 1.0, "type": "technosphere"},
            ],
        },
    })
    assert market_main_supplier_inputs(bd.get_node(database="gg", code="coat-group")) is None


def test_a_market_group_quotes_no_member_markets_boilerplate_as_its_suppliers_comment(project):
    """A market group buys from markets, so the supplier it mostly consists of is a member market, and that
    comment is the market boilerplate. Quoted, the group's detail presented it as what its supplier states, and
    the review dossier repeated it so. The group carries no supplier comment; the member market still quotes
    its own producer."""
    from prism_lca.engine.market_suppliers import market_main_supplier_comment
    from prism_lca.engine.model import activity_detail

    bd = get_bd()
    boilerplate = "This is a market activity. Each market represents the consumption mix of a product."
    bd.Database("dg").write({
        ("dg", "refinery"): {
            "name": "diesel production, petroleum refinery operation", "unit": "kilogram", "location": "RER",
            "reference product": "diesel", "comment": "Refinery data for European refineries.",
            "exchanges": [{"input": ("dg", "refinery"), "amount": 1, "type": "production"}],
        },
        ("dg", "diesel-rer"): {
            "name": "market for diesel", "unit": "kilogram", "location": "RER", "reference product": "diesel",
            "comment": boilerplate,
            "exchanges": [
                {"input": ("dg", "diesel-rer"), "amount": 1, "type": "production"},
                {"input": ("dg", "refinery"), "amount": 1.0, "type": "technosphere"},
            ],
        },
        ("dg", "diesel-group"): {
            "name": "market group for diesel", "unit": "kilogram", "location": "GLO", "reference product": "diesel",
            "comment": "This is a market group activity.",
            "exchanges": [
                {"input": ("dg", "diesel-group"), "amount": 1, "type": "production"},
                {"input": ("dg", "diesel-rer"), "amount": 1.0, "type": "technosphere"},
            ],
        },
    })
    group = bd.get_node(database="dg", code="diesel-group")
    assert market_main_supplier_comment(group) is None
    detail = activity_detail(group)["activity"]
    assert "main_supplier_comment" not in detail
    assert detail["comment"] == "This is a market group activity."  # its own words, attributed to itself

    member = market_main_supplier_comment(bd.get_node(database="dg", code="diesel-rer"))
    assert member is not None
    assert (member["name"], member["comment"]) == (
        "diesel production, petroleum refinery operation", "Refinery data for European refineries."
    )
