"""What a chapter may draw, and what its brief says it already shows.

A chapter's own figure is a declarative spec checked against a whitelist of the data the report holds, never
generated chart code; the brief tells the writer which figures are possible and which the chapter carries
anyway, so it does not describe a table twice or promise a chart that cannot exist.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import report_prompts as rp
from prism_lca.errors import PrismError


# ---- a chapter's own figure, as a validated spec ------------------------------
def test_a_figure_spec_is_validated_against_a_whitelist():
    """LIDA generates chart *code* and names two consequences itself: `exec()` as a security risk, and
    "silent semantic errors" — code that runs and aggregates the wrong thing. A declarative spec drawn by
    our own renderer has neither: the model names a source and a field, and both must exist."""
    data = {
        "contribution": {"groups": [{"key": "End of life", "impact": 0.062, "share_percent": 51.9}]},
        "hotspots": [],
    }
    ok = rp.accept_figure({"kind": "bar", "source": "contribution.groups", "value": "share_percent"}, data)
    assert ok == {
        "kind": "bar",
        "source": "contribution.groups",
        "value": "share_percent",
        "label": "key",
        "caption": "",
        "rows": 15,
        # How it is drawn, defaulted: presentation cannot be wrong about the numbers, so the writer need not
        # name it and a chapter's editor can change it afterwards without re-checking anything.
        "horizontal": True,
        "stacked": False,
    }

    for spec, code in [
        ({"kind": "pie", "source": "contribution.groups"}, "report_figure_bad_kind"),
        ({"kind": "bar", "source": "model.exchanges"}, "report_figure_bad_source"),
        ({"kind": "bar", "source": "contribution.groups", "value": "key"}, "report_figure_bad_value"),
        ({"kind": "bar", "source": "hotspots"}, "report_figure_no_data"),
    ]:
        with pytest.raises(PrismError) as raised:
            rp.accept_figure(spec, data)
        assert raised.value.code == code

    # No figure is a valid answer: a chapter that argues in words needs none.
    assert rp.accept_figure(None, data) is None


def test_a_long_caption_is_cut_at_a_word_not_mid_letter():
    """The old hard [:160] printed "…several processes of compa" under a real figure (V124)."""
    data = {
        "contribution": {"groups": [{"key": "End of life", "impact": 0.062, "share_percent": 51.9}]},
        "hotspots": [],
    }
    caption = ("Direct climate-change contributions of the largest single datasets per functional unit "
               "(kg CO2-Eq): the leading phases are carried by several processes of comparable size, "
               "with the last-mile parcel leg and natural-gas process heat ahead of the rest.")
    ok = rp.accept_figure(
        {"kind": "bar", "source": "contribution.groups", "value": "share_percent", "caption": caption}, data
    )
    assert ok["caption"].endswith("…")
    assert "compa" not in ok["caption"].split()[-2]  # the cut lands between words
    last_word = ok["caption"].removesuffix(" …").split()[-1]
    assert caption.count(f" {last_word} ")  # …and that word is one the caption really contains
    # A caption inside the limit is untouched.
    short = rp.accept_figure(
        {"kind": "bar", "source": "contribution.groups", "value": "share_percent", "caption": "Short."}, data
    )
    assert short["caption"] == "Short."


def test_the_brief_tells_the_writer_which_figures_are_possible():
    brief = rp.build_brief({"kind": "prose"}, {"lang": "en"}, {"study": {}, "results": [], "subjects": []})
    assert "contribution.groups" in brief["figure_sources"]
    assert "share_percent" in brief["figure_sources"]["contribution.groups"]
    # Heatmap and radar joined the list when figures became a chapter's own: they are built from the
    # report's subjects × indicators rather than from a row source, which is why they carry no source.
    assert brief["figure_kinds"] == ["bar", "stacked_bar", "heatmap", "radar"]


def test_a_chapter_carries_a_list_of_figures():
    """One chapter legitimately wants the contribution as bars *and* the same comparison as a heatmap.

    The single `figure` a chapter used to own made that impossible, and it was the writer's proposal — so the
    author could not add a second drawing without asking a model to rewrite the chapter.
    """
    data = {"contribution": {"groups": [{"key": "End of life", "impact": 0.06, "share_percent": 52.0}]}}
    figs = rp.accept_figures(
        [
            {"kind": "bar", "source": "contribution.groups", "value": "impact", "horizontal": False, "rows": 8},
            {"kind": "heatmap"},
        ],
        data,
    )
    assert [f["kind"] for f in figs] == ["bar", "heatmap"]
    assert figs[0]["horizontal"] is False and figs[0]["rows"] == 8
    # A comparison figure is built from subjects × indicators, so it carries no source and no rows.
    assert figs[1]["source"] == "" and figs[1]["rows"] == 0

    # Row counts are capped where a figure stops being one, and an empty list is a perfectly good answer.
    assert rp.accept_figures([{"kind": "bar", "source": "contribution.groups", "rows": 9999}], data)[0]["rows"] == 40
    assert rp.accept_figures(None) == []
    assert rp.accept_figures([]) == []

    # Without data the shape is still checked — the case when the *user* sets a figure in the chapter editor,
    # where no snapshot exists. A bad field must fail there, not silently draw nothing at render time.
    assert rp.accept_figures([{"kind": "bar", "source": "contribution.groups", "value": "impact"}])[0]["value"] == "impact"
    for spec in ({"kind": "pie"}, {"kind": "bar", "source": "nope"}, {"kind": "bar", "source": "hotspots", "value": "key"}):
        try:
            rp.accept_figures([spec])
        except PrismError:
            pass
        else:
            raise AssertionError(f"{spec} should have been refused")

    try:
        rp.accept_figures([{"kind": "bar", "source": "contribution.groups"}] * 7)
    except PrismError as exc:
        assert exc.code == "report_figure_too_many"
    else:
        raise AssertionError("seven figures should have been refused")


def test_the_brief_says_what_the_chapter_already_shows():
    """A comment chapter is told which tables and figures stand with it, and how to reference them.

    Its instruction says "comment on the analysis below the table" — without this the brief never said what
    that table is, so a writer either ignored the figure beside it or, worse, described it. The shares are
    already drawn; retelling them in prose is the one thing a comment should not do.
    """
    data = {
        "study": {"functional_unit": "1 L"},
        "results": [{"method_label": "climate change"}],
        "subjects": [{"label": "baseline"}, {"label": "variant"}],
        "contribution": {"groups": [{"key": "Packaging", "impact": 1.0, "share_percent": 47.0}]},
    }
    report = {"lang": "en", "options": {"figures": {"heatmap": True, "radar": True}}}

    got = rp.renders_for({"id": "sec-1", "kind": "contribution"}, report, data)
    assert [r["ref"] for r in got] == ["{{ref:t-contribution}}", "{{ref:f-contribution}}"]
    # All three shapes the renderer can draw for a contribution carry that one label, so it resolves to
    # whichever was actually drawn — which is why the brief can name it without knowing the shape.
    assert all(r["shows"] and r["kind"] in ("table", "figure") for r in got)

    # The chapter's own figures come with it, under the references the renderer places.
    with_own = rp.renders_for(
        {"id": "sec-1", "kind": "contribution", "figures": [{"kind": "heatmap"}, {"kind": "bar", "source": "hotspots"}]},
        report, data,
    )
    assert [r["ref"] for r in with_own[-2:]] == ["{{ref:f-section-sec-1-0}}", "{{ref:f-section-sec-1-1}}"]

    # Nothing is promised that will not be drawn: no contribution groups, no contribution table or figure.
    assert rp.renders_for({"id": "s", "kind": "contribution"}, report, {"results": [], "subjects": []}) == []
    # A radar needs more than three indicators, and a comparison needs more than one subject — the same
    # conditions the renderer applies, or the brief would name a figure the document does not contain.
    one_subject = {**data, "subjects": [{"label": "only"}]}
    assert [r["ref"] for r in rp.renders_for({"id": "s", "kind": "lcia"}, report, one_subject)] == ["{{ref:t-lcia}}"]
    four = {**data, "results": [{"method_label": str(i)} for i in range(4)]}
    refs = [r["ref"] for r in rp.renders_for({"id": "s", "kind": "lcia"}, report, four)]
    # One label per drawn indicator — the renderer emits f-lcia-{i} for each, and the brief mirrors it
    # (it used to know only f-lcia-0, so a reference the PDF contains was refused).
    assert refs == [
        "{{ref:t-lcia}}",
        "{{ref:f-lcia-0}}", "{{ref:f-lcia-1}}", "{{ref:f-lcia-2}}", "{{ref:f-lcia-3}}",
        "{{ref:f-heatmap}}", "{{ref:f-radar}}",
    ]

    # And it reaches the brief, next to the rule that tells the writer to point rather than retell.
    brief = rp.build_brief({"id": "sec-1", "kind": "contribution"}, report, data)
    assert brief["renders"] == got
    assert "renders" in brief["invariants"]
