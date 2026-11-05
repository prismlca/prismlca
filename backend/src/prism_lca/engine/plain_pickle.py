"""Whether a pickle holds plain values only, decided by reading its opcodes without loading it.

Plain values are None, bool, int, float, str, bytes, and lists, tuples, dicts and sets of them, without cycles.
Only the opcodes that build those are accepted; references through the memo are followed, the size of the
values fully expanded is bounded by the pickle's own length, their nesting depth is bounded, and no dict or set
gets many keys of one hash value, so whatever loads the pickle later does work in proportion to its size and
recurses only shallowly.
"""
from __future__ import annotations

import pickletools

#: Expanded values may be this many times the pickle's length, plus the floor: far beyond what repeated
#: strings and tuples in real data reach.
EXPANSION_FACTOR = 64
EXPANSION_FLOOR = 100_000
#: Real values nest a handful of levels (an exchange's properties, a calculation setup's keys).
MAX_DEPTH = 100
#: Keys of one dict or set that share a hash value. Keys are hashed as this process hashes them; distinct real
#: keys meet only by chance in a 64-bit space (-1 and -2 are the one pair among small numbers). Hashable keys
#: whose hash is not modelled here (frozensets, tuples holding one) all count as one value.
MAX_EQUAL_HASHES = 32

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
#: The kind of container each opcode builds: tuple, frozenset, dict, set, list.
_KIND = {"EMPTY_TUPLE": "t", "TUPLE": "t", "TUPLE1": "t", "TUPLE2": "t", "TUPLE3": "t", "FROZENSET": "f",
         "EMPTY_DICT": "d", "DICT": "d", "EMPTY_SET": "s", "EMPTY_LIST": "l", "LIST": "l"}
_UNMODELLED = "unmodelled"
_UNHASHABLE = object()
_NOT_YET = object()


class NotPlain(ValueError):
    pass


class _Atom:
    """A value that holds no others; ``value`` is its opcode's argument."""

    __slots__ = ("value", "hash")
    kids = None
    size = 1

    def __init__(self, value: object) -> None:
        self.value = value
        self.hash: object = _NOT_YET


class _Node:
    """A container in the pickle."""

    __slots__ = ("kids", "kind", "size", "depth", "state", "hash", "counts")

    def __init__(self, kids: list, kind: str) -> None:
        self.kids = kids
        self.kind = kind
        self.size = 1
        self.depth = 1
        self.state = 0  # 0 not sized, 1 being sized, 2 sized
        self.hash: object = _NOT_YET
        #: For a dict or set: how many of its keys share each hash.
        self.counts: dict[object, int] | None = {} if kind in ("d", "s", "f") else None


class _Hashed:
    """Stands in for a tuple item whose hash is known, so a tuple's hash is computed as Python computes it."""

    __slots__ = ("value",)

    def __init__(self, value: int) -> None:
        self.value = value

    def __hash__(self) -> int:
        return self.value


_FIXED_ATOMS = {"NONE": _Atom(None), "NEWTRUE": _Atom(True), "NEWFALSE": _Atom(False)}


def _key_hash(node: _Atom | _Node) -> object:
    """The hash ``node`` has as a key, :data:`_UNMODELLED`, or :data:`_UNHASHABLE`."""
    if node.hash is _NOT_YET:
        if node.kids is None:
            node.hash = _UNHASHABLE if isinstance(node.value, bytearray) else hash(node.value)
        elif node.kind == "t":
            items = [_key_hash(kid) for kid in node.kids]
            if any(item is _UNHASHABLE for item in items):
                node.hash = _UNHASHABLE
            elif any(item is _UNMODELLED for item in items):
                node.hash = _UNMODELLED
            else:
                node.hash = hash(tuple(_Hashed(item) for item in items))
        else:
            node.hash = _UNMODELLED if node.kind == "f" else _UNHASHABLE
    return node.hash


def _count_keys(container: _Node, keys: list) -> None:
    if container.counts is None:
        return
    for key in keys:
        value = _key_hash(key)
        if value is _UNHASHABLE:
            continue  # loading fails on it before any work
        seen = container.counts.get(value, 0) + 1
        if seen > MAX_EQUAL_HASHES:
            raise NotPlain("equal hashes")
        container.counts[value] = seen


_MARK = object()


def _since_mark(stack: list) -> list:
    i = len(stack) - 1
    while stack[i] is not _MARK:
        i -= 1
    items = stack[i + 1:]
    del stack[i:]
    return items


def check(data: bytes) -> None:
    """Raise :class:`NotPlain` unless ``data`` is a pickle of plain values within the bounds above."""
    try:
        containers = _scan(data)
        _bound(containers, EXPANSION_FACTOR * len(data) + EXPANSION_FLOOR)
    except NotPlain:
        raise
    except (ValueError, IndexError, KeyError, AttributeError, TypeError, RecursionError) as exc:
        raise NotPlain(type(exc).__name__) from exc  # malformed, out of order, or nested far too deep


def _scan(data: bytes) -> list[_Node]:
    """Follow the opcodes that build plain values; return every container they build."""
    stack: list = []
    memo: dict[int, object] = {}
    containers: list[_Node] = []
    for opcode, arg, _pos in pickletools.genops(data):
        name = opcode.name
        if name in _ATOMS:
            stack.append(_FIXED_ATOMS.get(name) or _Atom(arg))
        elif name in _EMPTY or name in _FROM_MARK or name in _TUPLE_N:
            if name in _EMPTY:
                kids = []
            elif name in _FROM_MARK:
                kids = _since_mark(stack)
            else:
                n = _TUPLE_N[name]
                kids = stack[-n:]
                del stack[-n:]
            node = _Node(kids, _KIND[name])
            _count_keys(node, kids[0::2] if name == "DICT" else kids)
            containers.append(node)
            stack.append(node)
        elif name == "APPEND":
            item = stack.pop()
            stack[-1].kids.append(item)
        elif name == "SETITEM":
            value, key = stack.pop(), stack.pop()
            stack[-1].kids += (key, value)
            _count_keys(stack[-1], [key])
        elif name in _FILL_FROM_MARK:
            items = _since_mark(stack)
            stack[-1].kids.extend(items)
            _count_keys(stack[-1], items[0::2] if name == "SETITEMS" else items)
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
    """Size every container as if all shared references were copies; refuse cycles, sizes over ``limit``
    and nesting deeper than :data:`MAX_DEPTH`."""
    for start in containers:
        todo = [(start, False)]
        while todo:
            node, sized_kids = todo.pop()
            if sized_kids:
                node.size = 1 + sum(kid.size for kid in node.kids)
                node.depth = 1 + max((kid.depth for kid in node.kids if kid.kids is not None), default=0)
                if node.size > limit:
                    raise NotPlain("expansion")
                if node.depth > MAX_DEPTH:
                    raise NotPlain("depth")
                node.state = 2
            elif node.state == 0:
                node.state = 1
                todo.append((node, True))
                todo.extend((kid, False) for kid in node.kids if kid.kids is not None and kid.state != 2)
            elif node.state == 1:
                raise NotPlain("cycle")
