"""Gridded field endpoints: slice, volume, timestep, isosurface, anomaly."""

from __future__ import annotations

import logging

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ...core.conventions import CANONICAL
from ..datastore import DataStore, get_store
from ..deps import FieldQuery, field_query
from ..services import raster, volume
from ..services.anomaly import compute_anomaly
from ..services.isosurface import extract_isosurface

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["fields"])


@router.get("/slice")
def slice_field(
    fmt: str = Query("json", pattern="^(json|png)$"),
    q: FieldQuery = Depends(field_query),
    store: DataStore = Depends(get_store),
):
    """One depth level as a JSON grid or a colour-mapped PNG."""
    cfd = store.dataset_for(q.variable)
    depth = q.depth if q.depth is not None else q.depth_range.top
    values, coords = cfd.select(q.variable, bbox=q.bbox, time=q.time, depth=depth)
    plane = values[0]
    cv = CANONICAL[q.variable]

    if fmt == "png":
        png = raster.colormap_png(
            plane, vmin=cv.valid[0], vmax=cv.valid[1], cmap=cv.cmap, log=cv.log
        )
        return Response(content=png, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=3600"})

    return {
        "variable": q.variable,
        "units": cv.units,
        "depth": float(coords["depth"][0]),
        "time": str(cfd.nearest_time(q.time)),
        "lat": [float(v) for v in coords["lat"]],
        "lon": [float(v) for v in coords["lon"]],
        "shape": list(plane.shape),
        "vmin": cv.valid[0],
        "vmax": cv.valid[1],
        # NaN is not valid JSON; None is.
        "values": [[None if not np.isfinite(v) else float(v) for v in row] for row in plane],
    }


@router.get("/volume")
def volume_endpoint(
    res: str = Query("coarse", pattern="^(coarse|full)$"),
    q: FieldQuery = Depends(field_query),
    store: DataStore = Depends(get_store),
) -> Response:
    """Quantized 3D volume as [uint32 headerLen][JSON header][raw bytes]."""
    cfd = store.dataset_for(q.variable)
    try:
        body = volume.build_volume(
            cfd,
            variable=q.variable,
            time=q.time,
            bbox=q.bbox,
            depth_range=q.depth_range,
            resolution=res,  # type: ignore[arg-type]
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "public, max-age=3600, immutable",
            "ETag": f'W/"{q.cache_key(res)}"',
        },
    )


@router.get("/timestep")
def timestep(
    q: FieldQuery = Depends(field_query),
    maxSteps: int = Query(60, ge=2, le=400),
    store: DataStore = Depends(get_store),
):
    """Decimated all-timesteps series at one depth, for timeline scrubbing.

    Returns a spatial mean per step plus the value range, which is enough to
    drive the scrubber without fetching every full grid up front.
    """
    cfd = store.dataset_for(q.variable)
    times = cfd.time_strings()
    if not times:
        raise HTTPException(status_code=404, detail="dataset has no time axis")

    stride = max(1, len(times) // maxSteps)
    picked = times[::stride]
    depth = q.depth if q.depth is not None else q.depth_range.top

    means, mins, maxs = [], [], []
    for t in picked:
        vals, _ = cfd.select(q.variable, bbox=q.bbox, time=t, depth=depth,
                             max_shape=(1, 64, 64))
        plane = vals[0]
        finite = np.isfinite(plane)
        if finite.any():
            means.append(float(np.nanmean(plane)))
            mins.append(float(np.nanmin(plane)))
            maxs.append(float(np.nanmax(plane)))
        else:
            means.append(None); mins.append(None); maxs.append(None)

    return {
        "variable": q.variable,
        "depth": float(depth),
        "times": picked,
        "mean": means,
        "min": mins,
        "max": maxs,
        "units": CANONICAL[q.variable].units,
    }


@router.get("/isosurface")
def isosurface(
    level: float = Query(..., description="iso value in the variable's units"),
    q: FieldQuery = Depends(field_query),
    store: DataStore = Depends(get_store),
) -> Response:
    """Server-side marching cubes, returned as a binary glTF mesh."""
    cfd = store.dataset_for(q.variable)
    try:
        glb = extract_isosurface(
            cfd, variable=q.variable, level=level, time=q.time,
            bbox=q.bbox, depth_range=q.depth_range,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=glb,
        media_type="model/gltf-binary",
        headers={"Cache-Control": "public, max-age=3600",
                 "ETag": f'W/"{q.cache_key("iso", level)}"'},
    )


@router.get("/anomaly")
def anomaly(
    q: FieldQuery = Depends(field_query),
    store: DataStore = Depends(get_store),
):
    """Z-score against the climatology, at one depth."""
    if store.climatology is None:
        raise HTTPException(status_code=404, detail="no climatology in this catalog")
    cfd = store.dataset_for(q.variable)
    depth = q.depth if q.depth is not None else q.depth_range.top
    try:
        return compute_anomaly(
            cfd, store.climatology, variable=q.variable,
            bbox=q.bbox, time=q.time, depth=depth,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
