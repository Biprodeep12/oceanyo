"""Velocity field encoded for the GPU particle layer."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ...core.geometry import BBox
from ..datastore import DataStore, get_store
from ..services import raster

router = APIRouter(prefix="/api", tags=["currents"])


@router.get("/currents")
def currents(
    bbox: str | None = Query(None),
    depth: float = Query(0.0, description="depth level in metres"),
    time: str | None = Query(None),
    res: int = Query(256, ge=32, le=512),
    fmt: str = Query("png", pattern="^(png|meta)$"),
    store: DataStore = Depends(get_store),
):
    """u/v packed into the R and G channels, plus the min/max to decode them.

    `fmt=meta` returns just the JSON metadata, which the client fetches first so
    it can size the texture and set the decode uniforms before the image loads.
    """
    if store.model is None:
        raise HTTPException(status_code=503, detail="model dataset unavailable")
    cfd = store.model
    for needed in ("u", "v"):
        if needed not in cfd.canonical_vars():
            raise HTTPException(status_code=404, detail=f"{needed} not in this catalog")

    try:
        box = BBox.parse(bbox) if bbox else cfd.bbox()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    box = box.clamp_to(cfd.bbox())
    if box.is_empty():
        raise HTTPException(status_code=422, detail="bbox does not intersect the dataset")

    u, _ = cfd.select("u", bbox=box, time=time, depth=depth, max_shape=(1, res, res))
    v, _ = cfd.select("v", bbox=box, time=time, depth=depth, max_shape=(1, res, res))
    png, meta = raster.encode_uv_png(u[0], v[0])
    meta["bbox"] = box.as_list()
    meta["depth"] = float(depth)
    meta["time"] = str(cfd.nearest_time(time))

    if fmt == "meta":
        return meta

    headers = {"Cache-Control": "public, max-age=3600"}
    # Small enough to carry inline; saves the client a second round trip.
    for k, val in meta.items():
        if isinstance(val, (int, float)):
            headers[f"X-{k}"] = str(val)
    return Response(content=png, media_type="image/png", headers=headers)
