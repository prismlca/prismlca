"""Abbreviations in a search query (search/abbrev.py).

The dictionary comes from the background databases' activity synonyms; the query as typed is kept and
its spelled-out form is searched beside it. Synthetic data only — no ecoinvent nomenclature in the repo.
"""

from __future__ import annotations

import uuid

from prism_lca.engine.backgrounds import common
from prism_lca.engine.bootstrap import get_bd
from prism_lca.search import abbrev
from prism_lca.search.abbrev import Dictionary, Expander, Row, derive, with_aliases


def _pet_rows() -> list[Row]:
    return [
        Row("polyethylene terephthalate production, granulate, bottle grade",
            "polyethylene terephthalate, granulate, bottle grade", "kilogram", ["PET"]),
        Row("polyethylene terephthalate production, granulate, amorphous",
            "polyethylene terephthalate, granulate, amorphous", "kilogram", ["PET"]),
        Row("polyethylene production, low density, granulate", "polyethylene, low density, granulate",
            "kilogram", ["LDPE"]),
        # A by-product row of the same multi-output activity carries the synonym too and must not count.
        Row("polyethylene production, low density, granulate", "steam, in chemical industry", "kilogram",
            ["LDPE"]),
        Row("polystyrene production, high impact", "polystyrene, high impact", "kilogram", ["HIPS"]),
        Row("polycarbonate production", "polycarbonate", "kilogram", []),
        Row("computer production, desktop", "computer, desktop", "unit", ["PC"]),
        Row("heat and power co-generation, natural gas", "heat, district or industrial", "megajoule", ["CHP"]),
        Row("hexafluoroethane production", "hexafluoroethane", "kilogram", ["C2F6"]),
        Row("market for wastewater from PET pelletising", "wastewater from PET pelletising", "cubic meter", []),
    ]


def _dictionary(*extra_sources) -> Dictionary:
    return Dictionary.merge([derive(_pet_rows()), *extra_sources])


def test_the_dictionary_is_derived_from_synonyms_of_material_production():
    table = derive(_pet_rows()).table
    assert table["PET"] == "polyethylene terephthalate"  # form word "granulate" stripped
    assert table["LDPE"] == "polyethylene, low density"  # the steam by-product row did not count
    assert table["HIPS"] == "polystyrene, high impact"  # a qualifier is not a form word
    assert "PC" not in table  # computers are counted in units, not a material
    assert "CHP" not in table  # a technology, measured in megajoule
    assert "C2F6" not in table  # a formula, not an acronym


def test_two_databases_that_disagree_give_no_expansion():
    other = abbrev.Source({"PET": "polyester terephthalate resin"})
    assert "PET" not in _dictionary(other).table
    same = abbrev.Source({"PET": "polyethylene terephthalate"})
    assert "PET" in _dictionary(same).table


def test_lowercase_only_where_the_databases_never_write_the_word_in_lower_case():
    names_with_pet = abbrev.Source({}, upper=abbrev.Counter({"PET": 9}))
    d = _dictionary(names_with_pet)
    assert "PET" in d.lowercase
    prose = abbrev.Source({}, upper=abbrev.Counter({"PET": 9}), lower=abbrev.Counter({"pet": 1}))
    assert "PET" not in _dictionary(prose).lowercase
    # Evidence counts across databases: one without synonyms (BAFU) still says how a word is written.
    assert "PET" not in _dictionary().lowercase  # only one upper-case mention in the synthetic names


def _expander(lowercase=frozenset({"PET"}), exact=frozenset()) -> Expander:
    d = _dictionary()
    d.lowercase = frozenset(lowercase)
    d.table.update({"E-PVC": "polyvinyl chloride, emulsion polymerised", "PP": "polypropylene",
                    "IP/P": "cement, type IP/P"})
    return Expander(d, exact)


def test_the_query_is_split_longest_match_first():
    e = _expander()
    assert e.expand("PET").text == "polyethylene terephthalate"
    assert e.expand("PET-Flasche Granulat").text == "polyethylene terephthalate Flasche Granulat"
    assert e.expand("E-PVC-Rohr").text == "polyvinyl chloride, emulsion polymerised Rohr"
    assert e.expand("PET/PP").text == "polyethylene terephthalate polypropylene"
    assert e.expand("rPET").text == "recycled polyethylene terephthalate"
    assert e.expand("r-PET-Granulat").text == "recycled polyethylene terephthalate Granulat"
    # The written form with its reading: "rPET" stays "rPET" and keeps its "recycled".
    assert e.expand("rPET").aliases == {"rPET": "recycled polyethylene terephthalate"}
    assert e.expand("rPET").keys == frozenset({"PET"})
    assert e.expand("rPET").anchors == {"PET": "polyethylene terephthalate"}
    assert e.expand("pet").aliases == {"pet": "polyethylene terephthalate"}


def test_the_recyclate_prefix_in_lower_case_follows_the_lowercase_rule():
    """"rpet" should work like "pet" does — but only where the dictionary vouches for
    the rest, or "rubber" and "rice" would split into r + something."""
    from prism_lca.search.abbrev import honesty_query

    e = _expander()  # PET may be written in lower case, LDPE may not
    assert e.expand("rpet").text == "recycled polyethylene terephthalate"
    assert e.expand("r-pet flakes").text == "recycled polyethylene terephthalate flakes"
    assert e.expand("RPET").text == "recycled polyethylene terephthalate"
    assert e.expand("rldpe") is None
    assert e.expand("rubber gloves") is None and e.expand("rice") is None
    exp = e.expand("rpet bottle")
    assert exp.recyclates == {"rpet": "PET"}
    assert honesty_query("rpet bottle", exp.recyclates) == "recycled PET bottle"
    assert honesty_query("REACH registered rubber") == "REACH registered rubber"  # no dictionary, no guess


def test_case_rules():
    e = _expander()
    assert e.expand("pet").text == "polyethylene terephthalate"  # lower case backed by the data
    assert e.expand("ldpe") is None  # lower case without that evidence stays a word
    assert e.expand("Pet") is None
    assert e.expand("pp granulate") is None  # two letters: capitals only


def test_guards():
    e = _expander(exact=frozenset({"wastewater from pet pelletising"}))
    assert e.expand("wastewater from PET pelletising") is None  # names a dataset exactly
    assert e.expand("PET pelletising wastewater") is None  # waste intent: the token is meant
    assert e.expand("end-of-life PET bottle") is None
    assert e.expand("PET (polyethylene terephthalate) tray") is None  # the long form is already there
    assert e.expand("recycled PET").text == "recycled polyethylene terephthalate"  # "recycl" is a material


def test_a_hit_carries_its_abbreviation_only_when_it_carries_the_whole_expansion():
    aliases = {"PET": "polyethylene terephthalate"}
    texts = with_aliases(["polyethylene terephthalate, granulate, bottle grade", "polyethylene, bottle"],
                         aliases)
    assert texts[0].endswith(" PET")
    assert not texts[1].endswith(" PET")  # words of the expansion spread over hits never count


def test_a_recyclate_abbreviation_is_matched_only_by_a_recyclate():
    """"rPET bottle" against a recycled bottle-grade hit read as "1 of 2" with a
    split warning; "r-PET" against virgin PET, and "r-HDPE" against BAFU's virgin "Polyethylene, HDPE,
    granulate", passed as matched. The checks read the prefix as "recycled" now."""
    from prism_lca.search.abbrev import honesty_query
    from prism_lca.search.ranking import best_hit_coverage, query_signature, unanchored_terms

    e = _expander()
    assert honesty_query("rPET bottle") == "recycled PET bottle"
    assert honesty_query("r-HDPE") == "recycled HDPE"
    assert honesty_query("pet food") == "pet food"

    exp = e.expand("rPET bottle")
    recycled = with_aliases(["market for polyethylene terephthalate, granulate, bottle grade, recycled"],
                            exp.anchors)
    assert best_hit_coverage(honesty_query("rPET bottle"), recycled) == (3, 3)
    virgin = with_aliases(["market for polyethylene terephthalate, granulate, bottle grade"],
                          e.expand("r-PET").anchors)
    assert "recycled" in unanchored_terms(honesty_query("r-PET"), virgin)
    bafu_virgin = ["Polyethylene, HDPE, granulate, at plant"]  # carries the abbreviation literally
    assert "recycled" in unanchored_terms(honesty_query("r-HDPE"), bafu_virgin)
    # Two searches, not one: "already searched" must not fire between them.
    assert query_signature(honesty_query("r-HDPE")) != query_signature(honesty_query("HDPE"))


def test_refrigerants_and_recyclate_names_are_read_right():
    """Refrigerant designations are not recyclates, and a dataset NAMED with the
    prefix ("rPET flakes, supplier X" in a library) matches a query that uses it."""
    from prism_lca.search.abbrev import honesty_query
    from prism_lca.search.ranking import best_hit_coverage, query_signature, unanchored_terms

    for code in ("R-C318", "R-E170", "R-134a", "R-1234yf", "R-22"):
        assert honesty_query(code) == code
    # No invented "recycled" in their signatures (an empty signature never counts as "already searched").
    assert "recycled" not in query_signature(honesty_query("R-C318 refrigerant"))
    hit = [honesty_query("rPET bottle flakes, supplier X")]
    assert best_hit_coverage(honesty_query("rPET bottle"), hit) == (3, 3)
    assert unanchored_terms(honesty_query("rPET bottle"), hit) == []


def test_a_database_that_names_the_material_with_the_abbreviation():
    d = _dictionary()
    # BAFU's way: the material, then the abbreviation — the query as typed is precise there.
    assert d.names_material(["Polyethylene, LDPE, granulate, at plant"]) == frozenset({"LDPE"})
    # Carrying the abbreviation is not enough: the name must BE the material.
    assert d.names_material(["Packaging film, LDPE, at plant"]) == frozenset()
    assert d.names_material(["polyethylene waste, LDPE, to incineration"]) == frozenset()


# --------------------------------------------------------------------------------------- through the API
def _background(bd, name: str) -> None:
    def act(code, nm, prod, unit="kilogram", synonyms=()):
        return {"name": nm, "reference product": prod, "location": "GLO", "unit": unit,
                "synonyms": list(synonyms),
                "exchanges": [{"input": (name, code), "amount": 1.0, "type": "production"}]}

    bd.Database(name).write({
        (name, "pet_prod"): act("pet_prod", "polyethylene terephthalate production, granulate",
                                "polyethylene terephthalate, granulate", synonyms=["PET"]),
        (name, "pet_market"): act("pet_market", "market for polyethylene terephthalate, granulate",
                                  "polyethylene terephthalate, granulate"),
        (name, "ww_market"): act("ww_market", "market for wastewater from PET pelletising",
                                 "wastewater from PET pelletising", unit="cubic meter"),
        (name, "ww_treat"): act("ww_treat", "treatment of wastewater from PET pelletising, wastewater treatment",
                                "wastewater from PET pelletising", unit="cubic meter"),
        (name, "ash"): act("ash", "market for bottom ash, MSWI-WWT, WW from PET pelletising",
                           "bottom ash, MSWI-WWT, WW from PET pelletising"),
        (name, "elec"): act("elec", "market for electricity, medium voltage",
                            "electricity, medium voltage", unit="kilowatt hour"),
    })
    bd.databases[name][common.COMPLETE_KEY] = True
    bd.databases.flush()


def _search(client, token, db, query, **kw):
    r = client.post("/api/v1/search/activities", json={"query": query, "database": db, "limit": 10, **kw},
                    headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def test_an_abbreviation_finds_the_material_and_says_what_it_searched(client, token, project):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200

    expanded = _search(client, token, db, "PET")
    assert expanded["searched_as"] == {"query": "polyethylene terephthalate",
                                       "replaced": {"PET": "polyethylene terephthalate"}}
    assert "polyethylene terephthalate" in expanded["hits"][0]["name"]
    # The material rows carry "PET" for the honesty checks: no false "not in any result" warning.
    assert "pet" not in expanded["terms_not_in_results"]

    literal = _search(client, token, db, "PET", literal=True)
    assert "searched_as" not in literal
    assert "PET pelletising" in literal["hits"][0]["name"]  # as typed: the old, waste-first answer


def test_a_failed_read_is_not_remembered_as_an_empty_dictionary(client, token, project, monkeypatch):
    """One "database is locked" while the app wrote turned off the expansion until
    a restart. A failed read must leave nothing cached, so the next search reads again."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    from prism_lca.search.variants import QueryVariants

    service = client.app.state.search
    service.forget_loaded()
    real = QueryVariants.rows
    calls = {"n": 0}

    def flaky(db_file, name):
        calls["n"] += 1
        if calls["n"] == 1:
            import sqlite3

            raise sqlite3.OperationalError("database is locked")
        return real(db_file, name)

    monkeypatch.setattr(QueryVariants, "rows", staticmethod(flaky))
    assert "PET" not in service._variants.dictionary().table  # the failed read: no expansion this time
    assert "PET" in service._variants.dictionary().table  # …and the next search reads again


def test_a_waste_query_and_a_library_are_left_alone(client, token, project):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    waste = _search(client, token, db, "wastewater from PET pelletising")
    assert "searched_as" not in waste
    assert waste["hits"][0]["name"].startswith(("market for wastewater", "treatment of wastewater"))

    # The library is searched with the variants but never contributes to the dictionary.
    lib = "My processes"
    bd.Database(lib).write({(lib, "own"): {
        "name": "our recycled granulate", "reference product": "RGX", "location": "DE", "unit": "kilogram",
        "synonyms": ["RGX"], "exchanges": [{"input": (lib, "own"), "amount": 1.0, "type": "production"}]}})
    client.post("/api/v1/search/index", json={"database": lib}, headers=token)
    assert "searched_as" not in _search(client, token, db, "RGX")
