from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd

METHOD = ["test", "gwp"]


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
