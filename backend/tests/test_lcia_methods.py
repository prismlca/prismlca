from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd


def _seed(bd) -> None:
    """A tiny system + one shipped GWP method (CO2=1). bottle = 0.1 + 2*0.5 kg CO2 -> GWP 1.1."""
    bd.Database("biosphere").write({
        ("biosphere", "co2"): {"name": "Carbon dioxide", "categories": ("air",), "unit": "kg"},
        ("biosphere", "ch4"): {"name": "Methane", "categories": ("air",), "unit": "kg"},
    })
    bd.Database("cfg").write({
        ("cfg", "elec"): {
            "name": "electricity", "unit": "kWh", "reference product": "electricity",
            "exchanges": [
                {"input": ("cfg", "elec"), "amount": 1, "type": "production"},
                {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
            ],
        },
        ("cfg", "bottle"): {
            "name": "bottle", "unit": "unit", "reference product": "bottle",
            "exchanges": [
                {"input": ("cfg", "bottle"), "amount": 1, "type": "production"},
                {"input": ("cfg", "elec"), "amount": 2, "type": "technosphere"},
                {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
            ],
        },
    })
    bd.Method(("ecoinvent", "GWP")).write([(("biosphere", "co2"), 1.0)])


def _lcia(client, token, method) -> float:
    r = client.post("/api/v1/calc/lcia",
                    json={"database": "cfg", "code": "bottle", "method": method}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["score"]


def test_shipped_method_is_read_only(client, token, project):
    _seed(get_bd())
    fams = client.get("/api/v1/lcia/families", headers=token).json()["families"]
    gwp = next(m for f in fams for m in f["methods"] if m["method"] == ["ecoinvent", "GWP"])
    assert gwp["editable"] is False

    # editing a shipped method is refused
    r = client.post("/api/v1/lcia/factor",
                    json={"method": ["ecoinvent", "GWP"], "ref": ["biosphere", "co2"], "cf": 5.0},
                    headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "method_read_only"


def test_duplicate_edit_and_results(client, token, project):
    _seed(get_bd())
    assert abs(_lcia(client, token, ["ecoinvent", "GWP"]) - 1.1) < 1e-6

    # duplicate into an editable copy in a new family (with description)
    dup = client.post("/api/v1/lcia/duplicate", json={
        "src": ["ecoinvent", "GWP"], "family": "My methods", "name": "GWP x2",
        "description": "my custom family",
    }, headers=token)
    assert dup.status_code == 200, dup.text
    assert dup.json()["editable"] is True
    new = ["My methods", "GWP x2"]
    co2_ref = next(f["ref"] for f in dup.json()["flows"] if f["flow"] == "Carbon dioxide")

    # copy reproduces the source result
    assert abs(_lcia(client, token, new) - 1.1) < 1e-6

    # change CO2 factor to 2 -> result doubles (0.1 + 2*0.5) * 2 = 2.2
    client.post("/api/v1/lcia/factor",
                json={"method": new, "ref": co2_ref, "cf": 2.0}, headers=token)
    assert abs(_lcia(client, token, new) - 2.2) < 1e-6

    # add a CH4 factor via flow-search ref (no CH4 emissions -> result unchanged), then it's listed
    ch4_ref = next(f["ref"] for f in
                   client.get("/api/v1/lcia/flow-search", params={"query": "Methane"}, headers=token).json()["flows"])
    fl = client.post("/api/v1/lcia/factor",
                     json={"method": new, "ref": ch4_ref, "cf": 28.0}, headers=token)
    assert {f["flow"] for f in fl.json()["flows"]} == {"Carbon dioxide", "Methane"}
    assert abs(_lcia(client, token, new) - 2.2) < 1e-6

    # remove CO2 -> only CH4 left, which the system doesn't emit -> score 0
    client.post("/api/v1/lcia/flow/remove",
                json={"method": new, "ref": co2_ref}, headers=token)
    assert abs(_lcia(client, token, new)) < 1e-6

    # family carries its description; the shipped family is not "custom"
    fams = {f["family"]: f for f in client.get("/api/v1/lcia/families", headers=token).json()["families"]}
    assert fams["My methods"]["description"] == "my custom family"
    assert fams["My methods"]["custom"] is True
    assert fams["ecoinvent"]["custom"] is False


def test_cannot_add_indicators_to_shipped_family(client, token, project):
    _seed(get_bd())
    # duplicating into the shipped "ecoinvent" family is refused
    r = client.post("/api/v1/lcia/duplicate",
                    json={"src": ["ecoinvent", "GWP"], "family": "ecoinvent", "name": "copy"}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "family_protected"
    # describing a shipped family is refused too
    r2 = client.post("/api/v1/lcia/family", json={"family": "ecoinvent", "description": "x"}, headers=token)
    assert r2.status_code == 400
    assert r2.json()["error"]["code"] == "family_protected"
    # a fresh custom family is fine
    ok = client.post("/api/v1/lcia/duplicate",
                     json={"src": ["ecoinvent", "GWP"], "family": "Mine", "name": "copy"}, headers=token)
    assert ok.status_code == 200, ok.text


def test_create_empty_method(client, token, project):
    _seed(get_bd())
    r = client.post("/api/v1/lcia/method",
                    json={"family": "Mine", "name": "blank", "unit": "pt"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["editable"] is True and r.json()["flows"] == []
    # can't create one in a shipped family
    bad = client.post("/api/v1/lcia/method",
                      json={"family": "ecoinvent", "name": "x"}, headers=token)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "family_protected"


def test_edit_family_rename_and_describe(client, token, project):
    _seed(get_bd())
    client.post("/api/v1/lcia/duplicate",
                json={"src": ["ecoinvent", "GWP"], "family": "Old", "name": "a"}, headers=token)
    r = client.post("/api/v1/lcia/family/edit",
                    json={"old": "Old", "name": "New", "description": "desc"}, headers=token)
    assert r.status_code == 200, r.text
    fams = {f["family"]: f for f in client.get("/api/v1/lcia/families", headers=token).json()["families"]}
    assert "Old" not in fams and fams["New"]["description"] == "desc"
    # the method moved with the family
    assert any(m["method"] == ["New", "a"] for m in fams["New"]["methods"])
    # renaming a shipped family is refused
    bad = client.post("/api/v1/lcia/family/edit",
                      json={"old": "ecoinvent", "name": "x", "description": ""}, headers=token)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "family_protected"


def test_delete_family(client, token, project):
    _seed(get_bd())
    client.post("/api/v1/lcia/duplicate",
                json={"src": ["ecoinvent", "GWP"], "family": "Fam", "name": "a"}, headers=token)
    client.post("/api/v1/lcia/duplicate",
                json={"src": ["ecoinvent", "GWP"], "family": "Fam", "name": "b"}, headers=token)
    r = client.post("/api/v1/lcia/family/delete", json={"family": "Fam"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["methods_removed"] == 2
    fams = {f["family"] for f in client.get("/api/v1/lcia/families", headers=token).json()["families"]}
    assert "Fam" not in fams
    # shipped family can't be deleted
    bad = client.post("/api/v1/lcia/family/delete", json={"family": "ecoinvent"}, headers=token)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "family_protected"


def test_flow_search_ranking(client, token, project):
    bd = get_bd()
    bd.Database("biosphere").write({
        ("biosphere", "ch4"): {"name": "Methane", "categories": ("air",), "unit": "kg"},
        ("biosphere", "ch4f"): {"name": "Methane, fossil", "categories": ("air",), "unit": "kg"},
        ("biosphere", "dcm"): {"name": "Dichloromethane", "categories": ("air",), "unit": "kg"},
        ("biosphere", "co2"): {"name": "Carbon dioxide", "categories": ("air",), "unit": "kg"},
    })
    flows = client.get("/api/v1/lcia/flow-search", params={"query": "methane"}, headers=token).json()["flows"]
    names = [f["flow"] for f in flows]
    assert names[0] == "Methane"                       # exact match first
    assert names.index("Methane, fossil") < names.index("Dichloromethane")  # prefix beats substring
    assert "Carbon dioxide" not in names               # non-matches excluded


def test_rename_method(client, token, project):
    _seed(get_bd())
    client.post("/api/v1/lcia/duplicate",
                json={"src": ["ecoinvent", "GWP"], "family": "Mine", "name": "old"}, headers=token)
    r = client.post("/api/v1/lcia/method/rename",
                    json={"method": ["Mine", "old"], "name": "new"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["method"] == ["Mine", "new"]
    ms = client.get("/api/v1/calc/methods", headers=token).json()
    names = [m["method"] for m in ms]
    assert ["Mine", "new"] in names and ["Mine", "old"] not in names
    # shipped method can't be renamed
    bad = client.post("/api/v1/lcia/method/rename",
                      json={"method": ["ecoinvent", "GWP"], "name": "x"}, headers=token)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "method_read_only"


def test_delete_custom_method(client, token, project):
    _seed(get_bd())
    client.post("/api/v1/lcia/duplicate",
                json={"src": ["ecoinvent", "GWP"], "family": "Mine", "name": "copy"}, headers=token)
    r = client.post("/api/v1/lcia/delete", json={"method": ["Mine", "copy"]}, headers=token)
    assert r.status_code == 200, r.text
    ms = client.get("/api/v1/calc/methods", headers=token).json()
    assert not any(m["method"] == ["Mine", "copy"] for m in ms)


def test_a_method_name_resolves_as_forgivingly_as_the_search_that_found_it(client, token, project):
    """`list_methods` folds punctuation, case and a "v" before a version; resolution now does too.

    The gap was the assistant's most repeated mistake in a practice run: it found a method by name,
    then failed three times passing it to `calculate`, because a string became a tuple of characters
    ("LCIA method ['I','P','C','C',…] not found") and only the exact triple was accepted.
    """
    bd = get_bd()
    _seed(bd)
    bd.Method(("EF v3.1", "climate change", "global warming potential (GWP100)")).write(
        [(("biosphere", "co2"), 1.0)]
    )

    exact = _lcia(client, token, ["EF v3.1", "climate change", "global warming potential (GWP100)"])

    # The joined name as ONE string — what a model writes when it copies a name out of a list.
    assert _lcia(client, token, "EF v3.1 · climate change · global warming potential (GWP100)") == exact
    # Folded: no "v", no punctuation, different case.
    assert _lcia(client, token, "ef3.1 climate change gwp100") == exact
    # A tuple with the segments spelled loosely still lands on it.
    assert _lcia(client, token, ["EF 3.1", "climate", "GWP 100"]) == exact


def test_an_unresolvable_method_names_candidates_instead_of_just_failing(client, token, project):
    bd = get_bd()
    _seed(bd)
    for horizon in ("GWP20", "GWP100", "GWP500"):
        bd.Method(("IPCC 2021", "climate change: total", f"global warming potential ({horizon})")).write(
            [(("biosphere", "co2"), 1.0)]
        )

    # Ambiguous: three horizons match "ipcc climate", so the answer is which ones, not a guess.
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method": "IPCC 2021 climate change total"},
        headers=token,
    )
    assert r.status_code == 404, r.text
    body = r.json()
    assert body["error"]["code"] == "method_ambiguous"
    # The recommended one is offered first; the specialist horizons are not hidden either.
    assert "GWP100" in body["error"]["hint"]

    # Nothing like it at all: still an error, but one that shows what does exist.
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": "cfg", "code": "bottle", "method": "IPCC 2021 unicorn potential"},
        headers=token,
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "method_not_found"


def test_flow_refs_are_strings_that_round_trip_and_a_missing_flow_is_an_error(client, token, project):
    """Node ids are 64-bit integers, which a JavaScript client rounds (above 2**53). The MCP practice
    run of 2026-10-04 sent such a rounded id back: remove_flow removed nothing and said nothing,
    set_factor added a second flow under an id no dataset has. Refs now travel as strings, a string
    is accepted on the way back, and a ref that matches no flow is refused."""
    _seed(get_bd())
    dup = client.post("/api/v1/lcia/duplicate", json={
        "src": ["ecoinvent", "GWP"], "family": "My methods", "name": "GWP strings",
    }, headers=token)
    assert dup.status_code == 200, dup.text
    new = ["My methods", "GWP strings"]
    flows = client.get("/api/v1/lcia/flow-search", params={"query": "Methane"}, headers=token).json()["flows"]
    ch4_ref = flows[0]["ref"]
    assert isinstance(ch4_ref, str) and ch4_ref.isdigit()

    # set twice with the string ref: one flow, the later factor
    for cf in (28.0, 30.0):
        r = client.post("/api/v1/lcia/factor", json={"method": new, "ref": ch4_ref, "cf": cf}, headers=token)
        assert r.status_code == 200, r.text
    listed = [f for f in r.json()["flows"] if f["flow"] == "Methane"]
    assert len(listed) == 1 and listed[0]["cf"] == 30.0
    # the method's own detail hands the same string back
    assert listed[0]["ref"] == ch4_ref

    # remove with the string ref works; removing again is an error, not a silent success
    r = client.post("/api/v1/lcia/flow/remove", json={"method": new, "ref": ch4_ref}, headers=token)
    assert r.status_code == 200 and not [f for f in r.json()["flows"] if f["flow"] == "Methane"]
    r = client.post("/api/v1/lcia/flow/remove", json={"method": new, "ref": ch4_ref}, headers=token)
    assert r.status_code == 404, r.text
    assert r.json()["error"]["code"] == "flow_not_in_method"
