"""V179: a suspicion the author can put down, and the two cases where they may not.

A test run hit a chapter the software could not finish. A parameter
change moved two incineration datasets from rank 3 and 5 to rank 6 and 10, and the rank check said
what it always says — "“the largest” *may* no longer be true". The sentence in question names both
datasets, prints their shares through pinned placeholders and contains no superlative at all, so it
was simply true. The correction model said so and refused to invent an edit; the only offers left
were a paid rewrite of a correct chapter or a report that stays yellow forever.

What was missing is a way for a person to answer a "may". These tests hold that answer to three
rules: it re-stamps and changes nothing else, it comes back the next time the numbers move (so it is
an answer to *this* drift, not a permanent gag), and it is refused where the finding is no longer a
suspicion — a frozen chapter, or a placeholder that will print “[missing: …]” into the PDF.

The data is faked at the snapshot boundary on purpose: what is under test is the verdict-and-record
arithmetic, and computing an LCIA whose ranking flips would test bw2calc instead.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import report_pipeline
from prism_lca.engine.report_store import ReportStore

DB = "pr"

#: The chapter's own sentence: two datasets named in the prose, their shares pinned to them. No
#: superlative anywhere — which is the whole reason the rank finding has no correction to propose.
TEXT = (
    "The incineration datasets (treatment of waste PET, municipal incineration and treatment of "
    "waste PP, municipal incineration) contribute {{hotspots.2.share_text}} and "
    "{{hotspots.4.share_text}} respectively."
)

_PINNED = [
    ("treatment of waste PET, municipal incineration", "pet", 8.4),
    ("treatment of waste PP, municipal incineration", "pp", 6.1),
]


def _hotspot(name: str, code: str, share: float) -> dict:
    return {
        "name": name,
        "database": DB,
        "code": code,
        "share_percent": share,
        "share_text": f"{share} %",
    }


def _filler(count: int, share: float, tag: str) -> list[dict]:
    return [_hotspot(f"{tag} process {i}", f"{tag}{i}", share) for i in range(count)]


def _data(above: int = 0, drop_last: bool = False) -> dict:
    """The snapshot, with `above` extra processes pushed in front of the pinned pair.

    Only the *order* moves: both pinned datasets keep the share the sentence prints, so the values
    hash is untouched and the rank finding is the only thing the check can be reacting to.
    """
    hotspots = [
        *_filler(above, 20.0, "big"),
        _hotspot("cardboard box production", "box", 12.0),
        _hotspot("electricity, medium voltage", "elec", 9.9),
        _hotspot(*_PINNED[0]),
        _hotspot("transport, lorry", "lorry", 7.2),
        _hotspot(*_PINNED[1]),
        _hotspot("tap water production", "water", 4.0),
    ]
    if drop_last:
        hotspots = hotspots[:-1]
    return {
        "study": {"functional_unit": "1 kg"},
        "results": [{"method_label": "t / gwp", "score": 1.0, "unit": "kg CO2-Eq"}],
        "hotspots": hotspots,
    }


@pytest.fixture
def snapshot(monkeypatch):
    """The numbers under the report, swappable from the test.

    Patched in both modules because both hold their own reference to the helper: `report` stamps the
    record when text is stored, `report_ai` reads it back when it judges — one seam since 3.2.
    """
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
        f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": "contribution"}, headers=token
    ).json()
    # Through the ordinary section update, so the chapter gets exactly the record and the pins a
    # stored chapter has.
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "contribution", "text": text},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return rep, sec


def _staleness(client, token, rep) -> dict:
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/staleness", json={}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["chapters"][0]


def _stored(client, token, rep, sec) -> dict:
    report = client.get(f"/api/v1/report/one/{DB}/{rep['id']}", headers=token).json()
    return next(s for s in report["sections"] if s["id"] == sec["id"])


def test_a_rank_finding_can_be_answered_without_a_model_and_without_a_word_changing(
    client, token, project, snapshot
):
    rep, sec = _written_chapter(client, token)
    before = _stored(client, token, rep, sec)
    assert _staleness(client, token, rep)["remedy"] == "none"

    # Three larger processes appear: the pinned pair slides from rank 3 and 5 to rank 6 and 8.
    snapshot["data"] = _data(above=3)
    chapter = _staleness(client, token, rep)
    assert chapter["remedy"] == "review", chapter
    assert {f["kind"] for f in chapter["findings"]} == {"ranks"}

    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] is True

    assert _staleness(client, token, rep)["remedy"] == "none"
    after = _stored(client, token, rep, sec)
    # The author's judgement is about the record, not about the chapter: everything that says what
    # the chapter *is* has to come through untouched — including the pins, or the sentence would
    # start printing the shares of whatever now sits at position two.
    assert after["text"] == before["text"]
    assert after["source"] == before["source"]
    assert after["bindings"] == before["bindings"]
    assert after.get("reviewed") == before.get("reviewed")


def test_accepting_answers_this_drift_and_not_the_next_one(client, token, project, snapshot):
    """The point of the button is a judgement about one sentence, not a permanent silence."""
    rep, sec = _written_chapter(client, token)
    snapshot["data"] = _data(above=3)
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert _staleness(client, token, rep)["remedy"] == "none"

    snapshot["data"] = _data(above=6)
    chapter = _staleness(client, token, rep)
    assert chapter["remedy"] == "review", chapter
    # …and it reports the move from where the author left it, not from where the chapter was written.
    assert any("was rank 6 and is now rank 9" in f["message"] for f in chapter["findings"]), chapter


def test_a_chapter_with_nothing_to_answer_is_left_alone_rather_than_scolded(
    client, token, project, snapshot
):
    """The check may have caught up between the click and the request — that is not an error."""
    rep, sec = _written_chapter(client, token)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"accepted": False, "stored": False, "remedy": "none", "findings": []}


def test_a_hole_in_the_deliverable_cannot_be_accepted(client, token, project, snapshot):
    """A vanished member is not a suspicion: the PDF will print “[missing: …]” where the figure was."""
    text = TEXT + " Tap water contributes {{hotspots.5.share_text}}."
    rep, sec = _written_chapter(client, token, text)
    snapshot["data"] = _data(above=3, drop_last=True)
    assert _staleness(client, token, rep)["remedy"] == "rewrite"

    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "report_accept_refused"
    # And the finding is still there — a refused request must not have half-stamped anything.
    assert _staleness(client, token, rep)["remedy"] == "rewrite"


def test_a_frozen_chapter_is_refused_like_every_other_write(client, token, project, snapshot):
    rep, sec = _written_chapter(client, token)
    snapshot["data"] = _data(above=3)
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "contribution", "locked": True},
        headers=token,
    )
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "report_section_locked"


#: A dataset the prose names in quotation marks and the results do not contain. The gate reads names,
#: the rank and band checks read placeholders and pins — so this sentence is invisible to the verdict
#: and plain to the store, which is exactly the split V190 fell through.
VANISHED = (
    " The oil input is modelled with “rape seed production, Swiss integrated production, extensive”."
)


def test_a_chapter_the_store_would_refuse_cannot_be_stamped_green(client, token, project, snapshot):
    """V190: the verdict says "check the wording", the gate says "this text cannot be stored".

    Measured on a real run: the inventory chapter named two rape-seed datasets a
    parameter change had removed from the results. They stand in prose, not in a placeholder, so the
    rank check never saw them and graded the chapter `review` over a band finding elsewhere — and the
    row therefore offered "Accept as it is", which stored `accepted: true` and left two invented
    dataset names on their way into a client PDF. The author is the authority on what their sentence
    claims, not on which datasets exist.
    """
    rep, sec = _written_chapter(client, token, TEXT + VANISHED)
    # A rank move, so the verdict is `review` and nothing stronger — the chapter arrives at the
    # button exactly as it did in the measured run.
    snapshot["data"] = _data(above=3)
    chapter = _staleness(client, token, rep)
    assert chapter["remedy"] == "review", chapter
    # Additive: the panel's own vocabulary plus the store's refusal, so the row can withhold the
    # button without a second request.
    gate = [f for f in chapter["findings"] if f["kind"] == "gate"]
    assert len(gate) == 1, chapter
    assert "rape seed production" in gate[0]["message"], gate

    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 400, r.text
    body = r.json()["error"]
    assert body["code"] == "report_accept_refused"
    # The reason, in the gate's own words: without the name the author has to guess which sentence.
    assert "cannot be stored as it stands" in body["message"], body
    assert "rape seed production, Swiss integrated production, extensive" in body["message"], body
    # And nothing was half-stamped: the finding is still there for the next read.
    assert _staleness(client, token, rep)["remedy"] == "review"
    assert any(f["kind"] == "gate" for f in _staleness(client, token, rep)["findings"])


def test_a_correctable_refusal_still_leaves_the_chapter_correctable(client, token, project, snapshot):
    """The guard is about *accepting*, not about the correction loop V184 built.

    The vanished name stands in a sentence, so the patch brief can hand it over and one rephrasing can
    genuinely put the chapter right. Turning this into a `rewrite` verdict would take the cheap repair
    away from the case it was built for, so the verdict stays `review` — only the free button goes.
    """
    rep, _sec = _written_chapter(client, token, TEXT + VANISHED)
    snapshot["data"] = _data(above=3)
    chapter = _staleness(client, token, rep)
    assert chapter["remedy"] == "review", chapter
    assert [f["severity"] for f in chapter["findings"] if f["kind"] == "gate"] == ["review"], chapter


def test_the_case_the_button_exists_for_is_untouched(client, token, project, snapshot):
    """The guard must be as narrow as the hole it closes.

    Same chapter, same rank move, no sentence the gate objects to: two named datasets that are still
    in the results and a sentence with no superlative in it. This is the V179 case the button was
    built for, and it has to stay free and available — a guard that also swallowed this one would put
    the report back to "yellow for good".
    """
    rep, sec = _written_chapter(client, token)
    snapshot["data"] = _data(above=3)
    chapter = _staleness(client, token, rep)
    assert chapter["remedy"] == "review", chapter
    assert not [f for f in chapter["findings"] if f["kind"] == "gate"], chapter

    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] is True
    assert _staleness(client, token, rep)["remedy"] == "none"


# --- V192: a refusal has to say which chapter it is about ----------------------------------------


def test_a_refusal_names_an_unnamed_chapter_the_way_the_document_does(client, token, project, snapshot):
    """Measured: all three refusals read "Section '' is frozen".

    The chapter's `title` is empty until somebody renames it — the normal case, not the exception — and
    the frontend shows `message` unchanged, so the author was told a chapter was frozen without being
    told which. The name now falls back to the standard heading of its kind, which is also what the
    reader finds above the chapter in the PDF.
    """
    rep, sec = _written_chapter(client, token, TEXT + VANISHED)
    stored = _stored(client, token, rep, sec)
    assert stored["title"] == "", stored  # the state the report is actually in

    # 1. frozen, on the accept path.
    snapshot["data"] = _data(above=3)
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "contribution", "locked": True},
        headers=token,
    )
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["message"] == (
        "Section 'Contribution analysis' is locked — unlock it first."
    )

    # 2. frozen, on the correction path — same chapter, same words.
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/patch",
        json={"edits": [{"find": "oil input", "replace": "oil", "why": "shorter"}], "store": True},
        headers=token,
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["message"] == (
        "Section 'Contribution analysis' is locked — unlock it first."
    )

    # 3. the gate's refusal, which carries the gate's own sentence after the name.
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "contribution", "locked": False},
        headers=token,
    )
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["message"].startswith("Section 'Contribution analysis' "), r.text


def test_a_rewrite_refusal_names_the_chapter_too(client, token, project, snapshot):
    """The fourth message, on the path where a placeholder would print “[missing: …]”."""
    text = TEXT + " Tap water contributes {{hotspots.5.share_text}}."
    rep, sec = _written_chapter(client, token, text)
    snapshot["data"] = _data(above=3, drop_last=True)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["message"] == (
        "Section 'Contribution analysis' asserts something that is no longer true."
    )


def test_a_renamed_chapter_is_refused_under_the_name_its_author_gave_it(
    client, token, project, snapshot
):
    """A stored title wins over the standard heading — the author's own word for the chapter is the one
    they will recognise, and it is what the document prints as well."""
    rep, sec = _written_chapter(client, token)
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}",
        json={"kind": "contribution", "title": "Where it comes from", "locked": True},
        headers=token,
    )
    snapshot["data"] = _data(above=3)
    r = client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["message"] == (
        "Section 'Where it comes from' is locked — unlock it first."
    )
