"""What a formula can reach: numbers, parameters and the maths functions — no files and no output.

Every interpreter that evaluates a formula (ours, bw2data's recalculation, bw2parameters' ParameterSet) builds its
namespace from asteval's tables, which ``engine/formula_namespace.py`` restricts once when ``params`` is imported.
The tests below hold that on the interpreters themselves and on each route a formula is evaluated by, with a
dummy file in a temporary directory.
"""
from __future__ import annotations

import builtins
import importlib.metadata
import io
import subprocess
import sys
import types
import uuid

import numpy as np
import pytest
from asteval import Interpreter, astutils

from prism_lca.engine import formula_namespace, params, sensitivity_fast
from prism_lca.errors import PrismError

#: The versions whose tables were checked against REMOVED_NAMES and REFUSED_ATTRIBUTES.
REVIEWED = {"asteval": "1.0.9", "bw2parameters": "1.1.0"}

MARK = "QX7-MARK"
CONTENT = "Kx7-dummy-content\n"


def _spelled(text: str) -> str:
    """``text`` as a formula expression that names no word of it, so no identifier check sees it."""
    return "+".join(f"chr({ord(c)})" for c in text)


@pytest.fixture
def files(tmp_path):
    src = tmp_path / "dummy.txt"
    src.write_text(CONTENT)
    return types.SimpleNamespace(src=src, dst=tmp_path / "written.bin")


@pytest.fixture
def printed(monkeypatch, capfd):
    """Everything a formula prints: asteval's default writer (bound to the stdout of the moment asteval was
    imported, which under pytest is not the captured one) plus what reaches file descriptor 1."""
    import asteval.asteval

    writer = io.StringIO()
    monkeypatch.setattr(asteval.asteval, "stdout", writer)
    return lambda: writer.getvalue() + capfd.readouterr().out


# --- the interpreters ---------------------------------------------------------------------------------------


def test_the_reviewed_versions_are_installed():
    for name, version in REVIEWED.items():
        assert importlib.metadata.version(name) == version, (
            f"{name} is now {importlib.metadata.version(name)}: check engine/formula_namespace.py against its "
            "symbol tables, its attribute checks and how its interpreters are built, then update REVIEWED here."
        )


def _interpreters():
    import bw2parameters

    return {
        "asteval": Interpreter,
        "asteval minimal": lambda: Interpreter(minimal=True),
        "bw2parameters": bw2parameters.Interpreter,
        "ParameterSet": lambda: bw2parameters.ParameterSet({"a": {"amount": 1.0}}).interpreter,
    }


_FORBIDDEN = {
    id(f): name
    for name, f in {
        "open": builtins.open, "io.open": io.open, "asteval open": astutils._open, "print": builtins.print,
        "fromfile": np.fromfile, "fromregex": np.fromregex, "genfromtxt": np.genfromtxt, "loadtxt": np.loadtxt,
        "load": np.load, "save": np.save, "savez": np.savez, "savez_compressed": np.savez_compressed,
        "savetxt": np.savetxt, "memmap": np.memmap, "info": np.info,
    }.items()
}
#: Source files of the numpy and standard-library code that reads or writes files or prints.
_IO_SOURCES = ("_npyio_impl.py", "_datasource.py", "_utils_impl.py", "/io.py", "/os.py", "/pydoc.py")


def _source_file(value) -> str:
    code = getattr(getattr(value, "_implementation", value), "__code__", None)
    return code.co_filename if code is not None else ""


@pytest.mark.parametrize("kind", list(_interpreters()))
def test_a_new_interpreter_offers_nothing_that_reads_writes_or_prints(kind):
    interp = _interpreters()[kind]()
    assert not [n for n in formula_namespace.REMOVED_NAMES if n in interp.symtable]
    assert interp.config["print"] is False
    offered = sorted(
        f"{name}: {_FORBIDDEN.get(id(value)) or _source_file(value)}"
        for name, value in interp.symtable.items()
        if id(value) in _FORBIDDEN or _source_file(value).endswith(_IO_SOURCES)
        or type(value).__module__.startswith("pint")
    )
    assert offered == []


def test_no_attribute_a_formula_can_reach_reads_or_writes_files():
    """Walk what asteval's own attribute check lets through, from every name and from the kinds of value a
    formula gets back, a few steps deep. No module may be reachable, and no file reader or writer."""

    class Refused(Exception):
        pass

    def refuse(node, exc=None, msg=""):
        raise Refused(msg)

    io_members = {"tofile", "dump", "load", "save", "savetxt", "savez", "fromfile", "loadtxt", "genfromtxt",
                  "fromregex", "memmap", "open", "info", "write", "writelines"}
    roots = list(Interpreter().symtable.values()) + [
        np.array([1.0]), np.float64(1.0), np.int32(1), np.dtype("f8"), np.matrix([[1.0]]), np.poly1d([1.0]),
        np.rec.array([(1,)])[0], np.zeros(1, dtype="V4")[0], np.array([b"ab"])[0], np.array([1.0]).data,
        np.vectorize(abs), "a", b"a", [1], {}, 1j,
    ]
    seen: set[int] = set()
    frontier, found = roots, []
    for _depth in range(3):
        nxt = []
        for obj in frontier:
            if id(obj) in seen:
                continue
            seen.add(id(obj))
            try:
                names = dir(obj)
            except Exception:  # noqa: BLE001 - a value that cannot list its members has none to walk
                continue
            for attr in names:
                try:
                    value = astutils.safe_getattr(obj, attr, refuse, None)
                except Refused:
                    continue
                except Exception:  # noqa: BLE001 - a member that fails on access gives a formula nothing
                    continue
                if isinstance(value, types.ModuleType) or attr in io_members or id(value) in _FORBIDDEN:
                    found.append(f"{type(obj).__name__}.{attr}")
                if not isinstance(value, (int, float, complex, str, bytes, bool, type(None))):
                    nxt.append(value)
        frontier = nxt
    assert found == []


def test_restricting_again_changes_nothing():
    before = (dict(astutils.LOCALFUNCS), dict(astutils.NUMPY_TABLE), dict(astutils.UNSAFE_ATTRS_DTYPES))
    formula_namespace.restrict()
    assert (dict(astutils.LOCALFUNCS), dict(astutils.NUMPY_TABLE), dict(astutils.UNSAFE_ATTRS_DTYPES)) == before
    assert astutils.UNSAFE_ATTRS_DTYPES[object] == formula_namespace.REFUSED_ATTRIBUTES


def test_a_table_the_restriction_does_not_know_stops_it(monkeypatch):
    monkeypatch.setitem(astutils.BUILTINS_TABLE, "open", builtins.open)
    with pytest.raises(RuntimeError, match="open"):
        formula_namespace.restrict()


@pytest.mark.parametrize("module", ["prism_lca.app", "prism_lca.engine.params", "prism_lca.engine.sensitivity_fast"])
def test_importing_the_backend_restricts_formulas_before_anything_evaluates_one(module, tmp_path):
    code = (
        f"import {module}\n"
        "from asteval import Interpreter\n"
        "i = Interpreter()\n"
        "assert 'open' not in i.symtable and 'fromfile' not in i.symtable and not i.config['print']\n"
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]


def test_the_package_itself_does_not_load_numpy(tmp_path):
    """The backend's entry point configures the maths libraries before numpy loads; the package import runs
    before it, so the restriction must not live there."""
    code = "import sys, prism_lca\nassert 'numpy' not in sys.modules and 'asteval' not in sys.modules\n"
    r = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]


# --- formulas on an interpreter --------------------------------------------------------------------------------

READS = [
    "open({src}).read()",
    "fromfile({src}, 'u1')",
    "loadtxt({src}, dtype='str')",
    "genfromtxt({src}, dtype='str')",
    "fromregex({src}, '(.*)', [('line', 'S40')])",
]
WRITES = [
    "sqrt(2.0).tofile({dst})",
    "float64(1).dump({dst})",
    "int32(7).tofile({dst})",
    "dtype('f8').type(3).tofile({dst})",
    "matrix.tofile(array([1.0]), {dst})",
    "array([1.0]).tofile({dst})",
    "array([1.0]).data.obj.tofile({dst})",
]
OUTPUT = [f"print({_spelled(MARK)})", f"info({_spelled(MARK)})"]
#: Statements only the default configuration (bw2data's, bw2parameters') accepts.
STATEMENTS = [
    "x = float64(2)\nx.dump({dst})",
    "def f():\n    return sqrt(2.0).tofile({dst})\nf()",
    f"(lambda: print({_spelled(MARK)}))()",
    f"frompyfunc(print, 1, 1)({_spelled(MARK)})",
    "y = matrix\ny.tofile(array([1.0]), {dst})",
]


@pytest.mark.parametrize("minimal", [True, False], ids=["minimal", "default"])
@pytest.mark.parametrize("formula", READS + WRITES + OUTPUT + STATEMENTS)
def test_a_formula_reads_writes_and_prints_nothing(formula, minimal, files, printed):
    if minimal and formula in STATEMENTS:
        pytest.skip("statements are not evaluated by the minimal interpreter at all")
    interp = Interpreter(minimal=minimal)
    value = interp(formula.format(src=repr(str(files.src)), dst=repr(str(files.dst))), show_errors=False)
    assert not files.dst.exists()
    assert CONTENT.strip() not in repr(value)
    if formula in READS + WRITES:
        assert interp.error, "the formula ran to the end"
    assert MARK not in printed()


@pytest.mark.parametrize(
    ("formula", "expected"),
    [
        ("sqrt(4.0) * 2", 4.0),
        ("max(1, 2) + abs(-1) + min(3, 4)", 6.0),
        ("log(e) + log10(100) + exp(0)", 4.0),
        ("array([1.0, 2.0]).sum() * pi / pi", 3.0),
        ("round(2.6) + floor(1.5) + ceil(1.2)", 6.0),
        ("len(float64(1).tobytes()) + len(float64(1).dumps()) > 0", True),
        ("3 if 2 > 1 else 0", 3),
    ],
)
def test_ordinary_formulas_still_evaluate(formula, expected):
    for interp in (Interpreter(), Interpreter(minimal=True)):
        if "if" in formula and interp.config.get("ifexp") is False:
            continue
        assert interp(formula, show_errors=False) == expected, (formula, [e.get_error() for e in interp.error])


# --- the routes a formula is evaluated by ---------------------------------------------------------------------


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _param(client, token, db, name, **body):
    return client.post("/api/v1/params", json={"database": db, "name": name, **body}, headers=token)


def _activity_with_exchange(client, token, db) -> tuple[str, str]:
    def create(name):
        return client.post(
            "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
        ).json()["activity"]["code"]

    a, b = create("A"), create("B")
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b, "amount": 0},
        headers=token,
    )
    return a, r.json()["exchange"]["uid"]


def _exchange_formula(client, token, db, code, uid, formula):
    return client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": code, "uid": uid, "formula": formula},
        headers=token,
    )


def test_the_evaluate_route_reaches_no_file(client, token, project, files):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=0.5).status_code == 200
    src, dst = _spelled(str(files.src)), _spelled(str(files.dst))
    for formula in (
        f"ord(list(open({src}))[0][0])",
        f"float(list(open({src}))[0])",
        f"fromfile({src}, chr(117)+chr(49))[0] * 1.0",
        f"sqrt(mass).tofile({dst})",
    ):
        r = client.post("/api/v1/params/evaluate", json={"database": db, "formula": formula}, headers=token)
        assert r.status_code >= 400, (formula, r.text)
        assert "Kx7" not in r.text
    assert not files.dst.exists()


def test_a_stored_parameter_formula_reaches_no_file(client, token, project, files):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=0.5).status_code == 200
    r = _param(client, token, db, "leak", formula=f"ord(open({str(files.src)!r}).read()[0]) + 0 * mass")
    assert r.status_code >= 400
    r = _param(client, token, db, "spill", formula=f"len([sqrt(2.0).tofile({str(files.dst)!r})]) + mass")
    assert r.status_code >= 400
    assert not files.dst.exists()
    names = {p["name"] for p in client.get("/api/v1/params", params={"database": db}, headers=token).json()}
    assert names == {"mass"}


def test_a_formula_stored_earlier_is_evaluated_without_output_or_files(client, token, project, files, printed):
    """A formula already in a project never passes an entry check; the recalculation of an unrelated edit
    evaluates it."""
    db = _fg(client, token)
    assert _param(client, token, db, "base", amount=2.0).status_code == 200
    from bw2data.parameters import DatabaseParameter

    DatabaseParameter.create(database=db, name="old", formula=f"print({_spelled(MARK)}) or 2 * base", amount=0.0)
    assert _param(client, token, db, "base", amount=5.0).status_code == 200
    stored = {p["name"]: p for p in client.get("/api/v1/params", params={"database": db}, headers=token).json()}
    assert stored["old"]["amount"] == 10.0
    assert MARK not in printed()

    DatabaseParameter.create(database=db, name="older", formula=f"float64(1).dump({str(files.dst)!r}) or base",
                             amount=0.0)
    _param(client, token, db, "base", amount=6.0)
    assert not files.dst.exists()


def test_an_exchange_formula_is_evaluated_without_output_or_files(client, token, project, files, printed):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    code, uid = _activity_with_exchange(client, token, db)
    r = _exchange_formula(client, token, db, code, uid, f"print({_spelled(MARK)}) or mass * 3")
    assert r.status_code == 200, r.text
    assert r.json()["exchange"]["amount"] == 6.0
    _exchange_formula(client, token, db, code, uid, f"sqrt(mass).tofile({str(files.dst)!r}) or 1")
    assert not files.dst.exists()
    assert MARK not in printed()


def test_scenario_overrides_reach_no_file_and_print_nothing(client, token, project, files, printed):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    assert _param(client, token, db, "twice", formula="2 * mass").status_code == 200
    with pytest.raises(PrismError, match="open"):
        params.evaluate_overrides(db, {"twice": f"ord(open({str(files.src)!r}).read()[0])"})
    with pytest.raises(PrismError):
        params.evaluate_overrides(db, {"twice": f"int32(7).tofile({str(files.dst)!r}) or mass"})
    assert not files.dst.exists()
    assert params.evaluate_overrides(db, {"twice": f"print({_spelled(MARK)}) or 3 * mass"})["twice"] == 6.0
    assert MARK not in printed()


def test_the_fast_sensitivity_path_evaluates_without_output_or_files(client, token, project, files, printed):
    """The fast path parses the exchange formulas once and evaluates the trees at every step."""
    from bw2data.parameters import ParameterizedExchange

    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    code, uid = _activity_with_exchange(client, token, db)
    assert _exchange_formula(client, token, db, code, uid, "mass * 3").status_code == 200

    def amounts(formula):
        ParameterizedExchange.update(formula=formula).execute()
        groups, _ids, stored = sensitivity_fast._formulas(db, {"mass": 2.0})
        assert groups, "the model has no formula the fast path evaluates"
        fast = types.SimpleNamespace(groups=groups, stored=stored)
        return sensitivity_fast.FastModel._amounts(fast, {"mass": 4.0})

    assert list(amounts(f"print({_spelled(MARK)}) or mass * 3")) == [12.0]
    with pytest.raises(PrismError):
        amounts(f"sqrt(mass).tofile({str(files.dst)!r}) or mass")
    assert not files.dst.exists()
    assert MARK not in printed()
