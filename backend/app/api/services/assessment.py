"""Regional assessment: where the observations are, and where the model is right.

Five of the Level 2 features in the spec are the same computation seen from
different angles -- observation coverage, blind-spot detection, model-accuracy
maps, the confidence layer and the data-freshness indicator all reduce to
"bin the observations onto a coarse grid and describe each bin". Computing them
separately would walk the profile index five times and, worse, let the five
layers disagree about which cell a float belongs to. So there is one pass.

Two choices worth defending:

  * **Freshness is measured against the dataset, not the wall clock.** A
    reanalysis subset that ends in 2024 is not "stale" because today is 2026;
    it is complete. Age is reported relative to the newest thing the catalog
    holds -- model or observation, whichever runs later -- so it reads as how
    far behind the frontier of the data a cell has fallen.

  * **A blind spot is ocean with no observation, not merely an empty cell.**
    Much of any Indian Ocean box is land or shelf. Calling those gaps in the
    observing network would make the layer noise; the bathymetry is already
    open, so the mask is free.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import numpy as np
import xarray as xr

from ...core.conventions import CANONICAL
from ...core.geometry import BBox
from .matchup import summarize

log = logging.getLogger(__name__)

#: Cell sizes we are willing to snap to, in degrees. A grid whose cells are
#: 0.3841 deg wide is unreadable in a legend and impossible to describe out
#: loud; these are the steps a chart axis would use.
NICE_STEPS = (0.1, 0.25, 0.5, 1.0, 2.0, 2.5, 5.0, 10.0)

#: Longest edge of the returned grid, in cells. Above this the polygons are
#: smaller than their own borders on screen and the payload stops being cheap.
TARGET_CELLS = 28


def choose_cell(box: BBox, grid_deg: float | None) -> float:
    """Pick a cell size for this box: readable, and never finer than the model.

    A cell smaller than the model grid cannot say anything new about model
    accuracy -- every profile in it colocates to the same model cell -- so it
    would draw structure that is not there.
    """
    span = max(box.east - box.west, box.north - box.south)
    want = span / TARGET_CELLS
    if grid_deg:
        want = max(want, grid_deg)
    for step in NICE_STEPS:
        if step >= want:
            return step
    return NICE_STEPS[-1]


def _ocean_mask(store, lon_c: np.ndarray, lat_c: np.ndarray) -> np.ndarray | None:
    """True where the cell centre is below sea level, or None without bathymetry."""
    bathy = store.bathymetry
    if bathy is None:
        return None
    try:
        da = bathy.ds[store.bathymetry_var]
        # Pointwise ("vectorized") selection: the indexers must be DataArrays
        # sharing a dimension name, or xarray takes the outer product of the
        # two coordinate lists and builds an N x N grid instead of N points.
        sel = da.sel(
            {
                bathy.axes.lon: xr.DataArray(lon_c, dims="cell"),
                bathy.axes.lat: xr.DataArray(lat_c, dims="cell"),
            },
            method="nearest",
        )
        elev = np.asarray(sel.values, dtype=float)
    except Exception as exc:  # a bathymetry that does not cover the box
        log.info("ocean mask unavailable for this box: %s", exc)
        return None
    # GEBCO and ETOPO are both positive UP, negative below sea level.
    return np.isfinite(elev) & (elev < 0.0)


def _mean(vals: list[float]) -> float | None:
    return float(np.mean(vals)) if vals else None


def _pool_rmse(vals: list[float], weights: list[int]) -> float | None:
    """Pool per-profile RMSEs by level count -- an RMSE is the root of a mean,
    so it recombines through the sum of squares, not the mean of the roots."""
    if not vals:
        return None
    w = np.asarray(weights, dtype=float)
    v = np.asarray(vals, dtype=float)
    tot = float(w.sum())
    if tot <= 0:
        return float(np.sqrt(float(np.mean(v**2))))
    return float(np.sqrt(float((w * v**2).sum() / tot)))


#: Depth-band edges for the reference spread, in metres. Roughly the mixed
#: layer, the thermocline, and the deep ocean -- the field's variability
#: changes by an order of magnitude across them.
SPREAD_BANDS = (0.0, 50.0, 150.0, 400.0, 1000.0, 2000.0, 6000.0)


def _reference_spread(profiles, variable: str) -> float:
    """The scale an RMSE should be judged against, measured from the data.

    Pooling every sample in the water column into one standard deviation gives
    ~9.5 degC for temperature -- almost all of it the surface-to-abyss gradient,
    which no model is being asked to guess. Judged against that, every cell
    looks confident. What an error of 0.5 degC should be compared with is how
    much the field varies BETWEEN PLACES AT THE SAME DEPTH, so the spread is
    computed within depth bands and pooled across them.
    """
    by_band: list[list[float]] = [[] for _ in range(len(SPREAD_BANDS) - 1)]
    for p in profiles:
        pv = p.variables.get(variable)
        if pv is None:
            continue
        for d, v, q in zip(p.depth, pv.values, pv.qc):
            if v is None or q != 1 or d is None:
                continue
            for b in range(len(SPREAD_BANDS) - 1):
                if SPREAD_BANDS[b] <= d < SPREAD_BANDS[b + 1]:
                    by_band[b].append(float(v))
                    break

    var_sum = 0.0
    weight = 0.0
    for band in by_band:
        if len(band) < 8:
            continue
        var_sum += float(np.var(band)) * len(band)
        weight += len(band)
    if weight > 0:
        sigma = math.sqrt(var_sum / weight)
        if sigma > 1e-6:
            return round(sigma, 4)
    # No usable observations: fall back to a tenth of the variable's own valid
    # range, which is a scale rather than a measurement -- and the response
    # says so through `scored`, which will be zero.
    lo, hi = CANONICAL[variable].valid
    return (hi - lo) / 10.0


def assess(
    store,
    *,
    box: BBox,
    variable: str = "temperature",
    cell_deg: float | None = None,
    window_days: float | None = None,
    platform: str | None = None,
    limit: int = 3000,
) -> dict[str, Any]:
    """Bin observations onto a coarse grid and describe every cell.

    Returns GeoJSON so the map can render it directly, with a `summary` block
    that answers the questions a reviewer asks out loud: how much of this
    region is observed at all, and how far is the model from the floats that
    are there.
    """
    cfd = store.dataset_for(variable)
    grid_deg = None
    if cfd.lons.size > 1 and cfd.lats.size > 1:
        grid_deg = float(
            max(
                np.median(np.abs(np.diff(cfd.lons))),
                np.median(np.abs(np.diff(cfd.lats))),
            )
        )
    cell = cell_deg or choose_cell(box, grid_deg)

    # Snap the grid origin to a multiple of the cell size. Anchoring it on the
    # requested bbox instead would move every cell each time the user nudged a
    # corner, and the layer would appear to shimmer rather than to be a
    # property of the region.
    west = math.floor(box.west / cell) * cell
    south = math.floor(box.south / cell) * cell
    nx = max(1, int(math.ceil((box.east - west) / cell)))
    ny = max(1, int(math.ceil((box.north - south) / cell)))

    # --- freshness reference: the newest thing this catalog holds ---
    #
    # Not the wall clock: a reanalysis that ends in 2024 is complete, not two
    # years stale, and dating it against today would paint the whole map red.
    # Not the model's last step alone either -- the Argo record runs ahead of
    # the model here, so that reference produces negative ages. The frontier of
    # the data is the later of the two, and "age" then reads as how far behind
    # the newest available information a cell has fallen.
    times = cfd.time_strings()
    model_end = times[-1] if times else None
    obs_end = max((r.time for r in store.observation_refs(platform=platform)), default="")
    reference = max(filter(None, (model_end, obs_end)), default=None)
    ref_source = "observations" if reference == obs_end and obs_end else "model"
    ref_t = np.datetime64(reference[:19]) if reference else None

    t_lo = None
    if window_days is not None and ref_t is not None:
        t_lo = str(ref_t - np.timedelta64(int(window_days * 86400), "s"))

    refs = store.observation_refs(bbox=box, platform=platform, t0=t_lo)
    truncated = len(refs) > limit
    if truncated:
        # Stride, not a prefix.
        #
        # The index is in catalog order -- every glider, then every float, each
        # float's cycles consecutive -- so `refs[:limit]` is not a sample of the
        # region, it is whichever platforms were parsed first. Cutting 992
        # profiles to 800 that way dropped every profile that overlapped the
        # model's own year and took the accuracy layer from 56 scored cells to
        # 5, which looks exactly like a model with nothing to compare against.
        step = len(refs) / limit
        refs = [refs[int(i * step)] for i in range(limit)]

    profiles = []
    for r in refs:
        try:
            profiles.append(store.load_profile(r))
        except Exception:
            continue

    rows = summarize(cfd, profiles, variable=variable)

    # --- bin ---
    cells: dict[tuple[int, int], dict[str, Any]] = {}
    for row in rows:
        ix = int((row["lon"] - west) / cell)
        iy = int((row["lat"] - south) / cell)
        if not (0 <= ix < nx and 0 <= iy < ny):
            continue
        c = cells.setdefault(
            (ix, iy),
            {"count": 0, "platforms": set(), "last": "", "bias": [], "rmse": [], "n": []},
        )
        c["count"] += 1
        c["platforms"].add(row["platform"])
        if row["time"] > c["last"]:
            c["last"] = row["time"]
        if row["rmse"] is not None and row["n"]:
            c["bias"].append(row["bias"])
            c["rmse"].append(row["rmse"])
            c["n"].append(row["n"])

    sigma = _reference_spread(profiles, variable)

    # --- ocean mask over cell centres ---
    keys = [(ix, iy) for iy in range(ny) for ix in range(nx)]
    lon_c = np.array([west + (ix + 0.5) * cell for ix, _ in keys])
    lat_c = np.array([south + (iy + 0.5) * cell for _, iy in keys])
    ocean = _ocean_mask(store, lon_c, lat_c)

    features = []
    n_ocean = n_covered = n_blind = 0
    all_rmse: list[float] = []
    all_w: list[int] = []
    for i, (ix, iy) in enumerate(keys):
        c = cells.get((ix, iy))
        is_ocean = True if ocean is None else bool(ocean[i])
        count = int(c["count"]) if c else 0
        if is_ocean:
            n_ocean += 1
            if count:
                n_covered += 1
            else:
                n_blind += 1

        rmse = _pool_rmse(c["rmse"], c["n"]) if c else None
        bias = _mean(c["bias"]) if c else None
        n_lev = int(sum(c["n"])) if c else 0
        if rmse is not None:
            all_rmse.append(rmse)
            all_w.append(n_lev)

        # Confidence: how much evidence there is, times how well it agrees.
        # Both factors are in 0..1 and both are measured, so the layer never
        # asserts confidence the data has not earned.
        confidence = None
        if rmse is not None and c is not None:
            evidence = len(c["rmse"]) / (len(c["rmse"]) + 2.0)
            agreement = math.exp(-rmse / sigma)
            confidence = round(evidence * agreement, 4)

        age = None
        if c and c["last"] and ref_t is not None:
            try:
                age = round(
                    float((ref_t - np.datetime64(c["last"][:19])) / np.timedelta64(1, "D")),
                    2,
                )
            except Exception:
                age = None

        x0, y0 = west + ix * cell, south + iy * cell
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [x0, y0], [x0 + cell, y0], [x0 + cell, y0 + cell],
                    [x0, y0 + cell], [x0, y0],
                ]],
            },
            "properties": {
                "count": count,
                "platforms": sorted(c["platforms"]) if c else [],
                "lastTime": (c["last"] or None) if c else None,
                "ageDays": age,
                "bias": None if bias is None else round(bias, 4),
                "rmse": None if rmse is None else round(rmse, 4),
                "levels": n_lev,
                "confidence": confidence,
                "ocean": is_ocean,
                "blindSpot": bool(is_ocean and count == 0),
            },
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "summary": {
            "variable": variable,
            "units": CANONICAL[variable].units,
            "cellDeg": cell,
            "gridDeg": grid_deg,
            "bbox": [box.west, box.south, box.east, box.north],
            "cells": len(features),
            "oceanCells": n_ocean,
            "observedCells": n_covered,
            "blindSpots": n_blind,
            "coverage": round(n_covered / n_ocean, 4) if n_ocean else None,
            "profiles": len(rows),
            "scored": sum(1 for r in rows if r["rmse"] is not None),
            "truncated": truncated,
            "regionalRmse": _pool_rmse(all_rmse, all_w),
            "sigma": round(sigma, 4),
            "referenceTime": reference,
            "referenceSource": ref_source,
            "windowDays": window_days,
            "maskedByBathymetry": ocean is not None,
            "modelSource": cfd.source,
        },
    }
