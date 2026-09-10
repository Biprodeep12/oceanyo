"""Level 2 assessment layers, and the provenance record behind them.

`/api/coverage` is one endpoint serving five map layers, because they are one
computation -- see `services/assessment.py`. `/api/provenance` is what turns
the numbers those layers show into something a reviewer can check: every file
actually open in this process, with its own global attributes rather than a
description copied from a README.
"""

from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ...core.geometry import BBox
from ..datastore import DataStore, get_store
from ..obs.registry import REGISTRY
from ..services.assessment import assess

router = APIRouter(prefix="/api", tags=["assessment"])

# An assessment walks every profile in the box and matches each against the
# model, so it costs a second or two on a basin-wide request. The map refetches
# it whenever the variable or the window changes and users flip between those
# repeatedly, so the same handful of answers is asked for again and again.
_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
_CACHE_MAX = 24
_LOCK = threading.Lock()


@router.get("/coverage")
def coverage(
    bbox: str | None = Query(None, description="w,s,e,n; defaults to the whole domain"),
    var: str = Query("temperature"),
    cell: float | None = Query(
        None, gt=0.01, le=20, description="cell size in degrees; default derives from the grid"
    ),
    windowDays: float | None = Query(
        None, gt=0, description="only count observations this recent, relative to the model's last step"
    ),
    platform: str | None = Query(None),
    limit: int = Query(3000, ge=1, le=20000),
    store: DataStore = Depends(get_store),
):
    """Observation coverage, blind spots, model accuracy, confidence and freshness.

    One GeoJSON grid; the client picks which property to colour by. Splitting
    this into five endpoints would walk the profile index five times and let
    the layers disagree about which cell a float falls in.
    """
    try:
        cfd = store.dataset_for(var)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        box = BBox.parse(bbox).clamp_to(cfd.bbox()) if bbox else cfd.bbox()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if box.is_empty():
        raise HTTPException(
            status_code=422,
            detail=f"bbox does not intersect the dataset extent {cfd.bbox().as_list()}",
        )

    key = hashlib.sha1(
        "|".join(
            [
                store.catalog.id, var, str(cell), str(windowDays), str(platform), str(limit),
                ",".join(f"{v:.3f}" for v in box.as_list()),
            ]
        ).encode()
    ).hexdigest()[:20]
    with _LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit

    result = assess(
        store, box=box, variable=var, cell_deg=cell,
        window_days=windowDays, platform=platform, limit=limit,
    )
    with _LOCK:
        _CACHE[key] = result
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return result


#: Global attributes worth surfacing. Anything else in a NetCDF header is
#: either machine detail or a processing log too long for a panel.
_ATTRS = (
    "title", "institution", "source", "history", "references", "comment",
    "Conventions", "product", "experiment", "summary", "license", "creator_name",
)


def _describe(cfd, role: str, uri) -> dict[str, Any]:
    ds = cfd.ds
    times = cfd.time_strings()
    box = cfd.bbox()
    return {
        "role": role,
        "file": getattr(uri, "name", str(uri)),
        "path": str(uri),
        "variables": cfd.canonical_vars(),
        "rawVariables": sorted(str(v) for v in ds.data_vars),
        "shape": {str(k): int(v) for k, v in ds.sizes.items()},
        "bbox": box.as_list(),
        "timeRange": [times[0], times[-1]] if times else None,
        "steps": len(times),
        "stepHours": cfd.step_hours(),
        "attrs": {
            k: str(ds.attrs[k])[:400] for k in _ATTRS if k in ds.attrs
        },
    }


@router.get("/provenance")
def provenance(store: DataStore = Depends(get_store)):
    """Every dataset this process actually has open, from its own header.

    A provenance panel that reads a hand-written list is a claim; one that
    reads `ds.attrs` is a receipt. If the catalog is pointed at a different
    file tomorrow, this changes with it and cannot drift.
    """
    cat = store.catalog
    datasets = []
    for role, cfd, ref in (
        ("model", store.model, cat.model),
        ("bgc", store.bgc, cat.bgc),
        ("climatology", store.climatology, cat.climatology),
    ):
        if cfd is not None and ref is not None:
            datasets.append(_describe(cfd, role, ref.uri))

    if store.bathymetry is not None and cat.bathymetry is not None:
        ds = store.bathymetry.ds
        datasets.append({
            "role": "bathymetry",
            "file": cat.bathymetry.uri.name,
            "path": str(cat.bathymetry.uri),
            "variables": [store.bathymetry_var],
            "rawVariables": sorted(str(v) for v in ds.data_vars),
            "shape": {str(k): int(v) for k, v in ds.sizes.items()},
            "bbox": store.bathymetry.bbox().as_list(),
            "timeRange": None,
            "steps": 0,
            "stepHours": None,
            "attrs": {k: str(ds.attrs[k])[:400] for k in _ATTRS if k in ds.attrs},
        })

    counts: dict[str, int] = {}
    latest: dict[str, str] = {}
    for r in store.observation_refs():
        counts[r.platform] = counts.get(r.platform, 0) + 1
        if r.time > latest.get(r.platform, ""):
            latest[r.platform] = r.time

    return {
        "catalogId": cat.id,
        "source": cat.source,
        "synthetic": cat.synthetic,
        "catalogFile": str(cat.path),
        "datasets": datasets,
        "observations": [
            {
                "platform": src.platform,
                "parser": src.parser,
                "path": str(src.uri),
                "profiles": counts.get(src.platform, 0),
                "latest": latest.get(src.platform),
            }
            for src in cat.observations
        ],
        "parsers": [c.model_dump() for c in REGISTRY.capabilities()],
        # Stated in the payload, not only in the README, so that anything
        # exported from the UI carries it too.
        "disclaimer": (
            "Research and visualization tool. Not an operational forecast or "
            "warning system. Model-observation differences are diagnostic, not "
            "a statement of fitness for navigation or safety of life at sea."
        ),
    }
