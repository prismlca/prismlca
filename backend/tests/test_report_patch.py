"""Correcting a sentence: finding the spot mechanically, and refusing anything that is not a patch."""
from __future__ import annotations

import pytest

from prism_lca.engine import report_patch as rp

TEXT = (
    "Packaging dominates the balance with {{contribution.groups.0.share_percent}} %. "
    "Raw materials follow with {{contribution.groups.1.share_percent}} %. "
    "The assessment uses EF v3.1 throughout."
)


def test_a_span_is_found_by_the_placeholder_not_by_a_word_list():
    """The heart of it: a finding names a data path, and that path sits in the text."""
    spans = rp.spans_for(
        TEXT,
        [{"kind": "bands", "path": "contribution.groups.0.share_percent",
          "message": "moved from >50 % to 5–20 %"}],
    )
    assert len(spans) == 1
    assert spans[0]["sentence"].startswith("Packaging dominates")
    assert "5–20 %" in spans[0]["finding"]


def test_a_finding_that_carries_its_sentence_is_located_and_answerable_by_it():
    """The third handle, and the only one a claim to the top made in words has: the sentence itself.

    Both halves have to read it. `spans_for` did and `unaddressed` did not, so such a finding could be
    handed over, corrected, and still counted as untouched — a badge that nothing could clear (V206).
    """
    finding = {
        "kind": "wording",
        "sentence": "The assessment uses EF v3.1 throughout.",
        "message": "claims a top rank in words",
    }
    spans = rp.spans_for(TEXT, [finding])
    assert [s["sentence"] for s in spans] == ["The assessment uses EF v3.1 throughout."]
    assert not rp.unlocated_in(TEXT, [finding])

    elsewhere = rp.apply_edits(TEXT, [{"old": "Raw materials follow", "new": "Raw materials come next"}])
    assert rp.unaddressed(TEXT, [finding], elsewhere["applied"]) == [finding]
    on_it = rp.apply_edits(TEXT, [{"old": "uses EF v3.1 throughout", "new": "applies EF v3.1"}])
    assert rp.unaddressed(TEXT, [finding], on_it["applied"]) == []


def test_a_selection_finding_is_found_by_its_literal_name():
    spans = rp.spans_for(TEXT, [{"kind": "selection", "names": ["EF v3.1"], "message": "not used"}])
    assert len(spans) == 1
    assert spans[0]["sentence"] == "The assessment uses EF v3.1 throughout."


def test_a_rank_finding_finds_the_sentence_that_cites_the_member():
    """A rank finding names the member — ``hotspots.0`` — and prose can only cite a leaf of it.

    Regression: requiring the path to end where the placeholder ends meant "the largest may no longer
    be true" never located a sentence. Every rank change came back "no sentence to point at", so the
    one finding this module exists for was the one it could not serve, and the only remedy left was a
    full rewrite of the chapter.
    """
    text = (
        "The largest single contributor is {{hotspots.0.name}} at {{hotspots.0.share_percent}} %. "
        "Second is {{hotspots.1.name}}."
    )
    spans = rp.spans_for(text, [{"kind": "ranks", "path": "hotspots.0",
                                 "message": "was rank 1 and is now rank 2"}])
    assert len(spans) == 1
    assert spans[0]["sentence"].startswith("The largest single contributor")
    # …and only that member: the sibling's sentence is not swept in.
    assert "hotspots.1" not in spans[0]["sentence"]
    # The boundary is a component boundary, not a prefix match.
    assert rp._offsets_of_path("{{hotspots.01.name}}", "hotspots.0") == []


def test_a_derivation_argument_counts_as_a_citation():
    text = "Together they reach {{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} %."
    spans = rp.spans_for(text, [{"kind": "bands", "path": "contribution.groups.1.share_percent",
                                 "message": "…"}])
    assert len(spans) == 1


def test_a_clean_patch_applies():
    out = rp.apply_edits(TEXT, [{"old": "dominates the balance with", "new": "contributes",
                                 "why": "share fell below 20 %"}])
    assert out["ok"], out
    assert out["text"].startswith("Packaging contributes {{contribution.groups.0.share_percent}} %.")
    assert len(out["applied"]) == 1


def test_an_ambiguous_find_is_refused():
    text = "It is high. It is high."
    out = rp.apply_edits(text, [{"old": "It is high", "new": "It is low"}])
    assert not out["ok"]
    assert "occurs 2 times" in out["problems"][0]
    assert out["text"] == text  # nothing applied


def test_a_find_that_is_not_there_is_refused():
    out = rp.apply_edits(TEXT, [{"old": "nowhere in the text", "new": "x"}])
    assert not out["ok"]
    assert "occurs 0 times" in out["problems"][0]


def test_a_patch_may_not_touch_a_placeholder():
    """Figures stay the placeholders' job — a patch that drops one would freeze a number into prose."""
    out = rp.apply_edits(
        TEXT,
        [{"old": "with {{contribution.groups.0.share_percent}} %", "new": "with 12 %"}],
    )
    assert not out["ok"]
    assert "placeholders differ" in out["problems"][0]
    assert out["text"] == TEXT


def test_reordering_placeholders_is_refused_too():
    out = rp.apply_edits(
        TEXT,
        [{
            "old": "{{contribution.groups.0.share_percent}} %. Raw materials follow with "
                    "{{contribution.groups.1.share_percent}} %",
            "new": "{{contribution.groups.1.share_percent}} %. Raw materials follow with "
                       "{{contribution.groups.0.share_percent}} %",
        }],
    )
    assert not out["ok"]
    assert "placeholders differ" in out["problems"][0]


def test_a_replacement_identical_to_the_original_is_a_mistake():
    """Same refusal as the assistant's own tool — accepting it would hide that the model missed."""
    out = rp.apply_edits(TEXT, [{"old": "Raw materials", "new": "Raw materials"}])
    assert not out["ok"]
    assert "identical" in out["problems"][0]


def test_too_many_edits_is_a_rewrite():
    edits = [{"old": f"w{i}", "new": "x"} for i in range(rp.MAX_EDITS + 1)]
    out = rp.apply_edits("w0 w1 w2 w3 w4 w5 w6", edits)
    assert not out["ok"]
    assert "is a rewrite" in out["problems"][0]


def test_too_large_a_change_is_a_rewrite():
    """A chapter long enough for the share to mean something, replaced wholesale."""
    text = ("Alpha beta gamma delta. Epsilon zeta eta theta. " * 14).strip()
    assert len(text) >= rp.MIN_TEXT_FOR_FRACTION
    out = rp.apply_edits(text, [{"old": text[:400], "new": "It says something else entirely now."}])
    assert not out["ok"]
    assert "% of the chapter" in out["problems"][0]
    assert out["text"] == text


def test_a_short_chapter_is_bounded_by_the_edit_count_not_by_the_share():
    """One correction in a three-sentence executive summary is a quarter of it by characters — and is
    exactly the surgical change this exists for. Below the floor only MAX_EDITS counts."""
    text = "Transport dominates the balance. The rest follows from it."
    assert len(text) < rp.MIN_TEXT_FOR_FRACTION
    out = rp.apply_edits(
        text, [{"old": "dominates the balance", "new": "is the largest single contributor"}]
    )
    assert out["ok"], out
    assert out["changed_fraction"] >= rp.MAX_CHANGED_FRACTION  # would have been refused before


def test_nothing_half_applied_leaves_the_function():
    """One good edit and one refused: the good one is reported as *applicable*, never as applied."""
    text = "Alpha is high. Beta is high too. Gamma stands apart."
    out = rp.apply_edits(
        text,
        [
            {"old": "Gamma stands apart", "new": "Gamma is different"},
            {"old": "is high", "new": "is low"},  # occurs twice
        ],
    )
    assert not out["ok"]
    assert out["text"] == text
    assert [e["old"] for e in out["applied"]] == ["Gamma stands apart"]
    assert "occurs 2 times" in out["problems"][0]


def test_the_brief_carries_the_spans_and_the_rules_but_no_data():
    section = {"title": "Contribution", "text": TEXT}
    b = rp.brief(section, [{"kind": "selection", "names": ["EF v3.1"], "message": "not used"}], "German")
    assert b["language"] == "German"
    assert b["spans"] and b["spans"][0]["sentence"].endswith("EF v3.1 throughout.")
    assert any("placeholder" in r for r in b["rules"])
    assert "data" not in b


def test_a_name_is_found_through_the_punctuation_prose_puts_inside_it():
    """A real chapter wrote "Environmental Footprint (EF) v3.1"; a strict match walked past the very
    sentence that mattered — the one calling it the European Commission's reference method."""
    text = "The assessment follows the Environmental Footprint (EF) v3.1 method, the reference one."
    spans = rp.spans_for(text, [{"kind": "selection", "names": ["EF v3.1"], "message": "not used"}])
    assert len(spans) == 1


def test_the_brief_states_what_the_report_actually_uses():
    """Without it, a correction renames the method family and leaves the sentence naming that
    family's own indicators standing — a more convincing wrong chapter than the one we started with.
    With it, a model can see there is nothing to rename them to and escalate instead."""
    section = {"title": "Methods", "text": TEXT}
    b = rp.brief(
        section,
        [{"kind": "selection", "names": ["EF v3.1"], "message": "not used"}],
        "English",
        {"methods": ["CML v4.8 2016 / climate change / GWP100"], "functional_unit": "1 L"},
    )
    assert b["report_uses"]["methods"] == ["CML v4.8 2016 / climate change / GWP100"]
    assert any("unfixable" in r and "report_uses" in r for r in b["rules"])


def test_the_reason_is_english_and_the_replacement_stays_in_the_chapter_s_language():
    """Two languages meet in one answer, and the model used to guess which was which.

    Measured on two real German reports: one dialogue came back with German reasons throughout, the
    next one mixed German and English inside the same list (V188). The reason is a surface text — it
    stands in the correction dialogue next to English labels and is never printed — so it is English,
    like every other string in the product. The replacement is the opposite: it goes into the
    document, so it stays German. Both halves are asserted, because reading the rule as "answer in
    English" is the expensive mistake — it would patch English sentences into a German report.
    """
    b = rp.brief(
        {"title": "Contribution", "text": TEXT},
        [{"kind": "ranks", "path": "contribution.groups.0.share_percent", "message": "now rank 2"}],
        "German",
    )
    assert b["language"] == "German"
    replacement_rule = next(r for r in b["rules"] if "'old' and 'new'" in r)
    assert "chapter's language" in replacement_rule
    assert "in English" not in replacement_rule
    why_rule = next(r for r in b["rules"] if r.startswith("'why'"))
    assert "always English" in why_rule
    assert "'unfixable'" in why_rule  # the same rule covers the span the model refuses to patch


def test_a_renamed_dataset_is_rebound_without_touching_a_word():
    """The free repair: same database and code, new display name. The pointer moves, the prose does
    not, and the "[missing: …]" hole closes."""
    bindings = {"hotspots.0": {"database": "ei", "code": "abc", "name": "Old name"}}
    data = {"hotspots": [{"database": "ei", "code": "abc", "name": "New name", "share_percent": 40}]}
    assert rp.rebindings(bindings, data) == {
        "hotspots.0": {"database": "ei", "code": "abc", "name": "New name"}
    }


def test_nothing_is_rebound_when_the_member_is_still_there():
    bindings = {"hotspots.0": {"database": "ei", "code": "abc", "name": "Same"}}
    data = {"hotspots": [{"database": "ei", "code": "abc", "name": "Same"}]}
    assert rp.rebindings(bindings, data) == {}


def test_a_list_keyed_only_by_its_name_is_never_guessed_at():
    """contribution.groups is keyed by the tag value itself — rename it and there is no identifier
    left to recognise it by, so PrismLCA offers nothing and the author decides."""
    bindings = {"contribution.groups.0": {"key": "Packaging"}}
    data = {"contribution": {"groups": [{"key": "Verpackung", "share_percent": 60}]}}
    assert rp.rebindings(bindings, data) == {}


def test_an_ambiguous_rebinding_is_refused():
    bindings = {"subjects.0": {"code": "c1", "scenario": "s1"}}
    data = {"subjects": [{"code": "c1", "scenario": "s1", "label": "A"},
                         {"code": "c1", "scenario": "s1", "label": "B"}]}
    # Both carry the identifying fields, so "which one did the sentence mean" has no answer.
    assert rp.rebindings(bindings, data) == {}


# ---- through the API --------------------------------------------------------
def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("pr").write(
        {("pr", "a"): {
            "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
            "exchanges": [
                {"input": ("pr", "a"), "amount": 1, "type": "production"},
                {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
            ],
        }}
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])
    bd.Method(("other", "ap")).write([(("biosphere", "co2"), 1.0)])


def _report_with_stale_methods(client, token):
    """A chapter naming method family "t", in a report that has since moved to "other"."""
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "en", "methods": [["t", "gwp"]],
              "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": "The assessment follows the t method throughout the study.",
              "store": True, "model": "m"},
        headers=token,
    )
    client.post(f"/api/v1/report/one/pr/{rep['id']}", json={"methods": [["other", "ap"]]}, headers=token)
    return rep, sec


def test_the_patch_brief_names_the_sentence_and_the_reason(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_with_stale_methods(client, token)
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/patch-brief", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    brief = r.json()
    assert brief["language"] == "English"
    assert brief["spans"], brief
    assert "t method" in brief["spans"][0]["sentence"]
    assert any("does not use" in f for f in brief["findings"])


def test_a_verified_patch_is_stored_and_clears_the_finding(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_with_stale_methods(client, token)
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"old": "the t method", "new": "the other method",
                         "why": "the report uses other/ap"}], "store": True, "model": "m"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] and out["stored"], out
    assert "other method" in out["text"]

    stored = client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()
    got = next(s for s in stored["sections"] if s["id"] == sec["id"])
    assert "the other method" in got["text"]
    # The corrected chapter must stop reporting the finding it was corrected for.
    after = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
    assert after["chapters"][0]["remedy"] == "none", after


def test_a_patch_that_types_a_number_is_refused_by_the_same_gate(client, token, project):
    """A correction may not be a way around the check a written chapter has to pass."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_with_stale_methods(client, token)
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"old": "the t method", "new": "the other method with 42 kg"}],
              "store": True},
        headers=token,
    )
    out = r.json()
    assert not out["ok"] and not out["stored"]
    assert any(f["kind"] == "literal_number" for f in out["verdict"]["findings"])
    stored = client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()
    assert "42" not in next(s for s in stored["sections"] if s["id"] == sec["id"])["text"]


def test_marking_a_chapter_read_records_the_wording_and_notices_when_it_moves(client, token, project):
    """Softer than freezing, which forbids change: this only remembers the state the author knew, so
    "the report stays as I know it" becomes checkable instead of a hope."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_with_stale_methods(client, token)
    r = client.post(f"/api/v1/report/one/pr/{rep['id']}/reviewed", json={}, headers=token)
    assert r.status_code == 200 and r.json()["marked"] == [sec["id"]]

    out = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
    chapter = out["chapters"][0]
    assert chapter["reviewed_at"] and not chapter["changed_since_reviewed"]

    # Correct it, and the chapter reports that it has moved since the read-through.
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"old": "the t method", "new": "the other method"}], "store": True},
        headers=token,
    )
    after = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
    chapter = after["chapters"][0]
    assert chapter["changed_since_reviewed"]
    assert "the t method" in chapter["reviewed_text"]  # what it said when it was read


def test_a_frozen_chapter_can_still_be_marked_read(client, token, project):
    """Marking is exactly what a reviewer does, and freezing must not stand in its way — it changes
    no sentence."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_with_stale_methods(client, token)
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}",
        json={"kind": "prose", "locked": True},
        headers=token,
    )
    r = client.post(f"/api/v1/report/one/pr/{rep['id']}/reviewed", json={}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["marked"] == [sec["id"]]


def test_a_frozen_chapter_refuses_a_patch(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_with_stale_methods(client, token)
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}",
        json={"kind": "prose", "locked": True},
        headers=token,
    )
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"old": "the t method", "new": "the other method"}], "store": True},
        headers=token,
    )
    # Same status as a refused proposal: freezing is one rule, not two.
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "report_section_locked"


# --- a hand edit gets the same record as a written chapter ---------------------------------------


def _report_with_hotspots(client, token):
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "en", "methods": [["t", "gwp"]],
              "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    return rep, sec


def _section(client, token, rep, section_id) -> dict:
    got = client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()
    return next(s for s in got["sections"] if s["id"] == section_id)


def test_typing_a_placeholder_by_hand_binds_it(client, token, project):
    """The gap the writing path never had: a ranked-list placeholder typed by the author followed
    *position* zero, because nothing bound it to the member they meant."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_with_hotspots(client, token)
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}",
        json={"kind": "prose", "text": "The leading indicator gives {{results.0.score}}."},
        headers=token,
    )
    stored = _section(client, token, rep, sec["id"])
    assert stored.get("bindings") == {"results.0": {"method_label": "t / gwp"}}
    assert stored.get("based_on"), "a hand-written chapter now has a record to be judged against"


def test_deleting_the_sentence_takes_its_binding_with_it(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_with_hotspots(client, token)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}"
    client.post(url, json={"kind": "prose", "text": "It is {{results.0.score}}."}, headers=token)
    client.post(url, json={"kind": "prose", "text": "No numbers here at all."}, headers=token)
    assert (_section(client, token, rep, sec["id"]).get("bindings") or {}) == {}


def _report_two_indicators(client, token):
    """A report whose ranked `results` list has two members, so their order can be turned over."""
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "en", "methods": [["t", "gwp"], ["other", "ap"]],
              "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    return rep, sec


def test_editing_one_paragraph_leaves_the_other_paragraphs_pins_alone(client, token, project):
    """V180: a hand edit re-bound the whole chapter, so a typo fix moved figures onto other members.

    The measured case named two incineration datasets in plain words and cited the share of one of them
    through a pin; the process had slipped to rank six. Correcting a word three paragraphs above would
    have printed rank three's share under the PET dataset's name — silently, badge and all gone green.
    """
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_two_indicators(client, token)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}"
    client.post(
        url,
        json={"kind": "prose",
              "text": "The lead indicator gives {{results.0.score}}. A sentence with a typpo in it."},
        headers=token,
    )
    assert _section(client, token, rep, sec["id"])["bindings"] == {"results.0": {"method_label": "t / gwp"}}

    # The ranking turns over: the report is re-ordered and position zero is now the other indicator.
    client.post(f"/api/v1/report/one/pr/{rep['id']}",
                json={"methods": [["other", "ap"], ["t", "gwp"]]}, headers=token)
    client.post(
        url,
        json={"kind": "prose",
              "text": "The lead indicator gives {{results.0.score}}. A sentence with a typo in it."},
        headers=token,
    )
    stored = _section(client, token, rep, sec["id"])
    assert stored["bindings"] == {"results.0": {"method_label": "t / gwp"}}, \
        "the untouched sentence still means the indicator it was written about"


def test_a_rewritten_sentence_moves_its_own_pin(client, token, project):
    """The other half of the rule: the author rewrote *this* claim, so it is about today's data."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_two_indicators(client, token)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}"
    client.post(url, json={"kind": "prose", "text": "The lead indicator gives {{results.0.score}}."},
                headers=token)
    client.post(f"/api/v1/report/one/pr/{rep['id']}",
                json={"methods": [["other", "ap"], ["t", "gwp"]]}, headers=token)
    client.post(url, json={"kind": "prose",
                           "text": "Today the leading indicator gives {{results.0.score}} instead."},
                headers=token)
    assert _section(client, token, rep, sec["id"])["bindings"] == {"results.0": {"method_label": "other / ap"}}


def test_a_placeholder_typed_into_an_edited_chapter_is_bound_against_today(client, token, project):
    """Keeping the old pins must not swallow a new citation — it has no pin to keep."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_two_indicators(client, token)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}"
    client.post(url, json={"kind": "prose", "text": "The lead indicator gives {{results.0.score}}."},
                headers=token)
    client.post(url, json={"kind": "prose",
                           "text": "The lead indicator gives {{results.0.score}}. "
                                   "The second gives {{results.1.score}}."},
                headers=token)
    stored = _section(client, token, rep, sec["id"])
    assert stored["bindings"] == {"results.0": {"method_label": "t / gwp"},
                                  "results.1": {"method_label": "other / ap"}}


def test_a_placeholder_deleted_from_an_edited_chapter_leaves_no_pin(client, token, project):
    """…and the orphan cleanup survives too: a kept pin is only kept while its sentence is there."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep, sec = _report_two_indicators(client, token)
    url = f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}"
    client.post(url, json={"kind": "prose",
                           "text": "The lead indicator gives {{results.0.score}}. And a closing line."},
                headers=token)
    client.post(url, json={"kind": "prose", "text": "And a closing line."}, headers=token)
    assert (_section(client, token, rep, sec["id"]).get("bindings") or {}) == {}


def test_an_unrenderable_report_still_takes_the_text(client, token, project):
    """Typing into a chapter must keep working where the report cannot be computed — it then stays
    unbound and unrecorded, exactly as it was before."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = client.post("/api/v1/report/create", json={"database": "pr", "lang": "en"}, headers=token).json()
    sec = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}",
        json={"kind": "prose", "text": "Written before the report knows its process."},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert _section(client, token, rep, sec["id"])["text"].startswith("Written before")


# --- V159: a sentence can carry two claims -------------------------------------------------------


def test_a_span_names_the_placeholder_its_finding_is_about():
    """Handed only "this sentence is wrong", a model weakens everything in it.

    A solar-lamp summary said "no single process dominates — the largest, X, contributes
    {{hotspots.0.share_text}} — but taken as a chain the NiMH batteries form the largest supply chain
    in the model". Only the first half went wrong when the ranking moved; the model softened both and
    reasoned that "hotspots.0 has moved from rank 2 to rank 1, so the NiMH battery chain can no longer
    be asserted as the single largest supply chain" — a non sequitur that cost the report a true
    statement. The finding already knows which placeholder it is about; the span now says so.
    """
    text = (
        "No single process dominates — the largest, silicon, contributes {{hotspots.0.share_text}} — "
        "but taken as a chain the NiMH batteries form the largest supply chain in the model."
    )
    finding = {"kind": "ranks", "path": "hotspots.0", "message": "hotspots.0 was rank 1 and is now rank 2"}
    spans = rp.spans_for(text, [finding])
    assert len(spans) == 1
    assert spans[0]["about"] == "hotspots.0"


def test_the_rule_reaches_the_model():
    finding = {"kind": "ranks", "path": "hotspots.0", "message": "…"}
    out = rp.brief({"text": "The largest is {{hotspots.0.name}}.", "kind": "summary"}, [finding], "en")
    assert any("'about'" in rule for rule in out["rules"])


def test_a_finding_located_by_a_name_has_no_placeholder_to_point_at():
    """Selection findings are located by literal names, not paths — 'about' is then simply empty."""
    text = "Impacts were assessed with EF v3.1 throughout."
    finding = {"kind": "selection", "names": ["EF v3.1"], "message": "the report no longer uses EF v3.1"}
    spans = rp.spans_for(text, [finding])
    assert spans and spans[0]["about"] == ""


# --- V184: the correction brief knows what will refuse it ----------------------------------------
#
# Measured on the PVC window report. A strong parameter change took the result down by
# 85 %; the staleness check graded *Impact assessment* as "review" and reported a rank. The model
# delivered exactly the rephrasing it was asked for — and the store refused it, because a *different*
# sentence named a dataset that the same parameter change had dropped out of the results. That
# sentence was in no finding, so no correction could ever have included it: a paid round that had to
# fail. The two checks now hand over the same task.
_V184_TEXT = (
    "The largest single contributor is {{hotspots.0.name}} at {{hotspots.0.share_text}}. "
    "Heat for the extrusion step comes from “market for natural gas, low pressure”."
)


def _spot(name: str, code: str, share: float) -> dict:
    return {"name": name, "database": "pr", "code": code,
            "share_percent": share, "share_text": f"{share} %"}


def _v184_data(gas: bool = True) -> dict:
    """The snapshot before and after the parameter change.

    Before, the gas market is a hotspot and the chapter may name it. After, it is gone from the
    results and the PVC market has slipped to second place — one finding the staleness check reports,
    one it has no vocabulary for.
    """
    hotspots = [_spot("market for polyvinylchloride", "pvc", 42.0)]
    if gas:
        hotspots.append(_spot("market for natural gas, low pressure", "gas", 21.0))
    else:
        hotspots.insert(0, _spot("market for aluminium", "alu", 44.0))
    hotspots.append(_spot("market for flat glass", "glass", 9.0))
    return {
        "study": {"functional_unit": "1 window"},
        "results": [{"method_label": "t / gwp", "score": 1.0, "unit": "kg CO2-Eq"}],
        "hotspots": hotspots,
    }


@pytest.fixture
def snapshot(monkeypatch):
    """The numbers under the report, swappable from the test.

    Patched in both modules because each holds its own reference: `report` stamps the record when the
    text is stored, `report_ai` reads it back when it judges. Faking here rather than computing an
    LCIA whose ranking flips keeps the test about the verdicts.
    """
    from prism_lca.engine import report_pipeline
    from prism_lca.engine.report_store import ReportStore

    state = {"data": _v184_data()}

    def fake(database, report_id, body):  # noqa: ARG001
        return ReportStore().get(database, report_id), state["data"]

    # One seam: every judging endpoint reaches the snapshot through
    # `report_pipeline.analysis_snapshot`, so one patch covers them all.
    monkeypatch.setattr(report_pipeline, "analysis_snapshot", fake)
    return state


def _v184_chapter(client, token, text: str = _V184_TEXT) -> tuple[dict, dict]:
    rep = client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "en", "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections", json={"kind": "contribution"}, headers=token
    ).json()
    # The ordinary section update, so the chapter carries the record and the pins a stored one has.
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}",
        json={"kind": "contribution", "text": text},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return rep, sec


def _v184_brief(client, token, rep, sec) -> dict:
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/patch-brief", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_the_brief_carries_the_refusal_that_would_reject_the_correction(
    client, token, project, snapshot
):
    """Both halves of the job, each with its own sentence — the measured case, end to end."""
    rep, sec = _v184_chapter(client, token)
    snapshot["data"] = _v184_data(gas=False)

    chapter = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token
    ).json()["chapters"][0]
    assert chapter["remedy"] == "review", chapter

    brief = _v184_brief(client, token, rep, sec)
    assert {s["kind"] for s in brief["spans"]} == {"ranks", "unsupported_fact"}
    refused = next(s for s in brief["spans"] if s["kind"] == "unsupported_fact")
    assert "market for natural gas, low pressure" in refused["sentence"]
    assert "does not appear in the study metadata" in refused["finding"]
    assert any("is now rank" in f for f in brief["findings"])
    # Located, so nothing had to be handed over as a bare message.
    assert brief["unlocated"] == []
    assert any("refusals from the check" in rule for rule in brief["rules"])


def test_a_correction_that_answers_both_findings_is_stored(client, token, project, snapshot):
    rep, sec = _v184_chapter(client, token)
    snapshot["data"] = _v184_data(gas=False)
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/patch",
        json={"store": True, "model": "m", "edits": [
            {"old": "The largest single contributor is", "new": "One large contributor is",
             "why": "the pinned dataset is no longer the largest"},
            {"old": "from “market for natural gas, low pressure”", "new": "from natural gas",
             "why": "the dataset is no longer in the results"},
        ]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] and out["stored"], out
    after = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token
    ).json()["chapters"][0]
    assert after["remedy"] == "none", after


def test_a_correction_that_answers_only_the_rank_is_still_refused(client, token, project, snapshot):
    """The gate does not soften because the brief got longer — it says which sentence is left."""
    rep, sec = _v184_chapter(client, token)
    snapshot["data"] = _v184_data(gas=False)
    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/patch",
        json={"store": True, "model": "m", "edits": [
            {"old": "The largest single contributor is", "new": "One large contributor is",
             "why": "the pinned dataset is no longer the largest"},
        ]},
        headers=token,
    )
    out = r.json()
    assert not out["ok"] and not out["stored"], out
    refusal = next(f for f in out["verdict"]["findings"] if f["kind"] == "unsupported_fact")
    assert "market for natural gas, low pressure" in refusal["detail"]


def test_an_advisory_finding_is_not_a_repair_job(client, token, project, snapshot):
    """A value judgement is a second read, not something a correction must file down."""
    rep, sec = _v184_chapter(
        client, token, _V184_TEXT + " The frame system is environmentally friendly."
    )
    snapshot["data"] = _v184_data(gas=False)
    brief = _v184_brief(client, token, rep, sec)
    assert not [f for f in brief["gate_findings"] if f["kind"] == "value_judgement"]
    assert not [s for s in brief["spans"] if "environmentally friendly" in s["sentence"]]


def test_a_refusal_with_no_sentence_to_point_at_is_still_named(client, token, project):
    """Handed over as a bare message rather than dropped: a correction that quietly leaves one out
    looks like a clean job, and the chapter comes back carrying the same refusal."""
    gate = [{"kind": "unsupported_fact", "detail": "“market for tap water” does not appear in the "
                                                   "study metadata or the results handed over."}]
    out = rp.brief({"title": "Impact assessment", "text": TEXT}, [], "English", gate=gate)
    assert out["spans"] == []
    assert out["unlocated"] == ["“market for tap water” does not appear in the study metadata or the "
                                "results handed over."]


def test_a_chapter_the_store_would_refuse_over_nothing_locatable_is_not_a_review_case(
    client, token, project, snapshot
):
    """(B), the honest fallback: where the brief has nothing to hand over, "review" is a promise the
    correction cannot keep. The chapter builds a dataset name half out of a placeholder, so the name
    the gate objects to exists in no sentence as written — the model would be told the message and
    left to guess, and a patch is refused in one piece. Offering a paid correction round for that is
    selling a coin flip, so the verdict says rewrite and the Accept button stays shut.
    """
    text = (
        "The largest single contributor is {{hotspots.0.name}} at {{hotspots.0.share_text}}. "
        "The frame profile is “market for {{hotspots.0.name}} profiles”."
    )
    rep, sec = _v184_chapter(client, token, text)
    snapshot["data"] = _v184_data(gas=False)

    chapter = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token
    ).json()["chapters"][0]
    assert chapter["remedy"] == "rewrite", chapter
    assert any("no sentence carries the reason" in f["message"] for f in chapter["findings"]), chapter

    r = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "report_accept_refused"


def test_a_finding_is_addressed_only_when_every_sentence_reading_the_path_was_touched():
    """One corrected sentence counted the finding as answered while a second sentence
    drew the same false conclusion from the same share."""
    text = (
        "Packaging dominates with {{contribution.groups.0.share_percent}} %. "
        "It is more than half at {{contribution.groups.0.share_percent}} %."
    )
    finding = {"kind": "bands", "path": "contribution.groups.0.share_percent", "severity": "review"}
    one = rp.apply_edits(text, [{"old": "Packaging dominates", "new": "Packaging leads"}])
    assert rp.unaddressed(text, [finding], one["applied"]) == [finding]
    both = rp.apply_edits(
        text,
        [{"old": "Packaging dominates", "new": "Packaging leads"}, {"old": "more than half", "new": "a large part"}],
    )
    assert rp.unaddressed(text, [finding], both["applied"]) == []


def test_an_edit_inside_a_placeholder_is_refused_even_though_both_halves_carry_none():
    """"results.0.score" → "results.1.score" carries no complete placeholder on either side, so the
    per-edit rule let it through and the sentence printed another indicator's figure under the first
    one's unit. The whole chapter's placeholder sequence has to survive."""
    text = "The impact is {{results.0.score}} kg CO2-Eq."
    out = rp.apply_edits(text, [{"old": "results.0.score", "new": "results.1.score"}])
    assert not out["ok"] and out["text"] == text
    assert any("placeholders changed" in p for p in out["problems"])
    # Words around a placeholder may still change.
    fine = rp.apply_edits(text, [{"old": "The impact is", "new": "The climate impact amounts to"}])
    assert fine["ok"] and "{{results.0.score}}" in fine["text"]


def test_a_rank_token_may_become_the_members_stable_path_but_nothing_else_may_move():
    """V423 follow-up: the staleness exit tells the model to cite `{{subjects.1.label}}`
    instead of the ranked token once the sentence stops claiming the position — and the patch rule
    then refused exactly that on all five chapters. The named swap passes; any other placeholder
    change is still refused."""
    text = "Die Variante {{rank:results.0.subjects_by_score.0}} liegt am höchsten, mit {{results.0.subjects_by_score.0.score}}."
    swaps = rp.rank_swaps([{"kind": "ranks", "path": "results.0.subjects_by_score.0", "stable": "subjects.1"}])
    assert swaps == {
        "rank:results.0.subjects_by_score.0": "subjects.1.label",
        "results.0.subjects_by_score.0.label": "subjects.1.label",
        "results.0.subjects_by_score.0.score": "subjects.1.results.0.score",
        "results.0.subjects_by_score.0.unit": "subjects.1.results.0.unit",
    }
    ok = rp.apply_edits(
        text,
        [{"old": "Die Variante {{rank:results.0.subjects_by_score.0}} liegt am höchsten", "new": "Die Variante {{subjects.1.label}} liegt über dem Basisfall"}],
        swaps=swaps,
    )
    assert ok["ok"] is True and "{{subjects.1.label}}" in ok["text"] and "{{results.0.subjects_by_score.0.score}}" in ok["text"]
    # Without the finding the same edit is refused, as before.
    refused = rp.apply_edits(text, [{"old": "Die Variante {{rank:results.0.subjects_by_score.0}} liegt am höchsten", "new": "Die Variante {{subjects.1.label}} liegt über dem Basisfall"}])
    assert refused["ok"] is False and any("placeholders differ" in p for p in refused["problems"])
    # A swap to a DIFFERENT path is not covered by the finding and stays refused.
    other = rp.apply_edits(text, [{"old": "{{rank:results.0.subjects_by_score.0}}", "new": "{{subjects.0.label}}"}], swaps=swaps)
    assert other["ok"] is False


def test_a_declaration_beside_the_label_may_be_dropped_when_the_label_stays():
    """The writer's `„{{…label}}“ ({{rank:…}})` habit (V402) leaves two tokens for one name; the
    correction keeps the name and drops the declaration. Allowed only for the finding's path."""
    text = "Die Variante „{{results.0.subjects_by_score.0.label}}“ ({{rank:results.0.subjects_by_score.0}}) hat den höchsten Wert, {{results.0.score}}."
    swaps = rp.rank_swaps([{"kind": "ranks", "path": "results.0.subjects_by_score.0", "stable": "subjects.1"}])
    ok = rp.apply_edits(
        text,
        [{"old": "„{{results.0.subjects_by_score.0.label}}“ ({{rank:results.0.subjects_by_score.0}}) hat den höchsten Wert", "new": "„{{results.0.subjects_by_score.0.label}}“ hat einen höheren Wert als der Basisfall"}],
        swaps=swaps,
    )
    assert ok["ok"] is True and "{{rank:" not in ok["text"] and "{{results.0.score}}" in ok["text"]
    # Dropping the LABEL too would lose the member — refused.
    gone = rp.apply_edits(text, [{"old": "„{{results.0.subjects_by_score.0.label}}“ ({{rank:results.0.subjects_by_score.0}}) hat", "new": "Die polymerreiche Variante hat"}], swaps=swaps)
    assert gone["ok"] is False
