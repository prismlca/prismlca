"""The search's unit filter, and what it changed in how hits are grouped and reported (search/facets.py)."""
from __future__ import annotations

import uuid

from prism_lca.engine.backgrounds import common
from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.facets import NO_FILTERS, Filters, unit_counts
from prism_lca.search.identifiers import Found


def _write(bd, name: str, rows: list[tuple[str, str, str, str, str]]) -> None:
    """One database from (code, name, reference product, location, unit) rows — invented, no licensed data."""
    bd.Database(name).write({
        (name, code): {
            "name": nm, "reference product": prod, "location": loc, "unit": unit,
            "exchanges": [{"input": (name, code), "amount": 1.0, "type": "production"}],
        }
        for code, nm, prod, loc, unit in rows
    })


ELECTRICITY = [
    ("elec_de", "electricity, low voltage", "electricity, low voltage", "DE", "kWh"),
    ("elec_market", "market for electricity, low voltage", "electricity, low voltage", "GLO", "kWh"),
    ("elec_group", "market group for electricity, low voltage", "electricity, low voltage", "RER", "kWh"),
    ("pet", "polyethylene terephthalate production", "polyethylene terephthalate, granulate", "RER", "kg"),
]


def _indexed(client, token, rows, name: str | None = None) -> str:
    db = name or "syn-" + uuid.uuid4().hex[:6]
    _write(get_bd(), db, rows)
    r = client.post("/api/v1/search/index", json={"database": db}, headers=token)
    assert r.status_code in (200, 202), r.text
    return db


def _search(client, token, **body) -> dict:
    r = client.post("/api/v1/search/activities", json={"limit": 10, **body}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()


# --- the filter object -------------------------------------------------------------------------------


def test_one_region_is_not_a_filter_but_one_unit_is():
    assert Filters.of(geographies=["DE"]).geos == frozenset()
    assert Filters.of(geographies=["DE", "RER"]).geos == {"DE", "RER"}
    assert Filters.of(units=["kg"]).units == {"kg"}
    assert not NO_FILTERS and not Filters.of(geographies=["DE"])
    assert Filters.of(units=["kg"])


def test_a_row_is_kept_out_by_the_first_filter_it_fails():
    f = Filters.of(activity_types=["M"], geographies=["DE", "RER"], units=["kg"])
    assert f.excluded_by({"atype": "P", "geo": "GLO", "unit": "kWh"}) == "type"
    assert f.excluded_by({"atype": "M", "geo": "GLO", "unit": "kWh"}) == "geography"
    assert f.excluded_by({"atype": "M", "geo": "DE", "unit": "kWh"}) == "unit"
    assert f.passes({"atype": "M", "geo": "DE", "unit": "kg"})


def test_unit_counts_put_the_common_units_first():
    meta = [{"unit": "kWh"}, {"unit": "kg"}, {"unit": "kWh"}, {"unit": "MJ"}, {"unit": None}, {"unit": "kg"}]
    assert unit_counts(meta) == [
        {"unit": "kWh", "count": 2}, {"unit": "kg", "count": 2}, {"unit": "MJ", "count": 1},
    ]


# --- through the API ---------------------------------------------------------------------------------


def test_the_units_endpoint_lists_what_the_index_holds(client, token, project):
    db = _indexed(client, token, ELECTRICITY)
    r = client.get(f"/api/v1/search/units/{db}", headers=token)
    assert r.status_code == 200, r.text
    assert r.json() == [{"unit": "kWh", "count": 3}, {"unit": "kg", "count": 1}]


def test_a_unit_filter_admits_only_its_units_even_a_single_one(client, token, project):
    db = _indexed(client, token, ELECTRICITY)
    only_kg = _search(client, token, query="electricity", database=db, units=["kg"])
    assert only_kg["hits"] and {h["unit"] for h in only_kg["hits"]} == {"kg"}
    both = _search(client, token, query="electricity", database=db, units=["kg", "kWh"], collapse_geo=False)
    assert {h["unit"] for h in both["hits"]} == {"kg", "kWh"}
    assert "units_not_in_databases" not in both


def test_a_unit_no_searched_database_has_is_named(client, token, project):
    db = _indexed(client, token, ELECTRICITY)
    body = _search(client, token, query="electricity", database=db, units=["cubic meter", "kg"])
    assert body["units_not_in_databases"] == ["cubic meter"]
    assert {h["unit"] for h in body["hits"]} == {"kg"}


def test_an_exact_name_hidden_by_the_unit_is_said_apart_from_the_regions(client, token, project):
    db = _indexed(client, token, ELECTRICITY)
    body = _search(client, token, query="market for electricity, low voltage", database=db, units=["kg"])
    assert "hidden by the unit filter" in body["outside_unit_filter"]
    assert "kWh" in body["outside_unit_filter"]
    assert "outside_geography_filter" not in body

    # Kept out by the regions already: the unit is not the reason, so it is not given as one.
    body = _search(client, token, query="market for electricity, low voltage", database=db,
                   geographies=["DE", "RER"], units=["kg"])
    assert "GLO" in body["outside_geography_filter"]
    assert "outside_unit_filter" not in body


def test_variants_in_another_unit_are_another_hit(client, token, project):
    """A library may hold one activity in two units. Grouped together, picking the other region carried the
    representative's unit into the model."""
    db = _indexed(client, token, [
        ("bracket_de", "steel bracket, welded", "steel bracket", "DE", "kg"),
        ("bracket_fr", "steel bracket, welded", "steel bracket", "FR", "unit"),
        ("bracket_it", "steel bracket, welded", "steel bracket", "IT", "kg"),
    ])
    hits = _search(client, token, query="steel bracket", database=db, variants_cap=0)["hits"]
    brackets = [h for h in hits if h["name"] == "steel bracket, welded"]
    assert sorted(h["unit"] for h in brackets) == ["kg", "unit"]
    by_unit = {h["unit"]: {v["geography"] for v in h["variants"]} for h in brackets}
    assert by_unit == {"kg": {"DE", "IT"}, "unit": {"FR"}}

    only = _search(client, token, query="steel bracket", database=db, units=["unit"])["hits"]
    assert [(h["unit"], h["geography"]) for h in only] == [("unit", "FR")]


def test_the_reserve_takes_the_best_rows_the_filter_admits(client, token, project):
    """Each database's own best few join the pool so the reserve can keep it visible. They used to be taken
    unfiltered and filtered afterwards: a library whose best rows were all in another unit added nothing."""
    # The background's kg row names the query, so it takes the one pool slot on its own merit; the library
    # can only come in through its reserve, and its best rows are all in kWh.
    background = _indexed(client, token, [
        *ELECTRICITY, ("meter", "electricity meter production", "electricity meter", "GLO", "kg"),
    ])
    library = _indexed(client, token, [
        *[(f"roof_{i}", f"electricity from our own roof {i}", "electricity, low voltage", "DE", "kWh")
          for i in range(10)],
        ("wire", "copper wire drawing", "copper wire", "DE", "kg"),
    ], name="My processes")
    search = client.app.state.search
    entries = [(name, search._require_index(name)) for name in (background, library)]
    qvec = search._provider_().embed(["electricity"], is_query=True)[0]

    floored = search._union_candidates("electricity", qvec, entries, Filters.of(units=["kg"]), 1, floor=1)
    assert {c["database"] for c in floored} == {background, library}
    assert {c["unit"] for c in floored} == {"kg"}


# --- the dense path, and the identifier pin -----------------------------------------------------------


def test_the_dense_path_filters_units_the_same_way(client, token, project, monkeypatch):
    monkeypatch.setattr(client.app.state.search._settings, "search_hybrid", False)
    db = _indexed(client, token, ELECTRICITY)
    only_kg = _search(client, token, query="electricity", database=db, units=["kg"])
    assert only_kg["hits"] and {h["unit"] for h in only_kg["hits"]} == {"kg"}


def test_a_pinned_number_in_two_units_is_two_hits():
    """The pin groups like the collapse: one activity kept in two units is two hits. Grouped by name alone,
    the row in the second unit counted as already shown and was dropped."""
    def row(unit: str) -> dict:
        return {"database": "db", "name": "sodium hydroxide", "product": "sodium hydroxide", "atype": "M",
                "geo": "GLO", "unit": unit, "code": f"naoh-{unit}"}

    other = {**row("kilogram"), "name": "potassium hydroxide", "product": "potassium hydroxide", "code": "koh"}
    pinned = Found("1310-73-2", [row("kilogram"), row("unit")]).pin([row("kilogram"), other], lambda rows: rows)
    assert [(h["name"], h["unit"]) for h in pinned] == [
        ("sodium hydroxide", "kilogram"), ("sodium hydroxide", "unit"),
    ]


def test_a_pinned_number_honours_the_unit_filter(client, token, project):
    """A substance number leads the list with the datasets carrying it, but only those the filters admit:
    pinned rows in another unit would come back past a filter that excluded them from the ranking."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]

    def act(code: str, name: str, unit: str, number: str = "") -> dict:
        exchange = {"input": (db, code), "amount": 1.0, "type": "production"}
        if number:
            exchange["CAS number"] = number
        return {"name": name, "reference product": name.removeprefix("market for "), "location": "GLO",
                "unit": unit, "exchanges": [exchange]}

    bd.Database(db).write({
        (db, "naoh"): act("naoh", "market for sodium hydroxide, without water", "kilogram", "1310-73-2"),
        (db, "brine"): act("brine", "market for brine", "cubic meter"),
    })
    bd.databases[db][common.COMPLETE_KEY] = True
    bd.databases.flush()
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200

    assert _search(client, token, query="1310-73-2", database=db)["hits"][0]["code"] == "naoh"
    in_m3 = _search(client, token, query="1310-73-2", database=db, units=["cubic meter"])
    assert [h["code"] for h in in_m3["hits"]] == ["brine"]
