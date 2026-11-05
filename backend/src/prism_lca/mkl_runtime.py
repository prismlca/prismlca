"""Intel MKL for pypardiso: which library is ours, and the variables that keep it ours. Importing it has no side effects.

``__main__`` and ``server.main`` apply the solver environment at start-up; this module only looks and
writes into the mapping it is given, so a test can import it without switching the whole test process
to MKL's TBB threading layer.
"""

from __future__ import annotations

import glob
import os
import sys
from collections.abc import MutableMapping


def bundled_mkl_rt(base: str) -> str | None:
    """The MKL runtime library inside a bundle directory, or None.

    Found by pattern, not by a fixed name: the major version in the file name moves with MKL — the
    Windows build looked for ``mkl_rt.2.dll`` while MKL 2026 ships ``mkl_rt.3.dll``, and every Windows
    bundle fell back to SciPy without a word. The highest version wins if several are present.
    """
    hits: list[str] = []
    for pattern in ("libmkl_rt.so.*", "mkl_rt.*.dll", "libmkl_rt*.dylib"):
        hits += glob.glob(os.path.join(base, pattern))
    return sorted(hits)[-1] if hits else None


def own_mkl_dir() -> str:
    """Where this backend's own MKL lives: next to the frozen executable's files, or in the virtual
    environment's library folder — the folder ``prism_backend.spec`` bundles it from."""
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    if sys.platform == "win32":
        return os.path.join(sys.prefix, "Library", "bin")
    return os.path.join(sys.prefix, "lib")


def pin_solver_environment(environ: MutableMapping[str, str], mkl_dir: str) -> str | None:
    """Point pypardiso at the MKL in ``mkl_dir`` and select the layers that MKL ships. Returns its path.

    Set, not defaulted, because these variables are often already set for somebody's own MKL, and every
    program inherits them: ``PYPARDISO_MKL_RT`` is pypardiso's own advice when it cannot find MKL, and
    ``MKL_THREADING_LAYER=GNU`` is the usual cure for an OpenMP clash between NumPy and PyTorch. The
    bundle ships only the TBB threading layer and the LP64 interface; MKL asked for any other layer
    aborts the whole process at the first solve ("Intel oneMKL FATAL ERROR"), and a foreign runtime
    path silently costs the fast solver. Without that, pypardiso would also try ``find_library``
    before its own environment, so a system-wide MKL (ldconfig, ``PATH``) would win over ours.

    * ``MKL_THREADING_LAYER=TBB``: MKL threads through oneTBB instead of Intel OpenMP. TBB ships
      under the same Intel Simplified Software License as MKL itself; the OpenMP runtime would
      bring the Intel EULA for Developer Tools into the bundle (on Windows PyTorch ships that runtime
      anyway, in torch/lib; THIRD-PARTY-NOTICES.md says so). Development runs the same layer.
    * ``MKL_INTERFACE_LAYER`` removed: MKL's default is LP64, the interface pypardiso calls and the
      only one bundled.

    Nothing is touched when ``mkl_dir`` holds no MKL — whatever MKL then loads is not ours to configure.
    """
    mkl_rt = bundled_mkl_rt(mkl_dir)
    if mkl_rt is None:
        return None
    environ["PYPARDISO_MKL_RT"] = mkl_rt
    environ["MKL_THREADING_LAYER"] = "TBB"
    environ.pop("MKL_INTERFACE_LAYER", None)
    return mkl_rt


def bundled_tbb(base: str) -> str | None:
    """The oneTBB runtime next to our MKL on Linux (``libtbb.so.<major>``, by its soname), or None."""
    hits = glob.glob(os.path.join(base, "libtbb.so.*"))
    # libtbb.so.12 and libtbb.so.12.19 are one file; the soname is the name MKL asks the loader for.
    sonames = [h for h in hits if os.path.basename(h).count(".") == 2 and h.rsplit(".", 1)[1].isdigit()]
    return max(sonames, key=lambda h: int(h.rsplit(".", 1)[1])) if sonames else None


def load_threading_runtime(mkl_dir: str) -> str | None:
    """Load the oneTBB runtime that sits next to our MKL, before MKL's TBB layer needs it. Returns its path.

    MKL's ``libmkl_tbb_thread`` names ``libtbb.so.12`` without a search path of its own, so outside the
    frozen bundle (whose loader path holds its own folder) Linux looks only system-wide: a solve worked where
    a system TBB happened to be installed and aborted the process everywhere else. The loader matches a
    library that is already loaded by its soname, so loading ours first is all it takes. Linux only: Windows
    finds a DLL's dependencies next to it, and macOS records them relative to the library.
    """
    if not sys.platform.startswith("linux") or bundled_mkl_rt(mkl_dir) is None:
        return None
    tbb = bundled_tbb(mkl_dir)
    if tbb is None:
        return None
    import ctypes

    ctypes.CDLL(tbb, mode=ctypes.RTLD_GLOBAL)
    return tbb
