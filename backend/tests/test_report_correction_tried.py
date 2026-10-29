"""V217: the correction round's answer is kept, and it expires with the report it was about.

Observed repeatedly in live use. A chapter claims a top rank in words, so the
freshness check grades it `review` (V206) — correctly, because one replacement could put such a
sentence right. The author presses "Correct all" and the model answers "0 replacements. Nothing here
can be corrected by rephrasing — the passage needs author rewriting or removal." They then open
"Write all chapters", and for the same chapter the plan says "Check the wording — left alone on
purpose. A rewrite is the wrong tool here; the cheap answer is *Correct…* on that row." The two
halves of the product send the author back and forth over an answer that already exists.

So the round's verdict is stored, and these tests hold it to the rules that make it safe to store:

* it is kept only where the model actually refused a passage and said why — an account-level failure
  or an unparsable answer is not a judgement about the chapter;
* it never outlives the state it was formed against: the text it read, and the numbers it read them
  against (`report_staleness.components`, the same record `based_on` is made of);
* a hand edit, a rewrite and `Accept as it is` each retire it, because each of them is an answer to
  the question the round was asked;
* it is not a second opinion about staleness — the remedy the check reports is untouched by it.

The data is faked at the snapshot boundary, as in `test_report_accept`: what is under test is the
bookkeeping, not bw2calc.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import report_pipeline
from prism_lca.engine.report_store import ReportStore

DB = "pr"

#: A sentence with a pinned share in it, so the record has both a value and a rank to move.
TEXT = (
    "Packaging remains the dominant contributor. It accounts for "
    "{{contribution.groups.0.share_percent}} % of the total."
)

#: What the model came back with: one passage, refused, with its own explanation.
REFUSED = [
    {
        "span": "Packaging remains the dominant contributor.",
        "why": "The sentence asserts a stable dominant position for Packaging, but Packaging is no "
        "longer the leading group and no placeholder in the sentence can supply the current "
        "leader; the passage needs author rewriting or removal.",
    }
]


def _groups(packaging: float, energy: float) -> list[dict]:
    return [
        {"key": "Packaging", "share_percent": packaging, "share_text": f"{packaging} %"},
        {"key": "Energy", "share_percent": energy, "share_text": f"{energy} %"},
    ]


def _data(packaging: float = 60.2, energy: float = 21.0) -> dict:
    return {
        "study": {"functional_unit": "1 kg"},
        "results": [{"method_label": "t / gwp", "score": 1.0, "unit": "kg CO2-Eq"}],
        "contribution": {"groups": _groups(packaging, energy)},
    }


@pytest.fixture
def snapshot(monkeypatch):
    """The numbers under the report, swappable from the test — patched in both modules, like the
    accept tests — one patch: every endpoint reads it through
    `report_pipeline.analysis_snapshot`."""
    state = {"data": _data()}

    def fake(database, report_id, body):  # noqa: ARG001
        return ReportStore().get(database, report_id), state["data"]

    # One seam: every judging endpoint reaches the snapshot through
    # `report_pipeline.analysis_snapshot`, so one patch covers them all.
    monkeypatch.setattr(report_pipeline, "analysis_snapshot", fake)
    return state


def _written_chapter(client, token, text: str = TEXT) -> tuple[dict, dict]:
    rep = client.post(
        "/api/v1/report/create",
        json={"database": DB, "lang": "en", "subjects": [{"database": DB, "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "prose", "text": text},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return rep, sec


def _chapter(client, token, rep) -> dict:
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/staleness", json={}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["chapters"][0]


def _try_correcting(client, token, rep, sec, *, spans: int = 1, refused: list | None = None) -> dict:
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/correction-tried",
        json={"spans": spans, "refused": REFUSED if refused is None else refused, "model": "m"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_a_round_that_came_back_empty_is_remembered_with_the_model_s_own_words(
    client, token, project, snapshot
):
    rep, sec = _written_chapter(client, token)
    out = _try_correcting(client, token, rep, sec)
    assert out["stored"] is True
    assert out["correction_tried"]["refused"] == REFUSED
    # The bookkeeping the expiry rule needs stays out of the answer: what a plan row shows is when the
    # round ran, how much of the chapter it refused, and why.
    assert set(out["correction_tried"]) == {"at", "model", "spans", "refused"}

    chapter = _chapter(client, token, rep)
    assert chapter["correction_tried"]["refused"][0]["why"] == REFUSED[0]["why"]
    assert chapter["correction_tried"]["spans"] == 1


def test_the_marker_does_not_change_what_the_freshness_check_says(client, token, project, snapshot):
    """The one thing it must never become: a second opinion about whether the chapter is stale."""
    rep, sec = _written_chapter(client, token)
    before = _chapter(client, token, rep)
    _try_correcting(client, token, rep, sec)
    after = _chapter(client, token, rep)
    assert after["remedy"] == before["remedy"] == "none"
    assert after["findings"] == before["findings"]


def test_a_round_without_a_reason_is_not_a_verdict_about_the_chapter(client, token, project, snapshot):
    """An unparsable answer, a truncated stream, or a call that never ran because the account is out
    of credits. None of those says anything about the chapter, and each of them arrives here — if a
    caller sends it at all — as an empty refusal list."""
    rep, sec = _written_chapter(client, token)
    for refused in ([], [{"span": "Packaging remains the dominant contributor."}], [{"why": "   "}]):
        out = _try_correcting(client, token, rep, sec, refused=refused)
        assert out == {"stored": False, "correction_tried": None}, refused
        assert _chapter(client, token, rep)["correction_tried"] is None


def test_a_partly_refused_round_says_so_rather_than_condemning_the_chapter(
    client, token, project, snapshot
):
    """A round is handed one passage per finding. Refusing one of three is not "nothing here can be
    corrected", and the record has to carry the denominator or the plan row would claim it."""
    rep, sec = _written_chapter(client, token)
    out = _try_correcting(client, token, rep, sec, spans=3)
    assert out["correction_tried"]["spans"] == 3
    assert len(out["correction_tried"]["refused"]) == 1
    # And never fewer than what came back: a caller that forgets the count must not turn "one of
    # three" into "none of none".
    assert _try_correcting(client, token, rep, sec, spans=0)["correction_tried"]["spans"] == 1


def test_the_numbers_moving_retires_the_verdict(client, token, project, snapshot):
    """It was an opinion about *these* numbers. Once they move it is about a report that is gone."""
    rep, sec = _written_chapter(client, token)
    _try_correcting(client, token, rep, sec)
    assert _chapter(client, token, rep)["correction_tried"] is not None

    snapshot["data"] = _data(packaging=18.0, energy=52.0)
    chapter = _chapter(client, token, rep)
    assert chapter["remedy"] == "review", chapter  # the check still has its say
    assert chapter["correction_tried"] is None


def test_editing_the_chapter_by_hand_retires_the_verdict(client, token, project, snapshot):
    """The author may have removed the offending sentence themselves."""
    rep, sec = _written_chapter(client, token)
    _try_correcting(client, token, rep, sec)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "prose", "text": "Packaging accounts for {{contribution.groups.0.share_percent}} %."},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert "correction_tried" not in r.json()
    assert _chapter(client, token, rep)["correction_tried"] is None


def test_a_rewrite_retires_the_verdict(client, token, project, snapshot):
    """A rewrite brings its own record, so it slips past the "text without based_on" rule — and it is
    the very operation the plan now offers on the strength of the marker."""
    rep, sec = _written_chapter(client, token)
    _try_correcting(client, token, rep, sec)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/proposal",
        json={
            "text": "Energy is the leading group at {{contribution.groups.1.share_percent}} %.",
            "store": True,
            "model": "m",
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["stored"] is True, r.text
    assert _chapter(client, token, rep)["correction_tried"] is None


def test_accepting_the_wording_retires_the_verdict(client, token, project, snapshot):
    """"Read it, the sentence makes no such claim" answers the question the round was asked."""
    rep, sec = _written_chapter(client, token)
    snapshot["data"] = _data(packaging=18.0, energy=52.0)
    assert _chapter(client, token, rep)["remedy"] == "review"
    _try_correcting(client, token, rep, sec)
    assert _chapter(client, token, rep)["correction_tried"] is not None

    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] is True
    chapter = _chapter(client, token, rep)
    assert chapter["remedy"] == "none"
    assert chapter["correction_tried"] is None
