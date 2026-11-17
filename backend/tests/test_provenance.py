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
