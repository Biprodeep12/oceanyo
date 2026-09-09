"""Synthetic glider deployments in EGO-shaped NetCDF.

Gliders fly a sawtooth: dive to ~1000 m, climb back, repeat. Per the EGO format
each dive/climb pair is split into two profiles, and the deployment is stored as
one file holding a time series plus a trajectory.

This exists mainly to hedge the risk the spec flags -- Indian Ocean glider
deployments are scarce in the real GDAC -- so the instrument-overlay
requirement demos regardless of what is available upstream.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

from . import fields
from .grid import GridProfile

log = logging.getLogger(__name__)

JULD_EPOCH = pd.Timestamp("1950-01-01")

INJECTED_BIAS = {"TEMP": -0.18, "PSAL": +0.03}


def write_deployments(
    gp: GridProfile, outdir: Path, *, seed: int = 7, n_deployments: int = 2
) -> list[Path]:
    rng = np.random.default_rng(seed + 202)
    outdir.mkdir(parents=True, exist_ok=True)
    t0 = pd.Timestamp(gp.start)
    written: list[Path] = []

    for d in range(n_deployments):
        code = f"BoB_glider_{d + 1:02d}"
        # Fly a transect across the basin.
        lat_start = gp.south + (0.30 + 0.35 * d) * (gp.north - gp.south)
        lon_start = gp.west + 0.22 * (gp.east - gp.west)
        heading_lon = 0.055 + 0.012 * d  # deg per profile, eastward
        heading_lat = 0.018 * (1 if d % 2 == 0 else -1)

        max_depth = 1000.0
        n_pairs = 26  # dive/climb pairs over ~14 days
        levels = np.concatenate([
            np.arange(0, 100, 2),
            np.arange(100, 400, 5),
            np.arange(400, 1001, 15),
        ]).astype(np.float32)
        n_lev = len(levels)
        n_prof = n_pairs * 2

        pres = np.tile(levels, (n_prof, 1))
        temp = np.full((n_prof, n_lev), np.nan, dtype=np.float32)
        psal = np.full((n_prof, n_lev), np.nan, dtype=np.float32)
        temp_qc = np.ones((n_prof, n_lev), dtype=np.int8)
        psal_qc = np.ones((n_prof, n_lev), dtype=np.int8)
        lats = np.zeros(n_prof)
        lons = np.zeros(n_prof)
        juld = np.zeros(n_prof)
        direction = np.empty(n_prof, dtype="S1")

        hours_per_profile = 6.0
        for p in range(n_prof):
            frac = p / max(n_prof - 1, 1)
            lon = lon_start + heading_lon * p
            lat = lat_start + heading_lat * p
            lon = float(np.clip(lon, gp.west + 0.05, gp.east - 0.05))
            lat = float(np.clip(lat, gp.south + 0.05, gp.north - 0.05))
            hours = p * hours_per_profile
            day = hours / 24.0

            lons[p], lats[p] = lon, lat
            juld[p] = (t0 + pd.Timedelta(hours=hours) - JULD_EPOCH).total_seconds() / 86400.0
            direction[p] = b"D" if p % 2 == 0 else b"A"

            lon2 = np.array([[lon]])
            lat2 = np.array([[lat]])
            z = levels.astype(float)
            t_true = fields.temperature(lon2, lat2, z, day)[:, 0, 0]
            s_true = fields.salinity(lon2, lat2, z, day)[:, 0, 0]

            w = rng.standard_normal(n_lev)
            smooth = np.convolve(w, np.ones(5) / 5.0, mode="same")
            temp[p] = (t_true + INJECTED_BIAS["TEMP"] + smooth * 0.05).astype(np.float32)
            psal[p] = (s_true + INJECTED_BIAS["PSAL"] + smooth * 0.012).astype(np.float32)

            # Gliders lose data at the deepest part of a dive fairly often.
            if rng.random() < 0.25:
                cut = int(n_lev * rng.uniform(0.82, 0.97))
                temp[p, cut:] = np.nan
                psal[p, cut:] = np.nan

        ds = xr.Dataset(
            {
                "PLATFORM_CODE": ((), code),
                "DATA_MODE": ((), "R"),
                "JULD": ("N_PROF", juld, {
                    "long_name": "Julian day (UTC) of the profile",
                    "units": "days since 1950-01-01 00:00:00 UTC",
                    "standard_name": "time"}),
                "LATITUDE": ("N_PROF", lats, {
                    "standard_name": "latitude", "units": "degrees_north"}),
                "LONGITUDE": ("N_PROF", lons, {
                    "standard_name": "longitude", "units": "degrees_east"}),
                "DIRECTION": ("N_PROF", direction, {
                    "long_name": "Profile direction: D=descent, A=ascent"}),
                "PRES": (("N_PROF", "N_LEVELS"), pres, {
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
                "Conventions": "EGO-1.5 CF-1.6",
                "format_version": "1.5",
                "title": "Glider deployment time series (SYNTHETIC)",
                "institution": "SYNTHETIC",
                "source": "SYNTHETIC - sampled from the synthetic model field",
                "synthetic": "true",
                "platform_code": code,
                "synthetic_bias_TEMP": INJECTED_BIAS["TEMP"],
                "synthetic_bias_PSAL": INJECTED_BIAS["PSAL"],
            },
        )
        path = outdir / f"{code}_R.nc"
        ds.to_netcdf(path, engine="h5netcdf")
        ds.close()
        written.append(path)

    log.info("wrote %d glider deployments -> %s", len(written), outdir)
    return written
