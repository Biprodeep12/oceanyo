"""Anomaly against climatology, expressed as a z-score.

Deliberately not a plain outlier detector. Comparing a value against the local
long-term mean and standard deviation separates a genuine anomaly from the
ordinary seasonal cycle; a naive detector conflates the two and flags every
summer as unusual.

The climatology is interpolated onto the model grid rather than required to
match it. Requiring a match happens to hold for the synthetic pair -- both are
generated on the same axes -- but every real climatology is coarser than the
model it is compared against (WOA is 1/4 degree, Roemmich-Gilson 1 degree,
GLORYS 1/12), so a shape check would fail on the first real swap. That is
precisely the kind of assumption the synthetic dataset can hide.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import xarray as xr

from ...core.cf_adapter import CFDataset
from ...core.conventions import CANONICAL
from ...core.geometry import BBox


@dataclass(frozen=True)
class AnomalyGrid:
    variable: str
    units: str
    depth: float
    time: str
    lat: np.ndarray
    lon: np.ndarray
    #: model - climatological mean, in the variable's own units
    diff: np.ndarray
    #: diff / climatological standard deviation
    z: np.ndarray


def climatology_names(
    model: CFDataset, climatology: CFDataset, key: str
) -> tuple[str, str] | None:
    """Find (mean, std) for one canonical variable INSIDE the climatology.

    The climatology is a different product from the model, by a different
    producer, and it does not have to share the model's vocabulary. Keying it
    on the model's raw name works only while both come from the same place --
    which was true for GLORYS against a GLORYS-shaped generator and is false
    the moment either side is real: WOA23 stores `thetao_mean`, HYCOM calls the
    field it is compared against `water_temp`, and the anomaly layer silently
    reported that no variable had a climatology at all.

    So the climatology is resolved on its own terms, canonical name first.
    """
    cv = CANONICAL.get(key)
    candidates: list[str] = []
    if cv is not None:
        candidates.append(cv.glorys_name)  # our own convention: thetao, so
    try:
        candidates.append(model.raw_name(key))  # same-producer pairing
    except KeyError:
        pass
    candidates.append(key)  # plain canonical: temperature_mean

    for base in candidates:
        mean, std = f"{base}_mean", f"{base}_std"
        if mean in climatology.ds and std in climatology.ds:
            return mean, std

    # Last resort: ask the climatology what it holds, by standard_name.
    if cv is not None:
        for name, da in climatology.ds.data_vars.items():
            sn = str(da.attrs.get("standard_name", ""))
            if sn and (sn == cv.standard_name or sn in cv.aliases):
                base = str(name).removesuffix("_mean")
                if f"{base}_mean" in climatology.ds and f"{base}_std" in climatology.ds:
                    return f"{base}_mean", f"{base}_std"
    return None


def available_variables(model: CFDataset, climatology: CFDataset | None) -> list[str]:
    """Canonical variables this catalog can actually produce an anomaly for.

    A climatology normally covers the physical core (temperature, salinity) and
    not the derived or biogeochemical fields, so the UI needs to know which
    variables to offer rather than discovering it from a 404.
    """
    if climatology is None:
        return []
    out = []
    for key in model.canonical_vars():
        if climatology_names(model, climatology, key) is not None:
            out.append(key)
    return out


def _on_model_grid(
    climatology: CFDataset, name: str, *, lat: np.ndarray, lon: np.ndarray, depth: float
) -> np.ndarray:
    """Climatology field at one depth, interpolated onto the model's lat/lon."""
    ax = climatology.axes
    da = climatology.ds[name]
    if ax.depth is not None and ax.depth in da.dims:
        da = da.sel({ax.depth: depth}, method="nearest")

    # Ascending coordinates: scipy's interpolator silently returns all-NaN on a
    # descending axis, which would read as "no anomaly anywhere".
    sort_by = [c for c in (ax.lat, ax.lon) if c in da.coords]
    if sort_by:
        da = da.sortby(sort_by)

    out = da.interp(
        {ax.lat: xr.DataArray(lat, dims="lat_t"), ax.lon: xr.DataArray(lon, dims="lon_t")},
        method="linear",
    )
    return np.asarray(out.transpose("lat_t", "lon_t").values, dtype=np.float64)


def anomaly_grid(
    model: CFDataset,
    climatology: CFDataset,
    *,
    variable: str,
    bbox: BBox,
    time: str | None,
    depth: float,
) -> AnomalyGrid:
    raw = model.raw_name(variable)
    names = climatology_names(model, climatology, variable)
    if names is None:
        raise KeyError(
            f"climatology has no mean/std for {variable!r}; "
            f"available: {list(climatology.ds.data_vars)}"
        )
    mean_name, std_name = names

    values, coords = model.select(variable, bbox=bbox, time=time, depth=depth)
    plane = values[0].astype(np.float64)
    lat, lon = coords["lat"], coords["lon"]

    mean = _on_model_grid(climatology, mean_name, lat=lat, lon=lon, depth=depth)
    std = _on_model_grid(climatology, std_name, lat=lat, lon=lon, depth=depth)

    with np.errstate(invalid="ignore", divide="ignore"):
        diff = plane - mean
        # A near-zero climatological spread makes the z-score meaningless
        # rather than infinite; mask those cells instead of emitting huge
        # values that would dominate the colour scale.
        z = np.where(std > 1e-6, diff / std, np.nan)

    return AnomalyGrid(
        variable=variable,
        units=CANONICAL[variable].units,
        depth=float(coords["depth"][0]),
        time=str(model.nearest_time(time)),
        lat=lat,
        lon=lon,
        diff=diff,
        z=z,
    )


def compute_anomaly(
    model: CFDataset,
    climatology: CFDataset,
    *,
    variable: str,
    bbox: BBox,
    time: str | None,
    depth: float,
) -> dict:
    """JSON envelope around `anomaly_grid`."""
    g = anomaly_grid(
        model, climatology, variable=variable, bbox=bbox, time=time, depth=depth
    )
    finite = np.isfinite(g.z)
    return {
        "variable": g.variable,
        "units": g.units,
        "depth": g.depth,
        "time": g.time,
        "lat": [float(v) for v in g.lat],
        "lon": [float(v) for v in g.lon],
        "shape": list(g.z.shape),
        "zRange": (
            [float(np.nanmin(g.z)), float(np.nanmax(g.z))] if finite.any() else [0.0, 0.0]
        ),
        "anomaly": [[None if not np.isfinite(v) else float(v) for v in row] for row in g.diff],
        "zscore": [[None if not np.isfinite(v) else float(v) for v in row] for row in g.z],
    }
