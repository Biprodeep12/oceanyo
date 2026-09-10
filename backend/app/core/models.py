"""The internal standardized data model (spec section 3).

These shapes are the contract with the frontend. `web/src/lib/api/types.ts`
mirrors them field for field.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Platform = str  # extensible via the parser registry; not a closed enum


class GriddedField(BaseModel):
    """Metadata describing one gridded model variable."""

    variable: str  # canonical key: temperature|salinity|u|v|chlorophyll
    standardName: str
    units: str
    lat: list[float]
    lon: list[float]
    depth: list[float]  # metres, positive DOWN
    time: list[str]  # ISO 8601 UTC
    shape: tuple[int, int, int, int]  # [time, depth, lat, lon]
    fillValue: float | None = None
    source: str
    synthetic: bool = False


class VariableSummary(BaseModel):
    """One row of GET /api/variables."""

    variable: str
    standardName: str
    units: str
    longName: str
    depthRange: tuple[float, float]
    timeRange: tuple[str, str]
    validRange: tuple[float, float]
    colormap: str
    log: bool = False


class ProfileVariable(BaseModel):
    units: str
    values: list[float | None]
    qc: list[int]


class ObservationProfile(BaseModel):
    """One in-situ profile, from any platform."""

    platform: Platform  # "argo" | "glider" | "ctd" | "mooring" | ...
    id: str
    lat: float
    lon: float
    time: str  # ISO 8601 UTC
    depth: list[float]  # metres, positive down
    variables: dict[str, ProfileVariable]  # aligned index-for-index with depth
    trajectory: list[dict] | None = None  # gliders: [{lat, lon, time}, ...]
    dataMode: Literal["R", "A", "D"] = "R"
    source: str = ""


class VolumeHeader(BaseModel):
    """JSON header of the binary /api/volume response.

    Wire format is a single length-prefixed body:
        [uint32 LE headerLen][utf8 JSON VolumeHeader][raw volume bytes]

    Raw value 0 is RESERVED for fill/land. Valid data occupies 1..(2^bits-1),
    which lets the shader discard `texel == 0.0` with no separate mask texture.
    """

    dtype: Literal["uint8", "uint16"]
    scale: float
    offset: float
    fillRaw: int = 0
    dims: tuple[int, int, int]  # [depth, lat, lon] -- depth-major, end to end
    bbox: tuple[float, float, float, float]
    depthRange: tuple[float, float]
    depths: list[float]
    resolution: Literal["coarse", "full"]
    variable: str
    time: str
    vmin: float  # dataset-wide, NOT per-subset (prevents colour flicker)
    vmax: float


class MatchupResult(BaseModel):
    """GET /api/matchup — the scientific differentiator."""

    platform: str
    id: str
    variable: str
    obsDepths: list[float]
    obsValues: list[float]
    modelValues: list[float | None]
    bias: float | None
    rmse: float | None
    mae: float | None
    corr: float | None
    n: int
    stdObs: float | None = None
    stdModel: float | None = None
    crmse: float | None = None
    radiusKm: float
    windowHours: float
    qcFlagsUsed: list[int]
    modelSource: str
    obsDataMode: str


class ParserCapabilities(BaseModel):
    """What a registered observation parser can supply.

    Surfaced at GET /api/platforms so the plugin architecture is demonstrable
    rather than merely claimed.
    """

    platform: str
    variables: list[str]
    depthRange: tuple[float, float]
    hasTrajectory: bool
    qcScheme: Literal["argo", "none"]
    dataModes: list[str]
    description: str = ""


class HealthResponse(BaseModel):
    status: str = "ok"
    catalogId: str
    synthetic: bool
    source: str
    variables: list[str]
    platforms: list[str]
    standards: dict[str, bool] = Field(default_factory=dict)
    #: Whether the natural-language layer can reach a model. False is normal:
    #: the palette resolves phrases locally either way, so this only tells the
    #: UI whether to offer the model for what the lookup table could not parse.
    nlq: bool = False
    #: canonical variables a climatology anomaly can be computed for; empty
    #: when the catalog carries no climatology at all.
    climatology: list[str] = Field(default_factory=list)
