"""Queries over the observing network itself, rather than over one profile.

This is `query_floats` from spec section 5.2, and it is a REST endpoint rather
than something the language layer answers, deliberately. The point of that
section is that the model emits a structured call and *the platform computes
the result* -- "which floats disagree most with the model this month" has to be
measured against the index, not generated. Keeping it here means the same
question is available from the command palette, from curl, and from any future
language layer, and all three get the identical answer.

An instrument is a float or a glider; a profile is one of its casts. The
observation index is keyed on profiles (`<instrument>:<cycle>`), so everything
below groups on the part before the colon.
"""

from __future__ import annotations

import math
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ...core.geometry import BBox
from ..datastore import DataStore, get_store
from ..services.matchup import summarize

router = APIRouter(prefix="/api", tags=["observations"])

EARTH_RADIUS_KM = 6371.0

SORT_KEYS = ("trajectory_length", "model_error", "recency", "profile_count")


def _haversine(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


@router.get("/instruments")
def instruments(
    sortBy: str = Query("profile_count", pattern="^(trajectory_length|model_error|recency|profile_count)$"),
    order: str = Query("desc", pattern="^(desc|asc)$"),
    limit: int = Query(10, ge=1, le=200),
    platform: str | None = Query(None),
    bbox: str | None = Query(None),
    var: str = Query("temperature"),
    store: DataStore = Depends(get_store),
):
    """Rank instruments by how far they travelled, how wrong the model is, or how recent they are.

    `model_error` is the one that costs anything: it has to match every cycle
    of every candidate against the model, so it is computed only when it is
    what was asked for.
    """
    try:
        box = BBox.parse(bbox) if bbox else None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    refs = store.observation_refs(bbox=box, platform=platform)
    groups: dict[str, list] = {}
    for r in refs:
        groups.setdefault(r.id.split(":", 1)[0], []).append(r)

    rows: list[dict[str, Any]] = []
    for name, items in groups.items():
        items.sort(key=lambda r: r.time)
        km = sum(
            _haversine(a.lon, a.lat, b.lon, b.lat)
            for a, b in zip(items, items[1:])
        )
        last = items[-1]
        rows.append({
            "instrument": name,
            "platform": items[0].platform,
            "profiles": len(items),
            "trajectoryKm": round(km, 1),
            "first": items[0].time,
            "last": last.time,
            "lon": last.lon,
            "lat": last.lat,
            "dataMode": last.data_mode,
            "meanAbsBias": None,
            "rmse": None,
            "matched": 0,
            # Enough to open the profile viewer without a second lookup.
            "lastProfileId": last.id,
        })

    if sortBy == "model_error":
        try:
            cfd = store.dataset_for(var)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        # Only the instruments that could plausibly rank: matching every cycle
        # of every float in a basin is minutes of work to answer a question
        # about the worst ten.
        by_name = {r["instrument"]: r for r in rows}
        candidates = sorted(rows, key=lambda r: r["profiles"], reverse=True)[: 60]
        for row in candidates:
            profiles = []
            for ref in groups[row["instrument"]]:
                try:
                    profiles.append(store.load_profile(ref))
                except Exception:
                    continue
            scored = [
                s for s in summarize(cfd, profiles, variable=var)
                if s["rmse"] is not None
            ]
            if not scored:
                continue
            n = sum(s["n"] for s in scored) or 1
            by_name[row["instrument"]].update(
                meanAbsBias=round(
                    sum(abs(s["bias"]) * s["n"] for s in scored) / n, 4
                ),
                rmse=round(
                    math.sqrt(sum((s["rmse"] ** 2) * s["n"] for s in scored) / n), 4
                ),
                matched=len(scored),
            )
        rows = [r for r in rows if r["rmse"] is not None]

    keyfn = {
        "trajectory_length": lambda r: r["trajectoryKm"],
        "model_error": lambda r: r["rmse"] or 0.0,
        "recency": lambda r: r["last"],
        "profile_count": lambda r: r["profiles"],
    }[sortBy]
    rows.sort(key=keyfn, reverse=(order == "desc"))

    return {
        "sortBy": sortBy,
        "order": order,
        "variable": var if sortBy == "model_error" else None,
        "instruments": len(groups),
        "results": rows[:limit],
    }
