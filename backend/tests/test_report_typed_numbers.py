"""A chapter left with nothing but typed numbers is stored for the author to decide (V461).

The writer that ran out of attempts over one typed figure used to lose the whole chapter. These tests
hold the replacement to its rules: only typed numbers may be left, each becomes an open point the author
keeps (with a reason) or replaces with the placeholder it was matched to, the report cannot be approved
while one is open, and a kept number is named again once the results move.
"""
from __future__ import annotations

import copy

import pytest

from prism_lca.engine import report_pipeline
from prism_lca.engine.report_store import ReportStore

DB = "pr"

DATA = {
    "study": {"goal": "Compare two cleaners", "functional_unit": "1 bottle"},
    "results": [{"method_label": "EF 3.1 / climate change", "unit": "kg CO2-Eq", "score": 1.234}],
    "contribution": {
        "unit": "kg CO2-Eq",
        "groups": [{"key": "Packaging", "label": "Packaging", "share": 0.548, "share_percent": 54.8, "share_text": "54.8 %"}],
    },
    "subjects": [],
    "parameters": [],
    "report": {"significance_percent": 5.0, "significance_text": "5 %"},
}

#: Two typed numbers: "55 %" is near the packaging share and named; "8.5 kg" is nothing in the data.
TYPED = "Packaging carries about 55 % of the impact. Each bottle weighs 8.5 kg in transport."


@pytest.fixture
def numbers(monkeypatch):
    state = {"data": copy.deepcopy(DATA)}

    def fake(database, report_id, body):  # noqa: ARG001
        return ReportStore().get(database, report_id), state["data"]

    monkeypatch.setattr(report_pipeline, "analysis_snapshot", fake)
    return state


def _chapter(client, token) -> tuple[dict, dict, str]:
    rep = client.post(
        "/api/v1/report/create",
        json={"database": DB, "lang": "en", "subjects": [{"database": DB, "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": "prose"}, headers=token).json()
    return rep, sec, f"/api/v1/report/one/{DB}/{rep['id']}"


def _stored(client, token, url, sec) -> dict:
    return next(s for s in client.get(url, headers=token).json()["sections"] if s["id"] == sec["id"])


def _propose(client, token, url, sec, text, **extra) -> dict:
    r = client.post(
        f"{url}/sections/{sec['id']}/proposal",
        json={"text": text, "store": True, "model": "writer-x", **extra},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_typed_numbers_alone_are_stored_as_open_points_only_when_asked(client, token, project, numbers):
    rep, sec, url = _chapter(client, token)
    refused = _propose(client, token, url, sec, TYPED)
    assert refused["stored"] is False

    kept = _propose(client, token, url, sec, TYPED, keep_numbers=True)
    assert kept["stored"] is True and kept["typed_numbers"] == 2
    stored = _stored(client, token, url, sec)
    assert stored["text"] == TYPED
    points = stored["ai_review"]["issues"]
    assert [p["number"] for p in points] == ["55", "8.5"]
    assert all(p["origin"] == "typed_number" and p["status"] == "open" for p in points)
    assert points[0]["candidates"][0]["path"] == "contribution.groups.0.share_text"
    assert "It looks like Packaging, which prints “54.8 %” today." in points[0]["problem"]
    assert points[1]["candidates"] == []
    assert stored["ai_review"]["verdict"] == "open_points"


def test_anything_else_left_keeps_the_chapter_out(client, token, project, numbers):
    rep, sec, url = _chapter(client, token)
    broken = TYPED + " The total is {{results.7.score}}."
    assert _propose(client, token, url, sec, broken, keep_numbers=True)["stored"] is False


def test_the_report_cannot_be_approved_while_a_typed_number_is_open(client, token, project, numbers):
    rep, sec, url = _chapter(client, token)
    _propose(client, token, url, sec, TYPED, keep_numbers=True)
    r = client.post(f"{url}/reviewed", json={}, headers=token)
    assert r.status_code == 409 and r.json()["error"]["code"] == "report_typed_numbers_open"

    for quote in [p["quote"] for p in _stored(client, token, url, sec)["ai_review"]["issues"]]:
        r = client.post(f"{url}/sections/{sec['id']}/keep-point", json={"quote": quote, "reason": "Input data"}, headers=token)
        assert r.status_code == 200, r.text
    points = _stored(client, token, url, sec)["ai_review"]["issues"]
    assert {p["status"] for p in points} == {"kept"} and points[0]["resolution"] == "Input data"
    assert client.post(f"{url}/reviewed", json={}, headers=token).status_code == 200


def test_a_typed_number_is_replaced_by_its_candidate_and_the_rest_stays_decided(client, token, project, numbers):
    rep, sec, url = _chapter(client, token)
    _propose(client, token, url, sec, TYPED, keep_numbers=True)
    points = _stored(client, token, url, sec)["ai_review"]["issues"]
    client.post(f"{url}/sections/{sec['id']}/keep-point", json={"quote": points[1]["quote"]}, headers=token)

    r = client.post(
        f"{url}/sections/{sec['id']}/replace-number",
        json={"quote": points[0]["quote"], "path": "contribution.groups.0.share_text"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    stored = _stored(client, token, url, sec)
    assert stored["text"].startswith("Packaging carries about {{contribution.groups.0.share_text}} of the impact.")
    left = stored["ai_review"]["issues"]
    assert [(p["number"], p["status"]) for p in left] == [("8.5", "kept")]

    # Only a candidate the point offered.
    r = client.post(
        f"{url}/sections/{sec['id']}/replace-number",
        json={"quote": left[0]["quote"], "path": "results.0.score"},
        headers=token,
    )
    assert r.status_code == 404  # kept, so no longer an open point


def test_a_kept_number_is_named_again_once_the_results_move(client, token, project, numbers):
    from prism_lca.engine import report_staleness

    rep, sec, url = _chapter(client, token)
    _propose(client, token, url, sec, TYPED, keep_numbers=True)
    for p in _stored(client, token, url, sec)["ai_review"]["issues"]:
        client.post(f"{url}/sections/{sec['id']}/keep-point", json={"quote": p["quote"]}, headers=token)

    def reminders() -> list[dict]:
        report = ReportStore().get(DB, rep["id"])
        section = next(s for s in report["sections"] if s["id"] == sec["id"])
        return [f for f in report_staleness.verdicts(section, report, numbers["data"]) if f["kind"] == "kept_numbers"]

    assert reminders() == []
    numbers["data"]["results"][0]["score"] = 1.5
    found = reminders()
    assert found and found[0]["severity"] == "review" and "“55”" in found[0]["message"]


def test_a_partial_repair_is_kept_when_the_chapter_is_still_refused(client, token, project, numbers):
    """V460: the result figure is bound although the chapter is refused for another typed number —
    the writer's next attempt starts from the bound text."""
    rep, sec, url = _chapter(client, token)
    text = "The climate impact is 1.23 kg CO2-Eq. Each bottle weighs 8.5 kg in transport."
    r = client.post(f"{url}/sections/{sec['id']}/proposal", json={"text": text, "store": False}, headers=token).json()
    assert r["ok"] is False
    assert r["text"].startswith("The climate impact is {{results.0.score}} kg CO2-Eq.")
    assert [f["kind"] for f in r["findings"]].count("repaired_literal") == 1


# --------------------------------------------------------------------------- #
# Each number is its own decision, and none is lost on the way
# --------------------------------------------------------------------------- #
def test_the_same_number_in_two_sentences_is_two_decisions(client, token, project, numbers):
    rep, sec, url = _chapter(client, token)
    text = "Packaging contributes 55 % of the impact. Transport contributes 55 % as well."
    assert _propose(client, token, url, sec, text, keep_numbers=True)["typed_numbers"] == 2
    points = _stored(client, token, url, sec)["ai_review"]["issues"]
    assert [p["quote"].split()[0] for p in points] == ["Packaging", "Transport"]
    client.post(f"{url}/sections/{sec['id']}/keep-point", json={"quote": points[0]["quote"]}, headers=token)
    # Keeping the first approves nothing about the second.
    assert client.post(f"{url}/reviewed", json={}, headers=token).status_code == 409


def test_typed_numbers_are_kept_past_a_long_reading(client, token, project, numbers):
    rep, sec, url = _chapter(client, token)
    reading = {"rounds": 3, "issues": [{"quote": f"q{i}", "problem": "p", "status": "resolved"} for i in range(30)]}
    kept = _propose(client, token, url, sec, TYPED, keep_numbers=True, reviewed_by="reader-y", review=reading)
    assert kept["stored"] is True
    issues = _stored(client, token, url, sec)["ai_review"]["issues"]
    assert len([i for i in issues if i.get("origin") == "typed_number"]) == 2
    assert client.post(f"{url}/reviewed", json={}, headers=token).status_code == 409


def test_a_signed_number_is_replaced_sign_and_all(client, token, project, numbers):
    numbers["data"]["subjects"] = [{"label": "Refill", "results": [], "change_text": "-4.2 %"}]
    rep, sec, url = _chapter(client, token)
    _propose(client, token, url, sec, "The refill changes the result by -4 % only.", keep_numbers=True)
    point = _stored(client, token, url, sec)["ai_review"]["issues"][0]
    assert point["candidates"][0]["path"] == "subjects.0.change_text"
    r = client.post(
        f"{url}/sections/{sec['id']}/replace-number",
        json={"quote": point["quote"], "path": "subjects.0.change_text", "offset": point["offset"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert _stored(client, token, url, sec)["text"] == "The refill changes the result by {{subjects.0.change_text}} only."


def test_no_replacement_once_the_numbers_have_moved(client, token, project, numbers, monkeypatch):
    rep, sec, url = _chapter(client, token)
    _propose(client, token, url, sec, TYPED, keep_numbers=True)
    point = _stored(client, token, url, sec)["ai_review"]["issues"][0]
    monkeypatch.setattr(report_pipeline, "snapshot_id_for", lambda *a, **k: "moved")
    r = client.post(
        f"{url}/sections/{sec['id']}/replace-number",
        json={"quote": point["quote"], "path": "contribution.groups.0.share_text"},
        headers=token,
    )
    assert r.status_code == 409


def test_a_moved_share_reminds_and_the_author_can_confirm_again(client, token, project, numbers):
    from prism_lca.engine import report_staleness

    rep, sec, url = _chapter(client, token)
    _propose(client, token, url, sec, TYPED, keep_numbers=True)
    first = _stored(client, token, url, sec)["ai_review"]["issues"][0]
    for p in _stored(client, token, url, sec)["ai_review"]["issues"]:
        client.post(f"{url}/sections/{sec['id']}/keep-point", json={"quote": p["quote"]}, headers=token)

    def reminders() -> list[dict]:
        report = ReportStore().get(DB, rep["id"])
        section = next(s for s in report["sections"] if s["id"] == sec["id"])
        return [f for f in report_staleness.verdicts(section, report, numbers["data"]) if f["kind"] == "kept_numbers"]

    # Only the share moves; every total stays as it was.
    numbers["data"]["contribution"]["groups"][0].update(share=0.6, share_percent=60.0, share_text="60.0 %")
    assert reminders() and first["quote"] in [p["quote"] for p in reminders()[0]["points"]]
    r = client.post(
        f"{url}/sections/{sec['id']}/keep-point", json={"quote": first["quote"], "reason": "Still the EPD value"}, headers=token
    )
    assert r.status_code == 200, r.text
    assert first["quote"] not in [p["quote"] for p in reminders()[0]["points"]]


def test_the_same_sentence_twice_is_two_places(client, token, project, numbers):
    rep, sec, url = _chapter(client, token)
    text = "Packaging is 55 %. Packaging is 55 %."
    _propose(client, token, url, sec, text, keep_numbers=True)
    points = _stored(client, token, url, sec)["ai_review"]["issues"]
    assert [p["occurrence"] for p in points] == [0, 1]
    second = {"quote": points[1]["quote"], "offset": points[1]["offset"], "occurrence": 1}
    r = client.post(
        f"{url}/sections/{sec['id']}/replace-number",
        json={**second, "path": "contribution.groups.0.share_text"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert _stored(client, token, url, sec)["text"] == "Packaging is 55 %. Packaging is {{contribution.groups.0.share_text}}."
    # The first is still its own open decision.
    left = _stored(client, token, url, sec)["ai_review"]["issues"]
    assert [(p["occurrence"], p["status"]) for p in left] == [(0, "open")]
