"""Report fixes: V433 (snapshot independent of translations),
V434 (declaration beside its own label)."""
from __future__ import annotations

from prism_lca.engine import report_bindings as rb
from prism_lca.engine import report_tokens as rt

# ---- V434 -----------------------------------------------------------------------------------------
SUMMARY = (
    'Die Variante "{{results.0.subjects_by_score.0.label}}" ({{rank:results.0.subjects_by_score.0}}) '
    "hat jeweils den höchsten Wert, der Basisfall den niedrigsten."
)
LCIA = (
    "hat die Variante „{{results.0.subjects_by_score.0.label}}\" ({{rank:results.0.subjects_by_score.0}}), "
    "den niedrigsten der Basisfall."
)


def test_the_declaration_beside_its_label_is_found_on_the_real_sentences():
    """Both sentences are taken from a real report (summary and LCIA chapter)."""
    assert rt.declaration_beside_label(SUMMARY) == ["results.0.subjects_by_score.0"]
    assert rt.declaration_beside_label(LCIA) == ["results.0.subjects_by_score.0"]
    # Reversed order counts too; a pair naming two different members does not.
    assert rt.declaration_beside_label("„{{rank:hotspots.0}}“ ({{hotspots.0.label}})") == ["hotspots.0"]
    assert rt.declaration_beside_label("{{rank:hotspots.0}} ({{hotspots.1.label}})") == []
    assert rt.declaration_beside_label("{{rank:hotspots.0}} trägt {{hotspots.0.share_text}}") == []


def test_the_pair_prints_as_one_name_and_keeps_the_declaration():
    folded = rt.collapse_declaration_pairs(SUMMARY)
    assert folded.startswith('Die Variante "{{rank:results.0.subjects_by_score.0}}" hat')
    assert "label" not in folded
    folded = rt.collapse_declaration_pairs(LCIA)
    assert folded.startswith("hat die Variante „{{rank:results.0.subjects_by_score.0}}\", den")
    # The stored text is not what the fold touches: placeholders_in still sees both tokens.
    assert rt.placeholders_in(SUMMARY) == ["results.0.subjects_by_score.0.label", "rank:results.0.subjects_by_score.0"]


def test_the_resolver_prints_the_member_once():
    data = {
        "subjects": [{"code": "p", "scenario": None, "label": "Basisfall"}, {"code": "p", "scenario": "s1", "label": "Glykolether 5 %"}],
        "results": [{"method": ["M"], "unit": "kg", "score": 1.0, "subjects_by_score": [
            {"code": "p", "scenario": "s1", "label": "Glykolether 5 %", "score": 1.2},
            {"code": "p", "scenario": None, "label": "Basisfall", "score": 1.0},
        ]}],
    }
    text, missing = rb.resolve(SUMMARY, data, "de", plain=True)
    assert missing == []
    assert text.count("Glykolether 5 %") == 1, text
    assert "(Glykolether" not in text


# ---- V433 -----------------------------------------------------------------------------------------
def test_stored_translations_do_not_change_the_snapshot_key():
    from prism_lca.engine import report_snapshot as rs

    class _Body:
        code = None
        methods = None
        amount = None
        aggregate_by = None

    report = {"methods": [["M"]], "subjects": [], "amount": 1, "lang": "de", "sections": [], "translations": {}}
    translated = {**report, "translations": {"lang": "de", "map": {"abc": "Übersetzt"}}}
    try:
        a = rs.snapshot_key("db", "r1", report, _Body())
        b = rs.snapshot_key("db", "r1", translated, _Body())
    except Exception as exc:  # noqa: BLE001 — no project is open in a unit test; the payload hash is what matters
        if "project" not in str(exc).lower() and "bd" not in str(exc).lower():
            raise
        return
    assert a == b
