"""The prompt of a written chapter belongs to the author.

The store has carried `prompt_override` from the start and the UI transported it, but there was no way
to *set* it and — the part that actually bites — no way to clear it: the update endpoint dropped `null`
before the store ever saw it, so "back to the standard prompt" returned 200 and changed nothing.
"""
from __future__ import annotations

from prism_lca.engine.report_prompts import DEFAULT_PROMPTS, effective_prompt


def _report(client, token) -> tuple[str, str]:
    r = client.post(
        "/api/v1/report/create",
        json={"database": "tp", "name": "prompts", "sections": [{"kind": "prose"}]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    return body["id"], body["sections"][0]["id"]


def test_the_builtin_prompts_are_readable(client, token, project):
    """Without this the override field is an empty box: you cannot depart from a text you cannot see."""
    r = client.get("/api/v1/report/prompts", headers=token)
    assert r.status_code == 200
    prompts = r.json()["prompts"]
    assert set(prompts) == set(DEFAULT_PROMPTS)
    assert "ISO 14044" in prompts["prose"]


def test_an_override_is_stored_and_reaches_the_brief(client, token, project):
    report_id, section_id = _report(client, token)
    mine = "Write it as a single paragraph, in the plainest language you can manage."
    r = client.post(
        f"/api/v1/report/one/tp/{report_id}/sections/{section_id}",
        json={"kind": "prose", "prompt_override": mine},
        headers=token,
    )
    assert r.status_code == 200
    assert r.json()["prompt_override"] == mine
    # The brief is what the writer and the gate both work from, so that is where it has to land.
    assert effective_prompt(r.json()).startswith(mine)


def test_clearing_the_override_goes_back_to_the_standard_prompt(client, token, project):
    """The regression this file exists for: `exclude_none` swallowed the null and the request looked
    like it had worked."""
    report_id, section_id = _report(client, token)
    url = f"/api/v1/report/one/tp/{report_id}/sections/{section_id}"
    client.post(url, json={"kind": "prose", "prompt_override": "mine"}, headers=token)
    r = client.post(url, json={"kind": "prose", "prompt_override": None}, headers=token)
    assert r.status_code == 200
    assert r.json()["prompt_override"] is None
    assert effective_prompt(r.json()) == DEFAULT_PROMPTS["prose"]


def test_a_patch_still_leaves_unmentioned_fields_alone(client, token, project):
    """`exclude_unset` must not turn every update into a full replacement — a title set earlier has to
    survive a later text-only patch."""
    report_id, section_id = _report(client, token)
    url = f"/api/v1/report/one/tp/{report_id}/sections/{section_id}"
    client.post(url, json={"kind": "prose", "title": "Interpretation", "prompt_override": "mine"}, headers=token)
    r = client.post(url, json={"kind": "prose", "text": "Some prose."}, headers=token)
    assert r.json()["title"] == "Interpretation"
    assert r.json()["prompt_override"] == "mine"
    assert r.json()["text"] == "Some prose."


def test_the_project_default_structure_carries_the_prompts(client, token, project):
    """A structure without its prompts is half a template — the chapters would come back with the
    standard assignment and nobody would know why the output changed."""
    report_id, section_id = _report(client, token)
    client.post(
        f"/api/v1/report/one/tp/{report_id}/sections/{section_id}",
        json={"kind": "prose", "prompt_override": "house style", "extra_instructions": "no adjectives"},
        headers=token,
    )
    client.post(
        "/api/v1/report/defaults",
        json={"sections": [{"kind": "prose", "prompt_override": "house style", "extra_instructions": "no adjectives"}]},
        headers=token,
    )
    fresh = client.post(
        "/api/v1/report/create", json={"database": "tp", "name": "second"}, headers=token
    ).json()
    assert fresh["sections"][0]["prompt_override"] == "house style"
    assert fresh["sections"][0]["extra_instructions"] == "no adjectives"


# ---- the brief now warns before writing, instead of the gate objecting afterwards ------------
def test_the_brief_names_the_reason_a_comparative_claim_is_not_allowed():
    """C7: the document already carried the ISO 14044 §7.3.3 note; the writer never knew. A writer told
    afterwards has to rewrite the sentence — one told beforehand does not write it."""
    from prism_lca.engine.report_prompts import cautions

    report = {"options": {"intended_public": True}}
    data = {
        "study": {},
        "subjects": [
            {"code": "a", "results": [{"method_label": "m", "score": 1.0, "unit": "kg"}]},
            {"code": "b", "results": [{"method_label": "m", "score": 2.0, "unit": "kg"}]},
        ],
    }
    text = " ".join(cautions(report, data))
    assert "critical review" in text and "never write that one variant is better" in text
    # With a review confirmed the prohibition goes away — the answer, not a sentence about it: the
    # text is usually a denial, and reading a denial as consent used to lift the prohibition (V191).
    data["study"]["critical_review_done"] = "yes"
    assert "critical review" not in " ".join(cautions(report, data))


def test_the_brief_states_the_significance_threshold_and_the_trade_off():
    from prism_lca.engine.report_prompts import cautions

    data = {
        "study": {},
        "subjects": [
            {"label": "A", "code": "a", "results": [{"method_label": "m", "score": 1.0, "unit": "kg"}]},
            {"label": "B", "code": "b", "results": [{"method_label": "m", "score": 2.0, "unit": "kg"}]},
        ],
        "trade_offs": [{"method_label": "water", "highest": "B", "score": 5.0}],
    }
    text = " ".join(cautions({"options": {"significance_percent": 7}}, data))
    assert "7 %" in text and "water → B" in text


def test_a_single_subject_report_is_told_it_cannot_compare():
    from prism_lca.engine.report_prompts import cautions

    data = {"study": {}, "subjects": [{"code": "a", "results": [{"method_label": "m", "score": 1.0, "unit": "kg"}]}]}
    assert "supports a comparison" in " ".join(cautions({}, data))


def test_a_deterministic_chapter_is_briefed_as_a_comment_and_carries_the_functional_unit():
    from prism_lca.engine.report_prompts import build_brief

    data = {"study": {"functional_unit": "1 carrier bag"}}
    brief = build_brief({"id": "s", "kind": "interpretation_checks"}, {"lang": "en"}, data)
    assert brief["commentary"] is True
    assert "1 carrier bag" in brief["invariants"]
    assert "single score" in brief["invariants"]  # C3, so the writer knows before the derivation refuses
    assert build_brief({"id": "s", "kind": "prose"}, {"lang": "en"}, data)["commentary"] is False
