"""Waste outputs of an imported process: a link to their TREATMENT, never a co-product and never a
substitution (a follow-up to the co-product handling).

A process that gives off 0.3 kg of scrap buys the service of having it treated. The import used to
write that as a positive technosphere input — against an ecoinvent cut-off treatment (reference
production −1 kg) the sign is wrong and the treatment ran BACKWARDS as a credit — and EcoSpold 1's
"Waste to treatment" came in as a co-product, so with substitution switched on it was credited
outright. The rule now: amount = |waste| × sign(the target's reference production), kind
``technosphere``, whatever the co-product option says.

Numbers, readable by hand: the ILCD widget emits 2.5 kg CO2 (its electricity stays unmatched and
parked); the treatment emits 1 kg CO2 per kg treated. With 0.3 kg of scrap treated: **2.8**.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism_lca.engine import health
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.dataimport import ilcd, readers, session
from prism_lca.engine.dataimport.matching import PACKAGE_DB
from prism_lca.engine.library import LIBRARY_DB

FIXTURES = Path(__file__).parent / "fixtures" / "import"
WASTE_FLOW = "99999999-9999-9999-9999-999999999999"
SIGN_RULES = {"positive_treatment_input", "reversed_provider_input"}

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
    """The ILCD unit process with a co-product (electricity out) and a waste output (scrap)."""
    root = tmp_path / "ilcd-waste"
    shutil.copytree(FIXTURES / "ilcd-unitprocess", root)
    process = root / "processes" / "11111111-1111-1111-1111-111111111111.xml"
    process.write_text(
        process.read_text(encoding="utf-8").replace("  </exchanges>", _EXTRA_EXCHANGES), encoding="utf-8"
    )
    widget = (root / "flows" / "22222222-2222-2222-2222-222222222222.xml").read_text(encoding="utf-8")
    (root / "flows" / f"{WASTE_FLOW}.xml").write_text(
        widget.replace("22222222-2222-2222-2222-222222222222", WASTE_FLOW)
        .replace(">Widget<", ">Scrap widgets<")
        .replace("Product flow", "Waste flow"),
        encoding="utf-8",
    )
    return root


def _activity(db, code: str, name: str, production: float, co2: float):
    act = db.new_activity(code=code, name=name, unit="kilogram", location="DE", **{"reference product": name})
    act.save()
    act.new_edge(input=act, amount=production, type="production").save()
    act.new_edge(input=("biosphere3", "co2-air"), amount=co2, type="biosphere").save()
    return act


@pytest.fixture
def world(client: TestClient, token, project):
    """biosphere3 with CO2, a GWP method, and two datasets a waste could go to: an ecoinvent-style
    cut-off treatment (production −1 kg) and a SimaPro-style disposal service (production +1 kg).
    Both emit 1 kg CO2 per kg of waste treated — per run for the service, per −1 run for the other."""
    bd = get_bd()
    bd.Database("biosphere3").write(
        {
            ("biosphere3", "co2-air"): {
                "name": "Carbon dioxide, fossil", "unit": "kilogram",
                "categories": ("air",), "type": "emission",
            },
            ("biosphere3", "unused"): {
                "name": "Nothing", "unit": "kilogram", "categories": ("air",), "type": "emission",
            },
        }
    )
    bg = bd.Database("bg")
    bg.register()
    # The treatment's own row: production −1, emission +1 → 1 kg CO2 per run; −0.3 runs 0.3 times.
    _activity(bg, "treat", "treatment of scrap widgets, incineration", -1.0, 1.0)
    _activity(bg, "service", "disposal, scrap widgets, to incineration", 1.0, 1.0)
    _activity(bg, "prod", "scrap widgets, sorted", 1.0, 1.0)
    _activity(bg, "zero", "produces nothing", 0.0, 1.0)
    bd.Method(("test", "gwp")).write([(("biosphere3", "co2-air"), 1.0)])
    yield
    session.cancel()


def _row(name: str) -> dict:
    return next(r for r in session.rows() if r["name"] == name)


def _decide(name: str, database: str, code: str) -> None:
    row = _row(name)
    assert session.decide([{"dataset_key": row["dataset_key"], "dataset": row["dataset"],
                            "index": row["index"], "database": database, "code": code}]) == 1


def _score(client: TestClient, token, code: str) -> float:
    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": LIBRARY_DB, "code": code, "method": ["test", "gwp"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return float(r.json()["score"])


def _edges_to(code: str, target: tuple[str, str]) -> list[tuple[str, float]]:
    act = get_bd().get_node(database=LIBRARY_DB, code=code)
    return [(e["type"], round(e["amount"], 9)) for e in act.exchanges() if e.input.key == target]


# --- the readers: each format says "waste going out" its own way ----------------------------------


def test_ilcd_a_waste_flow_going_out_is_a_waste_not_a_coproduct(package: Path):
    dataset = ilcd.read(package).datasets[0]
    waste = next(e for e in dataset.exchanges if e.name == "Scrap widgets")
    assert waste.waste and not waste.coproduct
    assert (waste.kind, waste.direction, waste.amount) == ("technosphere", "output", 0.3)
    # The product going out is still a co-product, and nothing else is a waste.
    sold = next(e for e in dataset.exchanges if e.name == "Electricity, medium voltage" and e.direction == "output")
    assert sold.coproduct and not sold.waste
    assert [e.name for e in dataset.exchanges if e.waste] == ["Scrap widgets"]


SCRAP = "c1e7a000-0000-4000-8000-0000000000f9"
TREATMENT = "c1e7a000-0000-4000-8000-0000000000c0"


def _jsonld_exchange(internal: int, flow: str, name: str, flow_type: str, amount: float, *, is_input: bool,
                     reference: bool = False, provider: str | None = None) -> dict:
    return {
        "@type": "Exchange", "internalId": internal, "amount": amount, "isInput": is_input,
        **({"isQuantitativeReference": True} if reference else {}),
        "flow": {"@type": "Flow", "@id": flow, "name": name, "flowType": flow_type, "refUnit": "kg"},
        "unit": {"@type": "Unit", "@id": "c1e7a000-0000-4000-8000-000000000011", "name": "kg"},
        "flowProperty": {"@type": "FlowProperty", "@id": "c1e7a000-0000-4000-8000-000000000002", "name": "Mass"},
        **({"defaultProvider": {"@type": "Process", "@id": provider, "name": "scrap treatment"}} if provider else {}),
    }


@pytest.fixture
def jsonld(tmp_path: Path) -> Path:
    """The JSON-LD package, plus: the widget gives off 0.4 kg of scrap (WASTE_FLOW, output) to a
    treatment process of the same package, named as `defaultProvider`; the treatment takes the
    scrap IN as its reference and also takes 0.1 kg of steel-part waste in (a waste INPUT)."""
    root = tmp_path / "jsonld"
    shutil.copytree(FIXTURES / "jsonld-package", root)
    steel_flow = json.loads((root / "flows" / "c1e7a000-0000-4000-8000-0000000000f2.json").read_text())
    scrap_flow = {**steel_flow, "@id": SCRAP, "name": "scrap", "flowType": "WASTE_FLOW"}
    (root / "flows" / f"{SCRAP}.json").write_text(json.dumps(scrap_flow))
    widget_path = root / "processes" / "c1e7a000-0000-4000-8000-0000000000a0.json"
    widget = json.loads(widget_path.read_text())
    widget["exchanges"].append(_jsonld_exchange(4, SCRAP, "scrap", "WASTE_FLOW", 0.4, is_input=False,
                                                provider=TREATMENT))
    widget_path.write_text(json.dumps(widget))
    steel = json.loads((root / "processes" / "c1e7a000-0000-4000-8000-0000000000b0.json").read_text())
    co2 = next(e for e in steel["exchanges"] if e["flow"]["flowType"] == "ELEMENTARY_FLOW")
    treatment = {
        **{k: v for k, v in steel.items() if k != "exchanges"},
        "@id": TREATMENT, "name": "scrap treatment",
        "exchanges": [
            _jsonld_exchange(1, SCRAP, "scrap", "WASTE_FLOW", 1.0, is_input=True, reference=True),
            _jsonld_exchange(2, SCRAP, "scrap", "WASTE_FLOW", 0.1, is_input=True),
            {**co2, "internalId": 3, "amount": 1.0},
        ],
    }
    (root / "processes" / f"{TREATMENT}.json").write_text(json.dumps(treatment))
    return root


def test_jsonld_a_waste_output_is_a_waste_and_keeps_its_named_treatment(jsonld: Path):
    _fmt, result = readers.read(jsonld)
    widget = next(d for d in result.datasets if d.name == "widget assembly")
    scrap = next(e for e in widget.exchanges if e.name == "scrap")
    assert scrap.waste and not scrap.coproduct
    assert (scrap.kind, scrap.direction, scrap.amount) == ("technosphere", "output", 0.4)
    assert scrap.provider == f"{TREATMENT}:{SCRAP}"


def test_jsonld_waste_inputs_are_left_as_they_were(jsonld: Path):
    """(c) A treatment's reference is the waste it takes IN: a NEGATIVE production, as before. A
    further waste input stays an ordinary technosphere input — positive, not flagged."""
    _fmt, result = readers.read(jsonld)
    treatment = next(d for d in result.datasets if d.name == "scrap treatment")
    reference = next(e for e in treatment.exchanges if e.kind == "production")
    assert reference.amount == -1.0 and not reference.waste
    taken_in = next(e for e in treatment.exchanges if e.kind == "technosphere")
    assert (taken_in.direction, taken_in.amount, taken_in.waste, taken_in.coproduct) == ("input", 0.1, False, False)


def test_simapro_waste_to_treatment_is_a_waste(tmp_path: Path):
    source = (FIXTURES / "simapro-inventory.csv").read_text(encoding="latin-1")
    lines = source.splitlines()
    at = lines.index("Waste to treatment")
    lines.insert(at + 1, "Scrap steel {CH}| treatment of scrap steel, inert material landfill | Alloc Rec, U;kg;0.5;Undefined;0;0;0;")
    target = tmp_path / "simapro-waste.csv"
    target.write_text("\n".join(lines) + "\n", encoding="latin-1")
    _fmt, result = readers.read(target)
    dataset = result.datasets[0]
    waste = [e for e in dataset.exchanges if e.waste]
    assert len(waste) == 1 and waste[0].name.startswith("Scrap steel")
    assert (waste[0].kind, waste[0].direction, waste[0].amount, waste[0].coproduct) == (
        "technosphere", "output", 0.5, False,
    )
    # The material bought is still a plain input.
    steel = next(e for e in dataset.exchanges if e.name.startswith("Steel, low-alloyed"))
    assert not steel.waste and steel.direction == "input"


def test_ecospold1_output_group_3_is_a_waste_not_a_coproduct(tmp_path: Path):
    """bw2io reads "Waste to treatment" as a production like the reference; it came in as a
    co-product, and with substitution on it was CREDITED for being treated."""
    source = (FIXTURES / "es1-abs-resin.xml").read_text(encoding="utf-8")
    old = ('name="Dummy_Disposal, solid waste, fuel, to municipal incineration" location="RNA" unit="kg" '
           'meanValue="0.17186">\n\t\t\t\t<inputGroup>5</inputGroup>')
    assert old in source
    target = tmp_path / "es1-waste.xml"
    target.write_text(source.replace(old, old.replace("<inputGroup>5</inputGroup>", "<outputGroup>3</outputGroup>")),
                      encoding="utf-8")
    _fmt, result = readers.read(target)
    dataset = result.datasets[0]
    waste = [e for e in dataset.exchanges if e.waste]
    assert [e.name for e in waste] == ["Dummy_Disposal, solid waste, fuel, to municipal incineration"]
    assert (waste[0].kind, waste[0].direction, waste[0].coproduct) == ("technosphere", "output", False)
    # The recovered energy (output group 2) is still the one co-product.
    assert [e.name for e in dataset.exchanges if e.coproduct][0].startswith("Recovered energy")
    assert len([e for e in dataset.exchanges if e.coproduct]) == 1


def _es2_file(products: str, inputs: str = "") -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
<ecoSpold xmlns="http://www.EcoInvent.org/EcoSpold02"><childActivityDataset>
<activityDescription><activity id="dddddddd-0000-4000-8000-00000000000d" activityNameId="dddddddd-0000-4000-8000-00000000000d" inheritanceDepth="0" type="1" specialActivityType="0">
<activityName xml:lang="en">casting</activityName></activity>
<geography><shortname xml:lang="en">DE</shortname></geography><technology technologyLevel="3"/>
<timePeriod startDate="2026-01-01" endDate="2026-12-31" isDataValidForEntirePeriod="true"/></activityDescription>
<flowData>{products}{inputs}</flowData>
<administrativeInformation><dataEntryBy personId="p" personName="f" personEmail="f@example.org"/>
<dataGeneratorAndPublication personId="p" personName="f" personEmail="f@example.org"/></administrativeInformation>
</childActivityDataset></ecoSpold>"""


def _es2_exchange(ident: str, name: str, amount: float, group: str, classification: str = "") -> str:
    cls = (
        '<classification classificationId="00000000-0000-0000-0000-0000000000cc">'
        '<classificationSystem xml:lang="en">By-product classification</classificationSystem>'
        f'<classificationValue xml:lang="en">{classification}</classificationValue></classification>'
        if classification else ""
    )
    return (f'<intermediateExchange id="x-{ident}" amount="{amount}" intermediateExchangeId="dddddddd-0000-4000-8000-0000000000{ident}">'
            f'<name xml:lang="en">{name}</name><unitName xml:lang="en">kg</unitName>{cls}{group}</intermediateExchange>')


def test_ecospold2_a_waste_needs_more_than_a_negative_sign(tmp_path: Path):
    """EcoSpold 2 writes a waste as a NEGATIVE input — but a negative correction on a producer looks
    the same. A waste is a negative input CLASSIFIED as waste (or linked to a treatment
    of the package, see the package test), or a by-product classified as waste. A bare negative input
    keeps its sign and is flagged for the reviewer."""
    target = tmp_path / "casting.spold"
    target.write_text(_es2_file(
        _es2_exchange("01", "casting", 1, "<outputGroup>0</outputGroup>")
        + _es2_exchange("02", "slag", 0.1, "<outputGroup>2</outputGroup>", classification="waste")
        + _es2_exchange("03", "offcuts", 0.2, "<outputGroup>2</outputGroup>", classification="allocatable product"),
        _es2_exchange("04", "waste mineral oil", -0.05, "<inputGroup>5</inputGroup>", classification="waste")
        + _es2_exchange("05", "steel", 1.2, "<inputGroup>5</inputGroup>")
        + _es2_exchange("06", "steel returned", -0.3, "<inputGroup>5</inputGroup>"),
    ), encoding="utf-8")
    _fmt, result = readers.read(target)
    dataset = result.datasets[0]
    by_name = {e.name: e for e in dataset.exchanges}
    assert by_name["casting"].kind == "production"
    for name in ("slag", "waste mineral oil"):
        assert by_name[name].waste and not by_name[name].coproduct, name
        assert (by_name[name].kind, by_name[name].direction) == ("technosphere", "output"), name
        assert not by_name[name].sign_review, name
    assert by_name["offcuts"].coproduct and not by_name["offcuts"].waste
    assert not by_name["steel"].waste and not by_name["steel"].sign_review
    returned = by_name["steel returned"]
    assert (returned.kind, returned.direction, returned.amount) == ("technosphere", "input", -0.3)
    assert returned.sign_review and not returned.waste


def test_ecospold2_a_bare_negative_input_is_booked_as_written_and_flagged(world, tmp_path: Path):
    """The credit on a producer stays a credit: −0.3 against a +1 supplier, not +0.3."""
    target = tmp_path / "casting.spold"
    target.write_text(_es2_file(
        _es2_exchange("01", "casting", 1, "<outputGroup>0</outputGroup>"),
        _es2_exchange("06", "scrap widgets returned", -0.3, "<inputGroup>5</inputGroup>"),
    ), encoding="utf-8")
    session.start(target)
    row = _row("scrap widgets returned")
    assert row["sign_review"] is True and row["waste"] is False
    assert session.state()["sign_review"] == 1
    _decide("scrap widgets returned", "bg", "prod")
    code = session.commit("credit")["codes"][0]
    assert _edges_to(code, ("bg", "prod")) == [("technosphere", -0.3)]


# --- the commit: the sign is the treatment's ------------------------------------------------------


@pytest.mark.parametrize(
    ("target", "expected"),
    [("treat", -0.3), ("service", 0.3)],
    ids=["cut-off-treatment-minus-1", "service-plus-1"],
)
def test_a_waste_output_is_booked_with_the_sign_of_its_treatment(
    client: TestClient, token, world, package, target, expected
):
    session.start(package)
    _decide("Scrap widgets", "bg", target)
    result = session.commit("waste")
    code = result["codes"][0]
    assert result["waste_treated"] == 1 and result["substituted"] == 0
    assert _edges_to(code, ("bg", target)) == [("technosphere", expected)]
    # Either way the treatment runs forwards: 2.5 of its own + 0.3 kg treated at 1 kg CO2 each.
    assert abs(_score(client, token, code) - 2.8) < 1e-6


def test_the_result_rises_with_the_waste_it_does_not_fall(client: TestClient, token, world, package):
    """The old booking (+0.3 against the −1 treatment) ran the treatment backwards: 2.5 − 0.3."""
    session.start(package)
    unbooked = session.commit("without the waste")["codes"][0]
    base = _score(client, token, unbooked)
    assert abs(base - 2.5) < 1e-6

    session.start(package)
    _decide("Scrap widgets", "bg", "treat")
    code = session.commit("with the waste")["codes"][0]
    assert code == unbooked
    assert _score(client, token, code) > base


def test_with_substitution_on_a_waste_is_still_a_treatment_and_not_a_coproduct(world, package):
    session.start(package)
    _decide("Scrap widgets", "bg", "treat")
    session.set_options(coproducts_as_substitution=True)
    assert session.state()["coproducts"] == 1  # the electricity only
    result = session.commit("substitution on")
    code = result["codes"][0]
    assert _edges_to(code, ("bg", "treat")) == [("technosphere", -0.3)]
    act = get_bd().get_node(database=LIBRARY_DB, code=code)
    assert not [e for e in act.exchanges() if e["type"] == "substitution" and e.input.key == ("bg", "treat")]
    assert all(c["name"] != "Scrap widgets" for c in act.get("prism_coproducts") or [])


def test_an_unmatched_waste_is_parked_with_its_reason(world, package):
    session.start(package)
    result = session.commit("unmatched")
    act = get_bd().get_node(database=LIBRARY_DB, code=result["codes"][0])
    parked = next(p for p in act["prism_unmatched"] if p["name"] == "Scrap widgets")
    assert parked["waste"] is True and parked["reason"].startswith("waste output — no treatment matched")
    assert not act.get("prism_coproducts") or all(c["name"] != "Scrap widgets" for c in act["prism_coproducts"])


def test_a_waste_on_a_target_producing_nothing_is_parked_not_guessed(world, package):
    session.start(package)
    _decide("Scrap widgets", "bg", "zero")
    result = session.commit("zero target")
    act = get_bd().get_node(database=LIBRARY_DB, code=result["codes"][0])
    assert result["waste_treated"] == 0
    assert not _edges_to(result["codes"][0], ("bg", "zero"))
    parked = next(p for p in act["prism_unmatched"] if p["name"] == "Scrap widgets")
    assert "reference production of 0" in parked["reason"]


@pytest.mark.parametrize("target", ["treat", "service"])
def test_the_health_check_sign_rule_passes_the_imported_waste(world, package, target):
    session.start(package)
    _decide("Scrap widgets", "bg", target)
    code = session.commit("lint")["codes"][0]

    def sign_findings() -> list[dict]:
        return [
            f for f in health.lint_database(LIBRARY_DB)["findings"]
            if f["code"] in SIGN_RULES and (f.get("activity") or {}).get("code") == code
        ]

    assert sign_findings() == []
    # The counter-check: the booking the import used to write IS caught by this very rule, so the
    # empty list above is the rule passing, not the rule not running.
    if target == "treat":
        act = get_bd().get_node(database=LIBRARY_DB, code=code)
        act.new_edge(input=("bg", "treat"), amount=0.3, type="technosphere").save()
        assert [f["code"] for f in sign_findings()] == ["positive_treatment_input"]


# --- the review rows ------------------------------------------------------------------------------


def _fake_search(query: str, database: str, limit: int) -> list[dict]:
    """A producer ranked first, the treatment second — the search knows names, not signs."""
    return [
        {"database": "bg", "code": "prod", "name": "scrap widgets, sorted", "unit": "kilogram",
         "product": "scrap widgets, sorted", "geography": "DE"},
        {"database": "bg", "code": "treat", "name": "treatment of scrap widgets, incineration",
         "unit": "kilogram", "product": "scrap widgets", "geography": "DE"},
    ]


def test_a_waste_row_says_so_and_puts_the_treatment_first(world, package):
    session.start(package, search=_fake_search, background="bg")
    row = _row("Scrap widgets")
    assert row["waste"] is True and row["coproduct"] is False
    assert [(c["code"], c["treatment"]) for c in row["candidates"]] == [("treat", True), ("prod", False)]
    # A row that is not a waste keeps the search's order and is not looked at.
    other = next(r for r in session.rows() if r["name"] == "Electricity, medium voltage" and r["direction"] == "input")
    assert other["waste"] is False
    assert [c["code"] for c in other["candidates"]] == ["prod", "treat"]
    assert all(c["treatment"] is None for c in other["candidates"])
    assert session.state()["waste"] == 1

    _decide("Scrap widgets", "bg", "treat")
    row = _row("Scrap widgets")
    # The amount the table shows is the amount the commit writes.
    assert row["target"]["treatment"] is True and abs(row["scaled_amount"] + 0.3) < 1e-9


def test_a_hand_picked_target_is_flagged_too(world, package):
    session.start(package)
    _decide("Scrap widgets", "bg", "service")
    row = _row("Scrap widgets")
    assert row["target"]["treatment"] is False and abs(row["scaled_amount"] - 0.3) < 1e-9
    found = session.candidates("scrap", "technosphere", search=_fake_search, background="bg")
    assert {c["code"]: c["treatment"] for c in found} == {"prod": False, "treat": True}


# --- a treatment delivered in the same package ----------------------------------------------------


ES2 = FIXTURES / "es2-package"
CO2 = "00000000-0000-0000-0000-00000000c002"


@pytest.fixture
def es2_with_treatment(tmp_path: Path) -> Path:
    """The EcoSpold 2 package, plus a treatment of scrap (reference −1 kg, 0.5 kg CO2 per kg) and
    0.4 kg of scrap given off by the widget as a negative input naming that treatment."""
    root = tmp_path / "es2"
    shutil.copytree(ES2, root)
    steel = (root / "steel-part-production.spold").read_text(encoding="utf-8")
    (root / "scrap-treatment.spold").write_text(
        steel.replace("bbbbbbbb-0000-4000-8000-00000000000b", "cccccccc-0000-4000-8000-00000000000c")
        .replace("bbbbbbbb-0000-4000-8000-0000000000f1", "cccccccc-0000-4000-8000-0000000000f1")
        .replace("steel part production", "treatment of scrap")
        .replace(">steel part<", ">scrap<")
        .replace('amount="1" intermediateExchangeId', 'amount="-1" intermediateExchangeId')
        .replace('amount="1.5"', 'amount="0.5"'),
        encoding="utf-8",
    )
    widget = root / "widget-assembly.spold"
    widget.write_text(
        widget.read_text(encoding="utf-8").replace(
            "</flowData>",
            '<intermediateExchange id="w-scrap" amount="-0.4" intermediateExchangeId="cccccccc-0000-4000-8000-0000000000f1" '
            'activityLinkId="cccccccc-0000-4000-8000-00000000000c"><name xml:lang="en">scrap</name>'
            '<unitName xml:lang="en">kg</unitName><inputGroup>5</inputGroup></intermediateExchange></flowData>',
        ),
        encoding="utf-8",
    )
    return root


@pytest.fixture
def es2_world(client: TestClient, token, project):
    bd = get_bd()
    bd.Database("biosphere3").write(
        {
            ("biosphere3", CO2): {
                "name": "Carbon dioxide, fossil", "unit": "kilogram",
                "categories": ("air",), "type": "emission",
            },
        }
    )
    bd.Method(("test", "gwp")).write([(("biosphere3", CO2), 1.0)])
    yield
    session.cancel()


def test_a_package_treatment_takes_the_sign_of_its_own_reference(
    client: TestClient, token, es2_world, es2_with_treatment
):
    """Widget 0.1 + 2 × 1.5 (steel) = 3.1 as in test_import_package_links; 0.4 kg of scrap treated
    at 0.5 kg CO2 adds 0.2 → 3.3."""
    session.start(es2_with_treatment)
    row = _row("scrap")
    assert row["waste"] is True
    assert row["target"]["package"] is True and row["target"]["treatment"] is True
    assert row["candidates"][0]["database"] == PACKAGE_DB
    result = session.commit("package treatment")
    assert result["waste_treated"] == 1
    widget = "widget-assembly.spold"
    assert _edges_to(widget, (LIBRARY_DB, "scrap-treatment.spold")) == [("technosphere", -0.4)]
    treatment = get_bd().get_node(database=LIBRARY_DB, code="scrap-treatment.spold")
    assert [e["amount"] for e in treatment.production()] == [-1.0]
    assert abs(_score(client, token, widget) - 3.3) < 1e-6
    findings = [f for f in health.lint_database(LIBRARY_DB)["findings"] if f["code"] in SIGN_RULES]
    assert findings == []


def test_a_jsonld_waste_follows_its_default_provider_to_the_treatment(es2_world, jsonld):
    session.start(jsonld)
    row = _row("scrap")
    assert row["waste"] is True and row["target"]["package"] is True
    assert row["target"]["code"] == next(d.key for d in session._current.datasets if d.name == "scrap treatment")
    result = session.commit("jsonld treatment")
    widget = next(c for c in result["codes"] if get_bd().get_node(database=LIBRARY_DB, code=c)["name"] == "widget assembly")
    treatment = next(c for c in result["codes"] if get_bd().get_node(database=LIBRARY_DB, code=c)["name"] == "scrap treatment")
    assert _edges_to(widget, (LIBRARY_DB, treatment)) == [("technosphere", -0.4)]


# --- a target replaced in the same import ------------------------------------------


def _treatment_file(root: Path, sign: str) -> None:
    steel = (ES2 / "steel-part-production.spold").read_text(encoding="utf-8")
    (root / "scrap-treatment.spold").write_text(
        steel.replace("bbbbbbbb-0000-4000-8000-00000000000b", "cccccccc-0000-4000-8000-00000000000c")
        .replace("bbbbbbbb-0000-4000-8000-0000000000f1", "cccccccc-0000-4000-8000-0000000000f1")
        .replace("steel part production", "treatment of scrap")
        .replace(">steel part<", ">scrap<")
        .replace('amount="1" intermediateExchangeId', f'amount="{sign}1" intermediateExchangeId')
        .replace('amount="1.5"', 'amount="0.5"'),
        encoding="utf-8",
    )


@pytest.mark.parametrize("treatment_first", [True, False], ids=["treatment-first", "source-first"])
@pytest.mark.parametrize("where", ["library", "package"])
def test_the_sign_is_the_one_the_import_leaves_the_target_with(
    es2_world, es2_with_treatment, tmp_path, treatment_first, where
):
    """The treatment was imported earlier as +1 and comes again, now −1, in the same import as the
    waste that goes to it. Whichever of the two is written first, the waste takes the NEW sign."""
    earlier = tmp_path / "earlier"
    earlier.mkdir()
    _treatment_file(earlier, "")
    session.start(earlier)
    library_code = session.commit("the treatment, +1")["codes"][0]
    assert _reference_sign_in_library(library_code) == 1.0

    session.start(es2_with_treatment)
    datasets = session._current.datasets
    datasets.sort(key=lambda d: (d.name != "treatment of scrap") if treatment_first else (d.name == "treatment of scrap"))
    if where == "library":
        _decide("scrap", LIBRARY_DB, library_code)
        # The row shows what the commit will write — the replacement's sign, not today's +1.
        row = _row("scrap")
        assert row["target"]["treatment"] is True and abs(row["scaled_amount"] + 0.4) < 1e-9
    else:
        assert _row("scrap")["target"]["package"] is True
    result = session.commit("again, −1")
    assert result["replaced"] == 1
    assert _reference_sign_in_library(library_code) == -1.0
    widget = next(c for c in result["codes"] if c.startswith("widget"))
    assert _edges_to(widget, (LIBRARY_DB, library_code)) == [("technosphere", -0.4)]


def _reference_sign_in_library(code: str) -> float:
    node = get_bd().get_node(database=LIBRARY_DB, code=code)
    return float(next(iter(node.production()))["amount"])


# --- drop does not drop a waste ----------------------------------------------------


def test_with_drop_an_unmatched_waste_is_still_parked(world, package):
    session.start(package)
    result = session.commit("drop", unmatched=session.Unmatched.drop)
    act = get_bd().get_node(database=LIBRARY_DB, code=result["codes"][0])
    parked = act.get("prism_unmatched") or []
    # The unmatched electricity is dropped as asked; the waste is not — its burden would vanish.
    assert [p["name"] for p in parked] == ["Scrap widgets"]
    assert parked[0]["waste"] is True
    assert result["unmatched"] == 1


# --- further regressions --------------------------------------------------------------------------


def test_a_flagged_negative_input_on_a_target_producing_nothing_is_parked(world, tmp_path: Path):
    target = tmp_path / "casting.spold"
    target.write_text(_es2_file(
        _es2_exchange("01", "casting", 1, "<outputGroup>0</outputGroup>"),
        _es2_exchange("06", "scrap widgets returned", -0.4, "<inputGroup>5</inputGroup>"),
    ), encoding="utf-8")
    session.start(target)
    _decide("scrap widgets returned", "bg", "zero")
    result = session.commit("zero", unmatched=session.Unmatched.drop)
    code = result["codes"][0]
    assert _edges_to(code, ("bg", "zero")) == []
    parked = get_bd().get_node(database=LIBRARY_DB, code=code)["prism_unmatched"]
    assert [(p["name"], p.get("sign_review")) for p in parked] == [("scrap widgets returned", True)]
    assert "reference production of 0" in parked[0]["reason"]


@pytest.mark.parametrize("coal_first", [True, False], ids=["coal-first", "gas-first"])
def test_two_incoming_datasets_reaching_one_old_identity_replace_nothing(es2_world, es2_with_treatment, coal_first):
    """`1|coal|scrap` and `1|gas|scrap` both reach an old import's `1|scrap`. The first took it and
    the second came in new, by file order; now neither replaces it and both are reported."""
    from prism_lca.engine.library import ensure_library

    ensure_library()
    old = get_bd().Database(LIBRARY_DB).new_activity(
        code="old-scrap", name="treatment of scrap", unit="kilogram", prism_import_identity="1|scrap"
    )
    old.save()
    old.new_edge(input=old, amount=1.0, type="production").save()

    session.start(es2_with_treatment)
    datasets = session._current.datasets
    coal = next(d for d in datasets if d.name == "treatment of scrap")
    gas = next(d for d in datasets if d.name == "steel part production")
    coal.identity, gas.identity = "1|coal|scrap", "1|gas|scrap"
    datasets.sort(key=lambda d: (d is not coal) if coal_first else (d is not gas))
    result = session.commit("contested")
    assert result["replaced"] == 0
    assert sorted(result["ambiguous"]) == ["steel part production", "treatment of scrap"]
    assert "old-scrap" not in result["codes"]
    assert get_bd().get_node(database=LIBRARY_DB, code="old-scrap")["name"] == "treatment of scrap"


def test_a_decision_by_a_shared_name_is_refused_and_the_key_decides(client: TestClient, token, es2_world):
    """Two datasets of one name, one exchange index: by name alone, both decisions landed on the
    last row. Now a name-only decision is refused; with the key each lands on its own row."""
    from prism_lca.errors import PrismError

    session.start(ES2)
    rows = [r for r in session._current.rows if r.match.exchange.kind == "biosphere"]
    assert len({r.dataset_key for r in rows}) == 2
    for r in rows:
        r.dataset, r.index = "same name", 99
    first, second = rows
    with pytest.raises(PrismError) as refused:
        session.decide([{"dataset": "same name", "index": 99, "code": ""}])
    assert refused.value.code == "import_dataset_ambiguous"
    r = client.post("/api/v1/import/decide", json={"decisions": [{"dataset": "same name", "index": 99}]}, headers=token)
    assert r.status_code == 422 and "import_dataset_ambiguous" in r.text

    assert first.match.target is not None and second.match.target is not None
    applied = session.decide([
        {"dataset": "same name", "dataset_key": first.dataset_key, "index": 99,
         "database": first.match.target.database, "code": first.match.target.code, "confidence": "good"},
        {"dataset": "same name", "dataset_key": second.dataset_key, "index": 99, "code": ""},
    ])
    assert applied == 2
    assert first.match.target is not None and second.match.target is None
