from __future__ import annotations

import multiprocessing
import os
import sys

from prism_lca.mkl_runtime import bundled_mkl_rt


def _solver_environment() -> None:
    """Point pypardiso at the bundled Intel oneMKL and pick its threading layer.

    Both variables must be set before ``mkl_rt`` is loaded, which happens on the first
    ``import pypardiso`` — hence here, before anything else is imported.

    * ``MKL_THREADING_LAYER=TBB``: MKL threads through oneTBB instead of Intel OpenMP. TBB ships
      under the same Intel Simplified Software License as MKL itself; the OpenMP runtime would
      bring the Intel EULA for Developer Tools into the bundle (on Windows PyTorch ships that runtime
      anyway, in torch/lib; THIRD-PARTY-NOTICES.md says so).
      Set in development too, so both environments run the same code paths.
    * ``PYPARDISO_MKL_RT``: in the PyInstaller bundle the MKL libraries sit next to the executable's
      ``_internal`` files (prism_backend.spec), where neither ``ctypes.util.find_library`` nor
      pypardiso's ``sys.prefix/lib*`` search looks. Only set when frozen; a venv finds its own.
    """
    os.environ.setdefault("MKL_THREADING_LAYER", "TBB")
    if getattr(sys, "frozen", False):
        mkl_rt = bundled_mkl_rt(getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)))
        if mkl_rt:
            os.environ.setdefault("PYPARDISO_MKL_RT", mkl_rt)


def _solver_check() -> int:
    """``prism-lca-backend --solver-check``: solve a small system with PARDISO, print which sparse
    solver this build will use and exit 0 for pypardiso/MKL, 1 for the SciPy fallback. The release
    workflow runs it on the bundle: the installer, not the venv, is what has to pass. Importing
    pypardiso only loads mkl_rt; the core, the threading layer and the CPU kernels load at the first
    solve, so a missing one would otherwise surface in a user's first calculation."""
    try:
        import numpy as np
        import pypardiso
        import scipy.sparse as sp

        x = pypardiso.spsolve(sp.csr_matrix(np.array([[4.0, 1.0], [1.0, 3.0]])), np.array([1.0, 2.0]))
        if not np.allclose(x, [1 / 11, 7 / 11]):
            raise RuntimeError(f"PARDISO returned {x} for a system whose solution is (1/11, 7/11)")
    except Exception as exc:  # ImportError, OSError from ctypes, a failed solve
        print(f"solver: scipy (SuperLU) — pypardiso unavailable: {type(exc).__name__}: {exc}")
        return 1
    print(
        "solver: pypardiso / Intel oneMKL PARDISO "
        f"(threading={os.environ.get('MKL_THREADING_LAYER')}, "
        f"mkl_rt={os.environ.get('PYPARDISO_MKL_RT', 'found by pypardiso')})"
    )
    return 0


_solver_environment()

if __name__ == "__main__":
    # One encoding whatever the console: Electron reads this output as UTF-8, and a Windows console's
    # cp1252 cannot even encode "←" — the bundle check died printing its own failure on one. Before
    # anything prints, and in a worker too; an unencodable character is escaped, never fatal.
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    # The frozen executable is also what multiprocessing starts its workers with — on Windows always,
    # there is no fork. freeze_support() turns such a start into the worker it is meant to be and exits.
    # Without it every worker of the ecoinvent import ran the normal start-up, met the instance lock,
    # quit with exit code 3 and was replaced by the pool, endlessly. A no-op outside a worker.
    multiprocessing.freeze_support()
    if "--solver-check" in sys.argv[1:]:
        raise SystemExit(_solver_check())
    if "--bundle-check" in sys.argv[1:]:
        from prism_lca.bundle_check import run

        code = run()
        sys.stdout.flush()
        # Not SystemExit: in a bundle whose freeze_support() does not work, multiprocessing's resource
        # tracker (POSIX) starts as a second backend, and a normal exit waits for that tracker forever —
        # the check would report the failure and then hang the release job.
        os._exit(code)
    from prism_lca.server import main

    main()
