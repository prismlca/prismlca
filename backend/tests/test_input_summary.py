"""The few inputs a short view lists of a dataset: one input bought in several regions is one row.

A RoW producer buys its electricity from several regional market groups and country markets, and ranked one
exchange per row those fragments pushed the coating powder to the last of six places and showed every amount as
a part. What is summed and what stays apart is the rule in ``engine/input_summary.py``; these pin it on a
throwaway Brightway with the shapes ecoinvent has.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.input_summary import biggest_inputs


def _dataset(name: str, unit: str, location: str = "GLO", product: str | None = None, exchanges=()) -> dict:
    out = {"name": name, "unit": unit, "location": location, "exchanges": list(exchanges)}
    if product is not None:
        out["reference product"] = product
    return out


def _uses(db: str, code: str, amount: float) -> dict:
    return {"input": (db, code), "amount": amount, "type": "technosphere"}


def _rows(rows: list[dict]) -> list[tuple]:
    return [(r["name"], r["amount"], r["unit"], r["location"]) for r in rows]


def _coating_world(bd) -> None:
    """A powder coating [RoW] as ecoinvent has it, and a market per square metre that buys it."""
    power, heat = "electricity, medium voltage", "heat, natural gas"

    def made(code: str, amount: float) -> dict:
        return _uses("rg", code, amount)

    bd.Database("rg").write({
        ("rg", "power-ras"): _dataset("market group for electricity, medium voltage", "kilowatt hour", "RAS", power),
        ("rg", "power-rna"): _dataset("market group for electricity, medium voltage", "kilowatt hour", "RNA", power),
        ("rg", "power-au"): _dataset("market for electricity, medium voltage", "kilowatt hour", "AU", power),
        ("rg", "heat-row"): _dataset("market for heat, natural gas", "megajoule", "RoW", heat),
        ("rg", "heat-caqc"): _dataset("market for heat, natural gas", "megajoule", "CA-QC", heat),
        ("rg", "acid"): _dataset("market for hydrochloric acid", "kilogram", "RoW", "hydrochloric acid"),
        ("rg", "powder"): _dataset("market for coating powder", "kilogram", "RoW", "coating powder"),
        ("rg", "waste"): _dataset("market for hazardous waste", "kilogram", "RoW", "hazardous waste"),
        ("rg", "oil"): _dataset("market for lubricating oil", "kilogram", "RoW", "lubricating oil"),
        ("rg", "idle"): _dataset("market for degreaser", "kilogram", "RoW", "degreaser"),
        ("rg", "coat-row"): _dataset(
            "powder coating, steel", "square meter", "RoW", "powder coat, steel",
            [
                {"input": ("rg", "coat-row"), "amount": 1, "type": "production"},
                made("heat-row", 33.84), made("power-ras", 0.8821), made("heat-caqc", 0.5561), made("acid", 0.34),
                made("power-rna", 0.272), made("powder", 0.0965), made("waste", -0.031), made("power-au", 0.02),
                made("oil", 0.0172), made("idle", 0),
            ],
        ),
        ("rg", "coat-market"): _dataset(
            "market for powder coat, steel", "square meter", "GLO", "powder coat, steel",
            [{"input": ("rg", "coat-market"), "amount": 1, "type": "production"}, made("coat-row", 1.0)],
        ),
    })


def test_one_input_bought_in_several_regions_is_one_row(project):
    """Six rows of fragments left room for the powder only in last place. Summed, electricity is one row —
    the market groups of RAS and RNA and the market of AU are the same electricity — and what the coating
    consumes besides it shows: powder, the waste it sends to treatment (negative), lubricating oil."""
    bd = get_bd()
    _coating_world(bd)
    got = biggest_inputs(bd.get_node(database="rg", code="coat-row"), "test", digits=6)
    assert _rows(got) == [
        ("market for heat, natural gas", 34.3961, "megajoule", "RoW and 1 more"),
        ("market group for electricity, medium voltage", 1.1741, "kilowatt hour", "RAS and 2 more"),
        ("market for hydrochloric acid", 0.34, "kilogram", "RoW"),
        ("market for coating powder", 0.0965, "kilogram", "RoW"),
        ("market for hazardous waste", -0.031, "kilogram", "RoW"),
        ("market for lubricating oil", 0.0172, "kilogram", "RoW"),
    ]
    assert not any("product" in r for r in got)


def test_the_block_of_a_market_per_square_metre_follows_the_same_rule(project):
    """The block that shows what one square metre consumes reads the main producer by the same rule, to four
    significant digits per one unit."""
    from prism_lca.engine.market_suppliers import market_main_supplier_inputs

    bd = get_bd()
    _coating_world(bd)
    block = market_main_supplier_inputs(bd.get_node(database="rg", code="coat-market"))
    assert block["name"] == "powder coating, steel"
    assert _rows(block["biggest_inputs"])[:2] == [
        ("market for heat, natural gas", 34.4, "megajoule", "RoW and 1 more"),
        ("market group for electricity, medium voltage", 1.174, "kilowatt hour", "RAS and 2 more"),
    ]


def test_a_markets_suppliers_stay_one_row_each_while_its_transport_is_summed(project):
    """Which region supplies how much is what a market IS: its suppliers sell its own product and stay apart,
    region by region. The lorry it buys in two regions is one row."""
    bd = get_bd()
    bd.Database("mg").write({
        ("mg", "steel-rer"): _dataset("steel production", "kilogram", "RER", "steel"),
        ("mg", "steel-row"): _dataset("steel production", "kilogram", "RoW", "steel"),
        ("mg", "lorry-rer"): _dataset("market for transport, freight, lorry", "ton kilometer", "RER", "lorry"),
        ("mg", "lorry-row"): _dataset("market for transport, freight, lorry", "ton kilometer", "RoW", "lorry"),
        ("mg", "market"): _dataset(
            "market for steel", "kilogram", "GLO", "steel",
            [
                {"input": ("mg", "market"), "amount": 1, "type": "production"},
                _uses("mg", "steel-rer", 0.6), _uses("mg", "steel-row", 0.4),
                _uses("mg", "lorry-rer", 0.05), _uses("mg", "lorry-row", 0.03),
            ],
        ),
    })
    got = biggest_inputs(bd.get_node(database="mg", code="market"), "test", digits=6)
    assert _rows(got) == [
        ("steel production", 0.6, "kilogram", "RER"),
        ("steel production", 0.4, "kilogram", "RoW"),
        ("market for transport, freight, lorry", 0.08, "ton kilometer", "RER and 1 more"),
    ]
    assert not any("product" in r for r in got)


def test_a_mix_that_is_not_called_a_market_keeps_its_technologies_apart(project):
    """A production mix buys its own product from each technology. The rule hangs on the product, not on the
    word "market", so the wind and the hydro of a mix stay two rows."""
    bd = get_bd()
    power = "electricity, high voltage"
    bd.Database("xg").write({
        ("xg", "wind"): _dataset("electricity production, wind", "kilowatt hour", "PT", power),
        ("xg", "hydro"): _dataset("electricity production, hydro", "kilowatt hour", "PT", power),
        ("xg", "mix"): _dataset(
            "electricity, high voltage, production mix", "kilowatt hour", "PT", power,
            [{"input": ("xg", "mix"), "amount": 1, "type": "production"},
             _uses("xg", "wind", 0.31), _uses("xg", "hydro", 0.07)],
        ),
    })
    got = biggest_inputs(bd.get_node(database="xg", code="mix"), "test", digits=6)
    assert [(r["name"], r["amount"]) for r in got] == [
        ("electricity production, wind", 0.31), ("electricity production, hydro", 0.07)
    ]


def test_one_product_from_two_differently_named_datasets_stays_two_rows(project):
    """Recycling and disposal of one waste sell the same product. One row named after the larger would say
    that all of it is recycled."""
    bd = get_bd()
    waste = "waste reinforcement steel"
    bd.Database("wg").write({
        ("wg", "recycling"): _dataset("treatment of waste reinforcement steel, recycling", "kilogram", "ZA", waste),
        ("wg", "disposal"): _dataset("treatment of waste reinforcement steel, disposal", "kilogram", "ZA", waste),
        ("wg", "field"): _dataset(
            "collector field construction", "square meter", "ZA", "collector field",
            [{"input": ("wg", "field"), "amount": 1, "type": "production"},
             _uses("wg", "recycling", -3.0), _uses("wg", "disposal", -1.0)],
        ),
    })
    got = biggest_inputs(bd.get_node(database="wg", code="field"), "test", digits=6)
    assert [(r["name"], r["amount"]) for r in got] == [
        ("treatment of waste reinforcement steel, recycling", -3.0),
        ("treatment of waste reinforcement steel, disposal", -1.0),
    ]


def test_an_own_process_without_products_sums_only_what_it_booked_twice(project):
    """Hand-built processes may carry no reference product. Then the name keeps two inputs apart, and the
    same dataset booked twice is one row in one region — not "GLO and 1 more"."""
    bd = get_bd()
    bd.Database("fg").write({
        ("fg", "tube"): _dataset("steel tube", "kilogram"),
        ("fg", "bolt"): _dataset("bolt", "kilogram"),
        ("fg", "frame"): _dataset(
            "frame", "unit", "DE", None,
            [{"input": ("fg", "frame"), "amount": 1, "type": "production"},
             _uses("fg", "tube", 0.5), _uses("fg", "bolt", 0.2), _uses("fg", "tube", 0.25)],
        ),
    })
    got = biggest_inputs(bd.get_node(database="fg", code="frame"), "test", digits=6)
    assert _rows(got) == [("steel tube", 0.75, "kilogram", "GLO"), ("bolt", 0.2, "kilogram", "GLO")]


def test_a_purchase_and_a_credit_of_one_input_are_not_netted(project):
    """Bought in two regions it is one row; sent back it is another. A net 0.2 kg would hide both the steel the
    process uses and the credit it books — and an exact credit would make the steel vanish."""
    bd = get_bd()
    steel = "steel, low-alloyed"
    bd.Database("sg").write({
        ("sg", "steel-rer"): _dataset("market for steel, low-alloyed", "kilogram", "RER", steel),
        ("sg", "steel-glo"): _dataset("market group for steel, low-alloyed", "kilogram", "GLO", steel),
        ("sg", "bracket"): _dataset(
            "bracket, with recycling credit", "unit", "DE", "bracket",
            [{"input": ("sg", "bracket"), "amount": 1, "type": "production"},
             _uses("sg", "steel-rer", 0.7), _uses("sg", "steel-glo", 0.3), _uses("sg", "steel-rer", -0.8)],
        ),
        ("sg", "even"): _dataset(
            "bracket, exact credit", "unit", "DE", "bracket",
            [{"input": ("sg", "even"), "amount": 1, "type": "production"},
             _uses("sg", "steel-rer", 1.0), _uses("sg", "steel-glo", -1.0)],
        ),
    })
    got = biggest_inputs(bd.get_node(database="sg", code="bracket"), "test", digits=6)
    assert _rows(got) == [
        ("market for steel, low-alloyed", 1.0, "kilogram", "RER and 1 more"),
        ("market for steel, low-alloyed", -0.8, "kilogram", "RER"),
    ]
    even = biggest_inputs(bd.get_node(database="sg", code="even"), "test", digits=6)
    assert [(r["amount"], r["location"]) for r in even] == [(1.0, "RER"), (-1.0, "GLO")]


def test_the_detail_endpoint_adds_the_rows_only_when_a_summary_asks(client, token, project):
    _coating_world(get_bd())
    plain = client.get("/api/v1/model/activity?database=rg&code=coat-row", headers=token)
    assert plain.status_code == 200
    assert "biggest_inputs" not in plain.json()
    short = client.get("/api/v1/model/activity?database=rg&code=coat-row&summary=true", headers=token)
    assert short.status_code == 200
    body = short.json()
    assert body["biggest_inputs"][1]["location"] == "RAS and 2 more"
    # The full exchange list stays as it is: every region its own exchange, for the split and the uids.
    assert len([e for e in body["exchanges"] if e["type"] == "technosphere"]) == 10
