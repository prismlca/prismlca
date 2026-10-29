# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for the PrismLCA backend.

Produces ``dist/prism-lca-backend/`` containing an executable ``prism-lca-backend``.
electron-builder ships this whole folder as ``resources/backend`` (extraResources), and
the Electron main process spawns the executable inside it. Onedir (not onefile) is used
for fast startup — no per-launch unpack to a temp dir.
"""
from PyInstaller.utils.hooks import collect_all, collect_submodules

hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("prism_lca")
    + [
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ]
)
datas: list = []
binaries: list = []

# Report module assets: the bundled fonts (see src/prism_lca/assets/fonts/NOTICE.md), the Typst
# template + fixture, and the brand images. Static analysis cannot see files read at runtime.
datas += [("src/prism_lca/assets", "prism_lca/assets")]

# Heavy deps that carry data files / dynamic libs PyInstaller's static analysis misses:
# the Brightway stack (bw2io ships migration + LCIA data), the embedding stack (bge-m3 via
# sentence-transformers/transformers/tokenizers), and scientific libs (scipy/sklearn/torch).
for _pkg in (
    "bw2data", "bw2calc", "bw2io", "bw2analyzer", "bw_processing", "matrix_utils",
    "stats_arrays", "sentence_transformers", "transformers", "tokenizers", "fastembed",
    "scipy", "sklearn", "torch",
    # Typst ships the compiler as a compiled extension plus its own embedded fonts.
    "typst",
    # searoute reads its marnet shipping-lane network (GeoJSON) from package data at first use.
    "searoute",
    # markitdown identifies a chat attachment's file type with magika, whose model and content-type
    # table are package data; without them every conversion fails ("model dir not found").
    "magika",
):
    _d, _b, _h = collect_all(_pkg)
    datas += _d
    binaries += _b
    hiddenimports += _h

# bw2io's data folder ships whole (create_core_migrations, the SimaPro importer and the ecoinvent
# correspondence tables read from it at runtime — see docs/DATENHERKUNFT.md). Only the EXIOBASE
# tables go: PrismLCA has no EXIOBASE import, and their importer is the one place bw2io needs pyxlsb.
datas = [
    (_src, _dst) for _src, _dst in datas
    if not (_dst.replace("\\", "/").startswith("bw2io/data") and "EXIOBASE" in _src)
]

# Intel oneMKL for pypardiso (the fast sparse solver; bw2calc and engine/lca.py prefer it). The
# libraries live in the environment's lib dir, outside site-packages, so PyInstaller's analysis never
# sees them — before 30.09.2026 the bundle silently fell back to SciPy. Shipped: the runtime dispatcher
# and core, the LP64 interface, the TBB threading layer plus oneTBB itself, and every CPU-dispatch
# kernel (def/mc3/avx2/avx512/avx10 and their VML twins; MKL aborts if the kernel for the host CPU is
# missing, so none may be dropped). Not shipped: Intel OpenMP (different Intel licence), sequential/
# GNU threading, ILP64/gfortran interfaces, ScaLAPACK, BLACS, CDFT. Licence: Intel Simplified Software
# License, redistribution permitted; PrismLCA's LICENSE carries the AGPL §7 permission for the
# combination. __main__.py points pypardiso at the bundled mkl_rt and selects the TBB layer.
import glob as _glob
import os as _os
import sys as _sys

_libdir = _os.path.join(_sys.prefix, "Library", "bin") if _sys.platform == "win32" else _os.path.join(_sys.prefix, "lib")
_mkl_stems = (
    "mkl_rt", "mkl_core", "mkl_tbb_thread",
    "mkl_def", "mkl_mc3", "mkl_avx2", "mkl_avx512", "mkl_avx10",
    "mkl_vml_def", "mkl_vml_mc3", "mkl_vml_avx2", "mkl_vml_avx512", "mkl_vml_avx10", "mkl_vml_cmpt",
    "tbb",
)
# The LP64 interface layer is a shared library only on Linux. On Windows it lives inside mkl_rt; the
# wheel ships no mkl_intel_lp64 DLL, only an import .lib, so asking for one stopped the Windows build.
if _sys.platform != "win32":
    _mkl_stems += ("mkl_intel_lp64",)
_mkl_files = []
for _stem in _mkl_stems:
    if _sys.platform == "win32":
        _pat = _os.path.join(_libdir, f"{_stem}.*.dll") if _stem != "tbb" else _os.path.join(_libdir, "tbb12.dll")
    else:
        _pat = _os.path.join(_libdir, f"lib{_stem}.so.*") if _stem != "tbb" else _os.path.join(_libdir, "libtbb.so.12")
    _hits = [f for f in _glob.glob(_pat) if not _os.path.islink(f) or _stem == "tbb"]
    if not _hits:
        raise SystemExit(f"prism_backend.spec: Intel library '{_stem}' not found under {_libdir} — is the 'mkl' package installed?")
    _mkl_files += _hits
binaries += [(_f, ".") for _f in _mkl_files]
print(f"prism_backend.spec: bundling {len(_mkl_files)} Intel oneMKL/oneTBB libraries from {_libdir}")

a = Analysis(
    ["src/prism_lca/__main__.py"],
    pathex=["src"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # pyxlsb is LGPL-3.0 and imported only by mrio_common_metadata's EXIOBASE conversion modules
    # (mrio_common_metadata.conversion), which nothing loads; the exclusion makes that a guarantee.
    # mrio_common_metadata itself must ship: bw2io.importers imports it unconditionally, and without
    # it every bw2io importer — ecoinvent and BAFU included — fails with "This class requires Python
    # version 3." (`--bundle-check` proves the imports on the finished bundle).
    excludes=["pyxlsb"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="prism-lca-backend",
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="prism-lca-backend",
)
