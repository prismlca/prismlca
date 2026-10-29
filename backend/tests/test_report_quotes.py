"""V409 — one pair of quotation marks per document, set by the compiler.

Four writer lanes produced three quote styles in one German report, and a mixed pair („ with a straight
closer) printed as „…„. Everything is straightened before Typst sees it; Typst's smartquote then sets the
language's pair and tells opening from closing."""
from prism_lca.engine import report_model as rm


def test_every_quotation_mark_variant_is_straightened():
    assert rm.normalise_quotes("„Methanol“ und «Stahl» und ‚Draht‘ und “PP”") == (
        "\"Methanol\" und \"Stahl\" und 'Draht' und \"PP\""
    )
    # The mixed pair that produced „…„ in a real report.
    assert rm.normalise_quotes("„methanol production\" (CN)") == "\"methanol production\" (CN)"


def test_apostrophes_and_placeholders_survive():
    assert rm.normalise_quotes("the model’s {{hotspots.0.name}}") == "the model's {{hotspots.0.name}}"
    assert rm.normalise_quotes("") == "" and rm.normalise_quotes(None) == ""
