"""The model the tests of "Why different?" split: every shape the split has to get right, and its copy.

The model holds each place where a sign or an index could go wrong without a simple model noticing: a production
amount bound to a parameter (``part``); a pair of processes with one fixed and two bound exchanges on the same pair,
summed in the matrix (``product`` → steel); a credit (``substitution``); a loop through the model (``recycle`` takes a
little ``product`` back); an emission bound to a parameter; a parameter computed by a formula (``d``) that a scenario
replaces; a treatment scored with the demand turned round (``waste``).
"""
from __future__ import annotations

from prism_lca.engine import lca, params
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.difference_pairing import COPIED_FROM

DB = "fx"
GWP = ("t", "gwp")
CH4 = ("t", "ch4")


def build_model(client, token) -> None:
    bd = get_bd()
    bd.Database("bio").write({
        ("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"},
        ("bio", "ch4"): {"name": "CH4", "type": "emission", "categories": ("air",), "unit": "kg"},
        # Characterised, but emitted by nothing of the model: only a copy's edit brings it into an inventory.
        ("bio", "n2o"): {"name": "N2O", "type": "emission", "categories": ("air",), "unit": "kg"},
    })
    bd.Database("bg").write({
        ("bg", "steel"): {"name": "steel", "unit": "kg", "exchanges": [
            {"input": ("bg", "steel"), "amount": 1, "type": "production"},
            {"input": ("bio", "co2"), "amount": 2.0, "type": "biosphere"},
        ]},
        ("bg", "power"): {"name": "power", "unit": "kWh", "exchanges": [
            {"input": ("bg", "power"), "amount": 1, "type": "production"},
            {"input": ("bg", "steel"), "amount": 0.01, "type": "technosphere"},
            {"input": ("bio", "co2"), "amount": 0.4, "type": "biosphere"},
        ]},
    })

    def ex(source, amount, kind, formula=None, uid=None):
        out = {"input": source, "amount": amount, "type": kind}
        if formula:
            out["formula"] = formula
        if uid:
            out["prism_uid"] = uid
        return out

    bd.Database(DB).write({
        (DB, "part"): {"name": "part", "unit": "unit", "reference product": "part", "exchanges": [
            ex((DB, "part"), 1.0, "production", "yield_part"),
            ex(("bg", "power"), 3.0, "technosphere", "kwh_part"),
            ex(("bio", "ch4"), 0.002, "biosphere", "leak"),
        ]},
        (DB, "product"): {"name": "product", "unit": "unit", "reference product": "product", "exchanges": [
            ex((DB, "product"), 1.0, "production"),
            ex((DB, "part"), 4.0, "technosphere", "n_parts"),
            ex(("bg", "steel"), 0.1, "technosphere", uid="steel-fixed"),
            ex(("bg", "steel"), 0.5, "technosphere", "steel_kg"),
            ex(("bg", "steel"), 0.2, "technosphere", "steel_extra"),
            ex(("bg", "power"), 0.3, "substitution", "credit_kwh"),
            ex((DB, "recycle"), 0.25, "technosphere", "r_share"),
            ex(("bio", "co2"), 6.0, "biosphere", "d"),
        ]},
        (DB, "recycle"): {"name": "recycle", "unit": "unit", "reference product": "recycle", "exchanges": [
            ex((DB, "recycle"), 1.0, "production"),
            ex((DB, "product"), 0.01, "technosphere"),
            ex(("bio", "co2"), 0.05, "biosphere"),
        ]},
        (DB, "waste"): {"name": "waste", "unit": "kg", "reference product": "waste", "exchanges": [
            ex((DB, "waste"), -1.0, "production"),
            ex(("bio", "co2"), 2.5, "biosphere", "burn_co2"),
        ]},
    })
    bd.databases[DB]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(GWP).write([(("bio", "co2"), 1.0), (("bio", "ch4"), 28.0), (("bio", "n2o"), 273.0)])
    bd.Method(CH4).write([(("bio", "ch4"), 1.0)])

    def p(**kw):
        r = client.post("/api/v1/params", json={"database": DB, **kw}, headers=token)
        assert r.status_code == 200, r.text

    for name, amount in (("yield_part", 1.0), ("kwh_part", 3.0), ("leak", 0.002), ("n_parts", 4.0), ("steel_kg", 0.5),
                         ("steel_extra", 0.2), ("credit_kwh", 0.3), ("r_share", 0.25), ("burn_co2", 2.5)):
        p(name=name, amount=amount)
    p(name="d", formula="2 * kwh_part")
    for code in ("part", "product", "waste"):
        params.register_activity_group(bd.get_node(database=DB, code=code))
    params.recalc_database(DB)
    lca.invalidate_lca_cache()


ONE = "one"


def one_process_model(client, token) -> None:
    """A model of one process and one emission bound to ``mass`` — a 1×1 system, whose supply a solver hands
    back as a scalar. Needs :func:`build_model`'s flows and methods."""
    bd = get_bd()
    bd.Database(ONE).write({(ONE, "bottle"): {"name": "bottle", "unit": "unit", "exchanges": [
        {"input": (ONE, "bottle"), "amount": 1.0, "type": "production"},
        {"input": ("bio", "co2"), "amount": 4.0, "type": "biosphere", "formula": "mass"},
    ]}})
    bd.databases[ONE]["prism_read_only"] = False
    bd.databases.flush()
    r = client.post("/api/v1/params", json={"database": ONE, "name": "mass", "amount": 4.0}, headers=token)
    assert r.status_code == 200, r.text
    params.register_activity_group(bd.get_node(database=ONE, code="bottle"))
    params.recalc_database(ONE)
    lca.invalidate_lca_cache()


def add_scenario(client, token, name: str, overrides: dict, database: str = DB) -> str:
    r = client.post("/api/v1/scenarios", json={"database": database, "name": name, "overrides": overrides},
                    headers=token)
    assert r.status_code == 200, r.text
    return r.json()["scenario"]["id"]


def fresh_score(database: str, code: str, method: tuple, amount: float = 1.0) -> float:
    """A score on a bw2calc LCA of its own, not the cached factorisation the split reads."""
    from bw2calc import LCA

    act = get_bd().get_node(database=database, code=code)
    calc = LCA({act.id: amount * lca._demand_sign(act)}, method=method)
    calc.lci()
    calc.lcia()
    return float(calc.score)


def copy_model(client, token, name: str = "fx copy") -> dict[str, str]:
    """Copy the model; original code → the copy's code, read from the record the copy keeps."""
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": DB, "name": name}, headers=token)
    assert r.status_code == 200, r.text
    return {act[COPIED_FROM]: act.key[1] for act in get_bd().Database(name)}


def edit_copy(client, token, codes: dict[str, str], name: str = "fx copy") -> None:
    """Three kinds of edit: an amount, a new process linked in, a process deleted (with its link)."""
    bd = get_bd()
    product = bd.get_node(database=name, code=codes["product"])
    fixed = next(ex for ex in product.technosphere() if ex.input.key == ("bg", "steel") and not ex.get("formula"))
    r = client.post("/api/v1/model/exchanges/amount", json={
        "activity_database": name, "activity_code": codes["product"], "uid": fixed["prism_uid"], "amount": 0.3,
    }, headers=token)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/model/activities", json={"database": name, "name": "paint", "unit": "kg"}, headers=token)
    assert r.status_code == 200, r.text
    paint = next(a for a in bd.Database(name) if a.get("name") == "paint").key[1]
    for body in (
        {"activity_code": paint, "input_database": "bio", "input_code": "co2", "amount": 3.0, "type": "biosphere"},
        {"activity_code": paint, "input_database": "bg", "input_code": "power", "amount": 0.5},
        {"activity_code": codes["product"], "input_database": name, "input_code": paint, "amount": 0.2},
    ):
        r = client.post("/api/v1/model/exchanges", json={"activity_database": name, **body}, headers=token)
        assert r.status_code == 200, r.text
    r = client.post("/api/v1/model/activities/delete",
                    json={"database": name, "code": codes["recycle"], "force": True}, headers=token)
    assert r.status_code == 200, r.text
