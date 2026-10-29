from __future__ import annotations

import uuid

from prism_lca.engine.bootstrap import get_bd

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission",
                                "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("src").write(
        {
            ("src", "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity",
                "exchanges": [
                    {"input": ("src", "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("src", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "exchanges": [
                    {"input": ("src", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("src", "elec"), "amount": 2, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _lcia(client, token, db, code):
    return client.post("/api/v1/calc/lcia",
                       json={"database": db, "code": code, "method": ["test", "gwp"]},
                       headers=token).json()["score"]


def test_model_export_import_roundtrip(client, token, project):
    _seed(get_bd())

    # export src model
    r = client.get("/api/v1/interop/model/src", headers=token)
    assert r.status_code == 200, r.text
    assert _XLSX in r.headers["content-type"]
    workbook = r.content

    # import into a fresh foreground db
    dst = "dst-" + uuid.uuid4().hex[:6]
    client.post("/api/v1/databases/foreground", json={"name": dst}, headers=token)
    imp = client.post(
        "/api/v1/interop/model",
        data={"target_database": dst},
        files={"file": ("model.xlsx", workbook, _XLSX)},
        headers=token,
    )
    assert imp.status_code == 200, imp.text
    body = imp.json()
    assert body["activities"] == 2
    assert body["exchanges"] == 3  # bottle: elec + co2; elec: co2 (production edges are implicit)

    # the imported model is self-contained and reproduces the original result
    assert abs(_lcia(client, token, dst, "bottle") - 1.1) < 1e-6

    # undo removes the whole import
    client.post("/api/v1/model/undo", headers=token)
    assert client.get(f"/api/v1/model/activities/{dst}", headers=token).json() == []


def test_import_rejects_unlinked_atomically(client, token, project):
    _seed(get_bd())
    dst = "dst-" + uuid.uuid4().hex[:6]
    client.post("/api/v1/databases/foreground", json={"name": dst}, headers=token)

    # build a workbook by hand with a dangling input
    import io

    from openpyxl import Workbook

    wb = Workbook()
    a = wb.active
    a.title = "activities"
    a.append(["code", "name", "unit", "location", "reference_product", "comment"])
    a.append(["w1", "widget", "unit", "GLO", "widget", None])
    e = wb.create_sheet("exchanges")
    e.append(["activity_code", "input_database", "input_code", "amount", "type"])
    e.append(["w1", "nowhere", "ghost", 1.0, "technosphere"])
    buf = io.BytesIO()
    wb.save(buf)

    r = client.post(
        "/api/v1/interop/model",
        data={"target_database": dst},
        files={"file": ("bad.xlsx", buf.getvalue(), _XLSX)},
        headers=token,
    )
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "import_unlinked"
    # nothing was written
    assert client.get(f"/api/v1/model/activities/{dst}", headers=token).json() == []


# --- what the sheet used to drop -------------------------------------------------------------------

def _fg(client, token, name):
    assert client.post("/api/v1/databases/foreground", json={"name": name},
                       headers=token).status_code == 200
    return name


def test_the_sheet_carries_formula_uncertainty_comment_and_tags(client, token, project):
    """The docstring said "round-trips losslessly" and meant the skeleton: a parameterised amount
    came back as a bare number, and the distribution and the tags were dropped without a word."""
    del project
    db = _fg(client, token, "InteropRich")
    a = client.post("/api/v1/model/activities", json={"database": db, "name": "bottle",
                                                      "unit": "kilogram"},
                    headers=token).json()["activity"]["code"]
    b = client.post("/api/v1/model/activities", json={"database": db, "name": "granulate",
                                                      "unit": "kilogram"},
                    headers=token).json()["activity"]["code"]
    client.post("/api/v1/params", json={"database": db, "name": "mass_kg", "amount": 2.0}, headers=token)
    client.post("/api/v1/model/exchanges",
                json={"activity_database": db, "activity_code": a, "input_database": db,
                      "input_code": b, "amount": 2.0, "type": "technosphere"}, headers=token)
    client.post("/api/v1/model/tags", json={"database": db, "code": a,
                                            "dimension": "Life-cycle phase", "value": "Production"},
                headers=token)
    detail = client.get(f"/api/v1/model/activities/{db}/{a}", headers=token).json()
    uid = next(e["uid"] for e in detail["exchanges"] if e["type"] == "technosphere")
    client.post("/api/v1/params/exchange-formula",
                json={"activity_database": db, "activity_code": a, "uid": uid,
                      "formula": "mass_kg * 1.5"}, headers=token)
    client.post("/api/v1/model/exchanges/uncertainty",
                json={"activity_database": db, "activity_code": a, "uid": uid,
                      "distribution": "lognormal", "params": {"median": 3.0, "gsd": 1.2}},
                headers=token)

    xlsx = client.get(f"/api/v1/interop/model/{db}", headers=token)
    assert xlsx.status_code == 200

    from prism_lca.engine.interop import read_model_workbook

    parsed = read_model_workbook(xlsx.content)
    act_row = next(r for r in parsed["activities"] if r["code"] == a)
    assert act_row["tags"] == "Life-cycle phase=Production"
    ex_row = next(r for r in parsed["exchanges"] if r["type"] == "technosphere")
    assert ex_row["formula"] == "mass_kg * 1.5"
    assert ex_row["uncertainty_type"] == 2  # lognormal
    assert ex_row["scale"]

    # …and back in, which is the half that matters. The XLSX import needs its target to exist —
    # unlike a bundle, which brings its own model.
    _fg(client, token, "InteropBack")
    r = client.post("/api/v1/interop/model",
                    data={"target_database": "InteropBack", "source": "import"},
                    files={"file": ("model.xlsx", xlsx.content,
                                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                    headers=token)
    assert r.status_code == 200, r.text
    # The sheet has no parameters, so `mass_kg` is unknown in the target — the import says so and
    # keeps the formula rather than dropping it or failing.
    assert "mass_kg" in (r.json().get("formulas_unresolved") or "")
    back = client.get(f"/api/v1/model/activities/InteropBack/{a}", headers=token).json()
    ex_back = next(e for e in back["exchanges"] if e["type"] == "technosphere")
    assert ex_back.get("formula") == "mass_kg * 1.5"
    # The exchange detail does not surface the distribution (it is edited through its own endpoint),
    # so read it where it lives.
    from prism_lca.engine.model import exchange_uncertainty_snapshot

    snap = exchange_uncertainty_snapshot("InteropBack", a, ex_back["uid"])
    assert snap.get("uncertainty type") == 2
    assert snap.get("scale")
    tags = client.get(f"/api/v1/model/tags/InteropBack/{a}", headers=token).json()
    assert {(t["dimension"], t["value"]) for t in tags} == {("Life-cycle phase", "Production")}


def test_a_production_amount_other_than_one_survives_the_round_trip(client, token, project):
    """The sheet dropped every production row and the import gave each activity a
    production of 1 — a process making 2 kWh came back making 1, its emissions unchanged, so the
    balance per unit silently doubled."""
    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission",
                                "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("src2").write(
        {
            ("src2", "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity",
                "exchanges": [
                    {"input": ("src2", "elec"), "amount": 2, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("src2", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "exchanges": [
                    {"input": ("src2", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("src2", "elec"), "amount": 2, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])
    # 0.1 direct + 2 kWh at 0.5 kg per 2 kWh produced.
    assert abs(_lcia(client, token, "src2", "bottle") - 0.6) < 1e-6

    workbook = client.get("/api/v1/interop/model/src2", headers=token).content
    dst = "dst-" + uuid.uuid4().hex[:6]
    client.post("/api/v1/databases/foreground", json={"name": dst}, headers=token)
    imp = client.post(
        "/api/v1/interop/model",
        data={"target_database": dst},
        files={"file": ("model.xlsx", workbook, _XLSX)},
        headers=token,
    )
    assert imp.status_code == 200, imp.text
    production = [
        e for e in client.get(f"/api/v1/model/activities/{dst}/elec", headers=token).json()["exchanges"]
        if e["type"] == "production"
    ]
    assert len(production) == 1, production
    assert production[0]["amount"] == 2
    assert abs(_lcia(client, token, dst, "bottle") - 0.6) < 1e-6


def test_import_as_model_creates_the_model_and_reproduces_the_result(client, token, project):
    """The app's way in (JSON, base64): a new model in one step, self-contained like the round trip above."""
    import base64

    _seed(get_bd())
    workbook = client.get("/api/v1/interop/model/src", headers=token).content
    name = "sheet-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/interop/model/import",
                    json={"name": name, "content": base64.b64encode(workbook).decode()}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["database"] == name
    assert abs(_lcia(client, token, name, "bottle") - 1.1) < 1e-6
    # The same name again is refused before anything is written.
    again = client.post("/api/v1/interop/model/import",
                        json={"name": name, "content": base64.b64encode(workbook).decode()}, headers=token)
    assert again.status_code == 409, again.text


def test_import_as_model_leaves_no_empty_model_behind_when_refused(client, token, project):
    import base64

    names = lambda: {d["name"] for d in client.get("/api/v1/databases", headers=token).json()}  # noqa: E731
    before = names()
    junk = client.post("/api/v1/interop/model/import",
                       json={"name": "junk-model", "content": base64.b64encode(b"not a workbook").decode()},
                       headers=token)
    assert junk.status_code == 400 and junk.json()["error"]["code"] == "sheet_unreadable"

    # A real sheet whose input does not exist here: refused, and the model created for it is gone again.
    _seed(get_bd())
    workbook = client.get("/api/v1/interop/model/src", headers=token).content
    client.post("/api/v1/databases/foreground/delete", json={"database": "src"}, headers=token)
    get_bd().Database("biosphere").delete(warn=False)
    refused = client.post("/api/v1/interop/model/import",
                          json={"name": "orphan-model", "content": base64.b64encode(workbook).decode()},
                          headers=token)
    assert refused.status_code == 422, refused.text
    assert "orphan-model" not in names()
    assert "junk-model" not in names()
    assert before <= names()
