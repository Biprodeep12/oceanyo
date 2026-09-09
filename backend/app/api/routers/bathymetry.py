"""Seabed heightmap for the block-mode mesh."""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query

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
    da = cfd.ds["elevation"]
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
