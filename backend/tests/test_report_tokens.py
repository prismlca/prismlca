"""The placeholder grammar, tested directly for the first time.

For a long time the language had no test module of its own — its rules were pinned only through
`test_report_derivations` (evaluation) and the render/gate suites (integration). These tests state
the grammar itself: which strings ARE tokens, how a token decomposes into the paths it reads, and
the small static facts (arity, percent flag, aggregate-ness) every checker downstream relies on.
"""

from prism_lca.engine import report_tokens as rt


def test_placeholder_forms():
    text = (
        "Plain {{results.0.score}}, padded {{ hotspots.1.name }}, "
        "a ref {{ref:t-lcia}}, a declaration {{rank:contribution.groups.0}}, "
        "a derivation {{percent(a.b, c.d)}} — but not {single} braces and not {{unclosed."
    )
    assert rt.placeholders_in(text) == [
        "results.0.score",
        "hotspots.1.name",
        "ref:t-lcia",
        "rank:contribution.groups.0",
        "percent(a.b, c.d)",
    ]


def test_paths_in_token_decomposition():
    # A plain path reads itself; a ref reads nothing; a declaration reads its member with the
    # prefix stripped (the one line that makes `rank:` invisible downstream); a derivation reads
    # its path arguments and skips numeric literals.
    assert rt.paths_in_token("results.0.score") == ["results.0.score"]
    assert rt.paths_in_token("ref:t-lcia") == []
    assert rt.paths_in_token("rank:contribution.groups.0") == ["contribution.groups.0"]
    assert rt.paths_in_token("percent(hotspots.0.direct, 100)") == ["hotspots.0.direct"]


def test_rank_path_only_strips_the_prefix():
    assert rt.rank_path("rank:subjects.1") == "subjects.1"
    assert rt.rank_path("rank:") is None
    assert rt.rank_path("results.0.score") is None


def test_derivation_table_arity_and_percent_flag():
    # The static facts checkers read straight off the table: `sum` is variadic (arity None) and
    # therefore the only aggregate; percent/change print their own sign, sum/diff/factor do not.
    assert {name for name, (arity, _fn, _pct) in rt.DERIVATIONS.items() if arity is None} == {"sum"}
    assert rt.AGGREGATES == frozenset({"sum"})
    assert {name for name, (_a, _fn, pct) in rt.DERIVATIONS.items() if pct} == {"percent", "change"}
    assert rt.is_aggregate("sum(a, b, c)")
    assert not rt.is_aggregate("diff(a, b)")
    assert not rt.is_aggregate("sum")  # not a call — a path that happens to be named sum


def test_prints_own_unit():
    # `…_text` carries its unit, percent/change print a sign by definition, a sum of shares is a
    # share — and a DIFFERENCE of two shares is percentage points, so it deliberately does not (V168).
    assert rt.prints_own_unit("contribution.groups.0.share_text")
    assert rt.prints_own_unit("percent(a.b, c.d)")
    assert rt.prints_own_unit("sum(a.share_percent, b.share_percent)")
    assert not rt.prints_own_unit("diff(a.share_percent, b.share_percent)")
    assert not rt.prints_own_unit("results.0.score")


def test_unfence_removes_only_pure_placeholder_fences():
    assert rt.unfence("a `{{results.0.score}}` b") == "a {{results.0.score}} b"
    # A real code span stays: it holds words, not just one token.
    assert rt.unfence("a `mass_kg` b") == "a `mass_kg` b"
    assert rt.unfence("`{{x}} and words`") == "`{{x}} and words`"


def test_lookup_paths():
    data = {"results": [{"score": 1.5, "unit": "kg"}], "study": {"goal": "g"}}
    assert rt.lookup("results.0.score", data) == 1.5
    assert rt.lookup("study.goal", data) == "g"
    assert rt.lookup("results.7.score", data) is None
    assert rt.lookup("results.x", data) is None
    assert rt.lookup("", data) is None


def test_unit_of_shares_and_companions():
    data = {
        "hotspots": [{"unit": "kilogram", "direct": 2.0, "direct_unit": "kg CO2-Eq"}],
        "results": [{"unit": "MJ", "score": 3.0}],
    }
    # The value's own companion key beats the container's physical unit (the ISO-violation refusal
    # this rule exists for), shares carry their scale in the suffix, unknown stays None.
    assert rt.unit_of("hotspots.0.direct", data) == "kg CO2-Eq"
    assert rt.unit_of("results.0.score", data) == "MJ"
    assert rt.unit_of("x.share_percent", data) == "%"
    assert rt.unit_of("x.share", data) == "share"
    assert rt.unit_of("nowhere.at.all", data) is None
