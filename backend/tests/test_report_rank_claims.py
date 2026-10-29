"""A chapter that *declares* its claim to the top rank instead of having it inferred from prose.

``Die Bilanz wird von {{rank:contribution.groups.0}} dominiert.`` asserts that the member at index 0 of
a size-ordered list is the one the sentence is about, and prints that member's name.

Why it exists is measured, not aesthetic. The gate decides whether a chapter claims a top rank by
matching word lists in five languages and then checks the claim arithmetically — and *ten* defects in
four days came out of the matching half, never the checking half (V205, V207–V213, V216): an ambiguous
word (`propre` = "own", `segundo` = "according to"), words inside words (`vertu`, `Gründe`,
`secondary`), a typographic apostrophe, an inflection tolerance that reaches unevenly per language,
and finally a missing *lemma* — `maior contribuidora` where the list has `maior contribuinte`, two
different nouns that no inflection rule bridges — which reached a delivered PDF.

So the tests below are mostly about what did **not** have to be built: the pin, the rank verdict, the
correction brief, the renderer and the export gate all judge a declaration through the machinery they
already had, because `paths_in_token` hands them the path and the prefix disappears.

The word lists keep their authority unchanged, which the last test holds down: a chapter that claims
the top in words alone behaves exactly as it did before.
"""
from __future__ import annotations

from test_report_render import _add_prose, _seed
from test_report_render import _report as _stored_report

from prism_lca.engine import report_claims as rc
from prism_lca.engine import report_data as rd
from prism_lca.engine import report_patch as rp
from prism_lca.engine import report_prompts as rpr
from prism_lca.engine import report_staleness as rs
from prism_lca.engine.bootstrap import get_bd

DECLARED = "The balance is dominated by {{rank:contribution.groups.0}}. The rest is spread thinly."
BARE = "The balance is dominated by packaging. The rest is spread thinly."


def _data(*groups: tuple[str, float]) -> dict:
    return {
        "study": {"functional_unit": "1 unit"},
        "activity": {"name": "widget", "code": "w", "database": "rr"},
        "amount": 1.0,
        "results": [{"method_label": "EF v3.1 / climate change", "score": 1.0, "unit": "kg CO2-Eq"}],
        "contribution": {
            "groups": [
                {"key": key, "share_percent": share, "share_text": f"{share:.1f} %"}
                for key, share in groups
            ]
        },
    }


def _report() -> dict:
    return {
        "lang": "en",
        "options": {},
        "sections": [],
        "methods": [["EF v3.1", "climate change", "GWP100"]],
        "subjects": [{"label": "Baseline", "code": "w"}],
        "aggregate_by": "tag:Life-cycle phase",
    }


LEADS_PACKAGING = _data(("Packaging", 60.0), ("Distribution", 30.0), ("Use", 10.0))
LEADS_DISTRIBUTION = _data(("Distribution", 55.0), ("Packaging", 35.0), ("Use", 10.0))
SAME_ORDER_OTHER_NUMBERS = _data(("Packaging", 52.0), ("Distribution", 38.0), ("Use", 10.0))


# --- resolution ---------------------------------------------------------------


def test_a_declaration_prints_the_member_it_names():
    text, missing = rd.resolve(DECLARED, LEADS_PACKAGING, "en")
    assert "dominated by Packaging." in text
    assert missing == []


def test_the_name_printed_is_the_binding_identity_and_stays_untranslated():
    """The key as the data spells it, which is the point: the label *is* the identity (V193).

    A translated display name would separate what is printed from what is pinned. That separation is a
    real improvement — and a different change; this design is what makes it possible, because only
    `member_label` would move.
    """
    hotspots = {"hotspots": [{"name": "packaging glass production", "database": "ei", "code": "gl"}]}
    text, missing = rd.resolve("{{rank:hotspots.0}} leads.", hotspots, "de")
    assert text.startswith("packaging glass production")
    assert missing == []


def test_a_declaration_that_names_a_figure_instead_of_a_member_is_an_unknown_path():
    """A figure already has a placeholder. A declaration names the member, and nothing else."""
    text, missing = rd.resolve("{{rank:contribution.groups.0.share_text}}", LEADS_PACKAGING, "en")
    assert missing == ["rank:contribution.groups.0.share_text"]
    assert "[missing:" in text


def test_a_rank_claim_on_a_structure_ordered_list_is_refused_as_an_unknown_path():
    """`results` is method order and `subjects` is report order — index there is not rank.

    `report_data.MAGNITUDE_RANKED` exists for exactly this distinction, and a claim on a list that
    never expressed size is a claim about nothing. Refused as the unknown path it is, rather than
    through a rule of its own: the report has no such thing as "the largest result".
    """
    data = {**LEADS_PACKAGING, "subjects": [{"label": "Baseline", "code": "w", "scenario": None}],
            "parameters": [{"name": "mass", "amount": 1.0}]}
    for token in ("rank:results.0", "rank:subjects.0", "rank:parameters.0", "rank:nothing.0"):
        text, missing = rd.resolve("{{" + token + "}}", data, "en")
        assert missing == [token], token
        assert "[missing:" in text
    # …and the same paths without the prefix still resolve as ordinary citations.
    assert rd.resolve("{{results.0.score}}", data, "en")[1] == []


def test_the_gate_refuses_a_bad_declaration_as_an_unresolved_placeholder():
    """No new refusal machinery: the gate's existing `unresolved_placeholder` covers all four cases."""
    section = {"id": "s1", "kind": "prose"}
    for token in ("rank:results.0", "rank:contribution.groups.0.share_text", "rank:nothing.0",
                  "rank:contribution.groups.9"):
        body = "Prose. {{" + token + "}}"
        out = rpr.check_proposal(body, section, LEADS_PACKAGING, "en", report=_report(),
                                 bindings=rd.bindings_for(body, LEADS_PACKAGING))
        kinds = {f["kind"] for f in out["findings"]}
        assert kinds == {"unresolved_placeholder"}, (token, out["findings"])
    # A well-formed declaration passes the gate with nothing to say about it.
    out = rpr.check_proposal(DECLARED, section, LEADS_PACKAGING, "en", report=_report(),
                             bindings=rd.bindings_for(DECLARED, LEADS_PACKAGING))
    assert out["findings"] == []


# --- identity -----------------------------------------------------------------


def test_a_declaration_is_pinned_to_the_member_it_meant():
    assert rd.bindings_for(DECLARED, LEADS_PACKAGING) == {"contribution.groups.0": {"key": "Packaging"}}


def test_a_declaration_keeps_naming_its_own_member_after_the_ranking_flips():
    """The pin decides, as it does for every other citation. Printing whoever occupies the index today
    would be the same sentence about a different thing — the failure bindings exist to prevent."""
    bindings = rd.bindings_for(DECLARED, LEADS_PACKAGING)
    text, missing = rd.resolve(DECLARED, LEADS_DISTRIBUTION, "en", bindings)
    assert "dominated by Packaging." in text and missing == []


def _stored(text: str, data: dict) -> dict:
    bindings = rd.bindings_for(text, data)
    return {
        "id": "s1",
        "kind": "prose",
        "text": text,
        "bindings": bindings,
        "based_on": rs.components(text, bindings, _report(), data),
    }


def test_a_declaration_earns_a_rank_verdict_when_the_leader_changes_hands():
    """The whole point: no new check, no word list, the existing `ranks` verdict."""
    found = rs.verdicts(_stored(DECLARED, LEADS_PACKAGING), _report(), LEADS_DISTRIBUTION)
    assert [(f["kind"], f["severity"], f["path"]) for f in found] == [
        ("ranks", "review", "contribution.groups.0")
    ]
    assert "was rank 1 and is now rank 2" in found[0]["message"]


def test_a_declaration_is_told_apart_from_a_suspicion():
    """"May" is the honest word for prose — this check cannot read a sentence, so it can only suspect
    that "the largest" was meant. A declaration removes the doubt, and the two states deserve two
    words: the author decides what to repair first by how certain the finding is."""
    declared = rs.verdicts(_stored(DECLARED, LEADS_PACKAGING), _report(), LEADS_DISTRIBUTION)[0]
    assert declared["declared"] is True
    assert "declares this member as the leader, and it is not any more" in declared["message"]
    assert "may no longer" not in declared["message"]

    # A declaration is not always a claim to the *top*. Run 21 wrote `{{rank:hotspots.1}}` for "the
    # second largest is …" — a rank claim like any other, and the message must name the position the
    # chapter declared instead of inventing leadership it never claimed.
    second = "The runner-up is {{rank:contribution.groups.1}}."
    ranked = [
        f
        for f in rs.verdicts(_stored(second, LEADS_PACKAGING), _report(), LEADS_DISTRIBUTION)
        if f["kind"] == "ranks" and f["path"] == "contribution.groups.1"
    ]
    assert len(ranked) == 1, "the fixture must move this member, or this asserts nothing"
    assert "as rank 2, and it is not any more" in ranked[0]["message"]
    assert "the leader" not in ranked[0]["message"]

    # The same ranking, cited without a declaration: the suspicion keeps its "may".
    cited = "Le groupe pèse {{contribution.groups.0.share_text}} du total."
    suspected = rs.verdicts(_stored(cited, LEADS_PACKAGING), _report(), LEADS_DISTRIBUTION)
    ranks = [f for f in suspected if f["kind"] == "ranks"]
    assert ranks and ranks[0]["declared"] is False
    assert "“the largest” may no longer be true" in ranks[0]["message"]


def test_a_declaration_says_nothing_when_only_the_values_move():
    """A remark that appears every time carries no information — the standing rule of this module."""
    assert rs.verdicts(_stored(DECLARED, LEADS_PACKAGING), _report(), SAME_ORDER_OTHER_NUMBERS) == []


def test_a_declared_claim_is_not_also_reported_as_a_wordless_one():
    """`unanchored_claims` is for sentences with nothing in them to check. A declaration has the pin,
    so it is anchored and the word-list rule leaves it to the arithmetic — one problem, one report."""
    assert rs._anchored("dominated by {{rank:contribution.groups.0}}.")
    assert rs.unanchored_claims(DECLARED, "en") == []


def test_a_true_declaration_is_never_refused_and_a_false_one_is():
    """The gate's superlative rule reads the declaration as the anchor it is (`_superlative_anchors`).

    Index 0 with the leader pinned to it is the claim being true, so nothing fires. A declaration on
    index 1 beside "dominated" is a claim the arithmetic contradicts, and it is refused — by the rule
    that has always refused exactly that, with no word list consulted about *whether* a claim is made.
    """
    assert rc.check_claims(DECLARED, LEADS_PACKAGING, "en",
                           rd.bindings_for(DECLARED, LEADS_PACKAGING)) == []
    wrong = "The balance is dominated by {{rank:contribution.groups.1}}."
    kinds = [f["kind"] for f in rc.check_claims(wrong, LEADS_PACKAGING, "en",
                                                rd.bindings_for(wrong, LEADS_PACKAGING))]
    assert kinds == ["contradicted_claim"]


def test_a_declaration_prints_a_name_so_it_cannot_be_a_misbound_figure():
    """`misbound_names` asks whose figure this is and whose name stands in front of it. A declaration
    answers both with the same member — and the sentence below is correct prose, which that
    *blocking* rule would otherwise refuse over the name of the member it explicitly calls second."""
    text = "Distribution follows, but {{rank:contribution.groups.0}} leads."
    assert rc.misbound_names(text, LEADS_PACKAGING, rd.bindings_for(text, LEADS_PACKAGING)) == []


def test_one_answer_to_what_a_member_is_called():
    """The staleness message and the printed declaration must never name the same member two ways."""
    assert rs._member_label is rd.member_label


# --- the correction brief -----------------------------------------------------


def test_the_correction_brief_finds_the_declared_sentence_by_path():
    """The class of finding nobody can point at (V184, V206) shrinks: a declaration *is* a path in the
    sentence, so `_spans_and_gaps` locates it with the mechanism it already had."""
    found = rs.verdicts(_stored(DECLARED, LEADS_PACKAGING), _report(), LEADS_DISTRIBUTION)
    located, unlocated = rp._spans_and_gaps(DECLARED, found)
    assert unlocated == []
    assert len(located) == 1
    assert located[0]["sentence"] == "The balance is dominated by {{rank:contribution.groups.0}}."
    # Which claim in the sentence the finding is about — the declaration, by name.
    assert located[0]["about"] == "contribution.groups.0"


def test_a_hand_edit_elsewhere_does_not_re_point_a_declaration():
    """`surviving_bindings` reads the declaration as the pin it is (V180's rule, one token further)."""
    bindings = rd.bindings_for(DECLARED, LEADS_PACKAGING)
    edited = DECLARED.replace("The rest is spread thinly.", "The rest is spread thinly indeed.")
    assert rp.surviving_bindings(DECLARED, edited, bindings) == bindings


# --- what a declaration is not ------------------------------------------------


def test_a_rank_token_is_not_a_reference_and_a_reference_is_not_a_rank_token():
    """Both checks filter on their own prefix, and neither may answer for the other: a `rank:` token
    run past the reference check would be judged against the document's table labels."""
    report = {**_report(), "sections": [{"id": "s1", "kind": "lcia", "title": "Impact"}]}
    out = rpr.check_proposal(DECLARED, {"id": "s2", "kind": "prose"}, LEADS_PACKAGING, "en",
                             report=report, bindings=rd.bindings_for(DECLARED, LEADS_PACKAGING))
    assert [f for f in out["findings"] if f["kind"] == "unknown_reference"] == []
    assert rd.paths_in_token("ref:t-lcia") == []
    assert rd.rank_path("ref:t-lcia") is None
    assert rd.rank_claim("ref:t-lcia") is None
    # …and the staleness check's reference sweep ignores it too.
    assert [t for t in rd.placeholders_in(DECLARED) if t.startswith("ref:")] == []


def test_show_with_the_numbers_resolves_a_declaration_and_names_its_member():
    parts = rd.explain(DECLARED, LEADS_DISTRIBUTION, "en", rd.bindings_for(DECLARED, LEADS_PACKAGING))
    value = [p for p in parts if p["kind"] == "value"]
    assert len(value) == 1
    assert value[0]["token"] == "rank:contribution.groups.0"
    assert value[0]["text"] == "Packaging"
    assert value[0]["missing"] is False
    # The editor's whole job here: which member, and whether the sentence is tied to it.
    assert value[0]["member"] == "key=Packaging" and value[0]["pinned"] is True


# --- backwards compatibility --------------------------------------------------


def test_a_bare_word_claim_behaves_exactly_as_it_did_before():
    """No migration and no new obligation: the word lists keep their authority, unchanged.

    A bare superlative under a ranking that changed hands is still the `wording` finding of V206, still
    `review`, still carrying the sentence verbatim so a correction costs one replacement. Making it
    block would let the word lists' false positives refuse chapters — the opposite of the point.
    """
    found = rs.verdicts(_stored(BARE, LEADS_PACKAGING), _report(), LEADS_DISTRIBUTION)
    wording = [f for f in found if f["kind"] == "wording"]
    assert len(wording) == 1
    assert wording[0]["severity"] == "review"
    assert wording[0]["sentence"] == "The balance is dominated by packaging."
    assert "claims a top rank in words" in wording[0]["message"]
    # And the sentence is still located by its verbatim text, not by a path.
    located, unlocated = rp._spans_and_gaps(BARE, wording)
    assert unlocated == [] and len(located) == 1
    # Nothing in the bare chapter is a declaration.
    assert rd.bindings_for(BARE, LEADS_PACKAGING) == {}


def test_the_writers_brief_offers_the_declaration_where_the_syntax_is_explained():
    assert "{{{{rank:contribution.groups.0}}}}" in rpr._INVARIANTS


# --- render and export --------------------------------------------------------
#
# End to end, because the promise is about the *document*: a declaration must resolve into `values.json`
# and `main.typ` like every other placeholder, and a member that has vanished must print a visible gap
# the export gate refuses to ship. Both are the renderer's existing behaviour for a bound path; these
# hold it down for the new token.

FLOW = "The largest elementary flow is {{rank:inventory.flows.0}}."


def _prose(client, token, rep, text: str) -> dict:
    section = _add_prose(client, token, rep)
    return client.post(
        f"/api/v1/report/one/rr/{rep['id']}/sections/{section['id']}",
        json={"kind": "prose", "text": text},
        headers=token,
    ).json()


def test_a_declaration_resolves_into_the_typeset_document(client, token, project):
    _seed(get_bd())
    rep = _stored_report(client, token)
    section = _prose(client, token, rep, FLOW)
    # The pin is the member, stored with the chapter, exactly as for any ranked citation.
    assert section["bindings"] == {
        "inventory.flows.0": {"flow": "Carbon dioxide", "compartment": "air"}
    }
    out = client.post(f"/api/v1/report/one/rr/{rep['id']}/sources", json={}, headers=token).json()
    assert out["missing_placeholders"] == []
    # The figure lives in `values.json` and the document looks it up — what makes an exported project
    # pick up new data on its own.
    assert "Carbon dioxide" in out["files"]["values.json"]
    assert "rank:inventory.flows.0" in out["files"]["main.typ"]


def test_a_vanished_member_prints_a_gap_and_the_export_gate_refuses_it(client, token, project):
    _seed(get_bd())
    rep = _stored_report(client, token)
    section = _prose(client, token, rep, FLOW)
    # The state a deleted member leaves behind: the pin names something the data no longer contains.
    # Straight into the store, because the endpoint derives the pins from the snapshot and there is no
    # snapshot in which this flow is gone *and* the chapter still cites it.
    from prism_lca.engine import report_store

    report_store.ReportStore().update_section(
        "rr", rep["id"], section["id"],
        {"bindings": {"inventory.flows.0": {"flow": "Methane", "compartment": "air"}}},
    )
    out = client.post(f"/api/v1/report/one/rr/{rep['id']}/sources", json={}, headers=token).json()
    assert out["missing_placeholders"] == ["rank:inventory.flows.0"]
    assert "[missing: rank:inventory.flows.0]" in out["files"]["main.typ"]
    # Never silently replaced by whoever occupies the index today — that would be the same sentence
    # about a different thing.
    assert "Carbon dioxide" not in out["files"]["values.json"]

    refused = client.post(f"/api/v1/report/one/rr/{rep['id']}/pdf", json={}, headers=token)
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "report_has_gaps"
    assert "rank:inventory.flows.0" in refused.json()["error"]["message"]
    # And exporting anyway stays a decision the author makes explicitly.
    anyway = client.post(f"/api/v1/report/one/rr/{rep['id']}/pdf", json={"allow_gaps": True},
                         headers=token).json()
    assert anyway["missing_placeholders"] == ["rank:inventory.flows.0"]


def test_the_hand_off_carries_a_declaration_like_any_other_lookup(client, token, project):
    """The bundle and the "update data only" archive.

    `main.typ` becomes the author's and `values.json` stays ours to regenerate, so a declaration has to
    be a `#pval` lookup rather than fixed text — otherwise a data refresh would move the tables and
    leave the sentence naming last month's leader. It is, and the split needed no change: a declaration
    is a token, and `resolve` emits every token the same way.
    """
    import base64
    import io
    import json
    import zipfile

    _seed(get_bd())
    rep = _stored_report(client, token)
    _prose(client, token, rep, FLOW)

    bundle = client.post(f"/api/v1/report/one/rr/{rep['id']}/bundle", json={}, headers=token).json()
    assert bundle["missing_placeholders"] == []
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["base64"]))) as zf:
        assert "Carbon dioxide" in zf.read("values.json").decode()
        assert "rank:inventory.flows.0" in zf.read("main.typ").decode()

    archive = client.post(f"/api/v1/report/one/rr/{rep['id']}/data/archive", json={}, headers=token).json()
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(archive["base64"]))) as zf:
        names = zf.namelist()
        assert "values.json" in names and "main.typ" not in names  # the prose stays the recipient's
        assert "Carbon dioxide" in zf.read("values.json").decode()

    only = client.post(f"/api/v1/report/one/rr/{rep['id']}/data", json={}, headers=token).json()
    assert "Carbon dioxide" in json.loads(only["values_json"]).get("rank:inventory.flows.0", "")


def test_a_declaration_adds_nothing_to_the_abbreviation_harvest(client, token, project):
    """The harvest reads the blocks, where every figure is still a `#pval` call — so a declaration is
    as invisible to it as `{{hotspots.0.name}}` already was, and cannot invent a candidate."""
    _seed(get_bd())
    rep = _stored_report(client, token)
    before = client.post(f"/api/v1/report/one/rr/{rep['id']}/abbreviations", json={}, headers=token).json()
    _prose(client, token, rep, FLOW)
    after = client.post(f"/api/v1/report/one/rr/{rep['id']}/abbreviations", json={}, headers=token).json()
    assert after["candidates"] == before["candidates"]


def test_mark_as_read_records_a_declaration_verbatim_and_notices_when_it_changes(
    client, token, project
):
    """A declaration is text like any other, which is what the word diff needs: the mark records the
    token as written, and rewriting the sentence that carries it counts as a change."""
    _seed(get_bd())
    rep = _stored_report(client, token)
    section = _prose(client, token, rep, FLOW)
    client.post(f"/api/v1/report/one/rr/{rep['id']}/reviewed", json={}, headers=token)
    stale = client.post(f"/api/v1/report/one/rr/{rep['id']}/staleness", json={}, headers=token).json()
    chapter = next(c for c in stale["chapters"] if c["section_id"] == section["id"])
    assert chapter["reviewed_text"] == FLOW  # the diff's "before" side, token included
    assert chapter["changed_since_reviewed"] is False

    client.post(
        f"/api/v1/report/one/rr/{rep['id']}/sections/{section['id']}",
        json={"kind": "prose", "text": FLOW.replace("The largest", "By far the largest")},
        headers=token,
    )
    stale = client.post(f"/api/v1/report/one/rr/{rep['id']}/staleness", json={}, headers=token).json()
    chapter = next(c for c in stale["chapters"] if c["section_id"] == section["id"])
    assert chapter["changed_since_reviewed"] is True


def test_freezing_protects_a_chapter_that_carries_a_declaration(client, token, project):
    """The text is a content key, so freezing guards the declaration with it — nothing new."""
    _seed(get_bd())
    rep = _stored_report(client, token)
    section = _prose(client, token, rep, FLOW)
    url = f"/api/v1/report/one/rr/{rep['id']}/sections/{section['id']}"
    client.post(url, json={"locked": True}, headers=token)
    refused = client.post(url, json={"text": "Something else entirely."}, headers=token)
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "report_section_locked"


def test_accept_as_it_is_answers_a_declared_claim_exactly_as_an_inferred_one(
    client, token, project, monkeypatch
):
    """The other end of a conservative check, unchanged (V179).

    A rank finding is a "may", and the author may answer it: re-stamp, no model, no word changed, no
    pin moved. That is deliberately still true of a *declared* claim in this phase — withholding the
    button where the sentence says outright that it claims the top would be a defensible next step, and
    it is a decision about the offer rather than about this token, so it is left for later.
    """
    from prism_lca.engine import report_pipeline
    from prism_lca.engine.report_store import ReportStore

    def _hotspots(order: list[str]) -> dict:
        shares = {"packaging": 40.0, "distribution": 35.0}
        return {
            "study": {"functional_unit": "1 kg"},
            "results": [{"method_label": "t / gwp", "score": 1.0, "unit": "kg CO2-Eq"}],
            "hotspots": [
                {"name": n, "database": "pr", "code": n[:3], "share_percent": shares[n],
                 "share_text": f"{shares[n]} %"}
                for n in order
            ],
        }

    state = {"data": _hotspots(["packaging", "distribution"])}

    def fake(database, report_id, body):  # noqa: ARG001
        return ReportStore().get(database, report_id), state["data"]

    # One seam: every judging endpoint reaches the snapshot through
    # `report_pipeline.analysis_snapshot`, so one patch covers them all.
    monkeypatch.setattr(report_pipeline, "analysis_snapshot", fake)

    rep = client.post(
        "/api/v1/report/create",
        json={"database": "pr", "lang": "en", "subjects": [{"database": "pr", "code": "a"}]},
        headers=token,
    ).json()
    sec = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections", json={"kind": "contribution"}, headers=token
    ).json()
    text = "The largest single process is {{rank:hotspots.0}}."
    stored = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}",
        json={"kind": "contribution", "text": text},
        headers=token,
    ).json()
    assert stored["bindings"] == {"hotspots.0": {"database": "pr", "code": "pac", "name": "packaging"}}

    def chapter() -> dict:
        out = client.post(f"/api/v1/report/one/pr/{rep['id']}/staleness", json={}, headers=token).json()
        return out["chapters"][0]

    assert chapter()["remedy"] == "none"

    # The lead changes hands, with both shares untouched: the rank is the only thing that moved.
    state["data"] = _hotspots(["distribution", "packaging"])
    now = chapter()
    assert now["remedy"] == "review"
    assert {f["kind"] for f in now["findings"]} == {"ranks"}

    accepted = client.post(
        f"/api/v1/report/one/pr/{rep['id']}/sections/{sec['id']}/accepted", json={}, headers=token
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["accepted"] is True
    after = next(
        s for s in client.get(f"/api/v1/report/one/pr/{rep['id']}", headers=token).json()["sections"]
        if s["id"] == sec["id"]
    )
    assert after["text"] == text and after["bindings"] == stored["bindings"]
    assert chapter()["remedy"] == "none"


# --- a rank claim about a *variant* (V219) -------------------------------------
#
# `subjects` is the report's own order, chosen by the author, so a rank claim there is a claim about
# nothing and stays refused. But "among the variants, the end-of-life case without recycling is the
# highest under both methods" *is* a rank claim, it went false when the numbers moved, and with no
# declaration form it stayed in the prose-only regime — word lists, `unanchored_claims`, and a paid
# rewrite of the chapter for one sentence (run 21, V219).
#
# So the variants get a derived, score-ordered view. Ranking them needs a score, and a score belongs
# to an indicator: the view therefore hangs off the indicator's own row, `results.<i>.subjects_by_score`,
# where the path says which score does the ordering and index 0 is the lead indicator like everywhere
# else. `trade_offs` is the proof that the per-indicator form is the honest one — it exists precisely
# because the order differs between indicators.

HIGHEST = "Among the variants, {{rank:results.0.subjects_by_score.0}} is the highest."
VARIANT = "No recycling at end of life"


def _variants(climate: tuple[float, float] = (10.0, 4.0), water: tuple[float, float] = (1.0, 9.0),
              swap: bool = False) -> dict:
    """A two-indicator, two-variant comparison, built through `build_data` so the view is the real one.

    The baseline deliberately runs **no** scenario: that is the shape every comparison has, and it is
    what makes the variant's identity a question rather than a copy of `subjects`' (code, scenario).
    """
    def rows(gwp: float, h2o: float) -> list[dict]:
        out = [
            {"method": ["EF v3.1", "climate change"], "unit": "kg CO2-Eq", "score": gwp},
            {"method": ["EF v3.1", "water use"], "unit": "m3", "score": h2o},
        ]
        return list(reversed(out)) if swap else out

    return rd.build_data(
        {"functional_unit": "1 unit"},
        {"activity": {"name": "widget", "database": "rr", "code": "w"}, "amount": 1.0,
         "results": rows(climate[0], water[0])},
        None,
        subjects=[
            {"label": "Baseline", "code": "w", "scenario": None,
             "lcia": {"results": rows(climate[0], water[0])}},
            {"label": VARIANT, "code": "w", "scenario": "no-recycling",
             "lcia": {"results": rows(climate[1], water[1])}},
        ],
    )


BASELINE_HIGHEST = _variants()
VARIANT_HIGHEST = _variants(climate=(2.0, 40.0))
SCORES_MOVED = _variants(climate=(20.0, 8.0))


def test_a_declaration_about_a_variant_prints_its_label_and_pins_the_variant():
    """What it prints is the variant's label, through `member_label` like every other declaration —
    the label is not the identity here (it follows the report language), so it rides beside the pin."""
    text, missing = rd.resolve(HIGHEST, BASELINE_HIGHEST, "en")
    assert text == "Among the variants, Baseline is the highest." and missing == []
    # Two pins for one declaration, and both are needed: the inner one says *which variant*, the outer
    # one says *whose ranking* — reordering the report's indicators must not slide another indicator's
    # order under the sentence (V186).
    assert rd.bindings_for(HIGHEST, BASELINE_HIGHEST) == {
        "results.0": {"method_label": "EF v3.1 / climate change"},
        "results.0.subjects_by_score.0": {"variant": "w", "@name": "Baseline"},
    }


def test_a_variant_that_loses_the_top_spot_raises_the_declared_rank_verdict():
    """The point of the whole exercise: no new check and no word list, the existing `ranks` verdict."""
    found = rs.verdicts(_stored(HIGHEST, BASELINE_HIGHEST), _report(), VARIANT_HIGHEST)
    ranked = [f for f in found if f["kind"] == "ranks"]
    assert len(ranked) == 1, "the fixture must move this variant, or this asserts nothing"
    assert ranked[0]["path"] == "results.0.subjects_by_score.0"
    assert ranked[0]["severity"] == "review"
    # The declared wording, not the suspicion: the sentence said so in machine-readable form.
    assert ranked[0]["declared"] is True
    assert "was rank 1 and is now rank 2" in ranked[0]["message"]
    assert "declares this member as the leader, and it is not any more" in ranked[0]["message"]
    assert "may no longer" not in ranked[0]["message"]
    # And the sentence keeps naming the variant it was written about, rather than being silently
    # rewritten into a true statement about a different one.
    text, missing = rd.resolve(HIGHEST, VARIANT_HIGHEST, "en",
                               rd.bindings_for(HIGHEST, BASELINE_HIGHEST))
    assert text == "Among the variants, Baseline is the highest." and missing == []


def test_a_variant_declaration_says_nothing_when_only_the_scores_move():
    assert rs.verdicts(_stored(HIGHEST, BASELINE_HIGHEST), _report(), SCORES_MOVED) == []


def test_the_correction_brief_finds_the_variant_sentence_by_path():
    found = rs.verdicts(_stored(HIGHEST, BASELINE_HIGHEST), _report(), VARIANT_HIGHEST)
    located, unlocated = rp._spans_and_gaps(HIGHEST, found)
    assert unlocated == []
    assert len(located) == 1 and located[0]["sentence"] == HIGHEST
    assert located[0]["about"] == "results.0.subjects_by_score.0"


def test_the_report_ordered_variant_list_still_refuses_a_rank_claim():
    """`subjects` is untouched: index there is where the author put the variant, not how it scores.

    Both halves matter. The member resolves for figures exactly as before, and the *rank* claim on the
    same member is refused as the unknown path it is — the report has no such thing as "the largest
    subject", only "the highest variant for this indicator".
    """
    assert rd.resolve("{{subjects.1.label}}", BASELINE_HIGHEST, "en")[1] == []
    for token in ("rank:subjects.0", "rank:subjects.1", "rank:subjects.2"):
        text, missing = rd.resolve("{{" + token + "}}", BASELINE_HIGHEST, "en")
        assert missing == [token], token
        assert "[missing:" in text
    assert rd.rank_claim("rank:subjects.1") is None
    assert not rd.is_magnitude_ranked("subjects")


def test_each_indicator_ranks_the_variants_by_its_own_score():
    """Why the form is per indicator rather than one report-wide ranking: the orders disagree, which is
    what `trade_offs` has always been about — and both now read the same ordering, so a declaration and
    the trade-off table can never name different variants as the highest."""
    both = ("Climate change: {{rank:results.0.subjects_by_score.0}}. "
            "Water use: {{rank:results.1.subjects_by_score.0}}.")
    text, missing = rd.resolve(both, BASELINE_HIGHEST, "en")
    assert text == f"Climate change: Baseline. Water use: {VARIANT}."
    assert missing == []
    assert BASELINE_HIGHEST["trade_offs"] == [
        {"method_label": "EF v3.1 / water use", "highest": VARIANT, "score": 9.0}
    ]


def test_reordering_the_indicators_does_not_move_another_ranking_under_the_sentence():
    """The reason the view sits on `results.<i>`: that row is already pinned by `method_label`, so the
    sentence keeps reading *its* indicator's ranking after the report's method list is reordered — the
    failure V186 measured, one level further out. Water use would name the other variant."""
    swapped = _variants(swap=True)
    assert swapped["results"][0]["method_label"] == "EF v3.1 / water use"
    bindings = rd.bindings_for(HIGHEST, BASELINE_HIGHEST)
    text, missing = rd.resolve(HIGHEST, swapped, "en", bindings)
    assert text == "Among the variants, Baseline is the highest." and missing == []
    assert rs.verdicts(_stored(HIGHEST, BASELINE_HIGHEST), _report(), swapped) == []


def test_the_baselines_pin_cannot_match_another_variant_of_the_same_process():
    """Why the identity is one `variant` key instead of `subjects`' (code, scenario) pair.

    Measured while building this: the baseline runs no scenario, `identity_of` drops empty values, and
    the pin therefore shrank to the process code — which every other variant of the same process
    carries too. It then matched whichever of them stood first, so the declaration printed the
    runner-up's name the moment the two swapped places, and no verdict fired at all.
    """
    pin = rd.bindings_for(HIGHEST, BASELINE_HIGHEST)["results.0.subjects_by_score.0"]
    other = VARIANT_HIGHEST["results"][0]["subjects_by_score"][0]
    assert other["label"] == VARIANT
    assert not rd.identity_matches(other, pin)
    assert rd.identity_fields("results.0.subjects_by_score") == ("variant",)


def test_one_variant_is_not_a_ranking():
    """No key at all below two variants, so the declaration is the unknown path it should be: "the
    highest of one" is not a claim, and a list of one cannot change hands."""
    alone = rd.build_data(
        {"functional_unit": "1 unit"},
        {"activity": {"name": "widget", "database": "rr", "code": "w"}, "amount": 1.0,
         "results": [{"method": ["EF v3.1", "climate change"], "unit": "kg CO2-Eq", "score": 1.0}]},
        None,
        subjects=[{"label": "Baseline", "code": "w", "scenario": None,
                   "lcia": {"results": [{"method": ["EF v3.1", "climate change"], "score": 1.0}]}}],
    )
    assert "subjects_by_score" not in alone["results"][0]
    assert rd.resolve(HIGHEST, alone, "en")[1] == ["rank:results.0.subjects_by_score.0"]


def test_the_declared_variant_is_named_in_the_report_language():
    """The score-ordered rows are copies of the variants, so they are in the translation walk with them.
    Left out, a variant would be named one way in the chart legend and another in the sentence that
    declares it the highest — and the source strings are identical, so nothing is translated twice."""
    from prism_lca.engine import report_translations as rtr

    data = _variants()
    assert [c["text"] for c in rtr.candidates(data)].count(VARIANT) == 1
    stored = {"lang": "de", "map": {rtr.source_key(VARIANT): "Ohne Recycling am Lebensende"}}
    # Three substitutions of one translation: the variant in `subjects`, and its row in each of the two
    # indicators' rankings. One source string, so the translator is asked once.
    assert rtr.apply(data, stored, "de") == 3
    text, missing = rd.resolve("{{rank:results.1.subjects_by_score.0}}", data, "de")
    assert text == "Ohne Recycling am Lebensende" and missing == []


def test_a_variant_claim_made_in_words_alone_is_left_exactly_as_it_was():
    """No new refusal and no new remark. The view is per indicator, so it is deliberately not one of
    the report's own rankings the wordless-claim rule watches (`PRIMARY_RANKED`): five indicators'
    variant orders re-rank on every recompute, and a sentence with no figure in it cannot be
    attributed to one of them — the reason written on that tuple, unchanged."""
    assert not [head for head in rs.PRIMARY_RANKED if "subjects_by_score" in head]
    bare = "Among the variants, the end-of-life case is the highest under both methods."
    assert rs.verdicts(_stored(bare, BASELINE_HIGHEST), _report(), VARIANT_HIGHEST) == []
    assert rd.bindings_for(bare, BASELINE_HIGHEST) == {}


def test_the_writers_brief_names_the_variant_ranking_beside_the_lists_that_carry_a_rank():
    assert "`results.<i>.subjects_by_score`" in rpr._INVARIANTS
    # …and still says what `subjects` is, so the writer is not invited to declare a rank there.
    assert "`subjects` are in report order, so they carry no rank" in rpr._INVARIANTS


def test_a_variant_declaration_renders_and_a_vanished_variant_is_a_reported_gap(client, token, project):
    """End to end, because the promise is about the document: the glass bottle is the highest, the
    sentence names it through `values.json`, and a pin on a variant this report no longer computes
    prints a visible gap the export gate refuses to ship."""
    import json

    from test_report_render import _seed_two

    _seed_two(get_bd())
    rep = client.post(
        "/api/v1/report/create",
        json={
            "database": "cmp",
            "methods": [["t", "gwp"]],
            "subjects": [{"database": "cmp", "code": "pet"}, {"database": "cmp", "code": "glass"}],
            "sections": [{"kind": "prose", "text": HIGHEST}],
        },
        headers=token,
    ).json()
    out = client.post(f"/api/v1/report/one/cmp/{rep['id']}/sources", json={}, headers=token).json()
    assert out["missing_placeholders"] == []
    assert out["data"]["results"][0]["subjects_by_score"][0]["label"] == "Glass bottle"
    values = json.loads(out["files"]["values.json"])
    assert values["rank:results.0.subjects_by_score.0"] == "Glass bottle"
    assert "rank:results.0.subjects_by_score.0" in out["files"]["main.typ"]

    from prism_lca.engine import report_store

    section = client.get(f"/api/v1/report/one/cmp/{rep['id']}", headers=token).json()["sections"][0]
    report_store.ReportStore().update_section(
        "cmp", rep["id"], section["id"],
        {"bindings": {"results.0.subjects_by_score.0": {"variant": "tin", "@name": "Tin can"}}},
    )
    gone = client.post(f"/api/v1/report/one/cmp/{rep['id']}/sources", json={}, headers=token).json()
    assert gone["missing_placeholders"] == ["rank:results.0.subjects_by_score.0"]
    assert "[missing: rank:results.0.subjects\\_by\\_score.0]" in gone["files"]["main.typ"]
    assert "Glass bottle" not in gone["files"]["values.json"]
    refused = client.post(f"/api/v1/report/one/cmp/{rep['id']}/pdf", json={}, headers=token)
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "report_has_gaps"


# --- an undeclared claim is told what to write ------------------------
#
# What the refusal alone leaves open is the *detection* problem, and it is written down as such: a model
# that claims a rank without declaring it is back in the word lists' hands, and the repair is a paid
# rewrite instead of one replacement. The advisory says so at the moment the wording exists — where the
# word list fires and the report has a size-ordered member the sentence is demonstrably about, the
# finding names the `{{rank:…}}` to write and the member it would print.
#
# It rides on the *existing* detection and adds no vocabulary: same list, same inflection tolerance,
# same disarming ordinal, same attribution. What it adds is three ways to fall silent, and each one is
# "we do not know what to write" rather than "nothing is wrong here" — no member the sentence points at,
# no member a declaration may name (a variant, a sub-list, an aggregate, two members at once), or a
# member that does not resolve. Measured over the 252 written chapters on this machine: 55 findings,
# 205 chapters with none, 9 with more than one.
#
# Advisory, and it must be: the half of the claim gate this rides on is the half that produced ten
# measured defects in four days. So it may suggest and may never refuse — `ADVISORY_KIND` is in
# `ADVISORY_FINDINGS`, and the tests below hold both ends of that down.

PROSE = "The balance is dominated by {{contribution.groups.0.share_text}} of the total."


def _snapshot() -> dict:
    """One report with all three of a single-subject study's size-ordered lists — and two that are not.

    `parameters` is alphabetical and `subjects` is the author's own order, so neither carries a rank;
    they are here because the suggestion has to be able to *not* name them.
    """
    return {
        "study": {"functional_unit": "1 unit"},
        "activity": {"name": "widget", "code": "w", "database": "rr"},
        "amount": 1.0,
        "results": [{"method_label": "EF v3.1 / climate change", "score": 1.0, "unit": "kg CO2-Eq"}],
        "contribution": {
            "groups": [
                {"key": "Packaging", "share_percent": 60.0, "share_text": "60.0 %"},
                {"key": "Distribution", "share_percent": 30.0, "share_text": "30.0 %"},
                {"key": "Use", "share_percent": 10.0, "share_text": "10.0 %"},
            ]
        },
        "hotspots": [
            {
                "name": "packaging glass production, white",
                "database": "ei", "code": "gl", "share_percent": 41.0, "share_text": "41.0 %",
                "inputs": [{"name": "market for natural gas, high pressure", "share_text": "22.0 %"}],
            },
            {
                "name": "market for transport, freight, lorry",
                "database": "ei", "code": "tr", "share_percent": 18.0, "share_text": "18.0 %",
            },
        ],
        "inventory": {
            "flows": [
                {"flow": "Carbon dioxide, fossil", "compartment": "air", "share_text": "72.0 %"},
                {"flow": "Methane, fossil", "compartment": "air", "share_text": "9.0 %"},
            ]
        },
        "subjects": [
            {"label": "Baseline", "code": "w",
             "results": [{"method_label": "EF v3.1 / climate change", "score": 1.0}]},
            {"label": "Heavier bottle", "code": "w", "scenario": "heavy",
             "results": [{"method_label": "EF v3.1 / climate change", "score": 1.4}]},
        ],
        "parameters": [{"name": "glass mass", "amount": 0.25, "unit": "kg"}],
    }


SNAPSHOT = _snapshot()


def _advice(text: str, lang: str = "en", data: dict | None = None, bindings: dict | None = None):
    """The declaration advisories on `text`, and nothing else."""
    found = rc.check_claims(text, data if data is not None else SNAPSHOT, lang, bindings)
    assert [f for f in found if f["kind"] not in rpr.ADVISORY_FINDINGS] == [], "must never refuse"
    return [f for f in found if f["kind"] == rc.ADVISORY_KIND]


def test_an_undeclared_claim_is_told_which_declaration_to_write():
    """The message names the placeholder *and* the member, because "declare it" alone is not followable."""
    found = _advice(PROSE)
    assert len(found) == 1
    detail = found[0]["detail"]
    assert "{{rank:contribution.groups.0}}" in detail
    assert "“Packaging”" in detail, "the member it would print, so the author can see it is the right one"
    # The word as the chapter spells it, and the sentence verbatim — the two handles a correction needs.
    assert "“dominated”" in detail
    assert found[0]["sentence"] == PROSE


def test_the_suggested_path_is_one_this_report_really_has():
    """Parsed back out of the message and resolved. A suggestion naming a path this report has no such
    thing as would be worse than silence: the author would write a gap into the document."""
    import re as _re

    for text, expected in (
        (PROSE, "contribution.groups.0"),
        ("The largest single process is {{hotspots.0.name}} at {{hotspots.0.share_text}}.", "hotspots.0"),
        ("The dominant flow is {{inventory.flows.0.flow}}.", "inventory.flows.0"),
    ):
        found = _advice(text)
        assert len(found) == 1, text
        path = _re.search(r"\{\{rank:([^}]+)\}\}", found[0]["detail"])
        assert path and path.group(1) == expected, text
        assert rd.rank_claim(f"rank:{path.group(1)}") is not None
        assert rd.resolve("{{rank:" + path.group(1) + "}}", SNAPSHOT, "en")[1] == [], text


def test_writing_the_suggested_declaration_ends_the_finding_and_earns_a_pin():
    """The round trip, which is the only proof the advice is followable."""
    fixed = PROSE.replace("{{contribution.groups.0.share_text}} of the total", "{{rank:contribution.groups.0}}")
    assert "{{rank:" in fixed
    assert _advice(fixed) == []
    assert rd.bindings_for(fixed, SNAPSHOT) == {"contribution.groups.0": {"key": "Packaging"}}


def test_a_sentence_that_already_declares_is_left_alone_whatever_it_says():
    """Recognised on the exact token — no word list and no language is consulted, the same test the
    `ranks` verdict makes. Which is why a declaration on a *different* list in the same sentence also
    silences it: the author has already said this claim is declared, and a second opinion about which
    list they meant is not this finding's business."""
    assert _advice("The balance is dominated by {{rank:contribution.groups.0}}.") == []
    assert _advice(
        "{{rank:hotspots.0}} dominates, at {{contribution.groups.0.share_text}} of the total."
    ) == []
    # …and the same on the ordinal branch, which reads the number off the words rather than the top:
    # a sentence that has already declared is not told to declare.
    declared_rank = "{{rank:hotspots.1}} is the second-largest process, at {{hotspots.1.share_text}}."
    assert rd.rank_path("rank:hotspots.1"), "the fixture needs a real declaration token"
    assert _advice(declared_rank) == []


def test_a_report_with_no_size_ordered_list_says_nothing():
    """There is nothing to point at, so there is nothing to say."""
    bare = {k: v for k, v in SNAPSHOT.items() if k not in ("contribution", "hotspots", "inventory")}
    assert "dominated" in PROSE
    assert _advice("The result is dominated by the packaging phase.", data=bare) == []
    # …and the same text against the full snapshot is silent for the same reason: no figure in it.
    assert _advice("The result is dominated by the packaging phase.") == []


def test_naming_a_member_without_claiming_a_rank_says_nothing():
    """The trigger is the word list's, unchanged. A sentence that cites a ranked member and makes no
    claim about its rank has nothing to declare."""
    for text in (
        "Packaging carries {{contribution.groups.0.share_text}} of the climate change result.",
        "The phase breakdown is shown in {{ref:t-contribution}} and lists {{contribution.groups.0.key}}.",
        "{{hotspots.0.name}} is modelled with an ecoinvent dataset for {{hotspots.0.share_text}}.",
    ):
        assert _advice(text) == [], text


# --- the denial and the hedge -----------------------------------------------------------------
#
# The five reports on disk that made the advisory say the wrong thing, verbatim, plus their siblings in
# the languages nothing fired on. A denial is not a claim to the top and a hedge claims less than the
# top, and the word list can see neither — so the *suggestion* stops where it cannot tell.
_DENIED = (
    # A denial in the clause the superlative sits in, in all five languages.
    ("en", "No single dataset dominates the result at {{contribution.groups.0.share_text}}."),
    ("de", "Kein Einzelprozess dominiert das Ergebnis bei {{contribution.groups.0.share_text}}."),
    ("fr", "Aucun groupe ne domine le résultat de {{contribution.groups.0.share_text}}."),
    ("es", "Ningún proceso domina por sí solo {{contribution.groups.0.share_text}} del resultado."),
    ("pt", "Nenhum processo domina sozinho {{contribution.groups.0.share_text}} do resultado."),
    # A hedge, which claims less than the top rather than denying it: *one of* the main ones is true of
    # index 0 and of index 2 alike, so declaring index 0 asserts more than the sentence does.
    ("en", "Packaging is one of the largest contributors at {{contribution.groups.0.share_text}}."),
    ("de", "Die Verpackung ist einer der größten Beiträge mit {{contribution.groups.0.share_text}}."),
    ("fr", "L'emballage est l'un des principaux contributeurs, {{contribution.groups.0.share_text}}."),
    ("es", "El envase es uno de los mayores contribuyentes, {{contribution.groups.0.share_text}}."),
    ("pt", "A embalagem é um dos maiores contribuintes, {{contribution.groups.0.share_text}}."),
)


def test_a_denied_or_hedged_superlative_is_told_nothing():
    """The measured price of the advisory: three of the 54 advisories on disk sat on sentences that deny or
    hedge concentration, and a wrong instruction costs more than a wrong flag."""
    for lang, text in _DENIED:
        # The fixture has to actually fire the word list, or this asserts nothing at all.
        low, _place = rc.folded(text)
        assert rc._mentions(rc._SUPERLATIVES[lang], low), text
        assert _advice(text, lang) == [], text


def test_the_denial_only_reaches_the_superlative_in_its_own_clause():
    """Both halves of the window, and both were measured against the 252 chapters on disk.

    Sentence-wide reach silences two correct advisories: the contrastive "nicht von der Distribution,
    **sondern** von der Produktion dominiert", where the comma the language requires ends the clause,
    and a negation belonging to a wholly different proposition. Backward-only, because a negation after
    the superlative regularly qualifies rather than denies it.
    """
    # A denial in an earlier clause leaves the claim in this one standing.
    later = _advice(
        "No single process dominates outright; the largest is still "
        "{{contribution.groups.0.share_text}} of the result."
    )
    assert len(later) == 1 and "{{rank:contribution.groups.0}}" in later[0]["detail"], later
    # The contrastive negation, which affirms what follows the comma.
    contrast = _advice(
        "Nicht von der Distribution, sondern von der Produktion dominiert, "
        "{{contribution.groups.0.share_text}}.", "de"
    )
    assert len(contrast) == 1, contrast
    # A negation *after* the superlative is not evidence about it.
    after = _advice(
        "Packaging dominates with a clarity it does not have elsewhere, "
        "{{contribution.groups.0.share_text}}."
    )
    assert len(after) == 1, after


def test_a_denied_word_beside_an_asserted_one_keeps_the_advisory():
    """Per word, not per sentence, and this is the sentence that decides it. "The largest single dataset
    is in fact **not** part of the dominant group at all: …" denies one of its two superlatives and
    asserts the other; silencing the sentence would lose a correct advisory, and the message must quote
    the word that survived rather than the one that was denied."""
    text = (
        "The largest single dataset is in fact not part of the dominant group at all: "
        "{{hotspots.0.share_text}} sits in end-of-life."
    )
    low, _place = rc.folded(text)
    spans = rc._mention_spans(rc._SUPERLATIVES["en"], low)
    denied = rc._denied_spans(spans, low, "en")
    assert len(spans) == 2 and len(denied) == 1, (spans, denied)
    assert low[next(iter(denied))[0]:next(iter(denied))[1]] == "dominant"
    found = _advice(text)
    assert len(found) == 1 and "{{rank:hotspots.0}}" in found[0]["detail"], found
    # …and the word quoted back is the asserted one. Read off the word list instead, the message on the
    # German original quoted *dominiert* — the one word in the sentence that claims nothing.
    assert "“largest”" in found[0]["detail"], found[0]["detail"]


def test_the_message_quotes_the_word_that_survived_even_when_the_denial_comes_first():
    """The German sentence on disk, shortened: the denied word stands *before* the asserted one, so a
    message built from the word list rather than from the surviving spans quotes "dominiert" — the one
    word in the sentence that claims nothing — beside advice that is about "größten"."""
    text = "Kein Einzelprozess dominiert: Die größten Beiträge liefert {{hotspots.0.share_text}}."
    low, _place = rc.folded(text)
    spans = rc._mention_spans(rc._SUPERLATIVES["de"], low)
    denied = rc._denied_spans(spans, low, "de")
    assert len(spans) == 2 and len(denied) == 1, (spans, denied)
    assert low[spans[0][0]:spans[0][1]] == "dominiert", "the denied word must come first, or this asserts nothing"
    found = _advice(text, "de")
    assert len(found) == 1 and "{{rank:hotspots.0}}" in found[0]["detail"], found
    assert "“größten”" in found[0]["detail"], found[0]["detail"]


def test_the_suppressor_applies_to_the_ordinal_branch_too():
    """A denial and a ranked claim in one sentence. The rank has to be read off the words that still
    assert something, or the denied one — which stands in no ordinal's clause — makes the reading
    non-unanimous and the sentence loses advice it should get."""
    text = "No single dataset dominates; the second-largest is {{hotspots.1.share_text}}."
    low, _place = rc.folded(text)
    spans = rc._mention_spans(rc._SUPERLATIVES["en"], low)
    assert len(rc._denied_spans(spans, low, "en")) == 1, spans
    assert low[spans[0][0]:spans[0][1]] == "dominates", "the denied word must come first"
    found = _advice(text)
    assert len(found) == 1 and "{{rank:hotspots.1}}" in found[0]["detail"], found
    # …and the word quoted back is the asserting one, on this branch as on 3b.
    assert "“largest”" in found[0]["detail"], found[0]["detail"]


def test_not_only_is_not_a_denial():
    """"not only X but also Y" affirms X, and a report on disk writes it. Blanked before the denials are
    matched, the same mechanic `_NOT_AN_ORDINAL` uses for a fraction."""
    found = _advice(
        "Packaging is not only the dominant group but the whole story, "
        "{{contribution.groups.0.share_text}}."
    )
    assert len(found) == 1, found


def test_the_suppressor_cannot_reach_the_rule_that_blocks():
    """The scoping *is* the safety argument. A denial in front of a superlative that sits on a non-top
    index must still be refused — the arithmetic contradicts the sentence whatever the wording does, and
    a suppressor that reached this would make a refusal fall silent."""
    text = "No single dataset dominates, and the largest is {{contribution.groups.1.share_text}}."
    kinds = [f["kind"] for f in rc.check_claims(text, SNAPSHOT, "en")]
    assert kinds == ["contradicted_claim"], kinds
    # And the same in a language whose denial is a listed pattern of its own.
    pt = "Nenhum processo domina, e o maior é {{contribution.groups.1.share_text}}."
    assert [f["kind"] for f in rc.check_claims(pt, SNAPSHOT, "pt")] == ["contradicted_claim"]


def test_every_ordinal_index_is_an_entry_of_the_ordinal_lists():
    """`_ORDINAL_INDEX` is a *reading* of the two ordinal lists and may never become a third, wider
    vocabulary — that is the constraint the whole suppressor was built under: no word list is widened."""
    for lang, mapping in rc._ORDINAL_INDEX.items():
        listed = set(rc._ORDINALS[lang]) | set(rc._ORDINALS_BEFORE_SUPERLATIVE.get(lang, ()))
        assert set(mapping) <= listed, (lang, set(mapping) - listed)
        assert set(mapping), lang
    assert set(rc._ORDINAL_INDEX) == set(rc._ORDINALS), "every report language needs the numbers"


def test_a_comparison_is_not_a_rank_claim():
    """The comparative exemption is the write-time rule's (V210/V211) and this inherits it: "A is more
    important than B" is a statement about two numbers, and there is no top rank in it to declare."""
    assert _advice(
        "{{contribution.groups.0.share_text}} est plus important que "
        "{{contribution.groups.1.share_text}} du total.", "fr"
    ) == []
    assert _advice(
        "{{contribution.groups.0.share_text}} is higher than {{contribution.groups.1.share_text}}."
    ) == []


def test_an_ordinal_names_the_rank_the_declaration_should_carry():
    """The gap the advisory inherited from the refusal, closed. "Distribution is the second-largest
    contributor" is a rank claim, `{{rank:contribution.groups.1}}` is its declaration, and the number
    comes out of the ordinal the chapter wrote — not out of the placeholder, not out of a count.

    The blocking rule is untouched: the sentence is still not refused, which `_advice` asserts for
    every case in this file."""
    found = _advice("Distribution is the second-largest contributor at {{contribution.groups.1.share_text}}.")
    assert len(found) == 1
    assert "{{rank:contribution.groups.1}}" in found[0]["detail"]
    assert "rank 2" in found[0]["detail"] and "Distribution" in found[0]["detail"]
    # The free-standing German ordinal, which is the shape that reaches the word list at all: a glued
    # compound ("zweitgrößte") has no word boundary in front of its superlative, so `_mentions` never
    # matches it and no rule here — this one or the one that blocks — ever sees the sentence.
    german = _advice("Der zweite Hauptbeitrag ist {{contribution.groups.1.share_text}}.", "de")
    assert len(german) == 1 and "{{rank:contribution.groups.1}}" in german[0]["detail"], german
    assert rc._mentions(rc._SUPERLATIVES["de"], rc.folded("Der zweitgrößte Beitrag ist X.")[0]) == []
    # Third, not second: the index is read off the word, so a different ordinal moves it.
    third = _advice("Use is the third-largest contributor at {{contribution.groups.2.share_text}}.")
    assert len(third) == 1 and "{{rank:contribution.groups.2}}" in third[0]["detail"]


def test_an_ordinal_that_names_no_rank_still_suggests_nothing():
    """"The next largest contributor" is a rank only relative to something chosen elsewhere, so there is
    no number to print — and `_ORDINAL_INDEX` deliberately has no entry for it. Same for the romance and
    German twins, and for an ordinal past the fifth, which the list does not carry at all."""
    assert "next" in rc._ORDINALS_BEFORE_SUPERLATIVE["en"], "the fixture needs the entry to disarm"
    assert "next" not in rc._ORDINAL_INDEX["en"], "and it must carry no number"
    assert _advice("The next largest contributor is {{contribution.groups.1.share_text}}.") == []
    assert _advice("Der nächste Hauptbeitrag ist {{contribution.groups.1.share_text}}.", "de") == []
    # An ordinal past the fifth is not in `_ORDINALS` at all, deliberately (see the note there), so it
    # disarms nothing and the rule that blocks judges the sentence exactly as it did before — which is
    # the pre-existing price, unchanged by anything here.
    sixth = "The sixth largest contributor is {{contribution.groups.1.share_text}}."
    assert [f["kind"] for f in rc.check_claims(sixth, SNAPSHOT, "en")] == ["contradicted_claim"]


def test_the_ordinal_and_the_cited_member_have_to_agree():
    """Where the words say rank 2 and the figure is index 0 the two disagree — and the ordinal is
    exactly why nothing here judges that. Suggesting either index would take the side the blocking rule
    declined to take, so the advisory says nothing."""
    assert _advice("Packaging is the second-largest contributor at {{contribution.groups.0.share_text}}.") == []


def test_a_fraction_or_a_preposition_never_becomes_an_index():
    """The `_NOT_AN_ORDINAL` work, held down on the *suggestion* side. "Ein Drittel" is a quantity,
    "segundo a norma" a preposition; neither may produce a rank, and neither may reach the blocking rule
    either — which is why the same blanking pass runs before both readings."""
    # German: the fraction is not an ordinal, so nothing disarms and the word list judges the sentence
    # as it always did (index 1 with index 0 leading — a refusal, not advice).
    fraction = "Ein Drittel entfällt auf den dominierenden Beitrag {{contribution.groups.1.share_text}}."
    kinds = [f["kind"] for f in rc.check_claims(fraction, SNAPSHOT, "de")]
    assert kinds == ["contradicted_claim"], kinds
    # Portuguese: the preposition likewise, and the refusal it exists to protect is unchanged.
    prep = "Segundo a norma ISO 14044, o grupo dominante é {{contribution.groups.1.share_text}}."
    assert [f["kind"] for f in rc.check_claims(prep, SNAPSHOT, "pt")] == ["contradicted_claim"]
    # And the very same word in its *ordinal* reading does produce the index — otherwise the blanking
    # would be paid for with the phrasing V213 kept.
    ordinal = _advice("A segunda maior contribuição é {{contribution.groups.1.share_text}}.", "pt")
    assert len(ordinal) == 1 and "{{rank:contribution.groups.1}}" in ordinal[0]["detail"], ordinal
    # Both readings in one sentence, which is what makes the blanking load-bearing here rather than
    # merely tidy: the preposition and a real ordinal naming a different rank. Unblanked, the two
    # numbers disagree and the sentence loses advice it should get.
    both = _advice(
        "Segundo a norma ISO 14044 o terceiro maior contribuinte é "
        "{{contribution.groups.2.share_text}}.", "pt"
    )
    assert len(both) == 1 and "{{rank:contribution.groups.2}}" in both[0]["detail"], both


def test_the_ordinal_has_to_stand_in_the_superlative_s_own_clause():
    """The one piece of advice the sentence-wide reading got wrong on the reports on disk, verbatim in
    shape: *segundo plano* is the idiom "in the background", the predominance belongs to a phase two
    clauses earlier, and the two happen to agree on the number 1 — so a sentence-wide reading printed a
    declaration naming the wrong member. Read clause by clause there is no ordinal beside the
    superlative and nothing is suggested."""
    text = (
        "O resultado concentra-se na distribuição, {{contribution.groups.0.share_text}} do total, "
        "com a embalagem em segundo plano ({{contribution.groups.1.share_text}}); "
        "essa predominância vem do transporte."
    )
    low, _place = rc.folded(text)
    # The fixture has to reach 3c at all: a superlative, and an ordinal that disarms the refusal.
    assert rc._mentions(rc._SUPERLATIVES["pt"], low) == ["predominância"], low
    assert rc._ordinal_hits(rc._ORDINALS["pt"], rc._SUPERLATIVES["pt"], low, "pt") == ["segundo"]
    assert _advice(text, "pt") == []


def test_a_rank_whose_member_is_gone_is_never_printed_as_advice():
    """`rank_name` is the renderer's own answer to "would this declaration print anything". A pin into
    the void resolves to nothing, and advice naming nothing is worse than none — the same guard 3b
    carries, on the branch that reads the number off an ordinal."""
    # No member is named in the sentence, so the bad pin below cannot also trip `misbound_names` and
    # leave this test passing for the wrong reason.
    text = "The second-largest contributor carries {{contribution.groups.1.share_text}} of the total."
    assert len(_advice(text)) == 1, "the fixture must produce advice when the pin resolves"
    gone = {"contribution.groups.1": {"key": "a group this report does not have"}}
    assert rd.rank_name("rank:contribution.groups.1", SNAPSHOT, gone) is None
    assert _advice(text, bindings=gone) == []


def test_a_rank_claim_about_a_variant_is_never_pointed_at_a_phase():
    """`subjects` is report order, so no declaration may name it — and the *nearest* size-ordered figure
    is somebody else's member. Measured on run 21's comparison chapter: "{{subjects.0.label}} is always
    the highest" would have been told to declare the phase breakdown standing beside it in the sentence.
    A variant therefore accounts for the word and suggests nothing."""
    text = (
        "Across the indicators the {{subjects.1.label}} variant is the highest, while packaging carries "
        "{{contribution.groups.0.share_text}}."
    )
    assert "subjects.1" in text and "contribution.groups.0" in text, "the fixture needs both, or this asserts nothing"
    assert _advice(text) == []
    # The write-time rule's own reading of the same sentence is unchanged: it never claimed anything here.
    assert rc.check_claims(text, SNAPSHOT, "en") == []


def test_a_figure_about_a_sub_lists_member_is_not_a_claim_about_its_parent():
    """`hotspots.0.inputs.0.name` splits at `hotspots`, because `hotspots.*.inputs` is no registered
    list — so the citation reads as "the leading hotspot" while the sentence says that hotspot's largest
    *input* is X. Three sentences on disk do exactly this."""
    text = "Inside that dataset the largest block is {{hotspots.0.inputs.0.name}}."
    assert rd.ranked_prefix("hotspots.0.inputs.0.name") == ("hotspots", 0, "inputs.0.name")
    assert _advice(text) == []


def test_an_aggregate_and_two_members_at_once_both_stay_silent():
    """An operand of a fold is not the subject of a superlative — the exemption `report_claims` already
    makes — and a word standing exactly between two ranked members has not said which one it is about.

    The tie is the difference from `_superlative_subjects`, which breaks one towards the figure because
    it has a chapter to refuse and the doubt belongs to the author. This one *asserts* what to write, so
    an unbroken tie is answered with silence.
    """
    assert _advice(
        "Together the top two are the dominant part, at "
        "{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} %."
    ) == []
    tie = "{{contribution.groups.0.key}} dominates {{hotspots.0.name}}."
    assert _advice(tie) == []
    # …and each half of it on its own is a finding, or the line above would pass for the wrong reason.
    assert len(_advice("{{contribution.groups.0.key}} dominates.")) == 1
    assert len(_advice("Dominated by {{hotspots.0.name}}.")) == 1
    # A nameless anchor tied with a nameable one goes to silence, which is the half of the tie rule that
    # differs from `_superlative_subjects`: there the figure wins, because that rule refuses.
    fold = (
        "{{sum(contribution.groups.0.share_percent, contribution.groups.1.share_percent)}} "
        "dominates {{hotspots.0.name}}."
    )
    assert _advice(fold) == []


def test_where_the_arithmetic_contradicts_the_sentence_only_the_refusal_is_reported():
    """One problem, one finding. The refusal already names the fix, and telling the author to declare a
    rank the data denies would be a second finding pointing the other way."""
    wrong = "The balance is dominated by {{contribution.groups.1.share_text}} of the total."
    found = rc.check_claims(wrong, SNAPSHOT, "en")
    assert [f["kind"] for f in found] == ["contradicted_claim"]


def test_a_declaration_that_would_print_a_gap_is_never_suggested():
    """The last guard, and the one that makes the message safe to follow blindly: what would be printed
    is asked of `rank_name`, the renderer's own answer. A chapter pinned to a member that has left the
    list is exactly where a positional suggestion would be a hole in the document."""
    gone = {"contribution.groups.0": {"key": "Filling"}}
    assert rd.resolve(PROSE, SNAPSHOT, "en", gone)[1], "the pin must be dead, or this asserts nothing"
    assert _advice(PROSE, bindings=gone) == []
    # Alive again with the pin the chapter would really carry.
    assert len(_advice(PROSE, bindings=rd.bindings_for(PROSE, SNAPSHOT))) == 1


def test_the_leaders_name_is_only_offered_while_index_0_still_means_the_leader():
    """The name in the sentence and the member the declaration would print have to be the same member.

    `head.0` is a *citation site*, not a position: a chapter can pin it to whichever member it was
    written about. Where it points somewhere else, "Packaging, the largest phase" and
    `{{rank:contribution.groups.0}}` name two different things, and the suggestion would put the wrong
    name into the sentence — the V182/V221 failure, in the shape of advice.
    """
    text = "Packaging, the largest phase, is followed by {{contribution.groups.1.share_text}}."
    pinned_elsewhere = {"contribution.groups.0": {"key": "Use"}}
    printed = rd.rank_name("rank:contribution.groups.0", SNAPSHOT, pinned_elsewhere)
    assert printed == "Use", "the pin must point away from the leader, or this asserts nothing"
    assert _advice(text, bindings=pinned_elsewhere) == []
    # Unpinned, index 0 *is* the leader and the same sentence gets its suggestion.
    found = _advice(text)
    assert len(found) == 1 and "“Packaging”" in found[0]["detail"]


def test_the_suggestion_can_never_refuse_a_chapter():
    """The one property nothing here may break."""
    assert rc.ADVISORY_KIND in rpr.ADVISORY_FINDINGS
    verdict = rpr.check_proposal(PROSE, {"kind": "prose"}, SNAPSHOT)
    assert _advice(PROSE), "the fixture must produce the finding, or this asserts nothing"
    assert verdict["ok"] and any(f["kind"] == rc.ADVISORY_KIND for f in verdict["findings"])


def test_the_suggestion_speaks_the_report_language_and_quotes_the_chapters_own_spelling():
    """The word list is per language and the fold is the matcher's, so the message has to quote the
    sentence rather than the list — a message naming a word that is not in the text sends a reader, or a
    correction model, looking for it."""
    found = _advice("Le bilan est dominé par {{contribution.groups.0.share_text}} du total.", "fr")
    assert len(found) == 1
    assert "“dominé”" in found[0]["detail"] and "{{rank:contribution.groups.0}}" in found[0]["detail"]
    spanish = _advice("La fase de uso sigue dominando {{contribution.groups.0.key}}.", "es")
    assert len(spanish) == 1 and "“dominando”" in spanish[0]["detail"]
