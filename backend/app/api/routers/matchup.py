"""Model-observation comparison -- the scientific differentiator."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ...core.geometry import BBox
from ...core.models import MatchupResult
from ..datastore import DataStore, get_store
from ..services.matchup import QC_DISPLAY, QC_QUANTITATIVE, compute_matchup, summarize

router = APIRouter(prefix="/api", tags=["matchup"])


@router.get("/matchup", response_model=MatchupResult)
def matchup(
    platform: str = Query(...),
    id: str = Query(..., description="profile id"),
    var: str = Query("temperature"),
    radius: float = Query(25.0, gt=0, le=500, description="colocation radius in km"),
    window: float = Query(24.0, gt=0, le=720, description="time window in hours"),
    qc: str = Query("strict", pattern="^(strict|display)$"),
    store: DataStore = Depends(get_store),
) -> MatchupResult:
    ref = store.find_ref(platform, id)
    if ref is None:
        raise HTTPException(status_code=404, detail=f"no {platform} profile {id!r}")

    try:
        cfd = store.dataset_for(var)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    profile = store.load_profile(ref)
    flags = QC_QUANTITATIVE if qc == "strict" else QC_DISPLAY
    try:
        return compute_matchup(
            cfd, profile, variable=var,
            radius_km=radius, window_hours=window, qc_flags=flags,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/matchup/summary")
def matchup_summary(
    bbox: str | None = Query(None),
    platform: str | None = Query(None),
    var: str = Query("temperature"),
    radius: float = Query(25.0, gt=0, le=500),
    window: float = Query(24.0, gt=0, le=720),
    limit: int = Query(120, ge=1, le=1000),
    store: DataStore = Depends(get_store),
):
    """Per-profile error across a region.

    Drives the colour-encoding of instrument markers in block mode: colour is
    the model-observation error, so it carries information rather than
    decorating the scene.
    """
    try:
        box = BBox.parse(bbox) if bbox else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        cfd = store.dataset_for(var)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    refs = store.observation_refs(bbox=box, platform=platform)[:limit]
    profiles = []
    for r in refs:
        try:
            profiles.append(store.load_profile(r))
        except Exception:
            continue

    rows = summarize(cfd, profiles, variable=var, radius_km=radius, window_hours=window)
    scored = [r for r in rows if r["rmse"] is not None]
    return {
        "variable": var,
        "count": len(rows),
        "scored": len(scored),
        "modelSource": cfd.source,
        "results": rows,
    }
