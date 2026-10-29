from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd


def _seed_calc(bd) -> None:
    """Minimal self-contained system: bottle needs 2 kWh electricity; each kWh emits 0.5 kg
    CO2, the bottle itself 0.1 kg. GWP = 1.0 per kg CO2 -> total = 0.1 + 2*0.5 = 1.1."""
    bd.Database("biosphere").write(
        {
            ("biosphere", "co2"): {
                "name": "Carbon dioxide",
                "type": "emission",
                "categories": ("air",),
                "unit": "kg",
            }
        }
    )
    bd.Database("cfg").write(
        {
            ("cfg", "elec"): {
                "name": "electricity",
                "unit": "kWh",
                "reference product": "electricity",
                "exchanges": [
                    {"input": ("cfg", "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("cfg", "bottle"): {
                "name": "bottle",
                "unit": "unit",
                "reference product": "bottle",
                "exchanges": [
                    {"input": ("cfg", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("cfg", "elec"), "amount": 2, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def test_methods_and_lcia(client, token, project):
    _seed_calc(get_bd())

    ms = client.get("/api/v1/calc/methods", headers=token).json()
    assert any(m["method"] == ["test", "gwp"] for m in ms)

    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method": ["test", "gwp"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(r.json()["score"] - 1.1) < 1e-6


def test_contribution_tree(client, token, project):
    _seed_calc(get_bd())
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "cfg", "code": "bottle", "method": ["test", "gwp"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert abs(d["meta"]["total"] - 1.1) < 1e-6
    assert abs(d["tree"]["dir"] - 0.1) < 1e-6  # bottle's own emissions
    child = d["tree"]["ch"][0]
    assert child["n"] == "electricity"
    assert abs(child["imp"] - 1.0) < 1e-6  # 2 kWh * 0.5
    assert d["tree"]["db"] == "cfg" and child["db"] == "cfg"
    # The foreground's own emissions: the bottle emits 0.1 itself, the electricity it buys is
    # background in this fixture only by name — both are in "cfg", so both count as foreground here
    # (0.1 + 2 kWh × 0.5). What the figure must NOT be is the tree's truncated remainder (V411).
    assert abs(d["meta"]["foreground_direct"] - 1.1) < 1e-6


def test_contribution_tree_nodes_carry_database(client, token, project):
    """Tree nodes identify activities by the (db, c) pair — codes alone can collide across
    databases (the canvas Sankey overlay keys its shares by the pair). Both activities here
    deliberately share the code "x" in different databases."""
    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("bg").write(
        {
            ("bg", "x"): {
                "name": "background x",
                "unit": "kg",
                "exchanges": [
                    {"input": ("bg", "x"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Database("fgx").write(
        {
            ("fgx", "x"): {
                "name": "foreground x",
                "unit": "unit",
                "exchanges": [
                    {"input": ("fgx", "x"), "amount": 1, "type": "production"},
                    {"input": ("bg", "x"), "amount": 3, "type": "technosphere"},
                ],
            }
        }
    )
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])

    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fgx", "code": "x", "method": ["test", "gwp"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    tree = r.json()["tree"]
    assert (tree["db"], tree["c"]) == ("fgx", "x")
    assert (tree["ch"][0]["db"], tree["ch"][0]["c"]) == ("bg", "x")
    assert abs(tree["ch"][0]["imp"] - 3.0) < 1e-6


def test_method_not_found(client, token, project):
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method": ["does", "not", "exist"]},
        headers=token,
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "method_not_found"


def test_lcia_direct_split(client, token, project):
    """The bottle emits 0.1 kg itself; the other 1.0 comes through the electricity it buys."""
    _seed_calc(get_bd())
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method": ["test", "gwp"], "direct_split": True},
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert abs(d["score"] - 1.1) < 1e-6
    assert abs(d["direct"] - 0.1) < 1e-6
    assert abs(d["upstream"] - 1.0) < 1e-6
    assert abs(d["direct_share"] - 0.1 / 1.1) < 1e-6
    # Without the flag the answer is what it always was.
    plain = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method": ["test", "gwp"]},
        headers=token,
    ).json()
    assert "direct" not in plain


def test_elementary_flows_direct_split(client, token, project):
    _seed_calc(get_bd())
    r = client.post(
        "/api/v1/calc/elementary-flows",
        json={"database": "cfg", "code": "bottle", "method": ["test", "gwp"], "direct_split": True},
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert abs(d["total"] - 1.1) < 1e-6
    assert abs(d["direct"] - 0.1) < 1e-6
    assert abs(d["flows"][0]["impact"] - 1.1) < 1e-6
    assert abs(d["flows"][0]["direct"] - 0.1) < 1e-6


def test_contribution_matrix(client, token, project):
    """Two indicators, one factorisation: electricity carries 1.0 of 1.1 (91 %) under both, the bottle
    0.1 (9 %). A 50 % cutoff keeps electricity only and puts the bottle's 0.1 into ``rest``."""
    bd = get_bd()
    _seed_calc(bd)
    bd.Method(("test", "gwp2")).write([(("biosphere", "co2"), 2.0)])
    body = {
        "database": "cfg",
        "code": "bottle",
        "methods": [["test", "gwp"], ["test", "gwp2"]],
        "cutoff": 0.01,
    }
    r = client.post("/api/v1/calc/contribution-matrix", json=body, headers=token)
    assert r.status_code == 200, r.text
    d = r.json()
    assert [m["total"] for m in d["meta"]["methods"]] == [1.1, 2.2]
    assert [row["n"] for row in d["rows"]] == ["electricity", "bottle"]  # largest share first
    elec, bottle = d["rows"]
    assert elec["values"] == [1.0, 2.0]
    assert abs(elec["shares"][0] - 1.0 / 1.1) < 1e-6
    assert bottle["values"] == [0.1, 0.2]
    assert d["meta"]["n_included"] == 2 and d["meta"]["n_shown"] == 2

    r2 = client.post("/api/v1/calc/contribution-matrix", json={**body, "cutoff": 0.5}, headers=token)
    d2 = r2.json()
    assert [row["n"] for row in d2["rows"]] == ["electricity"]
    assert abs(d2["rest"][0]["value"] - 0.1) < 1e-6
    assert abs(d2["rest"][1]["value"] - 0.2) < 1e-6

    none = client.post("/api/v1/calc/contribution-matrix", json={**body, "methods": []}, headers=token)
    assert none.status_code == 400


def test_method_family_resolves_standard_variants_only(client, token, project):
    bd = get_bd()
    _seed_calc(bd)
    bd.Method(("fam", "a")).write([(("biosphere", "co2"), 1.0)])
    bd.Method(("fam", "b")).write([(("biosphere", "co2"), 3.0)])
    bd.Method(("fam no LT", "a")).write([(("biosphere", "co2"), 1.0)])
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method_family": "FAM"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert sorted(x["method"][1] for x in d["results"]) == ["a", "b"]
    assert all(x["method"][0] == "fam" for x in d["results"])
    assert d["family"]["n_methods"] == 2
    # The twin is there when named.
    lt = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method_family": "fam no LT"},
        headers=token,
    ).json()
    assert [x["method"] for x in lt["results"]] == [["fam no LT", "a"]]
    # Unknown family: a clear refusal, not an empty answer.
    bad = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method_family": "nope"},
        headers=token,
    )
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "method_not_found" if "error" in bad.json() else True

    cmp = client.post(
        "/api/v1/calc/compare",
        json={"subjects": [{"database": "cfg", "code": "bottle"}, {"database": "cfg", "code": "elec"}], "method_family": "fam"},
        headers=token,
    )
    assert cmp.status_code == 200, cmp.text
    assert len(cmp.json()["methods"]) == 2
    missing = client.post(
        "/api/v1/calc/compare",
        json={"subjects": [{"database": "cfg", "code": "bottle"}]},
        headers=token,
    )
    assert missing.status_code == 400


def _seed_solo(bd) -> None:
    """One activity, no technosphere input: the 1×1 system a fresh model starts as."""
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("solo").write(
        {
            ("solo", "p"): {
                "name": "product",
                "unit": "kilogram",
                "reference product": "product",
                "exchanges": [
                    {"input": ("solo", "p"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 1.5, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])
    bd.Method(("test", "gwp2")).write([(("biosphere", "co2"), 2.0)])


def test_contribution_of_a_single_activity_model(client, token, project):
    """The real solver on a 1×1 technosphere returns a scalar; the tree must still come back."""
    _seed_solo(get_bd())
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "solo", "code": "p", "method": ["test", "gwp"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert abs(d["meta"]["total"] - 1.5) < 1e-9
    assert abs(d["tree"]["dir"] - 1.5) < 1e-9


def test_contribution_matrix_of_a_single_activity_with_two_methods(client, token, project):
    """One activity, two methods: each method keeps its own column whatever shape the solver
    squeezes the 1×2 answer into (the sibling of the 1×1 case above)."""
    _seed_solo(get_bd())
    body = {"database": "solo", "code": "p", "methods": [["test", "gwp"], ["test", "gwp2"]], "cutoff": 0.01}
    r = client.post("/api/v1/calc/contribution-matrix", json=body, headers=token)
    assert r.status_code == 200, r.text
    d = r.json()
    assert [m["total"] for m in d["meta"]["methods"]] == [1.5, 3.0]
    assert d["rows"][0]["values"] == [1.5, 3.0]
