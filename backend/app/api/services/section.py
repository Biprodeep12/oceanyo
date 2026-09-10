"""Vertical cross-section along an arbitrary track.

A section answers a different question from the volume: not "what does this
water mass look like" but "what happens between here and there". It is the
conventional way an oceanographer reads a transect, and it is the one view
where the vertical structure -- thermocline, freshwater cap, eddy core -- can
be measured rather than admired.

Two deliberate choices:

1. Each segment is a straight line in longitude/latitude, not a great circle.
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


Point = tuple[float, float]


def track(
    p0: Point, p1: Point, samples: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Evenly spaced points from p0 to p1, plus cumulative distance in km."""
    t = np.linspace(0.0, 1.0, samples)
    lons = p0[0] + (p1[0] - p0[0]) * t
    lats = p0[1] + (p1[1] - p0[1]) * t
    total = haversine_km(p0[0], p0[1], p1[0], p1[1])
    return lons, lats, t * total


def track_path(
    points: list[Point], samples: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[float]]:
    """Sample an N-point polyline at even spacing IN DISTANCE, not per segment.

    Splitting `samples` equally between the segments would be simpler and
    wrong: a 40 km dogleg at the end of a 900 km transect would then be drawn
    at twenty times the horizontal resolution of the rest, and the curtain
    would appear to change resolution partway across for no physical reason.
    Even spacing in distance keeps one horizontal scale across the whole
    section, which is what makes the x axis readable as kilometres.

    Returns the sampled lon/lat, the cumulative distance, and the distance at
    each vertex so the client can mark where the track turns.
    """
    if len(points) < 2:
        raise ValueError("a section needs at least two points")

    seg_km = [haversine_km(a[0], a[1], b[0], b[1]) for a, b in zip(points, points[1:])]
    total = float(sum(seg_km))
    if total < 1.0:
        raise ValueError("the section endpoints are the same place")

    vertex_km = [0.0]
    for d in seg_km:
        vertex_km.append(vertex_km[-1] + d)
    want = np.linspace(0.0, total, samples)

    lons = np.empty(samples)
    lats = np.empty(samples)
    for i, d in enumerate(want):
        # Which segment this distance falls in. The clamp guards the final
        # sample, which lands exactly on the last vertex.
        k = int(np.searchsorted(vertex_km, d, side="right")) - 1
        k = max(0, min(k, len(seg_km) - 1))
        span = seg_km[k]
        f = 0.0 if span <= 0 else (d - vertex_km[k]) / span
        a, b = points[k], points[k + 1]
        lons[i] = a[0] + (b[0] - a[0]) * f
        lats[i] = a[1] + (b[1] - a[1]) * f

    return lons, lats, want, vertex_km


def _seabed_along(
    bathymetry: CFDataset,
    lons: np.ndarray,
    lats: np.ndarray,
    variable: str = "elevation",
) -> list[float] | None:
    """Seabed depth (positive down) under each track point, or None.

    The variable name is passed in rather than assumed. Hardcoding "elevation"
    means only GEBCO works: ETOPO 2022 calls the same field "z", so against
    that catalogue the seabed line silently disappeared from every section and
    the curtain hung over nothing.
    """
    if bathymetry is None or variable not in bathymetry.ds:
        return None
    try:
        import xarray as xr

        ax = bathymetry.axes
        src = bathymetry.ds[variable]
        da = src.sortby([c for c in (ax.lat, ax.lon) if c in src.coords])
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
    path: list[Point],
    time: str | None,
    depth_range: DepthRange,
    samples: int = 192,
    max_levels: int | None = None,
    bathymetry: CFDataset | None = None,
    bathymetry_var: str = "elevation",
) -> dict:
    """Sample `variable` on the vertical surface following `path`.

    Two points is the common case and the one the block draws; more points let
    a transect follow a channel, a float track or a coastline rather than only
    the straight line between two clicks.
    """
    lons, lats, dist, vertex_km = track_path(path, samples)
    p0, p1 = path[0], path[-1]
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
        "path": [[float(x), float(y)] for x, y in path],
        "vertexKm": [float(v) for v in vertex_km],
        "lengthKm": float(dist[-1]),
        "time": str(snapped) if snapped is not None else "",
        "shape": [int(values.shape[0]), int(values.shape[1])],
        "distanceKm": [float(d) for d in dist],
        "lon": [float(v) for v in lons],
        "lat": [float(v) for v in lats],
        "depths": [float(d) for d in depths],
        "seabed": (
            _seabed_along(bathymetry, lons, lats, bathymetry_var)
            if bathymetry is not None
            else None
        ),
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
    path: list[Point],
    time: str | None,
    depth_range: DepthRange,
    samples: int = 192,
    max_levels: int | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """(values, depths) only -- the PNG path does not need the JSON envelope."""
    lons, lats, _, _ = track_path(path, samples)
    return cfd.sample_track(
        variable, lons, lats, time=time, depth_range=depth_range, max_levels=max_levels
    )
