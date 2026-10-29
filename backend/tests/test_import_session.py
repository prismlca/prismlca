"""The import session end to end: read, match, review, write — and what it refuses to do.

The one thing these tests are really about is that **nothing is written before commit**, and that
what commit writes is a database our LCIA methods can still work on.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.dataimport import session
from prism_lca.engine.dataimport.session import Unmatched
from prism_lca.engine.guardrails import is_read_only
from prism_lca.engine.library import LIBRARY_DB
from prism_lca.errors import PrismError

FIXTURES = Path(__file__).parent / "fixtures" / "import"


@pytest.fixture
def biosphere(client, token, project):
    """A small biosphere, written the way test_setup.py does it."""
    bd = get_bd()
    bd.Database("biosphere3").write(
        {
            ("biosphere3", "co2-air"): {
                "name": "Carbon dioxide, fossil", "unit": "kilogram",
                "categories": ("air",), "type": "emission",
            },
        }
    )
    yield
    session.cancel()


def test_reading_writes_nothing(biosphere):
    """The review step only means something if closing the wizard costs nothing."""
    before = set(get_bd().databases)
    summary = session.start(FIXTURES / "ilcd-unitprocess")
    assert summary["datasets"] == 1
    assert set(get_bd().databases) == before


def test_the_deterministic_pass_matches_what_it_can_and_says_so(biosphere):
    session.start(FIXTURES / "ilcd-unitprocess")
    rows = session.rows()
    co2 = next(r for r in rows if r["name"] == "Carbon dioxide, fossil")
    assert co2["confidence"] == "good"
    assert co2["target"]["code"] == "co2-air"
    assert co2["evidence"]

    electricity = next(r for r in rows if r["kind"] == "technosphere")
    assert electricity["confidence"] == "open"
    assert "nothing to link against" in electricity["evidence"]


def test_a_reviewer_can_clear_a_match(biosphere):
    """Saying "not this" has to be as easy as saying "this one", or a wrong match stays standing."""
    session.start(FIXTURES / "ilcd-unitprocess")
    row = next(r for r in session.rows() if r["target"])
    assert session.decide([{"dataset": row["dataset"], "index": row["index"], "code": None}]) == 1
    after = next(r for r in session.rows() if r["index"] == row["index"])
    assert after["target"] is None and after["confidence"] == "open"


def test_commit_writes_into_the_project_library(biosphere):
    """Not a database per import — one library, `My processes`, that every model can draw on.

    A database per source was the Brightway-conventional answer and it loses to one property of
    ours: search runs against exactly one database, so ten suppliers would be ten indexes and a
    user who has to know where a dataset lives before they can look for it.
    """
    session.start(FIXTURES / "ilcd-unitprocess")
    result = session.commit("Widgets from a partner")
    assert result["datasets"] == 1
    assert result["database"] == LIBRARY_DB
    assert not is_read_only(LIBRARY_DB)  # the point of a library: it can be edited
    act = next(iter(get_bd().Database(LIBRARY_DB)))
    # …the biosphere link is intact, which is what keeps every LCIA method working on it.
    assert "biosphere3" in {exc.input.key[0] for exc in act.exchanges()}
    # …and the provenance sits on the dataset, because the database is now permanent.
    assert act.get("prism_import_batch") == result["batch"]
    assert act.get("prism_import_label") == "Widgets from a partner"
    assert act.get("prism_import_source")



def test_a_committed_dataset_has_editable_exchanges(biosphere):
    """Every exchange the wizard writes carries a uid — the editor addresses exchanges by it."""
    session.start(FIXTURES / "ilcd-unitprocess")
    session.commit("Widgets")
    act = next(iter(get_bd().Database(LIBRARY_DB)))
    assert all(ex.get("prism_uid") for ex in act.exchanges())

def test_re_importing_the_same_source_replaces_instead_of_doubling(biosphere):
    """An updated file is the same datasets again. Doubling them would be the worst outcome: two
    datasets with one name, and no way to tell which one a model is drawing on."""
    session.start(FIXTURES / "ilcd-unitprocess")
    first = session.commit("v1")
    session.start(FIXTURES / "ilcd-unitprocess")
    second = session.commit("v2")
    assert second["replaced"] == first["datasets"]
    assert len(get_bd().Database(LIBRARY_DB)) == first["datasets"]
    # The newer import owns the dataset now — that is what "replaced" has to mean.
    act = next(iter(get_bd().Database(LIBRARY_DB)))
    assert act.get("prism_import_batch") == second["batch"]


def test_an_import_lands_beside_what_the_user_built_by_hand(biosphere):
    """The library is not an import folder. A dataset the user made must survive an import, and
    must not be counted as part of one."""
    from prism_lca.engine.library import ensure_library, own_datasets

    ensure_library()
    mine = get_bd().Database(LIBRARY_DB).new_activity(code="mine", name="My own thing", unit="kg")
    mine.save()

    session.start(FIXTURES / "ilcd-unitprocess")
    session.commit("a delivery")
    assert own_datasets() == 1
    assert get_bd().Database(LIBRARY_DB).get("mine")["name"] == "My own thing"


def test_what_cannot_be_matched_is_parked_and_counted(biosphere):
    """A dropped emission makes a dataset look better than it is, and nothing on screen would say
    so. Parked means: not an exchange (it could not be), but visible, counted and reported."""
    session.start(FIXTURES / "ilcd-unitprocess")
    result = session.commit("parked")
    assert result["unmatched"] >= 1
    assert result["unmatched_handling"] == "park"
    act = next(iter(get_bd().Database(LIBRARY_DB)))
    parked = act.get("prism_unmatched")
    assert parked and parked[0]["reason"]


def test_dropping_is_possible_but_is_recorded_as_a_decision(biosphere):
    session.start(FIXTURES / "ilcd-unitprocess")
    result = session.commit("dropped", unmatched=Unmatched.drop)
    assert result["unmatched_handling"] == "drop"
    act = next(iter(get_bd().Database(LIBRARY_DB)))
    assert act.get("prism_unmatched") == []


def test_the_health_check_counts_what_the_import_parked(biosphere):
    """Parking only helps if something later counts it. A dropped emission makes a dataset look
    better than it is; a parked one has to be visible where a modeller already looks."""
    from prism_lca.engine import health

    session.start(FIXTURES / "ilcd-unitprocess")
    session.commit("health")
    report = health.lint_database(LIBRARY_DB)
    unmatched = [f for f in report["findings"] if f["code"] == "imported_unmatched_flows"]
    assert unmatched, report
    assert "could not be matched" in unmatched[0]["message"]


def test_an_import_can_be_removed_again(biosphere):
    """The counterpart to commit. It is per import, not per database, because the library stays —
    "undo that import" cannot mean "delete the place it landed in"."""
    from prism_lca.engine.library import batches, delete_batch

    session.start(FIXTURES / "ilcd-unitprocess")
    result = session.commit("a delivery")
    listed = batches()
    assert [b["batch"] for b in listed] == [result["batch"]]
    assert listed[0]["label"] == "a delivery" and listed[0]["datasets"] == result["datasets"]

    removed = delete_batch(result["batch"])
    assert removed["datasets"] == result["datasets"]
    assert batches() == []
    assert len(get_bd().Database(LIBRARY_DB)) == 0  # the library itself survives, empty


def test_removing_an_import_does_not_strand_a_model_by_accident(biosphere):
    """A dangling exchange is not a visible error — it is a number that quietly stops being there.
    So the models that would lose their source are named, and deleting anyway has to be said."""
    from prism_lca.engine.library import delete_batch

    session.start(FIXTURES / "ilcd-unitprocess")
    result = session.commit("a delivery")
    imported = next(iter(get_bd().Database(LIBRARY_DB)))

    bd = get_bd()
    bd.Database("my-model").write(
        {
            ("my-model", "p"): {
                "name": "Something of mine", "unit": "unit", "type": "process",
                "exchanges": [
                    {"input": ("my-model", "p"), "amount": 1.0, "type": "production"},
                    {"input": imported.key, "amount": 2.0, "type": "technosphere"},
                ],
            }
        }
    )

    with pytest.raises(PrismError) as caught:
        delete_batch(result["batch"])
    assert caught.value.code == "import_in_use"
    assert "my-model" in str(caught.value)
    # …and it goes when the caller says so.
    assert delete_batch(result["batch"], force=True)["was_used_by"] == ["my-model"]


def test_the_library_cannot_be_deleted_like_a_model(biosphere):
    """It is writable, so the read-only guard lets it through — and every model drawing on a
    library dataset would lose it at once."""
    from prism_lca.engine.brightway_repository import BrightwayRepository
    from prism_lca.engine.library import ensure_library

    ensure_library()
    with pytest.raises(PrismError) as caught:
        BrightwayRepository().delete_foreground_database(LIBRARY_DB)
    assert caught.value.code == "library_protected"
    assert LIBRARY_DB in get_bd().databases


def test_the_library_is_not_listed_among_the_models(biosphere):
    """The Overview lists what `kind == 'foreground'` says. A library among the studies would be
    a study people open by accident and then wonder why it has no report."""
    from prism_lca.engine.brightway_repository import BrightwayRepository
    from prism_lca.engine.library import ensure_library

    ensure_library()
    kinds = {d.name: d.kind for d in BrightwayRepository().list_databases()}
    assert kinds[LIBRARY_DB] == "library"


def test_the_library_is_there_before_anyone_imports(biosphere):
    """A library that appears only after the first import is not a place you would think to put
    your own processes in. It exists as soon as the project has an inventory — and not before,
    because an empty project with a library in it would no longer open the ecoinvent wizard."""
    from prism_lca.engine.library import ensure_library_if_set_up

    bd = get_bd()
    assert LIBRARY_DB not in bd.databases
    assert ensure_library_if_set_up() is None  # biosphere alone is not a set-up project

    # An ecoinvent imported before `prism_import_complete` existed carries only the read-only
    # flag — a real project can be one, and checking the marker alone left it without a library.
    bd.Database("ecoinvent-x").register()
    bd.databases["ecoinvent-x"]["prism_read_only"] = True
    bd.databases.flush()
    assert ensure_library_if_set_up() == LIBRARY_DB
    assert LIBRARY_DB in bd.databases


def test_a_background_database_is_never_scanned_for_consumers(biosphere):
    """`consumers_of_keys` walks every model's exchanges. Letting ecoinvent count as a model would
    walk 26 533 activities on every delete — and name ecoinvent as something that "draws on" the
    library, which it cannot."""
    from prism_lca.engine.library import model_databases

    bd = get_bd()
    bd.Database("ecoinvent-old").register()
    bd.databases["ecoinvent-old"]["prism_read_only"] = True  # no `complete` marker: the old shape
    bd.Database("my-model").register()
    bd.databases["my-model"]["prism_read_only"] = False
    bd.Database("unflagged").register()
    bd.databases.flush()

    # The unflagged one is scanned on purpose: a database we cannot classify costs a slow answer,
    # not a wrong one.
    assert model_databases() == ["my-model", "unflagged"]


def test_a_match_whose_units_cannot_convert_lands_in_the_lowest_band(biosphere):
    """Whoever made it. The amount would go in unchanged and mean something else, and the band is
    what a reviewer filters by — so it has to carry that, not just the note beside it."""
    from prism_lca.engine.dataimport import session as s

    # A second flow measured in a volume, so there is something incompatible to point at.
    get_bd().Database("biosphere3").new_activity(
        code="water-air", name="Water", unit="cubic meter", categories=("air",), type="emission"
    ).save()

    s.start(FIXTURES / "ilcd-unitprocess")
    row = next(r for r in s.rows() if r["kind"] == "biosphere")
    volume = next(c for c in s.candidates("water", "biosphere") if "meter" in (c["unit"] or ""))
    applied = s.decide(
        [
            {
                "dataset": row["dataset"],
                "index": row["index"],
                "database": volume["database"],
                "code": volume["code"],
                "confidence": "medium",  # asked for medium…
            }
        ]
    )
    assert applied == 1
    after = next(r for r in s.rows() if r["index"] == row["index"])
    assert after["confidence"] == "low"  # …and got low, because the units do not convert
    assert "cannot be converted" in after["scale"]



def test_a_reviewer_can_bridge_mass_and_volume_with_a_stated_density(biosphere):
    """A mass flow matched to a volume flow converts only through a property of the substance. The
    row says so, so the wizard can ask for it; the reviewer's figure is applied and written down,
    and the band stays low because the number came from a person, not the source."""
    from prism_lca.engine.dataimport import session as s

    get_bd().Database("biosphere3").new_activity(
        code="water-air", name="Water", unit="cubic meter", categories=("air",), type="emission"
    ).save()
    s.start(FIXTURES / "ilcd-unitprocess")
    row = next(r for r in s.rows() if r["kind"] == "biosphere")
    assert row["needs_assumption"] is False  # matched by the rules in its own unit
    base = {"dataset": row["dataset"], "index": row["index"], "database": "biosphere3", "code": "water-air"}

    s.decide([base])
    bare = next(r for r in s.rows() if r["index"] == row["index"])
    assert bare["needs_assumption"] is True
    assert bare["factor"] == 1.0 and bare["confidence"] == "low"

    # 1 kg/L liquid water: one kilogram is 0.001 cubic metre — the factor, not the density.
    s.decide([{**base, "assumption": {"quantity": 0.001, "what": "liquid water, 1 kg/L"}}])
    bridged = next(r for r in s.rows() if r["index"] == row["index"])
    assert bridged["factor"] == 0.001
    assert abs(bridged["scaled_amount"] - row["amount"] * 0.001) < 1e-12
    assert "liquid water, 1 kg/L" in bridged["scale"]
    assert bridged["confidence"] == "low"
    assert bridged["needs_assumption"] is True  # still the reviewer's figure, still editable

    # …and after the commit the figure is still readable where the number lives.
    s.commit("bridged")
    lib = get_bd().Database(LIBRARY_DB)
    ex = next(
        e for a in lib for e in a.exchanges() if e.input.key == ("biosphere3", "water-air")
    )
    assert "liquid water, 1 kg/L" in (ex.get("comment") or "")

def test_a_decision_always_brings_its_own_conversion(biosphere):
    """Whoever made it — reviewer or matching model.

    Until the free lookup was built, `decide` set the target and left `factor` at whatever the rule
    pass had put there: 1.0 for a row the rules could not settle. So a model match that needed a
    conversion imported the raw number. The arithmetic is not the model's job — it never sees a
    factor and never returns one — but it has to happen for its choices too.
    """
    from prism_lca.engine.dataimport import session as s

    get_bd().Database("biosphere3").new_activity(
        code="co2-air-grams", name="Carbon dioxide, fossil", unit="gram",
        categories=("air",), type="emission",
    ).save()

    s.start(FIXTURES / "ilcd-unitprocess")
    row = next(r for r in s.rows() if r["kind"] == "biosphere" and r["unit"] == "kg")
    assert s.decide([{"dataset": row["dataset"], "index": row["index"], "code": "co2-air-grams"}]) == 1

    after = next(r for r in s.rows() if r["index"] == row["index"])
    assert after["factor"] == 1000.0
    assert after["scaled_amount"] == after["amount"] * 1000.0


def test_a_guessed_region_stays_the_reviewers_call():
    """The dataset exists in several regions and the source names none: whichever region the match
    carries is search-order, not a decision — so it blocks the commit until a person picks."""
    from prism_lca.engine.dataimport.matching import Candidate, Match
    from prism_lca.engine.dataimport.model import ForeignExchange
    from prism_lca.engine.dataimport.session import Row, _region_still_open

    def variant(code, location):
        return Candidate(
            database="bg", code=code, name="electricity, medium voltage",
            unit="kilowatt hour", location=location,
        )

    de, us = variant("de", "DE"), variant("us", "US")
    exchange = ForeignExchange(kind="technosphere", name="electricity", amount=1.0, unit="kWh")
    row = Row(dataset="widget", index=1, match=Match(exchange=exchange, candidates=[de, us]))

    # No source region, two variants: open — whoever ends up as target.
    assert _region_still_open(row, de, {}, {}) is True
    # The reviewer's explicit pick closes it.
    assert _region_still_open(row, de, {"region_chosen": True}, {}) is False
    # A region the SOURCE named is a decision, not a guess.
    assert _region_still_open(row, us, {}, {"widget": "US"}) is False
    # ...but only when the target actually honours it.
    assert _region_still_open(row, de, {}, {"widget": "US"}) is True
    # One region only: nothing to choose.
    single = Row(dataset="widget", index=2, match=Match(exchange=exchange, candidates=[de]))
    assert _region_still_open(single, de, {}, {}) is False
    # A flow never carries a region question.
    flow = ForeignExchange(kind="biosphere", name="CO2", amount=1.0, unit="kg")
    bio = Row(dataset="widget", index=3, match=Match(exchange=flow, candidates=[de, us]))
    assert _region_still_open(bio, de, {}, {}) is False


def test_a_read_can_be_stopped_and_leaves_nothing_behind(biosphere, monkeypatch):
    """Stopping is the way out of a wrong file, and it has to be free.

    A 3000-dataset package matches for minutes; until the wizard grew a Stop the only way out was
    closing the window, which left the pass running behind it. What the stop must guarantee is what
    every other step here guarantees: no session, no database, nothing to clean up.
    """
    seen: list[str] = []
    real = session.match_biosphere

    def stop_after_the_first_row(*args, **kwargs):
        # Stopped from the outside, mid-pass — the same thing POST /import/stop does. Once only,
        # so the second read below runs through and shows the flag did not survive the first.
        if not seen:
            session.stop_reading()
        seen.append("row")
        return real(*args, **kwargs)

    monkeypatch.setattr(session, "match_biosphere", stop_after_the_first_row)
    before = set(get_bd().databases)

    with pytest.raises(session.ImportStopped):
        session.start(FIXTURES / "ilcd-unitprocess")

    assert seen, "the pass has to have started for the stop to mean anything"
    assert session.state() == {"active": False}
    assert set(get_bd().databases) == before
    # The flag does not outlive its pass: the next read must not die on the last one's stop.
    assert session.start(FIXTURES / "ilcd-unitprocess")["datasets"] == 1


def test_a_reimport_keeps_the_links_of_models_that_use_the_dataset(biosphere):
    """Replacing a dataset went through bw2data's delete(), which cascades into
    the exchanges of every process consuming it — a re-import emptied inputs out of models."""
    session.start(FIXTURES / "ilcd-unitprocess")
    code = session.commit("first")["codes"][0]
    bd = get_bd()
    fg = bd.Database("fg-uses-library")
    fg.register()
    widget = fg.new_activity(code="widget", name="widget", unit="unit")
    widget.save()
    widget.new_edge(input=widget, amount=1, type="production").save()
    widget.new_edge(input=(LIBRARY_DB, code), amount=2.5, type="technosphere").save()

    session.start(FIXTURES / "ilcd-unitprocess")
    again = session.commit("second")
    assert again["replaced"] == 1 and again["codes"] == [code]
    links = [e for e in bd.get_node(database="fg-uses-library", code="widget").technosphere()
             if e.input.key == (LIBRARY_DB, code)]
    assert len(links) == 1 and links[0]["amount"] == 2.5


def test_amounts_are_written_per_one_unit_of_the_reference(biosphere):
    """The production was written as 1 and nothing else was divided, so a source
    making 10 kg with 20 kg of CO2 landed as 20 kg per kg."""
    session.start(FIXTURES / "ilcd-unitprocess")
    dataset = session._current.datasets[0]
    production = next(e for e in dataset.exchanges if e.kind == "production")
    co2 = next(e for e in dataset.exchanges if e.name == "Carbon dioxide, fossil")
    production.amount, co2.amount = 10.0, 20.0
    code = session.commit("per unit")["codes"][0]
    act = get_bd().get_node(database=LIBRARY_DB, code=code)
    assert [e["amount"] for e in act.production()] == [1.0]
    written = next(e for e in act.biosphere() if e.input["name"] == "Carbon dioxide, fossil")
    assert abs(written["amount"] - 2.0) < 1e-12


def test_rows_carry_the_dataset_key_and_a_decision_may_use_it(biosphere):
    """Rows were keyed by the dataset NAME, and two datasets of one name pooled
    their inventories at commit."""
    session.start(FIXTURES / "ilcd-unitprocess")
    row = next(r for r in session.rows() if r["target"])
    assert row["dataset_key"] and row["dataset_key"] != row["dataset"]  # the UUID, not the name
    assert session.decide(
        [{"dataset_key": row["dataset_key"], "dataset": "not the name", "index": row["index"], "code": None}]
    ) == 1
    assert next(r for r in session.rows() if r["index"] == row["index"])["target"] is None


def test_clearing_a_match_clears_its_region_question(biosphere):
    """A cleared row kept counting as an open region decision and blocked the commit."""
    session.start(FIXTURES / "ilcd-unitprocess")
    row = next(r for r in session.rows() if r["target"])
    live = next(r for r in session._current.rows if r.index == row["index"] and r.dataset == row["dataset"])
    live.match.region_open = True
    assert session.state()["region_open"] == 1
    session.decide([{"dataset": row["dataset"], "index": row["index"], "code": None}])
    assert session.state()["region_open"] == 0


def test_a_commit_after_a_project_switch_is_refused(biosphere):
    """The matches belong to the project the file was read in; a commit wrote them
    into whichever project was active."""
    import uuid as _uuid

    session.start(FIXTURES / "ilcd-unitprocess")
    bd = get_bd()
    home = bd.projects.current
    bd.projects.set_current(f"prism-test-elsewhere-{_uuid.uuid4().hex[:6]}")
    try:
        with pytest.raises(PrismError) as refused:
            session.commit("elsewhere")
        assert refused.value.code == "import_project_changed"
    finally:
        bd.projects.set_current(home)
