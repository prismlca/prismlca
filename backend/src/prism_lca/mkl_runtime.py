"""Locating Intel MKL's runtime library in the frozen backend — kept free of side effects.

``__main__`` sets the solver environment the moment it is imported; this module only looks, so a test
can import it without switching the whole test process to MKL's TBB threading layer.
"""

from __future__ import annotations

import glob
import os


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
