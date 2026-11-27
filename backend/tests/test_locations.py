"""Locations a model stores are never evaluated by Brightway (engine/locations.py).

bw2data reads a location with a round bracket back through eval. Here: what becomes of such a location on each
way into a model — rewritten with square brackets, said in the answer or in the log — and that a calculation never
runs one, also when it was stored by a way that did not rewrite it. Background databases keep theirs.
"""
from __future__ import annotations

import uuid

import pytest

from prism_lca.engine import bundle
from prism_lca.engine.backgrounds.common import COMPLETE_KEY
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.locations import (
    location_note,
    make_stored_locations_safe,
    recording,
    safe_location,
)


@pytest.mark.parametrize(
    ("given", "stored"),
    [
        ("GLO", "GLO"),
        ("RER w/o CH+DE", "RER w/o CH+DE"),
        ("Russia (Asia)", "Russia [Asia]"),
        ("exit (0)", "exit [0]"),
        ("Europe without NORDEL (NCPA)", "Europe without NORDEL [NCPA]"),
        # Text shaped like a tuple too: Brightway would turn it into a tuple its geography table does not know.
        ("('ecoinvent', 'RER')", "['ecoinvent', 'RER']"),
        ("(open('x'), 'RER')", "[open['x'], 'RER']"),
        ("()", "[]"),
        ("", ""),
        (None, None),
        # A real tuple is how Brightway keeps a regionalised location; it maps it as one.
        (("ecoinvent", "RER"), ("ecoinvent", "RER")),
        # Anything else from a file becomes its text, which Brightway finds again when it processes.
        (12345, "12345"),
        (["ecoinvent", "RER"], "['ecoinvent', 'RER']"),
    ],
)
def test_text_keeps_no_round_brackets_and_a_real_tuple_passes(given, stored):
    assert safe_location(given) == stored


def test_an_import_hears_what_it_rewrote():
    with recording() as outer:
        safe_location("GLO")
        safe_location("a (b)")
        with recording() as inner:
            safe_location("c (d)")
        assert inner == [("c (d)", "c [d]")]
    assert outer == [("a (b)", "a [b]"), ("c (d)", "c [d]")]
    assert safe_location("e (f)") == "e [f]"  # outside a recording nothing is kept


def test_the_note_names_both_spellings_and_only_when_something_changed():
    assert location_note("GLO", "GLO") is None
    assert location_note(None, "GLO") is None
    note = location_note("Russia (Asia)", "Russia [Asia]")
    assert "'Russia (Asia)'" in note and "'Russia [Asia]'" in note


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def test_a_process_created_or_edited_with_round_brackets_stores_square_ones_and_says_so(client, token, project):
    db = _fg(client, token)
    r = client.post(
        "/api/v1/model/activities",
        json={"database": db, "name": "A", "unit": "kg", "location": "Russia (Asia)"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["activity"]["location"] == "Russia [Asia]"
    assert "'Russia [Asia]'" in r.json()["location_note"]
    code = r.json()["activity"]["code"]

    r = client.post(
        "/api/v1/model/activities/fields", json={"database": db, "code": code, "location": "CH (Ticino)"}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["activity"]["location"] == "CH [Ticino]"
    assert "'CH (Ticino)'" in r.json()["location_note"]

    r = client.post("/api/v1/model/activities/fields", json={"database": db, "code": code, "location": "DE"}, headers=token)
    assert "location_note" not in r.json()
    r = client.post(
        "/api/v1/model/activities/fields",
        json={"database": db, "code": code, "location": "('ecoinvent', 'RER')"},
        headers=token,
    )
    assert r.json()["activity"]["location"] == "['ecoinvent', 'RER']" and "location_note" in r.json()


def test_a_bundle_writes_its_locations_with_square_brackets(project):
    _method()
    db = "m-" + uuid.uuid4().hex[:6]
    get_bd().Database(db).register()
    rows = {
        "activities": [
            {"code": "p", "name": "p", "unit": "kg", "location": "exit (0)"},
            {"code": "q", "name": "q", "unit": "kg", "location": 12345},
        ],
        "exchanges": [],
    }
    with recording() as rewritten:
        bundle._write_graph_rows(get_bd().Database(db), db, rows)
    assert get_bd().get_activity((db, "p"))["location"] == "exit [0]"
    assert get_bd().get_activity((db, "q"))["location"] == "12345"
    assert rewritten == [("exit (0)", "exit [0]"), (12345, "12345")]


def test_a_background_cannot_take_a_name_the_app_keeps(client, token, project):
    for name in ("My processes", "biosphere3"):
        r = client.post(
            "/api/v1/setup/background", json={"source": "bafu", "path": "/nowhere", "database": name}, headers=token
        )
        assert r.status_code == 400 and r.json()["error"]["code"] == "reserved_name", r.text


def _method():
    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _stored_as_is(db: str, location: str) -> None:
    """A model whose process carries ``location`` exactly as given — as a way that does not rewrite it would leave
    it — written without processing, so nothing has evaluated it yet."""
    get_bd().Database(db).write(
        {
            (db, "p"): {
                "name": "p",
                "unit": "kg",
                "location": location,
                "reference product": "p",
                "exchanges": [
                    {"input": (db, "p"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2, "type": "biosphere"},
                ],
            }
        },
        process=False,
    )
    get_bd().databases.set_dirty(db)  # as after any change: the next calculation processes it


@pytest.mark.parametrize("path", ["/api/v1/calc/lcia", "/api/v1/calc/montecarlo"])
def test_a_calculation_never_runs_a_location(client, token, project, tmp_path, path):
    """The stored location would create a file if Brightway evaluated it. The calculation rewrites it first."""
    _method()
    db = "m-" + uuid.uuid4().hex[:6]
    marker = tmp_path / "ran"
    _stored_as_is(db, f'__import__("pathlib").Path("{marker}").touch() or "GLO"')
    body = {"database": db, "code": "p", "method": ["test", "gwp"]}
    r = client.post(path, json={**body, **({"iterations": 3} if "montecarlo" in path else {})}, headers=token)
    assert r.status_code == 200, r.text
    assert not marker.exists()
    location = get_bd().get_activity((db, "p"))["location"]
    assert "(" not in location and location.startswith("__import__[")


def test_opening_a_workspace_rewrites_models_and_the_library_but_never_a_background(project):
    _method()
    model, library, background = ("m-" + uuid.uuid4().hex[:6]), "My processes", ("bg-" + uuid.uuid4().hex[:6])
    bd = get_bd()
    _stored_as_is(model, "Russia (Asia)")
    _stored_as_is(library, "exit (0)")
    _stored_as_is(background, "Russia (Asia)")
    bd.databases[background][COMPLETE_KEY] = True
    bd.databases[background]["prism_read_only"] = True
    # A model may be called biosphere3 where no biosphere was imported: the name protects nothing.
    impostor = "biosphere3"
    _stored_as_is(impostor, "exit (1)")
    bd.databases[impostor]["prism_read_only"] = False
    named_like_the_library = "bg-lib-" + uuid.uuid4().hex[:4]
    _stored_as_is(named_like_the_library, "Russia (Asia)")
    bd.databases[named_like_the_library][COMPLETE_KEY] = True  # by its marks it is a background, whatever its name
    regional = "m-" + uuid.uuid4().hex[:6]
    _stored_as_is(regional, "GLO")
    act = bd.get_activity((regional, "p"))
    act["location"] = ("ecoinvent", "RER")  # how Brightway keeps a regionalised location
    act.save()
    bd.databases.flush()

    class Bus:
        def __init__(self):
            self.notes = []

        def note(self, source, action, summary, database=None, **_):
            self.notes.append((source, action, summary, database))

    bus = Bus()
    changed = make_stored_locations_safe(bus)
    assert changed == {
        model: [("Russia (Asia)", "Russia [Asia]")],
        library: [("exit (0)", "exit [0]")],
        impostor: [("exit (1)", "exit [1]")],
    }
    assert bd.get_activity((regional, "p"))["location"] == ("ecoinvent", "RER")
    assert bd.get_activity((named_like_the_library, "p"))["location"] == "Russia (Asia)"
    assert bd.get_activity((model, "p"))["location"] == "Russia [Asia]"
    assert bd.get_activity((library, "p"))["location"] == "exit [0]"
    assert bd.get_activity((background, "p"))["location"] == "Russia (Asia)"
    assert {(n[0], n[1], n[3]) for n in bus.notes} == {
        ("system", "safe_locations", model),
        ("system", "safe_locations", library),
        ("system", "safe_locations", impostor),
    }
    assert "1 location stored with square brackets" in bus.notes[0][2]
    # Nothing left to do the second time.
    assert make_stored_locations_safe(bus) == {} and len(bus.notes) == 3
