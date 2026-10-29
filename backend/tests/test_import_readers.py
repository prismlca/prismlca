"""Every format lands in the same shape — and a file that cannot be read says why."""

from __future__ import annotations

from pathlib import Path

import pytest

from prism_lca.engine.dataimport import readers
from prism_lca.engine.dataimport.detect import SourceFormat
from prism_lca.errors import PrismError

FIXTURES = Path(__file__).parent / "fixtures" / "import"


@pytest.mark.parametrize(
    ("filename", "fmt", "min_exchanges"),
    [
        ("es1-abs-resin.xml", SourceFormat.ecospold1, 200),
        ("es2-sample.spold", SourceFormat.ecospold2, 1),
        ("simapro-inventory.csv", SourceFormat.simapro_csv, 1),
        ("simapro-allocation.csv", SourceFormat.simapro_csv, 1),
        ("ilcd-unitprocess", SourceFormat.ilcd, 3),
        ("es2-package", SourceFormat.ecospold2, 2),
        ("jsonld-package", SourceFormat.json_ld, 2),
    ],
)
def test_four_formats_one_shape(filename: str, fmt: SourceFormat, min_exchanges: int):
    """Everything downstream — matching, units, compartments, the review table — works on one
    intermediate. If the shape leaked the format, each of those steps would grow five branches."""
    found, result = readers.read(FIXTURES / filename)
    assert found is fmt
    assert result.datasets
    dataset = result.datasets[0]
    assert dataset.name
    assert len(dataset.exchanges) >= min_exchanges
    for exchange in dataset.exchanges:
        assert exchange.kind in {"production", "technosphere", "biosphere", "unknown"}
        assert exchange.direction in {"input", "output"}


def test_an_ecospold1_export_carries_its_flows_by_name_only():
    """The case the matcher exists for: EcoSpold 1 identifies a flow by name, not by UUID. 224 of
    the 230 exchanges here are elementary flows with no identifier of any kind."""
    _fmt, result = readers.read(FIXTURES / "es1-abs-resin.xml")
    summary = result.summary()
    assert summary["biosphere"] > 200
    flows = [e for e in result.datasets[0].exchanges if e.kind == "biosphere"]
    assert all(e.uuid is None for e in flows)
    assert all(e.name for e in flows)


def test_a_structural_schema_fault_is_repaired_and_says_so():
    """A real-world EcoSpold 1 file with no `<geography>` at all (US LCI does this). The validating
    parser refused the whole file for it — a structural quibble between the user and a perfectly
    readable inventory. PrismLCA repairs the structure, reads it, and says so; the missing geography
    honestly reads as "no region stated", which downstream makes the region the reviewer's call."""
    fmt, result = readers.read(FIXTURES / "es1-aluminium-extrusion.xml")
    assert fmt is SourceFormat.ecospold1
    assert result.datasets and result.datasets[0].exchanges
    assert result.datasets[0].location == ""
    assert any("repaired the structure" in note for note in result.notes)


def test_a_file_broken_in_substance_keeps_its_real_error(tmp_path: Path):
    """The repair covers structure, nothing else — half an XML is not readable and must say why."""
    broken = tmp_path / "half.xml"
    broken.write_text(
        '<?xml version="1.0"?>\n<ecoSpold xmlns="http://www.EcoInvent.org/EcoSpold01"><dataset>',
        encoding="utf-8",
    )
    with pytest.raises(PrismError) as caught:
        readers.read(broken)
    assert caught.value.code in ("import_unreadable", "import_unknown_format")


def test_a_file_prism_does_not_read_is_refused_by_name(tmp_path: Path):
    (tmp_path / "model.gabi").write_text("whatever", encoding="utf-8")
    with pytest.raises(PrismError) as caught:
        readers.read(tmp_path / "model.gabi")
    assert caught.value.code == "import_unknown_format"


def test_a_simapro_process_still_gets_a_name():
    """SimaPro CSV carries no `name` field at all (measured): bw2io gives a code, a metadata block
    and the exchanges. An unnamed row is what makes the review table unusable, so the fallback runs
    down to the production exchange and then to the identifier."""
    _fmt, result = readers.read(FIXTURES / "simapro-inventory.csv")
    assert result.datasets[0].name
    assert result.datasets[0].name != "unnamed dataset"


def test_a_method_export_says_what_it_is(tmp_path):
    """A SimaPro *method* export ran all the way into bw2io before dying on "Can't understand
    metadata", which tells nobody that they exported the wrong thing. SimaPro says it itself on
    line two: `{methods}` where a process export writes `{processes}`."""
    method = tmp_path / "impact-method.csv"
    method.write_text(
        "{SimaPro 8.5.0.0};;;;\n{methods};;;;\n{Date: 2019-05-15};;;;\n"
        "{CSV separator: Semicolon};;;;\n\nMethod;;;;\nImpact category;;;;\n",
        encoding="latin-1",
    )
    with pytest.raises(PrismError) as caught:
        readers.read(method)
    assert caught.value.code == "simapro_method_export"
    assert "not an inventory" in str(caught.value)


def test_the_delimiter_comes_from_the_file_and_not_from_a_default(tmp_path):
    """bw2io defaults to ';'. A tab-separated export therefore failed with an empty error message —
    the file states its own separator, and now we read it."""
    from prism_lca.engine.dataimport.readers import _simapro_flavour

    tabbed = tmp_path / "tabbed.csv"
    tabbed.write_text("{SimaPro 8.0}\n{processes}\n{CSV separator: Tab}\n", encoding="latin-1")
    assert _simapro_flavour(tabbed) == ("\t", "processes")

    unbraced = tmp_path / "unbraced.txt"
    unbraced.write_text("SimaPro don't even know\tprocesses\tDate:\t29.08.2013\n", encoding="latin-1")
    assert _simapro_flavour(unbraced) == ("\t", "processes")

    semicolon = tmp_path / "plain.csv"
    semicolon.write_text("{SimaPro 8.0}\n{processes}\n", encoding="latin-1")
    assert _simapro_flavour(semicolon)[0] == ";"


def test_a_single_spold_file_does_not_pull_in_its_neighbours(tmp_path: Path):
    """The importer walks a directory, and one file was read from its parent —
    every other dataset there came along."""
    import shutil

    release = tmp_path / "release"
    release.mkdir()
    shutil.copy(FIXTURES / "es2-sample.spold", release / "a.spold")
    shutil.copy(FIXTURES / "es2-sample.spold", release / "b.spold")
    _fmt, result = readers.read(release / "a.spold")
    assert len(result.datasets) == 1


def test_the_ecospold1_repair_leaves_no_descriptor_open():
    """Mkstemp hands the descriptor over open, and only the path was kept."""
    import os

    before = len(os.listdir("/proc/self/fd"))
    repaired = readers._repaired_ecospold1(FIXTURES / "es1-aluminium-extrusion.xml")
    assert repaired is not None, "the fixture is the one the repair test relies on"
    repaired.unlink()
    assert len(os.listdir("/proc/self/fd")) == before


# --- the shape strategies ------------------------------------------------------


def test_units_arrive_in_one_spelling():
    """bw2io's `normalize_units` runs now: "kg" is "kilogram" in every format, the spelling our
    biosphere and ecoinvent use — so a flow in "m2a" meets ecoinvent's "square meter-year" as the
    same unit instead of two strings nobody converts."""
    for fixture in ("es1-abs-resin.xml", "es2-sample.spold", "simapro-allocation.csv"):
        _fmt, result = readers.read(FIXTURES / fixture)
        units = {e.unit for d in result.datasets for e in d.exchanges}
        assert "kg" not in units and "kilogram" in units, (fixture, units)


def _simapro_rice_with_emission(tmp_path: Path) -> Path:
    """The allocation fixture, with 100 kg CO2 given to the rice process (6250 kg rice at 95.8 %,
    3125 kg straw at 4.2 %) — the fixture itself books nothing to allocate."""
    lines = (FIXTURES / "simapro-allocation.csv").read_text(encoding="latin-1").splitlines()
    products = next(i for i, line in enumerate(lines) if line.startswith("Rice, at farm (WFLDB 3.0)/IN U;kg;6250"))
    emissions = next(i for i in range(products, len(lines)) if lines[i] == "Emissions to air")
    lines.insert(emissions + 1, "Carbon dioxide, fossil;high. pop.;kg;100;Undefined;0;0;0;")
    out = tmp_path / "rice.csv"
    out.write_text("\n".join(lines) + "\n", encoding="latin-1")
    return out


def test_a_simapro_multi_output_process_is_allocated_by_its_factors(tmp_path: Path):
    """`sp_allocate_products` splits a two-product process into one dataset per product, and the
    inventory follows the factor: per kg, rice carries 95.8 % of the CO2 over 6250 kg, straw 4.2 %
    over 3125 kg. Before, the straw was a second `production` of one dataset."""
    _fmt, result = readers.read(_simapro_rice_with_emission(tmp_path))
    by_product = {d.reference_product: d for d in result.datasets}
    rice, straw = by_product["Rice, at farm (WFLDB 3.0)"], by_product["Rice straw, at farm (WFLDB 3.0)"]

    def per_kg(dataset):
        production = next(e for e in dataset.exchanges if e.kind == "production")
        co2 = next(e for e in dataset.exchanges if e.name == "Carbon dioxide, fossil")
        return co2.amount / production.amount

    assert abs(per_kg(rice) - 100 * 0.958 / 6250) < 1e-12
    assert abs(per_kg(straw) - 100 * 0.042 / 3125) < 1e-12
    # …which is the whole 100 kg again over the real masses: nothing lost, nothing counted twice.
    assert abs(per_kg(rice) * 6250 + per_kg(straw) * 3125 - 100) < 1e-9
    # One product per dataset, and one key per dataset — the copies shared the process identifier.
    assert all(sum(e.kind == "production" for e in d.exchanges) == 1 for d in result.datasets)
    assert len({d.key for d in result.datasets}) == len(result.datasets)
    # `split_simapro_name_geo`: the region SimaPro writes into the name becomes the region.
    assert rice.location == "IN" and rice.name == "Rice, at farm (WFLDB 3.0)"


def test_an_openlca_json_ld_package_reads():
    """The path that crashed on its first dataset: a dict of object groups taken as a list."""
    fmt, result = readers.read(FIXTURES / "jsonld-package")
    assert fmt is SourceFormat.json_ld
    by_name = {d.name: d for d in result.datasets}
    assert set(by_name) == {"widget assembly", "steel part production"}
    widget = by_name["widget assembly"]
    assert widget.unit == "kilogram" and widget.location == "DE"  # the code, not "Germany"
    co2 = next(e for e in widget.exchanges if e.kind == "biosphere")
    # 100 g in the file, converted into the unit group's reference unit by bw2io.
    assert abs(co2.amount - 0.1) < 1e-12 and co2.unit == "kilogram"
    assert co2.direction == "output" and "Emission to air" in co2.compartment
    steel = next(e for e in widget.exchanges if e.kind == "technosphere")
    assert steel.provider in by_name["steel part production"].provides


def test_a_zipped_json_ld_package_reads_like_the_folder(tmp_path: Path):
    """bw2io reads folders only; openLCA exports zips."""
    import zipfile

    from prism_lca.engine.dataimport.detect import detect

    archive = tmp_path / "export.zip"
    root = FIXTURES / "jsonld-package"
    with zipfile.ZipFile(archive, "w") as zf:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(root).as_posix())
    assert detect(archive).format is SourceFormat.json_ld
    _fmt, zipped = readers.read(archive)
    _fmt, folder = readers.read(root)
    assert sorted((d.key, len(d.exchanges)) for d in zipped.datasets) == sorted(
        (d.key, len(d.exchanges)) for d in folder.datasets
    )


def test_a_json_ld_multi_output_process_is_allocated(tmp_path: Path):
    """`json_ld_allocate_datasets` by the process's default method: 75/25 physical, one dataset per
    product, the CO2 split accordingly. openLCA 2 spells the direction `isInput`, which bw2io's
    allocation does not read — the reader sets both spellings."""
    import json
    import shutil

    root = tmp_path / "jsonld"
    shutil.copytree(FIXTURES / "jsonld-package", root)
    path = root / "processes" / "c1e7a000-0000-4000-8000-0000000000b0.json"
    process = json.loads(path.read_text(encoding="utf-8"))
    widget_ref = {"@type": "Flow", "@id": "c1e7a000-0000-4000-8000-0000000000f1", "name": "widget",
                  "flowType": "PRODUCT_FLOW", "refUnit": "kg"}
    process["exchanges"].append(
        {"@type": "Exchange", "internalId": 3, "amount": 1.0, "isInput": False, "flow": widget_ref,
         "unit": process["exchanges"][0]["unit"], "flowProperty": process["exchanges"][0]["flowProperty"]}
    )
    process["defaultAllocationMethod"] = "PHYSICAL_ALLOCATION"
    process["allocationFactors"] = [
        {"@type": "AllocationFactor", "allocationType": "PHYSICAL_ALLOCATION", "value": 0.75,
         "product": {"@type": "Flow", "@id": "c1e7a000-0000-4000-8000-0000000000f2"}},
        {"@type": "AllocationFactor", "allocationType": "PHYSICAL_ALLOCATION", "value": 0.25,
         "product": {"@type": "Flow", "@id": "c1e7a000-0000-4000-8000-0000000000f1"}},
    ]
    path.write_text(json.dumps(process), encoding="utf-8")

    _fmt, result = readers.read(root)
    split = [d for d in result.datasets if d.name == "steel part production"]
    assert sorted(d.reference_product for d in split) == ["steel part", "widget"]
    shares = {
        d.reference_product: next(e.amount for e in d.exchanges if e.kind == "biosphere") for d in split
    }
    assert abs(shares["steel part"] - 1.5 * 0.75) < 1e-12 and abs(shares["widget"] - 1.5 * 0.25) < 1e-12
    assert all(not e.coproduct for d in split for e in d.exchanges)  # allocated, so nothing left over


def test_a_json_ld_package_without_processes_says_so(tmp_path: Path):
    import shutil

    root = tmp_path / "flows-only"
    shutil.copytree(FIXTURES / "jsonld-package", root)
    shutil.rmtree(root / "processes")
    (root / "processes").mkdir()  # still recognised as openLCA, only empty
    with pytest.raises(PrismError) as caught:
        readers.read(root)
    assert caught.value.code in ("import_empty", "import_unreadable")
