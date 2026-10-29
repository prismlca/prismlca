"""Regression tests for the findings of an adversarial review of the import package.

One test (or a small group) per finding, numbered in review order. Point 1 (substitution against
a treatment) lives with the other co-product tests in ``test_import_coproducts.py``.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.dataimport import readers, session
from prism_lca.engine.dataimport.matching import PACKAGE_DB
from prism_lca.engine.library import LIBRARY_DB, delete_batch
from prism_lca.errors import PrismError

FIXTURES = Path(__file__).parent / "fixtures" / "import"
ES2 = FIXTURES / "es2-package"
JSONLD = FIXTURES / "jsonld-package"
CO2 = "00000000-0000-0000-0000-00000000c002"


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
    yield
    session.cancel()


def _es2(activity: str, name: str, products: list[tuple], inputs=()) -> str:
    """A minimal EcoSpold 2 dataset: products as (flow, name, amount, outputGroup[, unit]), inputs
    as (flow, name, amount, activityLinkId[, unit])."""
    out = "".join(
        f'<intermediateExchange id="{activity}-p{i}" amount="{p[2]}" intermediateExchangeId="{p[0]}">'
        f'<name xml:lang="en">{p[1]}</name><unitName xml:lang="en">{p[4] if len(p) > 4 else "kg"}</unitName>'
        f"<outputGroup>{p[3]}</outputGroup></intermediateExchange>"
        for i, p in enumerate(products)
    )
    ins = "".join(
        f'<intermediateExchange id="{activity}-i{i}" amount="{p[2]}" intermediateExchangeId="{p[0]}"'
        + (f' activityLinkId="{p[3]}"' if p[3] else "")
        + f'><name xml:lang="en">{p[1]}</name><unitName xml:lang="en">{p[4] if len(p) > 4 else "kg"}</unitName>'
        "<inputGroup>5</inputGroup></intermediateExchange>"
        for i, p in enumerate(inputs)
    )
    return f"""<?xml version="1.0" encoding="utf-8"?>
<ecoSpold xmlns="http://www.EcoInvent.org/EcoSpold02"><childActivityDataset>
<activityDescription><activity id="{activity}" activityNameId="{activity}" inheritanceDepth="0" type="1" specialActivityType="0">
<activityName xml:lang="en">{name}</activityName></activity>
<geography><shortname xml:lang="en">DE</shortname></geography><technology technologyLevel="3"/>
<timePeriod startDate="2026-01-01" endDate="2026-12-31" isDataValidForEntirePeriod="true"/></activityDescription>
<flowData>{out}{ins}</flowData>
<administrativeInformation><dataEntryBy personId="p" personName="f" personEmail="f@example.org"/>
<dataGeneratorAndPublication personId="p" personName="f" personEmail="f@example.org"/></administrativeInformation>
</childActivityDataset></ecoSpold>"""


# --- 2: JSON-LD amount and unit come from the same place ------------------------------------------


def _jsonld_copy(tmp_path: Path) -> Path:
    root = tmp_path / "jsonld"
    shutil.copytree(JSONLD, root)
    return root


def _edit_process(root: Path, pid: str, edit) -> None:
    path = root / "processes" / f"{pid}.json"
    process = json.loads(path.read_text(encoding="utf-8"))
    edit(process)
    path.write_text(json.dumps(process), encoding="utf-8")


WIDGET = "c1e7a000-0000-4000-8000-0000000000a0"


def test_2_without_ref_unit_the_amount_and_the_unit_are_both_the_reference(tmp_path):
    root = _jsonld_copy(tmp_path)

    def strip(process):
        for exc in process["exchanges"]:
            exc["flow"].pop("refUnit", None)

    _edit_process(root, WIDGET, strip)
    _fmt, result = readers.read(root)
    widget = next(d for d in result.datasets if d.key == WIDGET)
    co2 = next(e for e in widget.exchanges if e.kind == "biosphere")
    assert co2.unit == "kilogram" and abs(co2.amount - 0.1) < 1e-12  # not "0.1 gram"


def test_2_a_unit_the_package_does_not_define_is_refused(tmp_path):
    root = _jsonld_copy(tmp_path)

    def foreign_unit(process):
        process["exchanges"][2]["unit"] = {"@type": "Unit", "@id": "not-in-any-group", "name": "lb"}

    _edit_process(root, WIDGET, foreign_unit)
    with pytest.raises(PrismError) as caught:
        readers.read(root)
    assert caught.value.code == "import_unit_unresolved"


# --- 3: a named co-product supplier is never swapped -----------------------------------------------


def _coproduct_package(tmp_path: Path, *, with_b: bool) -> Path:
    root = tmp_path / ("with-b" if with_b else "without-b")
    root.mkdir()
    x, y = "0000000a-0000-4000-8000-0000000000f1", "0000000a-0000-4000-8000-0000000000f2"
    a, b, c = (f"0000000{n}-0000-4000-8000-000000000000" for n in "abc")
    (root / "a.spold").write_text(
        _es2(a, "A making X and Y", [(x, "X", 1.0, 0), (y, "Y", 0.5, 2)]), encoding="utf-8"
    )
    if with_b:
        (root / "b.spold").write_text(_es2(b, "B making Y", [(y, "Y", 1.0, 0)]), encoding="utf-8")
    (root / "c.spold").write_text(
        _es2(c, "C using Y", [("0000000c-0000-4000-8000-0000000000f1", "Z", 1.0, 0)], [(y, "Y", 2.0, a)]),
        encoding="utf-8",
    )
    return root


@pytest.mark.parametrize("with_b", [True, False], ids=["another-producer", "only-the-named-one"])
def test_3_a_named_coproduct_supplier_is_offered_and_never_replaced(world, tmp_path, with_b):
    session.start(_coproduct_package(tmp_path, with_b=with_b))
    row = next(r for r in session.rows() if r["name"] == "Y" and r["dataset"] == "C using Y")
    assert row["target"] is None  # neither B in A's place, nor A bound as if Y were its product
    assert row["candidates"][0]["database"] == PACKAGE_DB and row["candidates"][0]["code"] == "a.spold"
    assert "co-product" in row["evidence"]


# --- 4: deleting an import checks the library's own consumers -------------------------------------


def test_4_deleting_a_reimported_supplier_names_the_library_dataset_that_uses_it(world, tmp_path):
    session.start(ES2)
    session.commit("both")
    only_b = tmp_path / "only-b"
    only_b.mkdir()
    shutil.copy(ES2 / "steel-part-production.spold", only_b / "steel-part-production.spold")
    session.start(only_b)
    again = session.commit("b again")

    with pytest.raises(PrismError) as refused:
        delete_batch(again["batch"])
    assert refused.value.code == "import_in_use" and LIBRARY_DB in str(refused.value)
    widget = get_bd().get_node(database=LIBRARY_DB, code="widget-assembly.spold")
    assert [e.input.key for e in widget.technosphere()] == [(LIBRARY_DB, "steel-part-production.spold")]
    assert delete_batch(again["batch"], force=True)["was_used_by"] == [LIBRARY_DB]


def test_4_a_consumer_deleted_in_the_same_batch_is_no_reason_to_refuse(world):
    session.start(ES2)
    result = session.commit("both")
    assert delete_batch(result["batch"])["datasets"] == 2


# --- 5: a re-import finds what it replaces by identity, not by normalised names --------------------


def test_5_a_reimport_replaces_an_import_from_before_the_normalisation(world):
    """An import written before the strategies ran named the SimaPro process "Rice…/IN U" under the
    bare process id. Normalised, the same file reads as "Rice…" under "id:Rice…" — the (code, name)
    lookup missed it, the model stayed on the old dataset and the library doubled."""
    from prism_lca.engine.library import ensure_library

    ensure_library()
    bd = get_bd()
    old = bd.Database(LIBRARY_DB).new_activity(
        code="ReCenter000033915302504", name="Rice, at farm (WFLDB 3.0)/IN U", unit="kg",
        prism_import_batch="old-batch",
    )
    old.save()
    old.new_edge(input=old, amount=1.0, type="production").save()
    model = bd.Database("my-model")
    model.register()
    m = model.new_activity(code="m", name="meal", unit="unit")
    m.save()
    m.new_edge(input=old, amount=0.2, type="technosphere").save()

    session.start(FIXTURES / "simapro-allocation.csv")
    first = session.commit("normalised")
    assert first["replaced"] == 1
    assert "ReCenter000033915302504" in first["codes"]  # the replacement keeps the code it replaces
    link = next(iter(bd.get_node(database="my-model", code="m").technosphere()))
    assert link.input["name"] == "Rice, at farm (WFLDB 3.0)" and link["amount"] == 0.2

    session.start(FIXTURES / "simapro-allocation.csv")
    second = session.commit("again")
    assert second["replaced"] == first["datasets"]  # everything found again, by identity
    assert len(bd.Database(LIBRARY_DB)) == first["datasets"]


# --- 6: options and decisions are frozen while the commit writes ----------------------------------


def test_6_a_switch_flipped_during_the_commit_is_refused(world, monkeypatch):
    session.start(ES2)
    refusals: list[str] = []
    real = session.ensure_library

    def meddle():
        for attempt in (
            lambda: session.set_options(coproducts_as_substitution=True),
            lambda: session.decide([{"dataset": "widget assembly", "index": 1, "code": None}]),
        ):
            try:
                attempt()
            except PrismError as exc:
                refusals.append(exc.code)
        return real()

    monkeypatch.setattr(session, "ensure_library", meddle)
    session.commit("frozen")
    assert refusals == ["import_committing", "import_committing"]


def test_6_a_failed_commit_leaves_the_session_editable(world, monkeypatch):
    session.start(ES2)
    monkeypatch.setattr(session, "ensure_library", lambda: (_ for _ in ()).throw(RuntimeError("disk")))
    with pytest.raises(RuntimeError):
        session.commit("fails")
    assert session.set_options(coproducts_as_substitution=True)["coproducts_as_substitution"] is True


# --- 7: SimaPro without usable allocation factors loses nothing -----------------------------------


@pytest.mark.parametrize(("rice", "straw"), [("0", "0"), ("", "")], ids=["zero", "missing"])
def test_7_unusable_allocation_keeps_the_process_whole(tmp_path, rice, straw):
    lines = (FIXTURES / "simapro-allocation.csv").read_text(encoding="latin-1").splitlines()
    i = next(n for n, line in enumerate(lines) if line.startswith("Rice, at farm (WFLDB 3.0)/IN U;kg;6250"))
    lines[i] = lines[i].replace(";95.8;", f";{rice};")
    lines[i + 1] = lines[i + 1].replace(";4.2;", f";{straw};")
    emissions = next(n for n in range(i, len(lines)) if lines[n] == "Emissions to air")
    lines.insert(emissions + 1, "Carbon dioxide, fossil;high. pop.;kg;10;Undefined;0;0;0;")
    source = tmp_path / "unallocated.csv"
    source.write_text("\n".join(lines) + "\n", encoding="latin-1")

    _fmt, result = readers.read(source)
    rice_ds = [d for d in result.datasets if "Rice" in d.name and "residues" not in d.name]
    assert len(rice_ds) == 1  # not split
    exchanges = rice_ds[0].exchanges
    assert next(e for e in exchanges if e.name == "Carbon dioxide, fossil").amount == 10
    assert [e.name for e in exchanges if e.coproduct] == ["Rice straw, at farm (WFLDB 3.0)"]
    assert any("no usable allocation factors" in note for note in result.notes)


# --- 8: a decision sent with a database resolves in that database only -----------------------------


def test_8_the_database_sent_is_the_database_used(world):
    bd = get_bd()
    bd.Database("bg").write(
        {("bg", "steel-part-production.spold"): {"name": "steel from the background", "unit": "kilogram"}}
    )
    session.start(ES2)
    row = next(r for r in session.rows() if r["name"] == "steel part")
    assert row["target"]["database"] == PACKAGE_DB
    assert session.decide([{"dataset_key": row["dataset_key"], "dataset": row["dataset"], "index": row["index"],
                            "database": "bg", "code": "steel-part-production.spold"}]) == 1
    after = next(r for r in session.rows() if r["name"] == "steel part")
    assert after["target"]["database"] == "bg"


# --- 9: a zip has limits, and paths are contained by path -----------------------------------------


def _zip_of(root: Path, archive: Path, extra: dict[str, bytes] | None = None) -> Path:
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(root).as_posix())
        for name, body in (extra or {}).items():
            zf.writestr(name, body)
    return archive


def test_9_a_member_larger_than_the_limit_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(readers, "ZIP_MAX_MEMBER", 4096)
    archive = _zip_of(JSONLD, tmp_path / "bomb.zip", {"flows/big.json": b" " * 100_000})
    with pytest.raises(PrismError) as caught:
        readers.read(archive)
    assert caught.value.code == "import_archive_too_large"


def test_9_too_many_members_are_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(readers, "ZIP_MAX_MEMBERS", 5)
    with pytest.raises(PrismError) as caught:
        readers.read(_zip_of(JSONLD, tmp_path / "many.zip"))
    assert caught.value.code == "import_archive_too_large"


def test_9_a_member_escaping_the_folder_is_refused(tmp_path):
    archive = _zip_of(JSONLD, tmp_path / "escape.zip", {"../processes/evil.json": b"{}"})
    with pytest.raises(PrismError) as caught:
        readers.read(archive)
    assert caught.value.code == "import_unreadable"
    assert not (tmp_path / "processes" / "evil.json").exists()


def test_9_members_outside_the_object_folders_are_not_unpacked(tmp_path, monkeypatch):
    """A huge file nobody reads does not count against the limits and is never written."""
    monkeypatch.setattr(readers, "ZIP_MAX_MEMBER", 4096)
    archive = _zip_of(JSONLD, tmp_path / "junk.zip", {"bin/blob.bin": b"x" * 100_000})
    _fmt, result = readers.read(archive)
    assert len(result.datasets) == 2


# --- 10: openLCA 1 categories as reference objects -------------------------------------------------


def test_10_an_openlca_1_category_reference_is_read_not_crashed_on(tmp_path):
    root = _jsonld_copy(tmp_path)
    flow_path = root / "flows" / "c1e7a000-0000-4000-8000-0000000000f3.json"
    flow = json.loads(flow_path.read_text(encoding="utf-8"))
    flow["category"] = {"@type": "Category", "@id": "cat-air"}
    flow_path.write_text(json.dumps(flow), encoding="utf-8")
    (root / "categories").mkdir()
    (root / "categories" / "cat-air.json").write_text(
        json.dumps({"@type": "Category", "@id": "cat-air", "name": "Emission to air",
                    "category": {"@type": "Category", "@id": "cat-ef"}}), encoding="utf-8")
    (root / "categories" / "cat-ef.json").write_text(
        json.dumps({"@type": "Category", "@id": "cat-ef", "name": "Elementary flows"}), encoding="utf-8")

    def openlca_1_refs(process):
        for exc in process["exchanges"]:
            exc["flow"].pop("category", None)

    for pid in (WIDGET, "c1e7a000-0000-4000-8000-0000000000b0"):
        _edit_process(root, pid, openlca_1_refs)
    _fmt, result = readers.read(root)
    co2 = next(e for d in result.datasets for e in d.exchanges if e.kind == "biosphere")
    assert co2.compartment == ("Elementary flows", "Emission to air")


# ==================================================================================================
# Second review round
# ==================================================================================================


def _one_file(folder: Path, activity: str, name: str) -> Path:
    folder.mkdir()
    (folder / "p.spold").write_text(
        _es2(activity, name, [("00000000-0000-4000-8000-0000000000e1", "electricity", 1.0, 0, "kWh")]),
        encoding="utf-8",
    )
    return folder


def test_r2_1_two_processes_sharing_id_and_product_are_not_one_dataset(world, tmp_path):
    """"coal electricity" and "gas electricity", both file "p.spold" making "electricity": the
    identity without the process name was "p.spold|electricity" for both, and gas replaced coal."""
    session.start(_one_file(tmp_path / "coal", "00000000-0000-4000-8000-00000000c0a1", "coal electricity"))
    session.commit("coal")
    session.start(_one_file(tmp_path / "gas", "00000000-0000-4000-8000-0000000006a5", "gas electricity"))
    second = session.commit("gas")
    assert second["replaced"] == 0
    assert sorted(a["name"] for a in get_bd().Database(LIBRARY_DB)) == ["coal electricity", "gas electricity"]


def test_r2_1_an_ambiguous_identity_replaces_nothing_and_says_so(world):
    def same_identity():
        for dataset in session._current.datasets:
            dataset.identity = "one|and|the same"

    session.start(ES2)
    same_identity()
    session.commit("first")
    session.start(ES2)
    same_identity()
    result = session.commit("second")
    assert result["replaced"] == 0
    assert sorted(result["ambiguous"]) == ["steel part production", "widget assembly"]
    assert len(get_bd().Database(LIBRARY_DB)) == 4


def _steam_package(tmp_path: Path) -> Path:
    root = tmp_path / "steam"
    root.mkdir()
    power, steam = "0000000a-0000-4000-8000-0000000000e1", "0000000a-0000-4000-8000-0000000000e2"
    a, c = "0000000a-0000-4000-8000-000000000000", "0000000c-0000-4000-8000-000000000000"
    (root / "a.spold").write_text(
        _es2(a, "A: power plant", [(power, "electricity", 1.0, 0, "kWh"), (steam, "steam", 3.0, 2, "kg")]),
        encoding="utf-8",
    )
    (root / "c.spold").write_text(
        _es2(c, "C: dryer", [("0000000c-0000-4000-8000-0000000000f1", "dry goods", 1.0, 0)],
             [(steam, "steam", 4.0, a, "kg")]),
        encoding="utf-8",
    )
    return root


def _steam_row() -> dict:
    # C's steam INPUT — A lists steam too, as its co-product output, and that row has no supplier.
    return next(r for r in session.rows() if r["name"] == "steam" and r["dataset"] == "C: dryer")


def test_r2_2_a_coproduct_candidate_carries_the_suppliers_own_unit_and_a_flag(world, tmp_path):
    session.start(_steam_package(tmp_path))
    candidate = _steam_row()["candidates"][0]
    assert candidate["code"] == "a.spold"
    assert candidate["unit"] == "kilowatt hour"  # what one unit of A is — not the input's kg
    assert candidate["allocation_required"] is True


def test_r2_2_choosing_it_needs_an_explicit_confirmation(world, tmp_path):
    session.start(_steam_package(tmp_path))
    row = _steam_row()
    pick = {"dataset_key": row["dataset_key"], "dataset": row["dataset"], "index": row["index"],
            "database": PACKAGE_DB, "code": "a.spold"}
    with pytest.raises(PrismError) as refused:
        session.decide([pick])
    assert refused.value.code == "import_allocation_required"
    assert _steam_row()["target"] is None

    # In a batch with other decisions it is listed, not raised — the rest still applies.
    listed: list[dict] = []
    assert session.decide([pick, {**pick, "code": None}], refused=listed) == 1
    assert [r["code"] for r in listed] == ["import_allocation_required"]

    assert session.decide([{**pick, "allocation_confirmed": True}]) == 1
    after = _steam_row()
    assert after["target"]["code"] == "a.spold"
    assert after["confidence"] == "low"  # kg against kWh: confirmed, but not convertible


def test_r2_2_the_api_passes_the_confirmation_and_the_refusals(client: TestClient, token, world, tmp_path):
    client.post("/api/v1/import/start", json={"path": str(_steam_package(tmp_path))}, headers=token)
    row = _steam_row()
    pick = {"dataset_key": row["dataset_key"], "dataset": row["dataset"], "index": row["index"],
            "database": PACKAGE_DB, "code": "a.spold"}
    r = client.post("/api/v1/import/decide", json={"decisions": [pick]}, headers=token)
    assert r.status_code == 409 and "import_allocation_required" in r.text
    r = client.post("/api/v1/import/decide", json={"decisions": [{**pick, "allocation_confirmed": True}]},
                    headers=token)
    assert r.status_code == 200 and r.json() == {"applied": 1, "refused": []}


def test_r2_3_jsonld_members_are_unpacked_too(tmp_path):
    root = _jsonld_copy(tmp_path)
    group = next((root / "unit_groups").iterdir())
    group.rename(group.with_suffix(".jsonld"))
    _fmt, result = readers.read(_zip_of(root, tmp_path / "jsonld.zip"))
    assert len(result.datasets) == 2


def test_r2_4_a_snapshot_that_fails_leaves_no_commit_flag_behind(world, monkeypatch):
    session.start(ES2)

    def out_of_memory(_obj):
        raise MemoryError

    monkeypatch.setattr(session.copy, "copy", out_of_memory)
    with pytest.raises(MemoryError):
        session.commit("oom")
    monkeypatch.undo()
    assert session._current.committing is False
    assert session.set_options(coproducts_as_substitution=True)["coproducts_as_substitution"] is True


def test_r2_5_numeric_strings_are_numbers_for_the_allocation_guard():
    data = [{
        "exchanges": [
            {"type": "production", "name": "A", "unit": "kg", "amount": 1.0, "allocation": "0"},
            {"type": "production", "name": "B", "unit": "kg", "amount": 1.0, "allocation": "0"},
            {"type": "biosphere", "name": "CO2", "amount": 10.0},
        ],
    }]
    readers._refuse_or_mark_unallocatable(data)
    assert data[0]["prism_unallocated"] is True and data[0]["reference product"] == "A"


def test_r2_5_an_allocation_that_leaves_no_burden_is_refused():
    """What a formula evaluating to zero for every product comes to after bw2io's strategies:
    copies with a production and nothing else, from a source that had a burden."""
    copies = [
        {"prism_source_key": "p", "prism_source_name": "Rice", "prism_had_burden": True,
         "exchanges": [{"type": "production", "name": name, "amount": 1.0}]}
        for name in ("rice", "straw")
    ]
    with pytest.raises(PrismError) as caught:
        readers._refuse_burden_lost(copies)
    assert caught.value.code == "import_allocation_missing"
    # …and a source that had nothing to lose is left alone.
    for ds in copies:
        ds["prism_had_burden"] = False
    readers._refuse_burden_lost(copies)


def test_r2_6_a_dataset_with_a_reference_of_zero_is_not_imported(world, tmp_path):
    root = tmp_path / "ilcd-zero"
    shutil.copytree(FIXTURES / "ilcd-unitprocess", root)
    process = root / "processes" / "11111111-1111-1111-1111-111111111111.xml"
    text = process.read_text(encoding="utf-8")
    process.write_text(text.replace("<meanAmount>1.0</meanAmount>", "<meanAmount>0</meanAmount>", 1),
                       encoding="utf-8")
    summary = session.start(root)
    assert summary["datasets"] == 0
    assert any("reference amount of 0" in note for note in summary["notes"])
    assert session.commit("zero")["datasets"] == 0


# ==================================================================================================
# Third review round — two regressions of the second
# ==================================================================================================


def test_r3_1_a_two_part_identity_from_before_is_still_found(world, tmp_path):
    """An import of 25f99373 wrote identity "<id>|<product>" and, deduplicated, code "<id>:<product>".
    The same process re-imported alone matched neither and came in twice."""
    from prism_lca.engine.library import ensure_library

    folder = _one_file(tmp_path / "coal", "00000000-0000-4000-8000-00000000c0a1", "Coal plant")
    ensure_library()
    bd = get_bd()
    old = bd.Database(LIBRARY_DB).new_activity(
        code="p.spold:electricity", name="Coal plant", unit="kilowatt hour",
        prism_import_identity="p.spold|electricity", prism_import_batch="old",
    )
    old.save()
    old.new_edge(input=old, amount=1.0, type="production").save()

    session.start(folder)
    result = session.commit("again")
    assert result["replaced"] == 1 and result["codes"] == ["p.spold:electricity"]
    assert len(bd.Database(LIBRARY_DB)) == 1


def test_r3_1_two_old_datasets_under_one_two_part_identity_are_ambiguous(world, tmp_path):
    from prism_lca.engine.library import ensure_library

    ensure_library()
    lib = get_bd().Database(LIBRARY_DB)
    for code in ("a", "b"):
        act = lib.new_activity(code=code, name=f"old {code}", unit="kWh",
                               prism_import_identity="p.spold|electricity")
        act.save()
    session.start(_one_file(tmp_path / "coal", "00000000-0000-4000-8000-00000000c0a1", "Coal plant"))
    result = session.commit("again")
    assert result["replaced"] == 0 and result["ambiguous"] == ["Coal plant"]


def test_r3_2_only_the_reference_production_sets_the_sign(world):
    """A supplier with its self-reference +1 and a second production exchange −1 is a producer —
    the sum of 0 parked the substitution as "reference of 0"."""
    bd = get_bd()
    bg = bd.Database("bg")
    bg.register()
    other = bg.new_activity(code="other", name="something else", unit="kg")
    other.save()
    target = bg.new_activity(code="tgt", name="supplier", unit="kg")
    target.save()
    target.new_edge(input=target, amount=1.0, type="production").save()
    target.new_edge(input=other, amount=-1.0, type="production").save()
    session.start(ES2)
    assert session._production_sign(session._current, "bg", "tgt") == 1.0
