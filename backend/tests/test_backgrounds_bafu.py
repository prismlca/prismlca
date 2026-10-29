"""BAFU:20XY as a background database: reader, linker, import beside ecoinvent, import without
ecoinvent (bundled biosphere), the registry, removal, and the API shapes.

Fixture ``tests/fixtures/import/bafu-mini/`` is invented (BAFU structure, no BAFU data). The
"ecoinvent" side is a hand-made biosphere — the tests never touch licensed material.

The import without ecoinvent writes one bundled method per family; after changing the BAFU import or
bumping bw2io, run it with all 762: ``PRISM_FULL_BAFU=1 uv run pytest tests/test_backgrounds_bafu.py``.
"""

from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path

import pytest

from prism_lca.engine.backgrounds import bafu, common
from prism_lca.errors import PrismError

FIXTURE = Path(__file__).parent / "fixtures" / "import" / "bafu-mini"
FULL_BAFU = bool(os.environ.get("PRISM_FULL_BAFU"))


def _seed_ecoinvent(bd, name: str = "ecoinvent-3.12-cutoff") -> None:
    """A tiny 'ecoinvent': biosphere with the flows the fixture needs and one read-only inventory."""
    from prism_lca.engine import guardrails

    bd.Database("biosphere3").write(
        {
            ("biosphere3", "co2"): {
                "name": "Carbon dioxide, fossil",
                "type": "emission",
                "categories": ("air", "urban air close to ground"),
                "unit": "kilogram",
                "CAS number": "000124-38-9",
            },
            ("biosphere3", "propylene"): {
                "name": "Propylene",
                "type": "emission",
                "categories": ("air", "urban air close to ground"),
                "unit": "kilogram",
                "CAS number": "000115-07-1",
            },
            ("biosphere3", "water"): {
                "name": "Water",
                "type": "emission",
                "categories": ("water", "surface water"),
                "unit": "cubic meter",
                "CAS number": "007732-18-5",
            },
        }
    )
    bd.Database(name).write(
        {
            (name, "elec"): {
                "name": "electricity",
                "unit": "kilowatt hour",
                "reference product": "electricity",
                "location": "CH",
                "exchanges": [{"input": (name, "elec"), "amount": 1, "type": "production"}],
            }
        }
    )
    bd.databases[name][common.COMPLETE_KEY] = True
    bd.databases.flush()
    guardrails.set_read_only(name, True)
    guardrails.set_read_only("biosphere3", True)


def test_reader_parses_the_fixture_faithfully() -> None:
    datasets = bafu.read_folder(FIXTURE)
    assert len(datasets) == 2
    widget = next(d for d in datasets if d.name == "Test widget, at plant")
    assert widget.code == "aaaaaaaa-0000-0000-0000-000000000001"
    assert widget.number == "1001" and widget.location == "CH" and widget.unit == "kg"
    assert widget.period_start == "2015-01" and "UUID:" not in widget.comment
    kinds = [e.kind for e in widget.exchanges]
    assert kinds.count("production") == 1 and kinds.count("technosphere") == 1
    assert kinds.count("biosphere") == 4
    co2 = next(e for e in widget.exchanges if e.name == "Carbon dioxide, fossil")
    assert co2.cas == "124-38-9" and co2.uncertainty_type == 1 and co2.sd95 == 1.1


def test_linker_resolves_by_number_and_refuses_gaps() -> None:
    datasets = bafu.read_folder(FIXTURE)
    links = bafu.link_technosphere(datasets)
    assert set(links.values()) == {"aaaaaaaa-0000-0000-0000-000000000002"}
    datasets[0].exchanges.append(
        bafu.Exchange("9999", "Ghost, at plant", "test", "x", "kg", 1.0, "technosphere", "CH")
    )
    with pytest.raises(PrismError) as excinfo:
        bafu.link_technosphere(datasets)
    assert excinfo.value.code == "bafu_unlinked" and "Ghost" in (excinfo.value.hint or "")


def test_uncertainty_and_pedigree_translation() -> None:
    exc = bafu.Exchange("1", "x", "c", "s", "kg", 2.0, "biosphere", uncertainty_type=1, sd95=1.5)
    unc = bafu._uncertainty(exc, 2.0)
    assert unc["uncertainty type"] == 2 and unc["negative"] is False
    assert abs(unc["scale"] - 0.2027) < 1e-3  # ln(1.5)/2
    assert (
        bafu._uncertainty(
            bafu.Exchange("1", "x", "c", "s", "kg", 2.0, "biosphere", uncertainty_type=1, sd95=1.0),
            2.0,
        )["uncertainty type"]
        == 0
    )
    assert bafu._pedigree("(2,3,1,1,1,na); literature") == {
        "reliability": 2,
        "completeness": 3,
        "temporal correlation": 1,
        "geographical correlation": 1,
        "further technological correlation": 1,
    }
    assert bafu._pedigree("own assumption") is None


def test_label_from_path_reads_the_download_folder(tmp_path: Path) -> None:
    folder = tmp_path / "BAFU-2026 v1" / "ecoSpold files"
    folder.mkdir(parents=True)
    assert bafu.label_from_path(folder) == ("bafu-2026-v1", "BAFU:2026 v1", "2026 v1")
    assert bafu.label_from_path(tmp_path)[0] == bafu.DEFAULT_DATABASE


def test_import_beside_ecoinvent_maps_flows_and_creates_new_ones(client, token, project) -> None:
    from prism_lca.engine import ecoinvent
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    _seed_ecoinvent(bd)
    assert common.offered_providers() == ["bafu"]

    ecoinvent.start_bafu_import(str(FIXTURE), project, run_in_thread=False)
    st = ecoinvent.status()
    assert st.state is ecoinvent.JobState.done, st.detail
    assert st.database == "bafu-2026-v1"  # default: the fixture folder carries no BAFU-20XY name

    db = bd.Database("bafu-2026-v1")
    assert len(db) == 2
    widget = db.get("aaaaaaaa-0000-0000-0000-000000000001")
    bio = {e.input["code"]: e for e in widget.biosphere()}
    # exact (CO2), CAS (Propene → Propylene), rewrite+unit (Water kg → m³), new flow (noise)
    assert bio["co2"]["amount"] == 0.5 and bio["co2"]["prism_source"]["rung"] == "exact"
    assert bio["propylene"]["prism_source"]["rung"] == "cas"
    assert (
        abs(bio["water"]["amount"] - 0.003) < 1e-12
        and bio["water"]["prism_source"]["amount"] == 3.0
    )
    noise = next(e for code, e in bio.items() if code not in ("co2", "propylene", "water"))
    assert (
        noise.input["name"] == "Noise, test vehicle"
        and noise.input["prism_origin"] == "bafu-2026-v1"
    )
    assert noise.input["categories"] == ("air",) and noise["prism_source"]["rung"] == "new_flow"
    tech = list(widget.technosphere())
    assert len(tech) == 1 and tech[0].input["code"] == "aaaaaaaa-0000-0000-0000-000000000002"
    assert bio["co2"]["uncertainty type"] == 2  # lognormal from sd95 1.1

    # Registry and overview
    info = common.registry("bafu-2026-v1")
    assert info is not None and info.provider == "bafu" and "BAFU:2026" in info.citation
    # noise + the bolt dataset's Sodium, Coal and Heat, waste — none of them in the tiny biosphere
    assert info.flow_mapping["new_flows"] == 4 and info.flow_mapping["with_ecoinvent"] is True
    assert common.offered_providers() == []
    overview = client.get("/api/v1/setup/background", headers=token).json()
    names = {b["name"]: b for b in overview["background"]}
    assert (
        names["bafu-2026-v1"]["provider"] == "bafu"
        and names["bafu-2026-v1"]["label"] == "BAFU:2026 v1"
    )
    assert names["ecoinvent-3.12-cutoff"]["provider"] == "ecoinvent"  # derived from the name
    assert overview["offered"] == []

    # A second BAFU is refused (one database per provider).
    with pytest.raises(PrismError) as excinfo:
        ecoinvent.start_bafu_import(str(FIXTURE), project, run_in_thread=False)
    assert excinfo.value.code == "background_exists"


def test_remove_background_refuses_while_used_then_removes(client, token, project) -> None:
    from prism_lca.engine import ecoinvent
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    _seed_ecoinvent(bd)
    ecoinvent.start_bafu_import(str(FIXTURE), project, run_in_thread=False)
    bd.Database("my-model").write(
        {
            ("my-model", "w"): {
                "name": "w",
                "unit": "unit",
                "reference product": "w",
                "location": "GLO",
                "exchanges": [
                    {"input": ("my-model", "w"), "amount": 1, "type": "production"},
                    {
                        "input": ("bafu-2026-v1", "aaaaaaaa-0000-0000-0000-000000000001"),
                        "amount": 2,
                        "type": "technosphere",
                    },
                ],
            }
        }
    )
    from prism_lca.engine import guardrails

    guardrails.set_read_only("my-model", False)
    r = client.delete("/api/v1/setup/background/bafu-2026-v1", headers=token)
    assert r.status_code == 409 and r.json()["error"]["code"] == "background_in_use"
    assert "my-model" in r.json()["error"]["message"]

    bd.Database("my-model").delete(warn=False)
    del bd.databases["my-model"]
    r = client.delete("/api/v1/setup/background/bafu-2026-v1", headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["flows_removed"] == 4  # the new flows nothing references any more
    assert "bafu-2026-v1" not in bd.databases
    assert common.offered_providers() == ["bafu"]
    assert client.delete("/api/v1/setup/background/nope", headers=token).status_code == 404


def _bundled_methods() -> list[dict]:
    with zipfile.ZipFile(bafu.bw2io_path(bafu.BW2IO_METHODS_39)) as archive:
        return json.load(archive.open("data.json"))


@pytest.fixture
def bundled_methods(tmp_path, monkeypatch) -> set[tuple]:
    """The names of the methods the import without ecoinvent is expected to write.

    All 762 of bw2io's bundled methods take a minute to write — Brightway looks up every one of their
    227 000 factors on its own — so the normal suite writes the first method of each family and
    :func:`test_every_bundled_method_links_to_the_bundled_flow_list` checks the rest without writing.
    ``PRISM_FULL_BAFU=1`` writes them all: run it after changing the BAFU import or bumping bw2io."""
    methods = _bundled_methods()
    if FULL_BAFU:
        return {tuple(method["name"]) for method in methods}
    first_of_family: dict[str, dict] = {}
    for method in methods:
        first_of_family.setdefault(method["name"][0], method)
    sample = tmp_path / "lcia_sample.zip"
    with zipfile.ZipFile(sample, "w") as archive:
        archive.writestr("data.json", json.dumps(list(first_of_family.values())))
    # An absolute path: ``bw2io_path`` joins it onto bw2io's folder, and pathlib keeps the absolute side.
    monkeypatch.setattr(bafu, "BW2IO_METHODS_39", sample)
    return {tuple(method["name"]) for method in first_of_family.values()}


def test_every_bundled_method_links_to_the_bundled_flow_list() -> None:
    """What writing all bundled methods would prove, checked without writing them: every method has a
    name of its own (none overwrites another), and every factor is a number on a flow of the bundled
    flow list, so the import skips none."""
    codes = {flow.code for flow in bafu.bundled_flow_list().flows}
    methods = _bundled_methods()
    unusable = [
        method["name"]
        for method in methods
        for exc in method.get("exchanges", [])
        if not exc.get("input")
        or exc["input"][1] not in codes
        or not isinstance(exc.get("amount"), int | float)
    ]
    assert len(methods) > 700
    assert len({tuple(method["name"]) for method in methods}) == len(methods)
    assert not unusable, unusable[:5]


def test_import_without_ecoinvent_uses_bundled_biosphere_and_methods(
    client, token, project, bundled_methods
) -> None:
    """Scenario S3: a bare project. biosphere3 and the methods come from bw2io's bundled 3.9
    material; the fixture's flows map onto the 3.9 list (CO2 exact, Propene → Propylene via the
    correspondence, noise as a new flow)."""
    from prism_lca.engine import ecoinvent
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    assert common.offered_providers() == ["ecoinvent", "bafu"]
    ecoinvent.start_bafu_import(str(FIXTURE), project, run_in_thread=False)
    st = ecoinvent.status()
    assert st.state is ecoinvent.JobState.done, st.detail
    assert bd.databases["biosphere3"]["prism_biosphere_source"].startswith("bw2io")
    assert len(bd.Database("biosphere3")) >= 4709
    assert set(bd.methods) == bundled_methods
    method = next(m for m in bd.methods if m[0] == "IPCC 2021")
    assert bd.methods[method]["prism_bundled"] == "bw2io"
    info = common.registry("bafu-2026-v1")
    assert info.flow_mapping["with_ecoinvent"] is False
    assert info.flow_mapping["exchanges_resolved"] >= 3
    overview = client.get("/api/v1/setup/background", headers=token).json()
    assert overview["offered"] == ["ecoinvent"]


def test_background_import_route_shapes(client, token, project) -> None:
    r = client.post(
        "/api/v1/setup/background",
        json={"source": "bafu", "path": "/definitely/not/here"},
        headers=token,
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "path_not_found"
    r = client.post(
        "/api/v1/setup/background",
        json={"source": "nope", "path": "/x"},
        headers=token,
    )
    assert r.status_code == 422


def test_ecoinvent_after_bafu_rewrites_everything_onto_ecoinvent(
    client, token, project, tmp_path
) -> None:
    """Scenario S4 in miniature: a BAFU-first project (bundled-style biosphere, a bundled method),
    then ecoinvent's flow list arrives — flows lifted, exchanges re-pointed, the bundled method
    replaced by the workbook's, the 3.9-only flow pruned."""
    from test_setup import write_flow_list, write_lcia_workbook

    from prism_lca.engine import ecoinvent, guardrails
    from prism_lca.engine.backgrounds import sync
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    # The "bundled 3.9" biosphere: CO2 under the UUID ecoinvent keeps, an old-named flow that 3.12
    # renames, and a flow 3.12 dropped.
    bd.Database("biosphere3").write(
        {
            ("biosphere3", "c1"): {
                "name": "Carbon dioxide, fossil",
                "type": "emission",
                "categories": ("air", "urban air close to ground"),
                "unit": "kilogram",
                "prism_origin": "bw2io",
            },
            ("biosphere3", "c2"): {
                "name": "Propene",
                "type": "emission",
                "categories": ("air", "urban air close to ground"),
                "unit": "kilogram",
                "CAS number": "000115-07-1",
                "prism_origin": "bw2io",
            },
            ("biosphere3", "c3"): {
                "name": "Water, old only",
                "type": "emission",
                "categories": ("water", "surface water"),
                "unit": "cubic meter",
                "prism_origin": "bw2io",
            },
        }
    )
    bd.databases["biosphere3"][ecoinvent.BIO_SOURCE_KEY] = "bw2io 0.9.17: test"
    bd.databases.flush()
    guardrails.set_read_only("biosphere3", True)
    bundled = bd.Method(("Fam", "cat", "ind"))
    bundled.register(unit="x", description="bundled", prism_bundled="bw2io")
    bundled.write([(("biosphere3", "c1"), 1.0)])
    assert sync.has_bundled_biosphere()

    ecoinvent.start_bafu_import(str(FIXTURE), project, run_in_thread=False)
    assert ecoinvent.status().state is ecoinvent.JobState.done, ecoinvent.status().detail
    widget = bd.Database("bafu-2026-v1").get("aaaaaaaa-0000-0000-0000-000000000001")
    before = {e.input["code"]: e["amount"] for e in widget.biosphere()}
    assert "c2" in before and "c1" in before  # Propene exact, CO2 exact

    # ecoinvent arrives: c1 kept, c2 renamed to "Propylene", c3 gone, a new flow "Water" appears.
    flows = [
        ("c1", "Carbon dioxide, fossil", "air", "urban air close to ground"),
        ("c2", "Propylene", "air", "urban air close to ground"),
        ("w312", "Water", "water", "surface water"),
    ]
    elementary = write_flow_list(tmp_path / "ElementaryExchanges.xml", flows)
    _note, release_flows = ecoinvent._ensure_biosphere(elementary)
    # The workbook's method of the SAME name overwrites the bundled one in place (D7).
    ecoinvent._import_lcia(
        write_lcia_workbook(
            tmp_path / "lcia.xlsx",
            [
                (
                    "Fam",
                    "cat",
                    "ind",
                    "Carbon dioxide, fossil",
                    "air",
                    "urban air close to ground",
                    2.0,
                )
            ],
            [("Fam", "cat", "ind", "kg")],
        )
    )
    report = sync.ecoinvent_master(release_flows, replace_methods=True)

    assert report["lifted_flows"] >= 2  # c1/c2 lost their marker, c2 renamed
    assert bd.Database("biosphere3").get("c2")["name"] == "Propylene"
    assert report["bundled_methods_removed"] == 0  # overwritten in place, not deleted
    assert bd.methods[("Fam", "cat", "ind")].get("prism_bundled") is None
    assert (
        dict(bd.Method(("Fam", "cat", "ind")).load())[bd.Database("biosphere3").get("c1").id] == 2.0
    )
    after = {
        e.input["code"]: e
        for e in bd.Database("bafu-2026-v1").get("aaaaaaaa-0000-0000-0000-000000000001").biosphere()
    }
    # "Water" (kg, river) now has a counterpart in the release list: moved from its new flow onto
    # w312 (the fixture's flow list writes kg for every flow, so no unit factor here).
    assert "w312" in after and after["w312"]["amount"] == 3.0
    assert after["w312"]["prism_source"]["rung"] == "exact"
    moved = sum(r["moved"] for r in report["remapped"])
    assert moved >= 1
    # The dropped 3.9-only flow nothing references is gone; ecoinvent's flows stay.
    codes = {n["code"] for n in bd.Database("biosphere3")}
    assert "c3" not in codes and {"c1", "c2", "w312"} <= codes
    assert report["flows_removed"] >= 1


def test_bundle_round_trip_with_bafu_and_library_references(client, token, project) -> None:
    """A model drawing on ecoinvent, BAFU, the biosphere and the library, exported and imported
    again: the manifest names both backgrounds with provider and version, the background and
    biosphere references resolve exactly, and the library reference behaves as documented."""
    import base64
    import io
    import json
    import zipfile

    from prism_lca.engine import ecoinvent, guardrails
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.library import ensure_library

    bd = get_bd()
    _seed_ecoinvent(bd)
    ecoinvent.start_bafu_import(str(FIXTURE), project, run_in_thread=False)
    assert ecoinvent.status().state is ecoinvent.JobState.done
    lib = ensure_library()
    bd.Database(lib).write(
        {
            (lib, "mine"): {
                "name": "my own bolt",
                "unit": "kilogram",
                "reference product": "my own bolt",
                "location": "CH",
                "exchanges": [{"input": (lib, "mine"), "amount": 1, "type": "production"}],
            }
        }
    )
    guardrails.set_read_only(lib, False)

    r = client.post("/api/v1/databases/foreground", json={"name": "Mixed"}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/model/activities",
        json={"database": "Mixed", "name": "product", "unit": "kilogram", "location": "CH"},
        headers=token,
    )
    top = r.json()["activity"]["code"]
    for inp_db, inp_code in [
        ("ecoinvent-3.12-cutoff", "elec"),
        ("bafu-2026-v1", "aaaaaaaa-0000-0000-0000-000000000001"),
    ]:
        r = client.post(
            "/api/v1/model/exchanges",
            json={
                "activity_database": "Mixed",
                "activity_code": top,
                "input_database": inp_db,
                "input_code": inp_code,
                "amount": 1.0,
                "type": "technosphere",
            },
            headers=token,
        )
        assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/model/exchanges",
        json={
            "activity_database": "Mixed",
            "activity_code": top,
            "input_database": "biosphere3",
            "input_code": "co2",
            "amount": 0.1,
            "type": "biosphere",
        },
        headers=token,
    )
    assert r.status_code == 200, r.text

    r = client.post(
        "/api/v1/bundle/export", json={"database": "Mixed", "preset": "model"}, headers=token
    )
    assert r.status_code == 200, r.text
    data = base64.b64decode(r.json()["base64"])
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        graph = json.loads(zf.read("graph.json"))
    backgrounds = {b["database"]: b for b in manifest["requires"]["backgrounds"]}
    assert backgrounds["bafu-2026-v1"]["provider"] == "bafu"
    assert backgrounds["bafu-2026-v1"]["version"] == "2026 v1"
    assert backgrounds["ecoinvent-3.12-cutoff"]["provider"] == "ecoinvent"
    assert backgrounds["ecoinvent-3.12-cutoff"]["version"] == "3.12"
    # Licence rule: references only — no BAFU dataset content travels in the file.
    assert not any("Test widget" in json.dumps(a) for a in graph["activities"])
    assert {ref["database"] for ref in graph["references"]} == {
        "ecoinvent-3.12-cutoff",
        "bafu-2026-v1",
        "biosphere3",
    }

    b64 = base64.b64encode(data).decode("ascii")
    r = client.post("/api/v1/bundle/inspect", json={"content": b64}, headers=token)
    assert r.status_code == 200, r.text
    verdicts = {(x["database"], x["code"]): x["verdict"] for x in r.json()["references"]}
    assert all(v == "exact" for v in verdicts.values()), verdicts

    r = client.post(
        "/api/v1/bundle/import", json={"content": b64, "name": "Mixed copy"}, headers=token
    )
    assert r.status_code == 200, r.text
    copy = bd.Database("Mixed copy").get(top)
    inputs = {
        (e.input["database"], e.input["code"])
        for e in copy.exchanges()
        if e["type"] != "production"
    }
    assert ("bafu-2026-v1", "aaaaaaaa-0000-0000-0000-000000000001") in inputs
    assert ("ecoinvent-3.12-cutoff", "elec") in inputs and ("biosphere3", "co2") in inputs

    # A library reference: the bundle carries it as a reference only, so it resolves where that
    # dataset exists — here it does.
    r = client.post(
        "/api/v1/model/exchanges",
        json={
            "activity_database": "Mixed",
            "activity_code": top,
            "input_database": lib,
            "input_code": "mine",
            "amount": 2.0,
            "type": "technosphere",
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/bundle/export", json={"database": "Mixed", "preset": "model"}, headers=token
    )
    b64 = r.json()["base64"]
    r = client.post("/api/v1/bundle/inspect", json={"content": b64}, headers=token)
    assert r.status_code == 200, r.text
    lib_verdict = next(x for x in r.json()["references"] if x["database"] == lib)
    assert lib_verdict["verdict"] == "exact", lib_verdict
    assert lib not in {b["database"] for b in r.json()["manifest"]["requires"]["backgrounds"]}
    r = client.post(
        "/api/v1/bundle/import", json={"content": b64, "name": "Mixed copy 2"}, headers=token
    )
    assert r.status_code == 200, r.text
    copy = bd.Database("Mixed copy 2").get(top)
    assert (lib, "mine") in {(e.input["database"], e.input["code"]) for e in copy.exchanges()}


def test_library_dataset_pointing_at_a_background_is_refused_where_that_background_is_missing(
    client, token, project
) -> None:
    """The library section's own references go through the same ladder as the model's: a receiver
    without the background the sender's library dataset used gets a refusal, not a dangling link."""
    import base64

    from prism_lca.engine import background_reset, ecoinvent
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.library import ensure_library

    bd = get_bd()
    _seed_ecoinvent(bd)
    ecoinvent.start_bafu_import(str(FIXTURE), project, run_in_thread=False)
    lib = ensure_library()
    bd.Database(lib).write(
        {
            (lib, "casing"): {
                "name": "my casing",
                "unit": "kilogram",
                "reference product": "my casing",
                "location": "CH",
                "type": "process",
                "exchanges": [
                    {"input": (lib, "casing"), "amount": 1, "type": "production"},
                    {
                        "input": ("bafu-2026-v1", "aaaaaaaa-0000-0000-0000-000000000002"),
                        "amount": 0.4,
                        "type": "technosphere",
                    },
                ],
            }
        }
    )
    bd.databases[lib]["prism_read_only"] = False
    bd.databases.flush()
    client.post("/api/v1/databases/foreground", json={"name": "Uses casing"}, headers=token)
    r = client.post(
        "/api/v1/model/activities",
        json={"database": "Uses casing", "name": "device", "unit": "unit", "location": "CH"},
        headers=token,
    )
    top = r.json()["activity"]["code"]
    r = client.post(
        "/api/v1/model/exchanges",
        json={
            "activity_database": "Uses casing",
            "activity_code": top,
            "input_database": lib,
            "input_code": "casing",
            "amount": 1,
            "type": "technosphere",
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/bundle/export", json={"database": "Uses casing", "preset": "model"}, headers=token
    )
    data = base64.b64decode(r.json()["base64"])
    section = __import__("json").loads(
        __import__("zipfile").ZipFile(__import__("io").BytesIO(data)).read("library.json")
    )
    assert [ref["database"] for ref in section["references"]] == ["bafu-2026-v1"]

    # The receiver: same project minus BAFU and minus the library dataset.
    for act in list(bd.Database(lib)):
        act.delete()
    background_reset.remove_background("bafu-2026-v1")
    b64 = base64.b64encode(data).decode("ascii")
    look = client.post("/api/v1/bundle/inspect", json={"content": b64}, headers=token).json()
    assert look["summary"]["can_import"] is False
    bafu_ref = next(x for x in look["references"] if x["database"] == "bafu-2026-v1")
    assert bafu_ref["verdict"] == "missing"
    r = client.post(
        "/api/v1/bundle/import", json={"content": b64, "name": "Should fail"}, headers=token
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "bundle_unresolved"
    assert "Should fail" not in bd.databases and len(bd.Database(lib)) == 0  # nothing written


def test_index_hook_appends_new_flows_and_rebuilds_after_a_sync() -> None:
    """After an import the biosphere index follows: appended for added flows, rebuilt for renamed
    ones, both queued behind the database's own build; nothing when no index exists yet."""
    from prism_lca.api.v1.setup import index_after

    class FakeBuilds:
        def __init__(self, calls: list[tuple]) -> None:
            self.calls = calls

        def build_when_free(self, db: str) -> None:
            self.calls.append(("build", db))

        def extend_when_free(self, db: str, codes: list[str]) -> None:
            self.calls.append(("extend", db, tuple(codes)))

    class FakeSearch:
        def __init__(self, indexed: bool = True, building: bool = False) -> None:
            self.calls: list[tuple] = []
            self.indexed, self.building = indexed, building
            self.builds = FakeBuilds(self.calls)

        def index_info(self, db: str) -> dict:
            return {"database": db, "indexed": self.indexed, "building": self.building}

    fake = FakeSearch()
    index_after(fake)("bafu-2026-v1", {"biosphere_added": ["n1", "n2"]})
    assert fake.calls == [("build", "bafu-2026-v1"), ("extend", "biosphere3", ("n1", "n2"))]

    fake = FakeSearch()
    index_after(fake)("ecoinvent-3.12-cutoff", {"biosphere_rebuild": True})
    assert fake.calls == [("build", "ecoinvent-3.12-cutoff"), ("build", "biosphere3")]

    # No biosphere index yet: the database build pulls the flows in itself, as they are by then. Asked
    # only after that build, the fresh index looked like an old one and all 9 850 flows were built a
    # second time — so the question is asked before anything is queued.
    fake = FakeSearch(indexed=False)
    index_after(fake)("ecoinvent-3.12-cutoff", {"biosphere_rebuild": True})
    assert fake.calls == [("build", "ecoinvent-3.12-cutoff")]

    # Being built right now counts as there: that build may have read the flows before this import
    # added its own, and appending is idempotent.
    fake = FakeSearch(indexed=False, building=True)
    index_after(fake)("bafu-2026-v1", {"biosphere_added": ["n1"]})
    assert fake.calls == [("build", "bafu-2026-v1"), ("extend", "biosphere3", ("n1",))]


def test_index_hook_logs_what_it_could_not_line_up(caplog) -> None:
    """A failure stays out of the import (which succeeded) but not out of the log: a debug-only trace
    is how a missing index went unnoticed."""
    import logging

    from prism_lca.api.v1.setup import index_after

    class Refusing:
        def build_when_free(self, db: str) -> None:
            raise RuntimeError("no such database")

    class FakeSearch:
        builds = Refusing()

    with caplog.at_level(logging.WARNING):
        index_after(FakeSearch())("bafu-2026-v1", {})
    assert "bafu-2026-v1" in caplog.text and "no such database" in caplog.text
