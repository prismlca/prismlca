"""The resolution ladder, tested where it is cheapest: as a function, with no database in sight.

That it *is* a function is the design decision under test — the dry run the user reads before
importing is this output, so preview and import cannot drift apart.
"""
from __future__ import annotations

from prism_lca.engine.bundle_resolve import Installed, Reference, Verdict, resolve, summary

FP = ("market for electricity, low voltage", "electricity, low voltage", "DE", "kilowatt hour")


def _ref(**kw) -> Reference:
    base = dict(database="ecoinvent-3.12-cutoff", code="abc", name=FP[0],
                reference_product=FP[1], location=FP[2], unit=FP[3], version="3.12")
    base.update(kw)
    return Reference(**base)


def _installed(name="ecoinvent-3.12-cutoff", version="3.12", codes=None) -> Installed:
    return Installed(name=name, version=version, by_code=codes or {"abc": FP})


def test_the_normal_case_is_found_where_the_bundle_said():
    [r] = resolve([_ref()], [_installed()])
    assert r.verdict is Verdict.exact
    assert (r.database, r.code) == ("ecoinvent-3.12-cutoff", "abc")


def test_a_differently_named_database_is_relinked():
    """The frequent real failure: same data, `ecoinvent 3.12 cutoff` vs `ecoinvent-3.12-cutoff`."""
    [r] = resolve([_ref()], [_installed(name="ecoinvent 3.12 cutoff")])
    assert r.verdict is Verdict.relinked
    assert r.database == "ecoinvent 3.12 cutoff"
    assert r.code == "abc"
    assert "name differed" in r.detail


def test_a_changed_code_is_matched_by_its_description():
    [r] = resolve([_ref(code="gone")], [_installed(codes={"newcode": FP})])
    assert r.verdict is Verdict.matched
    assert r.code == "newcode"


def test_two_equally_good_matches_ask_instead_of_guessing():
    inst = [_installed(codes={"c1": FP}), _installed(name="ei-copy", codes={"c2": FP})]
    [r] = resolve([_ref(code="gone")], inst)
    assert r.verdict is Verdict.ambiguous
    assert {c["code"] for c in r.candidates} == {"c1", "c2"}


def test_nothing_here_is_missing_and_says_so():
    [r] = resolve([_ref(code="gone", name="something else")], [_installed()])
    assert r.verdict is Verdict.missing
    assert not r.resolved


def test_another_ecoinvent_version_is_refused_rather_than_relinked():
    """Across versions, stop. A 3.11 dataset is not the 3.12 number."""
    [r] = resolve([_ref(version="3.11")], [_installed(name="ecoinvent-3.12-cutoff", version="3.12")])
    assert r.verdict is Verdict.version
    # A database of the same NAME holding another version is the quietest way to wrong numbers.
    assert "same name, different data" in r.detail
    assert not r.resolved


def test_the_cross_version_path_exists_and_stays_switched_off():
    """The later stages are built and tested; enabling them is a release decision, not a rewrite."""
    refs = [_ref(version="3.11", code="gone")]
    inst = [_installed(version="3.12", codes={"newcode": FP})]
    assert resolve(refs, inst)[0].verdict is Verdict.version
    r = resolve(refs, inst, allow_cross_version=True)[0]
    assert r.verdict is Verdict.matched
    assert "numbers may differ" in r.detail


def test_an_unknown_version_on_either_side_does_not_block():
    """Not every database says which ecoinvent it is; "do not know" must not read as "different"."""
    [r] = resolve([_ref(version="")], [_installed(name="my-ei", version="")])
    assert r.verdict is Verdict.relinked


def test_the_summary_tells_the_ui_the_one_thing_it_must_branch_on():
    res = resolve([_ref(), _ref(code="gone", name="nope")], [_installed()])
    s = summary(res)
    assert s["total"] == 2
    assert s["resolved"] == 1
    assert s["can_import"] is False
    assert s["counts"]["missing"] == 1

    ok = summary(resolve([_ref()], [_installed()]))
    assert ok["can_import"] is True


def test_case_and_padding_do_not_decide_a_match():
    ref = _ref(code="gone", name="  Market For Electricity, Low Voltage ")
    [r] = resolve([ref], [_installed(codes={"c9": FP})])
    assert r.verdict is Verdict.matched
