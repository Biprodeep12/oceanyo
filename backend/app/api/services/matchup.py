"""Model-observation matchup statistics.

This is the platform's scientific differentiator, so the method follows
standard operational ocean-model validation practice rather than something
convenient:

  (a) select model cells within a spatial radius and a time window,
  (b) interpolate the model onto the observation depths,
  (c) filter observations by QC flag,
  (d) compute bias, RMSE, MAE and correlation, plus the standard deviations and
      centred RMSE a Taylor diagram needs.

Two deliberate choices, both defensible when questioned:

  * QC defaults differ by purpose. Display keeps flags 1 and 2 ("good" and
    "probably good"); quantitative comparison keeps only flag 1. The response
    echoes which was used, so the number is never ambiguous.

  * The default direction is model->observation: interpolate the model onto the
    float's depths rather than binning the float onto model levels. Argo
    resolves the upper ocean far more finely than a 1/12 degree model, so
    binning would throw away the observation's structure. Levels with no model
    coverage are excluded and reported in `n`.
"""

from __future__ import annotations

import logging
import math
import warnings
from typing import Literal

import numpy as np
import pandas as pd

from ...core.cf_adapter import CFDataset
from ...core.conventions import CANONICAL
from ...core.geometry import BBox
from ...core.models import MatchupResult, ObservationProfile

log = logging.getLogger(__name__)

QC_DISPLAY = (1, 2)
QC_QUANTITATIVE = (1,)

EARTH_RADIUS_KM = 6371.0


def _km_to_deg_lat(km: float) -> float:
    return km / 110.574


def _km_to_deg_lon(km: float, lat: float) -> float:
    return km / (111.320 * max(math.cos(math.radians(lat)), 1e-6))


def compute_matchup(
    cfd: CFDataset,
    profile: ObservationProfile,
    *,
    variable: str = "temperature",
    radius_km: float = 25.0,
    window_hours: float = 24.0,
    qc_flags: tuple[int, ...] = QC_QUANTITATIVE,
    method: Literal["model_to_obs", "obs_to_model"] = "model_to_obs",
) -> MatchupResult:
    if variable not in profile.variables:
        raise KeyError(
            f"profile {profile.id!r} has no {variable!r}; it carries "
            f"{sorted(profile.variables)}"
        )

    pv = profile.variables[variable]
    obs_depth = np.asarray(profile.depth, dtype=float)
    obs_val = np.asarray([np.nan if v is None else v for v in pv.values], dtype=float)
    obs_qc = np.asarray(pv.qc, dtype=int)

    n = min(len(obs_depth), len(obs_val), len(obs_qc))
    obs_depth, obs_val, obs_qc = obs_depth[:n], obs_val[:n], obs_qc[:n]

    # (c) QC filter, plus a gross-range check.
    #
    # The flag alone is not enough on real data. Real-time EGO glider files
    # from the GDAC carry samples flagged 1 ("good") at 40 degrees C, because
    # real-time mode applies almost no QC -- and a single such spike moves the
    # RMSE more than every genuine difference in the profile combined. A gross
    # range check against the variable's own valid range is the first test in
    # every operational QC suite, and it is the reason delayed mode exists.
    lo, hi = CANONICAL[variable].valid
    in_range = (obs_val >= lo) & (obs_val <= hi)
    keep = np.isfinite(obs_val) & np.isin(obs_qc, qc_flags) & in_range
    rejected = int((np.isfinite(obs_val) & np.isin(obs_qc, qc_flags) & ~in_range).sum())
    if rejected:
        log.info(
            "%s %s: %d flagged-good samples outside the valid range %s..%s",
            profile.platform, profile.id, rejected, lo, hi,
        )
    obs_depth, obs_val = obs_depth[keep], obs_val[keep]

    # (a) spatial and temporal colocation
    dlat = _km_to_deg_lat(radius_km)
    dlon = _km_to_deg_lon(radius_km, profile.lat)
    box = BBox(
        profile.lon - dlon, profile.lat - dlat,
        profile.lon + dlon, profile.lat + dlat,
    ).clamp_to(cfd.bbox())

    # The TIME window, actually enforced.
    #
    # `CFDataset.select` snaps to the nearest available step, which is right
    # when a profile falls inside the model run and catastrophic when it does
    # not: an Argo profile from 2002 was being compared against a January 2024
    # analysis and reporting a confident sub-degree bias. Nothing in the
    # synthetic catalog could show this, because the generator samples its
    # floats from the model's own timesteps -- every profile is in window by
    # construction. Real floats outlive real model subsets.
    #
    # `window_hours` was reported in the result all along. It was never applied.
    in_window = True
    if cfd.axes.time is not None:
        nearest = pd.Timestamp(cfd.nearest_time(profile.time))
        asked = pd.Timestamp(profile.time)
        if asked.tzinfo is not None:
            asked = asked.tz_convert(None)
        gap_h = abs((nearest - asked).total_seconds()) / 3600.0
        in_window = gap_h <= window_hours
        if not in_window:
            log.debug(
                "%s %s: nearest model step is %.1f h away, window is %.1f h",
                profile.platform, profile.id, gap_h, window_hours,
            )

    model_vals = np.full(obs_depth.shape, np.nan)
    if in_window and not box.is_empty() and obs_depth.size:
        values, coords = cfd.select(variable, bbox=box, time=profile.time)
        # Mean over the colocation neighbourhood, per model level. Levels that
        # lie entirely below the seabed are legitimately all-NaN, so the
        # "empty slice" warning is expected here and would only mask real ones.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            column = np.nanmean(values, axis=(1, 2))
        model_depth = np.asarray(coords["depth"], dtype=float)
        good = np.isfinite(column)
        if good.sum() >= 2:
            # (b) interpolate model onto observation depths; no extrapolation
            # beyond the model's vertical range.
            md, mc = model_depth[good], column[good]
            model_vals = np.interp(obs_depth, md, mc, left=np.nan, right=np.nan)
            model_vals[(obs_depth < md.min()) | (obs_depth > md.max())] = np.nan

    # (d) statistics over levels where both exist
    both = np.isfinite(model_vals) & np.isfinite(obs_val)
    o, m = obs_val[both], model_vals[both]
    count = int(both.sum())

    if count >= 2:
        diff = m - o
        bias = float(np.mean(diff))
        rmse = float(np.sqrt(np.mean(diff**2)))
        mae = float(np.mean(np.abs(diff)))
        std_obs = float(np.std(o))
        std_model = float(np.std(m))
        if std_obs > 1e-9 and std_model > 1e-9:
            corr = float(np.corrcoef(o, m)[0, 1])
        else:
            corr = None
        # centred RMSE: the Taylor-diagram radial coordinate
        crmse = float(np.sqrt(np.mean(((m - m.mean()) - (o - o.mean())) ** 2)))
    else:
        bias = rmse = mae = corr = std_obs = std_model = crmse = None

    return MatchupResult(
        platform=profile.platform,
        id=profile.id,
        variable=variable,
        obsDepths=[float(d) for d in obs_depth],
        obsValues=[float(v) for v in obs_val],
        modelValues=[None if not np.isfinite(v) else float(v) for v in model_vals],
        bias=bias,
        rmse=rmse,
        mae=mae,
        corr=corr,
        n=count,
        stdObs=std_obs,
        stdModel=std_model,
        crmse=crmse,
        radiusKm=radius_km,
        windowHours=window_hours,
        qcFlagsUsed=list(qc_flags),
        modelSource=cfd.source,
        obsDataMode=profile.dataMode,
    )


def summarize(
    cfd: CFDataset,
    profiles: list[ObservationProfile],
    *,
    variable: str = "temperature",
    radius_km: float = 25.0,
    window_hours: float = 24.0,
) -> list[dict]:
    """Per-profile error magnitude across many profiles.

    Feeds the colour-encoding of instrument markers in block mode: a float's
    colour is its model-observation error, so the colour means information
    rather than decoration.
    """
    out: list[dict] = []
    for p in profiles:
        try:
            r = compute_matchup(
                cfd, p, variable=variable,
                radius_km=radius_km, window_hours=window_hours,
            )
        except KeyError:
            continue
        out.append({
            "platform": p.platform,
            "id": p.id,
            "lat": p.lat,
            "lon": p.lon,
            "time": p.time,
            "dataMode": p.dataMode,
            "bias": r.bias,
            "rmse": r.rmse,
            "n": r.n,
        })
    return out
