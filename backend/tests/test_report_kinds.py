"""The ChapterKind registry — one description per kind, and everything that must agree with it.

Before the registry, adding a chapter kind took seven coordinated edits across six files, and the
one drift that slipped through reached a user: the brief offered a render label the renderer no
longer emitted, and a commissioned rewrite was thrown away over one token (V215). These tests are
the replacement for that coordination: every table that still exists as a literal (for order or
layering reasons) is compared against the registry, and every dispatch that replaced an if/elif
chain is checked for completeness.
"""

from prism_lca.engine import report_kinds as rk
from prism_lca.engine import report_prompts as rp
from prism_lca.engine import report_render as rr
from prism_lca.engine.report_i18n import LANGUAGES, t
from prism_lca.engine.report_model import DETERMINISTIC_KINDS, PROSE_KINDS

ALL_KINDS = {k.kind for k in rk.KINDS}


def test_registry_and_membership_tuples_describe_the_same_population():
    assert set(DETERMINISTIC_KINDS) == {k.kind for k in rk.KINDS if not k.prose}
    assert set(PROSE_KINDS) == {k.kind for k in rk.KINDS if k.prose}
    assert len(ALL_KINDS) == len(rk.KINDS), "duplicate kind id in the registry"


def test_the_historical_orders_survived_the_derivation():
    """The derived tables must reproduce the pre-registry literals byte for byte — deriving them was
    only safe because nothing observable changed. These are the literals as they once stood."""
    # …plus `system_model` right after goal & scope (the short-report kind), and the introduction
    # before goal & scope.
    assert rk.KIND_ORDER == [
        "summary", "abbreviations", "introduction", "goal_scope", "system_model", "inventory", "methods", "lcia",
        "contribution", "interpretation_checks", "limitations", "conclusions", "prose", "appendix",
        "datasets", "references", "provenance",
    ]
    assert DETERMINISTIC_KINDS == (
        "goal_scope", "system_model", "inventory", "methods", "lcia", "contribution",
        "interpretation_checks", "limitations", "appendix", "datasets", "references", "provenance",
        "abbreviations",
    )
    assert PROSE_KINDS == ("prose", "summary", "conclusions", "introduction")
    assert rp._SUMMARISING == ("summary", "conclusions")
    assert rp._WORTH_READING == (
        "goal_scope", "methods", "lcia", "contribution", "interpretation_checks", "limitations", "prose",
    )


def test_every_kind_has_a_heading_in_every_report_language():
    # `t` falls back to the key itself, so "resolves" means "comes back as something else".
    for kind in rk.KINDS:
        for lang in LANGUAGES:
            assert t(kind.title_key, lang) != kind.title_key, (kind.kind, lang)


def test_prompt_files_and_registry_flags_agree():
    assert set(rp.DEFAULT_PROMPTS) == {k.kind for k in rk.KINDS if k.own_prompt}


def test_every_kind_has_a_block_builder():
    """The renderer's dispatch replaced a thirteen-branch chain; a kind the chain forgot fell through
    to the unknown-kind note without anyone noticing in review. Now it fails here instead."""
    assert set(rr._KIND_BUILDERS) == ALL_KINDS


def test_render_offers_speak_only_of_known_kinds():
    assert set(rp._RENDER_OFFERS) <= ALL_KINDS
    # The kinds without an offer are exactly the chapters that carry only their own figures.
    assert ALL_KINDS - set(rp._RENDER_OFFERS) == {
        "goal_scope", "limitations", "provenance", "conclusions", "prose", "introduction",
    }


def test_the_side_tables_name_only_known_kinds():
    assert set(rp._KIND_COVERS) == ALL_KINDS - {"prose"}  # the free chapter has no fixed job
    assert set(rp._SETTLED_IN.values()) <= ALL_KINDS
    for kinds in rp._SPECIALIST_FACTS.values():
        assert kinds <= ALL_KINDS
    assert set(rr._EMPTY_NOTES) <= ALL_KINDS
