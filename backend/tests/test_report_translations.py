"""Study-borne prose, carried into the report's language (V123).

Collecting is deterministic and translating is a model's job — these tests cover everything but
the model: the walk, the language-bound apply, the candidate gate, and the endpoint round trip.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import report_snapshot
from prism_lca.engine import report_translations as rtr


@pytest.fixture(autouse=True)
def _clean_cache():
    report_snapshot.invalidate()
    yield
    report_snapshot.invalidate()


def _data() -> dict:
    return {
        "study": {
            "goal": "Wo liegen die Klimawirkungen?",
            "functional_unit": "1 Glas Apfelmus",
            "author": "Jonas Harth",  # a name, not prose — must never be offered
            "limitations": [{"kind": "assumption", "text": "Eigene Schätzung ohne Primärdaten."}],
        },
        "activity": {"name": "Bio-Apfelmus 500 g", "code": "abc"},
        "foreground": [
            {
                "name": "Produktion und Abfüllung",
                "product": "abgefülltes Apfelmus",
                "unit": "unit",
                "location": "DE",
                "description": "Heißabfüllung des Apfelmus.",
            }
        ],
        "background_datasets": [{"name": "market for tap water", "product": "tap water"}],
        "hotspots": [{"database": "ei", "code": "x", "name": "market for tap water"}],
        "parameters": [{"name": "n_cycles", "comment": "Anzahl der Umläufe."}],
        "scenarios": [{"name": "Wenige Umläufe (5)", "description": "Pessimistischer Fall."}],
        "subjects": [{"label": "Wenige Umläufe (5)", "code": "abc", "scenario": "s1"}],
        "review": {"open": [{"finding": "Customer trip excluded", "reason": "Als Limitation vermerkt."}]},
    }


def test_the_walk_collects_prose_and_only_prose():
    found = {c["text"] for c in rtr.candidates(_data())}
    assert "Wo liegen die Klimawirkungen?" in found
    assert "Eigene Schätzung ohne Primärdaten." in found
    assert "Produktion und Abfüllung" in found
    assert "Anzahl der Umläufe." in found
    assert "Jonas Harth" not in found  # author is a name
    assert "n_cycles" not in found  # parameter names are identifiers
    # V193: the reference product stood beside a translated process name and stayed German in all
    # seven rows of a real Spanish inventory table — it is the modeller's word, like the name.
    assert "abgefülltes Apfelmus" in found
    # Its siblings in the same row are identifiers, and one of them ("unit") only *looks* like a word.
    assert "unit" not in found
    assert "DE" not in found
    # And what the study did not write stays out: ecoinvent's name and its product, in either list.
    assert "market for tap water" not in found
    assert "tap water" not in found
    # The scenario name and the subject label are the same string — one candidate, not two.
    assert sum(1 for c in rtr.candidates(_data()) if c["text"] == "Wenige Umläufe (5)") == 1


def test_apply_substitutes_in_language_and_leaves_the_rest():
    data = _data()
    key = rtr.source_key("Wenige Umläufe (5)")
    stored = {"lang": "en", "map": {key: "Few cycles (5)"}}
    hits = rtr.apply(data, stored, "en")
    # The same source string is substituted everywhere it appears: scenario name AND subject label.
    assert hits == 2
    assert data["scenarios"][0]["name"] == "Few cycles (5)"
    assert data["subjects"][0]["label"] == "Few cycles (5)"
    assert data["study"]["goal"] == "Wo liegen die Klimawirkungen?"  # no entry → original stays


def test_the_reference_product_is_translated_and_the_dataset_name_is_not():
    """A German model in a Spanish report: the modeller's two strings move, ecoinvent's do not.

    The row that named the finding read "Tubo — Suministro de glicerina | Glycerin,
    kosmetiktauglich": process translated, product not. Both halves are checked here, and so is the
    documented exception — a group label is a binding identity and must survive translation.
    """
    data = _data()
    data["contribution"] = {"groups": [{"key": "Verpackung", "share_percent": 12.0}]}
    stored = {
        "lang": "es",
        "map": {
            rtr.source_key("Produktion und Abfüllung"): "Producción y llenado",
            rtr.source_key("abgefülltes Apfelmus"): "compota de manzana envasada",
            # Offered by nobody — the walk never collected either of these, so a map that carries
            # them anyway (a hand-edited report, a bundle from elsewhere) must not spend them.
            rtr.source_key("market for tap water"): "mercado de agua del grifo",
            rtr.source_key("Verpackung"): "Envase",
        },
    }
    rtr.apply(data, stored, "es")
    process = data["foreground"][0]
    assert process["name"] == "Producción y llenado"
    assert process["product"] == "compota de manzana envasada"
    assert process["unit"] == "unit" and process["location"] == "DE"
    assert data["background_datasets"][0]["product"] == "tap water"
    assert data["hotspots"][0]["name"] == "market for tap water"
    assert data["contribution"]["groups"][0]["key"] == "Verpackung"


def test_applying_twice_changes_nothing_more():
    """Idempotence, on the field the finding added: the second pass has no source left to match."""
    data = _data()
    stored = {"lang": "es", "map": {rtr.source_key("abgefülltes Apfelmus"): "compota de manzana envasada"}}
    assert rtr.apply(data, stored, "es") == 1
    assert rtr.apply(data, stored, "es") == 0
    assert data["foreground"][0]["product"] == "compota de manzana envasada"


def test_editing_the_product_withdraws_its_translation():
    """Keys are hashes of the source, so renaming the product in the model drops the old answer —
    the same guarantee the process notes have, and the reason nothing has to be invalidated."""
    data = _data()
    stored = {"lang": "es", "map": {rtr.source_key("abgefülltes Apfelmus"): "compota de manzana envasada"}}
    data["foreground"][0]["product"] = "abgefülltes Bio-Apfelmus"  # the modeller renamed it
    assert rtr.apply(data, stored, "es") == 0
    assert data["foreground"][0]["product"] == "abgefülltes Bio-Apfelmus"
    assert "abgefülltes Bio-Apfelmus" in {c["text"] for c in rtr.candidates(data)}


def test_apply_refuses_a_map_made_for_another_language():
    data = _data()
    stored = {"lang": "en", "map": {rtr.source_key("1 Glas Apfelmus"): "One jar of apple purée"}}
    assert rtr.apply(data, stored, "fr") == 0
    assert data["study"]["functional_unit"] == "1 Glas Apfelmus"


def test_accept_gates_on_the_candidates_and_keeps_identity():
    known = {"k1": "Heißabfüllung", "k2": "already English"}
    accepted = rtr.accept(known, {"k1": "Hot filling", "k2": "already English", "kX": "invented", "k3": ""})
    assert accepted == {"k1": "Hot filling", "k2": "already English"}


def test_accept_refuses_a_translation_that_changes_a_figure():
    """A stored translation is a quotable source for the gate: "Transport über 300 km" accepted as
    "Transport over 900 km" let a chapter cite 900 km. Separators may change,
    figures may not."""
    known = {"k1": "Transport über 300 km.", "k2": "Masse 1,5 kg, 1.500 Stück, Jahr 2026.", "k3": "300, 400 und 500 km"}
    accepted, refused = rtr.accept_with_reasons(
        known,
        {
            "k1": "Transport over 900 km.",
            "k2": "Mass 1.5 kg, 1,500 pieces, year 2026.",
            "k3": "300, 400 and 500 km",
        },
    )
    assert set(accepted) == {"k2", "k3"}
    assert "k1" in refused and "300" in refused["k1"] and "900" in refused["k1"]
    assert rtr.unfaithful("ohne Zahl", "no number") is None


# ---- the endpoint round trip --------------------------------------------------------------------

def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("tr").write(
        {
            ("tr", "a"): {
                "name": "Produktion und Abfüllung", "unit": "unit",
                "reference product": "Apfelmus", "location": "DE",
                "exchanges": [
                    {"input": ("tr", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])


@pytest.fixture
def report(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    return client.post(
        "/api/v1/report/create",
        json={"database": "tr", "lang": "en", "methods": [["t", "gwp"]],
              "subjects": [{"database": "tr", "code": "a"}]},
        headers=token,
    ).json()


def test_translations_round_trip(client, token, report):
    base = f"/api/v1/report/one/tr/{report['id']}"
    # A German study record: the goal & scope chapter prints critical_review VERBATIM from the
    # study dict, which is exactly where an untranslated line survived into a real English PDF.
    client.post(
        "/api/v1/study",
        json={"database": "tr", "critical_review": "Kein externes Review durchgeführt."},
        headers=token,
    )
    found = client.post(f"{base}/translations", json={}, headers=token).json()
    assert found["language"] == "en"
    open_texts = {c["text"]: c["key"] for c in found["open"]}
    assert "Produktion und Abfüllung" in open_texts
    assert "Kein externes Review durchgeführt." in open_texts
    # V193: the reference product travels the same road as the name, from the real model onwards —
    # `report_context` reads it off the activity, so a walk that misses it misses it here too.
    assert "Apfelmus" in open_texts

    key = open_texts["Produktion und Abfüllung"]
    product_key = open_texts["Apfelmus"]
    review_key = open_texts["Kein externes Review durchgeführt."]
    stored = client.post(
        f"{base}/translations/set",
        json={"resolved": {
            key: "Production and filling",
            product_key: "apple purée",
            review_key: "No external review was carried out.",
            "bogus": "invented",
        }},
        headers=token,
    ).json()
    assert stored["translated"] == 3
    assert stored["dropped"] == ["bogus"]

    # Settled: the covered source is no longer offered…
    again = client.post(f"{base}/translations", json={}, headers=token).json()
    assert key not in {c["key"] for c in again["open"]}
    # …and the snapshot the chapters are written from carries the translated name.
    r = client.post(f"{base}/sources", json={}, headers=token).json()
    assert any(a.get("name") == "Production and filling" for a in r["data"]["foreground"])
    assert any(a.get("product") == "apple purée" for a in r["data"]["foreground"])
    # The typeset document itself is translated too — the goal & scope chapter used to read the RAW
    # study dict past the translation layer.
    import base64
    import io
    import zipfile

    bundle = client.post(f"{base}/bundle", json={"allow_gaps": True}, headers=token).json()
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["base64"]))) as zf:
        main = zf.read("main.typ").decode("utf-8") + zf.read("tables.json").decode("utf-8")
    assert "No external review was carried out." in main
    assert "Kein externes Review" not in main
    # The inventory table's product column, and the cover: the subtitle spells the reference process
    # out under the title and read it from the RAW lcia dict, so the German name printed on page one
    # of an English document while the table two pages later was translated (V193, sibling).
    assert "apple purée" in main
    assert "Apfelmus" not in main
    assert "Produktion und Abfüllung" not in main

    # Once the chapter carries prose the row is gone entirely: the one surviving "Critical review"
    # box above the written text read as a stamp on the chapter, so a written
    # goal & scope prints heading and prose only — the fact lives in the writer's own sentences and
    # in the limitations chapter. Neither language's field row may appear above the written text.
    sections = client.get(base, headers=token).json()["sections"]
    gs = next(s for s in sections if s["kind"] == "goal_scope")
    client.post(
        f"{base}/sections/{gs['id']}/proposal",
        json={"text": "This chapter describes the goal.", "store": True},
        headers=token,
    )
    bundle = client.post(f"{base}/bundle", json={"allow_gaps": True}, headers=token).json()
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["base64"]))) as zf:
        main = zf.read("main.typ").decode("utf-8") + zf.read("tables.json").decode("utf-8")
    assert "This chapter describes the goal." in main
    assert "No external review was carried out." not in main
    assert "Kein externes Review" not in main


def test_an_unchanged_answer_is_settled_but_offered_again(client, token, report):
    """A stored answer that IS the source leaves `open` (the count reaches zero) but rides along
    under `unchanged`: a lazy model that kept a German scenario name would otherwise be stuck as
    "checked" forever — asking again is the only way out."""
    base = f"/api/v1/report/one/tr/{report['id']}"
    found = client.post(f"{base}/translations", json={}, headers=token).json()
    key = next(c["key"] for c in found["open"] if c["text"] == "Produktion und Abfüllung")
    client.post(
        f"{base}/translations/set",
        json={"resolved": {key: "Produktion und Abfüllung"}},  # the model kept it unchanged
        headers=token,
    )
    again = client.post(f"{base}/translations", json={}, headers=token).json()
    assert key not in {c["key"] for c in again["open"]}
    assert key in {c["key"] for c in again["unchanged"]}
    # A real translation replaces the identity entry and leaves `unchanged`.
    client.post(
        f"{base}/translations/set",
        json={"resolved": {key: "Production and filling"}},
        headers=token,
    )
    final = client.post(f"{base}/translations", json={}, headers=token).json()
    assert key not in {c["key"] for c in final["unchanged"]}


def test_a_language_switch_orphans_the_map(client, token, report):
    base = f"/api/v1/report/one/tr/{report['id']}"
    found = client.post(f"{base}/translations", json={}, headers=token).json()
    key = next(c["key"] for c in found["open"] if c["text"] == "Produktion und Abfüllung")
    client.post(f"{base}/translations/set", json={"resolved": {key: "Production and filling"}}, headers=token)
    client.post(base, json={"lang": "de"}, headers=token)
    after = client.post(f"{base}/translations", json={}, headers=token).json()
    assert after["stored"] == 0
    assert key in {c["key"] for c in after["open"]}


# --- V158: the study language was a silently defaulted field -------------------------------------

from prism_lca.engine.report_translations import detect_language  # noqa: E402

_DE = (
    "Screening-Ökobilanz für das HORNBACH LED Solar Bodenleuchten 4er-Set, verkauft auf dem deutschen "
    "Markt. Ziel ist es, die Klimawirkung und die wesentlichen Hotspots über den gesamten Lebensweg zu "
    "identifizieren; die Daten stammen aus der Produktseite und werden mit eigenen Schätzungen ergänzt."
)
_EN = (
    "A screening life cycle assessment of the product sold on the German market. The goal is to identify "
    "the climate impact and the significant hotspots over the entire life cycle, and the data are taken "
    "from the product page and supplemented with our own estimates."
)


def test_a_german_study_is_recognised_as_german():
    assert detect_language({"study": {"goal": _DE}}) == "de"


def test_an_english_study_is_recognised_as_english():
    assert detect_language({"study": {"goal": _EN}}) == "en"


def test_a_label_is_not_prose_and_gets_no_verdict():
    """Four words cannot carry a language, and a coin toss here would be worse than a question."""
    assert detect_language({"study": {"functional_unit": "1 Pack LED Solar"}}) == ""


def test_declared_limitations_count_as_prose():
    """The page of German that gave the finding its name lives in `limitations`, not in `goal`."""
    data = {"study": {"limitations": [{"text": _DE}]}}
    assert detect_language(data) == "de"


def test_a_bare_study_dict_works_too():
    """The study endpoint has the study, not a report snapshot around it."""
    assert detect_language({"goal": _DE}) == "de"


def test_nothing_written_means_nothing_claimed():
    assert detect_language({}) == ""
    assert detect_language({"study": {}}) == ""


# --- the variants' printed names (V223's second half) ---------------------------------------------


def _comparison(lang: str = "fr") -> dict:
    """A real two-variant snapshot, built by `build_data` so the lists have their production shape."""
    from prism_lca.engine import report_data as rd

    def tree() -> dict:
        return {
            "aggregation": {
                "dimension": "tag:Phase",
                "groups": [{"key": "Produktion", "impact": 1.0, "share": 1.0}],
            },
            "meta": {"unit": "kg"},
        }

    lcia = {
        "activity": {"name": "Kunststofffenster", "database": "d", "code": "w"},
        "amount": 1.0,
        "results": [{"method": ["m", "gwp"], "unit": "kg", "score": 1.0}],
    }
    subjects = [
        {"label": "Kunststofffenster 100x120", "code": "w", "scenario": None, "lcia": lcia},
        {"label": "Holzfenster 100x120", "code": "t", "scenario": None, "lcia": lcia},
    ]
    per_subject = [
        {"label": s["label"], "code": s["code"], "scenario": s["scenario"], "contribution": tree()}
        for s in subjects
    ]
    return rd.build_data(
        {}, lcia, tree(), lang=lang,
        subjects=subjects,
        subject_contributions=per_subject,
        contributions=[
            {"index": 0, "method_label": "m / gwp", "contribution": tree(),
             "subjects": per_subject, "hotspots": []}
        ],
    )


def test_the_variant_name_is_translated_in_the_breakdown_rows_too():
    """V223's second half: these rows head the contribution matrix and the grouped and stacked chart
    legends. They were left out while the label *was* their identity; since they carry `variant` the
    reason is gone, and what was left of it was a French report whose prose said "la fenêtre PVC
    100×120" over a table headed in German — one object, two languages, facing pages."""
    data = _comparison()
    stored = {
        "lang": "fr",
        "map": {
            rtr.source_key("Kunststofffenster 100x120"): "fenêtre PVC 100×120",
            # The group *label* takes it (V240); the key beside it must not move.
            rtr.source_key("Produktion"): "production",
        },
    }
    # Four sites for the variant name — the comparison list, the score-ordered view, the flat
    # per-variant breakdown and the per-indicator copy of it — and six for the group label: the flat
    # breakdown and the per-indicator one, plus each of the two variants in each of them.
    assert rtr.apply(data, stored, "fr") == 10
    assert data["subjects"][0]["label"] == "fenêtre PVC 100×120"
    assert data["results"][0]["subjects_by_score"][0]["label"] == "fenêtre PVC 100×120"
    assert data["contribution_subjects"][0]["label"] == "fenêtre PVC 100×120"
    assert data["contributions"][0]["subjects"][0]["label"] == "fenêtre PVC 100×120"
    # The group is printed in French and still binds by its German key, in every list that carries it.
    for group in (
        data["contribution"]["groups"][0],
        data["contributions"][0]["groups"][0],
        data["contribution_subjects"][0]["groups"][0],
        data["contributions"][0]["subjects"][0]["groups"][0],
    ):
        assert group["label"] == "production"
        assert group["key"] == "Produktion"
    # And the identity never goes through the map — it is not a string anybody reads.
    assert data["subjects"][0]["variant"] == "w"
    assert data["contribution_subjects"][0]["variant"] == "w"
    assert data["contributions"][0]["subjects"][0]["variant"] == "w"


def test_the_breakdown_dimension_and_its_values_reach_the_report_language():
    """V240: the Balkonkraftwerk report was English and its contribution chapter half German — the
    heading said "Bauteil" and every row under it named a German component. The dimension is a name
    the modeller typed and the tag values are more of the same: study text, like a scenario name."""
    from prism_lca.engine import report_typst as rt

    data = _comparison()
    stored = {
        "lang": "en",
        "map": {
            rtr.source_key("Phase"): "Life cycle stage",
            rtr.source_key("Produktion"): "Manufacturing",
        },
    }
    rtr.apply(data, stored, "en")
    assert data["contribution"]["dimension_label"] == "Life cycle stage"
    # The raw marker is untouched: it says how the breakdown was aggregated, not what to print.
    assert data["contribution"]["dimension"] == "tag:Phase"

    blocks = rt.indicator_contribution_blocks(data["contributions"][0], "en")
    table = next(b for b in blocks if b["type"] == "table")
    assert table["rows"][0][0] == "Manufacturing"


def test_a_rank_declaration_on_a_group_prints_the_report_language():
    """V248: V240 translated the tables, the heading, the captions and the chart axes — and left the
    one token the writing rules push authors towards. Three chapters of a wood-stain
    report said "Manufacturing" in their prose and declared "Herstellung" in the same sentence."""
    from prism_lca.engine import report_data as rd

    data = _comparison()
    stored = {"lang": "en", "map": {rtr.source_key("Produktion"): "Manufacturing"}}
    rtr.apply(data, stored, "en")

    assert rd.rank_name("rank:contribution.groups.0", data) == "Manufacturing"
    assert rd.rank_name("rank:contributions.0.groups.0", data) == "Manufacturing"
    # The pin is unchanged: it names the key, and the label rides along as an "@" field that
    # `identity_matches` skips.
    pin = rd.bindings_for("{{contribution.groups.0.share_text}}", data)["contribution.groups.0"]
    assert pin["key"] == "Produktion"
    assert rd.identity_matches({"key": "Produktion", "label": "Manufacturing"}, pin)


def test_everything_the_document_prints_goes_through_the_walk():
    """V252/V255: lists that were printed but never offered. Page 18 of an English report carried three
    German paragraphs of review findings, and a foreground process stood in the inventory table in
    English and in the hotspot sentence in German. (The German research questions went the other way —
    V251 stopped printing them at all.)"""
    data = {
        "activity": {"name": "Fenster", "database": "d", "code": "w"},
        "review": {"open": [{"finding": "Leinöl-Proxy ist ein Schätzwert", "reason": "Bleibt bestehen"}]},
        "web_research": [{"question": "Wie schwer ist eine Weißblech-Dose?", "findings": []}],
        "hotspots": [
            {"database": "d", "code": "w", "name": "Nutzung — Anstrich", "product": "Fläche"},
            {"database": "ecoinvent", "code": "x", "name": "market for steel", "product": "steel"},
        ],
    }
    offered = {c["text"] for c in rtr.candidates(data)}
    assert "Leinöl-Proxy ist ein Schätzwert" in offered
    assert "Bleibt bestehen" in offered
    # The research QUESTION is no longer offered — it is no longer printed either (V251): a
    # bibliography lists what was consulted, not what somebody typed into a search box.
    assert "Wie schwer ist eine Weißblech-Dose?" not in offered
    assert "Nutzung — Anstrich" in offered
    # …and ecoinvent's own names are still left alone. They are identifiers, not prose.
    assert "market for steel" not in offered

    stored = {"lang": "en", "map": {rtr.source_key("Nutzung — Anstrich"): "Use — coating"}}
    rtr.apply(data, stored, "en")
    assert data["hotspots"][0]["name"] == "Use — coating"
    assert data["hotspots"][1]["name"] == "market for steel"
    # The hotspot is bound by database+code; neither moved.
    assert data["hotspots"][0]["code"] == "w"


def test_one_name_in_four_places_is_offered_once():
    """The dedupe is `candidates`' own: a translator asked the same question four times would be
    four times the cost and four chances of four different answers."""
    data = _comparison()
    assert sum(1 for c in rtr.candidates(data) if c["text"] == "Kunststofffenster 100x120") == 1
    # Six sites for the group label since V240, and one question about it.
    assert sum(1 for c in rtr.candidates(data) if c["text"] == "Produktion") == 1


def test_the_typeset_results_table_carries_the_translated_variant_name():
    """The results matrix reads the render inputs' own subject list, not the translated snapshot — it
    needs each variant's raw `lcia` block beside the name — so it was the one table in the document
    that kept the German original while the prose, the breakdown table and the figures beside it had
    moved. Both tables now print one string, and the caller's list is left untranslated: it is the
    inputs memo's own, and the next render is served the same objects.
    """
    from prism_lca.engine import report_render

    def tree() -> dict:
        return {
            "aggregation": {"dimension": "tag:Phase", "groups": [{"key": "Phase", "impact": 1.0, "share": 1.0}]},
            "meta": {"unit": "kg"},
        }

    lcia = {
        "activity": {"name": "Kunststofffenster", "database": "d", "code": "w"},
        "amount": 1.0,
        "results": [{"method": ["m", "gwp"], "unit": "kg", "score": 1.0}],
    }
    subjects = [
        {"label": "Kunststofffenster 100x120", "code": "w", "scenario": None, "lcia": lcia},
        {"label": "Holzfenster 100x120", "code": "t", "scenario": None, "lcia": lcia},
    ]
    per_subject = [
        {"label": s["label"], "code": s["code"], "scenario": s["scenario"], "contribution": tree()}
        for s in subjects
    ]
    report = {
        "lang": "fr",
        "sections": [{"id": "l", "kind": "lcia", "order": 0}, {"id": "c", "kind": "contribution", "order": 1}],
        "translations": {
            "lang": "fr",
            "map": {rtr.source_key("Kunststofffenster 100x120"): "fenêtre PVC 100×120"},
        },
    }
    sources, _info = report_render.render_sources(
        report, {}, lcia, tree(),
        subjects=subjects,
        subject_contributions=per_subject,
        contributions=[
            {"index": 0, "method_label": "m / gwp", "contribution": tree(),
             "subjects": per_subject, "hotspots": []}
        ],
    )
    from prism_lca.engine import report_typst

    main = report_typst.document_text(sources)
    assert "Kunststofffenster 100x120" not in main
    assert main.count("fenêtre PVC 100×120") >= 2  # the results table and the breakdown matrix
    # The dicts the caller passed in are untouched — the memo keeps the untranslated record.
    assert subjects[0]["label"] == "Kunststofffenster 100x120"
    assert per_subject[0]["label"] == "Kunststofffenster 100x120"


def test_the_walk_reaches_the_extra_breakdown_dimensions():
    """A second contribution chapter is rendered from `contributions_by_dimension`,
    which the walk never visited — its groups and heading stayed in the model's language."""
    data = _data()
    data["contributions_by_dimension"] = {
        "tag:Bauteil": [{"dimension_label": "Bauteil", "groups": [{"key": "Montagegestell", "label": "Montagegestell"}]}]
    }
    found = {c["text"] for c in rtr.candidates(data)}
    assert "Montagegestell" in found and "Bauteil" in found


def test_the_reviews_open_findings_are_candidates_like_the_declared_limitations():
    """They print under the limitations in the builder's words (V408a) — so they travel with them."""
    texts = {c["text"] for c in rtr.candidates(_data())}
    assert "Customer trip excluded" in texts and "Als Limitation vermerkt." in texts


# --- V425: review findings in a report whose study shares its language ------------------------------


def test_review_candidates_carry_their_origin():
    """Only the review's texts are marked — the marker is what lets the endpoint pick them out."""
    by_text = {c["text"]: c for c in rtr.candidates(_data())}
    assert by_text["Customer trip excluded"].get("origin") == "review"
    assert by_text["Als Limitation vermerkt."].get("origin") == "review"
    assert "origin" not in by_text["Produktion und Abfüllung"]


@pytest.mark.parametrize(
    ("text", "lang"),
    [
        ("Datasets carrying 31 % of the result were not opened", "en"),
        ("End-of-life of in-joint sealant modelled with municipal waste datasets/statistics", "en"),
        ("Fill loss purchased but not disposed", "en"),
        ("Kein Silikon-spezifischer Datensatz für die Entsorgung, als Limitation vermerkt", "de"),
        ("Customer trip", ""),
    ],
)
def test_a_short_text_gets_a_language_by_its_function_words(text, lang):
    assert rtr.text_language(text) == lang


def test_an_english_finding_is_foreign_in_a_german_report_whatever_the_study_speaks():
    """A silicone run: study and report German, the reviewer's titles English (V425)."""
    english = {"key": "k1", "text": "Fill loss purchased but not disposed", "origin": "review"}
    german = {"key": "k2", "text": "Bleibt als Limitation vermerkt, weil kein Datensatz vorliegt", "origin": "review"}
    unclear = {"key": "k3", "text": "Customer trip excluded", "origin": "review"}
    assert rtr.foreign_review(english, "de") is True
    assert rtr.foreign_review(german, "de") is False  # the builder's note is already in the study language
    # Too short to tell: the reviewer writes English, so foreign unless the report is English.
    assert rtr.foreign_review(unclear, "de") is True
    assert rtr.foreign_review(unclear, "en") is False
    assert rtr.foreign_review(english, "en") is False
    # Not a review text: never foreign by this rule — the study → report step owns those.
    assert rtr.foreign_review({"key": "k4", "text": "Fill loss purchased but not disposed"}, "de") is False


def test_the_endpoint_lists_the_foreign_review_findings_on_their_own(client, token, report, monkeypatch):
    from prism_lca.engine import report_pipeline

    monkeypatch.setattr(
        report_pipeline.ReviewLogStore,
        "for_report",
        lambda self, db, gen=None: {
            "open": [
                {
                    "finding": "Datasets carrying 31 % of the result were not opened",
                    "reason": "Bleibt bestehen, weil die Datensätze nicht geöffnet wurden",
                    "resolution": "open",
                }
            ]
        },
    )
    base = f"/api/v1/report/one/tr/{report['id']}"
    client.post(base, json={"lang": "de"}, headers=token)
    found = client.post(f"{base}/translations", json={}, headers=token).json()
    foreign = {c["text"] for c in found["foreign"]}
    assert foreign == {"Datasets carrying 31 % of the result were not opened"}
    # The lists the client hands to a model stay {key, text}.
    assert all(set(c) == {"key", "text"} for c in found["open"] + found["foreign"])
    # Once translated it is no longer foreign.
    key = found["foreign"][0]["key"]
    client.post(
        f"{base}/translations/set",
        json={"resolved": {key: "Datensätze mit 31 % des Ergebnisses wurden nicht geöffnet"}},
        headers=token,
    )
    again = client.post(f"{base}/translations", json={}, headers=token).json()
    assert again["foreign"] == []


def test_the_foreign_findings_are_listed_without_building_the_snapshot(client, token, report, monkeypatch):
    """"Write all" asks this before anything is written. The review findings come from the review log, so
    the answer must not wait for the analysis snapshot — on an empty report that was the whole LCIA."""
    from prism_lca.engine import report_pipeline

    monkeypatch.setattr(
        report_pipeline.ReviewLogStore,
        "for_report",
        lambda self, db, gen=None: {
            "open": [
                {
                    "finding": "Datasets carrying 31 % of the result were not opened",
                    "reason": "Bleibt bestehen, weil die Datensätze nicht geöffnet wurden",
                    "resolution": "open",
                }
            ]
        },
    )
    base = f"/api/v1/report/one/tr/{report['id']}"
    client.post(base, json={"lang": "de"}, headers=token)
    # The full endpoint, for the answer the light one has to match.
    full = client.post(f"{base}/translations", json={}, headers=token).json()["foreign"]

    def no_snapshot(*args, **kwargs):
        raise AssertionError("the foreign findings must not build the analysis snapshot")

    def light() -> list:
        with monkeypatch.context() as m:
            m.setattr(report_pipeline, "analysis_snapshot", no_snapshot)
            r = client.post(f"{base}/translations/foreign", headers=token)
        assert r.status_code == 200, r.text
        return r.json()["foreign"]

    assert light() == full
    assert {c["text"] for c in full} == {"Datasets carrying 31 % of the result were not opened"}

    # A stored translation takes it off the list here as well.
    client.post(
        f"{base}/translations/set",
        json={"resolved": {full[0]["key"]: "Datensätze mit 31 % des Ergebnisses wurden nicht geöffnet"}},
        headers=token,
    )
    assert light() == []


def test_a_review_changed_after_the_snapshot_was_built_reaches_both_endpoints(client, token, report, monkeypatch):
    """The snapshot's key covers what moves numbers, and the review log moves none. A finding recorded or
    resolved while the snapshot is cached has to show in the full endpoint as it does in the light one,
    or the plan and the run of "Write all" disagree about the translation step."""
    from prism_lca.engine import report_pipeline

    finding = {
        "finding": "Datasets carrying 31 % of the result were not opened",
        "reason": "Bleibt bestehen, weil die Datensätze nicht geöffnet wurden",
        "resolution": "open",
    }
    review: dict = {"open": []}
    monkeypatch.setattr(report_pipeline.ReviewLogStore, "for_report", lambda self, db, gen=None: review)
    base = f"/api/v1/report/one/tr/{report['id']}"
    client.post(base, json={"lang": "de"}, headers=token)

    def full() -> list:
        return client.post(f"{base}/translations", json={}, headers=token).json()["foreign"]

    def light() -> list:
        return client.post(f"{base}/translations/foreign", headers=token).json()["foreign"]

    assert full() == [] == light()  # builds and caches the snapshot with no finding in it

    review["open"] = [finding]  # recorded after the build
    assert {c["text"] for c in full()} == {finding["finding"]}
    assert full() == light()

    review["open"] = []  # and resolved again
    assert full() == [] == light()
