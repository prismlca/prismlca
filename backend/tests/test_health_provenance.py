"""The provenance count of the health check: which texts cite a source, which parameters and comments are about a
figure, and how much of the model the cited figures carry."""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from prism_lca.engine.health_provenance import (
    EUROSTAT_TABLES,
    _states_a_figure,
    carries_a_figure,
    cites_a_source,
)

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


def test_a_page_address_without_its_scheme_is_a_source():
    """Models copy addresses out of search results without `https://`. With a path, the address names the
    page the figure is on as exactly as the link would; a wheelbarrow model cited four masses that way."""
    assert cites_a_source("Article weight 100 g (kox-direct.de/garten/zubehoer-schubkarren/holzgriff)")
    assert cites_a_source("Datasheet capito-gmbh.com/files/Downloads/Praktica%202025.pdf, 20.7 kg")
    assert cites_a_source("laut www.example.org/p/12345")
    assert cites_a_source("müba-shop.de/artikel/72971")
    # Still not: a bare domain, a domain with nothing after the slash, ratios and units, an e-mail address.
    assert not cites_a_source("comparable rim (shop.example.com)")
    assert not cites_a_source("see example-shop.de/ for spare parts")
    assert not cites_a_source("frame/tray split 6/11 kg, 1.25 mm/sheet, 830 kg/m3, z. B. Stahl/Holz")
    assert not cites_a_source("ask info@example.de/sales")


def test_the_eurostat_tables_are_the_ones_the_tool_queries():
    """The list here decides what counts as cited; the tool's list decides what the model can cite. A table
    added to the tool and missing here would make its figures count as unsourced again."""
    datasets = Path(__file__).resolve().parents[2] / "frontend/src/main/eurostat/datasets.ts"
    match = re.search(r"EUROSTAT_DATASETS\s*=\s*\[([^\]]*)\]", datasets.read_text(encoding="utf-8"))
    assert match, "EUROSTAT_DATASETS not found in datasets.ts"
    assert set(re.findall(r"'([a-z_]+)'", match.group(1))) == set(EUROSTAT_TABLES)


# --- which parameter states a figure ----------------------------------------------------------


def test_a_parameter_computed_from_others_states_no_figure():
    """`1 - eol_steel_recycling` holds the rate's figure a second time; counted, every cited end-of-life rate
    written with its complement counted twice."""
    assert not _states_a_figure({"amount": 0.013, "formula": "1 - eol_steel_recycling"})
    assert not _states_a_figure({"amount": 6.2, "formula": "m_total - m_boards - m_feet"})
    assert not _states_a_figure({"amount": 6.4, "formula": "n_boards * length * width * thickness * density"})
    assert not _states_a_figure({"amount": 0.0062, "formula": "m_frame / 1000"})  # a unit conversion
    assert _states_a_figure({"amount": 0.987, "formula": None})  # typed
    assert _states_a_figure({"amount": 20.7, "formula": "20.7"})  # a number typed as a formula
    assert _states_a_figure({"amount": 1.0, "formula": "1"})
    assert _states_a_figure({"amount": 0.8, "formula": "m_total * 0.04"})  # the 4 % is a figure of its own
    assert _states_a_figure({"amount": 6.4, "formula": "n_boards * length * width * 0.004 * density"})
    # A constant expression depends on no other parameter: whatever its numbers, it is the figure itself.
    for constant in ("10 / 100", "(10)", "100 + 10", "1e3", "max(10, 100)"):
        assert _states_a_figure({"amount": 1.0, "formula": constant}), constant
    assert not _states_a_figure({"amount": 0.05, "formula": "m_film2 / 1000"})  # a digit in a name
    assert not _states_a_figure({"amount": 7.0, "formula": "max(m_total - m_boards, 0)"})


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


def _set(client, token, db, name, description, **fields) -> None:
    r = client.post(
        "/api/v1/params", json={"database": db, "name": name, "description": description, **fields}, headers=token
    )
    assert r.status_code == 200, r.text


def _quiet(client, token, db) -> bool:
    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    return not any(f["code"] == "unsourced_figures" for f in findings)


def test_the_complement_of_a_cited_rate_is_not_a_second_figure(client, token, project):
    db = _fg(client, token)
    _create(client, token, db, "End of life")
    for material in ("steel", "wood"):
        _set(client, token, db, f"eol_{material}_rec", "Eurostat env_wastrt DE 2024.", amount=0.9)
        _set(client, token, db, f"eol_{material}_inc", "Eurostat env_wastrt DE 2024, the rest.",
             formula=f"1 - eol_{material}_rec")
    for i in range(5):
        _set(client, token, db, f"p{i}", "Own estimate.", amount=1.0 + i)

    # Four of nine would have been quiet; two figures of seven are not.
    assert "2 of 7 parameters" in _provenance(client, token, db)


def test_cited_rates_do_not_stand_in_for_unsourced_masses(client, token, project):
    """Eight cited end-of-life rates of 18 parameters silenced the count on a wheelbarrow model, whatever its
    masses cited. The masses are weighed in kilograms, so citing a small part does not do either."""
    db = _fg(client, token)
    _create(client, token, db, "Wheelbarrow")
    for material in ("steel", "wood", "rubber", "board"):
        _set(client, token, db, f"eol_{material}", "Eurostat env_wastrt DE 2024.", amount=0.9, unit="fraction")
    masses = {"m_total": (20.7, "kg"), "m_tray": (11.0, "kg"), "m_frame": (6.0, "kg"), "m_grips": (200.0, "g"),
              "m_tyre": (1.4, "kg"), "m_box": (0.42, "kg")}
    for name, (amount, unit) in masses.items():
        _set(client, token, db, name, "Typical value.", amount=amount, unit=unit)

    message = _provenance(client, token, db)
    assert "4 of 10 parameters" in message  # a third: the count alone would be quiet
    assert "0 percent of the mass" in message
    assert "do not stand in for the masses" in message

    _set(client, token, db, "m_grips", "100 g each (kox-direct.de/garten/holzgriff)", amount=200.0, unit="g")
    assert "0 percent" in _provenance(client, token, db)  # 0.2 of 39.7 kg

    _set(client, token, db, "m_total", "Datasheet https://www.example.org/praktica.pdf", amount=20.7, unit="kg")
    assert _quiet(client, token, db)


def test_a_count_short_of_a_third_does_not_blame_the_rates(client, token, project):
    """When the count itself is short, the masses are reported for orientation, without the sentence about
    rates standing in for them."""
    db = _fg(client, token)
    _create(client, token, db, "Shelf")
    _set(client, token, db, "m_total", "https://www.example.org/shelf", amount=24.0, unit="kg")
    for i in range(5):
        _set(client, token, db, f"d{i}", "Own estimate.", amount=100.0 + i, unit="km")

    message = _provenance(client, token, db)
    assert "1 of 6 parameters" in message
    assert "100 percent of the mass" in message
    assert "stand in" not in message
