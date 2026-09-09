"""Synthetic Argo floats, written in Argo core-profile NetCDF format.

Two deliberate choices here:

1. The files use real Argo variable names (PLATFORM_NUMBER, JULD, PRES, TEMP,
   PSAL, *_QC, DATA_MODE), so the SAME parser reads these and a real GDAC file.
   The synthetic data exercises the production code path rather than a mock.

2. Observations are sampled from the model field at each float's true position
   and time, then perturbed with a KNOWN systematic bias plus noise. This is
   what makes the matchup panel show a non-zero, non-random, explainable error
   -- observations identical to the model would give bias 0.000 and a dead
   demo, and pure noise would give an indefensible one. It also yields the only
   true end-to-end test available: the matchup should recover the injected bias.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

from . import fields
from .bathymetry import elevation
from .grid import GridProfile

log = logging.getLogger(__name__)

JULD_EPOCH = pd.Timestamp("1950-01-01")

# Argo-typical sampling: dense near the surface, coarse at depth.
PRES_LEVELS = np.concatenate([
    np.arange(0, 100, 5),
    np.arange(100, 300, 10),
    np.arange(300, 1000, 25),
    np.arange(1000, 2001, 50),
]).astype(np.float32)

# The bias we deliberately inject, per variable. The matchup endpoint must
# recover approximately these numbers -- see pipeline/verify.
INJECTED_BIAS = {"TEMP": -0.30, "PSAL": +0.05}

CYCLE_DAYS = 10.0
PARK_DEPTH = 1000.0


def _seabed_depth(lon: float, lat: float, gp: GridProfile, cache: dict) -> float:
    """Seabed depth (positive down) at a point, from the synthetic bathymetry."""
    if "grid" not in cache:
        lons = np.arange(gp.west, gp.east + 1e-9, gp.resolution)
        lats = np.arange(gp.south, gp.north + 1e-9, gp.resolution)
        cache["grid"] = (lons, lats, elevation(lons, lats, gp, seed=7))
    lons, lats, elev = cache["grid"]
    i = int(np.clip(np.searchsorted(lats, lat) - 1, 0, len(lats) - 1))
    j = int(np.clip(np.searchsorted(lons, lon) - 1, 0, len(lons) - 1))
    return float(-elev[i, j])


def _drift(lon: float, lat: float, day: float, days: float) -> tuple[float, float]:
    """Advect a parked float by the synthetic velocity field at PARK_DEPTH.

    `currents` differentiates a streamfunction, so it needs at least three
    points per axis. Evaluate on a small stencil and take the centre.
    """
    h = 0.05
    lons = np.array([lon - h, lon, lon + h])
    lats = np.array([lat - h, lat, lat + h])
    depth = np.array([PARK_DEPTH])
    u, v = fields.currents(lons, lats, depth, day)
    u_c, v_c = float(u[0, 1, 1]), float(v[0, 1, 1])
    # m/s -> degrees over `days`; the park depth damps the surface flow heavily.
    dx = u_c / (111_320.0 * np.cos(np.deg2rad(lat))) * 86400.0 * days
    dy = v_c / 110_540.0 * 86400.0 * days
    return lon + dx, lat + dy


def write_floats(
    gp: GridProfile, outdir: Path, *, seed: int = 7, n_floats: int = 30
) -> list[Path]:
    """Generate `n_floats` park-and-profile floats over the profile's window."""
    rng = np.random.default_rng(seed + 101)
    outdir.mkdir(parents=True, exist_ok=True)
    cache: dict = {}

    t0 = pd.Timestamp(gp.start)
    span_days = float(gp.n_steps - 1)
    written: list[Path] = []

    for f in range(n_floats):
        wmo = 2900000 + seed * 100 + f
        # Start somewhere in deep enough water.
        for _ in range(60):
            lon = float(rng.uniform(gp.west + 0.5, gp.east - 0.5))
            lat = float(rng.uniform(gp.south + 0.5, gp.north - 0.5))
            if _seabed_depth(lon, lat, gp, cache) > 250.0:
                break

        # A few floats carry an extra instrument drift term.
        drifting = f % 11 == 0
        data_mode = "D" if f % 3 == 0 else ("A" if f % 3 == 1 else "R")

        first_day = float(rng.uniform(0, CYCLE_DAYS))
        days = np.arange(first_day, span_days + 1e-9, CYCLE_DAYS)
        if len(days) == 0:
            days = np.array([0.0])

        n_prof = len(days)
        n_lev = len(PRES_LEVELS)
        pres = np.tile(PRES_LEVELS, (n_prof, 1))
        temp = np.full((n_prof, n_lev), np.nan, dtype=np.float32)
        psal = np.full((n_prof, n_lev), np.nan, dtype=np.float32)
        temp_qc = np.ones((n_prof, n_lev), dtype=np.int8)
        psal_qc = np.ones((n_prof, n_lev), dtype=np.int8)
        lats = np.zeros(n_prof, dtype=np.float64)
        lons = np.zeros(n_prof, dtype=np.float64)
        juld = np.zeros(n_prof, dtype=np.float64)

        clon, clat = lon, lat
        for p, day in enumerate(days):
            if p > 0:
                clon, clat = _drift(clon, clat, day, CYCLE_DAYS)
                clon = float(np.clip(clon, gp.west + 0.05, gp.east - 0.05))
                clat = float(np.clip(clat, gp.south + 0.05, gp.north - 0.05))
            lons[p], lats[p] = clon, clat
            juld[p] = (t0 + pd.Timedelta(days=float(day)) - JULD_EPOCH).total_seconds() / 86400.0

            seabed = _seabed_depth(clon, clat, gp, cache)
            valid = PRES_LEVELS <= min(2000.0, seabed - 10.0)
            if not valid.any():
                continue

            lon2 = np.array([[clon]])
            lat2 = np.array([[clat]])
            z = PRES_LEVELS[valid].astype(float)
            t_true = fields.temperature(lon2, lat2, z, float(day))[:, 0, 0]
            s_true = fields.salinity(lon2, lat2, z, float(day))[:, 0, 0]

            # depth-correlated noise (smooth, not white) + systematic bias.
            # np.convolve(mode="same") returns max(len(signal), len(kernel)), so
            # the kernel must not exceed the profile length -- shallow-water
            # profiles can be only a couple of levels deep.
            def _corr_noise(scale: float, n: int = len(z)) -> np.ndarray:
                w = rng.standard_normal(n)
                width = min(5, n)
                if width < 2:
                    return w * scale
                k = np.ones(width) / width
                return np.convolve(w, k, mode="same")[:n] * scale

            drift_term = (0.004 * z / 100.0) if drifting else 0.0

            temp[p, valid] = (
                t_true + INJECTED_BIAS["TEMP"] + _corr_noise(0.06) + drift_term
            ).astype(np.float32)
            psal[p, valid] = (
                s_true + INJECTED_BIAS["PSAL"] + _corr_noise(0.015)
            ).astype(np.float32)

            # A handful of genuinely bad points, flagged 4, so the QC filter has
            # something to actually filter.
            if rng.random() < 0.28:
                bad = rng.integers(0, valid.sum(), size=rng.integers(1, 4))
                idx = np.where(valid)[0][bad]
                temp[p, idx] += rng.uniform(-6, 6, size=len(idx))
                temp_qc[p, idx] = 4
            # Some "probably good" points.
            prob = np.where(valid)[0][rng.random(valid.sum()) < 0.05]
            temp_qc[p, prob] = 2
            psal_qc[p, prob] = 2

        ds = xr.Dataset(
            {
                "PLATFORM_NUMBER": ((), str(wmo)),
                "DATA_MODE": ((), data_mode),
                "JULD": ("N_PROF", juld, {
                    "long_name": "Julian day (UTC) of the station",
                    "units": "days since 1950-01-01 00:00:00 UTC",
                    "standard_name": "time",
                }),
                "LATITUDE": ("N_PROF", lats, {
                    "standard_name": "latitude", "units": "degrees_north"}),
                "LONGITUDE": ("N_PROF", lons, {
                    "standard_name": "longitude", "units": "degrees_east"}),
                "PRES": (("N_PROF", "N_LEVELS"), pres.astype(np.float32), {
                    "standard_name": "sea_water_pressure", "units": "decibar",
                    "axis": "Z", "positive": "down"}),
                "TEMP": (("N_PROF", "N_LEVELS"), temp, {
                    "standard_name": "sea_water_temperature", "units": "degree_Celsius"}),
                "PSAL": (("N_PROF", "N_LEVELS"), psal, {
                    "standard_name": "sea_water_salinity", "units": "psu"}),
                "TEMP_QC": (("N_PROF", "N_LEVELS"), temp_qc),
                "PSAL_QC": (("N_PROF", "N_LEVELS"), psal_qc),
            },
            attrs={
                "Conventions": "Argo-3.1 CF-1.6",
                "title": "Argo float vertical profile (SYNTHETIC)",
                "institution": "SYNTHETIC",
                "source": "SYNTHETIC - sampled from the synthetic model field",
                "synthetic": "true",
                # Recorded so the verification step can confirm the matchup
                # recovers it. Nothing in the API reads these.
                "synthetic_bias_TEMP": INJECTED_BIAS["TEMP"],
                "synthetic_bias_PSAL": INJECTED_BIAS["PSAL"],
                "synthetic_instrument_drift": "true" if drifting else "false",
            },
        )
        path = outdir / f"{wmo}_prof.nc"
        ds.to_netcdf(path, engine="h5netcdf")
        ds.close()
        written.append(path)

    log.info("wrote %d Argo float files -> %s", len(written), outdir)
    return written
