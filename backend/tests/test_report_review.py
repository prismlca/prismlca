"""A chapter a second model has read: who decides about the gate's findings, and what is kept.

Three rules. The contract — a placeholder that does not resolve, a typed number — blocks whoever has
read the chapter. Every other finding is a suspicion the reader decides about, so a reviewed write is
stored over it, while an unread write is refused over it exactly as before. And the reading is kept
with the chapter, stamped with the text it read, bounded so a record cannot become a transcript.

The numbers are faked at the snapshot boundary, as in the other gate tests: what is under test is who
decides, not the LCIA.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import report_pipeline, report_review, report_staleness
from prism_lca.engine.report_store import ReportStore, text_version

DB = "pr"

DATA = {
    "study": {"functional_unit": "1 kg of product"},
    "results": [{"method_label": "t / gwp", "score": 1.0, "unit": "kg CO2-Eq"}],
    "hotspots": [
        {"name": "cardboard box production", "database": DB, "code": "box", "share_percent": 40.0,
         "share_text": "40.0 %"},
        {"name": "transport, lorry", "database": DB, "code": "lorry", "share_percent": 20.0,
         "share_text": "20.0 %"},
    ],
}

#: False on its face — rank 2 called the largest — and caught only by a word list.
RANK_CLAIM = "Transport, lorry is the largest contributor at {{hotspots.1.share_text}}."
#: True, and nothing for any check to say.
PLAIN = "Cardboard box production carries {{hotspots.0.share_text}} of the result."


@pytest.fixture
def snapshot(monkeypatch):
    def fake(database, report_id, body):  # noqa: ARG001
        return ReportStore().get(database, report_id), DATA

    monkeypatch.setattr(report_pipeline, "analysis_snapshot", fake)


def _chapter(client, token, kind: str = "contribution") -> tuple[dict, dict]:
    rep = client.post(
        "/api/v1/report/create",
        json={"database": DB, "lang": "en", "subjects": [{"database": DB, "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": kind}, headers=token
    ).json()
    return rep, sec


def _propose(client, token, rep, sec, text: str, **extra) -> dict:
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": text, "store": True, "model": "writer-x", **extra},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _stored(client, token, rep, sec) -> dict:
    report = client.get(f"/api/v1/report/one/{DB}/{rep['id']}", headers=token).json()
    return next(s for s in report["sections"] if s["id"] == sec["id"])


def test_the_split_puts_every_token_fact_in_the_contract_and_every_reading_outside_it():
    findings = [{"kind": k} for k in ("literal_number", "contradicted_claim", "unresolved_placeholder",
                                       "self_reference", "unsupported_fact", "emoji")]
    assert {f["kind"] for f in report_review.contract(findings)} == {
        "literal_number", "unresolved_placeholder", "emoji"}
    assert {f["kind"] for f in report_review.hints(findings)} == {
        "contradicted_claim", "self_reference", "unsupported_fact"}


def test_an_unread_write_is_still_refused_over_a_word_list_finding(client, token, project, snapshot):
    rep, sec = _chapter(client, token)
    verdict = _propose(client, token, rep, sec, RANK_CLAIM)
    assert verdict["stored"] is False
    assert [f["kind"] for f in verdict["findings"]] == ["contradicted_claim"]


def test_a_reviewed_write_is_stored_over_a_reading_the_reviewer_decided(client, token, project, snapshot):
    rep, sec = _chapter(client, token)
    review = {"rounds": 1, "issues": [], "hints": {"contradicted_claim": {"dismissed": 1}}}
    verdict = _propose(client, token, rep, sec, RANK_CLAIM, reviewed_by="reader-y", review=review)
    assert verdict["stored"] is True
    stored = _stored(client, token, rep, sec)
    assert stored["text"] == RANK_CLAIM
    assert stored["ai_review"]["reviewer"] == "reader-y"
    assert stored["ai_review"]["text_version"] == text_version(RANK_CLAIM)


@pytest.mark.parametrize(
    "text",
    [
        "Cardboard box production carries {{hotspots.9.share_text}}.",
        # Near the box's 40.0 % but not what anything prints: refused, with the candidate named. Typed
        # exactly as printed it would be bound to its placeholder instead (V460).
        "Cardboard box production carries 41 % of the result.",
    ],
)
def test_the_contract_blocks_a_reviewed_write_too(client, token, project, snapshot, text):
    rep, sec = _chapter(client, token)
    verdict = _propose(client, token, rep, sec, text, reviewed_by="reader-y", review={"rounds": 1})
    assert verdict["stored"] is False
    assert report_review.contract(verdict["findings"])


def test_the_kept_reading_is_bounded_and_knows_no_status_it_was_not_given(client, token, project, snapshot):
    rep, sec = _chapter(client, token)
    review = {
        "rounds": 2,
        "issues": [
            {"quote": "x" * 2000, "problem": "too long", "status": "resolved"},
            {"quote": "y", "problem": "made up", "status": "waved_through"},
        ]
        + [{"quote": str(i), "problem": "p", "status": "resolved"} for i in range(40)],
        "questions": [{"id": "q1", "question": "Is end of life in scope?", "options": ["Yes", "No", ""]}],
    }
    _propose(client, token, rep, sec, PLAIN, reviewed_by="reader-y", review=review)
    kept = _stored(client, token, rep, sec)["ai_review"]
    assert len(kept["issues"]) == 30
    assert len(kept["issues"][0]["quote"]) <= 600
    assert kept["issues"][1]["status"] == "open"
    assert kept["verdict"] == "open_points"
    assert kept["questions"][0]["options"] == ["Yes", "No"]


def test_an_unread_store_leaves_no_reading_behind(client, token, project, snapshot):
    rep, sec = _chapter(client, token)
    _propose(client, token, rep, sec, PLAIN, reviewed_by="reader-y", review={"rounds": 1})
    _propose(client, token, rep, sec, PLAIN + " It is the box.")
    assert _stored(client, token, rep, sec).get("ai_review") is None


def test_the_reader_is_shown_the_chapter_as_printed_and_the_other_chapters_too(
    client, token, project, snapshot
):
    rep, sec = _chapter(client, token)
    other = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": "conclusions"}, headers=token
    ).json()
    _propose(client, token, rep, other, PLAIN)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/review-brief",
        json={"text": "Transport carries {{hotspots.1.share_text}}."},
        headers=token,
    )
    assert r.status_code == 200, r.text
    brief = r.json()
    assert brief["printed"] == "Transport carries 20.0 %."
    assert brief["facts"]
    assert [s["text"] for s in brief["siblings"]] == ["Cardboard box production carries 40.0 % of the result."]


# --------------------------------------------------------------------------- #
# updating instead of rewriting, and what the author answers
# --------------------------------------------------------------------------- #
@pytest.fixture
def moving(monkeypatch):
    """Numbers that can move under a written chapter: `state["data"]` is swapped by the test."""
    state = {"data": DATA}

    def fake(database, report_id, body):  # noqa: ARG001
        return ReportStore().get(database, report_id), state["data"]

    monkeypatch.setattr(report_pipeline, "analysis_snapshot", fake)
    return state


#: The two hotspots swapped: the box is second now, the lorry first.
SWAPPED = {**DATA, "hotspots": [DATA["hotspots"][1], DATA["hotspots"][0]]}


def test_an_update_is_handed_the_chapter_in_todays_positions(client, token, project, moving, monkeypatch):
    monkeypatch.setattr(report_staleness, "_dataset_fingerprint", lambda database, code: f"sha-{code}")
    rep, sec = _chapter(client, token)
    review = {"rounds": 1, "issues": [{"quote": "Cardboard box", "problem": "doubt", "status": "open"}]}
    lookups = [{"name": "get_process_details", "args": '{"database": "pr", "code": "box"}', "result": "Corrugated board."}]
    _propose(client, token, rep, sec, PLAIN, reviewed_by="reader-y", review=review, lookups=lookups)
    assert _stored(client, token, rep, sec)["bindings"]["hotspots.0"]["code"] == "box"
    moving["data"] = SWAPPED
    url = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"
    r = client.post(f"{url}/update-brief", headers=token)
    assert r.status_code == 200, r.text
    update = r.json()["update"]
    # The box stands second today, and the text the writer edits says so — the facts beside it are in
    # today's order, and a new sentence citing index 0 means the lorry in both.
    assert update["text"] == PLAIN.replace("hotspots.0", "hotspots.1")
    # It prints what the stored chapter prints under its pin: still the box's 40 %.
    assert update["printed"] == "Cardboard box production carries 40.0 % of the result."
    assert any("rank" in c for c in update["changes"])
    assert update["open_points"] == [{"quote": "Cardboard box", "problem": "doubt"}]
    # The evidence the chapter was accepted with comes along: its sentences still rest on it.
    assert update["lookups"] == lookups
    assert r.json()["snapshot_id"]
    # Stored as written, the untouched sentence is about the box, and the new one about the lorry.
    _propose(client, token, rep, sec, update["text"] + " Transport leads with {{hotspots.0.share_text}}.")
    pins = _stored(client, token, rep, sec)["bindings"]
    assert (pins["hotspots.1"]["code"], pins["hotspots.0"]["code"]) == ("box", "lorry")


def test_an_update_carries_only_the_lookups_that_are_still_true(client, token, project, moving, monkeypatch):
    shas = {"box": "sha-1", "lorry": "sha-1"}
    monkeypatch.setattr(report_staleness, "_dataset_fingerprint", lambda database, code: shas[code])
    rep, sec = _chapter(client, token)
    box = {"name": "get_process_details", "args": '{"database": "pr", "code": "box"}', "result": "Corrugated board."}
    lorry = {"name": "get_process_details", "args": '{"database": "pr", "code": "lorry"}', "result": "Euro 6."}
    moved = {"name": "explain_result", "args": "{}", "result": "The box carries 40 %."}
    _propose(client, token, rep, sec, PLAIN, lookups=[box, lorry, moved])
    # The lorry's documentation changed since; the explanation described numbers that have moved.
    shas["lorry"] = "sha-2"
    url = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"
    assert client.post(f"{url}/update-brief", headers=token).json()["update"]["lookups"] == [box]


def test_a_member_gone_from_the_results_is_marked_and_refused(client, token, project, moving):
    rep, sec = _chapter(client, token)
    _propose(client, token, rep, sec, PLAIN)
    moving["data"] = {**DATA, "hotspots": [DATA["hotspots"][1]]}
    url = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"
    update = client.post(f"{url}/update-brief", headers=token).json()["update"]
    assert "{{gone:hotspots.0.share_text}}" in update["text"]
    # Left in, the contract refuses it — never the lorry's share under the box's name.
    r = client.post(f"{url}/proposal", json={"text": update["text"], "store": False, "reviewed_by": "reader-y"},
                    headers=token)
    assert r.json()["ok"] is False
    assert any(f["kind"] == "unresolved_placeholder" for f in r.json()["findings"])


def test_the_earlier_wording_put_back_keeps_the_members_it_was_written_about(client, token, project, moving):
    rep, sec = _chapter(client, token)
    _propose(client, token, rep, sec, PLAIN)
    moving["data"] = SWAPPED
    url = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}"
    rebased = client.post(f"{url}/update-brief", headers=token).json()["update"]["text"]
    _propose(client, token, rep, sec, rebased)
    assert _stored(client, token, rep, sec)["previous"]["text"] == PLAIN
    # Put back by hand: index 0 is the lorry today, but this wording was about the box.
    client.post(url, json={"kind": "contribution", "text": PLAIN}, headers=token)
    assert _stored(client, token, rep, sec)["bindings"]["hotspots.0"]["code"] == "box"


def test_an_empty_chapter_has_nothing_to_update(client, token, project, moving):
    rep, sec = _chapter(client, token)
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/update-brief", headers=token)
    assert r.status_code == 409


def test_an_answer_reaches_every_brief_and_can_be_withdrawn(client, token, project, moving):
    rep, sec = _chapter(client, token)
    url = f"/api/v1/report/one/{DB}/{rep['id']}"
    r = client.post(
        f"{url}/answers",
        json={"question_id": "q-1", "question": "Is end of life in scope?", "answer": "No, excluded."},
        headers=token,
    )
    assert r.status_code == 200, r.text
    brief = client.post(f"{url}/sections/{sec['id']}/brief", json={}, headers=token).json()
    assert brief["author_answers"] == [{"question": "Is end of life in scope?", "answer": "No, excluded."}]
    read = client.post(f"{url}/sections/{sec['id']}/review-brief", json={"text": PLAIN}, headers=token).json()
    assert read["author_answers"] == brief["author_answers"]
    client.post(f"{url}/answers", json={"question_id": "q-1", "answer": ""}, headers=token)
    assert client.post(f"{url}/sections/{sec['id']}/brief", json={}, headers=token).json()["author_answers"] == []


def test_the_author_keeps_a_doubted_sentence_and_the_reading_says_so(client, token, project, moving):
    rep, sec = _chapter(client, token)
    review = {"rounds": 3, "issues": [{"quote": "Cardboard box", "problem": "doubt", "status": "open"}]}
    _propose(client, token, rep, sec, PLAIN, reviewed_by="reader-y", review=review)
    url = f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/keep-point"
    r = client.post(url, json={"quote": "Cardboard box"}, headers=token)
    assert r.status_code == 200, r.text
    kept = _stored(client, token, rep, sec)["ai_review"]
    assert kept["issues"][0]["status"] == "kept"
    assert kept["verdict"] == "accepted"
    # Changed since the reading: there is nothing left to keep.
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "contribution", "text": PLAIN + " By hand."},
        headers=token,
    )
    assert client.post(url, json={"quote": "Cardboard box"}, headers=token).status_code == 409


#: Right, and misread by the word check — it takes the positive difference for a claim that the first
#: figure is the lower one. The reader judges it; measured on a live run's executive summary.
COMPARED = "The lower share is {{diff(hotspots.0.share_percent, hotspots.1.share_percent)}} points below the higher one."


def test_a_reading_is_not_raised_again_while_its_figures_stand(client, token, project, moving):
    from prism_lca.engine import report_staleness

    def comparisons(rep, sec) -> list[dict]:
        report = ReportStore().get(DB, rep["id"])
        section = next(s for s in report["sections"] if s["id"] == sec["id"])
        return [f for f in report_staleness.verdicts(section, report, moving["data"]) if f["kind"] == "comparison"]

    rep, sec = _chapter(client, token)
    _propose(client, token, rep, sec, COMPARED, reviewed_by="reader-y", review={"rounds": 1, "issues": []})
    # The reader judged this sentence against these figures: no "Needs update" for it a minute later.
    assert comparisons(rep, sec) == []
    # Once the figures move, the reading no longer covers them and the check speaks again.
    moving["data"] = {**DATA, "hotspots": [{**DATA["hotspots"][0], "share_text": "45.0 %", "share_percent": 45.0},
                                           DATA["hotspots"][1]]}
    assert comparisons(rep, sec)
    # A chapter nobody read is judged as before: the gate alone refuses it.
    moving["data"] = DATA
    rep2, sec2 = _chapter(client, token)
    assert _propose(client, token, rep2, sec2, COMPARED)["stored"] is False


def test_what_the_store_would_refuse_is_the_contract_for_a_chapter_that_was_read(client, token, project, moving):
    from prism_lca.engine import report_gate

    rep, sec = _chapter(client, token)
    _propose(client, token, rep, sec, COMPARED, reviewed_by="reader-y", review={"rounds": 1, "issues": []})
    report = ReportStore().get(DB, rep["id"])
    section = next(s for s in report["sections"] if s["id"] == sec["id"])
    assert report_gate.gate_block(section, report, DATA) is None
    # Without the reading the word check still decides, as it did when such a chapter was stored.
    unread = {k: v for k, v in section.items() if k != "ai_review"}
    assert report_gate.gate_block(unread, report, DATA)["kind"] == "gate"
