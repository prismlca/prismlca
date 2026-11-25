"""A process code with a slash in it — what a spreadsheet brings in ("P1/2") — works like any other code.

The code is kept as the sheet wrote it: other models, scenario sheets and a re-import refer to it, so changing
it on the way in would break those. Everything that reads a process has to cope instead: the reads take the
code as a query parameter (the server routes on the decoded path, where a slash splits a segment), and a tag
key ``model/code`` is told apart by the model's own name and codes, never at its last slash.
"""
from __future__ import annotations

import io
import uuid
from types import SimpleNamespace

from openpyxl import Workbook

from prism_lca.engine import health
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.phase_attribution import _value_not_reached

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAIN, PART, STEP = "P1/2", "A/B/C", "step/"


def _import_sheet(client, token) -> str:
    """A model imported from a hand-written sheet whose codes carry slashes: P1/2 consumes the other two."""
    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    db = "slash-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    wb = Workbook()
    acts = wb.active
    acts.title = "activities"
    acts.append(["code", "name", "unit", "location", "reference_product", "comment"])
    acts.append([MAIN, "bottle", "unit", "GLO", "bottle", "made from the part"])
    acts.append([PART, "part", "kilogram", "GLO", "part", None])
    acts.append([STEP, "step", "kilogram", "GLO", "step", None])
    exs = wb.create_sheet("exchanges")
    exs.append(["activity_code", "input_database", "input_code", "amount", "type"])
    exs.append([MAIN, db, PART, 0.5, "technosphere"])
    exs.append([MAIN, db, STEP, 0.2, "technosphere"])
    exs.append([PART, "biosphere", "co2", 2.0, "biosphere"])
    buf = io.BytesIO()
    wb.save(buf)
    r = client.post("/api/v1/interop/model", data={"target_database": db},
                    files={"file": ("model.xlsx", buf.getvalue(), _XLSX)}, headers=token)
    assert r.status_code == 200, r.text
    return db


def test_an_imported_code_keeps_its_slash_and_every_read_finds_it(client, token, project):
    del project
    db = _import_sheet(client, token)
    listed = {a["code"] for a in client.get(f"/api/v1/model/activities/{db}", headers=token).json()}
    assert listed == {MAIN, PART, STEP}

    def get(path: str, code: str, **extra):
        r = client.get(f"/api/v1/model/{path}", params={"database": db, "code": code, **extra}, headers=token)
        assert r.status_code == 200, (path, code, r.text)
        return r.json()

    detail = get("activity", MAIN)
    assert detail["activity"]["code"] == MAIN
    assert {e["input"]["code"] for e in detail["exchanges"] if e["type"] == "technosphere"} == {PART, STEP}
    assert get("activity", STEP, detail="review", summary="true")["activity"]["code"] == STEP
    assert get("activity/metadata", MAIN)["comment"] == "made from the part"
    assert get("activity/properties", PART)["code"] == PART
    assert get("activity/properties", MAIN, input="part")["input"]["code"] == PART
    preview = get("delete-preview", PART)
    assert preview["target"]["code"] == PART
    assert [d["code"] for d in preview["dependents"]] == [MAIN]

    assert client.post("/api/v1/model/tags", json={"database": db, "code": PART, "dimension": "Component",
                                                   "value": "Lid"}, headers=token).status_code == 200
    assert get("tags", PART) == [{"dimension": "Component", "value": "Lid"}]
    assert get("tags", MAIN) == []


def test_the_health_checks_read_the_tags_of_a_code_with_a_slash(client, token, project):
    """Split at its last slash, the key "model/P1/2" named a model "model/P1" — the tag went unseen: a model
    whose only phase tag sat on such a process was told it had none, and an end-of-life tag counted nowhere."""
    del project
    db = _import_sheet(client, token)

    def codes() -> list[str]:
        return [f["code"] for f in client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]]

    assert "no_phase_tags" in codes()
    client.post("/api/v1/model/tags", json={"database": db, "code": STEP, "dimension": "Life-cycle phase",
                                            "value": "End of life"}, headers=token)
    assert "no_phase_tags" not in codes()
    at_end_of_life = health._end_of_life(db)
    assert at_end_of_life((db, STEP), None)
    assert not at_end_of_life((db, PART), None)


def test_the_hint_for_a_missing_phase_names_the_dimensions_of_codes_with_a_slash():
    node = SimpleNamespace(act=SimpleNamespace(key=("M", MAIN)))
    fg = SimpleNamespace(nodes={("M", MAIN): node},
                         tag_map={f"M/{MAIN}": [{"dimension": "Component", "value": "Lid"}],
                                  "Other/x": [{"dimension": "Owner", "value": "Team"}]})
    err = _value_not_reached(fg, "Life-cycle phase", "Use", {})
    assert err.hint == "Check the dimension name; the dimensions tagged here are: Component."
