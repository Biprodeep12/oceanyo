"""Vertical cross-section along a two-point track.

A section answers a different question from the volume: not "what does this
water mass look like" but "what happens between here and there". It is the
conventional way an oceanographer reads a transect, and it is the one view
where the vertical structure -- thermocline, freshwater cap, eddy core -- can
be measured rather than admired.

Two deliberate choices:

1. The track is a straight line in longitude/latitude, not a great circle.
   Over the few hundred kilometres a selection spans, at the latitudes this
   platform covers, the two differ by less than the model grid spacing. The
   reported distances are still true great-circle distances between the
   sampled points, so the horizontal axis is in real kilometres.

2. Values are sampled at the model's own depth levels, not on an evenly spaced
   depth axis. The upper ocean is resolved far more finely than the abyss, and
   re-gridding to even spacing would throw that away exactly where the
   interesting structure is. The client places each level using the same
   index-space mapping the volume uses, so the curtain lands inside the block
   without any tuning.
"""

from __future__ import annotations

import numpy as np

from ...core.cf_adapter import CFDataset
from ...core.conventions import CANONICAL
from ...core.geometry import DepthRange

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lon0: float, lat0: float, lon1: float, lat1: float) -> float:
    """Great-circle distance between two points, in kilometres."""
    p0, p1 = np.radians(lat0), np.radians(lat1)
    dp = p1 - p0
    dl = np.radians(lon1 - lon0)
    a = np.sin(dp / 2) ** 2 + np.cos(p0) * np.cos(p1) * np.sin(dl / 2) ** 2
    return float(2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(a)))


def track(
    p0: tuple[float, float], p1: tuple[float, float], samples: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Evenly spaced points from p0 to p1, plus cumulative distance in km."""
    t = np.linspace(0.0, 1.0, samples)
    lons = p0[0] + (p1[0] - p0[0]) * t
    lats = p0[1] + (p1[1] - p0[1]) * t
    total = haversine_km(p0[0], p0[1], p1[0], p1[1])
    return lons, lats, t * total


def _seabed_along(bathymetry: CFDataset, lons: np.ndarray, lats: np.ndarray) -> list[float] | None:
    """Seabed depth (positive down) under each track point, or None."""
    if bathymetry is None or "elevation" not in bathymetry.ds:
        return None
    try:
        import xarray as xr

        ax = bathymetry.axes
        da = bathymetry.ds["elevation"].sortby([c for c in (ax.lat, ax.lon) if c in bathymetry.ds["elevation"].coords])
        sampled = da.interp(
            {
                ax.lon: xr.DataArray(lons, dims="s"),
                ax.lat: xr.DataArray(lats, dims="s"),
            },
            method="linear",
        )
        elev = np.asarray(sampled.values, dtype=float)
        return [None if not np.isfinite(v) else float(-v) for v in elev]
    except Exception:
        # The seabed line is context, not the section itself; never fail on it.
        return None


def extract_section(
    cfd: CFDataset,
    *,
    variable: str,
    p0: tuple[float, float],
    p1: tuple[float, float],
    time: str | None,
    depth_range: DepthRange,
    samples: int = 192,
    max_levels: int | None = None,
    bathymetry: CFDataset | None = None,
) -> dict:
    """Sample `variable` on the vertical plane between two points."""
    if haversine_km(p0[0], p0[1], p1[0], p1[1]) < 1.0:
        raise ValueError("the two section endpoints are the same place")

    lons, lats, dist = track(p0, p1, samples)
    values, depths = cfd.sample_track(
        variable, lons, lats, time=time, depth_range=depth_range, max_levels=max_levels
    )

    cv = CANONICAL[variable]
    finite = np.isfinite(values)
    snapped = cfd.nearest_time(time)

    return {
        "variable": variable,
        "units": cv.units,
        "p0": [float(p0[0]), float(p0[1])],
        "p1": [float(p1[0]), float(p1[1])],
        "lengthKm": float(dist[-1]),
        "time": str(snapped) if snapped is not None else "",
        "shape": [int(values.shape[0]), int(values.shape[1])],
        "distanceKm": [float(d) for d in dist],
        "lon": [float(v) for v in lons],
        "lat": [float(v) for v in lats],
        "depths": [float(d) for d in depths],
        "seabed": _seabed_along(bathymetry, lons, lats) if bathymetry is not None else None,
        # Colour limits are the DATASET-wide range, matching the volume, so the
        # curtain and the block are on the same scale by construction.
        "vmin": float(cv.valid[0]),
        "vmax": float(cv.valid[1]),
        "dataRange": (
            [float(np.nanmin(values[finite])), float(np.nanmax(values[finite]))]
            if finite.any()
            else [0.0, 0.0]
        ),
        "coverage": float(finite.mean()),
        "values": [
            [None if not np.isfinite(v) else float(v) for v in row] for row in values
        ],
    }


def section_array(
    cfd: CFDataset,
    *,
    variable: str,
    p0: tuple[float, float],
    p1: tuple[float, float],
    time: str | None,
    depth_range: DepthRange,
    samples: int = 192,
    max_levels: int | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """(values, depths) only -- the PNG path does not need the JSON envelope."""
    if haversine_km(p0[0], p0[1], p1[0], p1[1]) < 1.0:
        raise ValueError("the two section endpoints are the same place")
    lons, lats, _ = track(p0, p1, samples)
    return cfd.sample_track(
        variable, lons, lats, time=time, depth_range=depth_range, max_levels=max_levels
    )
