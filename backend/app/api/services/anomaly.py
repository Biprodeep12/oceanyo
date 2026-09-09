"""Anomaly against climatology, expressed as a z-score.

Deliberately not a plain outlier detector. Comparing a value against the local
long-term mean and standard deviation separates a genuine anomaly from the
ordinary seasonal cycle; a naive detector conflates the two and flags every
summer as unusual.

The climatology carries `<raw>_mean` and `<raw>_std` on the same grid as the
model, so this is a straight cell-wise comparison with no regridding.
"""

from __future__ import annotations

import numpy as np

from ...core.cf_adapter import CFDataset
from ...core.conventions import CANONICAL
from ...core.geometry import BBox


def compute_anomaly(
    model: CFDataset,
    climatology: CFDataset,
    *,
    variable: str,
    bbox: BBox,
    time: str | None,
    depth: float,
) -> dict:
    raw = model.raw_name(variable)
    mean_name, std_name = f"{raw}_mean", f"{raw}_std"
    if mean_name not in climatology.ds:
        raise KeyError(
            f"climatology has no {mean_name!r}; available: {list(climatology.ds.data_vars)}"
        )

    values, coords = model.select(variable, bbox=bbox, time=time, depth=depth)
    plane = values[0]

    ax = climatology.axes
    sel = {ax.lon: slice(bbox.west, bbox.east), ax.lat: slice(bbox.south, bbox.north)}
    clim_mean = climatology.ds[mean_name].sel(sel).sel({ax.depth: depth}, method="nearest")
    clim_std = climatology.ds[std_name].sel(sel).sel({ax.depth: depth}, method="nearest")

    mean = np.asarray(clim_mean.values, dtype=np.float64)
    std = np.asarray(clim_std.values, dtype=np.float64)

    if mean.shape != plane.shape:
        raise KeyError(
            f"climatology grid {mean.shape} does not match model grid {plane.shape}"
        )

    with np.errstate(invalid="ignore", divide="ignore"):
        diff = plane.astype(np.float64) - mean
        # A near-zero climatological spread makes the z-score meaningless
        # rather than infinite; mask those cells instead of emitting huge values.
        z = np.where(std > 1e-6, diff / std, np.nan)

    cv = CANONICAL[variable]
    finite = np.isfinite(z)
    return {
        "variable": variable,
        "units": cv.units,
        "depth": float(coords["depth"][0]),
        "time": str(model.nearest_time(time)),
        "lat": [float(v) for v in coords["lat"]],
        "lon": [float(v) for v in coords["lon"]],
        "shape": list(z.shape),
        "zRange": [float(np.nanmin(z)), float(np.nanmax(z))] if finite.any() else [0.0, 0.0],
        "anomaly": [[None if not np.isfinite(v) else float(v) for v in row] for row in diff],
        "zscore": [[None if not np.isfinite(v) else float(v) for v in row] for row in z],
    }
