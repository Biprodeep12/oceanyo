"""Seabed heightmap for the block-mode mesh."""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query

from ...core.cf_adapter import snap_bbox_to_grid
from ...core.geometry import BBox
from ..datastore import DataStore, get_store

router = APIRouter(prefix="/api", tags=["terrain"])


@router.get("/bathymetry")
def bathymetry(
    bbox: str | None = Query(None, description="w,s,e,n"),
    res: int = Query(128, ge=16, le=512, description="max samples per axis"),
    store: DataStore = Depends(get_store),
):
    """Elevation grid for the seabed mesh.

    Stage 0 of the progressive reveal asks for res=64 (~16 KB), which renders
    the block frame and seabed before any water-column data has arrived.
    """
    if store.bathymetry is None:
        raise HTTPException(status_code=404, detail="no bathymetry in this catalog")

    cfd = store.bathymetry
    try:
        box = BBox.parse(bbox) if bbox else cfd.bbox()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    box = box.clamp_to(cfd.bbox())
    if box.is_empty():
        raise HTTPException(status_code=422, detail="bbox does not intersect the dataset")

    ax = cfd.axes
    da = cfd.ds[store.bathymetry_var]
    # Bathymetry slices by hand rather than through CFDataset.select, so it
    # needs the same guard: a box narrower than one cell selects nothing and
    # `lons[0]` raises. A drag emits exactly that on its first few frames.
    box = snap_bbox_to_grid(box, cfd.lons, cfd.lats)
    lon_sl = slice(box.west, box.east)
    lat_sl = slice(box.south, box.north)
    da = da.sel({ax.lon: lon_sl, ax.lat: lat_sl})

    for name in (ax.lat, ax.lon):
        vals = np.asarray(da[name].values, dtype=float)
        if vals.size > 1 and vals[0] > vals[-1]:
            da = da.isel({name: slice(None, None, -1)})

    steps = {}
    for name in (ax.lat, ax.lon):
        n = da.sizes[name]
        if n > res:
            steps[name] = slice(None, None, int(np.ceil(n / res)))
    if steps:
        da = da.isel(steps)

    elev = np.asarray(da.values, dtype=np.float32)
    lats = np.asarray(da[ax.lat].values, dtype=float)
    lons = np.asarray(da[ax.lon].values, dtype=float)

    return {
        "bbox": [float(lons[0]), float(lats[0]), float(lons[-1]), float(lats[-1])],
        "shape": [int(elev.shape[0]), int(elev.shape[1])],  # lat, lon
        "min": float(np.nanmin(elev)),
        "max": float(np.nanmax(elev)),
        "units": "m",
        "positive": "up",
        "note": "negative values are below sea level (GEBCO convention)",
        "elevation": [[float(v) for v in row] for row in elev],
    }


@router.get("/coastline")
def coastline(
    level: float = Query(0.0, description="elevation contour to trace, metres"),
    store: DataStore = Depends(get_store),
):
    """Coastline traced from the bathymetry, as GeoJSON.

    The map has no basemap by design -- a remote style that stalls leaves
    MapLibre permanently unloaded and renders nothing at all. But a data
    rectangle floating on a bare graticule is not a map, so the land outline is
    derived from the same elevation field the seabed mesh uses. It is therefore
    guaranteed consistent with the block, needs no network, and carries no
    third-party licence.

    With the synthetic catalog this outline is SYNTHETIC COASTLINE, not the
    real Indian coast, and it says so in the response and on the map. Drawing a
    made-up shoreline while implying it is India would be the exact kind of
    thing the provenance rules in this project exist to prevent.
    """
    if store.bathymetry is None:
        raise HTTPException(status_code=404, detail="no bathymetry in this catalog")

    from skimage import measure

    cfd = store.bathymetry
    ax = cfd.axes
    da = cfd.ds[store.bathymetry_var]
    for name in (ax.lat, ax.lon):
        vals = np.asarray(da[name].values, dtype=float)
        if vals.size > 1 and vals[0] > vals[-1]:
            da = da.isel({name: slice(None, None, -1)})

    elev = np.asarray(da.values, dtype=float)
    lats = np.asarray(da[ax.lat].values, dtype=float)
    lons = np.asarray(da[ax.lon].values, dtype=float)
    if elev.ndim != 2 or min(elev.shape) < 2:
        raise HTTPException(status_code=422, detail="bathymetry grid too small to contour")

    # Pad with deep water before contouring. Land that touches the edge of the
    # domain otherwise produces an OPEN contour, which is a line and cannot be
    # filled -- the coast would render as a stroke with no landmass behind it.
    # One ring of very negative cells makes every contour closed; the polygon
    # then runs one cell outside the data extent, which is also true: the land
    # does continue past the edge of the model domain.
    padded = np.pad(elev, 1, mode="constant", constant_values=-1.0e6)
    lat_idx = np.arange(-1, len(lats) + 1)
    lon_idx = np.arange(-1, len(lons) + 1)
    lat_pad = np.interp(lat_idx, np.arange(len(lats)), lats)
    lon_pad = np.interp(lon_idx, np.arange(len(lons)), lons)

    features = []
    for contour in measure.find_contours(padded, level):
        # find_contours returns (row, col) in index space; map back to degrees.
        rows, cols = contour[:, 0], contour[:, 1]
        lat = np.interp(rows, np.arange(len(lat_pad)), lat_pad)
        lon = np.interp(cols, np.arange(len(lon_pad)), lon_pad)
        coords = [[round(float(x), 5), round(float(y), 5)] for x, y in zip(lon, lat)]
        if len(coords) < 4:
            continue
        closed = (
            abs(coords[0][0] - coords[-1][0]) < 1e-6
            and abs(coords[0][1] - coords[-1][1]) < 1e-6
        )
        # A ring needs at least four positions with the first repeated last.
        if closed and len(coords) < 4:
            continue
        if closed:
            geometry = {"type": "Polygon", "coordinates": [coords]}
        else:
            geometry = {"type": "LineString", "coordinates": coords}
        features.append({"type": "Feature", "properties": {"level": level}, "geometry": geometry})

    return {
        "type": "FeatureCollection",
        "synthetic": store.catalog.synthetic,
        "source": store.catalog.source,
        "note": (
            "SYNTHETIC coastline traced from the synthetic bathymetry; not a real shoreline"
            if store.catalog.synthetic
            else f"coastline traced from {cfd.uri} at {level} m"
        ),
        "features": features,
    }
