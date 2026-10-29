from __future__ import annotations

import uuid

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.health import _dimension_note


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


def test_clean_model_has_no_errors(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    _edge(client, token, db, a, b)

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert h["ok"] is True
    assert h["summary"]["error"] == 0
    assert h["activities"] == 2


def test_detects_self_loop_and_circular_reference(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    _edge(client, token, db, a, b)   # A consumes B
    _edge(client, token, db, b, a)   # B consumes A  -> cycle A<->B
    _edge(client, token, db, a, a)   # A consumes A  -> self-loop

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    codes = {f["code"] for f in h["findings"]}
    assert "self_loop" in codes
    assert "circular_reference" in codes
    # cycles/self-loops are warnings, not hard errors
    assert h["summary"]["warning"] >= 2
    assert h["summary"]["error"] == 0


def test_negative_input_from_normal_provider_is_flagged(client, token, project):
    from prism_lca.engine.model import get_activity

    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")          # normal provider (production +1)
    t = _create(client, token, db, "Treatment")  # will get production −1
    act = get_activity(db, t)
    for ex in act.exchanges():
        if ex.get("type") == "production":
            ex["amount"] = -1.0
            ex.save()
    _edge(client, token, db, a, b, amount=-0.5)  # runs B backwards -> warning
    _edge(client, token, db, a, t, amount=-0.5)  # correct waste link -> no warning

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    flagged = [f for f in h["findings"] if f["code"] == "reversed_provider_input"]
    assert len(flagged) == 1
    assert flagged[0]["activity"]["code"] == a
    assert h["summary"]["error"] == 0


def test_zero_production_amount_is_error(client, token, project):
    from prism_lca.engine.model import get_activity

    db = _fg(client, token)
    a = _create(client, token, db, "A")
    act = get_activity(db, a)
    for ex in act.exchanges():
        if ex.get("type") == "production":
            ex["amount"] = 0.0
            ex.save()

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    codes = {f["code"] for f in h["findings"]}
    assert "zero_production_amount" in codes
    assert h["ok"] is False
    assert h["summary"]["error"] >= 1


def test_the_same_dataset_twice_is_tidiness_not_an_error(client, token, project):
    """Two exchanges to one provider compute exactly as one with their sum, and the usual cause is
    ordinary: two waste fractions taking the same treatment route. Calling that "counted twice" would
    train people to ignore the warning that matters — so it is an info."""
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    _edge(client, token, db, a, b, 0.3)
    _edge(client, token, db, a, b, 0.7)

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    dup = [f for f in h["findings"] if f["code"] == "duplicate_input"]
    assert len(dup) == 1
    assert dup[0]["severity"] == "info"
    assert "add up" in dup[0]["message"]
    assert h["ok"] is True


def test_two_datasets_for_one_product_is_flagged_as_possible_double_counting(client, token, project):
    """The failed-replace signature: a new dataset added, the old one never removed. Every per-dataset
    check reads both as perfectly valid inputs — this is the only place it can be seen. Found in a real
    model, where a consumer car trip ended up counted twice under two different vehicle datasets."""
    from prism_lca.engine.bootstrap import get_bd

    db = _fg(client, token)
    consumer = _create(client, token, db, "Juice at retail")
    # Two providers of one product: the same reference product, different activities.
    bd = get_bd()
    for code, name in (("car-a", "car, small"), ("car-b", "car, medium")):
        act = bd.Database(db).new_activity(
            code=code, name=name, unit="kilometer", location="RER"
        )
        act["reference product"] = "transport, passenger car"
        act["type"] = "process"
        act.save()
        prod = act.new_edge(input=act, amount=1.0, type="production")
        prod["prism_uid"] = code + "-prod"
        prod.save()
    _edge(client, token, db, consumer, "car-a", 0.34)
    _edge(client, token, db, consumer, "car-b", 0.34)

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    found = [f for f in h["findings"] if f["code"] == "possible_double_count"]
    assert len(found) == 1
    assert found[0]["severity"] == "warning"
    assert "transport, passenger car" in found[0]["message"]
    # Identical amounts are the strongest hint, and the message says so.
    assert "identical" in found[0]["message"]


def _two_suppliers(client, token, db, consumer, amounts, comments=(None, None)):
    """Two different datasets delivering ONE product to `consumer`, with the given amounts."""
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    for code, name in (("gly-syn", "glycerine, synthetic"), ("gly-veg", "glycerine, vegetable")):
        act = bd.Database(db).new_activity(code=code, name=name, unit="kilogram", location="RER")
        act["reference product"] = "glycerine"
        act["type"] = "process"
        act.save()
        prod = act.new_edge(input=act, amount=1.0, type="production")
        prod["prism_uid"] = code + "-prod"
        prod.save()
    for code, amount, comment in zip(("gly-syn", "gly-veg"), amounts, comments, strict=True):
        uid = _edge(client, token, db, consumer, code, amount)
        if comment:
            client.post(
                "/api/v1/model/exchanges/comment",
                json={"activity_database": db, "activity_code": consumer, "uid": uid, "comment": comment},
                headers=token,
            )


def test_a_mix_that_adds_up_to_the_reference_product_is_a_note_not_a_warning(client, token, project):
    """0.33 + 0.67 = 1 kg is a composition, not a half-finished replacement. Warning on it made the
    assistant argue a correct model out of a defect report — twice, on two different runs."""
    db = _fg(client, token)
    consumer = _create(client, token, db, "Glycerine supply")
    _two_suppliers(client, token, db, consumer, (0.33, 0.67))

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert not [f for f in h["findings"] if f["code"] == "possible_double_count"]
    mix = [f for f in h["findings"] if f["code"] == "deliberate_mix"]
    assert len(mix) == 1 and mix[0]["severity"] == "info"
    assert "add up to the reference product" in mix[0]["message"]


def test_commenting_both_exchanges_is_the_remedy_the_message_asks_for(client, token, project):
    """The old text said 'if the split is deliberate, say so in the exchange comments' and then never
    looked. A warning that survives doing what it asked is noise."""
    db = _fg(client, token)
    consumer = _create(client, token, db, "Glycerine supply")
    _two_suppliers(client, token, db, consumer, (0.2, 0.5), ("deliberate: synthetic share", "rest, vegetable"))

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert not [f for f in h["findings"] if f["code"] == "possible_double_count"]
    assert [f for f in h["findings"] if f["code"] == "deliberate_mix"][0]["severity"] == "info"


def test_an_undocumented_split_that_does_not_add_up_still_warns(client, token, project):
    """The failed-replace signature has to survive both escape hatches, or the check is worthless."""
    db = _fg(client, token)
    consumer = _create(client, token, db, "Glycerine supply")
    _two_suppliers(client, token, db, consumer, (0.2, 0.5))

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    found = [f for f in h["findings"] if f["code"] == "possible_double_count"]
    assert len(found) == 1 and found[0]["severity"] == "warning"


def test_an_add_and_credit_pair_is_not_reported(client, token, project):
    """A positive and a negative amount on one product is a deliberate add-and-credit, not a duplicate.
    Flagging it would make the check noise."""
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    _edge(client, token, db, a, b, 1.0)
    _edge(client, token, db, a, b, -1.0)

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert not [f for f in h["findings"] if f["code"] in ("duplicate_input", "possible_double_count")]


def _codes(health) -> list[str]:
    return [f["code"] for f in health["findings"]]


def test_a_per_kilogram_process_holding_a_whole_product_gets_a_hint(client, token, project):
    """The defect that cost a modelling session a factor of two, with 0 errors and 0 warnings to show for it.

    The process declares 1 kg of film and its inputs were filled with the mass of a whole roll, so the
    demand was applied twice — once by the parent's amount and once inside the formula.
    """
    db = _fg(client, token)
    film = _create(client, token, db, "film production")   # 1 kg of product
    resin = _create(client, token, db, "resin")
    _edge(client, token, db, film, resin, 0.435)           # ...but only 0.435 kg of resin in it

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert "mass_in_below_mass_out" in _codes(h)
    hint = next(f for f in h["findings"] if f["code"] == "mass_in_below_mass_out")
    # A hint and nothing more: the check must stay clean, or every agricultural model cries wolf.
    assert hint["severity"] == "info"
    assert h["summary"]["error"] == 0 and h["summary"]["warning"] == 0
    assert h["ok"] is True


def test_a_process_that_takes_mass_from_the_environment_is_left_alone(client, token, project):
    """Photosynthesis: a tonne of wheat needs nowhere near a tonne of inputs, and that is not an error.

    The check has to stay soft, and silent wherever mass legitimately enters from the
    environment. A natural-resource biosphere flow is what makes that recognisable.
    """
    bd = get_bd()
    bd.Database("bio-air").write({
        ("bio-air", "co2"): {
            "name": "Carbon dioxide, in air",
            "categories": ("natural resource", "in air"),
            "unit": "kg",
            "type": "emission",
        }
    })
    db = _fg(client, token)
    wheat = _create(client, token, db, "wheat, at farm")
    fertiliser = _create(client, token, db, "fertiliser")
    _edge(client, token, db, wheat, fertiliser, 0.02)  # 20 g of fertiliser per kg of wheat

    # Without the uptake the shortfall would be reported...
    assert "mass_in_below_mass_out" in _codes(client.get(f"/api/v1/model/health/{db}", headers=token).json())

    # ...and with it, nothing is said at all.
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": wheat, "input_database": "bio-air",
              "input_code": "co2", "amount": 1.5, "type": "biosphere"},
        headers=token,
    )
    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert "mass_in_below_mass_out" not in _codes(h)


def test_mass_that_leaves_is_never_mentioned(client, token, project):
    """Drying, combustion and losses all reduce mass, and none of them is worth a word."""
    db = _fg(client, token)
    dried = _create(client, token, db, "dried herbs")
    fresh = _create(client, token, db, "fresh herbs")
    _edge(client, token, db, dried, fresh, 8.0)  # 8 kg in, 1 kg out — the water left

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert "mass_in_below_mass_out" not in _codes(h)


def test_a_consumer_demanding_exactly_the_inputs_mass_makes_it_a_warning(client, token, project):
    """V290, the Gießkanne shape: 1 kg of reference product, 0.42 kg of content, 0.42 kg demanded.

    The engine scales by demand ÷ reference amount, so the materials enter the result at 42 % of
    themselves — the generic mass hint saw it and stayed an info, and the run reported "passed"."""
    db = _fg(client, token)
    ref = _create(client, token, db, "reference flow")
    mats = _create(client, token, db, "raw materials")     # declares 1 kg
    pe = _create(client, token, db, "pe pellets")
    _edge(client, token, db, mats, pe, 0.42)               # holds 0.42 kg
    _edge(client, token, db, ref, mats, 0.42)              # ...and 0.42 kg is demanded

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    scaled = [f for f in h["findings"] if f["code"] == "mass_scaled_demand"]
    assert len(scaled) == 1
    assert scaled[0]["severity"] == "warning"
    assert scaled[0]["activity"]["code"] == mats
    assert "0.42" in scaled[0]["message"]
    # The warning replaces the info for this activity, never doubles it.
    infos = [f for f in h["findings"] if f["code"] == "mass_in_below_mass_out"]
    assert all(f["activity"]["code"] != mats for f in infos)


def test_a_demand_unlike_the_inputs_mass_keeps_the_gentle_hint(client, token, project):
    """A shortfall alone stays an info — mass legitimately enters from the environment all the time."""
    db = _fg(client, token)
    ref = _create(client, token, db, "reference flow")
    mats = _create(client, token, db, "raw materials")
    pe = _create(client, token, db, "pe pellets")
    _edge(client, token, db, mats, pe, 0.42)
    _edge(client, token, db, ref, mats, 1.0)               # demands the declared kilogram

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert "mass_scaled_demand" not in _codes(h)
    hint = [f for f in h["findings"] if f["code"] == "mass_in_below_mass_out"
            and f["activity"]["code"] == mats]
    assert len(hint) == 1 and hint[0]["severity"] == "info"


# ---- recyclate bought at end of life (V289) --------------------------------
def _recyclate_provider() -> None:
    """A background dataset that PRODUCES recycled pellets — the thing an EoL process must not buy."""
    get_bd().Database("ei-mini").write({
        ("ei-mini", "rec"): {
            "name": "treatment of waste polyethylene, recycling",
            "reference product": "polyethylene, pellets, recycled",
            "unit": "kilogram",
            "location": "RER",
            "exchanges": [{"input": ("ei-mini", "rec"), "type": "production", "amount": 1.0}],
        },
    })


def test_an_eol_process_buying_recyclate_is_flagged(client, token, project):
    """The documented cut-off mistake: disposal charged for producing recyclate it never uses."""
    _recyclate_provider()
    db = _fg(client, token)
    eol = _create(client, token, db, "End-of-Life — product")
    _tag(client, token, db, eol, "Life-cycle phase", "End-of-Life")
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": eol, "input_database": "ei-mini",
              "input_code": "rec", "amount": 0.116},
        headers=token,
    )

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    flagged = [f for f in h["findings"] if f["code"] == "eol_buys_recyclate"]
    assert len(flagged) == 1
    assert flagged[0]["severity"] == "warning"
    assert flagged[0]["activity"]["code"] == eol
    assert "burden-free" in flagged[0]["message"]


def test_recyclate_on_the_input_side_is_left_alone(client, token, project):
    """The SAME purchase is correct in a raw-materials process — the phase tag is the judge."""
    _recyclate_provider()
    db = _fg(client, token)
    mats = _create(client, token, db, "raw materials")
    _tag(client, token, db, mats, "Life-cycle phase", "Rohstoffe")
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": mats, "input_database": "ei-mini",
              "input_code": "rec", "amount": 0.42},
        headers=token,
    )

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert "eol_buys_recyclate" not in _codes(h)


def test_an_untagged_buyer_of_recyclate_is_left_alone(client, token, project):
    """Without a phase tag there is no verdict to reach — silence beats crying wolf."""
    _recyclate_provider()
    db = _fg(client, token)
    a = _create(client, token, db, "some process")
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": "ei-mini",
              "input_code": "rec", "amount": 0.1},
        headers=token,
    )
    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert "eol_buys_recyclate" not in _codes(h)


# ---- how the tagged life-cycle phases hang together -----------------------
def _tag(client, token, db, code, group, value) -> None:
    client.post("/api/v1/model/tag-groups", json={"name": group}, headers=token)
    client.post("/api/v1/model/tag-groups/values", json={"group": group, "value": value}, headers=token)
    client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": db, "code": code}], "group": group, "value": value},
        headers=token,
    )


def test_phases_side_by_side_are_not_flagged(client, token, project):
    """The shape the model-building skill asks for: every phase hangs off the main node."""
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    for name, phase in (("raw materials", "Raw materials"), ("use", "Use"), ("end-of-life", "End-of-life")):
        code = _create(client, token, db, name)
        _tag(client, token, db, code, "Life-cycle phase", phase)
        _edge(client, token, db, main, code)

    codes = _codes(client.get(f"/api/v1/model/health/{db}", headers=token).json())
    assert "chained_phases" not in codes
    assert "phase_tag_on_reference_process" not in codes


def test_a_chain_of_phases_is_fine_and_an_untagged_step_is_named(client, token, project):
    """Use ← Distribution ← Manufacturing is the product's physical flow and the breakdown follows each
    process's own tag, so the chain itself raises nothing. A step left untagged silently counts under its
    consumer's phase — that is the finding."""
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    use = _create(client, token, db, "use")
    dist = _create(client, token, db, "distribution")
    made = _create(client, token, db, "manufacturing")
    _tag(client, token, db, use, "Life-cycle phase", "Use")
    _tag(client, token, db, dist, "Life-cycle phase", "Distribution")
    _edge(client, token, db, main, use)
    _edge(client, token, db, use, dist)
    _edge(client, token, db, dist, made)

    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert "chained_phases" not in _codes(h)
    untagged = [f for f in h["findings"] if f["code"] == "untagged_step"]
    assert [f["activity"]["name"] for f in untagged] == ["manufacturing"]
    assert "'Distribution'" in untagged[0]["message"]
    assert h["ok"] is True  # a hint, not an error


def test_an_untagged_helper_between_phases_is_not_a_chain(client, token, project):
    """A shared intermediate is meant to stay untagged and inherit its consumer's phase."""
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    raw = _create(client, token, db, "raw materials")
    use = _create(client, token, db, "use")
    formulation = _create(client, token, db, "formulation")  # deliberately untagged
    _tag(client, token, db, raw, "Life-cycle phase", "Raw materials")
    _tag(client, token, db, use, "Life-cycle phase", "Use")
    for phase in (raw, use):
        _edge(client, token, db, main, phase)
        _edge(client, token, db, phase, formulation)

    assert "chained_phases" not in _codes(client.get(f"/api/v1/model/health/{db}", headers=token).json())


def test_a_phase_tag_on_the_reference_process_is_flagged(client, token, project):
    """Nothing consumes the main node, so its tag is what every untagged activity inherits."""
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    raw = _create(client, token, db, "raw materials")
    use = _create(client, token, db, "use")
    _tag(client, token, db, raw, "Life-cycle phase", "Raw materials")
    _tag(client, token, db, use, "Life-cycle phase", "Use")
    _edge(client, token, db, main, raw)
    _edge(client, token, db, main, use)

    assert "phase_tag_on_reference_process" not in _codes(
        client.get(f"/api/v1/model/health/{db}", headers=token).json()
    )

    _tag(client, token, db, main, "Life-cycle phase", "Raw materials")
    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    flagged = [f for f in h["findings"] if f["code"] == "phase_tag_on_reference_process"]
    assert [f["activity"]["name"] for f in flagged] == ["shampoo, cradle-to-grave"]


def test_a_single_valued_dimension_is_not_a_phase_split(client, token, project):
    """One value across the whole model is a label, not a life-cycle breakdown."""
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    a = _create(client, token, db, "a")
    b = _create(client, token, db, "b")
    for code in (main, a, b):
        _tag(client, token, db, code, "Owner", "Team A")
    _edge(client, token, db, main, a)
    _edge(client, token, db, a, b)

    codes = _codes(client.get(f"/api/v1/model/health/{db}", headers=token).json())
    assert "chained_phases" not in codes
    assert "phase_tag_on_reference_process" not in codes


def test_a_mistagged_reference_process_is_reported_once(client, token, project):
    """The root gathering the phases only *looks* chained because it carries a phase tag. Saying
    so once beats saying it again for every phase hanging off it."""
    db = _fg(client, token)
    main = _create(client, token, db, "shampoo, cradle-to-grave")
    for name, phase in (("raw materials", "Raw materials"), ("use", "Use")):
        code = _create(client, token, db, name)
        _tag(client, token, db, code, "Life-cycle phase", phase)
        _edge(client, token, db, main, code)
    _tag(client, token, db, main, "Life-cycle phase", "Raw materials")

    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    # Not every finding sits on an activity — the study-metadata one is about the model as a whole.
    on_main = [f["code"] for f in findings if (f["activity"] or {}).get("name") == "shampoo, cradle-to-grave"]
    assert on_main == ["phase_tag_on_reference_process"]


# ---- the study's own metadata --------------------------------------------
def test_the_unrecorded_scope_fields_are_named(client, token, project):
    """The report's scope panel says this too, and the assistant never opens that page — it has no
    report tools. The health check is the one report it runs by itself."""
    db = _fg(client, token)
    _create(client, token, db, "a")

    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    scope = [f for f in findings if f["code"] == "unrecorded_scope"]
    assert len(scope) == 1
    assert scope[0]["severity"] == "info"  # never blocks an export; an empty review is a valid answer
    for label in ("functional unit", "geography", "reference year", "system boundaries", "cut-off criteria",
                  "process allocation", "system allocation (end of life)", "critical review"):
        assert label in scope[0]["message"]
    assert "model_info" in scope[0]["message"]  # it is told which tool fills them


def test_a_study_that_records_its_scope_is_not_nagged(client, token, project):
    db = _fg(client, token)
    _create(client, token, db, "a")
    client.post(
        "/api/v1/study",
        json={
            "database": db,
            "functional_unit": "1 kg",
            "geography": "made and sold in France",
            "reference_year": "2025",
            "system_boundaries": "cradle-to-gate",
            "cutoff_criteria": "1 % mass",
            "allocation": "mass",
            "system_allocation": "cut-off",
            "critical_review": "none — internal screening",
        },
        headers=token,
    )

    assert "unrecorded_scope" not in _codes(client.get(f"/api/v1/model/health/{db}", headers=token).json())


def test_a_critical_review_answered_no_is_recorded(client, token, project):
    """Authors answer "was there a review?" in the closed choice and leave the description empty. That
    is a complete answer: neither the health check nor the report panel may keep asking for it."""
    db = _fg(client, token)
    _create(client, token, db, "a")
    client.post("/api/v1/study", json={"database": db, "critical_review_done": "no"}, headers=token)

    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    message = next(f["message"] for f in findings if f["code"] == "unrecorded_scope")
    assert "critical review" not in message and "functional unit" in message


def test_a_half_recorded_scope_names_only_what_is_missing(client, token, project):
    db = _fg(client, token)
    _create(client, token, db, "a")
    client.post(
        "/api/v1/study",
        json={"database": db, "functional_unit": "1 kg", "system_boundaries": "cradle-to-gate"},
        headers=token,
    )

    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    message = next(f["message"] for f in findings if f["code"] == "unrecorded_scope")
    assert "functional unit" not in message and "system boundaries" not in message
    assert "cut-off criteria" in message and "critical review" in message


# --- amount quantity vs. the input's unit (V12) -------------------------------------------------

def test_dimension_note_flags_a_mass_parameter_on_a_volume_dataset():
    """The silent failure: an exchange amount is in the INPUT's unit, so a figure thought of in kg
    and pointed at an m3 dataset is wrong by a density and nothing else complains."""
    note = _dimension_note({"formula": "mass_solution"}, "cubic meter", {"mass_solution": "kg"})
    assert note is not None
    assert "mass_solution" in note and "cubic meter" in note


def test_dimension_note_stays_quiet_when_arithmetic_could_be_the_conversion():
    """`-mass_solution / 1000` is how a correct kg -> m3 conversion looks. A checker that cannot
    tell that from an error would flag good models and get switched off."""
    assert _dimension_note({"formula": "-mass_solution / 1000"}, "cubic meter", {"mass_solution": "kg"}) is None


def test_dimension_note_accepts_a_negated_bare_parameter():
    note = _dimension_note({"formula": "-mass_solution"}, "cubic meter", {"mass_solution": "kg"})
    assert note is not None


def test_dimension_note_is_silent_on_matching_or_unknown_quantities():
    assert _dimension_note({"formula": "mass_pet"}, "kg", {"mass_pet": "kg"}) is None
    # Same quantity, different scale — the amount is still in the input's unit, so this is not the
    # mismatch being hunted and guessing a factor here would be worse than saying nothing.
    assert _dimension_note({"formula": "mass_pet"}, "g", {"mass_pet": "kg"}) is None
    assert _dimension_note({"formula": "some_rate"}, "kg", {"some_rate": "dimensionless"}) is None
    assert _dimension_note({"formula": "mass_pet"}, "kg", {}) is None
    assert _dimension_note({"formula": ""}, "kg", {"mass_pet": "kg"}) is None


# --- what the figures rest on (V90) -------------------------------------------------------------

def _param(client, token, db, name, value, description):
    return client.post(
        "/api/v1/params",
        json={"database": db, "name": name, "amount": value, "description": description},
        headers=token,
    )


def test_a_model_built_entirely_on_unsourced_assumptions_says_so(client, token, project):
    """V90: a run built a whole study on memory and every check passed.

    Twenty parameters, fourteen of them beginning with the word "ANNAHME", one URL in the entire
    model — the one the user had pasted into the prompt — and no research tool called. The linter
    ran eight checks and none of them asks what the numbers rest on.
    """
    db = _fg(client, token)
    _create(client, token, db, "a")
    for i in range(4):
        _param(client, token, db, f"p{i}", 1.0 + i, "ASSUMPTION: typical industry value.")

    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    hit = [f for f in findings if f["code"] == "unsourced_figures"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "info"  # a screening study on typical values is legitimate
    assert "0 of 4 parameters" in hit[0]["message"]
    assert "research_bom" in hit[0]["message"]  # it is told what to do about it


def test_a_model_that_cites_its_figures_is_not_nagged(client, token, project):
    db = _fg(client, token)
    _create(client, token, db, "a")
    _param(client, token, db, "p0", 1.0, "Datasheet: https://example.org/spec.pdf")
    _param(client, token, db, "p1", 2.0, "Measured, see https://doi.org/10.1000/xyz")
    _param(client, token, db, "p2", 3.0, "ASSUMPTION: typical value.")

    assert "unsourced_figures" not in _codes(client.get(f"/api/v1/model/health/{db}", headers=token).json())


def test_provenance_stays_quiet_on_a_model_too_small_to_be_a_study(client, token, project):
    db = _fg(client, token)
    _create(client, token, db, "a")
    _param(client, token, db, "p0", 1.0, "ASSUMPTION: a sketch.")

    assert "unsourced_figures" not in _codes(client.get(f"/api/v1/model/health/{db}", headers=token).json())


# --- shaping: material linked, forming missing (V116) -------------------------------------------


def test_shaping_check_is_a_pure_name_comparison():
    """The whole check is a vocabulary match, so it can be measured without a database.

    Two runs in a row shipped bulk metal or plastic with no forming step: a solar lamp
    (chromium steel, polycarbonate, ABS) and an apple sauce (a twist-off lid on
    `steel production, converter, unalloyed` — crude steel, CPC "in ingots or other primary forms",
    while `sheet rolling, steel` and `deep drawing, steel` exist and add 0.78 kg CO2-Eq per kg).

    Measured against all 23 foreground models in the development install when this was written: it
    fires on six, every one of them a genuine gap (two apple-juice bottles with a wrought-aluminium
    closure, the apple sauce lid, cling film from granulate, the solar lamp, a PVC window whose
    profile is extruded and whose reinforcement is roll-formed), and stays quiet on the seventeen
    others — including three that have their forming and would otherwise have been false positives.
    """
    from prism_lca.engine.health import _unformed_materials as check

    # The two real cases.
    assert check(["steel production, converter, unalloyed", "market for corrugated board box"])
    assert check(["market for steel, chromium steel 18/8", "market for polycarbonate"])

    # Quiet when the model HAS its forming — the three that saved this check from firing wrongly.
    assert check(["market for section bar extrusion, aluminium", "market for steel, unalloyed"]) is None
    assert check(["market for blown film extrusion, monolayer", "market for polyethylene, low density, granulate"]) is None
    assert check(["market for injection moulding", "market for polypropylene, granulate"]) is None

    # Quiet when the dataset's own name already says it was shaped. `packaging film, low density
    # polyethylene` was the one false positive of the first draft, in a wall-paint model.
    assert check(["market for packaging film, low density polyethylene"]) is None
    assert check(["market for steel, low-alloyed, hot rolled"]) is None
    assert check(["market for reinforcing steel"]) is None
    assert check(["market for aluminium collector foil, for Li-ion battery"]) is None
    assert check(["market for polystyrene foam slab"]) is None

    # Quiet when there is no shapeable material at all — food, chemicals, packaging boards.
    assert check(["market for apple, organic", "market for tap water"]) is None
    assert check(["market for sodium hydroxide", "market for corrugated board box"]) is None
    # …and quiet on an empty model.
    assert check([]) is None


def test_shaping_check_reports_as_info_and_names_the_material(client, token, project):
    db = _fg(client, token)
    _create(client, token, db, "lid")
    # Anything in the foreground itself is not a background input and must not be counted.
    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert "missing_forming_step" not in _codes(findings)
    assert any("shaping" in c for c in findings["checks_run"])


# --- V164: a note that spells out a parameter's old value --------------------------------


def test_a_note_that_states_an_old_parameter_value_is_reported():
    """The model's own process notes name the parameter *and* its figure, and the inventory chapter
    prints them verbatim. Change the parameter and the delivered PDF states a number the model no
    longer uses — three pages from the parameter table that has the right one, with every chapter
    reporting itself current (apple-juice run: four wrong figures in one chapter).
    """
    from prism_lca.engine.health import frozen_parameter_figures

    values = {"mass_pallet_share": 0.004, "mass_glass_bottle": 0.15, "apples_per_litre": 1.62}
    units = {"mass_pallet_share": "kg/unit", "mass_glass_bottle": "kg/unit", "apples_per_litre": "kg/L"}

    note = "EUR pallet share per bottle: 42 g wood (parameter mass_pallet_share), based on a 25 kg pallet."
    assert frozen_parameter_figures(note, values, units) == [("mass_pallet_share", "42 g", 0.004)]

    # The figure may sit a few words back, and a quantity of another kind in between is not it.
    note = "1.5 kg of apples per 1 L of juice (parameter apples_per_litre, 65–70 % yield)."
    assert [f[0] for f in frozen_parameter_figures(note, values, units)] == ["apples_per_litre"]


def test_a_note_whose_figure_still_matches_says_nothing():
    """Silence is the whole point: a check that fires on a correct note gets switched off. Units are
    levelled (0.0025 kg is "2.5 g"), a rounded distance is not a disagreement, and a share written as
    a percentage matches the fraction the parameter holds."""
    from prism_lca.engine.health import frozen_parameter_figures

    values = {"mass_alu_cap": 0.0025, "dist_cap_plant": 400.0, "eol_glass_recycle": 0.85,
              "water_l_per_l": 3.0}
    units = {"mass_alu_cap": "kg/unit", "dist_cap_plant": "km", "water_l_per_l": "L/L"}
    notes = [
        "28 mm aluminium screw cap, 2.5 g (parameter mass_alu_cap).",
        "Transport ~400 km from supplier to filling plant (parameter dist_cap_plant).",
        "DE splits: 85 % recycling as cullet (parameter eol_glass_recycle).",
        "Water: 3 L per L juice including CIP cleaning (parameter water_l_per_l).",
        # No figure at all, and a figure in a unit the table cannot place.
        "Pasteurisation at ~85 °C for 30 sec (parameter water_l_per_l).",
    ]
    for note in notes:
        assert frozen_parameter_figures(note, values, units) == [], note


def test_a_parameter_the_model_does_not_have_is_not_guessed_at():
    from prism_lca.engine.health import frozen_parameter_figures

    assert frozen_parameter_figures("Something, 42 g (parameter gone_away).", {}, {}) == []


def test_the_linter_really_reads_the_parameters(client, token, project):
    """End-to-end, because the unit tests above pass a dict in by hand.

    `lint_database` imported `list_parameters` — a name that does not exist — inside a `try` that
    swallows the ImportError, so the parameter table was empty on every model and both checks that
    need it were dead: the frozen-figure check on arrival, and the unit-dimension check for months.
    A test that only calls the helpers could not see that.
    """
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    assert client.post(
        "/api/v1/params", json={"database": db, "name": "mass_bottle", "amount": 0.15, "unit": "kg/unit"},
        headers=token,
    ).status_code == 200
    assert client.post(
        "/api/v1/model/activities/fields",
        json={"database": db, "code": a, "comment": "Glass bottle, 370 g (parameter mass_bottle). Own estimate."},
        headers=token,
    ).status_code == 200

    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    stale = [f for f in findings if f["code"] == "stale_parameter_figure"]
    assert len(stale) == 1, findings
    assert "370 g" in stale[0]["message"] and "0.15" in stale[0]["message"]
    assert stale[0]["activity"]["code"] == a


def _health(client, token, db) -> dict:
    return client.get(f"/api/v1/model/health/{db}", headers=token).json()


def _codes(report: dict) -> list[str]:
    return [f["code"] for f in report["findings"]]


# --- V230: a formula that lands on zero takes the whole input out of the system ----------------


def test_a_formula_that_evaluates_to_zero_is_reported(client, token, project):
    """The Balkonkraftwerk inverter: `inverter_replacements` where `1 + inverter_replacements` was
    meant. The exchange stays linked, every structural check passes, and 20 % of the result quietly
    leaves the product system."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "set"), _create(client, token, db, "inverter")
    uid = _edge(client, token, db, a, b, amount=1.0)
    assert client.post(
        "/api/v1/params", json={"database": db, "name": "replacements", "amount": 0}, headers=token
    ).status_code == 200

    assert "formula_evaluates_to_zero" not in _codes(_health(client, token, db))

    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "replacements"},
        headers=token,
    ).status_code == 200

    report = _health(client, token, db)
    hit = [f for f in report["findings"] if f["code"] == "formula_evaluates_to_zero"]
    assert len(hit) == 1, _codes(report)
    assert hit[0]["severity"] == "warning"
    assert hit[0]["uid"] == uid
    assert "1 + n_replacements" in hit[0]["message"]

    # V242: the message asks for a comment, so the comment has to count. It did not — a wood-stain
    # model declared its dormant sea-freight branch exactly as instructed and was reported anyway.
    assert client.post(
        "/api/v1/model/exchanges/comment",
        json={"activity_database": db, "activity_code": a, "uid": uid,
              "comment": "Scenario switch: only active when replacements > 0 (baseline 0)."},
        headers=token,
    ).status_code == 200
    assert "formula_evaluates_to_zero" not in _codes(_health(client, token, db))

    # …and clearing it brings the warning back, so the comment is a declaration and not a mute button
    # somebody hit once.
    assert client.post(
        "/api/v1/model/exchanges/comment",
        json={"activity_database": db, "activity_code": a, "uid": uid, "comment": "   "},
        headers=token,
    ).status_code == 200
    assert "formula_evaluates_to_zero" in _codes(_health(client, token, db))

    # A fixed zero is a person typing a zero — not this check's business.
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": None},
        headers=token,
    ).status_code == 200
    assert client.post(
        "/api/v1/model/exchanges/amount",
        json={"activity_database": db, "activity_code": a, "uid": uid, "amount": 0},
        headers=token,
    ).status_code == 200
    assert "formula_evaluates_to_zero" not in _codes(_health(client, token, db))


# --- V233: the unused-parameter check has to follow the chain ----------------------------------


def test_a_parameter_that_only_feeds_a_dead_parameter_is_reported_too(client, token, project):
    db = _fg(client, token)
    assert client.post(
        "/api/v1/params/bulk",
        json={
            "database": db,
            "parameters": [
                {"name": "yield_kwh", "amount": 550},
                {"name": "lifetime_energy", "formula": "yield_kwh * 20"},
            ],
        },
        headers=token,
    ).status_code == 200

    report = _health(client, token, db)
    hits = {f["parameter"]: f["message"] for f in report["findings"] if f["code"] == "unused_parameter"}
    assert set(hits) == {"yield_kwh", "lifetime_energy"}, hits
    # The leaf says nothing refers to it; the feeder says where its chain dies.
    assert "no other parameter" in hits["lifetime_energy"]
    assert "'lifetime_energy'" in hits["yield_kwh"]
    assert "cannot change any result" in hits["yield_kwh"]


def test_a_parameter_reaching_an_exchange_through_another_parameter_is_not_reported(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "a"), _create(client, token, db, "b")
    uid = _edge(client, token, db, a, b)
    assert client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "n", "amount": 3}, {"name": "m", "formula": "n * 2"}]},
        headers=token,
    ).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "m"},
        headers=token,
    ).status_code == 200
    assert "unused_parameter" not in _codes(_health(client, token, db))


# --- V236: a scenario whose overrides reach nothing ---------------------------------------------


def test_a_scenario_on_an_unreachable_parameter_is_reported(client, token, project):
    db = _fg(client, token)
    assert client.post(
        "/api/v1/params", json={"database": db, "name": "tilt", "amount": 1.0}, headers=token
    ).status_code == 200
    made = client.post(
        "/api/v1/scenarios",
        json={"database": db, "name": "tilted", "overrides": {"tilt": 1.16}},
        headers=token,
    )
    # Creating it is allowed — a scenario written before the formula it will move is ordinary work.
    assert made.status_code == 200, made.text

    listed = client.get("/api/v1/scenarios", params={"database": db}, headers=token).json()
    assert listed[0]["no_effect"] == ["tilt"]
    assert listed[0]["ineffective"] == []

    hit = [f for f in _health(client, token, db)["findings"] if f["code"] == "scenario_has_no_effect"]
    assert len(hit) == 1
    assert hit[0]["severity"] == "warning"
    assert "'tilt'" in hit[0]["message"] and "tilted" in hit[0]["message"]


# --- V233 (b): the reference quantity, built rather than displayed -----------------------------


def test_a_reference_quantity_divides_in_the_matrix_and_is_idempotent(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "set"), _create(client, token, db, "part")
    _edge(client, token, db, a, b, amount=1.0)
    assert client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "yield_kwh", "amount": 550},
                                             {"name": "lifetime_energy", "formula": "yield_kwh * 20"}]},
        headers=token,
    ).status_code == 200
    # Before: the denominator reaches nothing.
    assert "unused_parameter" in _codes(_health(client, token, db))

    r = client.post(
        "/api/v1/model/reference-quantity",
        json={"database": db, "code": a, "parameter": "lifetime_energy",
              "name": "Electricity, per kWh", "unit": "kilowatt hour"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    made = r.json()
    assert made["replaced"] is False
    new_code = made["activity"]["code"]

    # After: nothing dead is left, because the chain now lands on an exchange.
    assert "unused_parameter" not in _codes(_health(client, token, db))
    found = client.get(f"/api/v1/model/reference-quantity/{db}", headers=token).json()
    assert found["parameter"] == "lifetime_energy" and found["of"] == a

    ex = client.get(f"/api/v1/model/activities/{db}/{new_code}", headers=token).json()["exchanges"]
    tech = [e for e in ex if e["type"] == "technosphere"]
    assert len(tech) == 1
    assert tech[0]["formula"] == "1 / lifetime_energy"
    assert tech[0]["amount"] == 1 / 11000.0

    # The formula has to be LIVE, not merely stored. Writing the field alone leaves a string that
    # reads back correctly, satisfies the health check and gives the right baseline — and never
    # recomputes, so every scenario on the denominator returns Δ 0 again. Asserting the string was
    # exactly the mistake this finding set is about: check the effect, not the field.
    assert client.post(
        "/api/v1/params", json={"database": db, "name": "yield_kwh", "amount": 1100}, headers=token
    ).status_code == 200
    moved = client.get(f"/api/v1/model/activities/{db}/{new_code}", headers=token).json()["exchanges"]
    assert next(e for e in moved if e["type"] == "technosphere")["amount"] == 1 / 22000.0

    # Called again it re-points the same node — two dividers would divide twice.
    again = client.post(
        "/api/v1/model/reference-quantity",
        json={"database": db, "code": a, "parameter": "yield_kwh",
              "name": "Electricity, per kWh", "unit": "kilowatt hour"},
        headers=token,
    )
    assert again.status_code == 200, again.text
    assert again.json()["replaced"] is True
    assert again.json()["activity"]["code"] == new_code
    ex2 = client.get(f"/api/v1/model/activities/{db}/{new_code}", headers=token).json()["exchanges"]
    assert len([e for e in ex2 if e["type"] == "technosphere"]) == 1

    # And undo does not delete a node an earlier step created.
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert client.get(f"/api/v1/model/activities/{db}/{new_code}", headers=token).status_code == 200


def test_a_reference_quantity_refuses_a_zero_denominator_and_itself(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "set")
    assert client.post(
        "/api/v1/params", json={"database": db, "name": "nothing", "amount": 0}, headers=token
    ).status_code == 200
    bad = client.post(
        "/api/v1/model/reference-quantity",
        json={"database": db, "code": a, "parameter": "nothing", "name": "x", "unit": "kWh"},
        headers=token,
    )
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "zero_denominator"

    missing = client.post(
        "/api/v1/model/reference-quantity",
        json={"database": db, "code": a, "parameter": "absent", "name": "x", "unit": "kWh"},
        headers=token,
    )
    assert missing.status_code == 400 and missing.json()["error"]["code"] == "unknown_parameter"


def _tkm_dataset(client, token, db, name) -> str:
    """A stand-in for an ecoinvent transport dataset: unit tonne-kilometre, name carrying the mode."""
    return client.post(
        "/api/v1/model/activities",
        json={"database": db, "name": name, "unit": "ton kilometer"},
        headers=token,
    ).json()["activity"]["code"]


def test_a_road_leg_booked_with_the_lot_size_per_kilogram_is_flagged(client, token, project):
    # An earlier test run: 435 km × 0.012 t "per kg of plate" = 5.225 tkm for ONE kilogram —
    # an implied lorry leg of 5 225 km. The right figure was 0.4354 tkm.
    db = _fg(client, token)
    plate = _create(client, token, db, "Steel plate delivered")
    lorry = _tkm_dataset(client, token, db, "transport, freight, lorry >32 metric ton, EURO6")
    uid = _edge(client, token, db, plate, lorry, amount=5.225)
    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    hit = next(f for f in h["findings"] if f["code"] == "transport_distance_implausible")
    assert hit["severity"] == "warning"
    assert hit["uid"] == uid
    assert hit["mode"] == "road"
    assert 5_200 < hit["implied_km"] < 5_250
    assert "0.001 t" in hit["message"]
    assert "transport legs" in " ".join(h["checks_run"])


def test_a_plausible_leg_and_a_long_sea_leg_pass(client, token, project):
    db = _fg(client, token)
    plate = _create(client, token, db, "Steel plate delivered")
    lorry = _tkm_dataset(client, token, db, "transport, freight, lorry >32 metric ton, EURO6")
    ship = _tkm_dataset(client, token, db, "transport, freight, sea, container ship")
    _edge(client, token, db, plate, lorry, amount=0.4354)  # 435 km for 1 kg
    _edge(client, token, db, plate, ship, amount=25.8)  # 25 800 km round the Cape — long, but real
    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    codes = [f["code"] for f in h["findings"]]
    assert "transport_distance_implausible" not in codes
    assert "transport_distance_tiny" not in codes


def test_kilograms_typed_as_tonnes_gives_a_tiny_leg_note(client, token, project):
    db = _fg(client, token)
    plate = _create(client, token, db, "Steel plate delivered")
    lorry = _tkm_dataset(client, token, db, "transport, freight, lorry >32 metric ton, EURO6")
    _edge(client, token, db, plate, lorry, amount=0.000435)  # 435 km × 0.001 kg-as-tonnes ÷ 1000
    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    hit = next(f for f in h["findings"] if f["code"] == "transport_distance_tiny")
    # A warning: the assistant overruled the earlier info as a "false positive" and kept the figure.
    assert hit["severity"] == "warning"
    assert hit["implied_km"] < 1
    # The message does the arithmetic for this product, so a reader has nothing left to argue with.
    assert "a thousand times" in hit["message"]
    assert "0.001 tkm" in hit["message"]


def test_transport_on_a_piece_product_is_not_judged(client, token, project):
    # A product declared per "unit" has no known mass: nothing to divide by, so nothing is said.
    db = _fg(client, token)
    sensor = client.post(
        "/api/v1/model/activities", json={"database": db, "name": "Sensor module", "unit": "unit"}, headers=token
    ).json()["activity"]["code"]
    plane = _tkm_dataset(client, token, db, "market for transport, freight, aircraft, long haul")
    _edge(client, token, db, sensor, plane, amount=1.85)
    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert not [f for f in h["findings"] if f["code"].startswith("transport_distance")]


def test_eol_shares_that_do_not_sum_to_one_get_an_info(client, token, project):
    # An earlier test run closed a 0.4 % gap by folding "other recovery" into landfill;
    # the honest shape is a fourth parameter, and this is the nudge towards it.
    db = _fg(client, token)
    assert client.post(
        "/api/v1/params/bulk",
        json={
            "database": db,
            "parameters": [
                {"name": "eol_recycling", "amount": 0.513, "group": "End-of-life"},
                {"name": "eol_incineration", "amount": 0.472, "group": "End-of-life"},
                {"name": "eol_landfill", "amount": 0.011, "group": "End-of-life"},
            ],
        },
        headers=token,
    ).status_code == 200
    report = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    hit = next(f for f in report["findings"] if f["code"] == "eol_shares_not_unity")
    assert hit["severity"] == "info"
    assert hit["total"] == 0.996
    assert hit["parameters"] == ["eol_incineration", "eol_landfill", "eol_recycling"]
    assert "eol_other" in hit["message"]
    assert "end-of-life shares" in " ".join(report["checks_run"])


def test_eol_shares_that_sum_to_one_are_silent_and_the_group_label_counts_too(client, token, project):
    db = _fg(client, token)
    assert client.post(
        "/api/v1/params/bulk",
        json={
            "database": db,
            "parameters": [
                {"name": "recycling_share", "amount": 0.75, "group": "End of life"},
                {"name": "eol_other", "amount": 0.25},
                {"name": "mass_kg", "amount": 2.5},  # not a share, not counted
            ],
        },
        headers=token,
    ).status_code == 200
    report = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert not [f for f in report["findings"] if f["code"] == "eol_shares_not_unity"]


def test_a_single_eol_parameter_is_not_judged(client, token, project):
    db = _fg(client, token)
    assert client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "eol_recycling", "amount": 0.9}]},
        headers=token,
    ).status_code == 200
    report = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert not [f for f in report["findings"] if f["code"] == "eol_shares_not_unity"]


# --- V332: a typed constant that equals a parameter's value -------------------------------------


def test_a_constant_equal_to_a_parameter_is_pointed_out(client, token, project):
    """A citric-acid model: `citric_acid_mass = 0.23` and an exchange of 0.23 with no
    formula. Reachable parameter, silent checks, scenarios that moved the result by −0.1 %."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "formulation"), _create(client, token, db, "citric acid")
    uid = _edge(client, token, db, a, b, amount=0.23)
    assert _param(client, token, db, "citric_acid_mass", 0.23, "40 % w/w").status_code == 200
    hits = [f for f in _health(client, token, db)["findings"] if f["code"] == "constant_matches_parameter"]
    assert len(hits) == 1 and hits[0]["severity"] == "info" and hits[0]["uid"] == uid
    assert "'citric_acid_mass'" in hits[0]["message"] and "0.23" in hits[0]["message"]

    # Bound with a formula it is one quantity, and the note goes away.
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "citric_acid_mass"},
        headers=token,
    ).status_code == 200
    assert "constant_matches_parameter" not in _codes(_health(client, token, db))


def test_the_constant_one_matches_no_parameter(client, token, project):
    """One unit of a sub-process equals every count-like parameter; saying so would be noise."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "product"), _create(client, token, db, "part")
    _edge(client, token, db, a, b, amount=1.0)
    assert _param(client, token, db, "doses", 1.0, "one per bottle").status_code == 200
    assert "constant_matches_parameter" not in _codes(_health(client, token, db))


def test_undoing_a_replaced_reference_quantity_puts_the_previous_one_back(client, token, project):
    """Undo of a re-pointed reference quantity did nothing and reported success."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "set"), _create(client, token, db, "part")
    _edge(client, token, db, a, b, amount=1.0)
    assert client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "p", "amount": 10}, {"name": "q", "amount": 20}]},
        headers=token,
    ).status_code == 200
    first = client.post(
        "/api/v1/model/reference-quantity",
        json={"database": db, "code": a, "parameter": "p", "name": "per p", "unit": "kilogram"},
        headers=token,
    )
    assert first.status_code == 200 and first.json()["replaced"] is False
    second = client.post(
        "/api/v1/model/reference-quantity",
        json={"database": db, "code": a, "parameter": "q", "name": "per q", "unit": "kilogram"},
        headers=token,
    )
    assert second.status_code == 200 and second.json()["replaced"] is True
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    found = client.get(f"/api/v1/model/reference-quantity/{db}", headers=token).json()
    assert found["parameter"] == "p" and found["name"] == "per p"
    ex = client.get(f"/api/v1/model/activities/{db}/{found['code']}", headers=token).json()["exchanges"]
    tech = [e for e in ex if e["type"] == "technosphere"]
    assert len(tech) == 1 and tech[0]["formula"] == "1 / p" and tech[0]["amount"] == 0.1


def test_an_eol_parameter_with_a_physical_unit_is_not_a_share(client, token, project):
    """`eol_distance` in km was summed with the shares — "101, mass treated twice"."""
    db = _fg(client, token)
    assert client.post(
        "/api/v1/params/bulk",
        json={
            "database": db,
            "parameters": [
                {"name": "eol_recycling", "amount": 0.5},
                {"name": "eol_incineration", "amount": 0.5},
                {"name": "eol_distance", "amount": 100, "unit": "km"},
            ],
        },
        headers=token,
    ).status_code == 200
    report = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert not [f for f in report["findings"] if f["code"] == "eol_shares_not_unity"]


def test_eol_shares_are_judged_per_material(client, token, project):
    """`eol_steel_recycling` and `eol_pp_recycling` are recycling rates of two materials, not a split
    of one mass; an earlier test run was told they "treat 0.848 too much". Shares are grouped
    by the material token after `eol_`; a group of one is not judged, a group of two is."""
    db = _fg(client, token)
    assert client.post(
        "/api/v1/params/bulk",
        json={
            "database": db,
            "parameters": [
                {"name": "eol_steel_recycling", "amount": 0.982, "group": "End of life"},
                {"name": "eol_pp_recycling", "amount": 0.0, "group": "End of life"},
                {"name": "eol_pet_recycling", "amount": 0.5, "group": "End of life"},
                {"name": "eol_pet_landfill", "amount": 0.3, "group": "End of life"},
            ],
        },
        headers=token,
    ).status_code == 200
    report = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    hits = [f for f in report["findings"] if f["code"] == "eol_shares_not_unity"]
    assert len(hits) == 1
    assert hits[0]["parameters"] == ["eol_pet_landfill", "eol_pet_recycling"]
    assert "'pet'" in hits[0]["message"]
