"""Shared request plumbing.

`field_query` validates and *snaps* every spatial request in one place: clamp
the bbox to what the catalog actually covers, snap time to the nearest
available step, clamp the depth range to available levels. Every field endpoint
depends on it, so validation, error shape and cache keys are written once
instead of six times.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Query

from ..core.geometry import BBox, DepthRange
from .datastore import DataStore, get_store


@dataclass(frozen=True)
class FieldQuery:
    variable: str
    bbox: BBox
    depth_range: DepthRange
    time: str | None
    depth: float | None

    def cache_key(self, *extra: object) -> str:
        parts = [
            self.variable,
            ",".join(f"{v:.4f}" for v in self.bbox.as_list()),
            ",".join(f"{v:.2f}" for v in self.depth_range.as_list()),
            str(self.time),
            str(self.depth),
            *[str(e) for e in extra],
        ]
        return hashlib.sha1("|".join(parts).encode()).hexdigest()[:20]


def field_query(
    var: str = Query(..., description="canonical variable key"),
    bbox: str | None = Query(None, description="w,s,e,n in degrees"),
    depthRange: str | None = Query(None, description="top,bottom in metres"),
    time: str | None = Query(None, description="ISO 8601; snapped to nearest step"),
    depth: float | None = Query(None, description="single depth in metres"),
    store: DataStore = Depends(get_store),
) -> FieldQuery:
    try:
        cfd = store.dataset_for(var)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        box = BBox.parse(bbox) if bbox else cfd.bbox()
        dr = DepthRange.parse(depthRange) if depthRange else cfd.depth_range()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    box = box.clamp_to(cfd.bbox())
    if box.is_empty():
        raise HTTPException(
            status_code=422,
            detail=f"bbox does not intersect the dataset extent {cfd.bbox().as_list()}",
        )
    dr = dr.clamp_to(cfd.depth_range())

    return FieldQuery(variable=var, bbox=box, depth_range=dr, time=time, depth=depth)
