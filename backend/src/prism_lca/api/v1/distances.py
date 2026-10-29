"""Sea distances over the searoute shipping-lane network — geometry only, no key, no external call.

The Electron main process geocodes (it holds the user's API keys) and sends coordinates; this
endpoint answers with the distance *sailed* between the network nodes nearest to those points, plus
how far each input point sits from its node. The two are reported separately and never added: an
inland factory snapped to Bremerhaven has a 450 km road or rail leg in front of the ship, and whose
leg that is — and by which mode — is the practitioner's decision.

`/places/resolve` and `/places/suggest` answer from the local airport and port catalogues
(engine/transport_catalogue.py) so a code or a named terminal needs no geocoding request.

Data provenance: `searoute` (Apache-2.0) on Eurostat's marnet network (EUPL-1.2) with ORNL's global
shipping lanes, its bundled port list, and OurAirports (Public Domain); see docs/DATENHERKUNFT.md. The network is loaded on first use (~1 s), which is why
the import sits inside the handler rather than at module level: a backend start must not pay for a
feature most sessions never touch.
"""
from __future__ import annotations

import math
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import transport_catalogue as catalogue
from prism_lca.engine.geodesy import geodesic_km

router = APIRouter(prefix="/distances", tags=["distances"], dependencies=[Depends(require_token)])

SOURCE = "searoute 1.6 on the Eurostat marnet shipping-lane network"


class Point(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


SeaVia = Literal["shortest", "cape"]

# searoute's default blocks only the Northwest Passage. "cape" additionally blocks Suez AND Panama:
# with Suez alone blocked, Shanghai→Rotterdam went east through Panama (25 021 km) — a hair shorter
# than round Africa and not what anyone means by "around the Cape".
_RESTRICTIONS: dict[str, list[str]] = {
    "shortest": ["northwest"],
    "cape": ["northwest", "suez", "panama"],
}


class SeaLeg(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: Point = Field(alias="from")
    to: Point
    # The routing the study assumes. Since late 2023 much Asia–Europe traffic goes around the Cape of
    # Good Hope; the network's shortest path is Suez, and a study has to be able to ask for the other.
    via: SeaVia = "shortest"


class SeaRequest(BaseModel):
    legs: list[SeaLeg] = Field(min_length=1, max_length=50)


class SeaLegResult(BaseModel):
    """One leg. `km` is node to node; the snap offsets say how far each place is from its node.
    A leg the network cannot serve carries `error` and nulls rather than failing the batch."""

    km: float | None
    from_snap_km: float | None
    to_snap_km: float | None
    passages: list[str] = Field(default_factory=list)
    via: SeaVia = "shortest"
    error: str | None = None


class SeaResponse(BaseModel):
    legs: list[SeaLegResult]
    source: str = SOURCE


def _norm_lon(lon: float) -> float:
    """searoute unrolls longitudes across the antimeridian (181° instead of -179°)."""
    return (lon + 180.0) % 360.0 - 180.0


_SAME_NODE = (
    "no sea leg between these places — both lie next to the same shipping-lane node "
    "(too close for a sea leg) or the network returned no route"
)


def _fail(leg: SeaLeg, error: str) -> SeaLegResult:
    return SeaLegResult(km=None, from_snap_km=None, to_snap_km=None, via=leg.via, error=error)


def _one_leg(leg: SeaLeg) -> SeaLegResult:
    import searoute  # noqa: PLC0415 — deliberate: loads the network on first use, see module doc

    if (leg.from_.lat, leg.from_.lon) == (leg.to.lat, leg.to.lon):
        # The same place twice: no transport, and no reason to ask the network.
        return SeaLegResult(km=0.0, from_snap_km=0.0, to_snap_km=0.0, via=leg.via)
    try:
        feature = searoute.searoute(
            (leg.from_.lon, leg.from_.lat),
            (leg.to.lon, leg.to.lat),
            units="km",
            restrictions=_RESTRICTIONS[leg.via],
            # Not combined with include_ports=True: in searoute 1.6 that pair raises
            # "TypeError: unhashable type: 'list'". Ports are resolved separately (/places/*).
            return_passages=True,
        )
    except Exception as exc:  # the library raises plain Exceptions for unroutable input
        return _fail(leg, str(exc)[:200])
    props = feature.get("properties") or {}
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    length = props.get("length")
    if (
        not coords
        or not isinstance(length, (int, float))
        or isinstance(length, bool)
        or not math.isfinite(length)
        or length < 0
    ):
        # Two different places, and the network has no leg between them: both snapped to the same
        # node, or the answer is broken. Either way a 0 would claim "no transport" — refuse instead.
        return _fail(leg, _SAME_NODE)
    if not all(len(c) >= 2 and all(math.isfinite(float(v)) for v in c[:2]) for c in (coords[0], coords[-1])):
        return _fail(leg, "the network returned an invalid route geometry")
    first_lon, first_lat = _norm_lon(float(coords[0][0])), float(coords[0][1])
    last_lon, last_lat = _norm_lon(float(coords[-1][0])), float(coords[-1][1])
    if length == 0:
        return _fail(leg, _SAME_NODE)
    return SeaLegResult(
        km=round(float(length), 1),
        from_snap_km=round(geodesic_km(leg.from_.lat, leg.from_.lon, first_lat, first_lon), 1),
        to_snap_km=round(geodesic_km(leg.to.lat, leg.to.lon, last_lat, last_lon), 1),
        passages=[str(p) for p in props.get("traversed_passages") or []],
        via=leg.via,
    )


@router.post("/sea", response_model=SeaResponse, summary="Sailed distance between coordinate pairs")
async def sea_distances(payload: SeaRequest) -> SeaResponse:
    return SeaResponse(legs=[_one_leg(leg) for leg in payload.legs])


# --- Airports and sea ports from the local catalogues (engine/transport_catalogue.py) ------------

PlaceKind = Literal["airport", "port"]


class PlaceQuery(BaseModel):
    text: str = Field(min_length=1, max_length=200)
    country: str | None = Field(default=None, max_length=2)


class ResolveRequest(BaseModel):
    kind: PlaceKind
    items: list[PlaceQuery] = Field(min_length=1, max_length=40)


class TerminalOut(BaseModel):
    code: str
    label: str
    lat: float
    lon: float
    country: str
    major: bool


class ResolveItem(BaseModel):
    """`match` when the text names a catalogue terminal; `error` when it names several; both null
    when it names none (the caller geocodes it as a place)."""

    match: TerminalOut | None = None
    error: str | None = None


class ResolveResponse(BaseModel):
    items: list[ResolveItem]
    source: str


def _out(t: catalogue.Terminal) -> TerminalOut:
    return TerminalOut(code=t.code, label=t.label, lat=t.lat, lon=t.lon, country=t.country, major=t.major)


def _source(kind: PlaceKind) -> str:
    return catalogue.airport_source() if kind == "airport" else catalogue.PORT_SOURCE


@router.post("/places/resolve", response_model=ResolveResponse, summary="Airports/ports named in the texts")
async def resolve_places(payload: ResolveRequest) -> ResolveResponse:
    items: list[ResolveItem] = []
    for q in payload.items:
        try:
            hit = catalogue.resolve(payload.kind, q.text, q.country)
        except catalogue.AmbiguousTerminal as exc:
            items.append(ResolveItem(error=str(exc)))
            continue
        items.append(ResolveItem(match=_out(hit) if hit else None))
    return ResolveResponse(items=items, source=_source(payload.kind))


class SuggestResponse(BaseModel):
    items: list[TerminalOut]
    source: str


@router.get("/places/suggest", response_model=SuggestResponse, summary="Typeahead over airports/ports")
async def suggest_places(kind: PlaceKind, q: str, major_only: bool = False) -> SuggestResponse:
    hits = catalogue.suggest(kind, q[:200], major_only=major_only)
    return SuggestResponse(items=[_out(t) for t in hits], source=_source(kind))


class NearestRequest(BaseModel):
    kind: PlaceKind
    points: list[Point] = Field(min_length=1, max_length=40)


class NearestItem(BaseModel):
    terminal: TerminalOut
    #: Great-circle distance from the point to the terminal.
    km: float
    #: The point lies ON this catalogue entry (any entry, major or not): it is the terminal itself.
    at: TerminalOut | None = None


class NearestResponse(BaseModel):
    items: list[NearestItem]
    source: str


@router.post("/places/nearest", response_model=NearestResponse, summary="Nearest major airport/port per point")
async def nearest_places(payload: NearestRequest) -> NearestResponse:
    items = []
    for p in payload.points:
        hit = catalogue.nearest(payload.kind, p.lat, p.lon)
        assert hit is not None  # both catalogues have major entries
        on = catalogue.at_entry(payload.kind, p.lat, p.lon)
        items.append(NearestItem(terminal=_out(hit[0]), km=round(hit[1], 2), at=_out(on) if on else None))
    return NearestResponse(items=items, source=_source(payload.kind))
