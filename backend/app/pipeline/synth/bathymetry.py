"""Synthetic seabed, shaped like a GEBCO tile.

Emitted as `elevation(latitude, longitude)`, negative below sea level, which is
GEBCO's own convention. Used twice: as the seabed mesh in block mode, and as
the mask that blanks the volume below the seafloor. The mask matters more than
it sounds -- a water column that stops at the bottom is what makes the block
read as a real place rather than a textured cube.
"""

from __future__ import annotations

import numpy as np

from .grid import GridProfile


def _smooth_noise(rng: np.random.Generator, shape: tuple[int, int], octaves: int = 4) -> np.ndarray:
    """Cheap fractal noise: sum of upsampled random grids."""
    ny, nx = shape
    out = np.zeros(shape, dtype=float)
    amp = 1.0
    for o in range(octaves):
        cy, cx = max(2, ny >> (octaves - o)), max(2, nx >> (octaves - o))
        coarse = rng.standard_normal((cy, cx))
        yi = np.linspace(0, cy - 1, ny)
        xi = np.linspace(0, cx - 1, nx)
        y0 = np.clip(np.floor(yi).astype(int), 0, cy - 2)
        x0 = np.clip(np.floor(xi).astype(int), 0, cx - 2)
        fy = (yi - y0)[:, None]
        fx = (xi - x0)[None, :]
        c = coarse
        top = c[y0][:, x0] * (1 - fx) + c[y0][:, x0 + 1] * fx
        bot = c[y0 + 1][:, x0] * (1 - fx) + c[y0 + 1][:, x0 + 1] * fx
        out += amp * (top * (1 - fy) + bot * fy)
        amp *= 0.5
    return out


def elevation(
    lon: np.ndarray, lat: np.ndarray, profile: GridProfile, seed: int = 7
) -> np.ndarray:
    """Return elevation(lat, lon) in metres, negative below sea level."""
    rng = np.random.default_rng(seed)
    lon2, lat2 = np.meshgrid(lon, lat)

    # Normalised distance from the western/northern coast of the Bay of Bengal.
    # The basin deepens to the south-east.
    fx = (lon2 - profile.west) / max(profile.east - profile.west, 1e-9)
    fy = (lat2 - profile.south) / max(profile.north - profile.south, 1e-9)

    # Distance from the notional coastline (an L-shape hugging west and north).
    d_coast = np.minimum(fx * 1.15, (1.0 - fy) * 1.30)
    d_coast = np.clip(d_coast, 0.0, 1.0)

    # Shelf (0-150 m) -> slope -> abyssal plain, via a smooth ramp.
    shelf_edge = 0.13
    slope_end = 0.34
    shelf = -150.0 * (d_coast / shelf_edge)
    ramp = (d_coast - shelf_edge) / (slope_end - shelf_edge)
    slope = -150.0 - (profile.max_depth * 0.92 - 150.0) * np.clip(ramp, 0, 1) ** 1.35
    abyss = -profile.max_depth * 0.92 - 220.0 * (d_coast - slope_end)

    elev = np.where(d_coast < shelf_edge, shelf, np.where(d_coast < slope_end, slope, abyss))

    # A mid-basin ridge and a shelf-incising canyon, so the mesh has relief
    # rather than a monotone ramp.
    ridge = 900.0 * np.exp(
        -(((fx - 0.62) / 0.09) ** 2 + ((fy - 0.42) / 0.42) ** 2)
    )
    canyon = -520.0 * np.exp(-(((fy - 0.63) / 0.035) ** 2)) * np.clip(1.4 - fx * 2.2, 0, 1)
    elev = elev + ridge + canyon

    # Roughness, scaled so the shelf stays smooth and the abyss is textured.
    elev = elev + _smooth_noise(rng, elev.shape) * 45.0 * np.clip(d_coast * 2.0, 0.1, 1.0)

    # A little dry land in the north-west corner so the coastline is visible.
    land = 60.0 * np.clip(0.10 - d_coast, 0, None) / 0.10
    elev = elev + land

    return np.clip(elev, -profile.max_depth * 1.05, 220.0)


def water_mask(elev: np.ndarray, depths: np.ndarray) -> np.ndarray:
    """Boolean (depth, lat, lon): True where the cell is in the water column.

    A cell is water when its depth is above the seabed and the seabed is below
    sea level.
    """
    seabed_depth = -elev  # positive down; negative over land
    return (depths[:, None, None] <= seabed_depth[None, :, :]) & (seabed_depth[None, :, :] > 0)
