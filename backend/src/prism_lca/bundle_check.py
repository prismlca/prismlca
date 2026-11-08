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
that runs the normal start-up instead of its task never answers. Then it typesets one tiny document offline,
through the worker process every preview and PDF is compiled in, and counts and reads one tiny PDF through the
worker process every PDF attachment is read in (markitdown loads its PDF libraries only there). Last it computes
one LCA through the engine the calculate endpoint uses: an import proves a library loads, only a write and a
solve prove that bw2data, bw_processing, matrix_utils and bw2calc work together with this build's solver and
data files. It prints each failure with its original cause. ``tests/test_bundle_check.py`` keeps the list complete: a function-level import
of a third-party module that is not on it fails the suite.
"""

from __future__ import annotations

import importlib
import multiprocessing
import os
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
    "bw2data.backends.schema",
    "bw2data.backends.utils",
    "bw2data.configuration",
    "bw2data.parameters",
    "bw2data.project",
    "bw2data.utils",
    "bw2io",
    "bw2io.backup",
    "bw2io.extractors.ecospold2",
    "bw2io.extractors.json_ld",
    "bw2io.importers.ecospold2_biosphere",
    "bw2io.strategies",
    "bw2parameters",
    "bw_processing.filesystem",
    "bw_processing.utils",
    "fastembed",
    "huggingface_hub",
    "huggingface_hub.file_download",
    "lxml",
    "lxml.etree",
    "markitdown",
    "matrix_utils.aggregation",
    "numpy",
    "openai",
    "openpyxl",
    "pdfminer.high_level",
    "pdfminer.layout",
    "pdfminer.pdfpage",
    "peewee",
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


def _typesetting_failures() -> list[str]:
    """One tiny offline document typeset through the compiler's worker process, as every preview is."""
    from prism_lca.engine import typst_render, typst_worker

    try:
        pdf = typst_render.compile_pdf({"main.typ": "probe\n"})
    finally:
        typst_worker.shutdown()
    return [] if pdf.startswith(b"%PDF") else ["typesetting: the worker returned something that is not a PDF"]


def _probe_pdf() -> bytes:
    """A one-page PDF that says "probe-pdf" in a standard font, with a cross-reference table."""
    content = b"BT /F1 12 Tf 72 720 Td (probe-pdf) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    table = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, table)
    return bytes(out)


def _pdf_failures() -> list[str]:
    """One tiny PDF read and counted through the worker process every PDF attachment is read in."""
    from prism_lca.engine import attachment_pdf

    with tempfile.TemporaryDirectory(prefix="prism-bundle-check-", ignore_cleanup_errors=True) as tmp:
        path = Path(tmp) / "probe.pdf"
        path.write_bytes(_probe_pdf())
        try:
            text, _ = attachment_pdf.text(path, None, 10_000)  # raises with the reason when it fails
            pages = attachment_pdf.page_count(path)
        finally:
            attachment_pdf.shutdown()
    failures = [] if "probe-pdf" in text else ["pdf: the marker is missing from the text"]
    return failures + ([] if pages == 1 else [f"pdf: counted {pages} pages, expected 1"])


#: A bottle needs 2 kWh; each kWh emits 0.5 kg CO2 and the bottle itself 0.1 kg. At 1 per kg CO2 that is 1.1
#: in all, 0.1 of it direct.
_PROBE_SCORE, _PROBE_DIRECT = 1.1, 0.1


def _write_probe_system(bd) -> None:
    bd.Database("probe-biosphere").write(
        {
            ("probe-biosphere", "co2"): {
                "name": "Carbon dioxide",
                "type": "emission",
                "categories": ("air",),
                "unit": "kg",
            }
        }
    )
    bd.Database("probe").write(
        {
            ("probe", "elec"): {
                "name": "electricity",
                "unit": "kWh",
                "reference product": "electricity",
                "exchanges": [
                    {"input": ("probe", "elec"), "amount": 1, "type": "production"},
                    {"input": ("probe-biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("probe", "bottle"): {
                "name": "bottle",
                "unit": "unit",
                "reference product": "bottle",
                "exchanges": [
                    {"input": ("probe", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("probe", "elec"), "amount": 2, "type": "technosphere"},
                    {"input": ("probe-biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("probe", "gwp")).write([(("probe-biosphere", "co2"), 1.0)])


def _calculation_failures() -> list[str]:
    """One LCA of a two-process system in a project of its own, which is deleted afterwards, and the
    project that was current before made current again."""
    from prism_lca.engine import lca
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    before = bd.projects.current
    name = f"prism-bundle-check-{os.getpid()}"
    bd.projects.set_current(name)
    try:
        _write_probe_system(bd)
        result = lca.compute_lcia("probe", "bottle", ["probe", "gwp"], direct_split=True)
    finally:
        bd.projects.set_current(before)
        # The cached LCA keeps the project's processed ZIP files open; Windows would refuse to delete them.
        lca.release_cached(name)
        bd.projects.delete_project(name, delete_dir=True)
    got = (result["score"], result["direct"])
    # Brightway's matrices hold float32: 1.1 comes back as 1.1000000015.
    if abs(got[0] - _PROBE_SCORE) < 1e-6 and abs(got[1] - _PROBE_DIRECT) < 1e-6:
        return []
    return [f"calculation: score {got[0]}, direct {got[1]}; expected {_PROBE_SCORE}, {_PROBE_DIRECT}"]


def run() -> int:
    """Import everything; print one line per failure. 0 when all imports work, 1 otherwise.

    In a Brightway directory of its own: bw2data creates its ``projects.db`` and a ``default`` project
    wherever it first looks, and without one that would be the Brightway directory of whoever runs
    the check — on a developer's machine, their own Brightway projects. The workers inherit it.
    """
    with tempfile.TemporaryDirectory(prefix="prism-bundle-check-bw-", ignore_cleanup_errors=True) as bw_dir:
        os.environ["BRIGHTWAY2_DIR"] = bw_dir
        return _check_everything()


def _check_everything() -> int:
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
    try:
        failures += _typesetting_failures()
    except Exception as exc:  # noqa: BLE001 — reported with its cause
        failures.append(f"typesetting: {_cause(exc)}")
    try:
        failures += _pdf_failures()
    except Exception as exc:  # noqa: BLE001 — reported with its cause
        failures.append(f"pdf: {_cause(exc)}")
    try:
        failures += _calculation_failures()
    except Exception as exc:  # noqa: BLE001 — reported with its cause
        failures.append(f"calculation: {_cause(exc)}")
    for line in failures:
        print(f"bundle: FAIL {line}")
    print(
        f"bundle: {len(names)} package modules and {len(LAZY_IMPORTS)} libraries imported, "
        f"3 attachment formats converted, 2 worker processes asked, 1 document typeset, 1 PDF read, "
        f"1 LCA computed, {len(failures)} failed"
    )
    return 1 if failures else 0
