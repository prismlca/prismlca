from __future__ import annotations

import pytest

from prism_lca.engine.bootstrap import get_bd

METHOD = ["test", "gwp"]


def approx(x: float) -> object:
    """The solve runs on single-precision matrix values: equal to about 1e-8, not to the last digit."""
    return pytest.approx(x, rel=1e-6)


def _seed(bd):
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    fg = bd.Database("fg")
    fg.write({
        ("fg", "gly"): {"name": "glycerine", "unit": "kg", "reference product": "glycerine",
                        "exchanges": [{"input": ("fg", "gly"), "amount": 1, "type": "production"},
                                      {"input": ("biosphere", "co2"), "amount": 3.0, "type": "biosphere"}]},
        ("fg", "cream"): {"name": "cream", "unit": "kg", "reference product": "cream",
                          "exchanges": [{"input": ("fg", "cream"), "amount": 1, "type": "production"},
                                        {"input": ("fg", "gly"), "amount": 0.4, "type": "technosphere"}]},
        ("fg", "tube"): {"name": "tube", "unit": "unit", "reference product": "tube",
                         "exchanges": [{"input": ("fg", "tube"), "amount": 1, "type": "production"},
                                       {"input": ("fg", "cream"), "amount": 0.05406, "type": "technosphere"}]},
    })
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def test_inventory_per_functional_unit(client, token, project):
    _seed(get_bd())
    r = client.post("/api/v1/calc/inventory", json={"database": "fg", "code": "tube"}, headers=token)
    assert r.status_code == 200, r.text
    inv = {x["name"]: x["quantity"] for x in r.json()["inventory"]}
    # 0.4 kg glycerine per kg cream x 0.05406 kg cream per tube = 21.6 g. Derived by hand twice in a
    # real run, once by the reviewer who then raised its own arithmetic as a finding.
    assert abs(inv["glycerine"] - 0.4 * 0.05406) < 1e-9
    assert abs(inv["cream"] - 0.05406) < 1e-9
    assert "tube" not in inv  # the functional unit is not part of its own inventory

    r = client.post("/api/v1/calc/inventory", json={"database": "fg", "code": "tube", "query": "glyc"}, headers=token)
    assert [x["name"] for x in r.json()["inventory"]] == ["glycerine"]


def test_inventory_after_project_switch_ignores_other_projects_cached_method(client, token, project):
    """`test_inventory_per_functional_unit` failed only in a single-process run with
    `assert method in methods` from bw2data. The suspect was Brightway's method register; the cause was the
    LCA cache, which outlives a project switch: the inventory borrowed the first cached entry's method
    without asking which project it belonged to, and that method does not exist in the current project
    (fixed in b86dca8d). xdist hid it because a worker rarely ran a cache-filling test
    right before this one. This is that sequence in one test, so the fix cannot regress unnoticed."""
    import uuid

    bd = get_bd()
    _seed(bd)  # registers ("test", "gwp") in the first project and fills the LCA cache
    r = client.post("/api/v1/calc/inventory", json={"database": "fg", "code": "tube"}, headers=token)
    assert r.status_code == 200, r.text

    other = "test-" + uuid.uuid4().hex[:8]
    r = client.post("/api/v1/projects", json={"name": other}, headers=token)
    assert r.status_code == 200, r.text
    assert str(bd.projects.current) == other
    # Same databases, a differently named method: the cache entry of the first project still exists,
    # and its method ("test", "gwp") is unknown here.
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("fg").write({
        ("fg", "gly"): {"name": "glycerine", "unit": "kg", "reference product": "glycerine",
                        "exchanges": [{"input": ("fg", "gly"), "amount": 1, "type": "production"},
                                      {"input": ("biosphere", "co2"), "amount": 3.0, "type": "biosphere"}]},
        ("fg", "tube"): {"name": "tube", "unit": "unit", "reference product": "tube",
                         "exchanges": [{"input": ("fg", "tube"), "amount": 1, "type": "production"},
                                       {"input": ("fg", "gly"), "amount": 2.0, "type": "technosphere"}]},
    })
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("other", "gwp")).write([(("biosphere", "co2"), 1.0)])

    r = client.post("/api/v1/calc/inventory", json={"database": "fg", "code": "tube"}, headers=token)
    assert r.status_code == 200, r.text
    inv = {x["name"]: x["quantity"] for x in r.json()["inventory"]}
    assert abs(inv["glycerine"] - 2.0) < 1e-9


def _seed_with_background(bd):
    """A tube made in the model from cream, with a cap from the library, drawing on a read-only background.

    The background uses electricity itself (in its glycerine market), so the foreground's direct draw of
    electricity and the whole chain's total differ — the difference the two scopes exist for."""
    from prism_lca.engine.library import LIBRARY_DB

    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )

    def proc(db, code, name, unit, inputs, production=1.0, **extra):
        exchanges = [{"input": (db, code), "amount": production, "type": "production"}]
        for (inp, amount, kind) in inputs:
            exchanges.append({"input": inp, "amount": amount, "type": kind})
        return {(db, code): {"name": name, "unit": unit, "reference product": name, "location": "GLO",
                             "exchanges": exchanges, **extra}}

    bg = {}
    bg |= proc("bg", "elec", "electricity", "kWh", [(("biosphere", "co2"), 0.5, "biosphere")])
    bg |= proc("bg", "gly", "market for glycerine", "kg", [(("bg", "elec"), 0.5, "technosphere")])
    bg |= proc("bg", "pp", "polypropylene", "kg", [(("biosphere", "co2"), 2.0, "biosphere")])
    bg |= proc("bg", "heat", "heat", "MJ", [(("biosphere", "co2"), 0.07, "biosphere")])
    # A treatment: its reference flow is negative, and the waste is sent to it with a negative amount.
    bg |= proc("bg", "waste", "treatment of waste plastic", "kg",
               [(("biosphere", "co2"), 1.0, "biosphere")], production=-1.0)
    bd.Database("bg").write(bg)
    bd.databases["bg"]["prism_read_only"] = True
    bd.databases.flush()

    bd.Database(LIBRARY_DB).write(proc(LIBRARY_DB, "cap", "tube cap", "unit", [(("bg", "pp"), 0.002, "technosphere")]))

    fg = {}
    fg |= proc("fg", "cream", "cream", "kg", [(("bg", "gly"), 0.4, "technosphere"),
                                              (("bg", "heat"), 0.1, "substitution")])
    fg |= proc("fg", "tube", "tube", "unit", [(("fg", "cream"), 0.05406, "technosphere"),
                                              ((LIBRARY_DB, "cap"), 1.0, "technosphere"),
                                              (("bg", "elec"), 0.01, "technosphere"),
                                              (("bg", "waste"), -0.003, "technosphere")])
    bd.Database("fg").write(fg)
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _inventory(client, token, **body):
    r = client.post("/api/v1/calc/inventory", json={"database": "fg", "code": "tube", **body}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def test_foreground_scope_is_the_recipe_with_direct_draws(client, token, project):
    from prism_lca.engine.library import LIBRARY_DB

    _seed_with_background(get_bd())
    out = _inventory(client, token, scope="foreground")
    assert out["scope"] == "foreground"
    rows = {r["name"]: r for r in out["inventory"]}
    assert set(rows) == {"cream", "tube cap", "market for glycerine", "polypropylene", "electricity", "heat",
                         "treatment of waste plastic"}
    assert (rows["cream"]["kind"], rows["cream"]["database"]) == ("model", "fg")
    assert (rows["tube cap"]["kind"], rows["tube cap"]["database"]) == ("library", LIBRARY_DB)
    assert {rows[n]["kind"] for n in ("market for glycerine", "polypropylene", "electricity", "heat")} == {"background"}
    assert rows["cream"]["quantity"] == approx(0.05406)
    assert rows["tube cap"]["quantity"] == approx(1.0)
    assert rows["market for glycerine"]["quantity"] == approx(0.4 * 0.05406)
    assert rows["polypropylene"]["quantity"] == approx(0.002)  # drawn through the library process
    # Only what the foreground draws itself — the glycerine market's own electricity is not in it.
    assert rows["electricity"]["quantity"] == approx(0.01)
    # A substitution is a negative draw; a waste sent to treatment keeps the sign of the exchange.
    assert rows["heat"]["quantity"] == approx(-0.1 * 0.05406)
    assert rows["treatment of waste plastic"]["quantity"] == approx(-0.003)
    # The model's own processes come first, then the library, then what they draw.
    kinds = [r["kind"] for r in out["inventory"]]
    assert kinds == sorted(kinds, key=["model", "library", "background"].index)
    assert "reading" in out


def test_scopes_agree_where_they_overlap_and_differ_by_the_backgrounds_own_use(client, token, project):
    _seed_with_background(get_bd())
    fg = {r["name"]: r["quantity"] for r in _inventory(client, token, scope="foreground")["inventory"]}
    whole = _inventory(client, token)
    assert whole["scope"] == "all" and "reading" not in whole
    every = {r["name"]: r["quantity"] for r in whole["inventory"]}
    assert all("kind" not in r for r in whole["inventory"])
    for name in ("cream", "tube cap", "market for glycerine", "polypropylene", "heat", "treatment of waste plastic"):
        assert fg[name] == approx(every[name]), name
    # The whole chain adds the glycerine market's electricity: 0.01 + 0.5 kWh/kg × 0.021624 kg.
    assert every["electricity"] == approx(0.01 + 0.5 * 0.4 * 0.05406)


def test_query_and_top_n_narrow_either_scope(client, token, project):
    _seed_with_background(get_bd())
    out = _inventory(client, token, scope="foreground", query="GLYC")
    assert [r["name"] for r in out["inventory"]] == ["market for glycerine"]
    assert out["total_entries"] == 1 and out["note"] is None

    out = _inventory(client, token, scope="foreground", query="titanium")
    assert out["inventory"] == [] and "titanium" in out["note"]

    out = _inventory(client, token, top_n=2)
    assert len(out["inventory"]) == 2 and out["total_entries"] == 7
    # The note names arguments the tool has: query, top_n, and the foreground scope.
    assert "'query'" in out["note"] and "'top_n'" in out["note"] and "scope='foreground'" in out["note"]
    out = _inventory(client, token, scope="foreground", top_n=2)
    assert "scope='foreground'" not in out["note"]


def test_unknown_scope_is_refused(client, token, project):
    _seed_with_background(get_bd())
    r = client.post("/api/v1/calc/inventory", json={"database": "fg", "code": "tube", "scope": "background"},
                    headers=token)
    assert r.status_code == 422
