"""A figure caption cites like prose, so it is pinned and watched like prose.

A caption may carry placeholders and is resolved at render time, but bindings and the staleness
record were formed from the chapter text alone. A ranked index that only a caption cited therefore
followed the list's POSITION: after a rank swap "Packaging: {{contribution.groups.0.share_text}}"
printed the share of transport, with no badge anywhere. Captions now have pins and a record of their
own (`caption_bindings`, `caption_based_on`), judged by `report_staleness.caption_verdicts`; the text
keeps `bindings`/`based_on`, and a write to one half never re-stamps or re-points the other.

The data is faked at the snapshot boundary, as in test_report_accept: what is under test is the
record-and-verdict arithmetic, not an LCIA whose ranking flips.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import report_data as rd
from prism_lca.engine import report_patch, report_pipeline
from prism_lca.engine import report_staleness as rs
from prism_lca.engine.report_store import ReportStore

DB = "pr"
CAPTION = "Packaging: {{contribution.groups.0.share_text}}"


def _group(key: str, share: float) -> dict:
    return {"key": key, "share_percent": share, "share_text": f"{share} %", "impact": share / 100.0}


def _data(swapped: bool = False) -> dict:
    groups = [_group("Packaging", 60.0), _group("Transport", 25.0)]
    if swapped:
        groups = [_group("Transport", 55.0), _group("Packaging", 30.0)]
    return {
        "study": {"functional_unit": "1 L"},
        "results": [{"method_label": "t / gwp", "score": 1.0, "unit": "kg CO2-Eq"}],
        "contribution": {"dimension": "Life-cycle phase", "unit": "kg CO2-Eq", "groups": groups},
    }


def _figure(caption: str = CAPTION) -> dict:
    return {"kind": "bar", "source": "contribution.groups", "caption": caption}


def _report() -> dict:
    return {"methods": [["t", "gwp"]], "subjects": [{"label": "Baseline", "code": "a"}], "lang": "en"}


# --- the helper -------------------------------------------------------------------------------------


def test_prose_is_the_text_first_then_the_captions_the_renderer_draws():
    section = {"text": "The text.", "figures": [_figure(), _figure("  "), {"kind": "heatmap"}]}
    prose = rd.prose_of(section)
    # The text is untouched at offset 0 — the patch mechanism's offsets stay valid on it.
    assert prose.startswith("The text.")
    assert prose == "The text.\n\n" + CAPTION
    # The list wins over the legacy singular, exactly as report_render chooses what to draw…
    assert rd.captions_of({"figures": [_figure("a")], "figure": _figure("b")}) == ["a"]
    # …and the singular counts while the list is empty.
    assert rd.captions_of({"figures": [], "figure": _figure("b")}) == ["b"]
    assert rd.prose_of({"text": "Only text."}) == "Only text."


def test_a_path_only_a_caption_cites_is_bound_and_goes_stale_on_a_rank_swap():
    from prism_lca.engine import report_gate

    before = {"id": "s", "kind": "prose", "text": "The phases are compared below."}
    before["based_on"] = rs.components(before["text"], {}, _report(), _data())
    section = {**before, "figures": [_figure()]}
    section.update(report_gate.caption_record(before, section, _report(), _data()))
    bindings = section["caption_bindings"]
    assert bindings.get("contribution.groups.0", {}).get("key") == "Packaging", bindings
    # The text alone — what the store used to bind — pins nothing at all.
    assert rd.bindings_for(section["text"], _data()) == {}
    assert rs.worst(rs.verdicts(section, _report(), _data())) == "none"

    swapped = _data(swapped=True)
    found = rs.verdicts(section, _report(), swapped)
    ranks = [f for f in found if f["kind"] == "ranks"]
    assert ranks and ranks[0]["path"] == "contribution.groups.0", found
    assert ranks[0]["in"] == "caption" and ranks[0]["message"].startswith("a figure caption")
    assert rs.worst(found) == "review"
    # And the caption still prints Packaging's share, not whatever sits at position 0 today.
    assert rd.bound_lookup("contribution.groups.0.share_text", swapped, bindings) == "30.0 %"


def test_a_caption_finding_is_not_handed_to_a_text_correction_as_its_sentence():
    """A patch edits the text by offset; a caption is not a sentence it can reach. The finding is
    reported as unlocated — and so stays open after any patch — instead of pointing into the text."""
    text = "The phases are compared below."
    finding = {"kind": "ranks", "severity": "review", "path": "contribution.groups.0", "message": "moved"}
    assert report_patch.unlocated_in(text, [finding]) == [finding]
    assert report_patch.unaddressed(text, [finding], [{"old": "phases", "new": "stages"}]) == [finding]


def test_an_unchanged_caption_keeps_its_pin_and_a_reworded_one_does_not():
    before = {"text": "a", "figures": [_figure()]}
    pins = {"contribution.groups.0": {"key": "Packaging"}}
    assert report_patch.surviving_caption_bindings(before, {**before, "text": "b"}, pins) == pins
    reworded = {"text": "a", "figures": [_figure("Leader: {{contribution.groups.0.share_text}}")]}
    assert report_patch.surviving_caption_bindings(before, reworded, pins) == {}


# --- through the endpoints --------------------------------------------------------------------------


@pytest.fixture
def snapshot(monkeypatch):
    state = {"data": _data()}

    def fake(database, report_id, body):  # noqa: ARG001
        return ReportStore().get(database, report_id), state["data"]

    monkeypatch.setattr(report_pipeline, "analysis_snapshot", fake)
    return state


def _chapter(client, token, text: str) -> tuple[dict, dict]:
    rep = client.post(
        "/api/v1/report/create",
        json={"database": DB, "lang": "en", "subjects": [{"database": DB, "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": "prose"}, headers=token).json()
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}", json={"text": text}, headers=token)
    assert r.status_code == 200, r.text
    return rep, sec


def _stored(client, token, rep, sec) -> dict:
    report = client.get(f"/api/v1/report/one/{DB}/{rep['id']}", headers=token).json()
    return next(s for s in report["sections"] if s["id"] == sec["id"])


def _staleness(client, token, rep) -> dict:
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/staleness", json={}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["chapters"][0]


def test_a_caption_typed_in_the_figure_editor_is_pinned_and_watched(client, token, project, snapshot):
    rep, sec = _chapter(client, token, "The phases are compared below.")
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}", json={"figures": [_figure()]}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["affects_staleness"] is True
    stored = _stored(client, token, rep, sec)
    assert stored["caption_bindings"]["contribution.groups.0"]["key"] == "Packaging", stored
    # The text's own pins are the text's: it cites nothing, so it pins nothing.
    assert not stored.get("bindings")
    assert _staleness(client, token, rep)["remedy"] == "none"

    snapshot["data"] = _data(swapped=True)
    chapter = _staleness(client, token, rep)
    assert chapter["remedy"] == "review", chapter
    assert any(f["kind"] == "ranks" and f["path"] == "contribution.groups.0" for f in chapter["findings"])


def test_reordering_figures_without_touching_a_caption_records_nothing(client, token, project, snapshot):
    rep, sec = _chapter(client, token, "The phases are compared below.")
    base = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"
    client.post(base, json={"figures": [_figure(), {"kind": "heatmap"}]}, headers=token)
    first = _stored(client, token, rep, sec)
    r = client.post(base, json={"figures": [{"kind": "heatmap"}, _figure()]}, headers=token)
    assert r.json()["affects_staleness"] is False
    again = _stored(client, token, rep, sec)
    assert again["caption_based_on"] == first["caption_based_on"]
    assert again["based_on"] == first["based_on"]


def test_a_rewrite_of_the_text_does_not_move_the_caption_onto_todays_leader(client, token, project, snapshot):
    """The writer replaces the text and never touches a caption. Re-pinning the caption by position
    against today's data would print Transport's share under the word "Packaging" — and clear the
    very rank finding that says so."""
    rep, sec = _chapter(client, token, "The phases are compared below.")
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}", json={"figures": [_figure()]}, headers=token
    )
    snapshot["data"] = _data(swapped=True)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": "The two life-cycle phases are compared in the figure below.", "store": True},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["stored"], r.json()
    stored = _stored(client, token, rep, sec)
    assert stored["caption_bindings"]["contribution.groups.0"]["key"] == "Packaging", stored


def test_a_frozen_chapter_still_takes_a_caption_and_its_pins(client, token, project, snapshot):
    """Figures stay editable on a frozen chapter; the record that comes with a caption must not turn
    that edit into a refused content change."""
    rep, sec = _chapter(client, token, "The phases are compared below.")
    base = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"
    assert client.post(base, json={"locked": True}, headers=token).status_code == 200
    r = client.post(base, json={"figures": [_figure()]}, headers=token)
    assert r.status_code == 200, r.text
    stored = _stored(client, token, rep, sec)
    assert stored["caption_bindings"]["contribution.groups.0"]["key"] == "Packaging"
    assert stored["text"] == "The phases are compared below."
    # …and the text itself is still frozen.
    assert client.post(base, json={"text": "Changed."}, headers=token).status_code != 200


# --- regressions, first pass ---------------------------------------------

LEADING = "Packaging is the leading phase: {{contribution.groups.0.share_text}}"


def _with_caption(client, token, caption: str = LEADING) -> tuple[dict, dict, str]:
    rep, sec = _chapter(client, token, "The phases are compared below.")
    base = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"
    assert client.post(base, json={"figures": [_figure(caption)]}, headers=token).status_code == 200
    return rep, sec, base


def _caption_ranks(chapter: dict) -> list[dict]:
    return [f for f in chapter["findings"] if f.get("in") == "caption" and f["kind"] == "ranks"]


def test_a_text_proposal_does_not_clear_an_unchanged_caption_s_rank_finding(client, token, project, snapshot):
    """Reproduced: after Transport took the lead, rewriting an unrelated sentence re-stamped the whole
    prose record and the caption's false "Packaging is the leading phase" stood with a current badge.
    The gate judged only the text, so the text is all a proposal may re-stamp."""
    rep, sec, base = _with_caption(client, token)
    snapshot["data"] = _data(swapped=True)
    assert _caption_ranks(_staleness(client, token, rep))
    r = client.post(
        f"{base}/proposal", json={"text": "The two phases are compared in the figure below.", "store": True},
        headers=token,
    )
    assert r.json()["stored"], r.json()
    chapter = _staleness(client, token, rep)
    assert _caption_ranks(chapter), chapter
    assert chapter["remedy"] == "review"


def test_a_hand_edit_of_the_text_does_not_clear_a_caption_s_rank_finding(client, token, project, snapshot):
    rep, sec, base = _with_caption(client, token)
    snapshot["data"] = _data(swapped=True)
    assert client.post(base, json={"text": "The phases are shown below."}, headers=token).status_code == 200
    assert _caption_ranks(_staleness(client, token, rep))


def test_a_kept_caption_pin_does_not_decide_what_the_fresh_text_s_index_means(client, token, project, snapshot):
    """Reproduced: with one shared map, the unchanged caption held index 0 on Packaging, so a correct
    proposal using today's index 0 for Transport resolved to Packaging's share and was refused as
    misbound — Transport was reachable through no group index at all. Two namespaces now."""
    rep, sec, base = _with_caption(client, token, CAPTION)
    snapshot["data"] = _data(swapped=True)
    r = client.post(
        f"{base}/proposal",
        json={"text": "Transport now leads with {{contribution.groups.0.share_text}}.", "store": True},
        headers=token,
    )
    body = r.json()
    assert body["stored"], body
    assert not [f for f in body["findings"] if f["kind"] == "misbound_name"], body
    stored = _stored(client, token, rep, sec)
    assert stored["bindings"]["contribution.groups.0"]["key"] == "Transport"
    assert stored["caption_bindings"]["contribution.groups.0"]["key"] == "Packaging"
    # Each half resolves through its own pins: the text prints Transport's share, the caption Packaging's.
    swapped = _data(swapped=True)
    assert rd.bound_lookup("contribution.groups.0.share_text", swapped, stored["bindings"]) == "55.0 %"
    assert rs.caption_bindings(stored)["contribution.groups.0"]["key"] == "Packaging"
    assert rd.bound_lookup("contribution.groups.0.share_text", swapped, rs.caption_bindings(stored)) == "30.0 %"


# --- regressions, second pass ---------------------------------------


def _legacy(client, token, caption: str = CAPTION) -> tuple[dict, dict, str]:
    """A chapter as the a7aa4fe2 era stored it: caption pins in the shared `bindings`, their ranks in the
    shared `based_on`, no caption fields of their own."""
    rep, sec = _chapter(client, token, "The phases are compared below.")
    section = {"text": "The phases are compared below.", "figures": [_figure(caption)]}
    prose = rd.prose_of(section)
    pins = rd.bindings_for(prose, _data())
    ReportStore().update_section(
        DB, rep["id"], sec["id"],
        {"figures": [_figure(caption)], "bindings": pins, "based_on": rs.components(prose, pins, _report(), _data())},
    )
    stored = _stored(client, token, rep, sec)
    assert "caption_bindings" not in stored and stored["bindings"]["contribution.groups.0"]["key"] == "Packaging"
    return rep, sec, f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"


def test_a_legacy_caption_keeps_its_rank_finding_without_caption_fields():
    """[2] Before: `caption_verdicts` read the missing `caption_based_on`, the text judgement no longer
    looked at captions, and the rank swap degraded to a harmless "numbers moved"."""
    section = {"id": "s", "kind": "prose", "text": "The phases are compared below.", "figures": [_figure()]}
    prose = rd.prose_of(section)
    pins = rd.bindings_for(prose, _data())
    section.update(bindings=pins, based_on=rs.components(prose, pins, _report(), _data()))
    found = rs.verdicts(section, _report(), _data(swapped=True))
    assert any(f["kind"] == "ranks" and f.get("in") == "caption" for f in found), found
    assert rs.worst(found) == "review"


def test_a_text_proposal_materialises_legacy_caption_pins_before_replacing_bindings(
    client, token, project, snapshot
):
    """[1] Before: the unchanged legacy caption produced no caption record, the proposal replaced
    `bindings` with the text's own, and the caption printed Transport's 55 % — no finding."""
    rep, sec, base = _legacy(client, token)
    snapshot["data"] = _data(swapped=True)
    r = client.post(
        f"{base}/proposal",
        json={"text": "Transport now leads with {{contribution.groups.0.share_text}}.", "store": True},
        headers=token,
    )
    assert r.json()["stored"], r.json()
    stored = _stored(client, token, rep, sec)
    assert stored["bindings"]["contribution.groups.0"]["key"] == "Transport"
    assert stored["caption_bindings"]["contribution.groups.0"]["key"] == "Packaging", stored
    swapped = _data(swapped=True)
    assert rd.bound_lookup("contribution.groups.0.share_text", swapped, rs.caption_bindings(stored)) == "30.0 %"
    assert _caption_ranks(_staleness(client, token, rep))


def test_appending_an_unrelated_figure_does_not_re_pin_a_legacy_caption(client, token, project, snapshot):
    """[1] Before: `caption_record` read the absent `caption_bindings`, kept nothing and bound the legacy
    caption against today's data by position."""
    rep, sec, base = _legacy(client, token)
    snapshot["data"] = _data(swapped=True)
    r = client.post(base, json={"figures": [_figure(), _figure("Transport: {{contribution.groups.0.share_text}}")]},
                    headers=token)
    assert r.status_code == 200, r.text
    stored = _stored(client, token, rep, sec)
    assert stored["caption_bindings"]["contribution.groups.0"]["key"] == "Packaging", stored
    assert _caption_ranks(_staleness(client, token, rep))


def test_a_selection_change_only_a_caption_depends_on_is_reported():
    """[3] Only the caption cites `first_result`; reordering the methods makes it print the toxicity
    score under "Climate impact". `_judge` found it and the caption filter threw it away."""
    from prism_lca.engine import report_gate

    data = {**_data(), "first_result": {"score": 1.0, "unit": "kg CO2-Eq"}}
    climate_first = {**_report(), "methods": [["t", "gwp"], ["t", "tox"]]}
    tox_first = {**_report(), "methods": [["t", "tox"], ["t", "gwp"]]}
    before = {"id": "s", "kind": "prose", "text": "The phases are compared below."}
    before["based_on"] = rs.components(before["text"], {}, climate_first, data)
    section = {**before, "figures": [_figure("Climate impact: {{first_result.score}}")]}
    section.update(report_gate.caption_record(before, section, climate_first, data))
    assert rs.worst(rs.verdicts(section, climate_first, data)) == "none"

    found = rs.verdicts(section, tox_first, data)
    selection = [f for f in found if f["kind"] == "selection"]
    assert selection and all(f.get("in") == "caption" for f in selection), found
    assert rs.worst(found) == "rewrite"
    # …and a change the text reports too is reported once, not twice.
    both = {**section, "text": "Score {{first_result.score}}."}
    both["based_on"] = rs.components(both["text"], {}, climate_first, data)
    twice = [f for f in rs.verdicts(both, tox_first, data) if f["kind"] == "selection"]
    assert len(twice) == 1 and "in" not in twice[0], twice


def _hot(name: str) -> dict:
    return {"hotspots": [{"name": name, "database": "ei", "code": "abc", "share_percent": 40.0,
                          "share_text": "40.0 %"}], **{k: v for k, v in _data().items() if k != "hotspots"}}


def test_rebind_repairs_a_renamed_member_a_caption_is_pinned_to(client, token, project, snapshot):
    """[4] The free repair looked at the text's map only; the caption's pin stayed on the old name and
    printed "[missing: …]". Both maps are repaired, both baselines kept."""
    snapshot["data"] = _hot("Old name")
    rep, sec = _chapter(client, token, "The hotspots are shown below.")
    base = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"
    client.post(base, json={"figures": [_figure("Top: {{hotspots.0.share_text}}")]}, headers=token)
    before = _stored(client, token, rep, sec)
    assert before["caption_bindings"]["hotspots.0"]["name"] == "Old name"

    snapshot["data"] = _hot("New name")
    assert _staleness(client, token, rep)["rebindable"] == 1
    r = client.post(f"{base}/rebind", json={}, headers=token)
    assert r.status_code == 200, r.text
    assert len(r.json()["rebound"]) == 1 and r.json()["stored"]
    after = _stored(client, token, rep, sec)
    assert after["caption_bindings"]["hotspots.0"]["name"] == "New name"
    assert after["caption_based_on"] == before["caption_based_on"]
    assert after.get("based_on") == before.get("based_on")


# --- regressions, third pass -------------------------------------------------------


def test_a_legacy_caption_does_not_inherit_the_text_s_lead_method():
    """Only the TEXT cites the first indicator; the caption cites nothing. Materialised from the shared
    record, the caption inherited `lead_method` and was condemned ("written for t / gwp; the report
    now uses none") with nothing changed."""
    data = {**_data(), "first_result": {"score": 1.0, "unit": "kg CO2-Eq"}}
    report = {**_report(), "methods": [["t", "gwp"], ["t", "tox"]]}
    section = {"id": "s", "kind": "prose", "text": "The score is {{first_result.score}}.",
               "figures": [_figure("The life cycle phases.")]}
    prose = rd.prose_of(section)
    section["based_on"] = rs.components(prose, {}, report, data)
    assert "lead_method" in section["based_on"]["selection"]
    found = rs.verdicts(section, report, data)
    assert not [f for f in found if f["kind"] == "selection"], found
    assert rs.worst(found) == "none"
    # …and the materialised baseline carries no lead_method for a caption that never read it.
    assert "lead_method" not in rs.caption_state(section)[1]["selection"]


def test_a_caption_written_anew_is_recorded_against_today_not_its_predecessor():
    """The only caption is replaced by a new one after the methods moved from gwp to tox. keep_stale
    carried the old selection over, so the new caption stayed "written for t / gwp"."""
    from prism_lca.engine import report_gate

    data = {**_data(), "first_result": {"score": 1.0, "unit": "kg CO2-Eq"}}
    climate_first = {**_report(), "methods": [["t", "gwp"], ["t", "tox"]]}
    tox_first = {**_report(), "methods": [["t", "tox"], ["t", "gwp"]]}
    plain = {"id": "s", "kind": "prose", "text": "The phases are compared below."}
    plain["based_on"] = rs.components(plain["text"], {}, climate_first, data)
    old = {**plain, "figures": [_figure("Climate impact: {{first_result.score}}")]}
    old.update(report_gate.caption_record(plain, old, climate_first, data))
    assert any(f["kind"] == "selection" for f in rs.verdicts(old, tox_first, data))

    new = {**old, "figures": [_figure("Toxicity: {{first_result.score}}")]}
    new.update(report_gate.caption_record(old, new, tox_first, data))
    found = rs.verdicts(new, tox_first, data)
    assert not [f for f in found if f["kind"] == "selection"], found
    # …while a caption that survives word for word keeps its finding when a new one joins it.
    both = {**old, "figures": [*old["figures"], _figure("Toxicity: {{first_result.score}}")]}
    both.update(report_gate.caption_record(old, both, tox_first, data))
    assert any(f["kind"] == "selection" and f.get("in") == "caption" for f in rs.verdicts(both, tox_first, data))
