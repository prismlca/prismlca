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
