"""The provenance logs: what the build researched, and what its internal review concluded.

Both exist because a chat dies and a report does not: the researched sources feed the bibliography's
"Sources researched during modelling" table, and the review log is what lets a study whose
`critical_review` field claims an internal review actually show its outcome.
"""
from __future__ import annotations

from prism_lca.engine.report_checks import limitations_blocks
from prism_lca.engine.report_prompts import brief_facts, build_brief, placeholder_paths
from prism_lca.engine.report_sources import researched_sources
from prism_lca.engine.research_log import ResearchLogStore, clean_bom_check, clean_entry
from prism_lca.engine.review_log import ReviewLogStore, tagged_findings

ENTRY = {
    "question": "empty weight of the 500 g deposit jar",
    "findings": [
        {"text": "The MMP 500 g jar weighs 220 g (retailer datasheet).",
         "sources": ["https://example.org/jar"]},
    ],
}


# --- research log ------------------------------------------------------------


def test_research_log_records_and_deduplicates(project):
    store = ResearchLogStore()
    assert store.record("m1", [ENTRY]) == {"added": 1, "total": 1}
    # The same finding again is not a second row; a NEW finding under the same question is.
    assert store.record("m1", [ENTRY])["added"] == 0
    more = {"question": ENTRY["question"],
            "findings": [ENTRY["findings"][0],
                         {"text": "A second retailer lists the same 220 g.", "sources": ["https://example.org/b"]}]}
    assert store.record("m1", [more])["added"] == 1
    entries = store.list("m1")
    assert len(entries) == 2
    assert entries[1]["findings"] == [
        {"text": "A second retailer lists the same 220 g.", "sources": ["https://example.org/b"]}
    ]
    assert all(e["asked"] for e in entries)


def test_research_log_refuses_junk_and_follows_renames(project):
    store = ResearchLogStore()
    assert store.record("m2", [{"question": ""}, {"question": "q", "findings": []}, "nope"])["added"] == 0
    store.record("m2", [ENTRY])
    store.rename_database("m2", "m2b")
    assert store.list("m2") == []
    assert len(store.list("m2b")) == 1
    store.remove_database("m2b")
    assert store.list("m2b") == []


def test_clean_entry_stores_a_mass_range_validated_or_not_at_all():
    entry = clean_entry({
        "question": "q",
        "findings": [
            {"text": "roof canopy: 2.2 kg", "sources": ["https://e.org/a"],
             "mass_kg": 2.2, "mass_range_kg": [1.8, 2.6]},
            {"text": "cap: 0.0026 kg", "sources": ["https://e.org/b"],
             "mass_kg": 0.0026, "mass_range_kg": [2.6, 1.8]},  # inverted span
            {"text": "frame: 9 kg", "sources": ["https://e.org/c"],
             "mass_kg": 9, "mass_range_kg": ["8", 10]},  # a string is not a number
        ],
    })
    assert entry["findings"][0]["mass_range_kg"] == [1.8, 2.6]
    assert "mass_range_kg" not in entry["findings"][1]
    assert "mass_range_kg" not in entry["findings"][2]


def test_clean_entry_keeps_the_engine_excerpt_bounded():
    entry = clean_entry({
        "question": "q",
        "findings": [
            {"text": "cap 2.5 g", "sources": ["https://a.de"], "excerpt": "  " + "x" * 1000},
            {"text": "no excerpt", "sources": ["https://b.de"], "excerpt": ""},
        ],
    })
    assert entry is not None
    assert len(entry["findings"][0]["excerpt"]) == 400
    assert "excerpt" not in entry["findings"][1]


#: A bill-of-materials call that found no mass at all, as research.ts logs it (T4/T5 shape).
BOM_NO_MASS = {
    "question": "Bill of materials: Schwerlastregal Atlas 176 x 90 x 40 cm",
    "context": "Avasco Atlas, verzinkt, 5 Holzböden; market NL/DE. " + "x" * 400,
    "findings": [],
    "bom_check": {
        "summary": "0 of 3 requested components came back with a mass of their own; parts sum to 0 kg. "
                   "The whole-product masses the research found disagree, so none was used — not judged.",
        "requests": [{"component": "Stahlrahmen", "status": "no_mass"},
                     {"component": "Füße", "status": "failed"},
                     {"component": "Gesamtgewicht", "status": "product_mass_only"},
                     {"component": "Böden", "status": "guessed"}],  # not a status: dropped
        "unresolved": [{"component": "Stahlrahmen", "reason": "no_mass", "note": "frame " * 80},
                       {"component": "Füße", "reason": "failed"},
                       {"component": "Böden", "reason": "lost"}],  # not a reason: dropped
        "totals": [{"mass_kg": 13, "basis": "net", "version": "EAN 5400431601480",
                    "source": "https://www.praxis.nl/x/10322182"},
                   {"mass_kg": 24, "basis": "sideways", "source": "https://buchmann.ch/atlas"},
                   {"mass_kg": 0, "basis": "net"}],  # no mass: dropped
        "versions": {"conflict": True,
                     "used": [{"version": "EAN 5400431601459", "entries": ["Böden"]},
                              {"version": "EAN 5400431601480", "entries": ["total 13 kg"]}],
                     "seen": [{"version": f"v{i}", "mass_kg": 14.1} for i in range(5)]},
    },
}


def test_a_bom_call_without_any_mass_leaves_its_check(project):
    store = ResearchLogStore()
    assert store.record("bom1", [BOM_NO_MASS]) == {"added": 1, "total": 1}
    (entry,) = store.list("bom1")
    assert entry["findings"] == []
    check = entry["bom_check"]
    assert check["summary"].startswith("0 of 3 requested components")
    assert [r["status"] for r in check["requests"]] == ["no_mass", "failed", "product_mass_only"]
    assert [u["reason"] for u in check["unresolved"]] == ["no_mass", "failed"]
    # The note is cut with a mark, not mid-word without one.
    assert len(check["unresolved"][0]["note"]) <= 200 and check["unresolved"][0]["note"].endswith("…")
    assert [(t["mass_kg"], t["basis"]) for t in check["totals"]] == [(13.0, "net"), (24.0, "unknown")]
    assert check["totals"][0]["version"] == "EAN 5400431601480"
    assert check["versions"]["conflict"] is True
    assert check["versions"]["used"][1] == {"version": "EAN 5400431601480", "entries": ["total 13 kg"]}
    assert len(check["versions"]["seen"]) == 3
    assert len(entry["context"]) == 300 and entry["context"].endswith("…")


def test_a_bom_call_repeated_with_the_same_findings_is_a_second_dated_entry(project):
    store = ResearchLogStore()
    part = {"text": "5 Holzböden (HDF, 5 mm) (5 pieces): 7.65 kg", "sources": ["https://www.praxis.nl/x/10119671"],
            "component": "5 Holzböden", "mass_kg": 7.65,
            "note": "0.9 × 0.4 × 0.005 m × 850 kg/m³ = 1.53 kg per board", "cited_by_search": False}
    call = {**BOM_NO_MASS, "findings": [part]}
    assert store.record("bom2", [call])["added"] == 1
    assert store.record("bom2", [call])["added"] == 1
    first, second = store.list("bom2")
    assert first["findings"][0]["note"].startswith("0.9 × 0.4")
    assert first["findings"][0]["cited_by_search"] is False
    # The finding is not stored twice; the check is — the log keeps each call, not a current state.
    assert second["findings"] == [] and second["bom_check"] == first["bom_check"]
    assert second["asked"]
    # A web question asked again with nothing new is still not a second row.
    assert store.record("bom2", [ENTRY])["added"] == 1
    assert store.record("bom2", [ENTRY])["added"] == 0


def test_a_repeat_keeps_its_finding_when_the_full_log_evicts_the_first_record(project):
    from prism_lca.engine.research_log import MAX_ENTRIES

    store = ResearchLogStore()
    part = {"text": "frame: 9 kg", "sources": ["https://e.org/a"], "component": "frame", "mass_kg": 9}
    call = {"question": "Bill of materials: rack", "findings": [part], "bom_check": {"summary": "checked"}}
    store.record("full", [call])
    store.record("full", [{"question": f"q{i}", "findings": [{"text": f"f{i}"}]} for i in range(MAX_ENTRIES - 1)])
    assert len(store.list("full")) == MAX_ENTRIES
    store.record("full", [call])  # the log is full: the first BOM entry goes
    entries = store.list("full")
    assert len(entries) == MAX_ENTRIES
    assert [f["text"] for e in entries for f in e["findings"] if e["question"] == "Bill of materials: rack"] == [
        "frame: 9 kg"
    ]
    assert entries[-1]["findings"][0]["mass_kg"] == 9.0


def test_a_repeated_part_hands_the_stored_one_the_other_figures_it_found(project):
    """The second research of the label counted the same 0.6 g and also met the direct print. The repeat is not
    stored again, so its other figure goes to the stored finding — the health check reads it only there."""
    store = ResearchLogStore()
    label = {"text": "label (PP): 0.0006 kg", "sources": ["https://e.org/l"], "component": "label",
             "mass_kg": 0.0006}
    call = {"question": "Bill of materials: soap", "findings": [label], "bom_check": {"summary": "checked"}}
    store.record("alt", [call])
    store.record("alt", [{**call, "findings": [{**label, "alternatives_kg": [0.00015, 0.0006]}]}])
    first, second = store.list("alt")
    # The counted figure itself is no other figure; the second entry still holds only its check.
    assert first["findings"][0]["alternatives_kg"] == [0.00015] and second["findings"] == []
    # A web finding repeated with nothing new still writes nothing; one that only widens a part is saved.
    assert store.record("alt", [{"question": "Bill of materials: soap", "findings": [label]}])["added"] == 0
    store.record("alt", [{"question": "Bill of materials: soap", "findings": [{**label, "alternatives_kg": [0.0008]}]}])
    assert store.list("alt")[0]["findings"][0]["alternatives_kg"] == [0.00015, 0.0008]
    assert len(store.list("alt")) == 2


def test_a_bom_check_keeps_the_recipe_and_whether_it_closed(project):
    check = clean_bom_check({
        "summary": "The recipe of liquid soap does NOT close",
        "recipe": {"of": "liquid soap (contents of the pouch)", "formulation": "MP-01", "kind": "frame",
                   "source": "https://pcc.example/mp01.pdf", "closes": False, "note": "its lines sum to 91.12 %",
                   "gap_pct": 8.88, "gap_kg": 0.045288, "mass_kg": 0.51, "mass_source": "given",
                   "missing_ingredients": ["Glyceryl Oleate"] + [f"x{i}" for i in range(20)],
                   "split": ["SLES 27 % solution"], "reachable_by_ranges": "yes",
                   "inci_order": ["Cocamidopropyl Betaine (no. 4) is listed before Glycerin (no. 5)"],
                   "inci_list": {"from": "found", "product": "Balea Flüssigseife"}},
    })
    recipe = check["recipe"]
    assert recipe["closes"] is False and recipe["gap_pct"] == 8.88 and recipe["gap_kg"] == 0.045288
    assert recipe["kind"] == "frame" and recipe["mass_source"] == "given"
    assert len(recipe["missing_ingredients"]) == 12 and recipe["split"] == ["SLES 27 % solution"]
    # The recipe is no longer held against the order of an INCI list: an entry that still carries that comparison
    # loses it here, as any field the check does not know.
    assert "inci_order" not in recipe and "inci_list" not in recipe
    assert "reachable_by_ranges" not in recipe
    # Not checkable is an answer of its own, kept as null; an over-full recipe keeps its negative gap.
    open_one = clean_bom_check({"recipe": {"of": "concrete", "closes": None, "gap_pct": -3.5, "kind": "guess"}})
    assert open_one == {"recipe": {"of": "concrete", "closes": None, "gap_pct": -3.5}}
    assert clean_bom_check({"recipe": {"closes": True}}) is None


def test_an_entry_without_findings_needs_a_valid_check(project):
    assert clean_entry({"question": "Bill of materials: x", "findings": [], "bom_check": {}}) is None
    assert clean_entry({"question": "Bill of materials: x", "bom_check": {"requests": [{"component": "a"}]}}) is None
    assert clean_entry({"question": "Bill of materials: x", "bom_check": "summary"}) is None
    kept = clean_entry({"question": "Bill of materials: x", "bom_check": {"summary": "nothing found"}})
    assert kept and kept["bom_check"] == {"summary": "nothing found"}


def test_the_new_fields_survive_a_bundle_restore(project):
    store = ResearchLogStore()
    store.record("bom3", [{**BOM_NO_MASS, "findings": [
        {"text": "frame: 9 kg", "sources": ["https://e.org/a"], "component": "frame", "mass_kg": 9,
         "note": "per datasheet", "cited_by_search": True, "version": "EAN 5400431601459"}]}])
    exported = store.list("bom3")
    assert exported[0]["findings"][0]["version"] == "EAN 5400431601459"
    store.replace("bom3b", exported)
    assert store.list("bom3b") == exported


def test_the_report_brief_skips_a_check_without_findings(project):
    facts = brief_facts({"web_research": [BOM_NO_MASS, ENTRY]}, "references")
    assert [e["question"] for e in facts.get("web_research", [])] == [ENTRY["question"]]


def test_research_endpoints_round_trip(client, token, project):
    r = client.post("/api/v1/provenance/research",
                    json={"database": "m3", "entries": [ENTRY]}, headers=token)
    assert r.status_code == 200 and r.json()["added"] == 1
    r = client.get("/api/v1/provenance/research", params={"database": "m3"}, headers=token)
    assert r.json()[0]["question"] == ENTRY["question"]


# --- review log --------------------------------------------------------------


def test_review_log_resolutions_and_staleness(project):
    store = ReviewLogStore()
    made = store.record_review("m4", "## Blocking\nNone.", gaps=["hotspots: not analysed"], generation=7)
    assert made["id"]
    # Resolutions attach to the latest review; recording the same finding twice keeps the later verdict.
    assert "error" in store.record_resolutions("other-model", [{"finding": "x"}])
    got = store.record_resolutions("m4", [
        {"finding": "label missing", "resolution": "fixed"},
        {"finding": "lid lacks forming steps", "resolution": "open", "reason": "below the 10 % bar"},
        {"finding": "label missing", "resolution": "rejected", "reason": "changed my mind"},
    ])
    # A review without tagged findings: the counts, and that which findings lack an outcome cannot be said.
    assert got == {"id": made["id"], "recorded": 2, "fixed": 0, "rejected": 1, "open": 1, "tagged": False}

    view = store.for_report("m4", current_generation=7)
    assert view["stale"] is False and view["resolutions_recorded"] is True
    assert [f["finding"] for f in view["open"]] == ["lid lacks forming steps"]
    assert store.for_report("m4", current_generation=8)["stale"] is True
    assert store.for_report("never-reviewed", 1) is None


TAGGED_REVIEW = """### Blocking
- [F1] Recalculate zinc coating: "1.121 m2" against 64 m2/t.
**[F2]** The frame is a residual mass.

## Should fix
1. **[F3]** Functional unit has no lifetime.
- [F4] Packaging film 0.4 kg; see also [F1] above.

**Worth a look**

**[F5]**
Tyre end-of-life is missing.
- [F3] repeated tag is not a second finding.
"""


def test_tagged_findings_are_read_from_the_start_of_a_line_in_any_markup():
    found = tagged_findings(TAGGED_REVIEW)
    assert [f["id"] for f in found] == ["F1", "F2", "F3", "F4", "F5"]
    assert found[0]["finding"].startswith("Recalculate zinc coating")
    assert found[1]["finding"] == "The frame is a residual mass."
    assert found[4]["finding"] == "Tyre end-of-life is missing."  # tag alone on its line
    assert tagged_findings("## Blocking\n- the lid, see [F2]") == []


def test_the_resolutions_answer_names_the_findings_without_an_outcome(project):
    """Eight outcomes for eleven findings used to answer with counts only — the three left over were
    invisible to the builder, who cannot read the log back."""
    store = ReviewLogStore()
    store.record_review("m9", TAGGED_REVIEW, generation=1)
    got = store.record_resolutions("m9", [
        {"id": "F1", "finding": "zinc coating area", "resolution": "fixed"},
        {"id": "[f2]", "finding": "frame residual", "resolution": "rejected", "reason": "by design"},
        {"finding": "F4: packaging film", "resolution": "open", "reason": "no data"},
        {"finding": "tyre end-of-life", "resolution": "fixed"},
        {"id": "F9", "finding": "a finding the review never made", "resolution": "fixed"},
    ])
    assert got["findings"] == 5
    assert [f["id"] for f in got["no_outcome_yet"]] == ["F3", "F5"]
    assert got["no_outcome_yet"][0]["finding"].startswith("Functional unit has no lifetime")
    assert got["without_id"] == 1 and got["unknown_ids"] == ["F9"]
    # The same id recorded again replaces the earlier outcome, whatever the words.
    again = store.record_resolutions("m9", [
        {"id": "F3", "finding": "lifetime of the barrow", "resolution": "open", "reason": "user decides"},
        {"id": "5", "finding": "tyres", "resolution": "fixed"},
        {"id": "F1", "finding": "zinc coating per m2", "resolution": "fixed"},
    ])
    assert again["no_outcome_yet"] == [] and again["recorded"] == 7
    # The ids number one review's findings; a report has no use for them.
    assert all("id" not in r for r in store.for_report("m9", 1)["open"])


def test_an_outcome_recorded_again_with_its_id_replaces_the_one_without(project):
    """The answer asks for exactly this; the stale entry must not stay behind for the report."""
    store = ReviewLogStore()
    store.record_review("m10", TAGGED_REVIEW, generation=1)
    store.record_resolutions("m10", [{"finding": "Missing lifetime", "resolution": "open"}])
    got = store.record_resolutions("m10", [{"id": "F3", "finding": "missing  lifetime", "resolution": "fixed"}])
    assert got["recorded"] == 1 and got["fixed"] == 1 and got["open"] == 0 and "without_id" not in got
    # And the other way round: the same words without an id keep the id already on record.
    store.record_resolutions("m10", [{"finding": "Missing lifetime", "resolution": "rejected", "reason": "x"}])
    assert store.latest("m10")["resolutions"] == [
        {"finding": "Missing lifetime", "resolution": "rejected", "reason": "x", "id": "F3"}
    ]
    # Two findings answered in the same words stay two outcomes.
    got = store.record_resolutions("m10", [
        {"id": "F1", "finding": "see above", "resolution": "fixed"},
        {"id": "F2", "finding": "see above", "resolution": "fixed"},
    ])
    assert got["recorded"] == 3


def test_review_endpoints_stamp_the_generation(client, token, project):
    r = client.post("/api/v1/provenance/review",
                    json={"database": "m5", "review": "## Should fix\n- a point"}, headers=token)
    assert r.status_code == 200 and r.json()["id"]
    r = client.get("/api/v1/provenance/review", params={"database": "m5"}, headers=token)
    entry = r.json()[-1]
    assert entry["generation"] is not None  # stamped server-side, never by the caller
    r = client.post("/api/v1/provenance/review/resolutions",
                    json={"database": "m5", "resolutions": [{"finding": "a point", "resolution": "open"}]},
                    headers=token)
    assert r.json()["open"] == 1


def test_review_log_keeps_the_chat_and_marks_each_entry_stale_or_not(project):
    """A re-review in the same chat is shown the previous one; the chat id is how the tool finds it."""
    store = ReviewLogStore()
    store.record_review("m6", "Should fix: the lid.", generation=3, chat="a1b2c3d4e5f6", partial=True)
    store.record_review("m6", "Blocking: none.", generation=5)
    first, second = store.history("m6", current_generation=5)
    assert first["chat"] == "a1b2c3d4e5f6" and first["stale"] is True and first["partial"] is True
    assert "chat" not in second and "partial" not in second and second["stale"] is False
    assert all(r["stale"] is None for r in store.history("m6"))


def test_a_review_from_an_earlier_backend_session_is_neither_stale_nor_fresh(project):
    """The generation counter restarts with the backend: an equal number then proves nothing."""
    store = ReviewLogStore()
    store.record_review("m8", "Should fix: the lid.", generation=4)
    stored = store.list("m8")
    stored[0]["session"] = "an-older-run"
    store.restore_database("m8", stored)
    assert store.history("m8", current_generation=4)[0]["stale"] is None


def test_review_endpoint_records_the_chat(client, token, project):
    client.post("/api/v1/provenance/review",
                json={"database": "m7", "review": "Should fix: a point", "chat": "c0ffee"}, headers=token)
    entry = client.get("/api/v1/provenance/review", params={"database": "m7"}, headers=token).json()[-1]
    assert entry["chat"] == "c0ffee"
    assert entry["stale"] is False  # nothing was edited between the review and the read


# --- what the report makes of them -------------------------------------------


def test_researched_sources_dedupe_against_cited(project):
    data = {"web_research": [ENTRY | {"asked": "2026-08-15T00:00:00Z"}]}
    assert researched_sources(data) == [("https://example.org/jar", ENTRY["question"])]
    # A URL a note already cites is one source, not two rows.
    assert researched_sources(data, exclude={"https://example.org/jar"}) == []


def test_the_limitations_chapter_prints_the_open_findings_and_not_the_bookkeeping(project):
    """V253: what is still open is a statement about the STUDY and belongs here. When it was reviewed,
    how many were closed and whether the model moved since is bookkeeping about the tooling — three
    sentences about the software in the chapter a critical reader checks first."""
    data = {
        "study": {"critical_review": "internal second review"},
        "subjects": [],
        "review": {
            "created": "2026-08-15T10:00:00Z",
            "stale": True,
            "open": [{"finding": "lid lacks forming steps", "reason": "below the 10 % bar"}],
            "rejected": [],
            "fixed": 2,
            "resolutions_recorded": True,
        },
    }
    blocks = limitations_blocks(data, "en", "Limitations")
    text = " ".join(str(b) for b in blocks)
    assert "lid lacks forming steps — below the 10 % bar" in text
    assert "Open findings" in text
    # …and nothing about the run that produced them.
    for gone in ("internal model review", "was carried out on", "2 were fixed", "modified since"):
        assert gone not in text, gone


def test_brief_facts_carry_what_the_prompts_promise(project):
    """The drift this closes: prompts told the writer to read checks/trade_offs/notes it never got."""
    data = {
        "study": {"goal": "g"},
        "results": [{"method_label": "IPCC", "score": 1.0}],
        "checks": {"sensitivity": [{"spread_percent": 3.1}]},
        "trade_offs": [{"method_label": "IPCC", "highest": "Variant B"}],
        "foreground": [{"name": "P", "description": "x" * 900}],
        "parameters": [{"name": "n_cycles", "amount": 12, "description": "GVM estimate"}],
        "scenarios": [{"name": "few cycles", "description": "5 instead of 12"}],
        "contributions": [{"index": 0, "method_label": "IPCC", "groups": [{"key": "use"}] * 12}],
        "web_research": [ENTRY],
        "review": {"created": "2026-08-15", "open": []},
    }
    facts = brief_facts(data)
    assert facts["checks"] == data["checks"]
    assert facts["trade_offs"] == data["trade_offs"]
    assert facts["parameters"][0]["description"] == "GVM estimate"
    assert facts["scenarios"][0]["name"] == "few cycles"
    assert len(facts["foreground"][0]["description"]) == 700  # capped, ellipsis included
    assert len(facts["contributions"][0]["groups"]) == 8
    assert facts["web_research"][0]["findings"][0]["sources"] == ["https://example.org/jar"]
    assert facts["review"]["created"] == "2026-08-15"

    brief = build_brief({"id": "s1", "kind": "prose"}, {"lang": "en"}, data)
    # In the brief, as the document prints them (V460): 3.1 is shown as "3.1".
    assert brief["facts"]["checks"] == {"sensitivity": [{"spread_percent": "3.1"}]}
    # The logs are writer context, never placeholder material — their indices renumber.
    assert not [p for p in placeholder_paths(data) if p.startswith(("web_research", "review"))]
