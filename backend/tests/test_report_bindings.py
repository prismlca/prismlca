"""Ranked placeholders keep meaning the same thing.

The question: hotspots are sorted by magnitude, so `{{hotspots.0.name}}` means "the largest one
*today*". Recompute the model, let raw materials overtake incineration, and the sentence "the dominant
contributor is {{hotspots.0.name}}" becomes a statement about a different dataset — grammatically
intact, numerically consistent, and wrong. That is the worst kind of defect: nothing looks broken.

A stored chapter therefore records *which* member each ranked index meant, and a later render resolves
by that identity. The same applies to contribution groups, inventory flows, results and subjects: every
one of them is ordered by a number rather than by structure.
"""
from __future__ import annotations

from prism_lca.engine import report_bindings as rb
from prism_lca.engine import report_data as rd


def _data(order: list[str]) -> dict:
    impacts = {"incineration": 0.062, "granulate": 0.050}
    return {
        "hotspots": [
            {"name": n, "database": "ecoinvent-3.12-cutoff", "code": n[:3], "share_text": f"{impacts[n] * 100:.1f} %"}
            for n in order
        ]
    }


def test_a_bound_index_follows_the_process_not_the_position():
    text = "The dominant contributor is {{hotspots.0.name}} at {{hotspots.0.share_text}}."
    written_against = _data(["incineration", "granulate"])
    bindings = rd.bindings_for(text, written_against)
    assert bindings == {"hotspots.0": {"database": "ecoinvent-3.12-cutoff", "code": "inc", "name": "incineration"}}

    # The ranking flips — without bindings the sentence would now name the granulate.
    reordered = _data(["granulate", "incineration"])
    plain, _ = rd.resolve(text, reordered)
    assert "granulate" in plain  # the defect, shown for what it is

    bound, missing = rd.resolve(text, reordered, "en", bindings)
    assert "incineration" in bound and "granulate" not in bound
    assert missing == []


def test_correcting_one_sentence_does_not_re_point_the_others():
    """A correction re-bound the whole chapter, which is how a safe hole became a wrong figure.

    Two cosmetic edits elsewhere in the contribution chapter moved four named datasets onto other
    datasets' numbers: "the parcel last mile (…, 16.7 %)" where 16.7 % was the natural-gas heat, and a
    containerboard that had dropped out of the ranking printing natural gas's share. The visible
    "[missing: …]" disappeared with it, the staleness badge went green and the render gate — which had
    correctly blocked the PDF — was satisfied. A pin may only move when the sentence is rewritten.
    """
    text = "The largest is {{hotspots.0.name}} at {{hotspots.0.share_text}}, then {{hotspots.1.name}}."
    original = rd.bindings_for(text, _data(["incineration", "granulate"]))

    # The ranking flips and the author corrects only the wording — same placeholders.
    corrected = text.replace("The largest is", "A leading contributor is")
    reordered = _data(["granulate", "incineration"])
    after = rd.bindings_for(corrected, reordered, keep=original)
    assert after == original, "an untouched sentence must keep pointing at the member it was about"

    bound, missing = rd.resolve(corrected, reordered, "en", after)
    assert "A leading contributor is incineration at 6.2 %" in bound and missing == []

    # An index the patch genuinely introduces — one the chapter had no pin for — is bound against
    # today's data, so a correction can still cite something new.
    grown = corrected + " Also {{hotspots.2.name}}."
    wider = _data(["granulate", "incineration"])
    wider["hotspots"].append({"name": "extrusion", "database": "ecoinvent-3.12-cutoff", "code": "ext"})
    fresh = rd.bindings_for(grown, wider, keep=original)
    assert fresh["hotspots.2"]["name"] == "extrusion"
    assert fresh["hotspots.0"] == original["hotspots.0"]  # …without disturbing the old pins


def test_a_bound_member_that_disappeared_is_reported_not_replaced():
    """The one thing worse than a stale number: the same sentence about a different thing."""
    text = "The dominant contributor is {{hotspots.0.name}}."
    bindings = rd.bindings_for(text, _data(["incineration", "granulate"]))
    gone = {"hotspots": [{"name": "extrusion", "database": "d", "code": "ext"}]}
    resolved, missing = rd.resolve(text, gone, "en", bindings)
    assert "extrusion" not in resolved
    assert "[missing:" in resolved
    assert missing == ["hotspots.0.name"]


def test_every_ordered_list_is_covered_not_just_hotspots():
    for path, data in [
        ("contribution.groups.1.share_text", {"contribution": {"groups": [{"key": "a"}, {"key": "b"}]}}),
        ("inventory.flows.0.flow", {"inventory": {"flows": [{"flow": "CO2", "compartment": "air"}]}}),
        ("results.0.score", {"results": [{"method_label": "IPCC", "score": 1.0}]}),
        # `variant` and not the (code, scenario) pair, because that is what identifies a variant now
        # (V221) — the pair collapsed to the code for the baseline and matched its sisters. Written as
        # `build_data` writes it: a fixture in the old shape would have this test asserting that a
        # snapshot nobody produces still binds.
        ("subjects.0.label", {"subjects": [{"code": "c1", "variant": "c1", "label": "Baseline"}]}),
    ]:
        bindings = rd.bindings_for("{{" + path + "}}", data)
        assert bindings, f"{path} was not bound"


def test_an_unranked_path_is_left_alone():
    """Binding a path that is not a ranking would only add a way to go wrong."""
    data = {"study": {"goal": "screening"}, "amount": 1.0}
    assert rd.bindings_for("{{study.goal}} for {{amount}}", data) == {}


def test_a_reordering_alone_marks_the_chapter_stale():
    """Belt and braces: even with bindings doing the right thing, the author is told the ranking moved,
    because a sentence like "the two dominant phases" may no longer be the right story. Judged by the
    staleness components — the whole-data `fingerprint` this test used to exercise is retired."""
    from prism_lca.engine import report_staleness as rs

    text = "{{hotspots.0.name}} leads."
    bindings = rd.bindings_for(text, _data(["incineration", "granulate"]))
    before = rs.components(text, bindings, {}, _data(["incineration", "granulate"]))
    after = rs.components(text, bindings, {}, _data(["granulate", "incineration"]))
    assert before["ranks"] != after["ranks"]


def test_values_keys_are_scoped_per_section():
    """Two chapters citing the same ranked token with different bindings used to share one values key;
    the last-rendered chapter's figure won both #pval sites. The bare key stays for exported bundles."""
    data = _data(["incineration", "granulate"])
    values: dict[str, str] = {}
    text = "{{hotspots.0.name}}"
    a = rd.resolve(text, data, "en", {"hotspots.0": {"name": "incineration"}}, values, scope="sec-a")[0]
    b = rd.resolve(text, data, "en", {"hotspots.0": {"name": "granulate"}}, values, scope="sec-b")[0]
    assert '#pval("sec-a:hotspots.0.name")' in a and '#pval("sec-b:hotspots.0.name")' in b
    assert values["sec-a:hotspots.0.name"] == "incineration"
    assert values["sec-b:hotspots.0.name"] == "granulate"
    assert "hotspots.0.name" in values  # the compatibility key


# --- V154: the per-indicator breakdowns are ranked lists too -------------------------------------
#
# `contribution.groups` is the breakdown of the leading indicator; `contributions.<i>.groups` is the
# same breakdown per indicator, and it was not registered. In a solar-lamp run the use
# phase overtook production, and the LCIA chapter printed "production carries the largest share — 59.0 %
# of the climate score, 68.9 % of water use and 77.3 % of land use". Those are the *use* phase's
# figures. Five numbers under the wrong name, in a delivered PDF, with nothing to warn anyone: the
# checker cannot report a rank change for a path it does not recognise as ranked.


def _phases(order: list[tuple[str, float]]) -> list[dict]:
    return [{"key": k, "share_percent": v, "share_text": f"{v} %"} for k, v in order]


def _indicators(order: list[tuple[str, float]]) -> dict:
    """Three indicators whose groups all rank the same way — as they did in the run."""
    return {"contributions": [{"groups": _phases(order)} for _ in range(3)]}


def test_a_per_indicator_group_is_a_ranked_path():
    assert rd.ranked_prefix("contributions.0.groups.1.share_text") == (
        "contributions.0.groups",
        1,
        "share_text",
    )
    assert rd.identity_fields("contributions.2.groups") == ("key",)
    assert rd.is_magnitude_ranked("contributions.2.groups")
    # `contributions` alone indexes into the indicators, which are method order, not a ranking.
    assert rd.registry_key("contributions") == "contributions"


def test_each_indicator_keeps_its_own_pin():
    text = "{{contributions.0.groups.0.share_text}} and {{contributions.1.groups.0.share_text}}"
    bindings = rd.bindings_for(text, _indicators([("Production", 73.3), ("Use", 20.7)]))
    assert bindings == {
        "contributions.0.groups.0": {"key": "Production"},
        "contributions.1.groups.0": {"key": "Production"},
    }, "the literal head is the binding key, so indicator 0 and 1 are pinned separately"


def test_a_phase_swap_no_longer_prints_the_other_group_s_figure():
    """The V154 defect, verbatim: production named, use phase's number printed."""
    text = "production carries {{contributions.0.groups.0.share_text}} of the climate score"
    written_against = _indicators([("Production", 73.3), ("Use", 20.7)])
    bindings = rd.bindings_for(text, written_against)

    swapped = _indicators([("Use", 59.0), ("Production", 37.1)])
    unbound, _ = rd.resolve(text, swapped)
    assert "59.0 %" in unbound  # what the delivered PDF said, under the name "production"

    bound, missing = rd.resolve(text, swapped, "en", bindings)
    assert "37.1 %" in bound and "59.0 %" not in bound
    assert missing == []


def test_a_phase_swap_is_reported_as_a_rank_change():
    """And the author hears about it — a bound figure is right, but "carries the largest share" is not."""
    from prism_lca.engine import report_staleness as rs

    text = "production carries {{contributions.0.groups.0.share_text}} of the climate score"
    written_against = _indicators([("Production", 73.3), ("Use", 20.7)])
    bindings = rd.bindings_for(text, written_against)
    swapped = _indicators([("Use", 59.0), ("Production", 37.1)])

    section = {
        "text": text,
        "bindings": bindings,
        "based_on": rs.components(text, bindings, {}, written_against),
    }
    found = rs.verdicts(section, {}, swapped, [])
    assert any(
        f["kind"] == "ranks" and f.get("path") == "contributions.0.groups.0" for f in found
    ), found


def test_the_per_indicator_hotspots_are_a_ranked_list_of_datasets():
    """V161: the brief now carries the datasets behind *each* indicator, so they need the same pinning.

    The top-level `hotspots` is the lead indicator's list and nothing else. A chapter told to compare
    three indicators had evidence for one, filled the gap from its own knowledge, and named two
    datasets that are not in the model — with shares (apple-juice run).
    """
    from prism_lca.engine import report_claims as rc

    def water(order: list[tuple[str, float]]) -> dict:
        return {
            "contributions": [
                {"hotspots": [
                    {"name": n, "database": "ecoinvent", "code": n[:4], "share_percent": v,
                     "share_text": f"{v} %"}
                    for n, v in order
                ]}
            ]
        }

    assert rd.registry_key("contributions.0.hotspots") == "contributions.*.hotspots"
    assert rd.identity_fields("contributions.0.hotspots") == ("database", "code", "name")
    assert rd.is_magnitude_ranked("contributions.0.hotspots")

    text = "market for urea leads with {{contributions.0.hotspots.0.share_text}}"
    written = water([("market for urea", 13.9), ("market for melamine", 12.2)])
    bindings = rd.bindings_for(text, written)
    assert bindings["contributions.0.hotspots.0"]["name"] == "market for urea"

    swapped = water([("market for melamine", 14.4), ("market for urea", 11.1)])
    bound, missing = rd.resolve(text, swapped, "en", bindings)
    assert "11.1 %" in bound and missing == []
    # …and the name/figure rule reaches it too, which it could not while the field map was keyed by
    # the literal head: `contributions.0.hotspots` found nothing under `hotspots`. (Its sibling
    # `contributions.*.groups` stays out of that map on purpose — see `_NAME_FIELD`.)
    assert rc.misbound_names(
        "market for melamine leads with {{contributions.0.hotspots.0.share_text}}", swapped, bindings
    )


# --- Improvement 1: the registry is a list someone has to maintain -------------------------------


def test_every_identity_bearing_list_in_the_report_data_is_registered():
    """V154 slipped through because `RANKED_LISTS` is hand-maintained and nobody notices a gap.

    This walks the *shape* of a report data snapshot instead: any list whose members carry one of the
    known identity field sets is a ranked list and must be registered, or a sentence about it can
    silently change meaning. Adding a new breakdown to the snapshot without registering it fails here
    rather than in a customer's PDF.
    """
    snapshot = {
        "results": [{"method_label": "EF v3.1 / climate change"}],
        "subjects": [
            {"code": "abc", "scenario": None, "label": "Baseline",
             "results": [{"method_label": "EF v3.1 / climate change", "score": 1.0}]}
        ],
        "hotspots": [{"database": "ecoinvent", "code": "x", "name": "market for silicon"}],
        "contribution": {"groups": [{"key": "Production", "share_percent": 73.3}]},
        # The indicator's own label belongs in here: without it the walk cannot see that the *outer*
        # index of `contributions.3.groups.0` identifies something either (V186).
        "contributions": [
            {
                "method_label": "EF v3.1 / climate change",
                "groups": [{"key": "Production", "share_percent": 73.3}],
                "hotspots": [{"database": "ecoinvent", "code": "x", "name": "market for silicon"}],
                "subjects": [{"label": "Baseline", "groups": [{"key": "Production"}]}],
            }
        ],
        "contribution_subjects": [{"label": "Baseline", "groups": [{"key": "Production"}]}],
        "checks": {"sensitivity": [{"method_label": "EF v3.1 / climate change", "spread_percent": 8.4}]},
        "trade_offs": [{"method_label": "EF v3.1 / water use", "highest": "Refill"}],
        "method_references": [{"name": "EF v3.1", "url": "https://example.org"}],
        "inventory": {"flows": [{"flow": "Carbon dioxide, fossil", "compartment": "air"}]},
        # The author's own lists. No rank, but very much an identity: a parameter's index is where its
        # name sorts, and creating one re-sorts everything after it (V182). The three that follow were
        # left out while the search for a translation-proof identity was open; each of them carries an
        # identifier the translation walk never touches, so each of them is in (V194).
        "parameters": [{"name": "m_steel", "amount": 0.08}],
        "scenarios": [{"id": "913c47f1e1024cd9", "name": "High recycling rate", "overrides": {}}],
        "foreground": [{"code": "abc", "name": "Mould remover, packed", "description": ""}],
        "background_datasets": [
            {"database": "ecoinvent-3.12-cutoff", "code": "def", "name": "market for citric acid"}
        ],
    }
    known = {frozenset(fields) for fields in rd.RANKED_LISTS.values()}

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                yield from walk(v, f"{path}.{k}" if path else k)
        elif isinstance(node, list) and node and isinstance(node[0], dict):
            fields = frozenset(node[0])
            if any(ident <= fields for ident in known):
                yield path
            for i, item in enumerate(node):
                yield from walk(item, f"{path}.{i}")

    for path in walk(snapshot, ""):
        assert rd.registry_key(path) in rd.RANKED_LISTS, (
            f"{path!r} has members with a stable identity but is not in RANKED_LISTS — a sentence "
            f"about it can change meaning without anything noticing (V154)"
        )


# --- V180: which pins a hand edit is allowed to move ---------------------------------------------


def test_a_hand_edit_moves_only_the_pins_of_the_sentences_it_rewrote():
    """The chapter as a whole is not the unit of a rewrite — the sentence is.

    Saving a hand edit used to re-bind everything the chapter cites. The report that showed it up named
    two incineration datasets in plain words and cited one of them through `{{hotspots.2.share_text}}`
    after that process had slipped to rank six; a typo fixed three paragraphs above would have printed
    rank two's share under the PET dataset's name, and the badge that says "check this" would have gone
    green in the same breath.
    """
    from prism_lca.engine import report_patch as rp

    before = (
        "The incineration of PET contributes {{hotspots.0.share_text}}. "
        "Granulate production follows. "
        "A sentence with a typpo."
    )
    written_against = _data(["incineration", "granulate"])
    pins = rd.bindings_for(before, written_against)

    after = before.replace("typpo", "typo")
    reordered = _data(["granulate", "incineration"])
    keep = rp.surviving_bindings(before, after, pins)
    assert keep == pins, "the claim sentence stands untouched, so its pin may not move"
    assert rd.bindings_for(after, reordered, keep=keep) == pins

    # Rewrite the claim itself and it is a claim about today's data again.
    retargeted = after.replace("The incineration of PET contributes", "The largest contributor is now")
    moved = rp.surviving_bindings(before, retargeted, pins)
    assert moved == {}
    assert rd.bindings_for(retargeted, reordered, keep=moved)["hotspots.0"]["name"] == "granulate"


def test_reflowing_whitespace_is_not_a_rewrite():
    """An editor that joins or re-wraps lines must not count as retargeting every claim in them."""
    from prism_lca.engine import report_patch as rp

    before = "The largest is {{hotspots.0.name}}.\nGranulate follows."
    after = "The largest is {{hotspots.0.name}}.\n\n   Granulate follows.\n"
    pins = rd.bindings_for(before, _data(["incineration", "granulate"]))
    assert rp.surviving_bindings(before, after, pins) == pins


def test_a_pin_a_surviving_sentence_still_cites_is_kept_even_if_another_sentence_moved():
    """Two sentences, one pin: the claim that is still on the page decides what it means."""
    from prism_lca.engine import report_patch as rp

    before = "The largest is {{hotspots.0.name}}. It carries {{hotspots.0.share_text}} of the total."
    after = before.replace("It carries", "That process carries")
    pins = rd.bindings_for(before, _data(["incineration", "granulate"]))
    assert rp.surviving_bindings(before, after, pins) == pins


# --- V182: a parameter is a member, not a position ----------------------------------------------
#
# The PVC-window report wrote its executive summary as "…, Uw =
# {{parameters.16.amount}} {{parameters.16.unit}}, an element mass of {{parameters.15.amount}}
# {{parameters.15.unit}}, …" and printed it correctly: 0.92 W/m2K and 30 kg. The parameter list is
# sorted by name, so those indices are wherever `uw` and `mass_total` happen to sort. Adding one
# parameter that sorts ahead of them — `a_frame_area`, an ordinary modelling action, no
# recomputation involved — turned the same sentence into "Uw = 30 kg, an element mass of 0.85 kg",
# printed with the same authority. Nothing reported it: `parameters` was not in `RANKED_LISTS`, so
# there was no member to lose, no rank to move and nothing for the staleness check to name.

#: The window model's parameters, by name — the order the list arrives in.
#: `mass_total` lands on 15 and `uw` on 16, which is how the report came to name them by those numbers.
_WINDOW: dict[str, tuple[float, str] | None] = {
    "dist_distribution": (150.0, "km"),
    "dist_eol": (50.0, "km"),
    "dist_supply": (420.0, "km"),
    "eol_incineration": (0.35, "-"),
    "eol_landfill": (0.05, "-"),
    "eol_recycling": (0.6, "-"),
    "frame_depth": (0.07, "m"),
    "frame_share": (0.42, "-"),
    "glass_share": (0.48, "-"),
    "heating_days": (220.0, "d"),
    "lifetime_years": (40.0, "a"),
    "mass_frame": (12.6, "kg"),
    "mass_glass": (14.4, "kg"),
    "mass_hardware": (1.8, "kg"),
    "mass_seals": (1.2, "kg"),
    "mass_total": (30.0, "kg"),
    "uw": (0.92, "W/m2K"),
}


def _window(**changes: tuple[float, str] | None) -> dict:
    """The report's data with the window's parameters, sorted by name as the model view sorts them.

    `changes` is what a modeller does between two renders and nothing more exotic:
    `a_frame_area=(1.6, "m2")` adds one ahead of the rest, `uw=None` deletes it,
    `uw=(0.85, "W/m2K")` turns its value down, and the two together are a rename.
    """
    values = {**_WINDOW, **changes}
    return {
        "study": {"functional_unit": "1 window element"},
        "parameters": [
            {"name": name, "amount": value[0], "unit": value[1]}
            for name, value in sorted(values.items())
            if value is not None
        ],
    }


SUMMARY = (
    "The element is assessed with Uw = {{parameters.16.amount}} {{parameters.16.unit}}, an element "
    "mass of {{parameters.15.amount}} {{parameters.15.unit}}."
)


def test_a_parameter_is_identified_by_its_name_and_carries_no_rank():
    assert rd.ranked_prefix("parameters.16.amount") == ("parameters", 16, "amount")
    assert rd.identity_fields("parameters") == ("name",)
    # Index 16 is where "uw" sorts, not how big it is. A superlative or a rank-drift finding about it
    # would be a statement about the alphabet.
    assert not rd.is_magnitude_ranked("parameters")


def test_adding_a_parameter_ahead_of_the_others_no_longer_moves_the_sentence():
    """The measured case, verbatim: one added parameter, and Uw was printed as 30 kg."""
    written_against = _window()
    bindings = rd.bindings_for(SUMMARY, written_against)
    assert bindings["parameters.16"] == {"name": "uw"}
    assert bindings["parameters.15"] == {"name": "mass_total"}

    shifted = _window(a_frame_area=(1.6, "m2"))
    plain, _ = rd.resolve(SUMMARY, shifted)
    assert "Uw = 30 kg" in plain  # the defect, shown for what it is
    assert "mass of 0.85" not in plain  # …with the runner-up: mass_seals' 1.2 kg, not the element's

    bound, missing = rd.resolve(SUMMARY, shifted, "en", bindings)
    assert "Uw = 0.92 W/m2K" in bound and "mass of 30 kg" in bound
    assert missing == []


def test_a_shifted_parameter_is_not_a_finding_at_all():
    """Nothing changed for the reader, so nothing may be asked of the author."""
    from prism_lca.engine import report_staleness as rs

    written_against = _window()
    bindings = rd.bindings_for(SUMMARY, written_against)
    section = {
        "text": SUMMARY,
        "bindings": bindings,
        "based_on": rs.components(SUMMARY, bindings, {}, written_against),
    }
    assert rs.verdicts(section, {}, _window(a_frame_area=(1.6, "m2")), []) == []


def test_turning_a_parameter_down_asks_for_nothing():
    """A parameter's value moving is what parameters are for — the placeholder resolves it again."""
    from prism_lca.engine import report_staleness as rs

    written_against = _window()
    bindings = rd.bindings_for(SUMMARY, written_against)
    section = {
        "text": SUMMARY,
        "bindings": bindings,
        "based_on": rs.components(SUMMARY, bindings, {}, written_against),
    }
    found = rs.verdicts(section, {}, _window(uw=(0.85, "W/m2K")), [])
    assert [f["kind"] for f in found] == ["values"]
    assert rs.worst(found) == "none"


def test_a_u_value_has_no_size_class():
    """The finding the run actually produced was "parameters.15.amount moved from 20–50 % to <5 %".

    An element mass sorted into percentage classes, with wording advice about "dominates". It came
    from two places at once, and both are closed: the figure is pinned so it does not move, and a
    number the data gives a unit to is not a share. The `percent(…)` in the sentence *beside* it is
    what gave it a band — the size classes were read off the whole chapter.
    """
    from prism_lca.engine import report_staleness as rs

    text = (
        SUMMARY + " Glazing accounts for {{percent(parameters.12.amount, parameters.15.amount)}} of "
        "the element mass, and packaging for {{contribution.groups.0.share_percent}} % of the score."
    )
    data = {**_window(), "contribution": {"groups": [{"key": "Packaging", "share_percent": 60.0}]}}
    bands = rs.components(text, rd.bindings_for(text, data), {}, data)["bands"]
    assert "band" not in bands["parameters.16.amount"], "a U-value in W/m2K is not 0–5 % of anything"
    assert "band" not in bands["parameters.15.amount"]
    assert bands["contribution.groups.0.share_percent"]["band"] == ">50 %"


def test_a_deleted_parameter_is_named_in_the_finding():
    from prism_lca.engine import report_staleness as rs

    written_against = _window()
    bindings = rd.bindings_for(SUMMARY, written_against)
    without_uw = _window(uw=None)

    # The hole is visible before it is printed…
    _resolved, missing = rd.resolve(SUMMARY, without_uw, "en", bindings)
    assert missing == ["parameters.16.amount", "parameters.16.unit"]

    section = {
        "text": SUMMARY,
        "bindings": bindings,
        "based_on": rs.components(SUMMARY, bindings, {}, written_against),
    }
    found = rs.verdicts(section, {}, without_uw, [])
    members = [f for f in found if f["kind"] == "members"]
    assert len(members) == 1 and members[0]["severity"] == "rewrite"
    assert "name=uw" in members[0]["message"]
    # …and no rank finding beside it: the parameter list never expressed size.
    assert not [f for f in found if f["kind"] == "ranks"]
    assert rs.worst(found) == "rewrite"


def test_a_renamed_parameter_is_a_member_that_is_gone():
    """The name is the whole identity, so a rename is a deletion — and it has to read like one.

    There is no second stable field to re-match on (`report_patch.STABLE_IDENTITY` re-matches a
    renamed dataset by its code; a parameter has nothing of the sort), and the alternative to saying
    so is guessing which parameter the sentence meant. The one outcome that must not happen is the
    old one: the sentence quietly printing whatever now sorts into position 16.
    """
    from prism_lca.engine import report_staleness as rs

    written_against = _window()
    bindings = rd.bindings_for(SUMMARY, written_against)
    renamed = _window(uw=None, u_window=(0.92, "W/m2K"))

    bound, missing = rd.resolve(SUMMARY, renamed, "en", bindings)
    assert "[missing: parameters.16.amount]" in bound
    assert missing == ["parameters.16.amount", "parameters.16.unit"]

    section = {
        "text": SUMMARY,
        "bindings": bindings,
        "based_on": rs.components(SUMMARY, bindings, {}, written_against),
    }
    found = rs.verdicts(section, {}, renamed, [])
    # "the numbers moved" comes along because the vanished figure drops out of the values hash; it
    # asks for nothing. The one finding with a remedy is the member that is gone, by name.
    assert [f["kind"] for f in found] == ["members", "values"]
    assert "name=uw" in found[0]["message"] and found[1]["severity"] == "none"


# --- V186: an indicator index is an identity too --------------------------------------------------
#
# Measured on a mould-remover report (5 indicators, EF v3.1). The impact-assessment
# chapter wrote "Packaging leads climate change ({{contributions.0.groups.0.share_text}}), … and
# acidification ({{contributions.3.groups.0.share_text}})", and the interpretation chapter quoted
# {{checks.sensitivity.3.spread_percent}}. Then the report's indicator list was *reordered* — the same
# five indicators, nothing recomputed, no model run. "acidification (61.0 %)" became "acidification
# (41.4 %)", which is particulate matter formation's packaging share, and the spread quoted for
# acidification became particulate matter's 35.6.
#
# Two identities live in `contributions.3.groups.0.share_text`: which indicator, and which phase
# inside it. Only the phase was pinned — the V154 fix — and it held, which is precisely why the wrong
# figure looked plausible instead of leaving a hole. Seven of nine chapters reported nothing at all.

#: (packaging share of the indicator, spread across the scenarios) as the report printed them.
_EF: dict[str, tuple[float, float]] = {
    "climate change": (67.4, 12.1),
    "water use": (55.3, 9.4),
    "land use": (47.8, 21.0),
    "acidification": (61.0, 16.5),
    "particulate matter formation": (41.4, 35.6),
}

_WRITTEN_ORDER = (
    "climate change", "water use", "land use", "acidification", "particulate matter formation",
)
#: The same five, reordered: land use goes to the end, so acidification lands on 2 and particulate
#: matter formation on 3 — the index the chapters were written under for acidification.
_REORDERED = (
    "climate change", "water use", "acidification", "particulate matter formation", "land use",
)


def _ef(
    order: tuple[str, ...],
    share: dict[str, float] | None = None,
    spread: dict[str, float] | None = None,
) -> dict:
    """The report's snapshot with the indicators in `order`.

    `share` and `spread` override one indicator's figures — a recomputation, as against `order`, which
    is the report's own method list and moves without one.
    """
    share, spread = share or {}, spread or {}

    def packaging(name: str) -> float:
        return share.get(name, _EF[name][0])

    return {
        "results": [
            {"method_label": f"EF v3.1 / {n}", "score": _EF[n][0] / 1000.0, "unit": f"unit-{n[:4]}"}
            for n in order
        ],
        "contributions": [
            {
                "method_label": f"EF v3.1 / {n}",
                "groups": [
                    {"key": "Packaging", "share_percent": packaging(n),
                     "share_text": f"{packaging(n)} %"},
                    {"key": "Distribution", "share_percent": round(100.0 - packaging(n), 1),
                     "share_text": f"{round(100.0 - packaging(n), 1)} %"},
                ],
            }
            for n in order
        ],
        "checks": {
            "sensitivity": [
                {"method_label": f"EF v3.1 / {n}", "spread_percent": spread.get(n, _EF[n][1])}
                for n in order
            ]
        },
    }


#: The two sentences the run measured, verbatim in shape.
ASSESSMENT = (
    "Packaging leads land use ({{contributions.2.groups.0.share_text}}) and acidification "
    "({{contributions.3.groups.0.share_text}})."
)
INTERPRETATION = "The spread for acidification is {{checks.sensitivity.3.spread_percent}} %."


def test_an_indicator_index_and_a_phase_index_are_both_identities():
    assert rd.ranked_splits("contributions.3.groups.0.share_text") == [
        ("contributions", 3, "groups.0.share_text"),
        ("contributions.3.groups", 0, "share_text"),
    ]
    # The innermost is what a claim is about, so the V154 answer is unchanged.
    assert rd.ranked_prefix("contributions.3.groups.0.share_text") == (
        "contributions.3.groups", 0, "share_text",
    )
    assert rd.identity_fields("contributions") == ("method_label",)
    assert rd.identity_fields("checks.sensitivity") == ("method_label",)
    # Indicator order is the report's own list, like `results`: index 3 is not "the third largest".
    assert not rd.is_magnitude_ranked("contributions")
    assert not rd.is_magnitude_ranked("checks.sensitivity")


def test_reordering_the_indicators_no_longer_moves_the_figure():
    """The measured line, verbatim: acidification (61.0 %) printed as acidification (41.4 %)."""
    written_against = _ef(_WRITTEN_ORDER)
    bindings = rd.bindings_for(ASSESSMENT, written_against)
    assert bindings["contributions.3"] == {"method_label": "EF v3.1 / acidification"}
    assert bindings["contributions.3.groups.0"] == {"key": "Packaging"}

    reordered = _ef(_REORDERED)
    unbound, _ = rd.resolve(ASSESSMENT, reordered)
    assert "41.4 %" in unbound  # what the report printed, under the word "acidification"

    bound, missing = rd.resolve(ASSESSMENT, reordered, "en", bindings)
    assert "acidification (61.0 %)" in bound and "41.4 %" not in bound
    assert "land use (47.8 %)" in bound
    assert missing == []


def test_the_sensitivity_spread_follows_its_indicator():
    """The other half of the same reorder: spread 16.5 was printed as 35.6."""
    written_against = _ef(_WRITTEN_ORDER)
    bindings = rd.bindings_for(INTERPRETATION, written_against)
    assert bindings == {"checks.sensitivity.3": {"method_label": "EF v3.1 / acidification"}}

    reordered = _ef(_REORDERED)
    assert "35.6" in rd.resolve(INTERPRETATION, reordered)[0]  # the defect
    bound, missing = rd.resolve(INTERPRETATION, reordered, "en", bindings)
    assert "is 16.5 %" in bound and missing == []


def test_results_still_follows_its_own_method_label():
    """The list that worked all along, and the model for the two above — it must stay working."""
    text = "The acidification score is {{results.3.score}} {{results.3.unit}}."
    bindings = rd.bindings_for(text, _ef(_WRITTEN_ORDER))
    bound, missing = rd.resolve(text, _ef(_REORDERED), "en", bindings)
    assert "unit-acid" in bound and missing == []


def test_a_pure_reorder_asks_the_author_for_nothing():
    """Nothing a reader can see changed, so the chapter must stay green — and it must not go green by
    being unwatched: the two tests above are what make the silence honest."""
    from prism_lca.engine import report_staleness as rs

    written_against = _ef(_WRITTEN_ORDER)
    text = ASSESSMENT + " " + INTERPRETATION
    bindings = rd.bindings_for(text, written_against)
    section = {
        "text": text,
        "bindings": bindings,
        "based_on": rs.components(text, bindings, {}, written_against),
    }
    assert rs.verdicts(section, {}, _ef(_REORDERED), []) == []


def test_a_figure_that_really_moves_is_still_reported():
    """The counter-test to the silence above: a value change is a `values` finding and nothing more.

    Measured against the *reordered* report, so this is the one that distinguishes "the pins work" from
    "the check has stopped looking".
    """
    from prism_lca.engine import report_staleness as rs

    written_against = _ef(_WRITTEN_ORDER)
    bindings = rd.bindings_for(INTERPRETATION, written_against)
    section = {
        "text": INTERPRETATION,
        "bindings": bindings,
        "based_on": rs.components(INTERPRETATION, bindings, {}, written_against),
    }
    moved = _ef(_REORDERED, spread={"acidification": 19.2})
    found = rs.verdicts(section, {}, moved, [])
    assert [f["kind"] for f in found] == ["values"] and rs.worst(found) == "none"
    assert "is 19.2 %" in rd.resolve(INTERPRETATION, moved, "en", bindings)[0]


def test_a_deleted_indicator_is_still_a_hole_and_a_rewrite():
    """The half that already worked and had to keep working: a missing indicator is named, not filled
    in by its neighbour. Reported against the indicator, once — not once per phase underneath it."""
    from prism_lca.engine import report_staleness as rs

    written_against = _ef(_WRITTEN_ORDER)
    bindings = rd.bindings_for(ASSESSMENT, written_against)
    without_land_use = _ef(tuple(n for n in _REORDERED if n != "land use"))

    bound, missing = rd.resolve(ASSESSMENT, without_land_use, "en", bindings)
    assert "[missing:" in bound  # the gap is printed where the figure was
    assert missing == ["contributions.2.groups.0.share_text"]
    # …and the sentence's other half is untouched by its neighbour's disappearance.
    assert "acidification (61.0 %)" in bound

    section = {
        "text": ASSESSMENT,
        "bindings": bindings,
        "based_on": rs.components(ASSESSMENT, bindings, {}, written_against),
    }
    found = rs.verdicts(section, {}, without_land_use, [])
    members = [f for f in found if f["kind"] == "members"]
    assert len(members) == 1 and members[0]["path"] == "contributions.2"
    assert "method_label=EF v3.1 / land use" in members[0]["message"]
    assert rs.worst(found) == "rewrite"


def test_the_sibling_lists_with_the_same_defect_are_registered():
    """Everything else in the snapshot whose index is an indicator, a variant or a method reference.

    `contribution_subjects` and `contributions.*.subjects` were not registered at *any* level, so a
    sentence citing a variant's phase share had no pin at all — the V154 defect, never measured
    because no chapter had cited one yet. Both were then pinned by the variant's *label*, which is the
    defect V223 measured; they carry the same composite key as every other variant list now.
    """
    assert rd.ranked_splits("subjects.1.results.0.score") == [
        ("subjects", 1, "results.0.score"),
        ("subjects.1.results", 0, "score"),
    ]
    assert rd.identity_fields("subjects.1.results") == ("method_label",)
    assert rd.identity_fields("contribution_subjects") == ("variant",)
    assert rd.identity_fields("contribution_subjects.0.groups") == ("key",)
    assert rd.identity_fields("contributions.2.subjects") == ("variant",)
    assert rd.identity_fields("contributions.2.subjects.1.groups") == ("key",)
    assert rd.identity_fields("method_references") == ("name",)
    assert rd.identity_fields("trade_offs") == ("method_label",)
    # The variant's *phases* rank by size; the variant list itself is report order.
    assert rd.is_magnitude_ranked("contribution_subjects.0.groups")
    assert not rd.is_magnitude_ranked("contribution_subjects")

    shares = {"Baseline": 61.0, "Refill": 41.4}
    keys = {"Baseline": "w", "Refill": "w · refill"}

    def variants(order: list[str]) -> dict:
        return {
            "contribution_subjects": [
                {"label": name, "variant": keys[name], "groups": [
                    {"key": "Packaging", "share_text": f"{shares[name]} %"},
                    {"key": "Distribution", "share_text": "10.0 %"},
                ]}
                for name in order
            ]
        }

    text = "The baseline's packaging carries {{contribution_subjects.0.groups.0.share_text}}."
    bindings = rd.bindings_for(text, variants(["Baseline", "Refill"]))
    assert bindings["contribution_subjects.0"] == {"variant": "w", rd.LABEL_KEY: "Baseline"}
    bound, missing = rd.resolve(text, variants(["Refill", "Baseline"]), "en", bindings)
    assert "61.0 %" in bound and missing == []


# --- V194: a scenario is a member, and its name is not what identifies it -------------------------
#
# Measured on a Portuguese mould-remover report. Three chapters cited the scenario
# list inside claims about a *named* variant — the executive summary ("… e a variante «{{scenarios.0.
# name}}» o mais baixo"), the interpretation checks and the conclusions ("o cenário
# {{scenarios.1.name}} quase não desloca nenhum indicador"). The list stands in creation order, so
# deleting the first scenario moved every index behind it:
#
#     cenario 1 = Alta taxa de reciclagem de plástico (80 %)   ->   cenario 1 = AAA Kontrolle
#
# The sentence now names a scenario those chapters never wrote about. The staleness check reported
# four other consequences of that edit and nothing about this one, because `scenarios` was not in
# `RANKED_LISTS` and a list nobody registered has no member to lose.
#
# It was left unregistered on purpose, twice (V182, V186), with the reason that `report_translations`
# rewrites a scenario's *name* in this very snapshot — a pin on the name would report itself missing in
# every translated report. The snapshot answers it: the entry carries the store's own `id`, and the
# translation walk touches `name` and `description` only. So the identity is `("id",)`, and that is
# also what separates a scenario from a parameter — a rename keeps the id, so the sentence keeps its
# scenario and prints the new name instead of losing it.

#: The report's scenarios in creation order, as `ScenarioStore.list_all` returns them.
_SCENARIOS: list[tuple[str, str]] = [
    ("6b1d0a5c9f2e4a71", "Transportes reduzidos para metade"),
    ("913c47f1e1024cd9", "Alta taxa de reciclagem de plástico (80 %)"),
    ("2f77c1b8e4d04a30", "AAA Kontrolle"),
]


def _scenarios(*, drop: str | None = None, rename: tuple[str, str] | None = None,
               add: tuple[str, str] | None = None, override: float | None = None) -> dict:
    """The snapshot with the three scenarios — and the four edits a modeller actually makes.

    `drop` deletes one by id, `rename` gives one a new name, `add` appends one (the UI has no other
    place to put it), `override` turns a value inside a scenario's overrides down.
    """
    entries = [
        {"id": sid, "name": rename[1] if rename and rename[0] == sid else name,
         "description": "", "overrides": {"recycling_rate": override if override is not None else 0.8},
         "database": "mould-remover"}
        for sid, name in _SCENARIOS if sid != drop
    ]
    if add:
        entries.append({"id": add[0], "name": add[1], "description": "", "overrides": {},
                        "database": "mould-remover"})
    return {"study": {"functional_unit": "1 application"}, "scenarios": entries}


CONCLUSION = "The scenario {{scenarios.1.name}} barely moves any indicator."


def test_a_scenario_is_identified_by_its_id_and_carries_no_rank():
    assert rd.identity_fields("scenarios") == ("id",)
    # Creation order. A superlative or a rank-drift finding about it would be a statement about the
    # order somebody happened to click "New scenario" in.
    assert not rd.is_magnitude_ranked("scenarios")
    assert rd.bindings_for(CONCLUSION, _scenarios())["scenarios.1"] == {
        "id": "913c47f1e1024cd9", rd.LABEL_KEY: "Alta taxa de reciclagem de plástico (80 %)"
    }


def test_deleting_an_earlier_scenario_no_longer_moves_the_sentence():
    """The measured case, verbatim: cenario 1 was the recycling rate and became AAA Kontrolle."""
    written_against = _scenarios()
    bindings = rd.bindings_for(CONCLUSION, written_against)

    without_first = _scenarios(drop="6b1d0a5c9f2e4a71")
    plain, _ = rd.resolve(CONCLUSION, without_first)
    assert "AAA Kontrolle" in plain  # the defect, shown for what it is

    bound, missing = rd.resolve(CONCLUSION, without_first, "en", bindings)
    assert "Alta taxa de reciclagem" in bound and "AAA Kontrolle" not in bound
    assert missing == []


def test_the_deleted_scenario_is_reported_and_named():
    """A pin on an opaque id still has to say *which* scenario the sentence was about.

    The name is gone from the snapshot by the time the loss is noticed, so it is stored beside the
    identity (`rd.LABEL_KEY`) and outside it — "id=913c47f1e1024cd9" is true and useless.
    """
    from prism_lca.engine import report_staleness as rs

    written_against = _scenarios()
    bindings = rd.bindings_for(CONCLUSION, written_against)
    without_it = _scenarios(drop="913c47f1e1024cd9")

    _resolved, missing = rd.resolve(CONCLUSION, without_it, "en", bindings)
    assert missing == ["scenarios.1.name"]

    section = {
        "text": CONCLUSION,
        "bindings": bindings,
        "based_on": rs.components(CONCLUSION, bindings, {}, written_against),
    }
    found = rs.verdicts(section, {}, without_it, [])
    members = [f for f in found if f["kind"] == "members"]
    assert len(members) == 1 and members[0]["severity"] == "rewrite"
    assert "Alta taxa de reciclagem de plástico (80 %)" in members[0]["message"]
    assert "id=913c47f1e1024cd9" in members[0]["message"]
    # …and no rank finding beside it: creation order never expressed size.
    assert not [f for f in found if f["kind"] == "ranks"]


def test_renaming_a_scenario_is_not_a_loss_and_prints_the_new_name():
    """The difference to `parameters`, where the name *is* the identity and a rename is a deletion.

    Renaming a scenario is a daily action, and the reader is meant to see the new name: the sentence
    was written about that scenario, not about the string it was called at the time.
    """
    from prism_lca.engine import report_staleness as rs

    written_against = _scenarios()
    bindings = rd.bindings_for(CONCLUSION, written_against)
    renamed = _scenarios(rename=("913c47f1e1024cd9", "Reciclagem elevada de plástico"))

    bound, missing = rd.resolve(CONCLUSION, renamed, "en", bindings)
    assert "Reciclagem elevada de plástico" in bound and missing == []

    section = {
        "text": CONCLUSION,
        "bindings": bindings,
        "based_on": rs.components(CONCLUSION, bindings, {}, written_against),
    }
    assert rs.verdicts(section, {}, renamed, []) == []


def test_adding_a_scenario_and_changing_an_override_ask_for_nothing():
    """Two more everyday edits that must leave a finished chapter alone."""
    from prism_lca.engine import report_staleness as rs

    written_against = _scenarios()
    bindings = rd.bindings_for(CONCLUSION, written_against)
    section = {
        "text": CONCLUSION,
        "bindings": bindings,
        "based_on": rs.components(CONCLUSION, bindings, {}, written_against),
    }
    assert rs.verdicts(section, {}, _scenarios(add=("aa11", "Cenário novo")), []) == []
    assert rs.verdicts(section, {}, _scenarios(override=0.5), []) == []


def test_deleting_a_later_scenario_leaves_the_earlier_ones_alone():
    """Only the indices behind a deletion move, and this sentence is not one of them."""
    from prism_lca.engine import report_staleness as rs

    written_against = _scenarios()
    bindings = rd.bindings_for(CONCLUSION, written_against)
    section = {
        "text": CONCLUSION,
        "bindings": bindings,
        "based_on": rs.components(CONCLUSION, bindings, {}, written_against),
    }
    later_gone = _scenarios(drop="2f77c1b8e4d04a30")
    bound, missing = rd.resolve(CONCLUSION, later_gone, "en", bindings)
    assert "Alta taxa de reciclagem" in bound and missing == []
    assert rs.verdicts(section, {}, later_gone, []) == []


def test_a_translated_scenario_name_does_not_unbind_the_chapter():
    """The reason the registration was held back — checked, not assumed.

    `report_translations.apply` substitutes into the snapshot the chapters resolve against. It rewrites
    `name` and `description`; the pin is on `id`, so the sentence resolves to the *translated* name and
    reports nothing.
    """
    from prism_lca.engine import report_staleness as rs
    from prism_lca.engine import report_translations as tr

    written_against = _scenarios()
    bindings = rd.bindings_for(CONCLUSION, written_against)

    translated = _scenarios()
    stored = {"lang": "en", "map": {
        tr.source_key("Alta taxa de reciclagem de plástico (80 %)"): "High plastic recycling rate (80 %)"
    }}
    assert tr.apply(translated, stored, "en") == 1

    bound, missing = rd.resolve(CONCLUSION, translated, "en", bindings)
    assert "High plastic recycling rate (80 %)" in bound and missing == []
    section = {
        "text": CONCLUSION,
        "bindings": bindings,
        "based_on": rs.components(CONCLUSION, bindings, {}, written_against),
    }
    assert rs.verdicts(section, {}, translated, []) == []


def test_the_model_documentation_lists_came_with_it():
    """`foreground` and `background_datasets` were held back for the same reason and have the same fix.

    Both are sorted by name — the `parameters` defect exactly: a rename re-sorts everything after it,
    with nothing recomputed. And both carry an identifier the translation walk leaves alone, even
    though `report_translations` rewrites a foreground process's name, product and description (V193).
    """
    assert rd.identity_fields("foreground") == ("code",)
    assert rd.identity_fields("background_datasets") == ("database", "code")
    assert not rd.is_magnitude_ranked("foreground")

    def processes(names: dict[str, str]) -> dict:
        return {"foreground": [{"code": code, "name": name, "description": f"{name} — as modelled."}
                               for code, name in sorted(names.items(), key=lambda kv: kv[1])]}

    text = "The packed product is modelled as {{foreground.1.name}}."
    written_against = processes({"aaa": "Filling", "bbb": "Mould remover, packed"})
    bindings = rd.bindings_for(text, written_against)
    assert bindings["foreground.1"] == {"code": "bbb", rd.LABEL_KEY: "Mould remover, packed"}

    # A process renamed so that it now sorts first — the daily action, no recomputation involved.
    renamed = processes({"aaa": "Filling", "bbb": "Bottling and packing"})
    plain, _ = rd.resolve(text, renamed)
    assert "Filling" in plain  # the defect, shown for what it is
    bound, missing = rd.resolve(text, renamed, "en", bindings)
    assert "Bottling and packing" in bound and missing == []


# --- V221: a variant's identity used to shrink to the process code --------------------------------
#
# `subjects` was pinned by the (code, scenario) pair. The baseline of a comparison runs no scenario,
# `identity_of` drops empty values, so its pin shrank to the process **code** — and every other
# variant of the same process carries that code. Measured while V219 was being built: the shrunken pin
# matched whichever such variant stood first, so the sentence printed a sister variant's figure, and no
# verdict fired at all.
#
# The fix is a never-empty composite (`variant`), the same field `results.<i>.subjects_by_score` was
# given, and the delicate half is what it does to chapters already on disk: nothing. `identity_matches`
# compares the fields a *stored* pin names, not the fields the registry names today, and the rows keep
# their code and scenario beside the new key — so an old pin goes on matching exactly what it matches
# now. No migration, and above all no disambiguation by the pin's own index.

# Author order: the scenario variant first, the baseline second. Deliberately not the other way round —
# the measured failure needs the pinned variant to *not* be the one the weak pin finds first.
COMPARISON = ("The unrecycled case emits {{subjects.0.results.0.score}} kg CO2-Eq, the baseline "
              "{{subjects.1.results.0.score}} kg.")
CLIMATE = "EF v3.1 / climate change"


def _comparison(baseline_first: bool = False) -> dict:
    """Two variants of *one* process — a baseline that runs no scenario, and a scenario case.

    Through `build_data`, so the `variant` key under test is the one a real snapshot carries rather
    than one the fixture invented.
    """
    def rows(gwp: float) -> list[dict]:
        return [{"method": ["EF v3.1", "climate change"], "unit": "kg CO2-Eq", "score": gwp}]

    baseline = {"label": "Baseline", "code": "w", "scenario": None, "lcia": {"results": rows(10.0)}}
    variant = {"label": "No recycling", "code": "w", "scenario": "no-recycling",
               "lcia": {"results": rows(4.0)}}
    order = [baseline, variant] if baseline_first else [variant, baseline]
    return rd.build_data(
        {"functional_unit": "1 unit"},
        {"activity": {"name": "widget", "database": "rr", "code": "w"}, "amount": 1.0,
         "results": rows(10.0)},
        None,
        subjects=order,
    )


def test_a_variant_is_identified_by_one_key_that_both_variant_lists_share():
    """One notion of "which variant", not two: the same field name, built by the same function.

    Two answers to "which variant is this" would eventually let a chapter's pin in the comparison
    table's list and its pin in the score-ordered view of the *same* variants mean different things.
    """
    assert rd.identity_fields("subjects") == ("variant",)
    assert rd.identity_fields("results.0.subjects_by_score") == ("variant",)

    data = _comparison()
    assert [s["variant"] for s in data["subjects"]] == ["w · no-recycling", "w"]
    # The derived view carries the same key for the same variant, whatever order it puts them in.
    ranked = data["results"][0]["subjects_by_score"]
    assert {r["variant"] for r in ranked} == {"w", "w · no-recycling"}
    # And it is never empty, which is the whole reason it exists: the baseline has no scenario.
    assert all(s["variant"] for s in data["subjects"])


def test_the_baselines_pin_no_longer_matches_a_sister_variant():
    """The pin the old rule wrote, and the pin written now, side by side on the same data."""
    written_against = _comparison()
    bindings = rd.bindings_for(COMPARISON, written_against)
    assert bindings["subjects.1"] == {"variant": "w", rd.LABEL_KEY: "Baseline"}
    assert bindings["subjects.0"] == {"variant": "w · no-recycling", rd.LABEL_KEY: "No recycling"}

    sister, baseline = written_against["subjects"]
    assert not rd.identity_matches(sister, bindings["subjects.1"])
    assert rd.identity_matches(baseline, bindings["subjects.1"])
    # The old pin is what made this a finding: it matches both, so it matches whichever comes first.
    assert rd.identity_matches(sister, {"code": "w"})
    assert rd.identity_matches(baseline, {"code": "w"})


def test_a_newly_written_chapter_survives_the_variants_swapping_places():
    """Resolution stays on the right variant, and no verdict fires — which is the correct outcome here.

    `subjects` is the author's own order and carries no rank (it is not in `MAGNITUDE_RANKED`), so two
    variants swapping places is not a change any chapter can be wrong about: the sentence keeps naming
    its own variant's figure and there is nothing to report. What must never happen is the other
    outcome — the same sentence, silently, about the other variant.
    """
    from prism_lca.engine import report_staleness as rs

    written_against = _comparison()
    bindings = rd.bindings_for(COMPARISON, written_against)
    text, missing = rd.resolve(COMPARISON, written_against, "en", bindings)
    assert "the baseline 10 kg" in text and missing == []

    swapped = _comparison(baseline_first=True)
    plain, _ = rd.resolve(COMPARISON, swapped)
    assert "the baseline 4 kg" in plain  # the defect, shown for what it is

    bound, missing = rd.resolve(COMPARISON, swapped, "en", bindings)
    assert "the baseline 10 kg" in bound and missing == []
    section = {"text": COMPARISON, "bindings": bindings,
               "based_on": rs.components(COMPARISON, bindings, {}, written_against)}
    assert rs.verdicts(section, {}, swapped, []) == []


def test_a_chapter_stored_before_the_change_says_exactly_what_it_said_before():
    """The whole risk of this fix, pinned down: an untouched stored chapter must not move at all.

    The bindings below are written the way the old rule wrote them — the pair, with the baseline's
    empty scenario dropped — and the record is stamped through that pin. Both halves of today's
    behaviour are asserted, including the wrong one: the weak pin resolves to whichever variant with
    that code stands first, so the sentence about the baseline prints the sister's figure. That is the
    bug, it is not repaired here, and repairing it by the pin's index would be the positional guess
    this design refuses. What matters is that it is not made *worse*: same figure, same silence.
    """
    from prism_lca.engine import report_staleness as rs

    written_against = _comparison()
    old_bindings = {
        "subjects.0": {"code": "w", "scenario": "no-recycling"},
        "subjects.0.results.0": {"method_label": CLIMATE},
        "subjects.1": {"code": "w"},  # the baseline: the empty scenario fell out of the pair
        "subjects.1.results.0": {"method_label": CLIMATE},
    }
    section = {"text": COMPARISON, "bindings": old_bindings,
               "based_on": rs.components(COMPARISON, old_bindings, {}, written_against)}

    text, missing = rd.resolve(COMPARISON, written_against, "en", old_bindings)
    assert "the baseline 4 kg" in text and missing == []  # the referent was already wrong
    assert rs.verdicts(section, {}, written_against, []) == []

    # …and after the two swap places: the weak pin follows the first code-carrier as it always did,
    # nothing goes missing, and nothing asks for anything. The one remark is "the numbers moved" at
    # severity `none` — the figure under the sentence did change, because the pin followed the swap,
    # which is the defect stated in the only vocabulary this record has for it.
    swapped = _comparison(baseline_first=True)
    after, missing = rd.resolve(COMPARISON, swapped, "en", old_bindings)
    assert "the baseline 10 kg" in after and missing == []
    assert [(f["kind"], f["severity"]) for f in rs.verdicts(section, {}, swapped, [])] == [
        ("values", "none")
    ]


def _two_processes() -> dict:
    """The other common comparison: two *different* processes, so no code is shared.

    The weak pin was never ambiguous in this shape — which is what makes re-stating it a translation
    rather than a decision, and what the strengthening below is for.
    """
    def rows(gwp: float) -> list[dict]:
        return [{"method": ["EF v3.1", "climate change"], "unit": "kg CO2-Eq", "score": gwp}]

    return rd.build_data(
        {"functional_unit": "1 unit"},
        {"activity": {"name": "widget", "database": "rr", "code": "w"}, "amount": 1.0,
         "results": rows(10.0)},
        None,
        subjects=[
            {"label": "Glass", "code": "w", "scenario": None, "lcia": {"results": rows(10.0)}},
            {"label": "Tin", "code": "t", "scenario": None, "lcia": {"results": rows(4.0)}},
        ],
    )


def test_an_unambiguous_old_pin_resolves_to_the_same_member_as_before():
    """Its member is the same under the old fields and the new one, so nothing on disk needs touching."""
    data = _two_processes()
    text = "The glass variant emits {{subjects.0.results.0.score}} kg CO2-Eq."
    old = {"subjects.0": {"code": "w"}, "subjects.0.results.0": {"method_label": CLIMATE}}
    new = rd.bindings_for(text, data)
    assert new["subjects.0"] == {"variant": "w", rd.LABEL_KEY: "Glass"}
    assert rd.resolve(text, data, "en", old) == rd.resolve(text, data, "en", new)


# --- the opportunistic half: a pin re-stated on save, never re-decided ----------------------------


def test_an_unambiguous_pin_is_re_stated_when_the_chapter_is_next_saved():
    """`bindings_for`'s `keep` is the moment a surviving pin is legitimately handled — see
    `_strengthened`. It cannot change the answer, so it is not a migration; it only stops the pin
    being ambiguous should a sister variant be added to the report later."""
    data = _two_processes()  # one variant per code, so "w" answers for exactly one member
    text = "The glass variant emits {{subjects.0.results.0.score}} kg CO2-Eq."
    kept = {"subjects.0": {"code": "w"}, "subjects.0.results.0": {"method_label": CLIMATE}}

    once = rd.bindings_for(text, data, keep=kept)
    assert once["subjects.0"] == {"variant": "w", rd.LABEL_KEY: "Glass"}
    # Same member, so the same figure — the condition that makes this legitimate at all.
    assert rd.resolve(text, data, "en", kept) == rd.resolve(text, data, "en", once)
    # Idempotent: a pin already written in today's fields comes back untouched.
    assert rd.bindings_for(text, data, keep=once) == once


def test_an_ambiguous_pin_is_never_re_stated_and_a_lost_one_is_left_to_the_verdict():
    """The two cases where a re-statement would be a guess, and both keep the pin exactly as it is."""
    ambiguous = _comparison()  # two variants carry the code "w"
    text = "The baseline emits {{subjects.1.results.0.score}} kg CO2-Eq."
    kept = {"subjects.1": {"code": "w"}, "subjects.1.results.0": {"method_label": CLIMATE}}
    assert rd.bindings_for(text, ambiguous, keep=kept)["subjects.1"] == {"code": "w"}

    # Nothing answers to the pin any more: strengthening it would invent a member, and the "gone"
    # verdict is what has to speak instead.
    other = _comparison()
    other["subjects"] = [dict(s, code="t", variant=rd.variant_key("t", s["scenario"]))
                         for s in other["subjects"]]
    assert rd.bindings_for(text, other, keep=kept)["subjects.1"] == {"code": "w"}


def test_a_partly_written_pin_is_not_hardened_into_one_a_rename_can_break():
    """The exclusion that keeps this from being a general "harden every old pin".

    A `hotspots` pin is (database, code, name); one written without the name still names two of the
    three fields, and completing it would turn a free re-link (`report_patch.rebindings` re-matches a
    renamed dataset by its code) into a lost member and a rewrite verdict. So the re-statement is only
    for a pin written against a *different* set of fields, not a shorter version of this one.
    """
    text = "The dominant contributor is {{hotspots.0.name}}."
    data = _data(["incineration", "granulate"])
    kept = {"hotspots.0": {"database": "ecoinvent-3.12-cutoff", "code": "inc"}}
    assert rd.bindings_for(text, data, keep=kept) == kept


# --- V223: the same defect one list further on, and wrong from the moment it is written -----------
#
# `contribution_subjects` and `contributions.*.subjects` were pinned by the variant's `label`. A variant
# with no label of its own is *called* by its process name (`api/v1/report.py` falls back to
# `activity.name`), so two variants of one process — the shape every scenario comparison has — carry the
# identical label. A pin on the second one then matched the first, and unlike V221 that needed no
# reordering: it was wrong the moment the chapter was written.
#
# Same fix, same harmlessness: the composite `variant` becomes the identity, the rows keep their
# `label`, so a pin already on disk goes on matching exactly what it matches today.

MATRIX = "The refill case's leading phase carries {{contribution_subjects.1.groups.0.share_text}}."


def _phase_split(packaging: float) -> dict:
    """One variant's phase breakdown, as the tree aggregation hands it over."""
    return {"aggregation": {"dimension": "phase", "groups": [
        {"key": "Packaging", "impact": packaging, "share": packaging / 10.0},
        {"key": "Distribution", "impact": 10.0 - packaging, "share": (10.0 - packaging) / 10.0},
    ]}}


def _unlabelled(swap: bool = False) -> dict:
    """Two variants of one process, neither given a label — so both are called by the process name.

    Nothing here is contrived: this is what `api/v1/report.py` hands over for a scenario comparison
    whose variants the author never renamed.
    """
    rows = [{"method": ["EF v3.1", "climate change"], "unit": "kg CO2-Eq", "score": 10.0}]
    baseline = {"label": "widget", "code": "w", "scenario": None, "contribution": _phase_split(6.0)}
    refill = {"label": "widget", "code": "w", "scenario": "refill", "contribution": _phase_split(2.0)}
    order = [refill, baseline] if swap else [baseline, refill]
    return rd.build_data(
        {"functional_unit": "1 unit"},
        {"activity": {"name": "widget", "database": "rr", "code": "w"}, "amount": 1.0,
         "results": rows},
        _phase_split(6.0),
        subject_contributions=order,
        contributions=[{"index": 0, "method_label": "EF v3.1 / climate change",
                        "contribution": _phase_split(6.0), "subjects": order, "hotspots": []}],
    )


def test_two_variants_of_one_process_are_called_the_same_and_identified_apart():
    """The collision is in the *label*, and the fix is that the label is no longer the identity."""
    data = _unlabelled()
    assert [s["label"] for s in data["contribution_subjects"]] == ["widget", "widget"]
    assert [s["variant"] for s in data["contribution_subjects"]] == ["w", "w · refill"]
    # The per-indicator sibling carries it too — same builder, same field, same values.
    assert [s["variant"] for s in data["contributions"][0]["subjects"]] == ["w", "w · refill"]


def test_the_measured_case_a_new_pin_names_the_variant_the_sentence_is_about():
    """The measurement from the finding, as the test: 80.0 %, not 40.0 %.

    Why the old number looked plausible is worth keeping: the *phase* pin held. The variant pin landed
    on the baseline, the phase pin then found Distribution inside it, and 40.0 % is Distribution's real
    share of the baseline — a correct figure for a variant the sentence was not about (the V186 shape).
    """
    data = _unlabelled()
    bindings = rd.bindings_for(MATRIX, data)
    assert bindings["contribution_subjects.1"] == {"variant": "w · refill", rd.LABEL_KEY: "widget"}
    # The label rides along since V248 so a lost pin can name the group in the report's language; it
    # is an "@" field, so `identity_matches` skips it and the pin still binds on `key` alone.
    assert bindings["contribution_subjects.1.groups.0"] == {
        "key": "Distribution",
        rd.LABEL_KEY: "Distribution",
    }

    text, missing = rd.resolve(MATRIX, data, "en", bindings)
    assert "carries 80.0 %" in text and missing == []

    # The pin the old rule wrote, on the very same data: the defect, shown for what it is.
    old = {"contribution_subjects.1": {"label": "widget"},
           "contribution_subjects.1.groups.0": {"key": "Distribution"}}
    was, _missing = rd.resolve(MATRIX, data, "en", old)
    assert "carries 40.0 %" in was

    # …and the new pin holds when the two swap places, which the old one did only by luck.
    swapped = _unlabelled(swap=True)
    still, missing = rd.resolve(MATRIX, swapped, "en", bindings)
    assert "carries 80.0 %" in still and missing == []


def test_a_chapter_stored_before_the_change_stays_silently_wrong_and_nothing_else():
    """The requirement that decides whether this is shippable: an untouched chapter does not move.

    It is wrong today and it is wrong afterwards, by the same figure, with the same silence — no new
    verdict, and none of today's verdicts lost. Repairing it would mean deciding which of two
    identically named variants a stored sentence meant, which is the guess this design refuses.
    """
    from prism_lca.engine import report_staleness as rs

    data = _unlabelled()
    old = {"contribution_subjects.1": {"label": "widget"},
           "contribution_subjects.1.groups.0": {"key": "Distribution"}}
    section = {"text": MATRIX, "bindings": old,
               "based_on": rs.components(MATRIX, old, {}, data)}

    text, missing = rd.resolve(MATRIX, data, "en", old)
    assert "carries 40.0 %" in text and missing == []
    assert rs.verdicts(section, {}, data, []) == []

    # And after a swap: the label pin follows the first row carrying that name, as it always did.
    swapped = _unlabelled(swap=True)
    after, missing = rd.resolve(MATRIX, swapped, "en", old)
    assert "carries 80.0 %" in after and missing == []
    # Verdicts at `review`, and the rank one is the *phase* pin's, not the variant's: the label pin
    # dragged the sentence onto the other variant, where Distribution happens to lead. Today's
    # behaviour to the letter — the same stored pin, the same resolution, the same finding — which is
    # the point of the test. Nothing here became a rewrite, and nothing that spoke went quiet. The
    # band verdict beside it is a later addition: `share_text` is watched through its
    # `share_percent` twin now, and 40 % → 80 % is a size class the sentence has to answer for.
    spoke = [(f["kind"], f["severity"], f["path"]) for f in rs.verdicts(section, {}, swapped, []) if "path" in f]
    assert spoke == [
        ("bands", "review", "contribution_subjects.1.groups.0.share_text"),
        ("ranks", "review", "contribution_subjects.1.groups.0"),
    ]


def test_the_per_indicator_sibling_is_pinned_through_its_indicator_and_its_variant():
    """`contributions.0.subjects.1.groups.0` makes three claims and all three are pinned — the
    indicator (V186), the variant (V223) and the phase (V154)."""
    data = _unlabelled()
    text = "Refill: {{contributions.0.subjects.1.groups.0.share_text}}."
    bindings = rd.bindings_for(text, data)
    assert bindings["contributions.0"] == {"method_label": "EF v3.1 / climate change"}
    assert bindings["contributions.0.subjects.1"] == {"variant": "w · refill", rd.LABEL_KEY: "widget"}
    assert bindings["contributions.0.subjects.1.groups.0"] == {
        "key": "Distribution",
        rd.LABEL_KEY: "Distribution",
    }
    assert rd.resolve(text, data, "en", bindings) == ("Refill: 80.0 %.", [])
    assert rd.resolve(text, _unlabelled(swap=True), "en", bindings) == ("Refill: 80.0 %.", [])


def test_a_label_pin_is_re_stated_only_where_the_label_named_one_variant():
    """`_strengthened` covers these two lists under the same three guards, and stays idempotent."""
    text = "The refill case carries {{contribution_subjects.1.groups.0.share_text}}."
    kept = {"contribution_subjects.1": {"label": "Refill"},
            "contribution_subjects.1.groups.0": {"key": "Distribution"}}

    # Distinct labels — the pin names exactly one variant, so re-stating it decides nothing.
    named = _unlabelled()
    for row, label in zip(named["contribution_subjects"], ["Baseline", "Refill"], strict=True):
        row["label"] = label
    once = rd.bindings_for(text, named, keep=kept)
    assert once["contribution_subjects.1"] == {"variant": "w · refill", rd.LABEL_KEY: "Refill"}
    assert rd.resolve(text, named, "en", kept) == rd.resolve(text, named, "en", once)
    assert rd.bindings_for(text, named, keep=once) == once  # idempotent

    # Both called "widget": the pin answers for two variants, so it is left exactly as it stands and
    # goes on resolving to the first of them — no better, no worse, and no decision taken for the author.
    collided = {"contribution_subjects.1": {"label": "widget"},
                "contribution_subjects.1.groups.0": {"key": "Distribution"}}
    ambiguous = _unlabelled()
    assert (rd.bindings_for(text, ambiguous, keep=collided)["contribution_subjects.1"]
            == {"label": "widget"})


def test_a_derivation_reads_the_unit_of_the_bound_member_not_of_the_position():
    """The values came through the pins, the units by list position — a length
    parameter sorting in above two pinned masses made `sum` refuse metres plus kilograms."""
    data = {
        "parameters": [
            {"name": "length_m", "amount": 3.0, "unit": "m"},
            {"name": "mass_a", "amount": 1.0, "unit": "kg"},
            {"name": "mass_b", "amount": 2.0, "unit": "kg"},
        ]
    }
    pins = {"parameters.0": {"name": "mass_a"}, "parameters.1": {"name": "mass_b"}}
    text, error = rb.derive("sum(parameters.0.amount, parameters.1.amount)", data, "en", bindings=pins)
    assert error is None, error
    assert text.startswith("3")


def test_the_pval_call_is_terminated_so_the_authors_punctuation_survives():
    """Typst reads the first `;` after an embedded expression as its terminator and prints nothing for
    it. A chapter saying "{{rank:…}}; es erhöht …" therefore lost its semicolon in the PDF (V401). The
    emitted call carries its own terminator, so the author's `;` — and anything else — stays markup."""
    data = _data(["incineration", "granulate"])
    values: dict[str, str] = {}
    out = rd.resolve("{{hotspots.0.name}}; it rose.", data, "en", None, values, scope="sec-a")[0]
    assert out.startswith('#pval("sec-a:hotspots.0.name");; it rose.')
    assert values["sec-a:hotspots.0.name"] == "incineration"
