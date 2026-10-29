"""The shared sentence rule — one implementation for judging (claims) and quoting (patch).

Before `report_sentences`, the two modules carried separate copies that agreed on every real
chapter but not by construction: `report_patch` split the raw text, so anything inside a
placeholder that happened to look like a sentence end ("… followed by whitespace and a capital",
possible in a derivation's argument list) would have torn the token apart in the quoting layer
while the judging layer kept it whole. These tests pin the shared behaviour.
"""

from prism_lca.engine import report_claims as rc
from prism_lca.engine import report_patch as rp
from prism_lca.engine import report_sentences as rs


def test_spans_and_strings_are_the_same_cut():
    text = "Packaging leads with {{contributions.0.groups.1.share_text}}. The use phase follows! Done?"
    spans = rs.sentence_spans(text)
    assert [text[a:b] for a, b in spans] == rs.sentences(text)
    assert [s.strip() for s in rs.sentences(text)] == [
        "Packaging leads with {{contributions.0.groups.1.share_text}}.",
        "The use phase follows!",
        "Done?",
    ]


def test_nothing_inside_a_placeholder_ends_a_sentence():
    # A derivation's argument list is the one place a placeholder can hold whitespace, and with it
    # the ". Capital" shape that ends a sentence in prose. The mask keeps the token whole — and
    # because it is length-preserving, the spans still address the original text exactly.
    text = "It cites {{sum(a.total, b.Total)}} of the result. Second sentence."
    assert len(rs.sentence_spans(text)) == 2
    start, end = rs.sentence_spans(text)[0]
    assert text[start:end] == "It cites {{sum(a.total, b.Total)}} of the result."


def test_terminators_inside_names_do_not_split():
    # The rule both originals enforced: a terminator only ends a sentence at whitespace followed by
    # a capital, so "ecoinvent-3.12-cutoff" stays whole. An abbreviation before a capital ("z. B.")
    # DOES split — a known imperfection inherited from both originals, pinned here so a change to it
    # is a decision and not an accident.
    assert len(rs.sentences("Version ecoinvent-3.12-cutoff is used. Second sentence.")) == 2
    assert len(rs.sentences("Es gilt z. B. hier nichts anderes.")) == 2
    assert len(rs.sentences("Es gilt z. b. hier nichts anderes.")) == 1


def test_patch_and_claims_consume_the_same_rule():
    text = "First {{subjects.1.results.0.score}} sentence. Second one."
    patch_view = [text[a:b].strip() for a, b in rp.sentences(text)]
    claims_view = [s.strip() for s in rc._sentences(text)]
    assert patch_view == claims_view == ["First {{subjects.1.results.0.score}} sentence.", "Second one."]


def test_empty_and_terminatorless_text():
    assert rs.sentences("") == []
    assert rs.sentences("No terminator at all") == ["No terminator at all"]
