"""The shape of the foreground graph: everything feeds one reference process, and nothing reaches it twice."""
from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def _edge(client, token, db, a, b, amount=1.0) -> str:
    return client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db,
              "input_code": b, "amount": amount},
        headers=token,
    ).json()["exchange"]["uid"]


def _findings(client, token, db) -> list[dict]:
    return client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]


def _codes(client, token, db) -> list[str]:
    return [f["code"] for f in _findings(client, token, db)]


def _life_cycle(client, token, db) -> dict[str, str]:
    """The recommended shape: the functional unit holds the delivered product, use and end of life side by
    side, and the product's own chain runs beneath the delivered product."""
    p = {name: _create(client, token, db, name) for name in
         ("1 litre carried", "distribution", "manufacturing", "use", "end of life")}
    _edge(client, token, db, p["1 litre carried"], p["distribution"], 0.002)
    _edge(client, token, db, p["distribution"], p["manufacturing"])
    _edge(client, token, db, p["1 litre carried"], p["use"])
    _edge(client, token, db, p["1 litre carried"], p["end of life"], 0.002)
    return p


# ---- a process nothing consumes ------------------------------------------------------------------
def test_the_recommended_shape_is_clean(client, token, project):
    db = _fg(client, token)
    _life_cycle(client, token, db)
    codes = _codes(client, token, db)
    assert "disconnected_process" not in codes and "counted_twice_via_two_paths" not in codes


def test_a_stage_nothing_consumes_is_named_with_the_process_the_model_is_calculated_from(client, token, project):
    """Distribution and End of life left hanging free after a rebuild: the model computes, every link checks
    out, and two stages are missing from the total."""
    db = _fg(client, token)
    fu = _create(client, token, db, "1 litre carried")
    manufacturing = _create(client, token, db, "manufacturing")
    _edge(client, token, db, fu, manufacturing, 0.002)
    _create(client, token, db, "distribution")
    _create(client, token, db, "end of life")

    loose = [f for f in _findings(client, token, db) if f["code"] == "disconnected_process"]
    assert sorted(f["activity"]["name"] for f in loose) == ["distribution", "end of life"]
    assert all(f["severity"] == "warning" for f in loose)
    assert "'1 litre carried'" in loose[0]["message"]


def test_a_model_of_one_chain_has_nothing_loose(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "product"), _create(client, token, db, "part")
    _edge(client, token, db, a, b)
    assert "disconnected_process" not in _codes(client, token, db)


# ---- a process reached twice ---------------------------------------------------------------------
def test_use_drawing_on_the_delivered_product_as_well_counts_it_twice(client, token, project):
    """The functional unit takes the delivered bottle, and Use takes it as well: the bottle counts twice."""
    db = _fg(client, token)
    p = _life_cycle(client, token, db)
    _edge(client, token, db, p["use"], p["distribution"], 0.002)

    twice = [f for f in _findings(client, token, db) if f["code"] == "counted_twice_via_two_paths"]
    assert [f["activity"]["name"] for f in twice] == ["distribution"]
    assert "use" in twice[0]["message"]


def test_a_process_reached_by_two_paths_is_flagged(client, token, project):
    """Half-finished restructure: the phase is hung under the reference process and the edge it
    used to hang from stays. Both amounts are added, so the study's total is quietly too high."""
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    filling = _create(client, token, db, "filling")
    formulation = _create(client, token, db, "formulation")
    _edge(client, token, db, main, filling)
    _edge(client, token, db, filling, formulation)  # the old path...
    _edge(client, token, db, main, formulation)  # ...and the new one, both live

    findings = _findings(client, token, db)
    twice = [f for f in findings if f["code"] == "counted_twice_via_two_paths"]
    assert [f["activity"]["name"] for f in twice] == ["formulation"]
    assert "filling" in twice[0]["message"] and "shampoo, cradle-to-grave" in twice[0]["message"]


def test_a_helper_shared_by_two_phases_is_not_counted_twice(client, token, project):
    """Two phases drawing on one intermediate is the shape the skill recommends, not a defect —
    the reference process is not one of the consumers."""
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    formulation = _create(client, token, db, "formulation")
    for name in ("raw materials", "use"):
        phase = _create(client, token, db, name)
        _edge(client, token, db, main, phase)
        _edge(client, token, db, phase, formulation)

    assert "counted_twice_via_two_paths" not in _codes(client, token, db)


def test_a_clean_star_has_one_way_in_per_phase(client, token, project):
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    for name in ("raw materials", "packaging", "use"):
        _edge(client, token, db, main, _create(client, token, db, name))

    assert "counted_twice_via_two_paths" not in _codes(client, token, db)


# ---- a process reached twice below the reference process -------------------------------------------
def _barrow(client, token, db) -> dict[str, str]:
    """The four-assembly shape of a wheelbarrow run, cut to two: the assemblies hung under the delivery
    step, then a final-assembly step put in between — and the direct links left standing."""
    p = {name: _create(client, token, db, name) for name in
         ("wheelbarrow, life cycle", "delivery", "final assembly", "tray", "frame", "end of life")}
    _edge(client, token, db, p["wheelbarrow, life cycle"], p["delivery"])
    _edge(client, token, db, p["wheelbarrow, life cycle"], p["end of life"])
    for part in ("tray", "frame"):
        _edge(client, token, db, p["delivery"], p[part])
        _edge(client, token, db, p["final assembly"], p[part])
    return p


def test_a_step_put_in_between_with_the_direct_links_left_counts_the_parts_twice(client, token, project):
    db = _fg(client, token)
    p = _barrow(client, token, db)
    _edge(client, token, db, p["delivery"], p["final assembly"])

    twice = [f for f in _findings(client, token, db) if f["code"] == "counted_twice_via_two_paths"]
    assert sorted(f["activity"]["name"] for f in twice) == ["frame", "tray"]
    message = next(f["message"] for f in twice if f["activity"]["name"] == "tray")
    assert "'delivery' takes it directly (1 kg) and again through 'final assembly'" in message
    assert all(f["severity"] == "warning" for f in twice)


def test_a_part_used_at_two_levels_with_other_amounts_is_not_flagged(client, token, project):
    """Screws in the final assembly and in the wheel beneath it, 8 and 4: a real use at each level."""
    db = _fg(client, token)
    p = {name: _create(client, token, db, name) for name in ("product", "assembly", "wheel", "screws")}
    _edge(client, token, db, p["product"], p["assembly"])
    _edge(client, token, db, p["assembly"], p["wheel"])
    _edge(client, token, db, p["assembly"], p["screws"], 8)
    _edge(client, token, db, p["wheel"], p["screws"], 4)
    assert "counted_twice_via_two_paths" not in _codes(client, token, db)


def test_a_background_dataset_taken_at_two_levels_is_not_flagged(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    get_bd().Database("bg-elec").write({
        ("bg-elec", "kwh"): {
            "name": "market for electricity, low voltage", "reference product": "electricity, low voltage",
            "unit": "kilowatt hour", "location": "DE",
            "exchanges": [{"input": ("bg-elec", "kwh"), "type": "production", "amount": 1.0}],
        },
    })
    db = _fg(client, token)
    p = {name: _create(client, token, db, name) for name in ("product", "assembly", "subassembly")}
    _edge(client, token, db, p["product"], p["assembly"])
    _edge(client, token, db, p["assembly"], p["subassembly"])
    for consumer in ("assembly", "subassembly"):
        client.post(
            "/api/v1/model/exchanges",
            json={"activity_database": db, "activity_code": p[consumer], "input_database": "bg-elec",
                  "input_code": "kwh", "amount": 1.0},
            headers=token,
        )
    assert "counted_twice_via_two_paths" not in _codes(client, token, db)


def _reached_twice(client, token, db, touching) -> list[dict]:
    r = client.post(f"/api/v1/model/reached-twice/{db}", json={"touching": touching}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["reached_twice"]


def test_the_doubles_a_new_link_is_part_of_are_named_with_both_links(client, token, project):
    db = _fg(client, token)
    p = _barrow(client, token, db)
    _edge(client, token, db, p["delivery"], p["final assembly"])

    found = _reached_twice(client, token, db, [[p["delivery"], p["final assembly"]]])
    assert sorted(t["input"] for t in found) == ["frame", "tray"]
    tray = next(t for t in found if t["input"] == "tray")
    assert tray["process"] == "delivery" and tray["amount"] == 1 and tray["unit"] == "kg"
    assert tray["also_through"] == "delivery → final assembly → tray"
    assert len(tray["direct_uids"]) == 1 and len(tray["through_uids"]) == 1
    assert tray["direct_uids"] != tray["through_uids"]
    # A link on neither route of a double is not part of one.
    assert _reached_twice(client, token, db, [[p["wheelbarrow, life cycle"], p["end of life"]]]) == []
    assert len(_reached_twice(client, token, db, [])) == 2


def test_reached_twice_of_an_unknown_model_is_a_404(client, token, project):
    r = client.post("/api/v1/model/reached-twice/no-such-model", json={"touching": []}, headers=token)
    assert r.status_code == 404
