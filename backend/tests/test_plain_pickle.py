"""What counts as a pickle of plain values: the opcodes that build them, and a bounded expanded size."""
from __future__ import annotations

import collections
import datetime
import pickle

import pytest

from prism_lca.engine import plain_pickle

EXCHANGE = {"input": ("db", "a" * 32), "output": ("db", "b" * 32), "amount": 0.0123, "type": "technosphere",
            "uncertainty type": 2, "loc": -4.4, "scale": 0.2, "pedigree": {"reliability": 2},
            "properties": {"carbon content": {"amount": 0.5, "unit": "dimensionless"}}, "big": 10**30,
            "neg": -5, "none": None, "flags": [True, False], "blob": b"\x00" * 300}
WITH_SETS = dict(EXCHANGE, tags={1, 2}, frozen=frozenset({3}))


@pytest.mark.parametrize("protocol", range(pickle.HIGHEST_PROTOCOL + 1))
def test_plain_values_pass_in_every_protocol(protocol):
    # Older protocols spell sets (below 4) and bytes (below 3) through a global.
    value = WITH_SETS if protocol >= 4 else EXCHANGE if protocol == 3 else {k: v for k, v in EXCHANGE.items()
                                                                            if k != "blob"}
    for data in (value, [value] * 50, {"k": value, "same": value}):
        plain_pickle.check(pickle.dumps(data, protocol=protocol))


@pytest.mark.parametrize("value", [datetime.date(2020, 1, 1), collections.OrderedDict(a=1), complex(1, 2),
                                   {1, 2}])
def test_values_built_through_a_global_are_refused(value):
    with pytest.raises(plain_pickle.NotPlain):
        plain_pickle.check(pickle.dumps(value, protocol=2))


def _shared_tuples(depth: int, *tail: bytes) -> bytes:
    """A tuple whose two halves are the same tuple, ``depth`` levels deep."""
    return (pickle.PROTO + bytes([4]) + pickle.EMPTY_DICT + pickle.EMPTY_TUPLE
            + (pickle.DUP + pickle.TUPLE2) * depth + b"".join(tail) + pickle.STOP)


def test_the_expanded_size_of_shared_values_is_bounded():
    plain_pickle.check(_shared_tuples(8, pickle.NONE, pickle.SETITEM))
    for tail in ((pickle.NONE, pickle.SETITEM), (pickle.POP,)):
        with pytest.raises(plain_pickle.NotPlain):
            plain_pickle.check(_shared_tuples(40, *tail))


def test_nesting_depth_is_bounded():
    def nested(depth: int) -> bytes:
        return (pickle.PROTO + bytes([4]) + pickle.EMPTY_DICT + pickle.EMPTY_TUPLE + pickle.TUPLE1 * depth
                + pickle.NONE + pickle.SETITEM + pickle.STOP)

    plain_pickle.check(nested(plain_pickle.MAX_DEPTH - 2))
    with pytest.raises(plain_pickle.NotPlain):
        plain_pickle.check(nested(plain_pickle.MAX_DEPTH))
    with pytest.raises(plain_pickle.NotPlain):
        plain_pickle.check(nested(200_000))


COLLIDING = [i * (2**61 - 1) for i in range(1, plain_pickle.MAX_EQUAL_HASHES + 2)]  # all hash to 0


def test_keys_of_real_data_never_share_a_hash_often():
    plain_pickle.check(pickle.dumps({i: i for i in range(-100_000, 100_000)}, protocol=4))
    plain_pickle.check(pickle.dumps({(i, i + 1): 1 for i in range(50_000)}, protocol=4))
    plain_pickle.check(pickle.dumps({i / 7: 1 for i in range(50_000)}, protocol=4))
    plain_pickle.check(pickle.dumps({f"location-{i}": i for i in range(50_000)}, protocol=4))  # geomapping-like
    plain_pickle.check(pickle.dumps({("ecoinvent", f"code-{i}"): 1.0 for i in range(50_000)}, protocol=4))
    plain_pickle.check(pickle.dumps({("same", i): 1 for i in range(50_000)}, protocol=4))
    plain_pickle.check(pickle.dumps(set(COLLIDING[: plain_pickle.MAX_EQUAL_HASHES]), protocol=4))


@pytest.mark.parametrize("build", [
    lambda keys: {k: 1 for k in keys},
    lambda keys: set(keys),
    lambda keys: frozenset(keys),
    lambda keys: {(k, 2): 1 for k in keys},
    lambda keys: {("same", k): 1 for k in keys},
    lambda keys: {frozenset({k}): 1 for k in keys},
    lambda keys: {frozenset({i}): 1 for i in range(len(keys))},
])
def test_many_keys_of_one_hash_are_refused(build):
    assert len({hash(k) for k in COLLIDING}) == 1
    for protocol in (2, 4):
        value = build(COLLIDING)
        if protocol == 2 and isinstance(value, (set, frozenset)):
            continue  # spelled through a global below protocol 4
        with pytest.raises(plain_pickle.NotPlain):
            plain_pickle.check(pickle.dumps(value, protocol=protocol))


def test_cycles_are_refused():
    data = pickle.PROTO + bytes([4]) + pickle.EMPTY_LIST + pickle.MEMOIZE + pickle.BINGET + b"\x00" \
        + pickle.APPEND + pickle.STOP
    with pytest.raises(plain_pickle.NotPlain):
        plain_pickle.check(data)


@pytest.mark.parametrize("data", [b"", pickle.PROTO + bytes([4]) + pickle.EMPTY_LIST,
                                  pickle.PROTO + bytes([4]) + pickle.BINGET + b"\x05" + pickle.STOP])
def test_incomplete_or_dangling_pickles_are_refused(data):
    with pytest.raises(plain_pickle.NotPlain):
        plain_pickle.check(data)
