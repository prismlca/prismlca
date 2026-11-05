"""Which Intel MKL the backend uses, and with which layers (mkl_runtime.py).

A Windows bundle once looked for ``mkl_rt.2.dll`` while MKL 2026 ships ``mkl_rt.3.dll``: PyInstaller
bundled the library, nothing found it, and pypardiso quietly fell back to SciPy.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from prism_lca.mkl_runtime import (
    bundled_mkl_rt,
    bundled_tbb,
    load_threading_runtime,
    own_mkl_dir,
    pin_solver_environment,
)


def _touch(folder: Path, *names: str) -> None:
    for name in names:
        (folder / name).write_bytes(b"")


def test_finds_the_runtime_whatever_its_major_version(tmp_path):
    _touch(tmp_path, "mkl_core.3.dll", "mkl_rt.3.dll", "tbb12.dll")
    assert bundled_mkl_rt(str(tmp_path)) == str(tmp_path / "mkl_rt.3.dll")


def test_finds_the_linux_runtime(tmp_path):
    _touch(tmp_path, "libmkl_core.so.3", "libmkl_rt.so.3")
    assert bundled_mkl_rt(str(tmp_path)) == str(tmp_path / "libmkl_rt.so.3")


def test_prefers_the_newest_and_says_nothing_when_absent(tmp_path):
    _touch(tmp_path, "mkl_rt.2.dll", "mkl_rt.3.dll")
    assert bundled_mkl_rt(str(tmp_path)).endswith("mkl_rt.3.dll")
    assert bundled_mkl_rt(str(tmp_path / "missing")) is None


# --- an MKL configured for somebody else ----------------------------------------------------------------------
# Users of Brightway and of NumPy/PyTorch often have these set for their own MKL, and every program inherits
# them. Measured on the 0.9.9 bundle: MKL_THREADING_LAYER=GNU or INTEL and MKL_INTERFACE_LAYER=ILP64 each end
# the backend at its first solve ("Intel oneMKL FATAL ERROR: Cannot load libmkl_gnu_thread.so.3", exit 2), and
# a foreign PYPARDISO_MKL_RT quietly falls back to SciPy.

_FOREIGN = {
    "PYPARDISO_MKL_RT": "/opt/conda/lib/libmkl_rt.so.2",
    "MKL_THREADING_LAYER": "GNU",
    "MKL_INTERFACE_LAYER": "ILP64",
}


def test_our_own_mkl_overrides_what_the_environment_inherited(tmp_path):
    _touch(tmp_path, "libmkl_rt.so.3")
    environ = {**_FOREIGN, "MKL_NUM_THREADS": "4"}
    assert pin_solver_environment(environ, str(tmp_path)) == str(tmp_path / "libmkl_rt.so.3")
    assert environ == {
        "PYPARDISO_MKL_RT": str(tmp_path / "libmkl_rt.so.3"),
        "MKL_THREADING_LAYER": "TBB",
        "MKL_NUM_THREADS": "4",  # tuning, not a layer: left as the user set it
    }


def test_without_an_own_mkl_nothing_is_touched(tmp_path):
    environ = dict(_FOREIGN)
    assert pin_solver_environment(environ, str(tmp_path)) is None
    assert environ == _FOREIGN


@pytest.mark.skipif(not bundled_mkl_rt(own_mkl_dir()), reason="this environment has no MKL of its own")
def test_a_real_solve_survives_an_mkl_environment_set_for_somebody_else():
    # In a child process: the pinned layer is process-wide, and the test process must keep its own.
    code = (
        "import os; from prism_lca.mkl_runtime import load_threading_runtime, own_mkl_dir, pin_solver_environment;"
        "pin_solver_environment(os.environ, own_mkl_dir()); load_threading_runtime(own_mkl_dir());"
        "import numpy as np, scipy.sparse as sp, pypardiso;"
        "x = pypardiso.spsolve(sp.csr_matrix(np.array([[4.0, 1.0], [1.0, 3.0]])), np.array([1.0, 2.0]));"
        "assert np.allclose(x, [1 / 11, 7 / 11]), x; print('solved')"
    )
    env = {**os.environ, **_FOREIGN, "PYTHONPATH": os.pathsep.join(sys.path)}
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0 and "solved" in out.stdout, out.stderr[-2000:]


def test_finds_the_tbb_runtime_by_its_soname(tmp_path):
    _touch(tmp_path, "libtbb.so.12", "libtbb.so.12.19", "libtbbbind.so.3", "libtbbmalloc.so.2", "libtbb.so.2")
    assert bundled_tbb(str(tmp_path)) == str(tmp_path / "libtbb.so.12")


def test_loads_no_tbb_without_an_own_mkl(tmp_path):
    _touch(tmp_path, "libtbb.so.12")
    assert load_threading_runtime(str(tmp_path)) is None


def test_loads_no_tbb_outside_linux(tmp_path, monkeypatch):
    _touch(tmp_path, "libmkl_rt.so.3", "libtbb.so.12")
    monkeypatch.setattr(sys, "platform", "win32")
    assert load_threading_runtime(str(tmp_path)) is None
