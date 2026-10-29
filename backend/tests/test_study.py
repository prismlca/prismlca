from __future__ import annotations


def test_study_metadata_merge_and_undo(client, token, project):
    db = "model-a"
    assert client.get("/api/v1/study", params={"database": db}, headers=token).json() == {}

    r = client.post(
        "/api/v1/study",
        json={"database": db, "goal": "PCF of a PET bottle", "functional_unit": "1000 bottles"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["study"]["goal"] == "PCF of a PET bottle"

    # merge more fields
    client.post(
        "/api/v1/study",
        json={"database": db, "author": "Example Org", "allocation": "cut-off"},
        headers=token,
    )
    study = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert study["functional_unit"] == "1000 bottles"
    assert study["author"] == "Example Org"

    # undo the second edit -> author gone, goal still there
    client.post("/api/v1/model/undo", headers=token)
    study2 = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert "author" not in study2
    assert study2["goal"] == "PCF of a PET bottle"


def test_the_market_and_the_reference_year_are_fields_of_their_own(client, token, project):
    """Where the product is made and sold, and the year the data stand for: stored, printed in the goal &
    scope table under their own labels, and named by the health check while they are empty."""
    from prism_lca.engine.report_typst import goal_scope_blocks
    from prism_lca.engine.study import unrecorded_scope

    db = "model-a"
    assert {"geography", "reference_year"} <= {k for k, _ in unrecorded_scope({})}
    r = client.post(
        "/api/v1/study",
        json={"database": db, "geography": "Made in Poland, sold in Brazil", "reference_year": "2025"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    study = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert study["geography"] == "Made in Poland, sold in Brazil" and study["reference_year"] == "2025"
    assert not {"geography", "reference_year"} & {k for k, _ in unrecorded_scope(study)}

    rows = dict(goal_scope_blocks(study, "de")[1]["pairs"])
    assert rows["Geografischer Bezug"] == "Made in Poland, sold in Brazil"
    assert rows["Bezugsjahr"] == "2025"


def test_the_study_language_is_a_closed_choice(client, token, project):
    """The language the study is documented in: normalised to a bare code, refused when unknown —
    a report translates from it mechanically, so 'klingon' must fail here, not at render time."""
    db = "model-a"
    r = client.post("/api/v1/study", json={"database": db, "language": "DE-at"}, headers=token)
    assert r.status_code == 200, r.text
    assert client.get("/api/v1/study", params={"database": db}, headers=token).json()["language"] == "de"

    bad = client.post("/api/v1/study", json={"database": db, "language": "klingon"}, headers=token)
    assert bad.status_code == 400

    # An empty select means "leave it be", not "the language named ''".
    ok = client.post("/api/v1/study", json={"database": db, "language": "", "notes": "x"}, headers=token)
    assert ok.status_code == 200, ok.text
    assert client.get("/api/v1/study", params={"database": db}, headers=token).json()["language"] == "de"


def test_an_assistant_edit_stamps_which_model_wrote_it(client, token, project):
    """V128: when the assistant fills study fields, the study records the LLM behind it — and a
    user edit neither sets nor clears that stamp (provenance is a fact, not a form field)."""
    db = "model-a"
    client.post(
        "/api/v1/study",
        json={"database": db, "goal": "Screening LCA", "source": "ai", "ai_model": "qwen/qwen3.8-max"},
        headers=token,
    )
    study = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert study["ai_model"] == "qwen/qwen3.8-max"

    # A user edit carries no stamp and must not erase the recorded one.
    client.post("/api/v1/study", json={"database": db, "notes": "checked by hand"}, headers=token)
    # …and a user request that *claims* a model is not believed either.
    client.post(
        "/api/v1/study",
        json={"database": db, "notes": "still by hand", "ai_model": "made/up"},
        headers=token,
    )
    study = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert study["ai_model"] == "qwen/qwen3.8-max"

    # An AI call that sets no content does not re-sign someone else's text.
    client.post(
        "/api/v1/study",
        json={"database": db, "source": "ai", "ai_model": "other/model"},
        headers=token,
    )
    study = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert study["ai_model"] == "qwen/qwen3.8-max"


def test_study_metadata_is_per_model(client, token, project):
    client.post("/api/v1/study", json={"database": "model-a", "goal": "Study A"}, headers=token)
    client.post("/api/v1/study", json={"database": "model-b", "goal": "Study B"}, headers=token)
    a = client.get("/api/v1/study", params={"database": "model-a"}, headers=token).json()
    b = client.get("/api/v1/study", params={"database": "model-b"}, headers=token).json()
    assert a["goal"] == "Study A"
    assert b["goal"] == "Study B"


def test_study_text_keeps_the_characters_the_author_meant(client, token, project):
    """HTML entities are undone on the way in (V108).

    A study field is prose, and every consumer escapes for itself on the way out, so an entity
    arriving here only ever survives as literal text. A solar-lamp run had an assistant
    write "&lt;1 g" into the system boundaries; it was stored, and would have printed, like that.
    """
    db = "model-entities"
    client.post(
        "/api/v1/study",
        json={
            "database": db,
            "cutoff_criteria": "wires and screws (&lt;1 g per lamp, &lt;1 % of mass)",
            "notes": "Cradle-to-grave &amp; screening; &quot;typical&quot; values",
            "limitations": [{"kind": "exclusion", "subject": "Cut-off", "text": "Parts &lt; 1 g"}],
        },
        headers=token,
    )
    study = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert study["cutoff_criteria"] == "wires and screws (<1 g per lamp, <1 % of mass)"
    assert study["notes"] == 'Cradle-to-grave & screening; "typical" values'
    assert study["limitations"][0]["text"] == "Parts < 1 g"
    # An ampersand that was already an ampersand stays one — no double unescaping.
    client.post("/api/v1/study", json={"database": db, "author": "Smith & Sons"}, headers=token)
    assert client.get("/api/v1/study", params={"database": db}, headers=token).json()["author"] == (
        "Smith & Sons"
    )


def test_whether_a_critical_review_happened_is_a_closed_choice_the_author_owns(client, token, project):
    """V191: a yes/no beside the description, because the description could not answer it.

    Two properties are worth pinning. It is closed — a third spelling would be stored and then read as
    "not confirmed", which is safe but silent. And it is the *author's*: confirming that an independent
    review took place is a statement about the world outside the model, and the one statement that
    switches off the ISO 14044 §7.3.3 note, so an assistant may describe a review but never confirm one.
    """
    db = "model-a"
    r = client.post("/api/v1/study", json={"database": db, "critical_review_done": "YES"}, headers=token)
    assert r.status_code == 200, r.text
    study = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert study["critical_review_done"] == "yes"

    bad = client.post("/api/v1/study", json={"database": db, "critical_review_done": "maybe"}, headers=token)
    assert bad.status_code == 400

    # "Not recorded" has to be able to take a "yes" back — unlike an empty study language, it is an answer.
    client.post("/api/v1/study", json={"database": db, "critical_review_done": ""}, headers=token)
    assert client.get("/api/v1/study", params={"database": db}, headers=token).json()["critical_review_done"] == ""

    # The assistant writes the description; the answer it must not touch is dropped, not obeyed.
    client.post(
        "/api/v1/study",
        json={"database": db, "source": "ai", "critical_review_done": "yes",
              "critical_review": "Keine kritische Prüfung (interne Screening-Studie)."},
        headers=token,
    )
    study = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert study["critical_review_done"] == ""
    assert study["critical_review"].startswith("Keine kritische Prüfung")


# --- comparison models ------------------------------------------------------------------------------
def _fg(client, token, name: str) -> str:
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    return name


def test_comparison_models_are_linked_on_both_sides_and_undoable(client, token, project):
    """B compared with A means A compared with B — one call writes both studies,
    unlinking clears both, and neither the study form nor the assistant's model_info can write one side."""
    r = client.post("/api/v1/study/link", json={"database": "pet", "other": "glass"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["compared_with"] == ["glass"]
    assert client.get("/api/v1/study", params={"database": "glass"}, headers=token).json()["compared_with"] == ["pet"]
    # idempotent
    client.post("/api/v1/study/link", json={"database": "glass", "other": "pet"}, headers=token)
    assert client.get("/api/v1/study", params={"database": "pet"}, headers=token).json()["compared_with"] == ["glass"]
    # a model is never its own comparison
    r = client.post("/api/v1/study/link", json={"database": "pet", "other": "pet"}, headers=token)
    assert r.status_code >= 400
    # the generic study write cannot touch the relation
    client.post("/api/v1/study", json={"database": "pet", "goal": "x", "compared_with": ["alu"]}, headers=token)
    assert client.get("/api/v1/study", params={"database": "pet"}, headers=token).json()["compared_with"] == ["glass"]
    # unlink from the other side clears both
    r = client.post("/api/v1/study/unlink", json={"database": "glass", "other": "pet"}, headers=token)
    assert r.status_code == 200, r.text
    assert "compared_with" not in client.get("/api/v1/study", params={"database": "pet"}, headers=token).json()
    assert "compared_with" not in client.get("/api/v1/study", params={"database": "glass"}, headers=token).json()
    # undo puts the link back on both sides
    client.post("/api/v1/model/undo", headers=token)
    assert client.get("/api/v1/study", params={"database": "glass"}, headers=token).json()["compared_with"] == ["pet"]
    assert client.get("/api/v1/study", params={"database": "pet"}, headers=token).json()["compared_with"] == ["glass"]


def test_comparison_links_follow_a_rename_and_a_delete(client, token, project):
    from prism_lca.engine.study import StudyMetaStore

    store = StudyMetaStore()
    store.link("pet", "glass")
    store.link("pet", "alu")
    store.rename_database("pet", "pet-bottle")
    assert store.compared_with("glass") == ["pet-bottle"]
    assert store.compared_with("alu") == ["pet-bottle"]
    assert sorted(store.compared_with("pet-bottle")) == ["alu", "glass"]
    store.remove_database("glass")
    assert store.compared_with("pet-bottle") == ["alu"]
    assert store.compared_with("glass") == []


def test_a_duplicate_does_not_inherit_the_comparison_relation(client, token, project):
    """A copy would hold one half of a symmetric relation. Linking the copy is the user's act."""
    a = _fg(client, token, "cmp-a")
    client.post("/api/v1/study", json={"database": a, "goal": "PCF"}, headers=token)
    client.post("/api/v1/study/link", json={"database": a, "other": "cmp-b"}, headers=token)
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": a, "name": "cmp-a-copy"}, headers=token)
    assert r.status_code == 200, r.text
    copy = client.get("/api/v1/study", params={"database": "cmp-a-copy"}, headers=token).json()
    assert copy["goal"] == "PCF"
    assert "compared_with" not in copy


def test_the_comparison_brief_carries_the_frame_and_the_structure_but_no_results(client, token, project):
    db = _fg(client, token, "brief-a")
    client.post(
        "/api/v1/study",
        json={
            "database": db,
            "functional_unit": "Packaging for 500 mL of water",
            "geography": "Made in Poland, sold in Brazil",
            "system_boundaries": "Cradle to grave; transport excluded.",
            "limitations": [{"text": "Transport is excluded at the commissioner's request.", "kind": "exclusion"}],
        },
        headers=token,
    )
    r = client.post(
        "/api/v1/model/activities",
        json={"database": db, "name": "Primary packaging — bottle", "product": "bottle", "unit": "unit"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    code = r.json()["activity"]["code"]
    client.post(
        "/api/v1/model/tag-groups", json={"name": "Life-cycle phase", "values": ["Packaging production"]}, headers=token
    )
    client.post(
        "/api/v1/model/tags",
        json={"database": db, "code": code, "dimension": "Life-cycle phase", "value": "Packaging production"},
        headers=token,
    )
    client.post(
        "/api/v1/params", json={"database": db, "name": "dist_supply_km", "amount": 500, "unit": "km",
                                "description": "Inbound transport, generic default"}, headers=token
    )
    r = client.get("/api/v1/study/comparison-brief", params={"database": db}, headers=token)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["exists"] is True and out["chars"] == len(out["markdown"])
    md = out["markdown"]
    assert f"# Comparison model: `{db}`" in md
    assert "Packaging for 500 mL of water" in md
    assert "**geography**: Made in Poland, sold in Brazil" in md  # the market is part of the frame
    assert "Life-cycle phase: Packaging production" in md
    assert "[exclusion] Transport is excluded" in md
    assert "Primary packaging — bottle" in md
    assert "`dist_supply_km` = 500 km" in md
    assert "Inbound transport, generic default" in md
    # no results, no health check, no review: the brief describes the model, not how it scored
    for word in ("kg CO2", "score", "health check", "review"):
        assert word not in md.lower()
    # a model that is not in the project is said to be missing, not an error
    r = client.get("/api/v1/study/comparison-brief", params={"database": "nope"}, headers=token)
    assert r.status_code == 200
    assert r.json()["exists"] is False and "not in the current workspace" in r.json()["markdown"]


def test_renaming_between_two_names_that_share_a_file_keeps_the_data(client, token, project):
    """"A B" and "A_B" sanitise to the same file; the rename wrote it and then
    unlinked it as the source."""
    from prism_lca.engine.study import StudyMetaStore

    store = StudyMetaStore()
    store.replace("A B", {"goal": "keep me"})
    store.rename_database("A B", "A_B")
    assert store.get("A_B").get("goal") == "keep me"


def test_the_same_limitation_twice_is_kept_once(client, token, project):
    """An assistant appending its limitations in two turns re-sent the earlier ones, and the chapter
    printed the customer-trip paragraph twice (V408c). One statement, one entry."""
    from prism_lca.engine.study import clean_limitations

    out = clean_limitations(
        [
            {"text": "Die Fahrt des Kunden zum Markt ist nicht enthalten.", "kind": "exclusion"},
            "Eigene Schätzung ohne Primärdaten.",
            {"text": "Die Fahrt des Kunden zum Markt ist nicht enthalten.", "kind": "exclusion"},
        ]
    )
    assert [x["text"] for x in out] == [
        "Die Fahrt des Kunden zum Markt ist nicht enthalten.",
        "Eigene Schätzung ohne Primärdaten.",
    ]
