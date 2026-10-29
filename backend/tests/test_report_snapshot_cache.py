"""One data snapshot per model state, shared by the endpoints that only judge text.

Writing a chapter asks three times for the same numbers (brief, the writer's own gate check, the
storing check). What matters here is not that a cache exists but exactly *when* it is allowed to
answer: never after a model change, never for a document, and — the case the whole key is built
around — always while a parallel run stores one chapter after another.
"""
from __future__ import annotations

import time

import pytest

from prism_lca.engine import lca, report_pipeline, report_render, report_snapshot


@pytest.fixture(autouse=True)
def _clean_cache():
    report_snapshot.invalidate()
    yield
    report_snapshot.invalidate()


@pytest.fixture
def renders(monkeypatch):
    """Count how often the data is actually computed."""
    calls: list[int] = []
    real = report_render.render_sources

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(report_render, "render_sources", counting)
    return calls


def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("pr").write(
        {
            ("pr", "a"): {
                "name": "widget", "unit": "unit", "reference product": "widget", "location": "GLO",
                "exchanges": [
                    {"input": ("pr", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])
    bd.Method(("t", "ap")).write([(("biosphere", "co2"), 0.5)])


def _make(client, token):
    return client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "en", "methods": [["t", "gwp"]],
              "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()


def _prose(client, token, rep):
    return client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections", json={"kind": "prose"}, headers=token
    ).json()


@pytest.fixture
def report(client, token, project):
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    return _make(client, token)


def test_the_same_numbers_are_computed_once(client, token, report, renders):
    base = f"/api/v1/report/one/pr/{report['id']}"
    sec = _prose(client, token, report)
    renders.clear()
    client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token)
    client.post(f"{base}/staleness", json={}, headers=token)
    client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token)
    assert len(renders) == 1


def test_staleness_with_nothing_written_computes_nothing(client, token, report, renders):
    """A brand-new report has nothing to compare, so the check must not pay for a snapshot —
    on a real model that was ~7 cold minutes inside the "Write all" dialog, spent computing
    an empty answer (V121)."""
    base = f"/api/v1/report/one/pr/{report['id']}"
    _prose(client, token, report)  # a chapter exists, but nothing is written yet
    renders.clear()
    r = client.post(f"{base}/staleness", json={}, headers=token)
    assert r.json() == {"chapters": []}
    assert renders == []


def test_per_chapter_staleness_shares_one_snapshot(client, token, report, renders):
    """The dialog asks per chapter so it can show real progress; N small calls must cost what one
    big one did — the snapshot is shared — and each answer carries only the chapter it was asked
    about."""
    base = f"/api/v1/report/one/pr/{report['id']}"
    first, second = _prose(client, token, report), _prose(client, token, report)
    for sec in (first, second):
        client.post(
            f"{base}/sections/{sec['id']}/proposal",
            json={"text": "The score is {{results.0.score}}.", "store": True},
            headers=token,
        )
    renders.clear()
    one = client.post(f"{base}/staleness", json={"section_ids": [first["id"]]}, headers=token).json()
    two = client.post(f"{base}/staleness", json={"section_ids": [second["id"]]}, headers=token).json()
    assert [c["section_id"] for c in one["chapters"]] == [first["id"]]
    assert [c["section_id"] for c in two["chapters"]] == [second["id"]]
    # At most one build for both calls — zero when the storing checks left the snapshot warm.
    assert len(renders) <= 1
    # Asking only for chapters without text answers empty without computing anything new.
    blank = _prose(client, token, report)
    renders.clear()
    r = client.post(f"{base}/staleness", json={"section_ids": [blank["id"]]}, headers=token).json()
    assert r == {"chapters": []} and renders == []


def test_storing_a_chapter_does_not_throw_the_snapshot_away(client, token, report, renders):
    """The case the key is designed for: with the report itself in the key, a four-lane "write all"
    would invalidate the snapshot on every save — which is the entire run."""
    base = f"/api/v1/report/one/pr/{report['id']}"
    first, second = _prose(client, token, report), _prose(client, token, report)
    renders.clear()
    for sec in (first, second):
        r = client.post(
            f"{base}/sections/{sec['id']}/proposal",
            json={"text": "The result is {{results.0.score}} {{results.0.unit}}.", "store": True},
            headers=token,
        )
        assert r.json()["stored"], r.json()
    assert len(renders) == 1


def test_a_scenario_bearing_report_still_hits_the_snapshot_cache(client, token, report, renders):
    """THE practice case (V131): building a snapshot for a report that compares scenarios applies
    and restores parameter overrides — a reversible window. Keying the cache on the raw
    factorisation generation made that window a permanent self-invalidation: no snapshot of a
    scenario-bearing report could ever be reused, and every brief, gate and staleness check paid
    the full recompute. The model generation must not move, and the second call must hit."""
    from prism_lca.engine import lca as lca_mod

    client.post("/api/v1/params", json={"database": "pr", "name": "mass", "amount": 2.0}, headers=token)
    client.post(
        "/api/v1/scenarios",
        json={"database": "pr", "name": "Heavier", "overrides": {"mass": 3.0}},
        headers=token,
    )
    sc = client.get("/api/v1/scenarios", params={"database": "pr"}, headers=token).json()[0]
    base = f"/api/v1/report/one/pr/{report['id']}"
    client.post(
        base,
        json={"subjects": [
            {"database": "pr", "code": "a", "label": "Baseline"},
            {"database": "pr", "code": "a", "scenario": sc["id"], "label": "Heavier"},
        ]},
        headers=token,
    )
    sec = _prose(client, token, report)
    client.post(
        f"{base}/sections/{sec['id']}/proposal",
        json={"text": "The score is {{results.0.score}}.", "store": True},
        headers=token,
    )
    renders.clear()
    before = lca_mod.model_generation()
    client.post(f"{base}/staleness", json={}, headers=token)
    assert lca_mod.model_generation() == before  # the reversible window moved no model state
    client.post(f"{base}/staleness", json={}, headers=token)
    client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token)
    assert len(renders) <= 1  # one build at most — the scenario window no longer poisons the key


def test_a_report_build_enters_each_scenario_state_exactly_once(client, token, project, monkeypatch):
    """V138: applying a scenario drops the factorised matrix, so every extra apply→restore pair is
    a re-factorisation. Grouped by parameter state, a build with two scenario variants and a
    contribution breakdown writes parameters exactly four times (apply + restore per scenario) —
    the old per-indicator × per-variant windows wrote them dozens of times for the same states."""
    from prism_lca.engine import scenarios as scenarios_mod
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    # Two nodes, two locations: enough tree for a geo breakdown, which a one-node model is not.
    bd.Database("gr").write(
        {
            ("gr", "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity",
                "location": "DE",
                "exchanges": [
                    {"input": ("gr", "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("gr", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle", "location": "GLO",
                "exchanges": [
                    {"input": ("gr", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("gr", "elec"), "amount": 2, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])
    bd.Method(("t", "ap")).write([(("biosphere", "co2"), 0.5)])

    client.post("/api/v1/params", json={"database": "gr", "name": "mass", "amount": 2.0}, headers=token)
    for name, value in (("S1", 3.0), ("S2", 4.0)):
        client.post(
            "/api/v1/scenarios",
            json={"database": "gr", "name": name, "overrides": {"mass": value}},
            headers=token,
        )
    by_name = {s["name"]: s for s in client.get("/api/v1/scenarios", params={"database": "gr"}, headers=token).json()}
    rep = client.post(
        "/api/v1/report/create",
        json={
            "database": "gr", "lang": "en",
            "methods": [["t", "gwp"], ["t", "ap"]],
            "aggregate_by": "geo",
            "subjects": [
                {"database": "gr", "code": "bottle", "label": "Baseline"},
                {"database": "gr", "code": "bottle", "scenario": by_name["S1"]["id"], "label": "S1"},
                {"database": "gr", "code": "bottle", "scenario": by_name["S2"]["id"], "label": "S2"},
            ],
        },
        headers=token,
    ).json()
    writes: list[int] = []
    real = scenarios_mod.params.apply_values

    def counting(db, values, formulas=None):
        writes.append(1)
        return real(db, values, formulas)

    monkeypatch.setattr(scenarios_mod.params, "apply_values", counting)
    traversed: list[int] = []
    real_contribution = report_pipeline.lca.contribution

    def counting_contribution(*args, **kwargs):
        traversed.append(1)
        return real_contribution(*args, **kwargs)

    monkeypatch.setattr(report_pipeline.lca, "contribution", counting_contribution)
    r = client.post(f"/api/v1/report/one/gr/{rep['id']}/sources", json={}, headers=token)
    assert r.status_code == 200, r.text
    assert len(writes) == 4  # S1 apply+restore, S2 apply+restore — the baseline needs none
    # Three states × two indicators, each breakdown once: the baseline reference is matched to its own
    # variant across the scenario windows, not to S1's or S2's, and not traversed a second time.
    assert len(traversed) == 6
    # …and the numbers per variant are the scenario's own, not a leftover state's.
    data = r.json()["data"]
    assert len(data["subjects"]) == 3
    assert len({s["label"] for s in data["subjects"]}) == 3


def test_a_second_document_reuses_the_inputs_and_a_theme_switch_stays_cheap(
    client, token, report, monkeypatch
):
    """The document endpoints memoise their expensive inputs (V136): when the model generation and
    every data-bearing field are unchanged, the numbers provably cannot differ — so a repeated
    /sources, and above all a palette or TEMPLATE switch in between, must not re-pay the study.
    A real data change (another indicator) must."""
    from prism_lca.engine import lca as lca_mod

    computes: list[int] = []
    real = lca_mod.compute_multi

    def counting(*args, **kwargs):
        computes.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(lca_mod, "compute_multi", counting)

    base = f"/api/v1/report/one/pr/{report['id']}"
    assert client.post(f"{base}/sources", json={}, headers=token).status_code == 200
    first = len(computes)
    assert first > 0

    # A theme switch between two renders: definition-side, so the memo must hold — and the fresh
    # render must carry the NEW template, not the minted one.
    templates = client.get("/api/v1/report/templates", headers=token).json()["templates"]
    other = next(t["name"] for t in templates if t["name"] != report.get("template"))
    client.post(base, json={"template": other}, headers=token)
    r = client.post(f"{base}/sources", json={}, headers=token)
    assert r.status_code == 200
    assert len(computes) == first  # nothing recomputed

    # A data-bearing change (an added indicator) breaks the fingerprint and recomputes.
    client.post(base, json={"methods": [["t", "gwp"], ["t", "ap"]]}, headers=token)
    client.post(f"{base}/sources", json={}, headers=token)
    assert len(computes) > first


def test_a_stored_chapter_is_visible_to_the_next_caller(client, token, report):
    """The definition is never served from the cache — only the numbers are."""
    base = f"/api/v1/report/one/pr/{report['id']}"
    sec = _prose(client, token, report)
    client.post(
        f"{base}/sections/{sec['id']}/proposal",
        json={"text": "The result is {{results.0.score}} {{results.0.unit}}.", "store": True},
        headers=token,
    )
    stale = client.post(f"{base}/staleness", json={}, headers=token).json()
    assert [c["section_id"] for c in stale["chapters"]] == [sec["id"]]


def test_a_model_change_invalidates_it(client, token, report, renders):
    base = f"/api/v1/report/one/pr/{report['id']}"
    sec = _prose(client, token, report)
    renders.clear()
    client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token)
    # Whatever moved the model — an edited exchange, a recalculated parameter, an import — ends here.
    lca.invalidate_lca_cache()
    client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token)
    assert len(renders) == 2


def test_changing_the_indicators_invalidates_it(client, token, report, renders):
    base = f"/api/v1/report/one/pr/{report['id']}"
    sec = _prose(client, token, report)
    renders.clear()
    client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token)
    client.post(base, json={"methods": [["t", "gwp"], ["t", "ap"]]}, headers=token)
    r = client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token).json()
    assert len(renders) == 2
    # …and the brief really carries the second indicator, not the cached one.
    assert "ap" in str(r)


def test_a_document_is_never_served_from_the_cache(client, token, report, renders):
    """What a deliverable says has to be computed for that deliverable — its "generated" stamp is the
    moment it was made, not the moment a chapter was checked."""
    base = f"/api/v1/report/one/pr/{report['id']}"
    sec = _prose(client, token, report)
    renders.clear()
    client.post(f"{base}/sections/{sec['id']}/brief", json={}, headers=token)
    client.post(f"{base}/sources", json={}, headers=token)
    client.post(f"{base}/sources", json={}, headers=token)
    assert len(renders) == 3


# --- warming it before anybody waits (V214) -----------------------------------------------------


def _written(client, token, rep):
    """A report with one chapter that quotes a number — the state the freshness check works on."""
    sec = _prose(client, token, rep)
    client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/proposal",
        json={"text": "The score is {{results.0.score}}.", "store": True},
        headers=token,
    )
    return sec


def test_a_warm_up_leaves_the_check_warm(client, token, report, renders):
    """The point of the whole exercise: after a model change the check is cold and costs a complete
    study (72 s on a 3-variant report, V214). A warm-up must fill the key the check will actually
    ask for — not one of its own — so that check is a lookup."""
    base = f"/api/v1/report/one/pr/{report['id']}"
    _written(client, token, report)
    client.post(f"{base}/staleness", json={}, headers=token)  # the report is now one somebody reads
    lca.invalidate_lca_cache()  # …and a parameter recalculation has just made it cold
    renders.clear()

    assert report_pipeline._warm_snapshot("pr", report["id"], lca.model_generation(), delay=0)
    assert len(renders) == 1  # the warm-up paid for the study

    r = client.post(f"{base}/staleness", json={}, headers=token)
    assert r.status_code == 200 and len(r.json()["chapters"]) == 1
    assert len(renders) == 1  # …and the check that follows pays for nothing


def test_a_recalculation_schedules_the_warm_up_for_what_went_cold(client, token, report, monkeypatch):
    """Where the warm-up comes from: the recalculation that invalidated the snapshot, for the
    generation it produced — and only for reports somebody has actually opened."""
    scheduled: list[tuple] = []
    monkeypatch.setattr(
        report_pipeline, "_warm_snapshot", lambda db, rid, gen, **kw: scheduled.append((db, rid, gen))
    )
    base = f"/api/v1/report/one/pr/{report['id']}"
    _written(client, token, report)
    client.post(f"{base}/staleness", json={}, headers=token)

    r = client.post("/api/v1/params/recalculate?database=pr", headers=token)
    assert r.status_code == 200, r.text
    # The thread is started, not awaited — the recalculation must not become slower for it.
    for _ in range(200):
        if scheduled:
            break
        time.sleep(0.01)
    assert scheduled == [("pr", report["id"], lca.model_generation())]


def test_nothing_is_warmed_for_a_model_nobody_has_a_report_open_for(client, token, report):
    """A project holds dozens of reports and a recalculation invalidates all of them; computing a
    study for each would be fifty unasked-for studies. Only what was already asked for is warmed."""
    other = client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "en", "methods": [["t", "gwp"]],
              "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()
    assert report_pipeline.warm_snapshots("pr") == []  # no report of pr has been computed yet
    assert report_pipeline.warm_snapshots("no-such-model") == []

    base = f"/api/v1/report/one/pr/{report['id']}"
    _written(client, token, report)
    client.post(f"{base}/staleness", json={}, headers=token)
    # The one that was read is warmed; the one that exists but was never opened is not.
    assert report_pipeline.warm_snapshots("pr") == [report["id"]]
    assert other["id"] not in report_pipeline.warm_snapshots("pr")


def test_two_warm_ups_of_the_same_state_compute_once(client, token, report, renders):
    """Two triggers can overlap (a formula edit recalculates per field). They share the build lock
    every other caller uses, so the second waits and finds the answer rather than paying again."""
    import threading

    base = f"/api/v1/report/one/pr/{report['id']}"
    _written(client, token, report)
    client.post(f"{base}/staleness", json={}, headers=token)
    lca.invalidate_lca_cache()
    renders.clear()

    gen = lca.model_generation()
    threads = [
        threading.Thread(target=report_pipeline._warm_snapshot, args=("pr", report["id"], gen), kwargs={"delay": 0})
        for _ in range(2)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert len(renders) == 1


def test_an_overtaken_warm_up_gives_up_instead_of_solving(client, token, report, renders):
    """A warm-up whose model state is already gone must not spend a study on it — it would also hold
    the LCA lock against the caller who is actually waiting for the current numbers."""
    base = f"/api/v1/report/one/pr/{report['id']}"
    _written(client, token, report)
    client.post(f"{base}/staleness", json={}, headers=token)
    lca.invalidate_lca_cache()
    renders.clear()
    stale_generation = lca.model_generation() - 1
    assert report_pipeline._warm_snapshot("pr", report["id"], stale_generation, delay=0) is False
    assert renders == []


def test_a_failed_warm_up_is_silent_but_does_not_swallow_the_reason(client, token, report, monkeypatch):
    """V200's mistake, in the other direction: a warm-up may not report anything to the author (they
    did not ask for it), and it may not cache anything either — the next real caller has to compute
    and hand over the sentence that says what is wrong with this model."""
    from prism_lca.errors import PrismError

    base = f"/api/v1/report/one/pr/{report['id']}"
    _written(client, token, report)
    client.post(f"{base}/staleness", json={}, headers=token)
    lca.invalidate_lca_cache()

    def boom(*args, **kwargs):
        raise PrismError("The scenario could not be undone.", code="scenario_restore_failed")

    monkeypatch.setattr(report_render, "render_sources", boom)
    cached = dict(report_snapshot._snapshots)  # the pre-change snapshot, which the new key cannot reach
    assert report_pipeline._warm_snapshot("pr", report["id"], lca.model_generation(), delay=0) is False
    assert report_snapshot._snapshots == cached  # nothing cached, not even the failure

    r = client.post(f"{base}/staleness", json={}, headers=token)
    assert r.status_code >= 400
    assert "could not be undone" in r.text


def test_a_model_change_evicts_the_snapshots_it_orphaned(client, token, report):
    """The cache is four slots, and the generation sits in the key — so the moment the model moves,
    every entry in it is unreachable. That was never wrong (nobody can be served from them), but it
    was dead weight: the size limit would spend itself evicting a *live* snapshot to make room
    beside three corpses, and only the ten-minute TTL ever collected them.
    """
    other = _make(client, token)
    for rep in (report, other):
        sec = _prose(client, token, rep)
        client.post(
            f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/brief", json={}, headers=token
        )
    generation = lca.model_generation()
    assert len(report_snapshot._snapshots) == 2
    assert {key[-1] for key in report_snapshot._snapshots} == {generation}

    lca.invalidate_lca_cache()  # whatever moved the model — an edit, a recalculation, an import
    assert lca.model_generation() != generation
    sec = _prose(client, token, report)
    client.post(
        f"/api/v1/report/one/pr/{report['id']}/sections/{sec['id']}/brief", json={}, headers=token
    )
    # Both orphans gone, the one that was just built kept.
    assert len(report_snapshot._snapshots) == 1
    assert {key[-1] for key in report_snapshot._snapshots} == {lca.model_generation()}

    # And a snapshot of the *current* generation is never evicted for being somebody else's report:
    # the rule is the generation, not the report.
    sec = _prose(client, token, other)
    client.post(
        f"/api/v1/report/one/pr/{other['id']}/sections/{sec['id']}/brief", json={}, headers=token
    )
    assert len(report_snapshot._snapshots) == 2


def test_a_stale_render_token_with_figures_is_refused(client, token, report):
    """A token the model outgrew was silently recomputed — with the charts drawn
    for the old numbers typeset beside the new ones."""
    url = f"/api/v1/report/one/pr/{report['id']}"
    snap = client.post(f"{url}/sources", json={}, headers=token)
    assert snap.status_code == 200, snap.text
    tok = snap.json()["render_token"]
    lca.invalidate_lca_cache(model_change=True)
    r = client.post(f"{url}/pdf", json={"render_token": tok, "figures": {"f-x": "<svg/>"}}, headers=token)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "report_preview_stale"
    # Without figures nothing can disagree: the numbers are simply recomputed.
    r2 = client.post(f"{url}/pdf", json={"render_token": tok}, headers=token)
    assert (r2.json().get("error") or {}).get("code") != "report_preview_stale"


def test_a_render_token_does_not_cross_into_another_workspace(client, token, project):
    """Tokens and preview documents were keyed by model name and report id
    only, so a short-report token from workspace A was spent as fresh in B — same model name — and
    typeset A's product and score into B's PDF. The workspace is part of the key now."""
    import uuid as _uuid

    from prism_lca.engine import report_snapshot as rs

    key_a = rs.preview_key("Shared", "short")
    tok = rs.new_render_token(key_a, {"id": "short"}, {"activity": {"name": "A product"}})
    assert rs.render_token_state(rs.preview_key("Shared", "short"), tok) == "fresh"

    other = "ws-b-" + _uuid.uuid4().hex[:6]
    assert client.post("/api/v1/projects", json={"name": other}, headers=token).status_code == 200
    key_b = rs.preview_key("Shared", "short")
    assert key_b != key_a
    assert rs.render_token_state(key_b, tok) == "unknown"
    assert rs.spend_render_token(key_b, tok, None, None) is None
    # A key taken in A before computing, minted after the switch to B: no token, and
    # nothing filed in the preview cache under either workspace's key.
    assert rs.new_render_token(key_a, {"id": "short"}, {"activity": {"name": "A product"}}) == ""
    rs.preview_put(key_a, ({"main.typ": "A"}, [], []))
    assert rs.preview_get(key_a) is None

    assert client.post(f"/api/v1/projects/{project}/activate", headers=token).status_code == 200
    assert rs.render_token_state(rs.preview_key("Shared", "short"), tok) == "fresh"
