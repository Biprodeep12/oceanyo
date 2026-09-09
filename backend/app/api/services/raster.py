"""Colour mapping and PNG encoding.

Two distinct outputs live here:

  * `colormap_png` -- a human-visible, colour-mapped image for map tiles and
    depth slices.
  * `encode_uv_png` -- u/v velocity packed into the R and G channels with
    min/max metadata, for the GPU particle layer. This is the webgl-wind
    convention: the browser never decodes it as a picture, it samples it as a
    velocity texture.
"""

from __future__ import annotations

import io
import json
from functools import lru_cache

import numpy as np
from PIL import Image

from ...core.config import REPO_ROOT

_COLORMAP_FILE = REPO_ROOT / "config" / "colormaps.json"


@lru_cache(maxsize=1)
def _load_definitions() -> dict:
    with open(_COLORMAP_FILE, "r", encoding="utf-8") as fh:
        return json.load(fh)["colormaps"]


def available() -> list[dict]:
    return [
        {"name": name, "label": spec.get("label", name),
         "description": spec.get("description", ""),
         "diverging": bool(spec.get("diverging", False))}
        for name, spec in _load_definitions().items()
    ]


@lru_cache(maxsize=16)
def lut(name: str, size: int = 256) -> np.ndarray:
    """Build an (size, 3) uint8 lookup table by interpolating the stops."""
    defs = _load_definitions()
    spec = defs.get(name) or defs["gray"]
    stops = np.asarray(spec["stops"], dtype=float)
    positions = stops[:, 0]
    colors = stops[:, 1:]

    x = np.linspace(0.0, 1.0, size)
    out = np.empty((size, 3), dtype=np.float64)
    for c in range(3):
        out[:, c] = np.interp(x, positions, colors[:, c])
    return np.clip(out, 0, 255).astype(np.uint8)


def normalize(
    values: np.ndarray, vmin: float, vmax: float, *, log: bool = False
) -> np.ndarray:
    """Scale to 0..1. NaN stays NaN so the caller can make it transparent."""
    v = values.astype(np.float64, copy=True)
    if log:
        floor = max(vmin, 1e-4)
        v = np.log10(np.clip(v, floor, None))
        lo, hi = np.log10(floor), np.log10(max(vmax, floor * 10))
    else:
        lo, hi = float(vmin), float(vmax)
    if hi - lo < 1e-12:
        hi = lo + 1e-12
    return (v - lo) / (hi - lo)


def colormap_png(
    values: np.ndarray,
    *,
    vmin: float,
    vmax: float,
    cmap: str = "thermal",
    log: bool = False,
    flip_y: bool = True,
    opacity: float = 1.0,
) -> bytes:
    """Render a 2D array to an RGBA PNG. NaN becomes fully transparent.

    `flip_y` because our arrays are stored with latitude ascending (north last)
    while image rows run top-down (north first).
    """
    if values.ndim != 2:
        raise ValueError(f"expected a 2D array, got shape {values.shape}")

    arr = values[::-1, :] if flip_y else values
    norm = normalize(arr, vmin, vmax, log=log)
    finite = np.isfinite(norm)

    idx = np.zeros(norm.shape, dtype=np.uint16)
    idx[finite] = np.clip(norm[finite] * 255.0, 0, 255).astype(np.uint16)

    table = lut(cmap)
    rgb = table[idx]

    alpha = np.where(finite, int(np.clip(opacity, 0, 1) * 255), 0).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])

    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def encode_uv_png(u: np.ndarray, v: np.ndarray, *, flip_y: bool = True) -> tuple[bytes, dict]:
    """Pack u/v into R and G channels for the GPU particle layer.

    Returns the PNG bytes plus the min/max metadata the shader needs to decode
    them back to m/s. Land/NaN is written as the midpoint with alpha 0, so the
    advection shader can treat zero alpha as "no flow here".
    """
    if u.shape != v.shape:
        raise ValueError(f"u and v shapes differ: {u.shape} vs {v.shape}")

    if flip_y:
        u, v = u[::-1, :], v[::-1, :]

    finite = np.isfinite(u) & np.isfinite(v)
    if not finite.any():
        umin = umax = vmin = vmax = 0.0
    else:
        umin, umax = float(np.nanmin(u)), float(np.nanmax(u))
        vmin, vmax = float(np.nanmin(v)), float(np.nanmax(v))
    if umax - umin < 1e-9:
        umax = umin + 1e-9
    if vmax - vmin < 1e-9:
        vmax = vmin + 1e-9

    ur = np.zeros(u.shape, dtype=np.uint8)
    vr = np.zeros(v.shape, dtype=np.uint8)
    ur[finite] = np.clip((u[finite] - umin) / (umax - umin) * 255.0, 0, 255).astype(np.uint8)
    vr[finite] = np.clip((v[finite] - vmin) / (vmax - vmin) * 255.0, 0, 255).astype(np.uint8)

    alpha = np.where(finite, 255, 0).astype(np.uint8)
    rgba = np.dstack([ur, vr, np.zeros_like(ur), alpha])

    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=False)

    meta = {
        "uMin": umin, "uMax": umax,
        "vMin": vmin, "vMax": vmax,
        "width": int(u.shape[1]), "height": int(u.shape[0]),
    }
    return buf.getvalue(), meta
