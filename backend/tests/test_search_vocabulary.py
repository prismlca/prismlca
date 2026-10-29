"""Words the databases do not use (search/vocabulary.py) and the transport-mode rule (search/transport_modes.py)."""

from __future__ import annotations

import uuid

import pytest

from prism_lca.engine.backgrounds import common
from prism_lca.engine.bootstrap import get_bd
from prism_lca.search import ranking, transport_modes, vocabulary
from prism_lca.search.transport_modes import Intent, adjust, query_intent, service

# -- the word list -----------------------------------------------------------------------------------


@pytest.mark.parametrize(("typed", "read", "replaced"), [
    ("freight transport by truck", "freight transport by lorry", {"truck": "lorry"}),
    ("Gütertransport per LKW", "freight transport per lorry", {"Gütertransport": "freight transport", "LKW": "lorry"}),
    ("Kühl-LKW", "refrigerated lorry", {"Kühl-LKW": "refrigerated lorry"}),  # the phrase before its last word
    ("semi-trailer", "lorry", {"semi-trailer": "lorry"}),  # a hyphen where the list has a space
    ("solar power", "photovoltaic electricity", {"solar power": "photovoltaic electricity"}),
    ("styrofoam", "expandable polystyrene", {"styrofoam": "expandable polystyrene"}),
    ("refrigerated truck", "refrigerated lorry", {"truck": "lorry"}),  # the entry for the last word covers it
    ("delivery van", "van, light commercial vehicle", {"delivery van": "van, light commercial vehicle"}),
    ("Transportbeton per LKW", "concrete per lorry", {"Transportbeton": "concrete", "LKW": "lorry"}),
])
def test_listed_words_are_replaced_by_the_databases_word(typed, read, replaced):
    assert vocabulary.expand(typed) == (read, replaced)


@pytest.mark.parametrize("typed", [
    "solar collector",  # "solar" alone is no entry: collectors and solar thermal are solar too
    "truck, lorry",  # the reading already stands in the query
    "trucking",  # a word that merely starts like an entry
    "Lastwagenwäsche",  # nor one that a German compound only contains
])
def test_other_words_are_left_alone(typed):
    assert vocabulary.expand(typed) == (typed, {})


# -- the transport-mode rule -------------------------------------------------------------------------


@pytest.mark.parametrize(("query", "intent"), [
    ("freight transport by truck", ("lorry", "freight")),
    ("LKW-Transport", ("lorry", None)),
    ("air freight", ("air", "freight")),
    ("car ride", ("car", "passenger")),
    ("Binnenschiff Gütertransport", ("inland waterway", "freight")),
    ("transport by air", ("air", None)),
    ("long-haul flight", ("air", "passenger")),
    ("bus ride", ("bus", "passenger")),
    ("road passenger transport", ("road", "passenger")),  # every road vehicle, not the lorry alone
    ("road transport by truck", ("lorry", None)),  # the lorry is a road vehicle: one mode
    ("Bahntransport", ("rail", None)),  # German compounds name the mode in front
    ("Zugfahrt", ("rail", None)),
    ("Straßengüterverkehr", ("road", "freight")),
    ("freight transport by air or truck", None),  # two modes: nothing to prefer
    ("car transport by ferry", None),
    ("commuting by bus or car", None),
    ("car battery", None),  # names a mode, asks for no transport
    ("heavy duty truck production", None),
    ("delivery van production", None),  # "delivery van" is a vehicle's name, not a request for a delivery
    ("Transportbeton per LKW", None),  # ready-mixed concrete
    ("freight transport", None),  # no mode
    ("river water", None),
])
def test_a_query_asks_for_one_mode_only_when_it_asks_for_transport(query, intent):
    found = query_intent(query)
    assert (found and (found.mode, found.kind)) == intent


@pytest.mark.parametrize(("query", "lift"), [
    ("freight transport by truck", True),
    ("diesel for road transport", False),  # asks for the diesel
    ("Reifen für PKW-Transport", False),
    ("electricity for rail transport", False),
    ("freight transport for 300 km by truck", True),  # the words before "for" ask for transport themselves
    ("formwork transport by truck", True),  # "for" only as a whole word
    ("tyre wear emissions, lorry transport", False),  # the databases' comma style says the same
    ("market for transport, freight, lorry, unspecified", True),  # the databases' wording for the service
    ("transport, freight, lorry, >32 metric ton", True),
])
def test_a_transport_named_only_as_what_something_is_for_is_not_lifted(query, lift):
    assert query_intent(query).lift is lift


@pytest.mark.parametrize(("name", "unit", "found"), [
    ("market for transport, freight, sea, container ship, heavy fuel oil", "ton kilometer", ("sea", "freight")),
    ("market for transport, freight, inland waterways, barge tanker, diesel", "ton kilometer",
     ("inland waterway", "freight")),  # a barge tanker sails rivers, not the sea
    ("Transport, passenger car, petrol, fleet average", "kilometer", ("car", "vehicle")),
    ("market for transport, freight, tractor and trailer, diesel, agricultural", "ton kilometer", ("", "freight")),
    ("transport, passenger, coach, diesel", "person kilometer", ("bus", "passenger")),
    ("Heavy duty truck, diesel, 40t gross weight", "unit", None),  # a vehicle, not a service
    ("Transport, aircraft, freight, Fahrzeug", "ton kilometer", None),  # a service's vehicle share
    ("market for diesel", "kilogram", None),
])
def test_a_dataset_is_a_service_by_its_unit_and_has_the_mode_its_name_says(name, unit, found):
    assert service({"name": name, "unit": unit}) == found


def test_the_asked_mode_moves_up_and_the_others_down_and_nothing_else_moves():
    rows = [
        {"name": "market for transport, freight, lorry, unspecified", "unit": "ton kilometer", "fused": 1.0},
        {"name": "market for transport, freight, sea, container ship", "unit": "ton kilometer", "fused": 1.0},
        {"name": "market for transport, freight, tractor and trailer", "unit": "ton kilometer", "fused": 1.0},
        {"name": "Heavy duty truck, diesel", "unit": "unit", "fused": 1.0},
        {"name": "market for transport, passenger, aircraft", "unit": "person kilometer", "fused": 1.0},
    ]
    adjust(Intent("lorry", "freight", lift=True), rows)
    assert [r["fused"] for r in rows] == [transport_modes.UP, transport_modes.DOWN, transport_modes.DOWN, 1.0,
                                          transport_modes.DOWN]


def test_road_lifts_every_road_vehicle_of_the_kind_asked():
    rows = [{"name": "market for transport, passenger car, fleet average", "unit": "person kilometer", "fused": 1.0},
            {"name": "market for transport, passenger, bus, diesel, regular", "unit": "person kilometer", "fused": 1.0},
            {"name": "market for transport, freight, lorry, unspecified", "unit": "ton kilometer", "fused": 1.0},
            {"name": "market for transport, passenger, train", "unit": "person kilometer", "fused": 1.0}]
    adjust(query_intent("road passenger transport"), rows)
    assert [r["fused"] for r in rows] == [transport_modes.UP, transport_modes.UP, transport_modes.DOWN,
                                          transport_modes.DOWN]


def test_a_transport_named_as_a_purpose_only_moves_the_other_modes_down():
    """"diesel for road transport": lifted, the lorry services would push the diesel out of the list."""
    rows = [{"name": "market for transport, freight, lorry, unspecified", "unit": "ton kilometer", "fused": 1.0},
            {"name": "market for transport, freight, train, diesel", "unit": "ton kilometer", "fused": 1.0},
            {"name": "market for diesel", "unit": "kilogram", "fused": 1.0}]
    adjust(query_intent("diesel for road transport"), rows)
    assert [r["fused"] for r in rows] == [1.0, transport_modes.DOWN, 1.0]


def test_freight_asked_does_not_lift_passenger_services_of_the_same_mode():
    rows = [{"name": "transport, freight, aircraft, long haul", "unit": "ton kilometer", "fused": 1.0},
            {"name": "transport, passenger, aircraft, long haul", "unit": "person kilometer", "fused": 1.0}]
    adjust(Intent("air", "freight", lift=True), rows)
    assert [r["fused"] for r in rows] == [transport_modes.UP, transport_modes.DOWN]


# -- the honesty checks ------------------------------------------------------------------------------


def test_short_words_the_search_reads_are_checked_and_german_words_stay_whole():
    assert ranking.unanchored_terms("freight transport by truck", ["market for transport, freight, sea"]) == ["truck"]
    assert ranking.unanchored_terms("Prozesswärme Erdgas", ["heat production, natural gas"]) == [
        "erdgas", "prozesswärme"]  # not "prozessw"


def test_two_searches_that_differ_only_in_the_mode_are_two_searches():
    assert ranking.query_signature("diesel transport by car") != ranking.query_signature("diesel transport by van")
    assert ranking.query_signature("international air freight") != ranking.query_signature("international sea freight")


def test_a_word_whose_reading_the_query_states_is_not_reported_missing():
    assert ranking.unanchored_terms("truck (lorry)", ["market for transport, freight, lorry"]) == []


def test_compatibility_characters_read_as_their_plain_form():
    assert ranking.unmatched_terms("CO₂ capture", ["carbon dioxide, CO2, captured"]) == []
    assert ranking.unmatched_terms("CO2 capture", ["carbon dioxide, CO₂, captured"]) == []


def test_an_odd_case_folding_does_not_break_the_search():
    assert vocabulary.expand("BENZİN") == ("BENZİN", {})  # a Turkish dotted capital I


# -- through the search ------------------------------------------------------------------------------


def _background(bd, name: str) -> None:
    def act(code, nm, prod, unit):
        return {"name": nm, "reference product": prod, "location": "GLO", "unit": unit,
                "exchanges": [{"input": (name, code), "amount": 1.0, "type": "production"}]}

    bd.Database(name).write({
        (name, "lorry"): act("lorry", "market for transport, freight, lorry, unspecified",
                             "transport, freight, lorry, unspecified", "ton kilometer"),
        (name, "ship"): act("ship", "market for transport, freight, sea, container ship",
                            "transport, freight, sea, container ship", "ton kilometer"),
        (name, "truck"): act("truck", "heavy duty truck, diesel", "heavy duty truck, diesel", "unit"),
    })
    bd.databases[name][common.COMPLETE_KEY] = True
    bd.databases.flush()


def _search(client, token, db, query, **kw):
    r = client.post("/api/v1/search/activities", json={"query": query, "database": db, "limit": 10, **kw},
                    headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def test_a_workspace_without_synonyms_still_reads_truck_as_lorry(client, token, project):
    """No database here carries synonyms, so there is no abbreviation dictionary — the word list must not
    depend on one (a workspace with BAFU alone is exactly this)."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    answer = _search(client, token, db, "freight transport by truck")
    assert answer["searched_as"] == {"query": "freight transport by lorry", "replaced": {"truck": "lorry"}}
    assert answer["hits"][0]["code"] == "lorry"
    assert "truck" not in answer["terms_not_in_results"]  # the lorry carries the truck the query typed


def test_a_query_naming_a_dataset_exactly_is_left_alone(client, token, project):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    assert "searched_as" not in _search(client, token, db, "heavy duty truck, diesel")


def test_literal_searches_without_the_word_list_and_without_the_mode_rule(client, token, project, monkeypatch):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    from prism_lca.search import service as search_service

    def boom(query):
        raise AssertionError("literal must not read the transport mode")

    monkeypatch.setattr(search_service, "transport_intent", boom)
    assert "searched_as" not in _search(client, token, db, "freight transport by truck", literal=True)


def _freight(bd, name: str, ship_name: str = "freight transport by ship, sea") -> None:
    """A lorry and a ship service whose names carry no "truck" anywhere — so only the readings can supply it."""
    def act(code, nm, unit="ton kilometer"):
        return {"name": nm, "reference product": nm, "location": "GLO", "unit": unit,
                "exchanges": [{"input": (name, code), "amount": 1.0, "type": "production"}]}

    bd.Database(name).write({(name, "lorry"): act("lorry", "market for transport, freight, lorry, unspecified"),
                             (name, "ship"): act("ship", ship_name)})
    bd.databases[name][common.COMPLETE_KEY] = True
    bd.databases.flush()


def test_a_hit_that_says_lorry_carries_the_truck_the_query_typed(client, token, project):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _freight(bd, db)
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    answer = _search(client, token, db, "freight transport by truck")
    assert "truck" not in answer["terms_not_in_results"]
    assert answer["best_match_words"] != "0 of 1"


def test_the_mode_rule_decides_when_the_text_alone_would_put_the_ship_first(client, token, project, monkeypatch):
    """The ship's name shares more words with the query; without the rule it leads, with it the lorry does."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _freight(bd, db, ship_name="market for freight transport by ship, freight transport, sea")
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    from prism_lca.search import service as search_service

    service = client.app.state.search
    monkeypatch.setattr(service._variants, "for_query", lambda query, entries: (None, False))  # text only
    assert _search(client, token, db, "freight transport by truck")["hits"][0]["code"] == "lorry"
    monkeypatch.setattr(search_service, "transport_intent", lambda query: None)
    assert _search(client, token, db, "freight transport by truck")["hits"][0]["code"] == "ship"


def test_an_abbreviation_and_an_everyday_word_are_read_together(client, token, project):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]

    def act(code, nm, prod, unit, synonyms=()):
        return {"name": nm, "reference product": prod, "location": "GLO", "unit": unit, "synonyms": list(synonyms),
                "exchanges": [{"input": (db, code), "amount": 1.0, "type": "production"}]}

    bd.Database(db).write({
        (db, "pet"): act("pet", "polyethylene terephthalate production, granulate",
                         "polyethylene terephthalate, granulate", "kilogram", ["PET"]),
        (db, "lorry"): act("lorry", "market for transport, freight, lorry, unspecified",
                           "transport, freight, lorry, unspecified", "ton kilometer"),
    })
    bd.databases[db][common.COMPLETE_KEY] = True
    bd.databases.flush()
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    answer = _search(client, token, db, "PET transport by truck")
    assert answer["searched_as"]["replaced"] == {"PET": "polyethylene terephthalate", "truck": "lorry"}



@pytest.mark.parametrize("query", ["delivery van", "Binnenschiff"])
def test_a_hit_in_the_databases_words_carries_the_word_typed(client, token, project, query):
    """The van reading names two databases' words and a hit says only one; the barge reading is in the plural
    the databases write — either way the right hit must not report the typed word missing."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]

    def act(code, nm):
        return {"name": nm, "reference product": nm, "location": "GLO", "unit": "ton kilometer",
                "exchanges": [{"input": (db, code), "amount": 1.0, "type": "production"}]}

    bd.Database(db).write({(db, "lcv"): act("lcv", "market for transport, freight, light commercial vehicle"),
                           (db, "barge"): act("barge", "market for transport, freight, inland waterways, barge")})
    bd.databases[db][common.COMPLETE_KEY] = True
    bd.databases.flush()
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    assert _search(client, token, db, query)["terms_not_in_results"] == []
