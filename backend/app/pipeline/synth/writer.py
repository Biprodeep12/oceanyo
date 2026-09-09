"""Assemble the synthetic fields into CF-compliant NetCDF files.

Every attribute written here comes from `core.conventions`, which is the same
module the CF adapter reads back. That symmetry is what makes the synthetic
dataset and a real GLORYS12 subset interchangeable.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

from ...core import conventions as cv
from . import bathymetry as bathy
from . import fields
from .grid import GridProfile, axes_for, bgc_axes_for

log = logging.getLogger(__name__)

# h5netcdf understands these; complevel 1 keeps generation fast while still
# roughly halving the file.
_ENCODING = {"zlib": True, "complevel": 1, "dtype": "float32", "_FillValue": np.float32(np.nan)}


def _time_encoding() -> dict:
    return {"units": cv.TIME_UNITS, "calendar": cv.TIME_CALENDAR, "dtype": "float64"}


def _coord_vars(lon, lat, depth, time) -> dict:
    return {
        "longitude": ("longitude", np.asarray(lon, dtype="float32"), dict(cv.LON_ATTRS)),
        "latitude": ("latitude", np.asarray(lat, dtype="float32"), dict(cv.LAT_ATTRS)),
        "depth": ("depth", np.asarray(depth, dtype="float32"), dict(cv.DEPTH_ATTRS)),
        "time": ("time", pd.DatetimeIndex(time), dict(cv.TIME_ATTRS)),
    }


def write_model(profile: GridProfile, out: Path, *, seed: int = 7) -> Path:
    """Emit model.nc with thetao, so, uo, vo on (time, depth, latitude, longitude)."""
    ax = axes_for(profile)
    lon, lat, depth, time = ax["lon"], ax["lat"], ax["depth"], ax["time"]
    lon2, lat2 = np.meshgrid(lon, lat)
    dom = profile.domain()

    elev = bathy.elevation(lon, lat, profile, seed=seed)
    mask = bathy.water_mask(elev, depth)  # (depth, lat, lon) True where water

    nt, nz, ny, nx = len(time), len(depth), len(lat), len(lon)
    log.info("model grid: time=%d depth=%d lat=%d lon=%d", nt, nz, ny, nx)

    thetao = np.empty((nt, nz, ny, nx), dtype=np.float32)
    so = np.empty_like(thetao)
    uo = np.empty_like(thetao)
    vo = np.empty_like(thetao)

    t0 = pd.Timestamp(time[0])
    for i, ts in enumerate(time):
        day = float((pd.Timestamp(ts) - t0).days)
        thetao[i] = fields.temperature(lon2, lat2, depth, day, dom)
        so[i] = fields.salinity(lon2, lat2, depth, day, dom)
        u, v = fields.currents(lon, lat, depth, day, dom)
        uo[i], vo[i] = u, v

    # Blank everything below the seabed. NaN is the fill value, and it becomes
    # raw 0 in the quantized volume, which the shader discards.
    nan = np.float32(np.nan)
    for arr in (thetao, so, uo, vo):
        arr[:, ~mask] = nan

    coords = _coord_vars(lon, lat, depth, time)
    data = {
        "thetao": thetao,
        "so": so,
        "uo": uo,
        "vo": vo,
    }
    ds = xr.Dataset(
        {
            name: (
                ("time", "depth", "latitude", "longitude"),
                arr,
                cv.variable_attrs(cv.BY_RAW_NAME[name]),
            )
            for name, arr in data.items()
        },
        coords={k: (d, v, a) for k, (d, v, a) in coords.items()},
        attrs=cv.global_attrs(
            title="Synthetic Bay of Bengal ocean state (GLORYS12V1-shaped)",
            synthetic=True,
            source="SYNTHETIC - GLORYS12V1-shaped, not a reanalysis",
        ),
    )
    ds.attrs["generator_profile"] = profile.name
    ds.attrs["generator_seed"] = seed

    enc = {name: dict(_ENCODING) for name in data}
    enc["time"] = _time_encoding()
    out.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(out, engine="h5netcdf", encoding=enc)
    ds.close()
    log.info("wrote %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return out


def write_bgc(profile: GridProfile, out: Path) -> Path:
    """Emit bgc.nc with chl on a deliberately coarser, lower-frequency grid.

    GLORYS12 is physics-only; model chlorophyll comes from a separate BGC
    reanalysis at 1/4 degree. Reproducing that mismatch here means the regrid
    problem is faced on synthetic data rather than discovered late.
    """
    ax = bgc_axes_for(profile)
    lon, lat, depth, time = ax["lon"], ax["lat"], ax["depth"], ax["time"]
    lon2, lat2 = np.meshgrid(lon, lat)
    dom = profile.domain()

    elev = bathy.elevation(lon, lat, profile, seed=7)
    mask = bathy.water_mask(elev, depth)

    nt, nz, ny, nx = len(time), len(depth), len(lat), len(lon)
    chl = np.empty((nt, nz, ny, nx), dtype=np.float32)
    t0 = pd.Timestamp(time[0])
    for i, ts in enumerate(time):
        day = float((pd.Timestamp(ts) - t0).days)
        chl[i] = fields.chlorophyll(lon2, lat2, depth, day, dom)
    chl[:, ~mask] = np.float32(np.nan)

    coords = _coord_vars(lon, lat, depth, time)
    ds = xr.Dataset(
        {"chl": (("time", "depth", "latitude", "longitude"), chl,
                 cv.variable_attrs(cv.CANONICAL["chlorophyll"]))},
        coords={k: (d, v, a) for k, (d, v, a) in coords.items()},
        attrs=cv.global_attrs(
            title="Synthetic Bay of Bengal chlorophyll (BGC-shaped, 1/4 deg)",
            synthetic=True,
            source="SYNTHETIC - GLOBAL_MULTIYEAR_BGC_001_029-shaped",
        ),
    )
    enc = {"chl": dict(_ENCODING), "time": _time_encoding()}
    out.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(out, engine="h5netcdf", encoding=enc)
    ds.close()
    log.info("wrote %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return out


def write_bathymetry(profile: GridProfile, out: Path, *, seed: int = 7) -> Path:
    """Emit gebco.nc: elevation(latitude, longitude), negative below sea level."""
    # Bathymetry is rendered as a mesh, so it gets a finer grid than the model.
    step = profile.resolution / 2.0
    lon = np.round(np.arange(profile.west, profile.east + 1e-9, step), 6)
    lat = np.round(np.arange(profile.south, profile.north + 1e-9, step), 6)
    elev = bathy.elevation(lon, lat, profile, seed=seed).astype(np.float32)

    ds = xr.Dataset(
        {
            "elevation": (
                ("latitude", "longitude"),
                elev,
                {
                    "standard_name": "height_above_mean_sea_level",
                    "long_name": "Elevation relative to sea level",
                    "units": "m",
                    "positive": "up",
                },
            )
        },
        coords={
            "longitude": ("longitude", lon.astype("float32"), dict(cv.LON_ATTRS)),
            "latitude": ("latitude", lat.astype("float32"), dict(cv.LAT_ATTRS)),
        },
        attrs=cv.global_attrs(
            title="Synthetic bathymetry (GEBCO-shaped)",
            synthetic=True,
            source="SYNTHETIC - GEBCO_2024-shaped, not a compilation product",
        ),
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(out, engine="h5netcdf",
                 encoding={"elevation": {"zlib": True, "complevel": 4}})
    ds.close()
    log.info("wrote %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return out


def write_climatology(profile: GridProfile, out: Path) -> Path:
    """Emit climatology.nc: eddy-free mean and standard deviation.

    Built by re-evaluating the same field functions with mesoscale features
    switched off, then sampling across a year. Anomalies computed against this
    are genuinely "versus climatology" rather than versus a smoothed copy of
    the data itself -- which is the distinction the spec calls out as the
    difference between a defensible anomaly and a naive outlier detector.
    """
    ax = axes_for(profile)
    lon, lat, depth = ax["lon"], ax["lat"], ax["depth"]
    lon2, lat2 = np.meshgrid(lon, lat)
    dom = profile.domain()

    elev = bathy.elevation(lon, lat, profile, seed=7)
    mask = bathy.water_mask(elev, depth)

    sample_days = np.linspace(0, 364, 24)
    with fields.no_eddies():
        t_stack = np.stack([fields.temperature(lon2, lat2, depth, d, dom) for d in sample_days])
        s_stack = np.stack([fields.salinity(lon2, lat2, depth, d, dom) for d in sample_days])

    def _stats(stack):
        mean = stack.mean(axis=0).astype(np.float32)
        std = stack.std(axis=0).astype(np.float32)
        mean[~mask] = np.float32(np.nan)
        std[~mask] = np.float32(np.nan)
        return mean, std

    t_mean, t_std = _stats(t_stack)
    s_mean, s_std = _stats(s_stack)

    dims = ("depth", "latitude", "longitude")
    ds = xr.Dataset(
        {
            "thetao_mean": (dims, t_mean, cv.variable_attrs(cv.CANONICAL["temperature"])),
            "thetao_std": (dims, t_std, {"units": "degrees_C", "long_name": "Temperature std"}),
            "so_mean": (dims, s_mean, cv.variable_attrs(cv.CANONICAL["salinity"])),
            "so_std": (dims, s_std, {"units": "1e-3", "long_name": "Salinity std"}),
        },
        coords={
            "longitude": ("longitude", lon.astype("float32"), dict(cv.LON_ATTRS)),
            "latitude": ("latitude", lat.astype("float32"), dict(cv.LAT_ATTRS)),
            "depth": ("depth", depth.astype("float32"), dict(cv.DEPTH_ATTRS)),
        },
        attrs=cv.global_attrs(
            title="Synthetic climatology (eddy-free annual mean and std)",
            synthetic=True,
            source="SYNTHETIC - eddy-free re-evaluation of the field functions",
        ),
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(
        out,
        engine="h5netcdf",
        encoding={v: dict(_ENCODING) for v in ds.data_vars},
    )
    ds.close()
    log.info("wrote %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return out
