"""The provenance logs: what the build researched, and what its internal review concluded.

Both exist because a chat dies and a report does not: the researched sources feed the bibliography's
"Sources researched during modelling" table, and the review log is what lets a study whose
`critical_review` field claims an internal review actually show its outcome.
"""
from __future__ import annotations

from prism_lca.engine.report_checks import limitations_blocks
from prism_lca.engine.report_prompts import brief_facts, build_brief, placeholder_paths
from prism_lca.engine.report_sources import researched_sources
from prism_lca.engine.research_log import ResearchLogStore, clean_entry
from prism_lca.engine.review_log import ReviewLogStore

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
    assert got == {"id": made["id"], "recorded": 2, "fixed": 0, "rejected": 1, "open": 1}

    view = store.for_report("m4", current_generation=7)
    assert view["stale"] is False and view["resolutions_recorded"] is True
    assert [f["finding"] for f in view["open"]] == ["lid lacks forming steps"]
    assert store.for_report("m4", current_generation=8)["stale"] is True
    assert store.for_report("never-reviewed", 1) is None


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
    assert brief["facts"]["checks"] == data["checks"]
    # The logs are writer context, never placeholder material — their indices renumber.
    assert not [p for p in placeholder_paths(data) if p.startswith(("web_research", "review"))]
