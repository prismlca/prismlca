from __future__ import annotations

import uuid

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import set_read_only


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    assert r.status_code == 200, r.text
    return db


def _create(client, token, db, name, **kw) -> str:
    r = client.post(
        "/api/v1/model/activities",
        json={"database": db, "name": name, **kw},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def test_create_activity_undo_redo(client, token, project):
    db = _fg(client, token)
    r = client.post(
        "/api/v1/model/activities",
        json={"database": db, "name": "Assembly", "product": "widget", "unit": "unit"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    detail = r.json()
    code = detail["activity"]["code"]
    assert detail["activity"]["read_only"] is False
    assert any(e["type"] == "production" for e in detail["exchanges"])

    assert client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).status_code == 200
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).status_code == 404
    assert client.post("/api/v1/model/redo", headers=token).status_code == 200
    assert client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).status_code == 200


def test_add_exchange_set_amount_undo(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A", unit="kg")
    b = _create(client, token, db, "B", unit="kg")

    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a,
              "input_database": db, "input_code": b, "amount": 2.0},
        headers=token,
    )
    assert r.status_code == 200, r.text
    uid = r.json()["exchange"]["uid"]
    assert r.json()["exchange"]["amount"] == 2.0

    r = client.post(
        "/api/v1/model/exchanges/amount",
        json={"activity_database": db, "activity_code": a, "uid": uid, "amount": 5.0},
        headers=token,
    )
    assert r.status_code == 200 and r.json()["exchange"]["amount"] == 5.0

    client.post("/api/v1/model/undo", headers=token)
    detail = client.get(f"/api/v1/model/activities/{db}/{a}", headers=token).json()
    ex = [e for e in detail["exchanges"] if e["uid"] == uid][0]
    assert ex["amount"] == 2.0


def test_who_consumes_a_dataset(client, token, project):
    """Replacing a background dataset after a review is the commonest repair there is, and it began
    with the assistant recalling from memory where it had linked the thing — every other read goes
    the other way round."""
    db = _fg(client, token)
    a = _create(client, token, db, "A", unit="kg")
    b = _create(client, token, db, "B", unit="kg")
    shared = _create(client, token, db, "shared input", unit="kg")
    for host, amount in ((a, 2.0), (b, 0.5)):
        client.post(
            "/api/v1/model/exchanges",
            json={"activity_database": db, "activity_code": host,
                  "input_database": db, "input_code": shared, "amount": amount},
            headers=token,
        )

    r = client.get(f"/api/v1/model/consumers/{db}",
                   params={"input_database": db, "input_code": shared}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 2
    by_name = {c["name"]: c for c in body["consumers"]}
    assert set(by_name) == {"A", "B"}
    assert by_name["A"]["amount"] == 2.0 and by_name["B"]["amount"] == 0.5
    assert by_name["A"]["uid"]

    # Something nothing links to answers zero rather than erroring — that IS the answer.
    r = client.get(f"/api/v1/model/consumers/{db}",
                   params={"input_database": db, "input_code": a}, headers=token)
    assert r.json()["count"] == 0


def test_a_negative_input_says_why_it_is_negative(client, token, project):
    """Reading back a waste flow shows direction "output" and a minus sign, and nothing else marked
    it as deliberate — while the SEARCH result explains the same convention via `sign_hint`. An
    assistant could not tell a correct negative amount from a mistake and re-created one identically,
    spending a round to change nothing."""
    db = _fg(client, token)
    a = _create(client, token, db, "A", unit="kg")
    b = _create(client, token, db, "B", unit="kg")
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a,
              "input_database": db, "input_code": b, "amount": -0.5},
        headers=token,
    )
    assert r.status_code == 200, r.text
    ex = r.json()["exchange"]
    assert ex["direction"] == "output" and ex["amount"] == -0.5
    assert "negative" in ex["sign_note"].lower()

    # A positive input carries no note — it would be noise on every ordinary row.
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a,
              "input_database": db, "input_code": b, "amount": 1.0},
        headers=token,
    )
    assert "sign_note" not in r.json()["exchange"]


def test_readonly_block_and_copy_to_foreground(client, token, project):
    bd = get_bd()
    bg = "bg-" + uuid.uuid4().hex[:6]
    dbobj = bd.Database(bg)
    dbobj.register()
    set_read_only(bg, True)
    act = dbobj.new_activity(code="steel", name="steel production", unit="kg", location="RER")
    act["reference product"] = "steel"
    act["type"] = "process"
    act.save()
    prod = act.new_edge(input=act, amount=1.0, type="production")
    prod["prism_uid"] = "p"
    prod.save()

    # cannot create directly in a read-only database
    r = client.post("/api/v1/model/activities", json={"database": bg, "name": "x"}, headers=token)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "read_only_database"

    # copy into a writable foreground database instead
    fg = _fg(client, token)
    r = client.post(
        "/api/v1/model/activities/copy",
        json={"source_database": bg, "source_code": "steel", "target_database": fg},
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["activity"]["read_only"] is False
    assert d["activity"]["name"] == "steel production"
    assert any(e["type"] == "production" for e in d["exchanges"])
    assert d["relinked"] == 0  # a plain copy leaves every consumer where it was


def test_localize_moves_the_models_consumers_onto_the_copy(client, token, project):
    """Localize re-points the canvas arrows at the copy — so the model must follow, or the picture
    shows a supply the calculation does not use. Undo puts the edge back."""
    bd = get_bd()
    bg = "bg-" + uuid.uuid4().hex[:6]
    dbobj = bd.Database(bg)
    dbobj.register()
    set_read_only(bg, True)
    act = dbobj.new_activity(code="steel", name="steel production", unit="kg", location="RER")
    act["type"] = "process"
    act.save()
    act.new_edge(input=act, amount=1.0, type="production").save()

    fg = _fg(client, token)
    a = _create(client, token, fg, "Frame", unit="kg")
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": fg, "activity_code": a,
              "input_database": bg, "input_code": "steel", "amount": 3.0, "comment": "hot rolled"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    uid = r.json()["exchange"]["uid"]

    r = client.post(
        "/api/v1/model/activities/copy",
        json={"source_database": bg, "source_code": "steel", "target_database": fg,
              "relink_consumers": True},
        headers=token,
    )
    assert r.status_code == 200, r.text
    copy = r.json()["activity"]["code"]
    assert r.json()["relinked"] == 1

    def steel_input():
        detail = client.get(f"/api/v1/model/activities/{fg}/{a}", headers=token).json()
        (ex,) = [e for e in detail["exchanges"] if e["type"] != "production"]
        return ex

    ex = steel_input()
    assert (ex["input"]["database"], ex["input"]["code"]) == (fg, copy)
    assert ex["amount"] == 3.0 and ex["uid"] == uid and ex["comment"] == "hot rolled"

    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    ex = steel_input()
    assert (ex["input"]["database"], ex["input"]["code"]) == (bg, "steel")
    assert ex["amount"] == 3.0 and ex["uid"] == uid
    assert client.get(f"/api/v1/model/activities/{fg}/{copy}", headers=token).status_code == 404


def test_tags_add_list_remove_undo(client, token, project):
    db = _fg(client, token)
    code = _create(client, token, db, "P", unit="kg")

    r = client.post(
        "/api/v1/model/tags",
        json={"database": db, "code": code, "dimension": "stage", "value": "raw materials"},
        headers=token,
    )
    assert r.status_code == 200 and r.json()["tagged"] == 1

    tags = client.get(f"/api/v1/model/tags/{db}/{code}", headers=token).json()
    assert {"dimension": "stage", "value": "raw materials"} in tags

    client.post("/api/v1/model/undo", headers=token)
    assert client.get(f"/api/v1/model/tags/{db}/{code}", headers=token).json() == []


def test_graph_nodes_and_edges(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A", unit="kg")
    b = _create(client, token, db, "B", unit="kg")
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a,
              "input_database": db, "input_code": b, "amount": 2.0},
        headers=token,
    )
    g = client.get(f"/api/v1/model/graph/{db}", headers=token).json()
    codes = {n["code"] for n in g["nodes"]}
    assert {a, b} <= codes
    assert any(e["type"] == "technosphere" and e["amount"] == 2.0 for e in g["edges"])


def test_audit_and_history(client, token, project):
    db = _fg(client, token)
    _create(client, token, db, "P", unit="kg")

    assert client.get("/api/v1/model/history", headers=token).json()["can_undo"] is True
    audit = client.get("/api/v1/model/audit", headers=token).json()
    assert any(a["action"] == "create_activity" and a["source"] == "user" for a in audit)


def test_a_database_name_survives_hyphens_and_spaces(client, token, project):
    """`ecoinvent 3.12 cutoff` should reach `ecoinvent-3.12-cutoff`, and a miss should name what exists.

    The exact spelling of a database name is not something anyone memorises. An assistant lost a round
    to it in a live session: it wrote `ecoinvent`, the call failed, and nothing in the error said which
    names the project actually had.
    """
    client.post("/api/v1/databases/foreground", json={"name": "ecoinvent-3.12-cutoff"}, headers=token)

    for spelling in ("ecoinvent-3.12-cutoff", "ecoinvent 3.12 cutoff", "Ecoinvent3.12Cutoff"):
        r = client.get(f"/api/v1/model/activities/{spelling}", headers=token)
        assert r.status_code == 200, f"{spelling}: {r.text}"

    r = client.get("/api/v1/model/activities/nothing-like-it", headers=token)
    assert r.status_code == 404
    body = r.json()["error"]
    assert body["code"] == "database_not_found"
    # The useful part of a 404 here is the list of names that do exist.
    assert "ecoinvent-3.12-cutoff" in body["hint"]


class _FakeExchange(dict):
    """Minimal stand-in for a brightway exchange: a dict plus `.input`."""

    def __init__(self, amount, supplier):
        super().__init__(amount=amount, type="technosphere")
        self.input = supplier


class _FakeActivity(dict):
    def __init__(self, key, exchanges=(), **fields):
        super().__init__(**fields)
        self.key = key
        self._ex = list(exchanges)

    def technosphere(self):
        return list(self._ex)


def test_service_note_quotes_the_dataset_that_says_it_supplies_no_material():
    """V78: ecoinvent declares processing-only datasets in its own words — quote them.

    An earlier test run bought 0.95 kg of "market for section bar extrusion, aluminium" and
    got no aluminium: the extrusion dataset draws 0.013 kg of wrought alloy per kilogram. Nothing
    distinguished it from the metal (same unit, same ISIC, the same CPC 88602 whose name reads
    "…manufacturing services"). What does distinguish it is the sentence below, ecoinvent's own.
    """
    from prism_lca.engine.model import service_only_note

    supplier = _FakeActivity(
        ("ei", "rer"),
        name="section bar extrusion, aluminium",
        location="RER",
        comment=(
            "Heated aluminium is forced through one or more dies.\n"
            "Included activities start: The material on which this service activity is applied it "
            "is not included as input.\n"
            "Included activities end: Does not include the material beeing extruded, only the "
            "amount of scrap lost in waste is balanced as primary aluminium input."
        ),
    )
    supplier["reference product"] = "section bar extrusion, aluminium"

    note = service_only_note(supplier)
    assert "is not included as input" in note
    assert "beeing extruded" in note


def test_a_market_inherits_the_note_from_the_supplier_it_mostly_consists_of():
    """The market is what search returns and what a model links — and its own comment is boilerplate."""
    from prism_lca.engine.model import service_only_note

    def supplier(code, location, share):
        a = _FakeActivity(
            ("ei", code),
            name="section bar extrusion, aluminium",
            location=location,
            comment="The material on which this service activity is applied it is not included as input.",
        )
        a["reference product"] = "section bar extrusion, aluminium"
        return _FakeExchange(share, a)

    market = _FakeActivity(
        ("ei", "glo"),
        exchanges=[supplier("row", "RoW", 0.251), supplier("rer", "RER", 0.749)],
        name="market for section bar extrusion, aluminium",
        location="GLO",
        comment="This is a market activity. Each market represents the consumption mix of a product.",
    )
    market["reference product"] = "section bar extrusion, aluminium"

    note = service_only_note(market)
    assert "is not included as input" in note
    assert "[RER]" in note and "75%" in note  # attributed to the supplier it came from


def test_a_plain_material_stays_silent():
    """No threshold, so no invented verdicts: a material market says nothing because ecoinvent says nothing."""
    from prism_lca.engine.model import service_only_note

    producer = _FakeActivity(
        ("ei", "prod"),
        name="flat glass production, uncoated",
        location="RER",
        comment="Production of uncoated flat glass by the float process.",
    )
    producer["reference product"] = "flat glass, uncoated"
    market = _FakeActivity(
        ("ei", "mkt"),
        exchanges=[_FakeExchange(1.0, producer)],
        name="market for flat glass, uncoated",
        location="RER",
        comment="This is a market activity. Each market represents the consumption mix of a product.",
    )
    market["reference product"] = "flat glass, uncoated"

    assert service_only_note(market) == ""
    assert service_only_note(producer) == ""


def test_service_note_also_reads_ecoinvents_other_wording():
    """V95: the four verbatim phrases of V78 miss half the database, plastics conversion included.

    A wall-paint run modelled a PP bucket with `injection moulding` — the plastics
    equivalent of the aluminium case V78 was built for, and the dataset actually in that model. Its
    comment says the same thing in different words and got no note. Measured over ecoinvent 3.12:
    the four phrases catch 191 activities, this wording catches 179 more across 70 names.
    """
    from prism_lca.engine.model import service_only_note

    act = _FakeActivity(
        ("ei", "im"),
        name="injection moulding",
        location="RER",
        comment=(
            "1 kg of this process equals 0.994 kg of injection moulded plastics.\n"
            "Included activities end: This process contains the auxillaries and energy demand for "
            "the mentioned convertion process of plastics. The converted amount of plastics is NOT "
            "included into the dataset."
        ),
    )
    act["reference product"] = "injection moulding"

    note = service_only_note(act)
    assert "converted amount of plastics is NOT included" in note


def test_service_note_stays_silent_on_the_other_things_a_dataset_leaves_out():
    """V95 guard: "not included" alone is not the signal — only the MATERIAL being worked on is.

    These four wordings occur in ecoinvent too (the first in 54 distinct names), and none of them
    says the dataset supplies a service rather than a substance. A phrase list that dragged them in
    would fire on ordinary datasets and be worth nothing.
    """
    from prism_lca.engine.model import service_only_note

    for sentence in (
        "Losses and relevant exchanges (transport, transport infrastructure, etc.) are not "
        "included in this dataset.",
        "Electricity input is NOT included into the dataset.",
        "Planting material is not included.",
        "Packaging material is not included.",
    ):
        act = _FakeActivity(("ei", "x"), name="some production", location="RER", comment=sentence)
        act["reference product"] = "some product"
        assert service_only_note(act) == "", sentence


def test_a_market_carries_its_main_suppliers_comment():
    """A market's detail answer quotes the producer it mostly buys from — calibration included.

    A solar-lamp run linked `market for battery, NiMH, rechargeable` at 41 % of the
    result; the sentence that would have overturned the choice ("for laptop applications … as used
    in a Fujitsu-Siemens laptop") sits on the producer, one lookup deeper than anybody went. The
    market inherits the WHOLE producer comment, unjudged — unlike service_only_note this quotes no
    specific phrase class, so it also covers the "calibrated on another product" case that no phrase
    list can.
    """
    from prism_lca.engine.model import market_main_supplier_comment

    def producer(code, comment, share):
        a = _FakeActivity(("ei", code), name=f"battery production {code}", location="GLO", comment=comment)
        a["reference product"] = "battery, NiMH, rechargeable"
        return _FakeExchange(share, a)

    market = _FakeActivity(
        ("ei", "mkt"),
        exchanges=[
            producer("small", "A minor producer.", 0.2),
            producer(
                "big",
                "This dataset represents the production of 1 kg of a NiMH battery for laptop "
                "applications … as used in a Fujitsu-Siemens laptop, model: C4135.",
                0.8,
            ),
        ],
        name="market for battery, NiMH, rechargeable",
        location="GLO",
        comment="This is a market activity. Each market represents the consumption mix of a product.",
    )
    market["reference product"] = "battery, NiMH, rechargeable"

    got = market_main_supplier_comment(market)
    assert got is not None
    assert got["name"] == "battery production big"
    assert got["share"] == 0.8
    assert "for laptop applications" in got["comment"]


def test_a_producer_borrows_no_comment_and_neither_does_a_commentless_market():
    """Only markets inherit — a producer's comment is its own — and boilerplate-plus-silence stays silent."""
    from prism_lca.engine.model import market_main_supplier_comment

    producer = _FakeActivity(
        ("ei", "prod"), name="battery production, NiMH", location="GLO", comment="Its own words."
    )
    producer["reference product"] = "battery, NiMH, rechargeable"
    assert market_main_supplier_comment(producer) is None

    silent = _FakeActivity(("ei", "s"), name="battery production silent", location="GLO", comment="")
    silent["reference product"] = "battery, NiMH, rechargeable"
    market = _FakeActivity(
        ("ei", "mkt2"),
        exchanges=[_FakeExchange(1.0, silent)],
        name="market for battery, NiMH, rechargeable",
        location="GLO",
        comment="Each market represents the consumption mix of a product.",
    )
    market["reference product"] = "battery, NiMH, rechargeable"
    assert market_main_supplier_comment(market) is None


def test_activity_list_is_sorted_by_name(client, token, project):
    """The model's process list came in Brightway's iteration order, a different one on every call — the
    Results rail and the own processes' default colours followed it (the list is now sorted by name;
    search keeps its own ranking). Case-insensitive, ties broken by code so the order is total."""
    db = _fg(client, token)
    for name in ["bottle", "Cap", "label", "Bottle", "assembly"]:
        _create(client, token, db, name)
    for _ in range(3):
        acts = client.get(f"/api/v1/model/activities/{db}", headers=token).json()
        names = [a["name"] for a in acts]
        assert [n.casefold() for n in names] == ["assembly", "bottle", "bottle", "cap", "label"]
        twins = [a["code"] for a in acts if a["name"].casefold() == "bottle"]
        assert twins == sorted(twins)
