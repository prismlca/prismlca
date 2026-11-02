"""The fast path of the sensitivity runs: the same numbers as writing every step, without writing.

The model is built to hold every shape the block solve has to get right, each one a place where a sign or
an index could go wrong without a simple model noticing:

* ``part`` makes its product at a parameterised ``yield_part`` (a production amount), draws background power
  and leaks methane by a parameter (an emission);
* ``product`` uses parts, background steel twice (one fixed exchange and two parameterised ones on the same
  pair, summed in the matrix), gets a credit for power (``substitution``, the positive edge type), and
  sends a share to ``recycle``, which takes a little ``product`` back — a loop inside the model;
* ``waste`` is a treatment (production −1), scored with the demand sign flipped;
* ``consumer`` in another database uses ``product``: once the cached system holds it, the block has to
  take it in, or the shortcut ``A[F, R] = 0`` would be false.

Every comparison runs the same call twice — fast, then with the steps written — and holds them to 1e-12.
"""
from __future__ import annotations

import threading

import pytest

from prism_lca.engine import lca, param_window, params, sensitivity, sensitivity_fast
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

DB = "fx"
GWP = ("t", "gwp")
CH4 = ("t", "ch4")


@pytest.fixture(autouse=True)
def _clean():
    yield
    param_window.reset_for_tests()


def _model(client, token, *, consumer: bool = False) -> None:
    bd = get_bd()
    bd.Database("bio").write({
        ("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"},
        ("bio", "ch4"): {"name": "CH4", "type": "emission", "categories": ("air",), "unit": "kg"},
    })
    bd.Database("bg").write({
        ("bg", "steel"): {"name": "steel", "unit": "kg", "exchanges": [
            {"input": ("bg", "steel"), "amount": 1, "type": "production"},
            {"input": ("bio", "co2"), "amount": 2.0, "type": "biosphere"},
        ]},
        ("bg", "power"): {"name": "power", "unit": "kWh", "exchanges": [
            {"input": ("bg", "power"), "amount": 1, "type": "production"},
            {"input": ("bg", "steel"), "amount": 0.01, "type": "technosphere"},
            {"input": ("bio", "co2"), "amount": 0.4, "type": "biosphere"},
        ]},
    })

    def ex(source, amount, kind, formula=None):
        out = {"input": source, "amount": amount, "type": kind}
        if formula:
            out["formula"] = formula
        return out

    bd.Database(DB).write({
        (DB, "part"): {"name": "part", "unit": "unit", "exchanges": [
            ex((DB, "part"), 1.0, "production", "yield_part"),
            ex(("bg", "power"), 3.0, "technosphere", "kwh_part"),
            ex(("bio", "ch4"), 0.002, "biosphere", "leak"),
        ]},
        (DB, "product"): {"name": "product", "unit": "unit", "exchanges": [
            ex((DB, "product"), 1.0, "production"),
            ex((DB, "part"), 4.0, "technosphere", "n_parts"),
            ex(("bg", "steel"), 0.1, "technosphere"),
            ex(("bg", "steel"), 0.5, "technosphere", "steel_kg"),
            ex(("bg", "steel"), 0.2, "technosphere", "steel_extra"),
            ex(("bg", "power"), 0.3, "substitution", "credit_kwh"),
            ex((DB, "recycle"), 0.25, "technosphere", "r_share"),
            ex(("bio", "co2"), 6.0, "biosphere", "d"),
        ]},
        (DB, "recycle"): {"name": "recycle", "unit": "unit", "exchanges": [
            ex((DB, "recycle"), 1.0, "production"),
            ex((DB, "product"), 0.01, "technosphere"),
            ex(("bio", "co2"), 0.05, "biosphere"),
        ]},
        (DB, "waste"): {"name": "waste", "unit": "kg", "exchanges": [
            ex((DB, "waste"), -1.0, "production"),
            ex(("bio", "co2"), 2.5, "biosphere", "burn_co2"),
        ]},
    })
    if consumer:
        bd.Database("other").write({
            ("other", "consumer"): {"name": "consumer", "unit": "unit", "exchanges": [
                {"input": ("other", "consumer"), "amount": 1, "type": "production"},
                {"input": (DB, "product"), "amount": 1.0, "type": "technosphere"},
                {"input": ("bio", "co2"), "amount": 1.0, "type": "biosphere"},
            ]},
        })
    bd.Method(GWP).write([(("bio", "co2"), 1.0), (("bio", "ch4"), 28.0)])
    bd.Method(CH4).write([(("bio", "ch4"), 1.0)])

    def p(**kw):
        r = client.post("/api/v1/params", json={"database": DB, **kw}, headers=token)
        assert r.status_code == 200, r.text

    for name, amount in (("yield_part", 1.0), ("kwh_part", 3.0), ("leak", 0.002), ("n_parts", 4.0), ("steel_kg", 0.5),
                         ("steel_extra", 0.2), ("credit_kwh", 0.3), ("burn_co2", 2.5)):
        p(name=name, amount=amount)
    p(name="r_share", amount=0.25, rule={"kind": "range", "min": 0, "max": 1})
    p(name="d", formula="2 * kwh_part")
    for code in ("part", "product", "waste"):
        params.register_activity_group(bd.get_node(database=DB, code=code))
    params.recalc_database(DB)


def _both(monkeypatch, call):
    """``call()`` on the fast path, then with every step written — after checking the fast one was taken."""
    taken: list[bool] = []
    real = sensitivity_fast.build

    def watched(*args, **kwargs):
        out = real(*args, **kwargs)
        taken.append(out is not None)
        return out

    monkeypatch.setattr(sensitivity_fast, "build", watched)
    fast = call()
    assert taken and all(taken), "the fast path did not take the model"
    monkeypatch.setattr(sensitivity_fast, "ENABLED", False)
    written = call()
    monkeypatch.setattr(sensitivity_fast, "ENABLED", True)
    return fast, written


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-12 * max(abs(a), abs(b), 1e-300)


def _same_tornado(fast: dict, written: dict) -> None:
    assert all(_close(a, b) for a, b in zip(fast["baseline"], written["baseline"], strict=True))
    by_param = {e["param"]: e for e in written["entries"]}
    assert set(by_param) == {e["param"] for e in fast["entries"]}
    for e in fast["entries"]:
        w = by_param[e["param"]]
        for side in ("low", "high"):
            assert all(_close(a, b) for a, b in zip(e[side], w[side], strict=True)), (e["param"], side, e, w)
        assert {k: e.get(k) for k in ("low_value", "high_value", "limited", "breaks")} == \
            {k: w.get(k) for k in ("low_value", "high_value", "limited", "breaks")}
    assert fast.get("skipped") == written.get("skipped")


@pytest.mark.parametrize("code", ["product", "part", "waste"])
def test_the_tornado_is_the_same_both_ways(client, token, project, monkeypatch, code):
    _model(client, token)
    fast, written = _both(monkeypatch, lambda: sensitivity.tornado(DB, code, [GWP, CH4], 0.25))
    _same_tornado(fast, written)
    moved = [e for e in fast["entries"] if e["high"][0] != e["low"][0]]
    assert moved, "nothing moved: the model does not exercise the path"


def test_a_scenario_start_is_the_same_both_ways(client, token, project, monkeypatch):
    _model(client, token)
    r = client.post("/api/v1/scenarios", json={"database": DB, "name": "Lean",
                                               "overrides": {"steel_kg": 0.3, "d": "3 * kwh_part"}},
                    headers=token)
    assert r.status_code == 200, r.text
    sid = r.json()["scenario"]["id"]
    fast, written = _both(monkeypatch, lambda: sensitivity.tornado(DB, "product", [GWP], 0.1, scenario_id=sid))
    _same_tornado(fast, written)
    fast, written = _both(monkeypatch, lambda: sensitivity.curve(
        DB, "product", GWP, "n_parts", [1.0, 2.5, 6.0], [None, sid]))
    for f, w in zip(fast["curves"], written["curves"], strict=True):
        assert _close(f["origin"]["score"], w["origin"]["score"]) and f["origin"]["value"] == w["origin"]["value"]
        assert all(_close(a, b) for a, b in zip(f["scores"], w["scores"], strict=True))


def test_a_product_used_outside_the_model_widens_the_block(client, token, project, monkeypatch):
    """With the consumer in the cached system, its column holds a model product: left out of the block,
    the score of every step would miss what flows back through it."""
    _model(client, token, consumer=True)
    consumer = get_bd().get_node(database="other", code="consumer")
    with lca._LCA_LOCK:
        lca.get_lca({consumer.id: 1.0}, GWP)  # the cache now holds the system with the consumer in it
        fast = sensitivity_fast.build(DB, "product", [GWP], 1.0)
    assert fast is not None and len(fast.f) == 5  # four model processes and the consumer
    pair = _both(monkeypatch, lambda: sensitivity.tornado(DB, "product", [GWP], 0.25))
    _same_tornado(*pair)


def test_a_fast_run_writes_nothing_and_lets_other_calculations_through(client, token, project, monkeypatch):
    _model(client, token)

    def refuse(*_args, **_kwargs):
        raise AssertionError("a fast run wrote into the model")

    monkeypatch.setattr(params, "apply_values", refuse)
    free: list[bool] = []

    def progress(done, _total, _label):
        if done > 1:  # inside the steps
            got: list[bool] = []

            def other_calculation():
                if lca._LCA_LOCK.acquire(timeout=2):
                    lca._LCA_LOCK.release()
                    got.append(True)
                else:
                    got.append(False)

            t = threading.Thread(target=other_calculation)
            t.start()
            t.join()
            free.append(got[0])

    sensitivity.tornado(DB, "product", [GWP], 0.1, progress=progress)
    assert free and all(free)
    assert not param_window.path().exists()


def test_activity_parameters_with_formulas_leave_the_run_to_the_written_steps(client, token, project):
    _model(client, token)
    from bw2data.parameters import ActivityParameter

    ActivityParameter.create(group=f"prism__{DB}__part", database=DB, code="part", name="local", formula="2 * yield_part",
                             amount=2.0)
    with lca._LCA_LOCK:
        assert sensitivity_fast.build(DB, "part", [GWP], 1.0) is None
    out = sensitivity.tornado(DB, "part", [GWP], 0.1)  # and the run still answers, by writing
    assert out["entries"]


def test_a_stored_amount_the_formulas_do_not_give_leaves_the_run_to_the_written_steps(client, token, project):
    """An amount stored behind its formula's back: the fast path cannot tell a stale amount from an
    evaluation of its own that went wrong, and either way it must not answer."""
    _model(client, token)
    from bw2data.backends.schema import ExchangeDataset

    row = next(e for e in ExchangeDataset.select().where(ExchangeDataset.output_code == "waste")
               if e.data.get("formula") == "burn_co2")
    row.data = {**row.data, "amount": 9.0}
    row.save()
    lca.invalidate_lca_cache()
    with lca._LCA_LOCK:
        assert sensitivity_fast.build(DB, "waste", [GWP], 1.0) is None


def test_an_edit_during_the_build_drops_the_fast_path(client, token, project, monkeypatch):
    _model(client, token)
    real = sensitivity_fast._build

    def edited(*args, **kwargs):
        out = real(*args, **kwargs)
        lca.invalidate_lca_cache()  # what a parameter edit does, without the lock
        return out

    monkeypatch.setattr(sensitivity_fast, "_build", edited)
    with lca._LCA_LOCK:
        assert sensitivity_fast.build(DB, "product", [GWP], 1.0) is None


def test_a_formula_that_fails_at_a_step_says_so(client, token, project):
    _model(client, token)
    r = client.post("/api/v1/params", json={"database": DB, "name": "d", "formula": "1 / (4 - kwh_part)"},
                    headers=token)
    assert r.status_code == 200, r.text
    with pytest.raises(PrismError) as info:
        sensitivity.curve(DB, "product", GWP, "kwh_part", [2.0, 4.0])
    assert info.value.code in {"formula_error", "sensitivity_singular"}


def test_a_step_without_a_way_out_says_so(client, token, project):
    _model(client, token)
    with pytest.raises(PrismError) as info:
        sensitivity.curve(DB, "part", GWP, "yield_part", [0.0])
    assert info.value.code == "sensitivity_singular"


def test_a_production_turned_negative_turns_the_demand_round(client, token, project, monkeypatch):
    """The write path reads the demand's sign off the subject's first production on every step
    (`lca._demand_sign`); a step that turns it negative scores the treatment, not minus it."""
    _model(client, token)
    fast, written = _both(monkeypatch, lambda: sensitivity.curve(DB, "part", GWP, "yield_part", [0.5, -1.0, -2.0]))
    for f, w in zip(fast["curves"][0]["scores"], written["curves"][0]["scores"], strict=True):
        assert _close(f, w), (fast["curves"], written["curves"])


def test_equal_amounts_on_one_pair_are_summed_in_brightways_order(client, token, project, monkeypatch):
    """Three exchanges on one pair and nothing else on it: a credit of 2⁻²⁴, an input of `p` and a credit of 1. At
    p = 1 the input and the large credit tie on amount, and the order Brightway sums them in decides the float32
    result (0, where a sort on row, column and amount alone gives 6e-8): the fast path has to take the same one."""
    _model(client, token)
    bd = get_bd()
    act = bd.get_node(database=DB, code="recycle")
    for amount, kind, formula in ((2.0**-24, "substitution", None), (0.9, "technosphere", "tie_p"),
                                  (1.0, "substitution", None)):
        ex = act.new_exchange(input=("bg", "steel"), amount=amount, type=kind)
        if formula:
            ex["formula"] = formula
        ex.save()
    r = client.post("/api/v1/params", json={"database": DB, "name": "tie_p", "amount": 0.9}, headers=token)
    assert r.status_code == 200, r.text
    params.register_activity_group(act)
    params.recalc_database(DB)
    fast, written = _both(monkeypatch, lambda: sensitivity.curve(DB, "product", GWP, "tie_p", [0.9, 1.0, 1.1]))
    # The other order moves the steel entry by 6e-8 kg, about 1e-9 of the score; the two solvers differ by 1e-16.
    for f, w in zip(fast["curves"][0]["scores"], written["curves"][0]["scores"], strict=True):
        assert _close(f, w), (f, w)


def test_a_records_own_rescale_factor_is_applied_after_the_flip():
    """matrix_utils multiplies by a record's `rescale` after flipping and before summing; the assembly must too,
    or a parameterised exchange carrying one moves by the wrong amount."""
    from prism_lca.engine.sensitivity_fast import _Entries

    entries = _Entries(data=[{"amount": 0.0, "rescale": 2.0}, {"amount": 1.0}], ids=[(5, 9, True), (5, 9, False)],
                       rows_of={5: 0}, cols_of={9: 0})
    _r, _c, v = entries.assemble({0: 1.5})
    assert v.tolist() == [-2.0]  # −1.5 × 2 + 1
