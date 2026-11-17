"""The provenance count of the health check: which texts cite a source, and which comments are about a figure."""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from prism_lca.engine.health_provenance import EUROSTAT_TABLES, carries_a_figure, cites_a_source

# --- which text cites a source -----------------------------------------------------------------


def test_a_link_or_a_doi_is_a_source():
    assert cites_a_source("11 kg per the retailer (https://www.example.org/spare-tray-150l)")
    assert cites_a_source("Measured, see doi:10.1000/xyz")
    assert cites_a_source("Measured, see https://doi.org/10.1000/xyz")


def test_a_table_of_the_eurostat_tool_is_a_source():
    """A figure the model took from `eurostat_eol` is cited by its table code, not by a link — and was
    counted as unsourced, so four end-of-life rates from the tool made a documented model look bare."""
    assert cites_a_source("Recycling rate paper packaging DE 2024: 86.8 % (Eurostat env_waspac W150101).")
    assert cites_a_source("Landfill share of residual waste (Eurostat env_wasmun DE 2024: 0.5/30.98).")
    assert cites_a_source("Share recycled (env_wastrt W074, DE 2024: RCV_R_B 83.6 %).")  # without the word
    assert cites_a_source("ENV_WASOPER, DE, 2022")


def test_prose_and_bare_domains_are_not_sources():
    assert not cites_a_source("Own estimate, no published mass.")
    assert not cites_a_source("ASSUMPTION: typical industry value.")
    # A shop's domain names where to start looking, not the page the figure is on.
    assert not cites_a_source("Grip diameter 32 mm (retailer listing example-shop.de), length estimated.")
    # Look-alikes of a table code: a parameter name, a longer identifier.
    assert not cites_a_source("Share incinerated = 1 - eol_karton_rec")
    assert not cites_a_source("see env_waspac_share for the split")


def test_the_eurostat_tables_are_the_ones_the_tool_queries():
    """The list here decides what counts as cited; the tool's list decides what the model can cite. A table
    added to the tool and missing here would make its figures count as unsourced again."""
    datasets = Path(__file__).resolve().parents[2] / "frontend/src/main/eurostat/datasets.ts"
    match = re.search(r"EUROSTAT_DATASETS\s*=\s*\[([^\]]*)\]", datasets.read_text(encoding="utf-8"))
    assert match, "EUROSTAT_DATASETS not found in datasets.ts"
    assert set(re.findall(r"'([a-z_]+)'", match.group(1))) == set(EUROSTAT_TABLES)


# --- which comment is about a figure -----------------------------------------------------------

DB = "fg-model"


def _ex(amount, *, own=True, formula=None, kind="technosphere"):
    return {"type": kind, "amount": amount, "formula": formula, "input": (DB if own else "ecoinvent", "x")}


def _figure(amount, unit="unit", **kw) -> bool:
    return carries_a_figure(_ex(amount, **kw), DB, unit)


def test_one_piece_of_the_own_process_is_structure_not_a_figure():
    """ "1 tray per wheelbarrow": the product's structure. It cannot have a source, and counting its comment
    lowered the share of a model that sourced every figure it had."""
    assert not _figure(1.0)
    assert not _figure(1.0, formula="1")  # typed as a formula, still a typed 1
    assert not _figure(-1.0)  # one piece of the own end-of-life process
    # Units this app has no dimension for are pieces too: models name them in their own language.
    for unit in ("Stück", "Pack", "Paar", "Satz", "item"):
        assert not _figure(1.0, unit), unit


def test_the_reference_flow_is_not_a_figure_whatever_its_unit():
    assert not _figure(1.0, "kilogram", kind="production")
    assert _figure(0.3, "kilogram", kind="production")  # a co-product's share is one


def test_one_kilogram_of_the_own_process_is_a_quantity():
    """A typed 1 kg or 1 kWh of an own process is as much an assumption as 1000 g would be."""
    assert _figure(1.0, "kilogram")
    assert _figure(-1.0, "kg")  # one kilogram to the own end-of-life process
    assert _figure(1.0, "kilowatt hour")
    assert _figure(1.0, "hour")


def test_a_dormant_switch_is_not_a_figure():
    """A scenario branch at zero in the baseline: its figures sit in the parameters that switch it."""
    assert not _figure(0.0, "kilogram", own=False, formula="m_steel * share_eaf")
    assert not _figure(0.0, "kilogram", own=False, formula="m_rim/(1-loss_sheet)*share_eaf")
    assert not _figure(0.0, "ton kilometer", own=False, formula="(m_total+m_box)/1000*d_sea*share_sea")
    assert not _figure(0, "kilogram", own=False)


def test_a_dormant_switch_with_a_figure_in_its_formula_is_one():
    """`250 * use_sea_freight`: the 250 km are described by no parameter, so the exchange comment is the only
    place their source can stand — even while the branch is switched off."""
    assert _figure(0.0, "ton kilometer", own=False, formula="0.0207 * 250 * use_sea_freight")
    assert _figure(0.0, "kilogram", own=False, formula="m_steel * 0.85 * share_eaf")
    assert not _figure(0.0, "kilogram", own=False, formula="m_film2 * share_alt")  # a digit in a name


def test_quantities_are_figures():
    assert _figure(0.6, "kilogram")  # 0.6 kg of a foreground part
    assert _figure(1.0, formula="n_shelves")  # a parameter moves it
    assert _figure(5.0)  # five pieces typed: a count somebody chose
    assert _figure(1.0, "kilowatt hour", own=False)  # 1 kWh of electricity is an estimate
    assert _figure(1.0, "unit", own=False)  # one background item is a quantity, too
    assert _figure(-1.65, "kilogram", own=False, formula="-m_tyre")
    assert _figure(0.02, "kilogram", own=False, kind="biosphere")


# --- the count, end to end ---------------------------------------------------------------------


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name, unit="unit") -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": unit}, headers=token
    ).json()["activity"]["code"]


def _linked(client, token, db, consumer, provider, amount, comment) -> None:
    uid = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": consumer, "input_database": db,
              "input_code": provider, "amount": amount},
        headers=token,
    ).json()["exchange"]["uid"]
    client.post(
        "/api/v1/model/exchanges/comment",
        json={"activity_database": db, "activity_code": consumer, "uid": uid, "comment": comment},
        headers=token,
    )


def _provenance(client, token, db) -> str:
    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    hit = [f for f in findings if f["code"] == "unsourced_figures"]
    assert len(hit) == 1, findings
    return hit[0]["message"]


def test_the_count_takes_eurostat_codes_and_leaves_out_structure(client, token, project):
    db = _fg(client, token)
    product, tray, frame = (_create(client, token, db, n) for n in ("Wheelbarrow", "Tray", "Frame"))
    steel = _create(client, token, db, "Steel sheet", "kilogram")
    _linked(client, token, db, product, tray, 1.0, "1 tray per wheelbarrow.")  # structure
    _linked(client, token, db, product, frame, 0.0, "Scenario switch, 0 in the baseline.")  # dormant
    _linked(client, token, db, tray, frame, 0.4, "Own estimate.")  # a figure, unsourced
    _linked(client, token, db, frame, steel, 1.0, "One kilogram, own estimate.")  # a quantity, unsourced
    descriptions = [
        "Article weight 20.7 kg (https://www.example.org/datasheet)",
        "Recycling rate DE 2024: 86.8 % (Eurostat env_waspac W150101).",
        "Own estimate.",
        "Own estimate.",
        "Own estimate.",
        "Own estimate.",
        "Own estimate.",
    ]
    for i, text in enumerate(descriptions):
        r = client.post(
            "/api/v1/params",
            json={"database": db, "name": f"p{i}", "amount": 1.0 + i, "description": text},
            headers=token,
        )
        assert r.status_code == 200, r.text

    message = _provenance(client, token, db)
    assert "2 of 7 parameters" in message  # the link and the Eurostat table
    assert "0 of 2 process/exchange comments" in message  # the 0.4 pieces and the one kilogram
    assert "Eurostat" in message  # the model is told what counts
