"""Where the frozen backend finds Intel MKL's runtime (mkl_runtime.bundled_mkl_rt).

A Windows bundle once looked for ``mkl_rt.2.dll`` while MKL 2026 ships ``mkl_rt.3.dll``: PyInstaller
bundled the library, nothing found it, and pypardiso quietly fell back to SciPy.
"""
from __future__ import annotations

from pathlib import Path

from prism_lca.mkl_runtime import bundled_mkl_rt


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
