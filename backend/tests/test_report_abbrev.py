from __future__ import annotations

from prism_lca.engine import report_abbreviations as rp
from prism_lca.engine.bootstrap import get_bd


def test_candidates_come_from_the_text_not_from_imagination():
    """Extraction is deterministic on purpose: a model asked to FIND abbreviations invents ones the
    document never used."""
    text = "The GWP100 result and the AP value follow the ISO rules; see the PDF and the EPD."
    got = rp.abbreviation_candidates(text)
    assert "GWP100" in got and "AP" in got and "EPD" in got
    # Document furniture and already-obvious ones are not glossary material.
    assert "ISO" not in got and "PDF" not in got
    # UTC turned up in a live run purely because our own colophon prints a timestamp — a reader of an
    # LCA report does not need "coordinated universal time" explained.
    assert "UTC" not in rp.abbreviation_candidates("Generated on 2026-07-26 19:00 UTC.")


def test_units_can_be_added_as_known_terms():
    got = rp.abbreviation_candidates("A plain sentence.", extra=["kg CO2-eq"])
    assert got == ["kg CO2-eq"]


def test_only_expansions_for_real_candidates_are_kept():
    """The guard that makes asking a model safe: it cannot add an entry for something absent."""
    accepted = rp.accept_abbreviations(
        ["GWP", "AP"],
        {"GWP": "Global warming potential", "gwp": "second spelling", "XYZ": "invented", "AP": ""},
    )
    # First valid expansion wins — a predictable result rather than one that depends on dict order.
    assert accepted == {"GWP": "Global warming potential"}
    assert "XYZ" not in accepted  # never mentioned in the document
    assert "AP" not in accepted  # an empty expansion is not an expansion


def test_an_expansion_that_merely_repeats_the_acronym_is_refused():
    assert rp.accept_abbreviations(["GWP"], {"GWP": "gwp"}) == {}


def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("ab").write(
        {
            ("ab", "a"): {
                "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
                "exchanges": [
                    {"input": ("ab", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("IPCC 2021", "climate change", "GWP100")).write([(("biosphere", "co2"), 1.0)])


def test_the_endpoint_finds_candidates_and_stores_only_accepted_ones(client, token, project):
    _seed(get_bd())
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "ab", "methods": [["IPCC 2021", "climate change", "GWP100"]],
              "subjects": [{"database": "ab", "code": "a"}],
              "sections": [{"kind": "lcia"}, {"kind": "abbreviations"}]},
        headers=token,
    ).json()
    base = f"/api/v1/report/one/ab/{rep['id']}"

    found = client.post(f"{base}/abbreviations", json={}, headers=token).json()
    assert "GWP100" in found["candidates"]  # it is in the method name, hence in the document

    r = client.post(
        f"{base}/abbreviations/set",
        json={"resolved": {"GWP100": "Global warming potential over 100 years", "NOPE": "invented"}},
        headers=token,
    ).json()
    assert r["resolved"] == {"GWP100": "Global warming potential over 100 years"}
    assert r["dropped"] == ["NOPE"]

    from prism_lca.engine import report_typst

    main = report_typst.document_text(client.post(f"{base}/sources", json={}, headers=token).json()["files"])
    assert "Abbreviations" in main and "Global warming potential over 100 years" in main
    assert client.post(f"{base}/pdf", json={}, headers=token).status_code == 200


def test_the_glossary_section_says_so_when_nothing_is_resolved(client, token, project):
    _seed(get_bd())
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "ab", "lang": "de", "methods": [["IPCC 2021", "climate change", "GWP100"]],
              "subjects": [{"database": "ab", "code": "a"}], "sections": [{"kind": "abbreviations"}]},
        headers=token,
    ).json()
    main = client.post(f"/api/v1/report/one/ab/{rep['id']}/sources", json={}, headers=token).json()["files"]["main.typ"]
    assert "Abkürzungsverzeichnis" in main and "Noch keine Abkürzungen" in main


# ---- the glossary against the finished document ----------------------------------------------
def test_an_entry_whose_term_no_longer_appears_is_left_out(client, token, project):
    """The glossary was built once and then went stale in silence: delete the chapter that used a term
    and the report kept explaining it. Filtered at render time, against the document as it now is."""
    from prism_lca.engine import report_render

    report = {
        "lang": "en",
        "abbreviations": {"LDPE": "Low-density polyethylene", "PVC": "Polyvinyl chloride"},
        "sections": [
            {"id": "p", "kind": "prose", "order": 0, "text": "The LDPE film dominates."},
            {"id": "a", "kind": "abbreviations", "order": 1},
        ],
    }
    blocks, _ = report_render.blocks_for(report, {}, {"results": []}, None, {}, {})
    table = next(b for b in blocks if b.get("label") == "t-abbreviations")
    assert [row[0] for row in table["rows"]] == ["LDPE"]  # PVC appears nowhere in the document


def test_acronyms_used_without_an_explanation_are_reported(client, token, project):
    """The other half: a newly written chapter brings terms nobody has explained. Reported, never
    invented — explaining stays an explicit step."""
    from prism_lca.engine import report_render

    report = {
        "lang": "en",
        "abbreviations": {"LDPE": "Low-density polyethylene"},
        "sections": [
            {"id": "p", "kind": "prose", "order": 0, "text": "The LDPE film dominates, and GWP100 rises."},
            {"id": "a", "kind": "abbreviations", "order": 1},
        ],
    }
    _sources, info = report_render.render_sources(report, {}, {"results": []}, None)
    assert info["unexplained_abbreviations"] == ["GWP100"]


def test_nothing_is_reported_without_the_chapter(client, token, project):
    """A report that carries no glossary is not missing one."""
    from prism_lca.engine import report_render

    report = {"lang": "en", "sections": [{"id": "p", "kind": "prose", "order": 0, "text": "GWP100 rises."}]}
    _sources, info = report_render.render_sources(report, {}, {"results": []}, None)
    assert info["unexplained_abbreviations"] == []


def test_an_address_lends_no_acronym():
    # A researched source's URL: its path segments look like acronyms and are none.
    text = "Regulation (EC) No 1223/2009, https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32009R1223 (ALL)."
    got = rp.abbreviation_candidates(text)
    assert "EC" in got and "ALL" in got
    assert "TXT" not in got and "CELEX" not in got
