"""Whether a pickle holds plain values only, decided by reading its opcodes without loading it.

Plain values are None, bool, int, float, str, bytes, and lists, tuples, dicts and sets of them, without cycles.
Only the opcodes that build those are accepted; references through the memo are followed, and the size of the
values fully expanded is bounded by the pickle's own length, so whatever loads the pickle later does work in
proportion to its size.
"""
from __future__ import annotations

import pickletools

#: Expanded values may be this many times the pickle's length, plus the floor: far beyond what repeated
#: strings and tuples in real data reach.
EXPANSION_FACTOR = 64
EXPANSION_FLOOR = 100_000

_ATOMS = frozenset({
    "NONE", "NEWTRUE", "NEWFALSE", "INT", "BININT", "BININT1", "BININT2", "LONG", "LONG1", "LONG4",
    "FLOAT", "BINFLOAT", "STRING", "BINSTRING", "SHORT_BINSTRING", "UNICODE", "BINUNICODE",
    "SHORT_BINUNICODE", "BINUNICODE8", "BINBYTES", "SHORT_BINBYTES", "BINBYTES8", "BYTEARRAY8",
})
_EMPTY = frozenset({"EMPTY_LIST", "EMPTY_DICT", "EMPTY_SET", "EMPTY_TUPLE"})
_FROM_MARK = frozenset({"LIST", "TUPLE", "DICT", "FROZENSET"})
_FILL_FROM_MARK = frozenset({"APPENDS", "SETITEMS", "ADDITEMS"})
_TUPLE_N = {"TUPLE1": 1, "TUPLE2": 2, "TUPLE3": 3}
_GET = frozenset({"GET", "BINGET", "LONG_BINGET"})
_PUT = frozenset({"PUT", "BINPUT", "LONG_BINPUT"})


class NotPlain(ValueError):
    pass


class _Node:
    """A container in the pickle; ``kids`` is None for a value that holds no others."""

    __slots__ = ("kids", "size", "state")

    def __init__(self, kids: list | None) -> None:
        self.kids = kids
        self.size = 1
        self.state = 0  # 0 not sized, 1 being sized, 2 sized


_ATOM = _Node(None)
_MARK = object()


def _since_mark(stack: list) -> list:
    i = len(stack) - 1
    while stack[i] is not _MARK:
        i -= 1
    items = stack[i + 1:]
    del stack[i:]
    return items


def check(data: bytes) -> None:
    """Raise :class:`NotPlain` unless ``data`` is a pickle of plain values within the expansion bound."""
    try:
        containers = _scan(data)
        _bound(containers, EXPANSION_FACTOR * len(data) + EXPANSION_FLOOR)
    except NotPlain:
        raise
    except (ValueError, IndexError, KeyError, AttributeError, TypeError) as exc:  # malformed or out of order
        raise NotPlain(type(exc).__name__) from exc


def _scan(data: bytes) -> list[_Node]:
    """Follow the opcodes that build plain values; return every container they build."""
    stack: list = []
    memo: dict[int, object] = {}
    containers: list[_Node] = []
    for opcode, arg, _pos in pickletools.genops(data):
        name = opcode.name
        if name in _ATOMS:
            stack.append(_ATOM)
        elif name in _EMPTY or name in _FROM_MARK or name in _TUPLE_N:
            if name in _EMPTY:
                kids = []
            elif name in _FROM_MARK:
                kids = _since_mark(stack)
            else:
                n = _TUPLE_N[name]
                kids = stack[-n:]
                del stack[-n:]
            node = _Node(kids)
            containers.append(node)
            stack.append(node)
        elif name == "APPEND":
            item = stack.pop()
            stack[-1].kids.append(item)
        elif name == "SETITEM":
            value, key = stack.pop(), stack.pop()
            stack[-1].kids += (key, value)
        elif name in _FILL_FROM_MARK:
            items = _since_mark(stack)
            stack[-1].kids.extend(items)
        elif name == "MARK":
            stack.append(_MARK)
        elif name == "MEMOIZE":
            memo[len(memo)] = stack[-1]
        elif name in _PUT:
            if arg > len(data):
                raise NotPlain(name)
            memo[arg] = stack[-1]
        elif name in _GET:
            stack.append(memo[arg])
        elif name == "DUP":
            stack.append(stack[-1])
        elif name == "POP":
            stack.pop()
        elif name == "POP_MARK":
            _since_mark(stack)
        elif name == "FRAME":
            if arg > len(data):
                raise NotPlain(name)
        elif name == "STOP":
            break
        elif name != "PROTO":
            raise NotPlain(name)
    return containers


def _bound(containers: list[_Node], limit: int) -> None:
    """Size every container as if all shared references were copies; refuse cycles and sizes over ``limit``."""
    for start in containers:
        todo = [(start, False)]
        while todo:
            node, sized_kids = todo.pop()
            if sized_kids:
                node.size = 1 + sum(kid.size for kid in node.kids)
                if node.size > limit:
                    raise NotPlain("expansion")
                node.state = 2
            elif node.state == 0:
                node.state = 1
                todo.append((node, True))
                todo.extend((kid, False) for kid in node.kids if kid.kids is not None and kid.state != 2)
            elif node.state == 1:
                raise NotPlain("cycle")
