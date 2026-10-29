from __future__ import annotations

from prism_lca.engine import report_prompts as rp

DATA = {
    "study": {"goal": "Compare two bottles", "functional_unit": "1 bottle"},
    "activity": {"name": "PET bottle", "database": "m", "code": "c"},
    "amount": 1.0,
    "results": [{"method": ["IPCC 2021", "GWP100"], "method_label": "IPCC 2021 / GWP100", "unit": "kg CO2-eq", "score": 0.412}],
    "contribution": {
        "dimension": "Phase",
        "unit": "kg CO2-eq",
        "groups": [{"key": "Production", "impact": 0.31, "share": 0.75, "share_percent": 75.0}],
        "top": {"key": "Production", "impact": 0.31, "share": 0.75, "share_percent": 75.0},
    },
    "subjects": [],
    "parameters": [],
    "scenarios": [],
    "provenance": {},
}


def _add_prose(client, token, rep, database=None):
    """Add a free prose chapter and return it.

    The default structure used to include an anonymous "Written chapter", and these tests borrowed it.
    It now starts with the concrete ISO chapters instead (methods, interpretation checks, conclusions),
    so a test that needs a prose chapter asks for one.
    """
    db = database or rep.get("database") or "pr"
    return client.post(
        f"/api/v1/report/one/{db}/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()


def test_a_correctly_written_chapter_passes():
    """The gate must not punish the very thing it asks for: a placeholder resolves to a number, and
    searching the resolved text for numbers would flag every correct placeholder."""
    text = (
        "The result is {{results.0.score}} {{results.0.unit}}, dominated by "
        "{{contribution.top.key}} at {{contribution.top.share_percent}} %; see {{ref:t-lcia}}."
    )
    verdict = rp.check_proposal(text, {"kind": "prose"}, DATA)
    assert verdict["ok"], verdict["findings"]
    assert "0.412" in verdict["resolved"]


def test_a_literal_number_is_flagged_with_a_reason():
    verdict = rp.check_proposal("The result is 0.412 kg CO2-eq.", {"kind": "prose"}, DATA)
    assert not verdict["ok"]
    kinds = [f["kind"] for f in verdict["findings"]]
    assert "literal_number" in kinds
    assert "recomputed" in verdict["findings"][0]["detail"]


def test_a_nested_derivation_is_refused_instead_of_printing_raw():
    """{{sum(a, sum(b, c))}} matches no placeholder regex, so it was invisible to the gate AND the
    renderer — two of them printed raw in a client PDF. `sum` is variadic; the nesting
    was never needed, and the finding says so."""
    verdict = rp.check_proposal(
        "The total is {{sum(results.0.score, sum(results.1.score, results.2.score))}} kg.",
        {"kind": "prose"},
        DATA,
    )
    assert not verdict["ok"]
    kinds = [f["kind"] for f in verdict["findings"]]
    assert "malformed_placeholder" in kinds
    detail = next(f["detail"] for f in verdict["findings"] if f["kind"] == "malformed_placeholder")
    assert "sum(a, b, c" in detail and "nest" in detail

    # The flat, legal form stays untouched.
    flat = rp.check_proposal(
        "The total is {{sum(results.0.score, results.0.score)}} kg CO2-eq.", {"kind": "prose"}, DATA
    )
    assert "malformed_placeholder" not in [f["kind"] for f in flat["findings"]]


def test_a_prose_placeholder_mid_sentence_is_a_second_opinion_not_a_block():
    """V295's shape: {{study.goal}} where a value belongs dumps the whole goal paragraph into the
    sentence. The path is legal and standalone use is common, so this is advisory — the chapter
    still passes, the writer report shows the remark in grey."""
    data = dict(DATA)
    data["study"] = {
        **(DATA.get("study") or {}),
        "goal": "Screening LCA of a 10 L watering can made from almost entirely recycled plastic "
        "with a post-consumer share above 50 percent, for internal product assessment purposes.",
    }
    verdict = rp.check_proposal(
        "The product carries a post-consumer share of more than {{study.goal}}.",
        {"kind": "prose"},
        data,
    )
    kinds = [f["kind"] for f in verdict["findings"]]
    assert "prose_placeholder_in_sentence" in kinds
    assert verdict["ok"], "advisory findings must not block"


def test_a_prose_placeholder_standing_alone_stays_unremarked():
    data = dict(DATA)
    data["study"] = {
        **(DATA.get("study") or {}),
        "goal": "Screening LCA of a 10 L watering can made from almost entirely recycled plastic "
        "with a post-consumer share above 50 percent, for internal product assessment purposes.",
    }
    verdict = rp.check_proposal("The recorded goal reads: {{study.goal}}", {"kind": "prose"}, data)
    kinds = [f["kind"] for f in verdict["findings"]]
    assert "prose_placeholder_in_sentence" not in kinds


def test_single_variant_caution_names_the_model_scenarios_instead_of_denying_them():
    """V293: the caution told the writer nothing supports a scenario comparison while the model
    carried a computed one — and the writer obeyed, denying a sensitivity analysis that existed."""
    report = {"options": {}}
    data = {
        "subjects": [{"label": "Baseline", "results": [{"score": 1.0}]}],
        "scenarios": [{"name": "Mehr Deponierung", "overrides": {"eol_landfill_share": 0.5}}],
    }
    notes = rp.cautions(report, data)
    hit = next(n for n in notes if "compare_scenarios" in n)
    assert "Mehr Deponierung" in hit
    assert "Never state that no sensitivity analysis was carried out" in hit
    # …and without model scenarios the plain single-variant sentence stays.
    plain = rp.cautions(report, {"subjects": data["subjects"], "scenarios": []})
    assert any("supports no comparison" in n or "supports a comparison" in n for n in plain)
    assert not any("compare_scenarios" in n for n in plain)


def test_designations_years_and_small_ordinals_are_left_alone():
    """Forbidding every digit produces worse prose than it prevents. A designation cannot go stale when
    the model is recomputed, which is the only thing this rule protects against."""
    verdict = rp.check_proposal(
        "Following ISO 14044 and the IPCC 2021 method with ecoinvent 3.12 and CML v4.8, "
        "the 3 phases were assessed.",
        {"kind": "prose"},
        DATA,
    )
    assert verdict["ok"], verdict["findings"]


def test_an_unresolvable_placeholder_is_flagged():
    verdict = rp.check_proposal("Total {{results.9.score}}.", {"kind": "prose"}, DATA)
    assert not verdict["ok"]
    assert verdict["findings"][0]["kind"] == "unresolved_placeholder"


def test_a_quoted_fact_that_was_never_handed_over_is_flagged():
    """The assistant may phrase the recorded facts, which moves the burden here: the check asks
    whether a named thing has any basis in what we gave it."""
    verdict = rp.check_proposal('The study used the “Norwegian spruce forestry” dataset.', {"kind": "prose"}, DATA)
    assert not verdict["ok"]
    assert [f["kind"] for f in verdict["findings"]] == ["unsupported_fact"]


def test_a_quoted_fact_that_was_handed_over_passes():
    verdict = rp.check_proposal('The functional unit is “1 bottle”.', {"kind": "prose"}, DATA)
    assert verdict["ok"], verdict["findings"]


def test_a_dataset_named_in_italics_is_checked_like_one_in_quotes():
    """V161: the rule above only ever read quotation marks, and a writer that marks dataset names in
    italics slipped past it entirely.

    In an apple-juice run the contribution chapter named *market for urea formaldehyde
    resin*, *market for melamine formaldehyde resin* and *sawing, softwood* — none of them anywhere in
    the 139 k-character brief — and attached shares to two of them for an indicator whose hotspot list
    was never computed. All three went into the delivered PDF.
    """
    verdict = rp.check_proposal(
        "Water use is led by *market for urea formaldehyde resin*, with *sawing, softwood* behind it.",
        {"kind": "prose"},
        DATA,
    )
    assert not verdict["ok"]
    assert {f["kind"] for f in verdict["findings"]} == {"unsupported_fact"}
    assert len(verdict["findings"]) == 2


def test_emphasis_that_is_not_a_dataset_name_is_left_alone():
    """The restraint that keeps the rule usable: *italics* is a writing device first."""
    verdict = rp.check_proposal(
        "The *use phase* carries the result, and that is what the figure *means*.",
        {"kind": "prose"},
        DATA,
    )
    assert not [f for f in verdict["findings"] if f["kind"] == "unsupported_fact"], verdict["findings"]


def test_an_en_dash_in_a_dataset_name_is_not_an_invention():
    """A writer that types "16–32" where the dataset has "16-32" has invented nothing, and saying so
    would teach it to stop naming its sources. Both sides are levelled before they are compared."""
    data = {
        **DATA,
        "hotspots": [{"name": "transport, freight, lorry, 16-32 metric ton, diesel, EURO 6"}],
    }
    verdict = rp.check_proposal(
        "The leading dataset is *transport, freight, lorry, 16–32 metric ton, diesel, EURO 6*.",
        {"kind": "prose"},
        data,
    )
    assert not [f for f in verdict["findings"] if f["kind"] == "unsupported_fact"], verdict["findings"]


def test_the_brief_carries_the_whole_assignment():
    section = {"id": "s1", "kind": "prose", "title": "Interpretation", "extra_instructions": "Mention the reuse rate."}
    brief = rp.build_brief(section, {"lang": "de"}, DATA)
    assert brief["language"] == "German"
    assert "Mention the reuse rate." in brief["prompt"]          # the author's addition survives
    assert "Write in German" in brief["invariants"]
    assert brief["study"]["goal"] == "Compare two bottles"       # the contract of the study
    assert "results.0.score" in brief["placeholders"]            # the paths, so they need not be guessed


def test_an_edited_prompt_cannot_drop_the_invariants():
    section = {"id": "s1", "kind": "prose", "prompt_override": "Write two sentences."}
    brief = rp.build_brief(section, {"lang": "en"}, DATA)
    assert brief["prompt"] == "Write two sentences."
    assert "Never write a COMPUTED number as a literal" in brief["invariants"]


def test_placeholder_paths_use_one_example_index_per_list():
    paths = rp.placeholder_paths(DATA)
    assert "results.0.score" in paths
    assert not any(p.startswith("results.1") for p in paths)


# ---- through the API --------------------------------------------------------

def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("pr").write(
        {
            ("pr", "a"): {
                "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
                "exchanges": [
                    {"input": ("pr", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _make(client, token):
    return client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "de", "methods": [["t", "gwp"]],
              "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()


def test_the_brief_endpoint_hands_over_prompt_metadata_and_paths(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    client.post("/api/v1/study", json={"database": "pr", "goal": "Widget PCF"}, headers=token)
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/brief", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    brief = r.json()
    assert brief["language"] == "German"
    assert brief["study"]["goal"] == "Widget PCF"
    assert "results.0.score" in brief["placeholders"]
    assert "Never write a COMPUTED number as a literal" in brief["invariants"]


def test_a_clean_proposal_is_stored_with_its_provenance(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal"
    r = client.post(
        url,
        json={"text": "Das Ergebnis beträgt {{results.0.score}} {{results.0.unit}}.", "store": True, "model": "tencent/hy3"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] and r.json()["stored"]
    stored = client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()
    got = next(s for s in stored["sections"] if s["id"] == sec["id"])
    assert got["source"] == "ai" and got["model"] == "tencent/hy3"
    # The record anchors the text to what it was written against — components, not one hash, because
    # the remedy for a share that changed class differs from the one for a changed method family.
    # `leaders` is the one entry that is not about what the chapter cites: a claim to the top can be
    # made in words alone, and then there is no citation to judge it by (V206).
    # `sources`: the texts the chapter drew on, beside what it cites.
    assert set(got["based_on"]) == {"values", "bands", "ranks", "selection", "leaders", "sources"}
    assert got["based_on"]["selection"]["methods"] == ["t / gwp"]


def test_a_proposal_with_findings_is_not_stored(client, token, project):
    """Storing only on a clean gate is what guarantees every chapter in a report resolves."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal"
    r = client.post(url, json={"text": "Das Ergebnis beträgt 2,0 kg CO2-eq.", "store": True}, headers=token)
    assert r.status_code == 200
    assert not r.json()["ok"] and not r.json()["stored"]
    stored = client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()
    assert next(s for s in stored["sections"] if s["id"] == sec["id"])["text"] == ""


def test_a_frozen_chapter_refuses_a_proposal(client, token, project):
    """Freezing has to hold against a regeneration, or it protects nothing."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    base = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}"
    client.post(base, json={"kind": "prose", "locked": True}, headers=token)
    r = client.post(f"{base}/proposal", json={"text": "Kurzer Text.", "store": True}, headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "report_section_locked"


def test_a_moved_number_alone_needs_no_new_text(client, token, project):
    """The comparison is arithmetic — no model is asked whether a paragraph is still valid — and a
    number that merely moved is not a reason to rewrite anything: the sentence holds a placeholder,
    so it prints the new figure by itself. Saying "stale" here taught the author to ignore the badge."""
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    _seed(bd)
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal"
    client.post(url, json={"text": "Ergebnis: {{results.0.score}}.", "store": True, "model": "m"}, headers=token)

    fresh = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
    assert [c["remedy"] for c in fresh["chapters"]] == ["none"]
    assert fresh["chapters"][0]["findings"] == []

    # Move a number the chapter was written against, without touching anything it names.
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 2.5)])
    from prism_lca.engine.lca import invalidate_lca_cache

    invalidate_lca_cache()
    after = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
    chapter = after["chapters"][0]
    assert chapter["remedy"] == "none"
    assert [f["kind"] for f in chapter["findings"]] == ["values"]

    # Reporting only: the prose is untouched.
    stored = client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()
    assert next(s for s in stored["sections"] if s["id"] == sec["id"])["text"] == "Ergebnis: {{results.0.score}}."


def test_a_chapter_naming_a_method_the_report_dropped_needs_rewriting(client, token, project):
    """The reported defect: the Methods chapter kept explaining EF v3.1 for a study on CML, and
    "Write all" would not touch it because it had text."""
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    _seed(bd)
    bd.Method(("other", "ap")).write([(("biosphere", "co2"), 1.0)])
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": "Die Bewertung folgt der Methode t.", "store": True, "model": "m"},
        headers=token,
    )
    # Switch the report to the other method family — the prose still names the old one.
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}",
        json={"methods": [["other", "ap"]]},
        headers=token,
    )
    out = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
    chapter = out["chapters"][0]
    assert chapter["remedy"] == "rewrite", chapter
    assert any(f["kind"] == "selection" for f in chapter["findings"])


def test_text_without_a_fingerprint_is_unknown_rather_than_stale(client, token, project):
    """Prose written before this check existed must not be accused of being out of date.

    Only genuinely old data reaches this now: a hand edit *today* records what it was written
    against, like every other way a chapter gets its text (see the test below).
    """
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    # Straight into the store, without the endpoint — a chapter from before the record existed.
    from prism_lca.engine import report_store

    report_store.ReportStore().update_section(
        "pr", rep["id"], sec["id"], {"text": "Von Hand geschrieben."}
    )
    out = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
    assert [f["kind"] for f in out["chapters"][0]["findings"]] == ["unknown"]
    # Unknown is not an accusation: nothing is asked of the author.
    assert out["chapters"][0]["remedy"] == "none"


def test_a_hand_edit_today_is_recorded_and_therefore_checkable(client, token, project):
    """The seam this used to fall through: only the writing paths stored a record, so anything the
    author typed was permanently unjudgeable."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}",
        json={"kind": "prose", "text": "Das Ergebnis ist {{results.0.score}}."},
        headers=token,
    )
    out = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
    assert "unknown" not in [f["kind"] for f in out["chapters"][0]["findings"]]
    assert out["chapters"][0]["remedy"] == "none"


# ---- two defects the sample study surfaced ----------------------------------
def test_numbers_the_study_metadata_states_are_quotations_not_inventions():
    """DeepSeek wrote a correct interpretation chapter and the gate rejected it over "20" and "300" —
    the bag mass and the transport distance, both stated in the scope it had been handed. Flagging those
    teaches the writer to hide the assumptions its conclusions rest on, which is the opposite of the
    point. Result figures are unaffected: they are not in the metadata."""
    data = {
        "study": {"functional_unit": "One LDPE carrier bag (20 g)", "scope": "delivered 300 km by road"},
        "results": [{"method_label": "IPCC", "unit": "kg CO2-eq", "score": 0.119, "method": ["IPCC"]}],
        "subjects": [],
    }
    quoted = rp.check_proposal("The 20 g bag is delivered 300 km to retail.", {"kind": "prose"}, data)
    assert quoted["ok"], quoted["findings"]

    typed = rp.check_proposal("The bag causes 0.119 kg CO2-eq.", {"kind": "prose"}, data)
    assert not typed["ok"]
    assert [f["kind"] for f in typed["findings"]] == ["literal_number"]

    placeheld = rp.check_proposal(
        "The bag causes {{results.0.score}} {{results.0.unit}}.", {"kind": "prose"}, data
    )
    assert placeheld["ok"], placeheld["findings"]


def test_the_brief_carries_the_evidence_a_real_interpretation_needs():
    """Aggregated phases say *which stage* dominates, and a model given only those can do
    no more than paraphrase the results table — the first live chapter duly explained the chemistry it had
    inferred from a dataset name. The brief now carries the hotspot processes and the elementary flows, and
    the placeholder list offers them, so a claim about a driver can be sourced."""
    data = {
        "study": {"goal": "screening"},
        "results": [{"method_label": "IPCC", "unit": "kg CO2-eq", "score": 0.12, "method": ["IPCC"]}],
        "contribution": {"dimension": "tag:phase", "groups": [{"key": "End of life", "share_percent": 51.9}]},
        "hotspots": [
            {"name": "treatment of waste polyethylene, municipal incineration", "location": "GLO",
             "direct": 0.062, "share_percent": 51.9}
        ],
        "inventory": {"flows": [{"flow": "Carbon dioxide, fossil", "compartment": "air", "unit": "kg",
                                 "impact": 0.0659, "share_percent": 55.2}]},
        "subjects": [],
    }
    paths = rp.placeholder_paths(data)
    assert "hotspots.0.name" in paths
    assert "hotspots.0.share_percent" in paths
    assert "inventory.flows.0.flow" in paths

    brief = rp.build_brief({"kind": "prose"}, {"lang": "en"}, data)
    assert brief["data"]["hotspots"][0]["share_percent"] == 51.9
    # And the standard prompt actually asks for it — evidence nobody is told to use is evidence wasted.
    assert "hotspot" in brief["prompt"].lower()


def test_a_dataset_description_is_material_to_paraphrase_not_a_placeholder():
    """Process details answer "why does this process dominate", which is the reason they are in the brief
    at all. They must not be offered as placeholders: one resolving to 700 characters of ecoinvent text
    would drop a wall of prose into the middle of a sentence."""
    data = {
        "study": {},
        "results": [],
        "subjects": [],
        "hotspots": [
            {
                "name": "treatment of waste polyethylene, municipal incineration",
                "share_text": "51.9 %",
                "product": "waste polyethylene",
                "description": "This dataset describes the incineration of 1 kg of waste polyethylene " * 8,
                "classification": "ISIC 3821",
                "inputs": [{"name": "electricity, medium voltage", "share_text": "0.4 %"}],
            }
        ],
    }
    paths = rp.placeholder_paths(data)
    assert "hotspots.0.share_text" in paths
    assert "hotspots.0.inputs.0.name" in paths
    assert not [p for p in paths if p.endswith(("description", "classification"))]

    # But the gate still accepts terms the description introduced — it is part of what we handed over.
    verdict = rp.check_proposal(
        'The dominant process is the "incineration of 1 kg of waste polyethylene".', {"kind": "prose"}, data
    )
    assert verdict["ok"], verdict["findings"]


def test_a_number_quoted_from_a_dataset_description_is_not_an_invention():
    """Two different models wrote that the incinerator burns at 700–875 °C — the figures stand in the
    ecoinvent description we handed over — and both chapters were refused for it. Flagging a quotation
    teaches the writer to hide the very facts that explain a result. A computed figure still has to be a
    placeholder, and a figure found in a *lookup* is deliberately not quotable either: nothing can keep it
    correct."""
    data = {
        "study": {"functional_unit": "One LDPE carrier bag (20 g)"},
        "hotspots": [
            {
                "name": "treatment of waste polyethylene, municipal incineration",
                "description": "Combustion takes place at 700 to 875 degrees C in a MSWI plant.",
                "share_percent": 51.9,
            }
        ],
        "results": [{"method_label": "IPCC", "unit": "kg CO2-eq", "score": 0.1195, "method": ["IPCC"]}],
        "subjects": [],
        "looked_up": [{"name": "explain_result", "args": "{}", "result": '{"total": 0.0619804}'}],
    }
    assert rp.check_proposal("The plant burns the bag at 700 to 875 degrees C.", {"kind": "prose"}, data)["ok"]
    assert rp.check_proposal("The 20 g bag is incinerated.", {"kind": "prose"}, data)["ok"]
    typed = rp.check_proposal("The bag scores 0.12 kg CO2-eq.", {"kind": "prose"}, data)
    assert [f["kind"] for f in typed["findings"]] == ["literal_number"]
    from_lookup = rp.check_proposal("Incineration contributes 0.0619804.", {"kind": "prose"}, data)
    assert not from_lookup["ok"]


def test_a_share_reads_the_same_way_wherever_it_comes_from():
    """A writer that learnt `share_text` from the hotspots reasonably assumed a contribution group had one
    too — and the chapter was refused for a placeholder that did not exist. The key is now on all three."""
    from prism_lca.engine.report_data import build_data

    data = build_data(
        {},
        {"activity": {}, "results": [], "amount": 1.0},
        {"aggregation": {"dimension": "tag:phase", "groups": [{"key": "End of life", "impact": 1.0, "share": 0.519}]},
         "meta": {"unit": "kg"}},
        hotspots=[{"name": "incineration", "share_percent": 51.9}],
        inventory={"flows": [{"flow": "CO2", "share": 0.552}]},
    )
    assert data["contribution"]["groups"][0]["share_text"] == "51.9 %"
    assert data["hotspots"][0]["share_text"] == "51.9 %"
    assert data["inventory"]["flows"][0]["share_text"] == "55.2 %"


def test_a_figure_found_in_a_lookup_still_has_to_be_a_placeholder():
    """The honest limit of letting the writer look things up: a number it *was given* has a placeholder and
    survives a recomputation, while one it found in a lookup has none and would be frozen at today's
    value. The gate keeps that from entering the document."""
    data = {"study": {}, "results": [], "subjects": [],
            "looked_up": [{"name": "explain_result", "args": "{}", "result": '{"total": 0.0619804}'}]}
    # The phrase is supported — the lookup is part of what was handed over…
    assert rp.check_proposal('The dominant process is "explain_result".', {"kind": "prose"}, data)["ok"]
    # …but the figure inside it is not quotable, because nothing can keep it correct.
    verdict = rp.check_proposal("Incineration contributes 0.0619804 kg CO2-eq.", {"kind": "prose"}, data)
    assert [f["kind"] for f in verdict["findings"]] == ["literal_number"]


def test_the_summary_reads_the_chapters_it_summarises_with_placeholders_intact():
    """An executive summary that has not read the report can only paraphrase the results table.

    Handed over as STORED, so a copied figure is a placeholder and stays correct after a recompute — and
    survives the gate, which refuses a literal number that is not in the metadata whitelist. Ordinary
    chapters see none of this: it would be length without purpose.
    """
    from prism_lca.engine.report_prompts import written_siblings

    report = {
        "sections": [
            {"id": "s1", "kind": "summary", "title": "Executive summary", "order": 0, "text": ""},
            {"id": "s2", "kind": "lcia", "title": "Impact assessment", "order": 1,
             "text": 'The result is {{results.0.score}} kg CO2-Eq.'},
            {"id": "s3", "kind": "contribution", "title": "Contribution", "order": 2,
             "text": 'The film carries {{contribution.top.share_percent}}.'},
            {"id": "s4", "kind": "appendix", "title": "Annex", "order": 3, "text": "A table of parameters."},
            {"id": "s5", "kind": "conclusions", "title": "Conclusions", "order": 4, "text": ""},
        ]
    }
    summary = report["sections"][0]

    seen = written_siblings(summary, report)
    assert [c["title"] for c in seen] == ["Impact assessment", "Contribution"]  # in document order
    assert "{{results.0.score}}" in seen[0]["text"]  # unresolved, on purpose
    # The annex is not worth reading, and the chapter never reads itself.
    assert all("parameters" not in c["text"] for c in seen)

    # An ordinary chapter gets nothing; an unwritten sibling contributes nothing.
    assert written_siblings(report["sections"][1], report) == []
    assert all(c["text"].strip() for c in written_siblings(report["sections"][4], report))


def test_a_chapter_can_say_which_member_each_number_belongs_to(client, token, project):
    """The editor shows a path and the document shows a figure; which row that is was nowhere."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": "Das Ergebnis ist {{results.0.score}} {{results.0.unit}}.", "store": True,
              "model": "m"},
        headers=token,
    )
    parts = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/resolved", json={}, headers=token
    ).json()["parts"]
    values = [p for p in parts if p["kind"] == "value"]
    assert [p["token"] for p in values] == ["results.0.score", "results.0.unit"]
    # The number the document will print, and the member the sentence is pinned to.
    assert all(not p["missing"] for p in values)
    assert values[0]["member"] == "method_label=t / gwp"
    assert values[0]["pinned"] is True
    # The author's own words come back untouched and in order.
    assert "".join(p["text"] for p in parts).startswith("Das Ergebnis ist ")


def test_a_pinned_member_that_vanished_is_shown_as_the_hole_it_is(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": "Das Ergebnis ist {{results.0.score}}.", "store": True, "model": "m"},
        headers=token,
    )
    get_bd().Method(("t", "other")).write([(("biosphere", "co2"), 1.0)])
    client.post(f"/api/v1/report/one/pr/{rep['id']}", json={"methods": [["t", "other"]]}, headers=token)
    parts = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/resolved", json={}, headers=token
    ).json()["parts"]
    hole = next(p for p in parts if p["kind"] == "value")
    assert hole["missing"] is True
    assert "missing" in hole["text"]


# ---- cross-references: the two holes the first real report printed -------------------------------

def _report_with(kind: str, **section) -> dict:
    return {"lang": "en", "methods": [["t", "gwp"]], "options": {},
            "sections": [{"id": "s1", "kind": kind, **section}]}


def test_a_reference_to_a_table_the_report_does_not_have_is_refused():
    """It printed "[missing reference: …]" in a client's PDF. A cross-reference was checked for its
    spelling only, so a well-formed name for a table nobody emits sailed through."""
    report = _report_with("lcia")
    verdict = rp.check_proposal("See {{ref:t-lcia}} and {{ref:f-section-sec-deadbeef}}.",
                                report["sections"][0], DATA, report=report)
    assert not verdict["ok"]
    assert [f["kind"] for f in verdict["findings"]] == ["unknown_reference"]
    assert "f-section-sec-deadbeef" in verdict["findings"][0]["detail"]


def test_a_label_from_another_chapter_is_allowed():
    """Typst labels are document-wide, and "see Table 2" is how a report reads. The set is the whole
    document's, not the chapter's."""
    report = {"lang": "en", "methods": [["t", "gwp"]], "options": {},
              "sections": [{"id": "s1", "kind": "conclusions"}, {"id": "s2", "kind": "lcia"}]}
    verdict = rp.check_proposal("As {{ref:t-lcia}} shows.", report["sections"][0], DATA, report=report)
    assert verdict["ok"], verdict["findings"]


def test_a_clean_completeness_check_offers_no_table_to_point_at():
    """The clean check renders as a sentence, not a labelled table — so the label must not be offered.
    The brief promised it, the model used it, and the document printed a gap."""
    clean = {**DATA, "checks": {"completeness": {"activities": 15, "findings": 0, "clean": True}}}
    dirty = {**DATA, "checks": {"completeness": {"activities": 15, "findings": 2, "clean": False}}}
    section = {"id": "s1", "kind": "interpretation_checks"}
    report = _report_with("interpretation_checks", id="s1")
    refs = lambda d: {e["ref"] for e in rp.renders_for(section, report, d)}  # noqa: E731
    assert "{{ref:t-completeness}}" not in refs(clean)
    assert "{{ref:t-completeness}}" in refs(dirty)


def test_a_scenario_says_what_it_changed_not_how_many_things():
    """A comparative report's annex said "Longer DC distance … 1" — a count, in the one table whose
    whole subject is which value was varied."""
    from prism_lca.engine import report_render as rr

    data = {"scenarios": [{"name": "Heavier bottle", "description": "",
                           "overrides": {"mass_glass_bottle": 0.42}}]}
    rows = [b for b in rr._appendix_blocks(data, "en", "Annex") if b.get("type") == "table"]
    cells = [c for r in rows for row in r.get("rows", []) for c in row]
    assert any("mass_glass_bottle = 0.42" in c for c in cells), cells


def test_a_figure_caption_names_what_it_draws():
    from prism_lca.engine import report_render as rr

    data = {"contribution": {"dimension": "Life-cycle phase"}, "results": [{"method_label": "GWP100"}]}
    assert "Life-cycle phase" in rr._figure_caption({"kind": "bar", "source": "contribution.groups"}, data, "en")
    assert "GWP100" in rr._figure_caption({"kind": "bar", "source": "subjects"}, data, "en")
    assert rr._figure_caption({"kind": "heatmap"}, data, "en") != "Figure for this chapter"


def test_a_four_digit_figure_with_a_unit_is_not_a_year():
    """"amounts to 1350 MJ" passed the gate as "the year 1350" and froze a result figure in prose."""
    section = {"id": "s", "kind": "prose"}
    typed = rp.check_proposal("The cumulative energy demand amounts to 1350 MJ per unit.", section, DATA)
    assert any(f["kind"] == "literal_number" and "1350" in f["detail"] for f in typed["findings"]), typed

    year = rp.check_proposal("The inventory follows the 2021 revision of the method.", section, DATA)
    assert not [f for f in year["findings"] if f["kind"] == "literal_number"], year

    # A designator after the year must not turn it into a figure — standards come *before* their number.
    iso = rp.check_proposal("Seit 2006 ISO 14044 defines the reporting duties.", section, DATA)
    assert not [f for f in iso["findings"] if f["kind"] == "literal_number"], iso


def _literals(text: str, data: dict | None = None) -> list[str]:
    verdict = rp.check_proposal(text, {"id": "s", "kind": "prose"}, data if data is not None else DATA)
    return [f["names"][0] for f in verdict["findings"] if f["kind"] == "literal_number"]


def test_a_small_result_with_a_unit_is_a_figure_not_a_count():
    """0–19 passed as a count even before a unit — "12 kg CO2-Eq" stayed unbound and was
    never watched for staleness. The count allowance now holds only while no physical unit follows,
    and "kg" is matched as a prefix, so every way of writing a characterised unit is caught."""
    for text in (
        "The climate impact amounts to 12 kg CO2-eq per unit.",
        "The climate impact amounts to 12 kgCO2e per unit.",
        "The climate impact amounts to 12 kg-CO2-Eq per unit.",
        "Acidification is 3 mol H+-Eq.",
        "Transport adds 12 KG.",
        "It needs 3 MJ.",
        "Packaging holds 12 % of the total.",
        "Packaging holds 12% of the total.",
        "Packaging holds 12\u202f% of the total.",
        "A 2-kg bottle of detergent.",
    ):
        assert _literals(text) and _literals(text)[0] in ("12", "3", "2"), text
    # …and a unit the LCIA method itself reports, which no static list has to know.
    data = {**DATA, "results": [{"method_label": "tox", "score": 1.0, "unit": "CTUh"}]}
    assert _literals("Toxicity is 4 CTUh.", data) == ["4"]


def test_a_small_count_stays_a_count():
    for text in (
        "The 3 phases were assessed.",
        "The study compares 12 processes.",
        "Two of the 4 scenarios reduce the impact.",
        "The 2 LCA studies disagree.",
        "The 3 LCIA methods agree, over 4 months of data.",
        "Die 3 Phasen und 12 Prozesse.",
        "The 2 EPDs were consulted.",
    ):
        assert _literals(text) == [], text


def test_an_input_quantity_from_the_scope_stays_quotable_with_its_own_unit():
    """The counter-case: "the 2 kg bottle" in goal & scope is the scope's own figure. It stays allowed
    — but only with the same unit: the scope's "1 kg" functional unit does not license a result of
    "1 kg CO2-Eq", and its "12 bottles" does not license "12 kg"."""
    data = {**DATA, "study": {"goal": "A 2 kg bottle of juice, 12 bottles per crate.", "functional_unit": "1 kg of juice"}}
    assert _literals("The product is the 2 kg bottle.", data) == []
    assert _literals("The functional unit is 1 kg of juice.", data) == []
    assert _literals("The impact is 1 kg CO2-Eq.", data) == ["1"]
    assert _literals("The impact is 12 kg.", data) == ["12"]


def test_a_small_figure_says_what_to_do_when_nothing_states_it():
    """The message the writer sees. Tested on a model: the plain "reference it as a
    placeholder" sent it to put {{results.0.score}} in place of a fill mass; the wording now closes
    both evasions and leaves the result case unchanged."""
    verdict = rp.check_proposal("The product is a 2 kg bottle.", {"id": "s", "kind": "prose"}, DATA)
    detail = next(f["detail"] for f in verdict["findings"] if f["kind"] == "literal_number")
    assert "2 kg" in detail
    assert "leave the figure out" in detail
    assert "Never put a placeholder that means a different quantity" in detail


def test_a_small_parameter_value_with_its_unit_is_named_and_repaired():
    data = {**DATA, "parameters": [{"name": "fill_mass", "amount": 2.0, "unit": "kg"}]}
    verdict = rp.check_proposal("The product is a 2 kg bottle.", {"id": "s", "kind": "prose"}, data)
    literal = next(f for f in verdict["findings"] if f["kind"] == "literal_number")
    assert "fill_mass" in literal["detail"]
    assert literal["repair"]["replace"] == "{{parameters.0.amount}} {{parameters.0.unit}}"
    # A characterised unit is an impact, never a mass parameter's value — even with the same leading
    # "kg". Reproduced in review: bound to fill_mass, "2 kg CO2-Eq" printed "3 kg CO2-Eq" after a
    # recompute with no finding. It stays a plain refusal, with no repair on offer.
    for impact in ("The climate impact is 2 kg CO2-Eq.", "The climate impact is 2 kgCO2e."):
        found = [f for f in rp.check_proposal(impact, {"id": "s", "kind": "prose"}, data)["findings"]
                 if f["kind"] == "literal_number"]
        assert found and "repair" not in found[0] and "fill_mass" not in found[0]["detail"], impact
        assert rp.apply_repairs(impact, found)[1] == []
    # The characterised unit may carry a per-unit suffix, sentence punctuation, a line break or extra
    # spaces — and is still an impact (a regression found in testing).
    for impact in ("The impact is 2 kg CO2-Eq/m2 here.", "The impact is 2 kg CO2.", "The impact is 2 kg\nCO2-Eq.",
                   "The impact is 2 kg   CO2-Eq."):
        found = [f for f in rp.check_proposal(impact, {"id": "s", "kind": "prose"}, data)["findings"]
                 if f["kind"] == "literal_number" and f["names"] == ["2"]]
        assert found and "repair" not in found[0] and "fill_mass" not in found[0]["detail"], impact
    # …but a digit in a LATER word is no part of the unit. Reproduced in testing: the 3 in
    # "and 3 bottles" made "2 kg" characterised, the parameter match was dropped and the quotation
    # exception let the figure through unreported.
    for mass in ("The mass is 2 kg and 3 bottles.", "The mass is 2 kg in 2026."):
        found = [f for f in rp.check_proposal(mass, {"id": "s", "kind": "prose"}, data)["findings"]
                 if f["kind"] == "literal_number" and f["names"] == ["2"]]
        assert found and "fill_mass" in found[0]["detail"] and "repair" in found[0], mass
    # 1 is how every functional unit is written — never claimed for a parameter.
    one = {**DATA, "parameters": [{"name": "unit_mass", "amount": 1.0, "unit": "kg"}],
           "study": {"functional_unit": "1 kg of product"}}
    assert _literals("The functional unit is 1 kg of product.", one) == []


def test_a_number_recorded_in_a_process_note_is_a_quotation():
    """The inventory prompt sends the writer to the process notes; a distance recorded there must be
    quotable, or the gate blocks exactly the provenance statements the chapter exists for."""
    section = {"id": "s", "kind": "inventory"}
    data = {**DATA, "foreground": [{"name": "transport", "description": "450 km by lorry, own estimate"}]}
    ok = rp.check_proposal("The 450 km transport distance is an estimate.", section, data)
    assert not [f for f in ok["findings"] if f["kind"] == "literal_number"], ok
    # And a phrase from the note is a supported fact now, not an invented one.
    quoted = rp.check_proposal("The note calls it “own estimate”.", section, data)
    assert not [f for f in quoted["findings"] if f["kind"] == "unsupported_fact"], quoted


def test_the_gate_offers_every_per_indicator_chart_the_renderer_draws():
    """document_labels used to know only f-lcia-0 and to ignore per_indicator_charts — it refused
    references the PDF contains and approved references to charts that were switched off."""
    data = {
        **DATA,
        "results": [
            {"method_label": "IPCC 2021 / GWP100", "unit": "kg", "score": 1.0},
            {"method_label": "EF v3.1 / water use", "unit": "m3", "score": 2.0},
        ],
        "subjects": [
            {"label": "A", "results": [{"score": 1.0}]},
            {"label": "B", "results": [{"score": 2.0}]},
        ],
    }
    lcia = {"id": "L", "kind": "lcia"}
    report = {"lang": "en", "sections": [lcia]}
    assert {"f-lcia-0", "f-lcia-1"} <= rp.document_labels(report, data)

    report_lead = {"lang": "en", "sections": [{**lcia, "per_indicator_charts": "lead"}]}
    labels = rp.document_labels(report_lead, data)
    assert "f-lcia-0" in labels and "f-lcia-1" not in labels

    report_none = {"lang": "en", "sections": [{**lcia, "per_indicator_charts": "none"}]}
    assert not any(label.startswith("f-lcia") for label in rp.document_labels(report_none, data))


def test_the_gate_judges_the_figure_the_write_will_leave_behind(client, token, project):
    """The hole the second real report printed, after `document_labels` was supposed to make holes
    impossible. A chapter carries its own figure's label, and the gate used to check a write against the
    section *on disk* — so it judged a document other than the one it was about to store, in both
    directions: it refused a reference to the figure the write itself asked for, and it waved through a
    reference to one the write removed. `[missing reference: f-section-…]` went into the PDF.

    Only the adding direction is still reachable: since V215 a proposal may add a figure but never
    delete one (`test_a_write_that_asks_for_no_figure_keeps_the_one_the_chapter_carries` holds that
    half), because deleting one was how the brief's own offer became a refusal.
    """
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal"
    figure = {"kind": "bar", "source": "subjects", "label": "label"}
    text = f"Siehe {{{{ref:f-section-{sec['id']}}}}}."

    # Nothing is drawn here yet, so the label exists only because this write asks for the figure.
    refused = client.post(url, json={"text": text, "store": True, "model": "m"}, headers=token).json()
    assert refused["stored"] is False
    assert [f["kind"] for f in refused["findings"]] == ["unknown_reference"]
    assert f"f-section-{sec['id']}" in refused["findings"][0]["detail"]

    # With the figure it asks for, the same sentence points at something the document will contain.
    r1 = client.post(url, json={"text": text, "figure": figure, "store": True, "model": "m"}, headers=token)
    first = r1.json()
    assert r1.status_code == 200, first
    assert first["ok"] is True, first
    assert first["stored"] is True

    stored = client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()
    kept = next(s for s in stored["sections"] if s["id"] == sec["id"])
    assert kept["figure"] is not None


def test_the_contribution_chapter_is_offered_the_labels_it_prints():
    """It prints one table and one figure per indicator now. Offering only the bare pair meant a
    chapter could not point at tables it had itself printed — and a reference to one would have been
    refused as unknown, which is the gate doing its job about a promise nobody made."""
    data = {
        "contribution": {"groups": [{"key": "Production", "impact": 1.0}]},
        "contributions": [
            {"index": 0, "method_label": "EF / climate change", "groups": [{"key": "Production"}]},
            {"index": 1, "method_label": "EF / water use", "groups": [{"key": "Production"}]},
        ],
    }
    section = {"kind": "contribution"}
    refs = [e["ref"] for e in rp.renders_for(section, {"sections": [section]}, data)]
    assert refs == [
        "{{ref:t-contribution}}", "{{ref:f-contribution}}",
        "{{ref:t-contribution-1}}", "{{ref:f-contribution-1}}",
    ]
    # …and a hidden indicator is not offered, because it is not printed.
    hidden = {"kind": "contribution", "hidden_indicators": ["EF / water use"]}
    refs = [e["ref"] for e in rp.renders_for(hidden, {"sections": [hidden]}, data)]
    assert refs == ["{{ref:t-contribution}}", "{{ref:f-contribution}}"]


# ---- a chapter's own figure: the label the brief offers and the write keeps (V215) ---------------

_OWN_FIGURE = {"kind": "bar", "source": "contribution.groups", "value": "impact", "label": "key"}


def test_a_chapter_may_point_at_the_figure_it_carries_in_either_spelling():
    """A chapter's own figure is labelled by the *key that holds it*, and both keys are in use: the
    single `figure` an AI write stores is drawn as `f-section-<id>`, a `figures` list as
    `f-section-<id>-<i>` (report_render, `specs = list(section["figures"])` with the single one as the
    fallback). The gate has to accept whichever the renderer will emit — and refuse the other spelling,
    because a reference to `…-0` on a chapter that carries the single key prints a gap.
    """
    def labels(section: dict) -> set[str]:
        return rp.document_labels({"lang": "en", "sections": [section]}, DATA)

    def offered(section: dict) -> set[str]:
        report = {"lang": "en", "sections": [section]}
        return {rp._label_in(e["ref"]) for e in rp.offered_renders(section, report, DATA)}

    def accepts(section: dict, label: str) -> bool:
        report = {"lang": "en", "sections": [section]}
        verdict = rp.check_proposal(f"See {{{{ref:{label}}}}}.", section, DATA, report=report)
        return verdict["ok"]

    single = {"id": "s", "kind": "contribution", "figure": _OWN_FIGURE}
    assert "f-section-s" in labels(single) and "f-section-s-0" not in labels(single)
    assert "f-section-s" in offered(single)
    assert accepts(single, "f-section-s")
    assert not accepts(single, "f-section-s-0")

    one = {"id": "s", "kind": "contribution", "figures": [_OWN_FIGURE]}
    assert "f-section-s-0" in labels(one) and "f-section-s" not in labels(one)
    assert "f-section-s-0" in offered(one)
    assert accepts(one, "f-section-s-0")
    assert not accepts(one, "f-section-s")

    two = {"id": "s", "kind": "contribution", "figures": [_OWN_FIGURE, {"kind": "bar", "source": "subjects"}]}
    assert {"f-section-s-0", "f-section-s-1"} <= labels(two)
    assert {"f-section-s-0", "f-section-s-1"} <= offered(two)
    assert accepts(two, "f-section-s-1")
    assert not accepts(two, "f-section-s-2")

    # And a chapter that draws nothing of its own has no such label at all — the refusal the check
    # exists for.
    bare = {"id": "s", "kind": "contribution"}
    assert not any(label.startswith("f-section") for label in labels(bare))
    assert not accepts(bare, "f-section-s")


def test_a_write_that_asks_for_no_figure_keeps_the_one_the_chapter_carries(client, token, project):
    """V215: the brief offered a chapter its own figure, and the write that used the offer was refused.

    The brief reads the chapter *on disk*, so it named `f-section-<id>`; the gate reads the chapter this
    write would produce, and the write built that one by overwriting `figure` with the request's — empty
    on every rewrite that does not ask for a chart again, which the brief never even hands the spec for.
    Offer and authority are the same function on two different documents, which is how they drifted for
    a label no list was missing. It cost a commissioned rewrite of a chapter whose datasets had changed:
    refused, thrown away, paid for.

    The same write also silently deleted the figure from the report, which is the half a gate cannot
    catch at all.
    """
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    sec = _add_prose(client, token, rep)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal"
    figure = {"kind": "bar", "source": "subjects", "label": "label"}
    text = f"Siehe {{{{ref:f-section-{sec['id']}}}}}."

    first = client.post(url, json={"text": text, "figure": figure, "store": True, "model": "m"}, headers=token).json()
    assert first["ok"] is True, first

    # The brief offers the figure the chapter now carries…
    brief = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/brief", json={}, headers=token
    ).json()
    assert f"{{{{ref:f-section-{sec['id']}}}}}" in [r["ref"] for r in brief["renders"]]

    # …and a rewrite that says nothing about figures may use it. The figure is still there afterwards.
    again = client.post(url, json={"text": text + " Und mehr.", "store": True, "model": "m"}, headers=token).json()
    assert again["ok"] is True, again["findings"]
    assert again["stored"] is True
    stored = client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()
    kept = next(s for s in stored["sections"] if s["id"] == sec["id"])
    assert kept["figure"] is not None
    assert kept["text"].endswith("Und mehr.")


def test_every_reference_the_brief_offers_is_accepted_by_the_write_that_uses_it(client, token, project):
    """The invariant across the round-trip, not within one call — where V215 sat.

    `test_the_brief_offers_less_than_the_gate_accepts_but_never_more` compares the two functions on one
    report dict, and both endpoints were innocent by that measure: the brief computed its offer from the
    stored report and the gate its authority from the report the write would produce, and the write
    changed the document. So this walks the actual path — brief, then a proposal that uses each offered
    reference — over a report whose chapters carry their own figures in both spellings, because that is
    the only field a write can change on the chapter under judgement.
    """
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    base = f"/api/v1/report/one/pr/{rep['id']}"

    # One chapter with the single `figure` an AI write leaves behind, one with a `figures` list of two.
    single = _add_prose(client, token, rep)
    client.post(
        f"{base}/sections/{single['id']}/proposal",
        json={"text": "Ein Satz.", "figure": {"kind": "bar", "source": "subjects"}, "store": True, "model": "m"},
        headers=token,
    )
    listed = _add_prose(client, token, rep)
    client.post(
        f"{base}/sections/{listed['id']}",
        json={"kind": "prose", "figures": [{"kind": "bar", "source": "subjects"},
                                           {"kind": "bar", "source": "contribution.groups"}]},
        headers=token,
    )

    report = client.get(base, headers=token).json()
    checked: set[str] = set()
    for section in report["sections"]:
        brief = client.post(f"{base}/sections/{section['id']}/brief", json={}, headers=token).json()
        for entry in brief.get("renders") or []:
            verdict = client.post(
                f"{base}/sections/{section['id']}/proposal",
                json={"text": f"Siehe {entry['ref']}.", "store": False},
                headers=token,
            ).json()
            refused = [f for f in verdict.get("findings") or [] if f["kind"] == "unknown_reference"]
            assert not refused, (section["kind"], entry["ref"], refused)
            checked.add(rp._label_in(entry["ref"]))
        # The same invariant for the figure this write may *ask for*: the brief names the label it will
        # carry, so the write that uses that name must be accepted. It was not, on any chapter that
        # already carried a list — the request landed in the single key, which no reader looks at while
        # the list is non-empty, and the promised label existed in no document.
        asked = client.post(
            f"{base}/sections/{section['id']}/proposal",
            json={
                "text": f"Siehe {{{{ref:{brief['figure_ref']}}}}}.",
                "figure": {"kind": "bar", "source": "subjects"},
                "store": False,
            },
            headers=token,
        ).json()
        refused = [f for f in asked.get("findings") or [] if f["kind"] == "unknown_reference"]
        assert not refused, (section["kind"], brief["figure_ref"], refused)
        checked.add(brief["figure_ref"])
    # A guard on the guard: what was offered has to include the labels this is about, or every
    # assertion above is a loop over nothing.
    assert {f"f-section-{single['id']}", f"f-section-{listed['id']}-0",
            f"f-section-{listed['id']}-1", "t-lcia"} <= checked, sorted(checked)


def test_emptying_the_figure_list_deletes_the_figure_a_legacy_chapter_carries(client, token, project):
    """The editor's delete has to reach the single `figure` too, or it deletes nothing.

    The editor writes `figures` and only `figures`, so emptying the list stored `figures: []` — and both
    readers fall back to the single key while the list is empty, so the document kept drawing the figure
    the author had just removed. Since V215 the proposal path no longer clears that key either, which
    left it with no delete path in the product at all.

    Cleared rather than migrated into the list on the first edit: migrating renames the label from
    `f-section-<id>` to `f-section-<id>-0`, and the brief offers a chapter exactly that reference for its
    own figure, so its stored text may already carry it (V203).
    """
    from prism_lca.engine import report_render
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    base = f"/api/v1/report/one/pr/{rep['id']}"
    sec = _add_prose(client, token, rep)

    # The one way to get the legacy shape: a write asks for a figure, and it lands in the single key.
    client.post(
        f"{base}/sections/{sec['id']}/proposal",
        json={"text": "Ein Satz.", "figure": {"kind": "bar", "source": "subjects"}, "store": True, "model": "m"},
        headers=token,
    )
    stored = client.get(base, headers=token).json()
    carried = next(s for s in stored["sections"] if s["id"] == sec["id"])
    assert carried["figure"] is not None
    from prism_lca.engine import report_model as rm

    spec, lead = carried["figure"], DATA["results"][0]["method_label"]

    def drawn(report: dict) -> list[str]:
        """What the document draws for this chapter — with both chart keys supplied, so the answer is
        the renderer's choice and not a missing SVG."""
        # Keyed as the renderer keys a chapter's figure (report_model.section_chart_key).
        charts = {
            rm.section_chart_key(sec["id"], None, spec, lead): "<svg/>",
            rm.section_chart_key(sec["id"], 0, spec, lead): "<svg/>",
        }
        blocks = report_render.blocks_for(report, {}, {}, None, DATA, charts, [], {})[0]
        return [b["label"] for b in blocks if b.get("type") == "figure"]

    assert drawn(stored) == [f"f-section-{sec['id']}"]

    # What the editor does when the author removes the last figure.
    client.post(f"{base}/sections/{sec['id']}", json={"kind": "prose", "figures": []}, headers=token)
    empty = client.get(base, headers=token).json()
    gone = next(s for s in empty["sections"] if s["id"] == sec["id"])
    assert gone.get("figure") is None
    assert drawn(empty) == []
    # …and no label for it survives either, so a sentence pointing at it is refused rather than printed
    # as a gap.
    assert not any(label.startswith("f-section") for label in rp.document_labels(empty, DATA))


def test_a_figure_a_write_asks_for_on_a_chapter_with_a_list_is_drawn_and_referenceable(client, token, project):
    """V215's neighbour: the request landed in the key the readers ignore while the list is non-empty.

    So the chart was validated, stored and drawn by nobody, and `f-section-<id>` — the only name a writer
    could have guessed for it — was in no document: another paid call against a wall. It goes into the
    live list now, which leaves the labels the chapter already has where they are, and the brief says
    which label the new one will carry (`figure_slot`), because that label depends on the chapter's shape
    and was never guessable.
    """
    from prism_lca.engine import report_render
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = _make(client, token)
    base = f"/api/v1/report/one/pr/{rep['id']}"
    sec = _add_prose(client, token, rep)
    client.post(
        f"{base}/sections/{sec['id']}",
        json={"kind": "prose", "figures": [{"kind": "bar", "source": "subjects"},
                                           {"kind": "bar", "source": "contribution.groups"}]},
        headers=token,
    )

    brief = client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token).json()
    assert brief["figure_ref"] == f"f-section-{sec['id']}-2"

    verdict = client.post(
        f"{base}/sections/{sec['id']}/proposal",
        json={
            "text": f"Siehe {{{{ref:{brief['figure_ref']}}}}}.",
            # `subjects` again: what matters is the slot it lands in, and this seeded report has
            # no hotspots to plot.
            "figure": {"kind": "bar", "source": "subjects"},
            "store": True,
            "model": "m",
        },
        headers=token,
    ).json()
    assert verdict["ok"] is True, verdict
    assert verdict["stored"] is True

    stored = client.get(base, headers=token).json()
    kept = next(s for s in stored["sections"] if s["id"] == sec["id"])
    assert [f["source"] for f in kept["figures"]] == ["subjects", "contribution.groups", "subjects"]
    # And nothing was left behind in the key that would have been ignored anyway.
    assert kept.get("figure") is None

    from prism_lca.engine import report_model as rm

    lead = DATA["results"][0]["method_label"]
    charts = {rm.section_chart_key(sec["id"], i, f, lead): "<svg/>" for i, f in enumerate(kept["figures"])}
    blocks = report_render.blocks_for(stored, {}, {}, None, DATA, charts, [], {})[0]
    assert [b["label"] for b in blocks if b.get("type") == "figure"] == [
        f"f-section-{sec['id']}-0", f"f-section-{sec['id']}-1", f"f-section-{sec['id']}-2"
    ]


# ---- the gate's authority against the renderer (V197) -------------------------------------------


def _annex_report() -> tuple[dict, dict]:
    """A report whose annex, bibliography and glossary print their tables, and the data behind them."""
    data = {
        **DATA,
        "provenance": {"background": "ecoinvent 3.12"},
        "parameters": [{"name": "bottle_mass", "amount": 0.42, "unit": "kg", "description": "own estimate"}],
        "scenarios": [{"name": "Heavier bottle", "description": "", "overrides": {"bottle_mass": 0.5}}],
    }
    report = {
        "lang": "en",
        "options": {},
        "abbreviations": {"LDPE": "Low-density polyethylene"},
        "sections": [
            {"id": "p", "kind": "prose", "order": 0, "text": ""},
            {"id": "x", "kind": "appendix", "order": 1},
            {"id": "r", "kind": "references", "order": 2},
            {"id": "g", "kind": "abbreviations", "order": 3},
        ],
    }
    return report, data


def test_the_gate_accepts_the_bibliography_and_the_glossary_the_document_prints():
    """The renderer prints `t-references` and `t-abbreviations`; the authority did not list them, so a
    chapter writing "the sources are listed in …" was refused over a reference the PDF resolves. Every
    such refusal buys a paid revision round, and the writer was never offered the tables either."""
    from prism_lca.engine import report_render

    report, data = _annex_report()
    section = report["sections"][0]
    text = "The LDPE film dominates; see {{ref:t-references}} and {{ref:t-abbreviations}}."
    verdict = rp.check_proposal(text, section, data, report=report)
    assert verdict["ok"], verdict["findings"]

    # …and the document really resolves them: accepting a reference is only worth something if the
    # printed page carries the label. Same two assertions the export makes — no reported gap, no
    # "[missing reference: …]" in the prose the reader gets.
    section["text"] = text
    blocks, missing = report_render.blocks_for(report, data["study"], {"results": []}, None, data, {})
    assert missing == []
    labels = {b.get("label") for b in blocks}
    assert {"t-references", "t-abbreviations", "t-scenarios", "t-parameters"} <= labels
    prose = " ".join(str(b.get("text") or "") for b in blocks)
    assert "@t-references" in prose and "@t-abbreviations" in prose
    assert "[missing reference" not in prose


def test_a_table_the_document_does_not_print_is_still_refused():
    """The other direction, and the reason the authority is computed rather than listed: the two source
    tables of the bibliography exist only where there are sources to list, so a reference to one in a
    report without them would print a gap."""
    report, data = _annex_report()
    section = report["sections"][0]
    for label in ("t-web-research", "t-sources", "t-conclusions-summary"):
        verdict = rp.check_proposal(f"See {{{{ref:{label}}}}}.", section, data, report=report)
        assert [f["kind"] for f in verdict["findings"]] == ["unknown_reference"], label

    # With a research log behind it, the same reference is to something the document contains.
    researched = {**data, "web_research": [{"question": "How heavy?", "findings": [{"sources": ["https://x.test/a"]}]}]}
    ok = rp.check_proposal("See {{ref:t-web-research}}.", section, researched, report=report)
    assert ok["ok"], ok["findings"]


def _every_table_report() -> tuple[dict, dict]:
    """A report that prints every labelled table the renderer has, and the data that fills it.

    Deliberately without a methods chapter: the results chapter then carries the short-name legend
    (`t-method-legend`), and a report with both cannot exist — the legend is what stands in *for* a
    methods chapter (report_typst._method_legend).
    """
    from prism_lca.engine import report_checks

    results = [
        {
            "method": ["IPCC 2021", "climate change", "GWP100"],
            "method_label": "IPCC 2021 / climate change / GWP100",
            "unit": "kg CO2-eq",
            "score": 0.41,
        }
    ]
    data = {
        "study": {"functional_unit": "1 bottle", "notes": "Masses from https://sources.test/masses."},
        "activity": {"name": "PET bottle", "database": "m", "code": "c"},
        "amount": 1.0,
        "provenance": {"background": "ecoinvent 3.12"},
        "results": results,
        "foreground": [{"name": "bottling", "product": "bottle", "unit": "unit", "location": "GLO",
                        "code": "c", "description": "Own data."}],
        "background_datasets": [{"name": "electricity", "product": "electricity", "location": "DE",
                                 "database": "ecoinvent 3.12"}],
        "parameters": [{"name": "bottle_mass", "amount": 0.42, "unit": "kg", "description": "own estimate"}],
        "scenarios": [{"name": "Heavier bottle", "description": "", "overrides": {"bottle_mass": 0.5}}],
        "inventory": {"method": ["IPCC 2021", "GWP100"],
                      "flows": [{"flow": "CO2", "categories": ["air"], "unit": "kg", "impact": 0.4, "share": 0.9}]},
        "contribution": {"dimension": "Phase", "unit": "kg CO2-eq",
                         "groups": [{"key": "Production", "impact": 0.31, "share": 0.75}]},
        "contributions": [{"index": 0, "method_label": results[0]["method_label"], "unit": "kg CO2-eq",
                           "dimension": "Phase",
                           "groups": [{"key": "Production", "impact": 0.31, "share": 0.75, "share_text": "75.0 %"}]}],
        "subjects": [
            {"label": "Baseline", "results": results},
            {"label": "Heavier bottle", "scenario": "Heavier bottle",
             "results": [{**results[0], "score": 0.52}]},
        ],
        "health": {"activities": 2,
                   "findings": [{"severity": "warning", "activity": {"name": "bottling"}, "message": "no location"}]},
        "web_research": [{"question": "How heavy is a PET bottle?",
                          "findings": [{"sources": ["https://research.test/pet"]}]}],
    }
    # The snapshot's own summary, so the conditions the gate reads are the ones a real report carries.
    data["checks"] = report_checks.checks_summary(data)
    report = {
        "lang": "en",
        "options": {},
        "abbreviations": {"LDPE": "Low-density polyethylene"},
        "sections": [
            {"id": "i", "kind": "inventory", "order": 0,
             "inventory_parts": ["processes", "datasets", "parameters", "flows"]},
            {"id": "d", "kind": "datasets", "order": 1},
            {"id": "l", "kind": "lcia", "order": 2},
            {"id": "c", "kind": "contribution", "order": 3},
            {"id": "k", "kind": "interpretation_checks", "order": 4},
            {"id": "x", "kind": "appendix", "order": 5},
            {"id": "r", "kind": "references", "order": 6},
            {"id": "g", "kind": "abbreviations", "order": 7},
            # Two chapters that draw something of their own, in both spellings of the key that holds it:
            # a `figures` list (labels `f-section-…-<i>`) and the single `figure` an AI write stores
            # (label `f-section-…`). Without one of these in the fixture the guards below never look at
            # the one field a write can change on the chapter under judgement — which is where the offer
            # and the authority came apart for a label neither list was missing (V215).
            {"id": "n", "kind": "prose", "order": 8, "text": "",
             "figures": [{"kind": "bar", "source": "contribution.groups", "value": "impact", "label": "key"},
                         {"kind": "heatmap"}]},
            {"id": "p", "kind": "prose", "order": 9, "text": "The LDPE film dominates.",
             "figure": {"kind": "bar", "source": "hotspots", "value": "share_percent", "label": "name"}},
        ],
    }
    return report, data


def test_the_authority_knows_every_table_the_renderer_prints():
    """The guard on the whole arrangement: what the gate accepts is compared against what the renderer
    actually labels, for a report that prints all of them. Five tables had drifted out of the list
    (V197) because nothing held the two sides together.

    Tables only. A figure's label depends on the chart the frontend hands over at export time, so
    comparing figures here would test the fixture rather than the code — `per_indicator_charts` and the
    switchable comparison figures have their own tests above.
    """
    from prism_lca.engine import report_render

    report, data = _every_table_report()
    blocks, _missing = report_render.blocks_for(report, data["study"], {"results": data["results"]}, None, data, {})
    printed = {str(b["label"]) for b in blocks if b.get("label") and str(b["label"]).startswith("t-")}
    authority = {label for label in rp.document_labels(report, data) if label.startswith("t-")}
    assert authority == printed

    # And the swap the legend rests on: with a methods chapter the mapping is that chapter's table,
    # and the legend is not drawn at all.
    with_methods = {**report, "sections": [*report["sections"], {"id": "m", "kind": "methods", "order": 9}]}
    labels = rp.document_labels(with_methods, data)
    assert "t-methods" in labels and "t-method-legend" not in labels


def test_the_brief_offers_less_than_the_gate_accepts_but_never_more():
    """Two questions, one source. The offer may be narrower — what a chapter *should* point at is a
    judgement — but it is derived by filtering `_WITHHELD_FROM_BRIEF` out of the same conditions, so it
    cannot drift the way the authority did. This also keeps that set honest: a name in it that nothing
    emits any more would be a filter on nothing.

    The fixture's last two chapters carry figures of their own, in both spellings, and that is not
    decoration: those are the only labels that depend on a *section* field rather than on the report and
    its data, so they are the only ones a write can change under the gate's feet. Held on a report whose
    chapters draw nothing, this relation was true and worthless — it passed all through V215, where the
    offer and the authority were the same two functions evaluated on two different documents. What the
    round trip does with them is
    `test_every_reference_the_brief_offers_is_accepted_by_the_write_that_uses_it`; this pins the
    per-document half, own figures included.
    """
    report, data = _every_table_report()
    authority = rp.document_labels(report, data)
    offered = {
        rp._label_in(entry["ref"])
        for section in report["sections"]
        for entry in rp.offered_renders(section, report, data)
    }
    assert offered <= authority
    assert {"f-section-n-0", "f-section-n-1", "f-section-p"} <= offered
    assert authority - offered == set(rp._WITHHELD_FROM_BRIEF)
    assert set(rp._WITHHELD_FROM_BRIEF) <= authority

    # The withheld label is a real one the gate accepts — a chapter may point at it, the brief just
    # does not suggest it.
    assert rp.check_proposal("See {{ref:t-method-legend}}.", report["sections"][-1], data, report=report)["ok"]


def test_the_per_indicator_breakdowns_are_offered_as_placeholder_paths():
    """The interpretation rules tell a chapter which phase leads *each* indicator. Left to the general
    walk, `contributions` fell past the 120-path cap on a three-indicator study — so the instruction
    named data the writer was never shown."""
    data = {
        "results": [{"method_label": "a", "score": 1.0, "unit": "kg"}],
        "contributions": [
            {"index": 0, "method_label": "EF / climate change",
             "groups": [{"key": "Use", "impact": 0.9, "share_text": "90.0 %"}]}
        ],
        # Enough filler to run past the cap if the ordering did not protect it.
        "noise": {f"k{i}": {f"j{j}": float(j) for j in range(20)} for i in range(20)},
    }
    paths = rp.placeholder_paths(data)
    assert "contributions.0.groups.0.share_text" in paths
    assert "contributions.0.method_label" in paths


def test_a_number_that_is_a_parameter_s_value_is_not_a_quotation():
    """Verbesserung 5, the third of it that is worth having.

    A number that appears in a description we handed over is a quotation and passes — that exemption
    was added after refusing "a 450 km transport distance recorded in a note" taught the writer to hide
    its own provenance. But the process notes name the parameter *and* spell its value out, so the
    exemption also waved through the one class of figure that is guaranteed to go stale: the
    an apple-juice report printed "the EUR pallet — 42 g of softwood allocated to each bottle"
    in prose, and the pallet share is 4 g now.
    """
    data = {
        **DATA,
        "parameters": [
            {"name": "mass_pallet_share", "amount": 0.042, "unit": "kg/unit"},
            {"name": "dist_dc_store", "amount": 500.0, "unit": "km"},
        ],
        "foreground": [{"description": "EUR pallet share per bottle: 42 g wood (parameter mass_pallet_share)."}],
    }
    verdict = rp.check_proposal("This is the EUR pallet — 42 g of softwood per bottle.", {"kind": "prose"}, data)
    literals = [f for f in verdict["findings"] if f["kind"] == "literal_number"]
    assert len(literals) == 1, verdict["findings"]
    assert "mass_pallet_share" in literals[0]["detail"]
    # …and it says *which* placeholder. "Write it as a placeholder" is only followable if the writer
    # knows the index, and the only way to find one used to be counting the parameter list in the
    # brief — which is how a report came to print a U-value as an element mass (V182). So the brief
    # states each parameter's path, and the finding names the one it is talking about.
    assert "{{parameters.0.amount}}" in literals[0]["detail"]
    assert rp.brief_facts(data)["parameters"][0]["path"] == "parameters.0"
    assert not verdict["ok"]
    # The unit the writer chose is free: 0.042 kg and 42 g are the same quantity, equally stale.
    assert [f["kind"] for f in rp.check_proposal(
        "The pallet share is 0.042 kg per bottle.", {"kind": "prose"}, data)["findings"]] == ["literal_number"]
    # …and it is not a mass-only rule.
    assert [f["kind"] for f in rp.check_proposal(
        "Goods travel 500 km to the store.", {"kind": "prose"}, data)["findings"]] == ["literal_number"]


def test_a_number_that_only_looks_like_a_parameter_stays_a_quotation():
    """The unit beside it is what makes this a rule rather than a coincidence.

    Keyed on the number alone, the first real chapter produced "GWP100" against a transport distance of
    100 km — the kind of finding that gets a checker switched off. And an ordinary quoted figure that
    is nobody's parameter must still pass, which is the whole reason the exemption exists.
    """
    data = {
        **DATA,
        "parameters": [{"name": "dist_pallet_plant", "amount": 100.0, "unit": "km"}],
        "study": {**DATA["study"], "scope": "A 20 g bag delivered over 300 km to retail."},
    }
    # The method name carries a 100 and the distance parameter is 100 km. No unit follows "GWP100",
    # so it is not that parameter's value — and the rule says nothing about it.
    findings = rp.check_proposal(
        "Following the IPCC 2021 / GWP100 method, the study reports one score.", {"kind": "prose"}, data
    )["findings"]
    assert not [f for f in findings if "parameter" in f.get("detail", "")], findings

    # …and an ordinary quoted figure that is nobody's parameter still passes untouched, which is the
    # whole reason the exemption exists.
    assert not [
        f
        for f in rp.check_proposal(
            "The bag is delivered over 300 km to retail.", {"kind": "prose"}, data
        )["findings"]
        if f["kind"] == "literal_number"
    ]


def test_the_gate_reads_the_document_the_renderer_will_print():
    """V165: `check_proposal` resolved by position while the renderer resolves by binding.

    After a rank swap the two disagree about every figure in the chapter: measured on the apple-juice
    report, the gate saw "Packaging (60.1 %)" where the PDF printed "Packaging (18.9 %)". Whatever the
    gate then judges — and whatever it reports as missing — is about a different document than the one
    that goes out.
    """
    written_against = {
        **DATA,
        "hotspots": [
            {"name": "glass production", "database": "d", "code": "g", "share_percent": 60.1,
             "share_text": "60.1 %"},
            {"name": "road freight", "database": "d", "code": "r", "share_percent": 18.9,
             "share_text": "18.9 %"},
        ],
    }
    text = "The leading dataset is {{hotspots.0.name}} at {{hotspots.0.share_text}}."
    from prism_lca.engine import report_data as rd

    bindings = rd.bindings_for(text, written_against)
    swapped = {**written_against, "hotspots": list(reversed(written_against["hotspots"]))}

    # Without the chapter's pins the gate reads the list by position — the old behaviour.
    assert "18.9 %" in rp.check_proposal(text, {"kind": "prose"}, swapped)["resolved"]
    # With them it reads what the document prints.
    verdict = rp.check_proposal(text, {"kind": "prose"}, swapped, bindings=bindings)
    assert "60.1 %" in verdict["resolved"] and "glass production" in verdict["resolved"]

    # …and a pinned member that has left the list is a gap for the gate too, not a stranger's figure.
    gone = {**written_against, "hotspots": [{"name": "extrusion", "database": "d", "code": "e"}]}
    findings = rp.check_proposal(text, {"kind": "prose"}, gone, bindings=bindings)["findings"]
    assert [f["kind"] for f in findings if f["kind"] == "unresolved_placeholder"]


def test_the_authority_is_never_narrower_than_the_renderer_whatever_the_report_looks_like():
    """The guard above compares one report that prints everything, and equality there does not settle
    the question a *refusal* rests on. `report_staleness` refuses a reference whose table the authority
    does not list (V198), so what it needs is the one-sided version of the same relation — printed ⊆
    known — held over the shapes a real report actually takes. A new table conditioned more narrowly
    here than in the renderer would pass the equality guard on the maximal fixture and hang a permanent
    rewrite badge on a reference the PDF resolves, which is the failure V197 and V190 both describe.

    The two shapes where the relation genuinely does not hold are named in
    `report_staleness._printed_tables`, which declines to judge them at all; they are asserted here as
    exceptions so that neither side can quietly grow a third.
    """
    from prism_lca.engine import report_checks, report_render, report_staleness

    def printed(report, data):
        blocks, _ = report_render.blocks_for(
            report, data.get("study") or {}, {"results": data.get("results") or []}, None, data, {}
        )
        return {str(b["label"]) for b in blocks if b.get("label") and str(b["label"]).startswith("t-")}

    def resummarised(data, **changes):
        moved = {**data, **changes}
        moved["checks"] = report_checks.checks_summary(moved)
        return moved

    base_report, base_data = _every_table_report()
    def without(kinds):
        return {**base_report, "sections": [s for s in base_report["sections"] if s["kind"] not in kinds]}

    hidden = {
        **base_report,
        "sections": [
            {**s, "hidden_indicators": [base_data["results"][0]["method_label"]]}
            if s["kind"] == "contribution"
            else s
            for s in base_report["sections"]
        ],
    }
    shapes = {
        "everything": (base_report, base_data),
        "results chapter deleted": (without({"lcia"}), base_data),
        "annex and bibliography deleted": (without({"appendix", "references"}), base_data),
        "prose only": ({**base_report, "sections": [{"id": "p", "kind": "prose", "order": 0}]}, base_data),
        "glossary empty": ({**base_report, "abbreviations": {}}, base_data),
        "glossary term unused": ({**base_report, "abbreviations": {"ZZZ": "Nothing uses this"}}, base_data),
        "contribution hidden": (hidden, base_data),
        "no scenarios": (base_report, resummarised(base_data, scenarios=[], subjects=base_data["subjects"][:1])),
        "no health": (base_report, resummarised(base_data, health={})),
        "clean health": (base_report, resummarised(base_data, health={"activities": 3, "findings": []})),
        "no parameters or flows": (base_report, resummarised(base_data, parameters=[], inventory={})),
        "no model at all": (base_report, resummarised(base_data, foreground=[], background_datasets=[])),
        "no sources": (base_report, resummarised(base_data, web_research=[], study={"functional_unit": "1 b"})),
    }
    for name, (report, data) in shapes.items():
        known = report_staleness._printed_tables(report, data)
        assert known is not None, name
        assert printed(report, data) <= known, (name, printed(report, data) - known)

    # And the two exceptions, each declining rather than guessing: a report that computed nothing (the
    # results table is labelled whatever its row count) and a snapshot without the §4.5 summary (the
    # three check tables are drawn from the data, not from it).
    assert report_staleness._printed_tables(base_report, {**base_data, "results": []}) is None
    assert report_staleness._printed_tables(base_report, {**base_data, "checks": {}}) is None


def test_a_name_in_bold_and_quotes_is_still_the_same_name():
    """V314. Both branches used to compare the span verbatim — quote marks and sentence punctuation
    included — so a writer that set a process in bold AND quotes, or let the comma fall inside the
    quotation, was told its OWN model's process does not exist. Measured on the LH-Lasur run of
    Seen once: five of six blocks on one LCI chapter were the study's own foreground processes."""
    data = {**DATA, "hotspots": [{"name": "Packaging production — 5 L pail"}]}
    for text in (
        'The inventory books **“Packaging production — 5 L pail”** against the container.',
        'The inventory books “Packaging production — 5 L pail,” against the container.',
        'The inventory books *Packaging production — 5 L pail*. It carries the lid.',
    ):
        verdict = rp.check_proposal(text, {"kind": "prose"}, data)
        assert not [f for f in verdict["findings"] if f["kind"] == "unsupported_fact"], (text, verdict["findings"])


def test_trimming_the_wrapper_does_not_blind_the_check():
    """The counter-case: a name that was never handed over is still caught through either wrapper."""
    for text in (
        'The study used **“Norwegian spruce forestry”** for the substrate.',
        'The study used “Norwegian spruce forestry,” for the substrate.',
    ):
        verdict = rp.check_proposal(text, {"kind": "prose"}, DATA)
        assert [f["kind"] for f in verdict["findings"] if f["kind"] == "unsupported_fact"] == ["unsupported_fact"], text


def test_abbreviation_contexts_show_the_words_around_each_token():
    """V410: the glossary model is handed where an abbreviation stands, not the bare token — so the lorry
    class beside EURO says it is not a currency, and the Typst machinery around the words is stripped."""
    from prism_lca.engine.report_abbreviations import abbreviation_contexts

    main = (
        'Der Lkw ist ein #strong[EURO 6]-Fahrzeug mit #pval("sec:results.0.score"); kg CO2-Eq, '
        "vgl. @t-sensitivity. Die Räder stammen von LUX-TOOLS."
    )
    ctx = abbreviation_contexts(main, ["EURO", "LUX", "PVC"])
    assert "EURO 6" in ctx["EURO"] and "#strong" not in ctx["EURO"] and "#pval" not in ctx["EURO"]
    assert "@t-sensitivity" not in ctx["EURO"]
    assert "LUX" not in ctx  # LUX-TOOLS is one word; the bare token never occurs
    assert "PVC" not in ctx
