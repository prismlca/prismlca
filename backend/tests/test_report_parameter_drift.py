"""An earlier test run, as a test: what a finished report does when the model moves.

The run behind this file wrote a report, then turned one parameter down a little, up a little, and
finally far — and watched which chapters had to change. Four defects came out of it, and every one of them lived on the path
between "the numbers moved" and "the wording is now wrong":

* a rank finding could not be located in the prose at all, so the only remedy left was a rewrite,
* a dataset name carrying a version split the sentence and produced a contradiction that was not there,
* the gate refused the very correction the staleness check demanded,
* and a correction re-pointed the sentences it had not touched, turning a visible gap into a wrong
  figure under a right name — through every other check, green.

None of that needs a model to reproduce: the verdicts are arithmetic over a data snapshot. So this
walks the same four parameter states with one frozen chapter and asserts what each step must say.
The numbers are the run's own, rounded.
"""
from __future__ import annotations

from prism_lca.engine import report_claims as rc
from prism_lca.engine import report_data as rd
from prism_lca.engine import report_patch as rp
from prism_lca.engine import report_staleness as rs

DB = "ecoinvent-3.12-cutoff"

#: (name, code, share %) per parameter state, largest first — the four states the run went through.
#: `last mile` grows with `d_last_mile`, `heat` with `heat_per_kg`, and at the strong setting the two
#: containerboards drop out of the top list entirely.
_STATES: dict[str, tuple[float, float, list[tuple[str, str, float]]]] = {
    # label: (total kg CO2-Eq, Distribution share %, hotspots)
    "baseline": (0.515, 45.6, [
        ("heat production, natural gas, at industrial furnace >100kW", "heat", 15.0),
        ("transport, freight, light commercial vehicle, fleet average", "lcv", 14.4),
        ("market for heat, district or industrial, natural gas", "mkt-heat", 5.8),
        ("containerboard production, fluting medium, recycled", "cb-flut", 3.6),
        ("containerboard production, linerboard, testliner", "cb-line", 3.4),
    ]),
    # 80 → 70 km: −2.9 %. Everything keeps its place and its band.
    "slightly_down": (0.500, 44.2, [
        ("heat production, natural gas, at industrial furnace >100kW", "heat", 15.5),
        ("transport, freight, light commercial vehicle, fleet average", "lcv", 12.8),
        ("market for heat, district or industrial, natural gas", "mkt-heat", 6.0),
        ("containerboard production, fluting medium, recycled", "cb-flut", 3.7),
        ("containerboard production, linerboard, testliner", "cb-line", 3.5),
    ]),
    # 70 → 92 km: +3.5 % against the written state, and the top two change places.
    "slightly_up": (0.533, 47.4, [
        ("transport, freight, light commercial vehicle, fleet average", "lcv", 16.3),
        ("heat production, natural gas, at industrial furnace >100kW", "heat", 14.5),
        ("market for heat, district or industrial, natural gas", "mkt-heat", 5.6),
        ("containerboard production, fluting medium, recycled", "cb-flut", 3.5),
        ("containerboard production, linerboard, testliner", "cb-line", 3.3),
    ]),
    # 400 km and 12 MJ/kg: +134 %. Distribution crosses 50 %, and the containerboards are gone.
    "strong": (1.207, 58.9, [
        ("transport, freight, light commercial vehicle, fleet average", "lcv", 30.7),
        ("heat production, natural gas, at industrial furnace >100kW", "heat", 16.7),
        ("market for heat, district or industrial, natural gas", "mkt-heat", 4.8),
        ("market for petroleum", "petrol", 3.8),
    ]),
}


def _data(state: str) -> dict:
    total, distribution, hotspots = _STATES[state]
    return {
        "study": {"functional_unit": "1 jar (500 g)"},
        "results": [{"method_label": "EF v3.1 / climate change / GWP100", "score": total,
                     "unit": "kg CO2-Eq"}],
        "contribution": {"groups": [
            {"key": "Distribution", "share_percent": distribution},
            {"key": "Production", "share_percent": round(96.0 - distribution, 1)},
            {"key": "Raw materials", "share_percent": 4.0},
        ]},
        "hotspots": [
            {"name": name, "database": DB, "code": code,
             "share_percent": share, "share_text": f"{share} %"}
            for name, code, share in hotspots
        ],
    }


REPORT = {
    "methods": [["EF v3.1", "climate change", "GWP100"]],
    "subjects": [{"label": "Baseline", "code": "jar"}],
    "aggregate_by": "tag:Life-cycle phase",
    "lang": "en",
}

#: One chapter, written against the baseline: a superlative on the leading dataset, a runner-up, a
#: phase share, and — the sentence that matters — a dataset named in plain words beside its figure.
TEXT = (
    "The result for the functional unit is {{results.0.score}} {{results.0.unit}}. "
    "Distribution is the largest life-cycle phase at {{contribution.groups.0.share_percent}} %. "
    "The largest individual contributor is heat production, natural gas, at industrial furnace "
    ">100kW from ecoinvent-3.12-cutoff at {{hotspots.0.share_text}} of the total, ahead of "
    "transport, freight, light commercial vehicle, fleet average at {{hotspots.1.share_text}}. "
    "The shipping carton adds containerboard production, fluting medium, recycled at "
    "{{hotspots.3.share_text}}."
)


def _section(state: str = "baseline") -> dict:
    data = _data(state)
    bindings = rd.bindings_for(TEXT, data)
    return {
        "id": "contribution",
        "kind": "contribution",
        "text": TEXT,
        "bindings": bindings,
        "based_on": rs.components(TEXT, bindings, REPORT, data),
    }


def _verdict(state: str, section: dict | None = None) -> tuple[str, list[dict]]:
    section = section or _section()
    found = rs.verdicts(section, REPORT, _data(state), [])
    return rs.worst(found), found


# --- the chapter as written -------------------------------------------------------------


def test_the_chapter_is_clean_against_the_state_it_was_written_for():
    remedy, found = _verdict("baseline")
    assert remedy == "none" and found == []


def test_the_written_chapter_passes_the_gate():
    """Including the pins check: name and figure belong to the same member."""
    section = _section()
    assert rc.misbound_names(TEXT, _data("baseline"), section["bindings"]) == []


# --- step 1: a small change downwards ---------------------------------------------------


def test_a_small_change_asks_for_nothing():
    """−2.9 %: the placeholders carry it. This is the whole point of the design and it must not
    start asking for rewrites when a figure moves in the third digit."""
    remedy, found = _verdict("slightly_down")
    assert remedy == "none"
    assert [f["kind"] for f in found] == ["values"]
    assert "the text stays valid" in found[0]["message"]


# --- step 2: a small change upwards that turns the ranking over -------------------------


def test_a_rank_swap_asks_for_a_look_and_nothing_more():
    remedy, found = _verdict("slightly_up")
    assert remedy == "review"
    ranks = [f for f in found if f["kind"] == "ranks"]
    assert {f["path"] for f in ranks} == {"hotspots.0", "hotspots.1"}
    assert not [f for f in found if f["severity"] == "rewrite"]


def test_the_rank_finding_can_be_located_in_the_prose():
    """V142: the finding names the member (`hotspots.0`), the prose can only cite a leaf of it.

    Unlocatable meant "Not corrected — no sentence to point at", i.e. the cheap remedy was missing
    for exactly the case it exists for.
    """
    _remedy, found = _verdict("slightly_up")
    ranks = [f for f in found if f["kind"] == "ranks"]
    located, unlocated = rp._spans_and_gaps(TEXT, ranks)
    assert unlocated == []
    assert located and all("largest individual contributor" in s["sentence"] for s in located[:1])


def _contradictions(text: str, state: str, bindings: dict) -> list[dict]:
    return [
        f for f in rc.check_claims(text, _data(state), "en", bindings)
        if f["kind"] == "contradicted_claim"
    ]


def test_the_superlative_may_sit_on_the_member_that_now_leads():
    """V144, isolated: no ordinal and no version string, so only the pins can save this sentence.

    After the swap the transport leg leads, and it is pinned to `hotspots.1`. Reading the index as a
    rank made the gate refuse the only true wording there is — while the staleness check was
    demanding exactly that correction.
    """
    text = (
        "The largest individual contributor is transport, freight, light commercial vehicle, "
        "fleet average at {{hotspots.1.share_text}}."
    )
    pins = _section()["bindings"]  # hotspots.1 was written as the runner-up; it now leads
    assert pins["hotspots.1"]["code"] == "lcv"
    assert _contradictions(text, "slightly_up", pins) == []


def test_a_version_in_a_name_must_not_separate_the_ordinal_from_the_superlative():
    """V143, isolated: the pinned member is *not* the leader, so only the ordinal makes it correct.

    Split at "ecoinvent-3." the ordinal stays in the first half and "largest" moves to the second,
    which is how a correct sentence became a contradiction.
    """
    text = (
        "The second-largest contributor is heat production, natural gas, at industrial furnace "
        ">100kW from ecoinvent-3.12-cutoff, so it is not the largest at {{hotspots.1.share_text}}."
    )
    pins = {"hotspots.1": {"database": DB, "code": "heat",
                           "name": "heat production, natural gas, at industrial furnace >100kW"}}
    assert len(rc._sentences(text)) == 1
    assert _contradictions(text, "slightly_up", pins) == []


# --- step 3: the strong change ----------------------------------------------------------


def test_a_strong_change_needs_one_rewrite_and_says_why():
    """+134 %: a phase crosses 50 %, and a named dataset leaves the list. The first is a wording
    check, the second is a hole in the deliverable — different remedies, both reported."""
    remedy, found = _verdict("strong")
    assert remedy == "rewrite"
    members = [f for f in found if f["kind"] == "members"]
    assert len(members) == 1
    assert "containerboard production, fluting medium, recycled" in members[0]["message"]
    bands = [f for f in found if f["kind"] == "bands"]
    assert any("20–50 %" in f["message"] and ">50 %" in f["message"] for f in bands)


def test_the_hole_is_visible_before_it_is_printed():
    """The gap gate's input: the vanished member resolves to nothing, which is what stops the PDF."""
    _resolved, missing = rd.resolve(TEXT, _data("strong"), "en", _section()["bindings"])
    assert missing == ["hotspots.3.share_text"]


# --- the defect that walked through every gate (V146) -----------------------------------


def test_a_correction_elsewhere_must_not_re_point_this_sentence():
    """The chapter is patched in its *first* sentence; the dataset sentence is untouched.

    Re-binding the whole chapter against today's data moved the named datasets onto each other's
    figures — "heat production … (30.7 %)" where 30.7 % is the transport leg — and with the pins
    rewritten the staleness check, the gap gate and the superlative rule were all satisfied.
    """
    section = _section()
    corrected = TEXT.replace("The result for the functional unit is", "The result is")
    data = _data("strong")

    after = rd.bindings_for(corrected, data, keep=section["bindings"])
    assert after["hotspots.0"]["code"] == "heat", "the sentence is about the heat dataset"
    assert after["hotspots.1"]["code"] == "lcv"
    # The hole stays a hole instead of quietly filling with a stranger's number.
    _text, missing = rd.resolve(corrected, data, "en", after)
    assert missing == ["hotspots.3.share_text"]
    # …and the chapter still asks to be rewritten, which is the honest answer.
    assert rs.worst(rs.verdicts({**section, "text": corrected, "bindings": after}, REPORT, data, [])) == "rewrite"


def test_the_swap_is_caught_if_it_ever_happens_again():
    """Belt and braces: even with the pins wrongly rewritten, the names now contradict the figures."""
    data = _data("strong")
    rebound = rd.bindings_for(TEXT, data)  # the old, damaging behaviour
    assert rebound["hotspots.0"]["code"] == "lcv"  # …which is a different dataset than the prose names
    findings = rc.misbound_names(TEXT, data, rebound)
    assert findings, "a figure printed under another member's name must be reported"
    assert all(f["kind"] == "misbound_name" for f in findings)


# --- an apple-juice run: what a correction is allowed to declare fixed ------


def test_a_correction_only_clears_the_findings_it_answered():
    """V162: one replacement must not make the chapter green for the sentences it never read.

    In the apple-juice run a single "Correct all" round took five chapters from twenty findings to
    none, while five demonstrably false sentences stayed in the document — two of them contradicting
    the corrected sentence in the very next line. The cause is one line: storing a patch re-stamped
    the chapter's whole record against today's data.
    """
    data = _data("strong")
    section = _section()
    actionable = [
        f for f in rs.verdicts(section, REPORT, data, []) if f["severity"] in ("rewrite", "review")
    ]
    paths = {(f["kind"], f.get("path")) for f in actionable}
    assert ("bands", "contribution.groups.0.share_percent") in paths
    assert ("ranks", "hotspots.0") in paths and ("ranks", "hotspots.1") in paths

    # The model answers exactly one of them — the phase sentence — and says nothing about the rest.
    result = rp.apply_edits(TEXT, [{
        "old": "Distribution is the largest life-cycle phase at",
        "new": "Distribution is the largest life-cycle phase, now over half the total, at",
    }])
    assert result["ok"] and len(result["applied"]) == 1

    left = rp.unaddressed(TEXT, actionable, result["applied"])
    still = {(f["kind"], f.get("path")) for f in left}
    assert ("bands", "contribution.groups.0.share_percent") not in still, "that sentence was corrected"
    assert ("ranks", "hotspots.0") in still and ("ranks", "hotspots.1") in still

    bindings = rd.bindings_for(result["text"], data, keep=section["bindings"])
    fresh = rs.components(result["text"], bindings, REPORT, data)
    patched = {
        **section,
        "text": result["text"],
        "bindings": bindings,
        "based_on": rs.keep_stale(fresh, section["based_on"], left),
    }
    after = rs.verdicts(patched, REPORT, data, [])
    kinds = {(f["kind"], f.get("path")) for f in after}
    assert ("ranks", "hotspots.0") in kinds and ("ranks", "hotspots.1") in kinds
    assert ("bands", "contribution.groups.0.share_percent") not in kinds

    # And the defect itself, so the fix cannot be undone without a red test: stamping the fresh record
    # over everything reports nothing about the two sentences nobody touched.
    naive = {**patched, "based_on": fresh}
    assert not [f for f in rs.verdicts(naive, REPORT, data, []) if f["kind"] == "ranks"]


def test_a_finding_with_no_sentence_to_point_at_stays_unaddressed():
    """Nothing can have corrected it, so nothing may declare it corrected."""
    orphan = {"kind": "ranks", "severity": "review", "path": "hotspots.9", "message": "…"}
    result = rp.apply_edits(TEXT, [{"old": "The result for the functional unit is", "new": "The result is"}])
    assert [f["path"] for f in rp.unaddressed(TEXT, [orphan], result["applied"])] == ["hotspots.9"]
