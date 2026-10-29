"""The report's colour sets: the catalogue the picker shows, and the sets a user adds of their own.

A set is the *colour* half of a document's look (the theme is the layout half). The shipped sets are fixed
per version; the user's own belong to the installation rather than to a report or a workspace, so this
surface has no database in its paths — `engine/report_palettes` holds both kinds and resolves either when a
report is typeset.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.config import get_settings
from prism_lca.engine import report_palettes

router = APIRouter(prefix="/report", tags=["report"], dependencies=[Depends(require_token)])


class NewPaletteRequest(BaseModel):
    label: str
    accent: str
    deep: str
    paper: str


@router.get("/palettes", summary="Colour sets a report can be typeset in")
def list_palettes() -> dict:
    """The catalogue for the colour picker: id, label, hint and three swatches each — the shipped sets,
    then the user's own (`builtin: false`).

    A report only names a set. One it names that is gone — dropped by a later version, deleted, or added on
    another computer — falls back to the default instead of failing to render.
    """
    # The flag rides with the catalogue rather than in an endpoint of its own: the picker fetches this once
    # per session anyway, and a switch nobody can flip from the UI has no business being a request.
    return {
        "palettes": report_palettes.list_palettes(),
        "default": report_palettes.DEFAULT_PALETTE,
        "custom_colors": get_settings().report_custom_colors,
    }


@router.post("/palettes", summary="Add a colour set of your own (name and three colours)")
def add_palette(body: NewPaletteRequest) -> dict:
    """Accent, deep tone and paper as hex, and a name no other set has. Available to every report on this
    computer from then on."""
    return {"palette": report_palettes.add_user_palette(body.label, body.accent, body.deep, body.paper)}


@router.post("/palettes/{palette_id}/delete", summary="Delete a colour set of your own")
def delete_palette(palette_id: str) -> dict:
    """Reports that use it render in the default set from then on; the shipped sets cannot be deleted."""
    report_palettes.remove_user_palette(palette_id)
    return {"ok": True}
