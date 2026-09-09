"""Grid definitions for the synthetic ocean.

Axes are shaped to match GLORYS12V1 so that the synthetic dataset and a real
subset are interchangeable: same names, same order, same depth distribution.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class GridProfile:
    """One named generator configuration."""

    name: str
    west: float
    south: float
    east: float
    north: float
    resolution: float  # degrees
    n_levels: int
    max_depth: float
    n_steps: int  # daily timesteps
    start: str

    # chlorophyll lives on a deliberately coarser, lower-frequency grid --
    # mirroring GLOBAL_MULTIYEAR_BGC_001_029 (1/4 deg) against GLORYS12 (1/12
    # deg). Facing the regrid problem on synthetic data is the point.
    bgc_resolution: float = 0.25
    bgc_step_days: int = 5


PROFILES: dict[str, GridProfile] = {
    # Fast restarts while iterating.
    "tiny": GridProfile(
        name="tiny",
        west=85.0, south=10.0, east=92.0, north=18.0,
        resolution=0.25, n_levels=25, max_depth=2000.0,
        n_steps=5, start="2023-01-01",
    ),
    # The actual build and demo target: Bay of Bengal.
    "demo": GridProfile(
        name="demo",
        west=80.0, south=5.0, east=95.0, north=22.0,
        resolution=0.125, n_levels=40, max_depth=2000.0,
        n_steps=30, start="2023-01-01",
    ),
    # Matches the spec section 7 acquisition bbox.
    "full": GridProfile(
        name="full",
        west=60.0, south=0.0, east=100.0, north=25.0,
        resolution=0.125, n_levels=50, max_depth=5500.0,
        n_steps=31, start="2023-01-01",
    ),
}


def depth_levels(n: int, max_depth: float) -> np.ndarray:
    """Stretched-exponential depth axis, GLORYS-shaped.

    GLORYS12 puts 22 of its 50 levels in the top 100 m. We reproduce that
    *distribution* (dense near the surface, coarse at depth) rather than the
    exact level table, so the thermocline is properly resolved and the volume
    renderer has something to show.

    z_k = a * (exp(b*k) - 1), tuned so z_0 is a fraction of a metre and
    z_{n-1} == max_depth with roughly half the levels above 100 m.
    """
    k = np.arange(n, dtype=float)
    # Solve for b such that the half-way index lands near 100 m.
    target_shallow = 100.0
    half = n * 0.55
    b = np.log(1.0 + (max_depth / target_shallow)) / (n - 1 - half + 1e-9)
    b = float(np.clip(b, 0.03, 0.35))
    raw = np.exp(b * k) - 1.0
    z = raw / raw[-1] * max_depth
    z[0] = round(float(max_depth) * 0.00025, 3)  # ~0.5 m at 2000 m, like GLORYS
    return np.round(z, 3)


def axes_for(profile: GridProfile) -> dict[str, np.ndarray]:
    """Build the model axes (longitude, latitude, depth, time)."""
    lon = np.round(
        np.arange(profile.west, profile.east + 1e-9, profile.resolution), 6
    )
    lat = np.round(
        np.arange(profile.south, profile.north + 1e-9, profile.resolution), 6
    )
    depth = depth_levels(profile.n_levels, profile.max_depth)
    time = pd.date_range(profile.start, periods=profile.n_steps, freq="D")
    return {"lon": lon, "lat": lat, "depth": depth, "time": time}


def bgc_axes_for(profile: GridProfile) -> dict[str, np.ndarray]:
    """Coarser, lower-frequency axes for the biogeochemistry product."""
    lon = np.round(
        np.arange(profile.west, profile.east + 1e-9, profile.bgc_resolution), 6
    )
    lat = np.round(
        np.arange(profile.south, profile.north + 1e-9, profile.bgc_resolution), 6
    )
    depth = depth_levels(max(12, profile.n_levels // 3), 300.0)
    n = max(2, profile.n_steps // profile.bgc_step_days)
    time = pd.date_range(profile.start, periods=n, freq=f"{profile.bgc_step_days}D")
    return {"lon": lon, "lat": lat, "depth": depth, "time": time}


def levels_from_file(path: str) -> np.ndarray:
    """Adopt the depth axis of a real GLORYS granule.

    One tiny granule (a single variable, single day, one degree) is a ~30 second
    download once credentials exist, and inheriting its exact level table is the
    cheapest possible de-risking of a future real-data swap.
    """
    import xarray as xr

    with xr.open_dataset(path) as ds:
        for cand in ("depth", "deptht", "lev"):
            if cand in ds.coords:
                return np.asarray(ds[cand].values, dtype=float)
    raise ValueError(f"no recognisable depth coordinate in {path}")
