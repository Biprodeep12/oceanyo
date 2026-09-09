"""Observation discovery and profile retrieval."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ...core.geometry import BBox
from ...core.models import ObservationProfile
from ..datastore import DataStore, get_store

router = APIRouter(prefix="/api", tags=["observations"])


@router.get("/observations")
def observations(
    bbox: str | None = Query(None, description="w,s,e,n"),
    platform: str | None = Query(None),
    t0: str | None = Query(None, description="ISO 8601 start"),
    t1: str | None = Query(None, description="ISO 8601 end"),
    limit: int = Query(2000, ge=1, le=20000),
    store: DataStore = Depends(get_store),
):
    """GeoJSON FeatureCollection of profile positions.

    Deliberately lightweight: this loads no profile data, only the index built
    at startup, so it can be fetched last without gating the block transition.
    """
    try:
        box = BBox.parse(bbox) if bbox else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    refs = store.observation_refs(bbox=box, platform=platform, t0=t0, t1=t1)[:limit]
    return {
        "type": "FeatureCollection",
        "count": len(refs),
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [r.lon, r.lat]},
                "properties": {
                    "platform": r.platform,
                    "id": r.id,
                    "time": r.time,
                    "dataMode": r.data_mode,
                },
            }
            for r in refs
        ],
    }


@router.get("/profile/{platform}/{profile_id:path}", response_model=ObservationProfile)
def profile(
    platform: str, profile_id: str, store: DataStore = Depends(get_store)
) -> ObservationProfile:
    ref = store.find_ref(platform, profile_id)
    if ref is None:
        raise HTTPException(
            status_code=404, detail=f"no {platform} profile with id {profile_id!r}"
        )
    return store.load_profile(ref)
