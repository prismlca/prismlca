"""Suppliers delivered in the same package are linked to, not searched for.

An EcoSpold 2 package can hold a process AND its supplier, and say so: ``activityLinkId`` on the
input names the supplying activity, the input's own flow names the product. PrismLCA searched the
background for every input anyway, so a delivered supply chain came out bound to ecoinvent proxies —
or parked. ``fixtures/import/es2-package`` is the smallest such package: *widget assembly* buys 2 kg
of *steel part* from *steel part production*, which is in the same folder.

GWP numbers for the check at the end: widget 0.1 kg CO2 + 2 × 1.5 kg (steel) = **3.1**.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.dataimport import readers, session
from prism_lca.engine.dataimport.matching import PACKAGE_DB
from prism_lca.engine.library import LIBRARY_DB, ensure_library

FIXTURES = Path(__file__).parent / "fixtures" / "import"
PACKAGE = FIXTURES / "es2-package"
CO2 = "00000000-0000-0000-0000-00000000c002"  # the fixture's elementary flow UUID
SUPPLIER = "steel-part-production.spold"


@pytest.fixture
def world(client: TestClient, token, project):
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


def _steel_row() -> dict:
    return next(r for r in session.rows() if r["name"] == "steel part")


def test_the_reader_keeps_the_link_the_source_wrote():
    _fmt, result = readers.read(PACKAGE)
    by_key = {d.key: d for d in result.datasets}
    supplier, consumer = by_key[SUPPLIER], by_key["widget-assembly.spold"]
    steel = next(e for e in consumer.exchanges if e.name == "steel part")
    assert steel.provider and steel.provider in supplier.provides


def test_a_supplier_in_the_package_is_matched_to_the_package(world):
    session.start(PACKAGE)
    row = _steel_row()
    assert row["target"]["database"] == PACKAGE_DB and row["target"]["code"] == SUPPLIER
    assert row["target"]["package"] is True
    assert row["confidence"] == "good"
    assert "this package" in row["evidence"]
    assert not row["region_open"]
    assert session.state()["from_package"] == 1


def test_commit_points_the_input_at_the_imported_supplier(client: TestClient, token, world):
    session.start(PACKAGE)
    result = session.commit("a package")
    assert result["datasets"] == 2
    widget = get_bd().get_node(database=LIBRARY_DB, code="widget-assembly.spold")
    steel = [e for e in widget.technosphere()]
    assert [(e.input.key, e["amount"]) for e in steel] == [((LIBRARY_DB, SUPPLIER), 2.0)]

    r = client.post(
        "/api/v1/calc/lcia",
        json={"database": LIBRARY_DB, "code": "widget-assembly.spold", "method": ["test", "gwp"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(r.json()["score"] - 3.1) < 1e-6


def test_the_link_follows_the_supplier_to_its_suffixed_code(world):
    """A key taken by another dataset of the library gets a suffix at commit — the input has to
    point at the code the supplier was actually written under, not at the key it had in the file."""
    ensure_library()
    squatter = get_bd().Database(LIBRARY_DB).new_activity(code=SUPPLIER, name="something else", unit="kg")
    squatter.save()

    session.start(PACKAGE)
    result = session.commit("collision")
    assert f"{SUPPLIER}-2" in result["codes"]
    widget = get_bd().get_node(database=LIBRARY_DB, code="widget-assembly.spold")
    assert [e.input.key for e in widget.technosphere()] == [(LIBRARY_DB, f"{SUPPLIER}-2")]
    assert get_bd().get_node(database=LIBRARY_DB, code=SUPPLIER)["name"] == "something else"


def test_the_reviewer_can_undo_and_redo_a_package_match(world):
    session.start(PACKAGE)
    row = _steel_row()
    assert session.decide([{"dataset_key": row["dataset_key"], "dataset": row["dataset"],
                            "index": row["index"], "code": None}]) == 1
    assert _steel_row()["target"] is None
    assert session.decide([{"dataset_key": row["dataset_key"], "dataset": row["dataset"],
                            "index": row["index"], "database": PACKAGE_DB, "code": SUPPLIER}]) == 1
    assert _steel_row()["target"]["code"] == SUPPLIER
    result = session.commit("redone")
    widget = get_bd().get_node(database=LIBRARY_DB, code="widget-assembly.spold")
    assert [e.input.key for e in widget.technosphere()] == [(LIBRARY_DB, SUPPLIER)]
    assert result["datasets"] == 2


# --- ILCD: no process links in the format, but the flow identifier says it -------------------------

_ELECTRICITY_PROCESS = """<?xml version="1.0" encoding="utf-8"?>
<processDataSet xmlns="http://lca.jrc.it/ILCD/Process" xmlns:common="http://lca.jrc.it/ILCD/Common" version="1.1">
  <processInformation>
    <dataSetInformation>
      <common:UUID>{uuid}</common:UUID>
      <name><baseName xml:lang="en">{name}</baseName></name>
    </dataSetInformation>
    <quantitativeReference type="Reference flow(s)"><referenceToReferenceFlow>0</referenceToReferenceFlow></quantitativeReference>
    <geography><locationOfOperationSupplyOrProduction location="DE"/></geography>
  </processInformation>
  <modellingAndValidation>
    <LCIMethodAndAllocation><typeOfDataSet>Unit process, single operation</typeOfDataSet></LCIMethodAndAllocation>
  </modellingAndValidation>
  <exchanges>
    <exchange dataSetInternalID="0">
      <referenceToFlowDataSet type="flow data set" refObjectId="44444444-4444-4444-4444-444444444444"/>
      <exchangeDirection>Output</exchangeDirection>
      <meanAmount>1.0</meanAmount>
    </exchange>
  </exchanges>
</processDataSet>
"""


def _ilcd_with_producers(tmp_path: Path, count: int) -> Path:
    root = tmp_path / f"ilcd-{count}"
    shutil.copytree(FIXTURES / "ilcd-unitprocess", root)
    for n in range(count):
        uuid = f"eeeeeeee-0000-4000-8000-00000000000{n}"
        (root / "processes" / f"{uuid}.xml").write_text(
            _ELECTRICITY_PROCESS.format(uuid=uuid, name=f"Electricity from plant {n}"), encoding="utf-8"
        )
    return root


def _electricity_row() -> dict:
    return next(
        r for r in session.rows() if r["name"] == "Electricity, medium voltage" and r["dataset"].startswith("Widget")
    )


def test_an_ilcd_package_links_to_the_only_producer_of_a_flow(world, tmp_path):
    session.start(_ilcd_with_producers(tmp_path, 1))
    row = _electricity_row()
    assert row["target"] and row["target"]["database"] == PACKAGE_DB
    assert row["target"]["code"] == "eeeeeeee-0000-4000-8000-000000000000"
    assert "same flow identifier" in row["evidence"]


def test_two_producers_of_one_flow_are_the_reviewers_choice(world, tmp_path):
    session.start(_ilcd_with_producers(tmp_path, 2))
    assert _electricity_row()["target"] is None


# --- JSON-LD: `defaultProvider` is the same link under another name --------------------------------


def test_a_json_ld_default_provider_links_like_an_activity_link(world):
    session.start(FIXTURES / "jsonld-package")
    row = _steel_row()
    assert row["target"]["database"] == PACKAGE_DB
    assert row["target"]["code"] == "c1e7a000-0000-4000-8000-0000000000b0"
    session.commit("json-ld")
    widget = get_bd().get_node(database=LIBRARY_DB, code="c1e7a000-0000-4000-8000-0000000000a0")
    assert [e.input.key for e in widget.technosphere()] == [(LIBRARY_DB, "c1e7a000-0000-4000-8000-0000000000b0")]
