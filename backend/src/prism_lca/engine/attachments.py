"""Chat attachments: keep what the user hands the assistant, and make it readable for a model.

Files dropped into the chat are stored in the active project under ``prism_meta/sources/``, keyed by
a hash of their content, and indexed in ``prism_meta/sources.json``. Two reasons for putting them on
disk rather than only into the request:

* The context forgets. A long conversation gets compacted (see the front-end agent's
  ``compactMessages``), and an attachment that lived only in the message array is then gone for good.
  On disk it stays reachable, so a compacted attachment can be opened again — by page, by sheet —
  instead of being re-uploaded.
* The same specification is usually consulted more than once. Hashing deduplicates: attaching the
  same PDF in three chats stores one file.

**What goes to the model in which form**: PDFs and
images travel natively, so the model sees the layout, the diagrams and the tables as drawn — this
module only stores and measures them. Everything a chat endpoint cannot take is converted to
Markdown here.

``markitdown`` is the converter for all of it — Word, spreadsheets and the text side of a PDF — so
there is one place where "file becomes readable" happens. It is capped rather than trusted: the
counts that say what a file holds are taken separately (:func:`measure`) and prepended, because a
converted table that silently stops invites the model to sum a column and report the total of a
twelfth of the data.

The single exception is a **page range**. Asking for pages 12-14 of an 80-page PDF is what makes
re-reading after a compaction cheap, and a whole-file converter cannot express it. That path — and
the page count — goes through ``pdfminer``, which is the library markitdown itself reads PDFs with:
one PDF engine in the stack, and a page range whose text matches what the whole document produced.

No OCR anywhere, deliberately: a scanned PDF is answered by the native route, where the model reads
the page images itself. What has no text layer says so instead of being guessed at.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC
from pathlib import Path
from typing import Any, ClassVar

from prism_lca.engine._store import JsonFileStore, LoadPolicy, now_iso, prism_meta_dir

#: Hard cap on extracted text per file. ~25k tokens; beyond this the model is reading noise, and the
#: rest stays one `read_source` away.
MAX_EXTRACT_CHARS = 100_000
#: Rows in a workbook beyond which the conversion will not fit the character cap and the user should
#: hear about it before sending. Not a cap of its own — the cap is `MAX_EXTRACT_CHARS`, and the true
#: row count is written above the tables either way (see `_sheet_header`).
BIG_SHEET_ROWS = 5_000
#: Above this the UI warns before sending — roughly 50 pages of prose, and the point where an
#: attachment starts to dominate every later turn of the conversation.
WARN_CHARS = 100_000
#: Same warning, counted in pages, for the natively forwarded PDFs (a page costs far more than its
#: characters once the page image rides along).
WARN_PAGES = 50
#: Refused outright: the ceiling above which Claude stops looking at a PDF's visual elements.
MAX_PDF_PAGES = 1_000

_NATIVE_PDF = {".pdf"}
_NATIVE_IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_SHEETS = {".xlsx", ".xlsm", ".xltx", ".xltm"}
#: Read as text as they are — converting these would only add markup to something already readable.
_PLAIN = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml", ".py", ".js",
    ".ts", ".tsx", ".jsx", ".log", ".rst", ".ini", ".cfg", ".toml", ".sql", ".r", ".m", ".sh",
}
#: Handed to markitdown — and deliberately only what the extras we install can actually convert
#: (`docx` for Word, the core for HTML). Listing .pptx or .odt here would accept a file and then fail
#: at extraction, which is worse than refusing it at the chip. Unknown suffixes are refused rather
#: than guessed at, so the message can name the format that was not understood.
_CONVERT = {".docx", ".html", ".htm"}


def kind_of(name: str) -> str:
    """Which of the five routes a file takes: ``pdf``, ``image``, ``sheet``, ``text``, ``document``.

    Returns ``""`` for anything we refuse — the caller turns that into a message naming the suffix.
    """
    suffix = Path(name).suffix.lower()
    if suffix in _NATIVE_PDF:
        return "pdf"
    if suffix in _NATIVE_IMAGE:
        return "image"
    if suffix in _SHEETS:
        return "sheet"
    if suffix in _PLAIN:
        return "text"
    if suffix in _CONVERT:
        return "document"
    return ""


def sources_dir() -> Path:
    """Where attached files live — one directory per project, shared by all its models."""
    return prism_meta_dir() / "sources"


def _safe_name(name: str) -> str:
    """A file name we are willing to write. The original travels in the index, not on disk."""
    stem = Path(name).name
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", stem).strip("._")
    return cleaned[:80] or "attachment"


class SourceIndex(JsonFileStore):
    """``prism_meta/sources.json`` — id → what the file is, so the stored blob keeps its identity.

    Not registered in ``per_model_stores``: attachments are deduplicated across the whole project and
    a file may be cited by chats of several models, so deleting one model must not delete them.
    """

    FILENAME: ClassVar[str] = "sources.json"
    #: A half-written index costs stored blobs their names, not the blobs; rebuilding beats refusing
    #: to start.
    ON_ERROR: ClassVar[LoadPolicy] = "empty_io"

    def _default(self) -> dict:
        return {}

    def get(self, attachment_id: str) -> dict | None:
        entry = self._load().get(attachment_id)
        return dict(entry) if isinstance(entry, dict) else None

    def put(self, attachment_id: str, meta: dict) -> None:
        with self._lock:
            data = self._load()
            data[attachment_id] = meta
            self._save(data)

    def all(self) -> dict:
        return self._load()

    def remove(self, attachment_ids: set[str]) -> None:
        with self._lock:
            data = self._load()
            kept = {k: v for k, v in data.items() if k not in attachment_ids}
            if len(kept) != len(data):
                self._save(kept)


#: An attachment younger than this is kept even when no message names it yet: it was uploaded a
#: moment ago and the message that will cite it is still being typed. Deleting a chat in another
#: model in that moment must not take it.
GRACE_SECONDS = 60 * 60


def prune_unreferenced(grace_seconds: int | None = None) -> list[str]:
    """Remove every stored attachment no chat message of the project names any more.

    This is how an attachment ends: not by a delete button, but by the last message that cites it
    going away — a deleted chat, a deleted model. The chat-delete route and the model-delete cascade
    call this right after; the startup sweep (``engine.hygiene``) catches what those missed.
    Returns the ids removed.
    """
    from datetime import datetime, timedelta

    from prism_lca.engine.chat_store import ChatStore

    grace = GRACE_SECONDS if grace_seconds is None else grace_seconds
    cutoff = datetime.now(UTC) - timedelta(seconds=grace)
    referenced = ChatStore().attachment_ids()
    index = SourceIndex()
    doomed: set[str] = set()
    for attachment_id, meta in index.all().items():
        if attachment_id in referenced:
            continue
        added = (meta or {}).get("added") if isinstance(meta, dict) else None
        try:
            if added and datetime.fromisoformat(str(added)) > cutoff:
                continue
        except ValueError:
            pass  # an unreadable timestamp is no reason to keep the file
        doomed.add(attachment_id)
    for attachment_id in doomed:
        try:
            path_of(attachment_id, index.get(attachment_id)).unlink(missing_ok=True)
        except OSError:
            pass  # the index entry goes either way; a stray blob is re-collected next sweep
    index.remove(doomed)
    return sorted(doomed)


def path_of(attachment_id: str, meta: dict | None = None) -> Path:
    """On-disk path of a stored attachment. Ids are our own hash-derived names, never user input —
    but they arrive from a model in ``read_source``, so the traversal guard stays."""
    stored = (meta or {}).get("stored") or attachment_id
    name = Path(str(stored)).name
    return sources_dir() / name


def store(name: str, data: bytes) -> dict:
    """Put a file into the project's sources and describe it. Idempotent per content hash."""
    kind = kind_of(name)
    if not kind:
        suffix = Path(name).suffix.lower() or "(none)"
        raise ValueError(f"Cannot attach {suffix} files — supported: PDF, images, spreadsheets, documents, text.")
    digest = hashlib.sha256(data).hexdigest()[:12]
    stored = f"{digest}-{_safe_name(name)}"
    attachment_id = stored
    target = sources_dir() / stored
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(target)
    index = SourceIndex()
    meta: dict[str, Any] = index.get(attachment_id) or {}
    meta.update(
        {
            "id": attachment_id,
            "name": Path(name).name,
            "stored": stored,
            "kind": kind,
            "bytes": len(data),
            "added": meta.get("added") or now_iso(),
        }
    )
    meta.update(measure(target, kind))
    index.put(attachment_id, meta)
    return meta


def measure(path: Path, kind: str) -> dict:
    """How much there is of it — the numbers the size warning and the model's stub are built from.

    Measuring is separate from extracting on purpose: a page count must not cost a full text pass,
    because it is taken while the user is still typing.
    """
    out: dict[str, Any] = {}
    if kind == "pdf":
        try:
            from pdfminer.pdfpage import PDFPage

            # Counting only walks the page tree — no text extraction, single-digit milliseconds even
            # for long documents. It has to be that cheap: it happens while the user is still typing.
            with path.open("rb") as fh:
                out["pages"] = sum(1 for _ in PDFPage.get_pages(fh))
        except Exception:
            # A page count we could not take is not a reason to refuse the file — the model still
            # gets it, only the warning cannot say how long it is.
            pass
    elif kind == "sheet":
        try:
            from openpyxl import load_workbook

            wb = load_workbook(path, read_only=True, data_only=True)
            try:
                out["sheets"] = [
                    {"name": ws.title, "rows": ws.max_row or 0, "columns": ws.max_column or 0}
                    for ws in wb.worksheets
                ]
            finally:
                wb.close()
        except Exception:
            pass
    elif kind == "text":
        try:
            out["chars"] = len(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            pass
    return out


def _read_text_file(path: Path, limit: int) -> tuple[str, bool]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    if len(raw) <= limit:
        return raw, False
    return raw[:limit], True


def _convert(path: Path, limit: int) -> tuple[str, bool]:
    """markitdown's Markdown for anything that is not plain text, capped at ``limit`` characters."""
    from markitdown import MarkItDown

    # Plugins off: third-party converters would decide what our attachments mean, and an install on
    # the user's machine would change what the assistant reads.
    raw = MarkItDown(enable_plugins=False).convert(str(path)).text_content or ""
    return raw[:limit], len(raw) > limit


def _sheet_header(meta_sheets: Any) -> str:
    """What the workbook holds, stated before its tables.

    markitdown converts the sheets; it does not say how much it left out when the result is cut to
    the character cap. These counts come from :func:`measure`, so the model can see that the table it
    is reading is a beginning and not the whole of it.
    """
    if not isinstance(meta_sheets, list) or not meta_sheets:
        return ""
    lines = [
        f"- {s.get('name')}: {s.get('rows')} rows × {s.get('columns')} columns"
        for s in meta_sheets
        if isinstance(s, dict)
    ]
    return "# Workbook contents\n\n" + "\n".join(lines) + "\n\n" if lines else ""


def _pdf_pages(path: Path, pages: str, limit: int) -> tuple[str, bool]:
    """Only the pages asked for, with their numbers kept — the cheap way back into a long PDF.

    The one thing markitdown cannot express, and the reason a compacted attachment does not have to
    be re-sent whole.
    """
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTTextContainer

    wanted = _parse_pages(pages)
    if not wanted:
        return _convert(path, limit)
    # pdfminer numbers pages from zero and yields only the selected ones, in document order — so the
    # sorted request is what maps a yielded page back to the number the user asked for.
    order = sorted(wanted)
    out: list[str] = []
    truncated = False
    for index, layout in enumerate(extract_pages(str(path), page_numbers={n - 1 for n in order})):
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


def extract(
    attachment_id: str,
    *,
    pages: str | None = None,
    sheet: str | None = None,
    limit: int = MAX_EXTRACT_CHARS,
) -> dict:
    """The file as text a model can read. Raises ``FileNotFoundError`` if the id is unknown."""
    meta = SourceIndex().get(attachment_id)
    if meta is None:
        raise FileNotFoundError(attachment_id)
    path = path_of(attachment_id, meta)
    if not path.exists():
        raise FileNotFoundError(attachment_id)
    kind = str(meta.get("kind") or kind_of(str(meta.get("name") or attachment_id)))
    if kind == "image":
        # Images have no text side. Saying so beats returning "" — an empty result reads as "the
        # file is empty", and the model would go looking for a different file.
        return {**meta, "text": "", "truncated": False, "note": "Images are shown to the model directly, not as text."}
    if kind == "text":
        text, truncated = _read_text_file(path, limit)
    elif kind == "pdf" and pages:
        text, truncated = _pdf_pages(path, pages, limit)
    elif kind == "sheet":
        head = _sheet_header(meta.get("sheets"))
        body, truncated = _convert(path, max(limit - len(head), 1_000))
        text = head + body
    else:
        text, truncated = _convert(path, limit)
    # `sheet` narrows a workbook to one tab. markitdown converts all of them, so the narrowing
    # happens on its output — announced, because a silent drop of the other sheets would look like
    # the workbook only ever had one.
    if kind == "sheet" and sheet:
        text = _only_sheet(text, sheet)
    return {**meta, "text": text, "truncated": truncated}


def _only_sheet(markdown: str, sheet: str) -> str:
    """Keep the requested sheet's section of a converted workbook (markitdown heads each with '## ')."""
    sections = re.split(r"(?m)^## ", markdown)
    for section in sections[1:]:
        title = section.split("\n", 1)[0].strip()
        if title.lower() == sheet.strip().lower():
            return f"## {section.rstrip()}"
    return markdown


def warning_for(meta: dict) -> str:
    """What to tell the user before they send this — empty when there is nothing to say.

    English, because it is UI text; the numbers are the ones ``measure`` took.
    """
    pages = meta.get("pages")
    if isinstance(pages, int) and pages > WARN_PAGES:
        return f"{pages} pages — this file is re-read on every message of the conversation and will use a lot of tokens."
    chars = meta.get("chars")
    if isinstance(chars, int) and chars > WARN_CHARS:
        return f"{chars // 1000}k characters — this file is re-read on every message and will use a lot of tokens."
    sheets = meta.get("sheets")
    if isinstance(sheets, list):
        rows = sum(int(s.get("rows") or 0) for s in sheets if isinstance(s, dict))
        if rows > BIG_SHEET_ROWS:
            return f"{rows} rows — the model gets the beginning of the workbook, not all of it."
    # A PDF goes to the provider as a file. A model that cannot read PDFs itself gets the text from
    # OpenRouter's parser, which runs at Cloudflare — one more recipient the user should know about
    # before sending (privacy notice). Said on the chip, where the decision is made.
    if meta.get("kind") == "pdf":
        return "PDF: a model that cannot read PDFs itself gets the text via OpenRouter's parser at Cloudflare."
    return ""
