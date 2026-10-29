"""Chat attachments: store a file the user handed the assistant, and read it back.

The main process owns the bytes (it read them off disk) but not the project directory, so storing
goes through here. Payloads are base64 in a JSON body, the same way the scenario import already
crosses this boundary — one shape for uploads instead of two.
"""

from __future__ import annotations

import base64
import binascii

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import attachments

router = APIRouter(prefix="/files", tags=["files"], dependencies=[Depends(require_token)])


class StoreRequest(BaseModel):
    name: str = Field(min_length=1, max_length=400)
    #: The file itself, base64. A bare payload, not a data URL — the caller strips the prefix.
    data_b64: str


@router.post("/attachments", summary="Store a chat attachment in the project")
def store_attachment(req: StoreRequest) -> dict:
    """Store the file under ``prism_meta/sources/`` and describe it.

    Idempotent: the same content stored twice keeps one file. The response carries what the chip
    above the chat input needs — kind, size, page/sheet counts and the warning, if there is one.
    """
    try:
        data = base64.b64decode(req.data_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Attachment is not valid base64: {exc}") from exc
    if not data:
        raise HTTPException(status_code=400, detail="Attachment is empty.")
    try:
        meta = attachments.store(req.name, data)
    except ValueError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    pages = meta.get("pages")
    if isinstance(pages, int) and pages > attachments.MAX_PDF_PAGES:
        raise HTTPException(
            status_code=413,
            detail=f"PDF has {pages} pages — the limit is {attachments.MAX_PDF_PAGES}.",
        )
    return {**meta, "warning": attachments.warning_for(meta)}


@router.get("/attachments/{attachment_id}", summary="What a stored attachment is")
def get_attachment(attachment_id: str) -> dict:
    meta = attachments.SourceIndex().get(attachment_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"No stored attachment '{attachment_id}'.")
    return {**meta, "warning": attachments.warning_for(meta)}


@router.get("/attachments/{attachment_id}/path", summary="Where a stored attachment lives on disk")
def get_attachment_path(attachment_id: str) -> dict:
    """The absolute path of the stored file, so the desktop shell can open it or show it in the
    file manager. Local by construction: this API serves one machine its own project directory.
    """
    meta = attachments.SourceIndex().get(attachment_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"No stored attachment '{attachment_id}'.")
    path = attachments.path_of(attachment_id, meta)
    if not path.exists():
        name = meta.get("name") or attachment_id
        raise HTTPException(status_code=404, detail=f"'{name}' is no longer in the workspace's sources folder.")
    return {"path": str(path)}


@router.get("/attachments/{attachment_id}/text", summary="A stored attachment as text a model can read")
def get_attachment_text(
    attachment_id: str,
    pages: str | None = Query(default=None, description="PDF pages, e.g. '3', '12-14', '1,4,9-11'. Omit for all."),
    sheet: str | None = Query(default=None, description="Spreadsheet: one sheet by name. Omit for all."),
    limit: int = Query(default=attachments.MAX_EXTRACT_CHARS, ge=1_000, le=attachments.MAX_EXTRACT_CHARS),
) -> dict:
    """The conversion described in ``engine/attachments``: Markdown for documents and spreadsheets,
    page-marked text for PDFs. This is also what answers a re-opened attachment after the context
    was compacted, which is why it takes a page range rather than only whole files."""
    try:
        return attachments.extract(attachment_id, pages=pages, sheet=sheet, limit=limit)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"No stored attachment '{attachment_id}'.") from exc
    except Exception as exc:  # a broken/encrypted file must not read as a missing one
        raise HTTPException(status_code=422, detail=f"Could not read the attachment: {exc}") from exc


@router.get("/attachments/{attachment_id}/raw", summary="A stored attachment's bytes, base64")
def get_attachment_raw(attachment_id: str) -> dict:
    """For the natively forwarded kinds (PDF, images): the bytes as the model transport wants them.

    Base64 in JSON rather than a binary response, because the only caller builds a data URL out of
    it — a stream would just be encoded again one layer up.
    """
    meta = attachments.SourceIndex().get(attachment_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"No stored attachment '{attachment_id}'.")
    path = attachments.path_of(attachment_id, meta)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Stored attachment '{attachment_id}' is gone from disk.")
    return {**meta, "data_b64": base64.b64encode(path.read_bytes()).decode("ascii")}
