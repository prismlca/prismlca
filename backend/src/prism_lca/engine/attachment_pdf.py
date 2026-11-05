"""A PDF attached to a chat: its page count and its text, read in worker processes within a budget.

pdfminer — the library markitdown reads PDFs with as well — parses the whole file in Python and inflates
its streams with no limit of its own, so both readings run in ``bounded_worker`` processes. A PDF over the
budget gets no page count, as when the count fails, and reading its text is refused with an error that
says why. Within the budget the readings are the same calls as ever, so their results are too.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from prism_lca.engine import bounded_worker
from prism_lca.errors import PrismError

#: Wall-clock limit of a page count, taken while the user is still typing. Counting walks the page tree:
#: well under a second for 1,100 pages, about five seconds for an 8 MB file whose cross-reference table
#: is broken and has to be rebuilt from the whole file.
COUNT_TIME_LIMIT_S = 60.0
#: Wall-clock limit of reading text. The whole of a 1,100-page text PDF reads in about two and a half
#: minutes, the whole of 100 pages of dense vector charts (14 MB) in about seven and a half. The limit
#: ends just before the ten minutes after which the desktop app stops waiting for an answer from the
#: backend, so a reading that was answered before still is.
TEXT_TIME_LIMIT_S = 580.0
#: Memory a worker may hold. Reading the whole of 100 pages of dense vector charts peaks near 270 MB, the
#: whole of a 1,100-page text PDF near 220 MB.
MEMORY_LIMIT = 1024**3
#: Workers that count pages, and workers that read text, at the same time. Counting has workers of its
#: own, so a file being attached never waits behind a long reading.
COUNTERS = 2
READERS = 2

#: How much of a reader's error message crosses back: pdfminer quotes whole streams in some of them.
_ERROR_CHARS = 2000


# ---- the worker --------------------------------------------------------------------------------------


def _count(path: str) -> int:
    from pdfminer.pdfpage import PDFPage

    # Only walks the page tree — no text extraction.
    with open(path, "rb") as fh:
        return sum(1 for _ in PDFPage.get_pages(fh))


def _whole(path: str, limit: int) -> tuple[str, bool]:
    """markitdown's Markdown of the whole file, capped at ``limit`` characters."""
    from markitdown import MarkItDown

    # Plugins off: third-party converters would decide what our attachments mean, and an install on
    # the user's machine would change what the assistant reads.
    raw = MarkItDown(enable_plugins=False).convert(path).text_content or ""
    return raw[:limit], len(raw) > limit


def _pages(path: str, order: list[int], limit: int) -> tuple[str, bool]:
    """Only the pages asked for (sorted, numbered from one), with their numbers kept — the cheap way back
    into a long PDF. The one thing markitdown cannot express, and the reason a compacted attachment does
    not have to be re-sent whole."""
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTTextContainer

    # pdfminer numbers pages from zero and yields only the selected ones, in document order — so the
    # sorted request is what maps a yielded page back to the number the user asked for.
    out: list[str] = []
    truncated = False
    for index, layout in enumerate(extract_pages(path, page_numbers={n - 1 for n in order})):
        number = order[index] if index < len(order) else index + 1
        body = "".join(e.get_text() for e in layout if isinstance(e, LTTextContainer)).strip()
        out.append(f"## Page {number}\n\n{body}" if body else f"## Page {number}\n\n(no text layer on this page)")
        if sum(len(c) for c in out) > limit:
            truncated = True
            break
    text = "\n\n".join(out)
    if len(text) > limit:
        return text[:limit], True
    return text, truncated


_READERS = {"count": _count, "whole": _whole, "pages": _pages}


def _handle(job: tuple) -> tuple:
    reader, path, *args = job
    try:
        return ("ok", _READERS[reader](path, *args))
    except Exception as exc:  # noqa: BLE001 - a file the readers reject is an answer, not a dead worker
        message = str(exc)
        return ("error", message[:_ERROR_CHARS] + "…" if len(message) > _ERROR_CHARS else message)


def _serve(conn: Any, memory_limit: int) -> None:
    bounded_worker.serve(conn, _handle, memory_limit)


# ---- the backend's side ----------------------------------------------------------------------------


def _start() -> bounded_worker.Worker:
    return bounded_worker.Worker(_serve, (MEMORY_LIMIT,), name="prism-pdf")


_counting = bounded_worker.Pool(_start, COUNTERS)
#: A reading loads the converters, which a worker would otherwise hold on to while idle; it ends instead.
_reading = bounded_worker.Pool(_start, READERS, keep_idle=False)


def shutdown() -> None:
    """Stop the idle workers; a running reading keeps its own until it ends."""
    _counting.shutdown()
    _reading.shutdown()


class ReadError(Exception):
    """The reader's own error for a file it could not read, carried across the process boundary."""


def page_count(path: Path) -> int | None:
    """How many pages the PDF has, or None when it cannot be counted within the budget or at all."""
    try:
        status, value = _counting.run(("count", str(path)), COUNT_TIME_LIMIT_S, waiting_counts=True)
    except bounded_worker.Stopped:
        return None
    return value if status == "ok" else None


def text(path: Path, pages: str | None, limit: int) -> tuple[str, bool]:
    """The PDF as text: the pages in ``pages`` (``"12-14"``) with their numbers, or all of it through
    markitdown. A file the reader rejects raises :class:`ReadError` with the reader's message; a reading
    over its budget raises a PrismError. Waiting for a free worker is part of the budget, so an answer
    always comes before the desktop app stops waiting for one."""
    wanted = _parse_pages(pages)
    job = ("pages", str(path), sorted(wanted), limit) if wanted else ("whole", str(path), limit)
    try:
        status, value = _reading.run(job, TEXT_TIME_LIMIT_S, waiting_counts=True)
    except bounded_worker.Stopped as stopped:
        raise _stopped(stopped.code) from None
    if status != "ok":
        raise ReadError(value)
    body, truncated = value
    return body, truncated


def _stopped(code: int | None) -> PrismError:
    """Why a reading gave no text, as the error it ends with — its message is all a model is shown."""
    if code is None or code == bounded_worker.EXIT_TIME:
        return PrismError(
            f"Reading the text of this PDF took longer than {TEXT_TIME_LIMIT_S:.0f} seconds and was stopped.",
            code="attachment_read_timeout",
            status_code=422,
        )
    if code == bounded_worker.EXIT_MEMORY:
        return PrismError(
            f"Reading the text of this PDF needed more than {MEMORY_LIMIT / 1024**3:g} GB of memory and was "
            "stopped.",
            code="attachment_read_out_of_memory",
            status_code=422,
        )
    return PrismError(
        f"The process reading this PDF stopped unexpectedly (exit code {code}). Trying again starts a new one.",
        code="attachment_read_failed",
        status_code=422,
    )


def _parse_pages(spec: str | None) -> set[int] | None:
    """``"3"``, ``"12-14"``, ``"1,4,9-11"`` → the set of page numbers; ``None`` = all of them."""
    if not spec or not spec.strip():
        return None
    wanted: set[int] = set()
    for part in spec.split(","):
        chunk = part.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo, _, hi = chunk.partition("-")
            try:
                start, end = int(lo), int(hi)
            except ValueError:
                continue
            if start <= end:
                wanted.update(range(start, min(end, start + 200) + 1))
        else:
            try:
                wanted.add(int(chunk))
            except ValueError:
                continue
    return wanted or None
