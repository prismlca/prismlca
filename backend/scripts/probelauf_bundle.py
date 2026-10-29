"""End-to-end bundle check with REAL BAFU data, in the throwaway project of ``probelauf_bafu.py``
(never the working project): build a model that draws on a BAFU dataset, a biosphere flow and two
library datasets (one of which itself draws on BAFU), export it, empty the library, import the
bundle under a new name, and verify what came back.

    cd backend
    uv run python scripts/probelauf_bundle.py --scratch /tmp/prism-bafu-probelauf
"""

from __future__ import annotations

import argparse
import io
import json
import os
import zipfile
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--scratch", type=Path, required=True)
    ap.add_argument("--project", default="probelauf")
    args = ap.parse_args()
    os.environ["BRIGHTWAY2_DIR"] = str(args.scratch)
    os.environ.setdefault("PRISM_DATA_DIR", str(args.scratch / "prism"))

    from prism_lca.engine import bundle as _bundle
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.guardrails import set_read_only
    from prism_lca.engine.library import ensure_library

    bd = get_bd()
    bd.projects.set_current(args.project)

    bafu = next(n for n in bd.databases if n.startswith("bafu-"))
    acts = list(bd.Database(bafu))
    grid = next(
        a
        for a in acts
        if a["name"].startswith("Electricity, low voltage, at grid") and a["location"] == "CH"
    )
    steel = next(a for a in acts if "steel" in a["name"].lower() and a["unit"] == "kilogram")
    bio = bd.Database("biosphere3")
    co2 = next(
        f for f in bio if f["name"] == "Carbon dioxide, fossil" and f["categories"] == ("air",)
    )
    print(
        f"[data] {bafu}: {grid['name']} [{grid['location']}], {steel['name']} [{steel['location']}]"
    )

    lib = ensure_library()
    ldb = bd.Database(lib)
    for code in ("pl-housing", "pl-frame"):
        try:
            ldb.get(code).delete()
        except Exception:  # noqa: BLE001
            pass
    frame = ldb.new_activity(
        code="pl-frame",
        name="probelauf frame",
        unit="kilogram",
        location="CH",
        type="process",
        **{"reference product": "frame"},
    )
    frame.save()
    frame.new_edge(input=frame, amount=1, type="production", unit="kilogram").save()
    frame.new_edge(input=steel, amount=1.05, type="technosphere", unit="kilogram").save()
    housing = ldb.new_activity(
        code="pl-housing",
        name="probelauf housing",
        unit="unit",
        location="CH",
        type="process",
        **{"reference product": "housing"},
    )
    housing.save()
    housing.new_edge(input=housing, amount=1, type="production", unit="unit").save()
    housing.new_edge(
        input=frame, amount=0.8, type="technosphere", unit="kilogram", formula="0.8 * scrap"
    ).save()
    bd.databases[lib]["prism_read_only"] = False
    bd.databases.flush()

    for name in ("Probelauf device", "Probelauf device (re-imported)"):
        if name in bd.databases:
            bd.Database(name).delete(warn=False)
            del bd.databases[name]
    model = bd.Database("Probelauf device")
    model.register()
    set_read_only("Probelauf device", False)
    top = "device"
    device = model.new_activity(
        code=top,
        name="device",
        unit="unit",
        location="CH",
        type="process",
        **{"reference product": "device"},
    )
    device.save()
    device.new_edge(input=device, amount=1, type="production", unit="unit").save()
    device.new_edge(input=grid, amount=12.0, type="technosphere", unit=grid["unit"]).save()
    device.new_edge(input=housing, amount=1.0, type="technosphere", unit="unit").save()
    device.new_edge(input=co2, amount=0.5, type="biosphere", unit="kilogram").save()

    data = _bundle.export_bundle("Probelauf device")
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        library = json.loads(zf.read("library.json"))
        graph = json.loads(zf.read("graph.json"))
    print(f"[export] {len(data)} bytes; requires {manifest['requires']['backgrounds']}")
    print(
        f"[export] library datasets: {[d['code'] for d in library['datasets']]}; library refs: {[(x['database'], x['name']) for x in library['references']]}"
    )
    assert [d["code"] for d in library["datasets"]] == ["pl-frame", "pl-housing"]
    assert graph["references"] and not any(
        "probelauf frame" in json.dumps(a) for a in graph["activities"]
    )
    # Names travel as references; dataset content (a BAFU comment) never does — the file is a ZIP,
    # so look inside the members, not at the compressed bytes.
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        members = "".join(zf.read(n).decode("utf-8") for n in zf.namelist())
    ref_names = {x["name"] for x in graph["references"]} | {
        x["name"] for x in library["references"]
    }
    assert steel["name"] in ref_names and "Carbon dioxide, fossil" in ref_names
    assert grid["name"] in ref_names
    if grid.get("comment"):
        assert grid["comment"][:60] not in members

    # The original's number, taken now — emptying the library below leaves the original dangling.
    import bw2calc as bc

    method = next(
        m
        for m in bd.methods
        if m[0] == "IPCC 2021" and "total (excl. biogenic CO2)" in m[1] and "GWP100" in m[2]
    )
    lca = bc.LCA({bd.Database("Probelauf device").get(top): 1}, method=method)
    lca.lci()
    lca.lcia()
    a = lca.score

    # The receiver: library emptied; BAFU and biosphere present. Inspect and import through the
    # same engine functions the API calls — in this thread, so the SQLite file has one connection.
    for act in list(ldb):
        act.delete()
    from prism_lca.engine.bundle_resolve import resolve, summary
    from prism_lca.engine.commands import ImportBundleCommand

    opened = _bundle.read_bundle(data)
    resolutions = resolve(_bundle.bundle_references(opened), _bundle.installed_for_bundle(opened))
    carried = _bundle.library_codes(opened["sections"].get("library"))
    print(f"[inspect] {summary(resolutions)} library carried={len(carried)}")
    assert summary(resolutions)["can_import"] is True and len(carried) == 2
    mapping = {
        (r.reference.database, r.reference.code): (r.database, r.code)
        for r in resolutions
        if r.resolved
    }
    result = ImportBundleCommand(
        opened=opened, mapping=mapping, name="Probelauf device (re-imported)"
    ).execute()
    print(f"[import] {result}")
    assert result["library"] == {"added": 2, "kept": 0}

    copy = bd.Database("Probelauf device (re-imported)").get(top)
    inputs = {
        (e.input["database"], e.input["code"]): e
        for e in copy.exchanges()
        if e["type"] != "production"
    }
    assert (
        (bafu, grid["code"]) in inputs
        and (lib, "pl-housing") in inputs
        and ("biosphere3", co2["code"]) in inputs
    )
    housing2 = ldb.get("pl-housing")
    frame_link = next(e for e in housing2.exchanges() if e["type"] == "technosphere")
    assert frame_link.input["code"] == "pl-frame" and frame_link.get("formula") == "0.8 * scrap"
    frame2 = ldb.get("pl-frame")
    steel_link = next(e for e in frame2.exchanges() if e["type"] == "technosphere")
    assert steel_link.input["database"] == bafu and steel_link.input["code"] == steel["code"]
    assert (
        housing2["prism_import_format"] == "prism-bundle"
        and housing2["prism_import_batch"] == frame2["prism_import_batch"]
    )

    # And the number: the copy must score exactly like the original (same links, same data).
    lca2 = bc.LCA({copy: 1}, method=method)
    lca2.lci()
    lca2.lcia()
    print(f"[score] original {a:.6g} kg CO2-eq, re-imported {lca2.score:.6g} kg CO2-eq")
    assert abs(a - lca2.score) <= 1e-9 * max(1.0, abs(a))
    print("[ok] export → import round trip with BAFU, biosphere and library links holds")


if __name__ == "__main__":
    main()
