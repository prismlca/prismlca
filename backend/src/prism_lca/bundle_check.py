"""``prism-lca-backend --bundle-check``: import everything the backend loads only when it is needed.

The packaged backend starts without most of its libraries: bw2io, the search model, the PDF and spreadsheet
readers and the routing library are imported inside the functions that use them. A start, a smoke test and the
solver check therefore pass even when one of them cannot be imported in the bundle — the import fails only when
a user reaches that function. That happened: the PyInstaller spec excluded ``mrio_common_metadata`` on the belief
that nothing imports it, but ``bw2io.importers`` imports it unconditionally, so every ecoinvent and BAFU import
in every installer failed with bw2io's message "This class requires Python version 3.".

This check imports every module of the package and every library on :data:`LAZY_IMPORTS`, then converts a
tiny HTML, XLSX and DOCX file the way chat attachments are converted: markitdown imports its format libraries
(mammoth, pandas, openpyxl) only when it converts, so an import alone would not notice one missing. Last it
starts two worker processes the way Windows always starts them (``spawn``: a fresh copy of the executable)
and waits for their answers — the ecoinvent import reads its datasets in such workers, and a frozen worker
that runs the normal start-up instead of its task never answers. It prints each failure with its original
cause. ``tests/test_bundle_check.py`` keeps the list complete: a function-level import
of a third-party module that is not on it fails the suite.
"""

from __future__ import annotations

import importlib
import multiprocessing
import pkgutil
import tempfile
import traceback
import zipfile
from pathlib import Path

#: Third-party modules imported inside functions somewhere in ``prism_lca``.
LAZY_IMPORTS: tuple[str, ...] = (
    "asteval",
    "bw2calc",
    "bw2data",
    "bw2data.backends",
    "bw2data.parameters",
    "bw2data.project",
    "bw2io",
    "bw2io.backup",
    "bw2io.extractors.ecospold2",
    "bw2io.extractors.json_ld",
    "bw2io.importers.ecospold2_biosphere",
    "bw2io.strategies",
    "bw2parameters",
    "fastembed",
    "huggingface_hub",
    "huggingface_hub.file_download",
    "lxml",
    "lxml.etree",
    "markitdown",
    "numpy",
    "openai",
    "openpyxl",
    "pdfminer.high_level",
    "pdfminer.layout",
    "pdfminer.pdfpage",
    "pypardiso",
    "scipy.sparse",
    "scipy.sparse.linalg",
    "searoute",
    "sentence_transformers",
    "starlette.responses",
)


def _cause(exc: BaseException) -> str:
    """The exception and every cause behind it — bw2io re-raises a missing module under another message."""
    lines = []
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        lines.append("".join(traceback.format_exception_only(type(exc), exc)).strip())
        exc = exc.__cause__ or exc.__context__
    return " ← ".join(lines)


_DOCX_PARTS = {
    "[Content_Types].xml": (
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    ),
    "_rels/.rels": (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Target="word/document.xml" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>'
    ),
    "word/document.xml": (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>probe-docx</w:t></w:r></w:p></w:body></w:document>"
    ),
}


def _conversion_failures() -> list[str]:
    """Convert one tiny file per attachment format through markitdown; each failure as a line."""
    from markitdown import MarkItDown
    from openpyxl import Workbook

    failures = []
    # Cleanup errors are not bundle defects: on Windows a converter may still hold a probe file open.
    with tempfile.TemporaryDirectory(prefix="prism-bundle-check-", ignore_cleanup_errors=True) as tmp:
        files = {"html": Path(tmp) / "probe.html", "xlsx": Path(tmp) / "probe.xlsx", "docx": Path(tmp) / "probe.docx"}
        files["html"].write_text("<html><body><p>probe-html</p></body></html>", encoding="utf-8")
        book = Workbook()
        book.active["A1"] = "probe-xlsx"
        book.save(files["xlsx"])
        with zipfile.ZipFile(files["docx"], "w") as docx:
            for name, xml in _DOCX_PARTS.items():
                docx.writestr(name, xml)
        converter = MarkItDown(enable_plugins=False)
        for kind, path in files.items():
            try:
                text = converter.convert(str(path)).text_content or ""
                if f"probe-{kind}" not in text:
                    failures.append(f"convert {kind}: the marker is missing from the output")
            except Exception as exc:  # noqa: BLE001 — reported with its cause
                failures.append(f"convert {kind}: {_cause(exc)}")
    return failures


#: How long the worker probe waits. A spawned worker loads bw2io before it answers; the CI runners and a
#: slow disk need some of that, a worker that never reaches its task needs all of it.
WORKER_TIMEOUT_SECONDS = 180.0


def _probe_task(n: int) -> int:
    """What a worker of the ecoinvent import does first: load bw2io's ecoSpold-2 reader."""
    from prism_lca.engine.bootstrap import get_bi

    get_bi()
    import bw2io.extractors.ecospold2  # noqa: F401 — the import is the probe

    return n * n


def _worker_failures() -> list[str]:
    """Two spawned workers, two answers within the time limit — or one line saying what went wrong."""
    from prism_lca.engine.ecoinvent_inventory import prepare_worker

    with multiprocessing.get_context("spawn").Pool(2, initializer=prepare_worker) as pool:
        try:
            answers = pool.map_async(_probe_task, [2, 3]).get(timeout=WORKER_TIMEOUT_SECONDS)
        except multiprocessing.TimeoutError:
            return [
                f"worker processes: no answer within {WORKER_TIMEOUT_SECONDS:.0f} s — the workers do "
                "not reach their task (a frozen executable without multiprocessing.freeze_support())"
            ]
    return [] if answers == [4, 9] else [f"worker processes: answered {answers}, expected [4, 9]"]


def run() -> int:
    """Import everything; print one line per failure. 0 when all imports work, 1 otherwise."""
    import prism_lca

    names = [
        info.name
        for info in pkgutil.walk_packages(prism_lca.__path__, "prism_lca.")
        if info.name != "prism_lca.__main__"
    ]
    failures = []
    for name in [*names, *LAZY_IMPORTS]:
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 — every failure is reported, none is fatal here
            failures.append(f"{name}: {_cause(exc)}")
    try:
        conversions = _conversion_failures()
    except Exception as exc:  # noqa: BLE001 — markitdown or openpyxl itself missing
        conversions = [f"conversion probes: {_cause(exc)}"]
    failures += conversions
    try:
        failures += _worker_failures()
    except Exception as exc:  # noqa: BLE001 — a pool that cannot even start is a failure too
        failures.append(f"worker processes: {_cause(exc)}")
    for line in failures:
        print(f"bundle: FAIL {line}")
    print(
        f"bundle: {len(names)} package modules and {len(LAZY_IMPORTS)} libraries imported, "
        f"3 attachment formats converted, 2 worker processes asked, {len(failures)} failed"
    )
    return 1 if failures else 0
