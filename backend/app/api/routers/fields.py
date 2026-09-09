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
from ..services.section import extract_section, section_array

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["fields"])


@router.get("/slice")
def slice_field(
    fmt: str = Query("json", pattern="^(json|png)$"),
    res: int | None = Query(
        None, ge=8, le=2048,
        description="cap the returned grid to res x res cells (decimated, not interpolated)",
    ),
    vmin: float | None = Query(None),
    vmax: float | None = Query(None),
    log: bool | None = Query(None),
    cmap: str | None = Query(None),
    q: FieldQuery = Depends(field_query),
    store: DataStore = Depends(get_store),
):
    """One depth level as a JSON grid or a colour-mapped PNG."""
    cfd = store.dataset_for(q.variable)
    depth = q.depth if q.depth is not None else q.depth_range.top
    values, coords = cfd.select(
        q.variable, bbox=q.bbox, time=q.time, depth=depth,
        max_shape=(1, res, res) if res else None,
    )
    plane = values[0]
    cv = CANONICAL[q.variable]

    if fmt == "png":
        png = raster.colormap_png(
            plane,
            vmin=cv.valid[0] if vmin is None else vmin,
            vmax=cv.valid[1] if vmax is None else vmax,
            cmap=cmap or cv.cmap,
            log=cv.log if log is None else log,
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
    res: str = Query("full", pattern="^(coarse|full)$",
                     description="match the /volume resolution this surface is drawn inside"),
    q: FieldQuery = Depends(field_query),
    store: DataStore = Depends(get_store),
) -> Response:
    """Server-side marching cubes, returned as a binary glTF mesh."""
    cfd = store.dataset_for(q.variable)
    try:
        glb = extract_isosurface(
            cfd, variable=q.variable, level=level, time=q.time,
            bbox=q.bbox, depth_range=q.depth_range,
            max_shape=volume.RESOLUTIONS[res],
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=glb,
        media_type="model/gltf-binary",
        headers={"Cache-Control": "public, max-age=3600",
                 "ETag": f'W/"{q.cache_key("iso", level, res)}"'},
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


def _point(raw: str, name: str) -> tuple[float, float]:
    try:
        lon, lat = (float(v) for v in raw.split(","))
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail=f"{name} must be 'lon,lat'; got {raw!r}"
        ) from exc
    return lon, lat


@router.get("/section")
def section(
    p0: str = Query(..., description="lon,lat of the first endpoint"),
    p1: str = Query(..., description="lon,lat of the second endpoint"),
    samples: int = Query(192, ge=8, le=512, description="points along the track"),
    maxLevels: int | None = Query(None, ge=2, le=200),
    fmt: str = Query("json", pattern="^(json|png)$"),
    vmin: float | None = Query(None),
    vmax: float | None = Query(None),
    log: bool | None = Query(None),
    cmap: str | None = Query(None),
    q: FieldQuery = Depends(field_query),
    store: DataStore = Depends(get_store),
):
    """Vertical cross-section between two points.

    `fmt=png` returns the section as an image whose rows are the model's own
    depth levels, shallowest first. That is what the 3D curtain samples: the
    client places each level by index, so the image and the geometry share a
    vertical axis and no resampling to even depth spacing is needed anywhere.
    """
    cfd = store.dataset_for(q.variable)
    a, b = _point(p0, "p0"), _point(p1, "p1")

    if fmt == "png":
        cv = CANONICAL[q.variable]
        try:
            values, _ = section_array(
                cfd, variable=q.variable, p0=a, p1=b, time=q.time,
                depth_range=q.depth_range, samples=samples, max_levels=maxLevels,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        png = raster.colormap_png(
            values,
            vmin=cv.valid[0] if vmin is None else vmin,
            vmax=cv.valid[1] if vmax is None else vmax,
            cmap=cmap or cv.cmap,
            log=cv.log if log is None else log,
            # Row 0 is the shallowest level and must stay the TOP image row.
            flip_y=False,
        )
        return Response(
            content=png,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=3600",
                "ETag": f'W/"{q.cache_key("sec", p0, p1, samples)}"',
            },
        )

    try:
        return extract_section(
            cfd, variable=q.variable, p0=a, p1=b, time=q.time,
            depth_range=q.depth_range, samples=samples, max_levels=maxLevels,
            bathymetry=store.bathymetry,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
