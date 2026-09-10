"""XYZ raster tiles for map mode."""

from __future__ import annotations

import math

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ...core.conventions import CANONICAL
from ...core.geometry import BBox
from ..datastore import DataStore, get_store
from ..services import raster
from ..services.anomaly import anomaly_grid

router = APIRouter(tags=["tiles"])

TILE_SIZE = 256


def _tile_bounds(z: int, x: int, y: int) -> BBox:
    """Web Mercator XYZ tile -> geographic bounds."""
    n = 2.0**z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return BBox(west, south, east, north)


def _blank_tile() -> Response:
    png = raster.colormap_png(np.full((1, 1), np.nan), vmin=0, vmax=1, cmap="gray")
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def _to_pixels(
    plane: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    bounds: BBox,
    extent: BBox,
    z: int,
    y: int,
) -> np.ndarray:
    """Resample a lat/lon grid onto this tile's Mercator pixel grid.

    Nearest neighbour is right here: these are model cells, not a photograph,
    and at typical zooms one cell covers many pixels. Mercator rows are not
    linear in latitude, hence the arctan/sinh.
    """
    px_lon = np.linspace(bounds.west, bounds.east, TILE_SIZE)
    n = 2.0**z
    ys = np.linspace(y, y + 1, TILE_SIZE)
    px_lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * ys / n))))

    ix = np.searchsorted(lon, px_lon).clip(0, len(lon) - 1)
    iy = np.searchsorted(lat, px_lat).clip(0, len(lat) - 1)
    grid = plane[np.ix_(iy, ix)]

    # Blank any pixel outside the real data extent.
    outside_lon = ((px_lon < extent.west) | (px_lon > extent.east))[None, :]
    outside_lat = ((px_lat < extent.south) | (px_lat > extent.north))[:, None]
    return np.where(outside_lon | outside_lat, np.nan, grid)


@router.get("/tiles/{variable}/{time}/{depth}/{z}/{x}/{y}.png")
def tile(
    variable: str, time: str, depth: float, z: int, x: int, y: int,
    vmin: float | None = Query(None, description="colour range low; defaults to the variable range"),
    vmax: float | None = Query(None, description="colour range high"),
    log: bool | None = Query(None, description="log scale; defaults to the variable default"),
    cmap: str | None = Query(None, description="colormap name override"),
    store: DataStore = Depends(get_store),
) -> Response:
    """One 256x256 map tile.

    `time` accepts the literal string "latest" so a URL template can omit real
    timestamps while the user is only panning around.
    """
    try:
        cfd = store.dataset_for(variable)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    bounds = _tile_bounds(z, x, y)
    extent = cfd.bbox()
    clipped = bounds.clamp_to(extent)
    if clipped.is_empty():
        return _blank_tile()

    when = None if time in ("latest", "-", "") else time
    values, coords = cfd.select(variable, bbox=clipped, time=when, depth=depth)
    plane = values[0]
    if plane.size == 0:
        return _blank_tile()

    cv = CANONICAL[variable]
    grid = _to_pixels(
        plane,
        np.asarray(coords["lat"], dtype=float),
        np.asarray(coords["lon"], dtype=float),
        bounds, extent, z, y,
    )

    png = raster.colormap_png(
        grid,
        vmin=(cfd.data_range(variable)[0] if vmin is None else vmin),
        vmax=(cfd.data_range(variable)[1] if vmax is None else vmax),
        cmap=cmap or cv.cmap,
        log=cv.log if log is None else log,
        flip_y=False,  # px_lat already runs north -> south
    )
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/tiles/anomaly/{variable}/{time}/{depth}/{z}/{x}/{y}.png")
def anomaly_tile(
    variable: str, time: str, depth: float, z: int, x: int, y: int,
    field: str = Query("z", pattern="^(z|diff)$",
                       description="z-score against climatology, or the raw difference"),
    limit: float = Query(3.0, gt=0,
                         description="colour saturates at +/- this many standard deviations"),
    cmap: str | None = Query(None, description="colormap name override"),
    store: DataStore = Depends(get_store),
) -> Response:
    """Anomaly against climatology as a map tile.

    A separate route rather than a flag on `/tiles`, because an anomaly needs a
    different colour treatment to be readable: a DIVERGING map centred on zero,
    with a symmetric range. Reusing the variable's own sequential colormap here
    would put zero at an arbitrary colour and make the sign impossible to read.
    """
    if store.climatology is None:
        raise HTTPException(status_code=404, detail="no climatology in this catalog")
    try:
        cfd = store.dataset_for(variable)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    bounds = _tile_bounds(z, x, y)
    extent = cfd.bbox()
    clipped = bounds.clamp_to(extent)
    if clipped.is_empty():
        return _blank_tile()

    when = None if time in ("latest", "-", "") else time
    try:
        g = anomaly_grid(
            cfd, store.climatology, variable=variable,
            bbox=clipped, time=when, depth=depth,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    plane = g.z if field == "z" else g.diff
    if plane.size == 0:
        return _blank_tile()

    grid = _to_pixels(plane, g.lat, g.lon, bounds, extent, z, y)
    png = raster.colormap_png(
        grid,
        vmin=-limit, vmax=limit,
        cmap=cmap or "delta",
        log=False,
        flip_y=False,
    )
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )
