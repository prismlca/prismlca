"""Co-products of an imported process: never a consumption, unbooked by default, substitution on
request.

A process that makes a widget and gives off 3.6 MJ of electricity SELLS that electricity. The import
used to book it as a technosphere input with a positive amount — the widget bought the energy it
exports. The fixture here is the hand-written ILCD unit process with two lines added: that
electricity as an output, and a waste going out (which is not a co-product — it is a treatment
service, a different question).

The numbers are chosen so each stage can be read off by hand. Background electricity emits 0.5 kg
CO2 per kWh, GWP is 1 per kg:

* widget alone: 2.5 kg CO2 + 7.2 MJ (= 2 kWh) of electricity bought → 2.5 + 1.0 = **3.5**
* with the 3.6 MJ (= 1 kWh) co-product booked as substitution → 3.5 − 0.5 = **3.0**
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.dataimport import ilcd, session
from prism_lca.engine.library import LIBRARY_DB

FIXTURES = Path(__file__).parent / "fixtures" / "import"
WASTE_FLOW = "99999999-9999-9999-9999-999999999999"

_EXTRA_EXCHANGES = f"""
    <exchange dataSetInternalID="3">
      <referenceToFlowDataSet type="flow data set" refObjectId="44444444-4444-4444-4444-444444444444">
        <common:shortDescription xml:lang="en">Electricity, medium voltage</common:shortDescription>
      </referenceToFlowDataSet>
      <exchangeDirection>Output</exchangeDirection>
      <meanAmount>3.6</meanAmount>
    </exchange>
    <exchange dataSetInternalID="4">
      <referenceToFlowDataSet type="flow data set" refObjectId="{WASTE_FLOW}">
        <common:shortDescription xml:lang="en">Scrap widgets</common:shortDescription>
      </referenceToFlowDataSet>
      <exchangeDirection>Output</exchangeDirection>
      <meanAmount>0.3</meanAmount>
    </exchange>
  </exchanges>"""


@pytest.fixture
def package(tmp_path: Path) -> Path:
    """The ILCD unit process, now with a co-product and a waste output."""
    root = tmp_path / "ilcd-coproduct"
    shutil.copytree(FIXTURES / "ilcd-unitprocess", root)
    process = root / "processes" / "11111111-1111-1111-1111-111111111111.xml"
    process.write_text(
        process.read_text(encoding="utf-8").replace("  </exchanges>", _EXTRA_EXCHANGES), encoding="utf-8"
    )
    # The waste: a mass flow like the widget itself, only typed as waste.
    widget = (root / "flows" / "22222222-2222-2222-2222-222222222222.xml").read_text(encoding="utf-8")
    (root / "flows" / f"{WASTE_FLOW}.xml").write_text(
        widget.replace("22222222-2222-2222-2222-222222222222", WASTE_FLOW)
        .replace(">Widget<", ">Scrap widgets<")
        .replace("Product flow", "Waste flow"),
        encoding="utf-8",
    )
    return root


@pytest.fixture
def world(client: TestClient, token, project):
    """biosphere3 with CO2, a background electricity to match against, and a GWP method."""
    bd = get_bd()
    bd.Database("biosphere3").write(
        {
            ("biosphere3", "co2-air"): {
                "name": "Carbon dioxide, fossil", "unit": "kilogram",
                "categories": ("air",), "type": "emission",
            },
        }
    )
    bd.Database("bg").write(
        {
            ("bg", "elec"): {
                "name": "electricity production, medium voltage", "unit": "kilowatt hour",
                "location": "DE", "reference product": "electricity, medium voltage",
                "exchanges": [
                    {"input": ("bg", "elec"), "amount": 1.0, "type": "production"},
                    {"input": ("biosphere3", "co2-air"), "amount": 0.5, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("test", "gwp")).write([(("biosphere3", "co2-air"), 1.0)])
    yield
    session.cancel()


def _rows_by_name(name: str) -> list[dict]:
    return [r for r in session.rows() if r["name"] == name]


def _match_electricity_rows_to_the_background() -> None:
    """The reviewer binds both electricity lines — the one bought and the one given off."""
    decisions = [
        {"dataset_key": r["dataset_key"], "dataset": r["dataset"], "index": r["index"],
         "database": "bg", "code": "elec", "confidence": "good"}
        for r in _rows_by_name("Electricity, medium voltage")
    ]
    assert session.decide(decisions) == 2


def _score(client: TestClient, token, code: str) -> float:
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": LIBRARY_DB, "code": code, "method": ["test", "gwp"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return float(r.json()["score"])


# --- stage 1: the reader --------------------------------------------------------------------------


def test_the_reader_says_which_way_a_product_goes(package: Path):
    """The direction was always read; now a product going out is also SAID to be a co-product."""
    dataset = ilcd.read(package).datasets[0]
    electricity = [e for e in dataset.exchanges if e.name == "Electricity, medium voltage"]
    bought = next(e for e in electricity if e.direction == "input")
    sold = next(e for e in electricity if e.direction == "output")
    assert not bought.coproduct
    assert sold.coproduct and sold.kind == "technosphere" and sold.amount == 3.6
    # A waste going out is not a co-product: it is the service of having it treated.
    waste = next(e for e in dataset.exchanges if e.name == "Scrap widgets")
    assert waste.direction == "output" and not waste.coproduct
    # …and the reference product is still the reference, not a co-product of itself.
    assert next(e for e in dataset.exchanges if e.kind == "production").name == "Widget"


def test_a_second_product_from_a_bw2io_reader_is_a_coproduct_too():
    """EcoSpold 1 marks both products `production`; the one that is not the reference is given off
    besides it — the US LCI resin recovers 0.48 MJ of energy."""
    from prism_lca.engine.dataimport import readers

    _fmt, result = readers.read(FIXTURES / "es1-abs-resin.xml")
    dataset = result.datasets[0]
    assert [e.name for e in dataset.exchanges if e.kind == "production"] == [dataset.reference_product]
    recovered = [e for e in dataset.exchanges if e.coproduct]
    assert len(recovered) == 1 and recovered[0].direction == "output"
    assert recovered[0].name.startswith("Recovered energy")


# --- stage 2: the session -------------------------------------------------------------------------


def test_rows_and_state_carry_the_coproduct(world, package: Path):
    session.start(package)
    sold = next(r for r in _rows_by_name("Electricity, medium voltage") if r["direction"] == "output")
    assert sold["coproduct"] is True
    state = session.state()
    assert state["coproducts"] == 1
    assert state["coproducts_as_substitution"] is False  # never the default: it changes results


def test_by_default_a_coproduct_is_not_booked_but_kept_with_the_dataset(world, package: Path):
    session.start(package)
    _match_electricity_rows_to_the_background()
    result = session.commit("default")
    assert result["coproducts"] == 1 and result["substituted"] == 0

    act = get_bd().get_node(database=LIBRARY_DB, code=result["codes"][0])
    # Exactly one electricity exchange: the one bought. Nothing bought for the one sold.
    to_elec = [e for e in act.exchanges() if e.input.key == ("bg", "elec")]
    assert [(e["type"], round(e["amount"], 9)) for e in to_elec] == [("technosphere", 2.0)]
    kept = act.get("prism_coproducts")
    assert kept and kept[0]["name"] == "Electricity, medium voltage"
    assert kept[0]["matched_to"] and "not booked" in kept[0]["reason"]
    # Not an unmatched flow: nothing about it failed to match.
    assert all(p["name"] != "Electricity, medium voltage" for p in act.get("prism_unmatched") or [])


def test_on_request_a_coproduct_is_booked_as_substitution(world, package: Path):
    session.start(package)
    _match_electricity_rows_to_the_background()
    assert session.set_options(coproducts_as_substitution=True)["coproducts_as_substitution"] is True
    result = session.commit("substitution")
    assert result["substituted"] == 1 and result["coproducts"] == 0

    act = get_bd().get_node(database=LIBRARY_DB, code=result["codes"][0])
    by_type = {e["type"]: e for e in act.exchanges() if e.input.key == ("bg", "elec")}
    assert set(by_type) == {"technosphere", "substitution"}
    # Positive amount, converted like any match: 3.6 MJ given off = 1 kWh avoided.
    assert abs(by_type["substitution"]["amount"] - 1.0) < 1e-9
    assert not act.get("prism_coproducts")


def test_an_unbooked_coproduct_raises_no_region_question(world, package: Path):
    """A region choice for a line that will not be written is a question with no consequence."""
    session.start(package)
    live = next(r for r in session._current.rows if r.match.exchange.coproduct)
    live.match.region_open = True
    assert session.state()["region_open"] == 0
    session.set_options(coproducts_as_substitution=True)
    assert session.state()["region_open"] == 1


# --- stage 3: the result --------------------------------------------------------------------------


def test_substitution_credits_the_result_and_not_booking_it_does_not(client: TestClient, token, world, package):
    session.start(package)
    _match_electricity_rows_to_the_background()
    plain = session.commit("plain")["codes"][0]
    assert abs(_score(client, token, plain) - 3.5) < 1e-6

    session.start(package)
    _match_electricity_rows_to_the_background()
    session.set_options(coproducts_as_substitution=True)
    credited = session.commit("credited")["codes"][0]
    assert credited == plain  # the same dataset, replaced
    assert abs(_score(client, token, credited) - 3.0) < 1e-6


def test_the_option_is_a_write_through_endpoint(client: TestClient, token, world, package):
    r = client.post("/api/v1/import/start", json={"path": str(package)}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/import/options", json={"coproducts_as_substitution": True}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["coproducts_as_substitution"] is True
    assert client.get("/api/v1/import/state", headers=token).json()["coproducts_as_substitution"] is True


# --- the sign of the target -----------------------------------------------


@pytest.mark.parametrize("target_sign", [1.0, -1.0], ids=["target-produces", "target-treats"])
@pytest.mark.parametrize("source_sign", [1.0, -1.0], ids=["source-produces", "source-treats"])
def test_substitution_follows_the_sign_of_the_targets_production(
    client: TestClient, token, world, package, target_sign, source_sign
):
    """A substitution runs its target backwards. Against a treatment (production −1) a positive
    amount ran it FORWARDS and added its burden; the amount carries the target's production sign.
    The source's own sign changes nothing: what it gives off, it gives off per unit of reference."""
    bd = get_bd()
    target = bd.Database("bg").new_activity(
        code="tgt", name="the thing the co-product replaces", unit="megajoule", location="DE"
    )
    target.save()
    target.new_edge(input=target, amount=target_sign, type="production").save()
    target.new_edge(input=("biosphere3", "co2-air"), amount=1.0, type="biosphere").save()

    session.start(package)
    session._current.datasets[0].exchanges[0].amount = source_sign  # the reference: produce or treat
    sold = next(r for r in _rows_by_name("Electricity, medium voltage") if r["direction"] == "output")
    assert session.decide([{"dataset_key": sold["dataset_key"], "dataset": sold["dataset"],
                            "index": sold["index"], "database": "bg", "code": "tgt"}]) == 1
    session.set_options(coproducts_as_substitution=True)
    code = session.commit("signed")["codes"][0]

    act = bd.get_node(database=LIBRARY_DB, code=code)
    edge = next(e for e in act.exchanges() if e["type"] == "substitution")
    assert abs(edge["amount"] - 3.6 * target_sign) < 1e-9

    if source_sign > 0:
        # 2.5 kg of its own CO2, 3.6 runs of the target avoided at 1 kg each — for either target.
        assert abs(_score(client, token, code) - (2.5 - 3.6)) < 1e-6


def test_a_target_producing_nothing_is_not_substituted(world, package):
    """A production of 0 was read as +1 and the credit booked anyway."""
    bd = get_bd()
    target = bd.Database("bg").new_activity(code="zero", name="produces nothing", unit="megajoule")
    target.save()
    target.new_edge(input=target, amount=0.0, type="production").save()

    session.start(package)
    sold = next(r for r in _rows_by_name("Electricity, medium voltage") if r["direction"] == "output")
    session.decide([{"dataset_key": sold["dataset_key"], "dataset": sold["dataset"],
                     "index": sold["index"], "database": "bg", "code": "zero"}])
    session.set_options(coproducts_as_substitution=True)
    result = session.commit("zero target")
    assert result["substituted"] == 0 and result["coproducts"] == 1
    act = bd.get_node(database=LIBRARY_DB, code=result["codes"][0])
    assert not [e for e in act.exchanges() if e["type"] == "substitution"]
    assert "reference production of 0" in act["prism_coproducts"][0]["reason"]
