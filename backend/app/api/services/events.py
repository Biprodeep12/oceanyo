"""Extreme events in the record, and the honest limits of calling them heatwaves.

The Level 2 list pairs "event replay" with a "climatology anomaly + Hobday
marine-heatwave layer". Those are one feature: an event is a run of timesteps
during which an unusual fraction of the region sits beyond a climatological
threshold, and replaying it is playing that run.

**What this is not.** Hobday et al. (2016) define a marine heatwave as SST
above the seasonally varying 90th percentile of a 30-year DAILY climatology,
sustained for at least five consecutive days, with defined categories from the
distance to that percentile. Two of those three criteria cannot be evaluated
here and no amount of care will change that:

  * the climatology carries a mean and a standard deviation per month, not a
    percentile distribution, so the threshold below is a NORMAL APPROXIMATION
    to the 90th percentile (mean + 1.2816 sigma) rather than the percentile
    itself;
  * a monthly model cannot resolve a five-day duration criterion at all.

So the response calls these *exceedance events* and carries the reason. Naming
them marine heatwaves would be the single easiest way to lose the credibility
the matchup statistics earn, in front of the one audience most able to check.
The machinery is right and the threshold is the documented one; what is missing
is a daily record, which is a data question rather than a code question.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import numpy as np

from ...core.cf_adapter import CFDataset
from ...core.conventions import CANONICAL
from ...core.geometry import BBox
from .anomaly import anomaly_grid

log = logging.getLogger(__name__)

#: z at the 90th percentile of a normal distribution. Hobday's threshold is the
#: 90th percentile itself; this is what a mean and a standard deviation can say
#: about where that percentile lies.
P90_Z = 1.2816

#: Fraction of the region that must be beyond the threshold before a timestep
#: counts as part of an event. Below this it is a local patch, not a regional
#: event, and every step in a record would qualify for something.
AREA_FRACTION = 0.10


def _area_weights(lat: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """cos(latitude), broadcast over the grid.

    A degree of longitude is 111 km at the equator and 78 km at 45N. Without
    the weight a basin-wide mean over the Indian Ocean is pulled towards
    whichever end of the box has more grid cells per unit area, and the
    "regional anomaly" would partly be a statement about the projection.
    """
    w = np.cos(np.radians(lat))
    return np.repeat(w[:, None], shape[1], axis=1)


def scan(
    model: CFDataset,
    climatology: CFDataset,
    *,
    variable: str,
    bbox: BBox,
    depth: float,
    threshold: float = P90_Z,
) -> list[dict[str, Any]]:
    """One row per timestep: how anomalous the region was, and over how much of it."""
    rows: list[dict[str, Any]] = []
    for t in model.time_strings():
        try:
            g = anomaly_grid(
                model, climatology, variable=variable, bbox=bbox, time=t, depth=depth
            )
        except Exception as exc:
            log.info("events: step %s unavailable (%s)", t, exc)
            continue

        z = g.z
        finite = np.isfinite(z)
        if not finite.any():
            continue
        w = _area_weights(g.lat, z.shape)
        wf = w * finite
        total = float(wf.sum())
        if total <= 0:
            continue

        mean_z = float(np.nansum(np.where(finite, z * w, 0.0)) / total)
        warm = float(np.nansum(np.where(finite & (z >= threshold), w, 0.0)) / total)
        cool = float(np.nansum(np.where(finite & (z <= -threshold), w, 0.0)) / total)
        diff = g.diff
        mean_diff = float(
            np.nansum(np.where(np.isfinite(diff), diff * w, 0.0))
            / max(float((w * np.isfinite(diff)).sum()), 1e-9)
        )

        rows.append({
            "time": t,
            "meanZ": round(mean_z, 4),
            "meanAnomaly": round(mean_diff, 4),
            "warmFraction": round(warm, 4),
            "coolFraction": round(cool, 4),
            "kind": (
                "warm" if warm >= AREA_FRACTION and warm > cool
                else "cool" if cool >= AREA_FRACTION
                else None
            ),
        })
    return rows


def find_events(
    model: CFDataset,
    climatology: CFDataset,
    *,
    variable: str,
    bbox: BBox,
    depth: float = 0.0,
    threshold: float = P90_Z,
    limit: int = 8,
) -> dict[str, Any]:
    """Group consecutive exceedance steps into events, ranked by severity."""
    rows = scan(
        model, climatology, variable=variable, bbox=bbox, depth=depth, threshold=threshold
    )
    times = [r["time"] for r in rows]

    events: list[dict[str, Any]] = []
    run: list[dict[str, Any]] = []

    def close_run() -> None:
        if not run:
            return
        kind = run[0]["kind"]
        key = "warmFraction" if kind == "warm" else "coolFraction"
        peak = max(run, key=lambda r: r[key])
        area = max(r[key] for r in run)
        events.append({
            "kind": kind,
            "start": run[0]["time"],
            "end": run[-1]["time"],
            "steps": len(run),
            "startIndex": times.index(run[0]["time"]),
            "endIndex": times.index(run[-1]["time"]),
            "peakTime": peak["time"],
            "peakIndex": times.index(peak["time"]),
            "peakZ": peak["meanZ"],
            "peakAnomaly": peak["meanAnomaly"],
            "peakArea": round(area, 4),
            # Severity ranks a broad mild event against a narrow intense one.
            # Area alone would rank a basin-wide 0.1 sigma drift above a
            # localised extreme; |z| alone would do the reverse.
            "severity": round(abs(peak["meanZ"]) * area * len(run), 4),
        })
        run.clear()

    for r in rows:
        if r["kind"] is None:
            close_run()
        elif run and run[-1]["kind"] != r["kind"]:
            close_run()
            run.append(r)
        else:
            run.append(r)
    close_run()

    events.sort(key=lambda e: e["severity"], reverse=True)

    return {
        "variable": variable,
        "units": CANONICAL[variable].units,
        "depth": depth,
        "bbox": bbox.as_list(),
        "thresholdZ": threshold,
        "areaFraction": AREA_FRACTION,
        "steps": rows,
        "events": events[:limit],
        # Carried in the payload, not only in the UI, so it travels with an
        # export or a screenshot of the response.
        "method": (
            "Exceedance of a normal approximation to the climatological 90th "
            f"percentile (mean + {threshold} sigma), over at least "
            f"{int(AREA_FRACTION * 100)}% of the region by area."
        ),
        "notHobday": (
            "Not a Hobday et al. (2016) marine heatwave. That definition needs "
            "the 90th percentile of a 30-year daily climatology and a five-day "
            "minimum duration; this climatology stores monthly mean and standard "
            "deviation, and this model is monthly, so neither criterion can be "
            "evaluated. The threshold and the area test are the documented ones; "
            "the duration test is absent."
        ),
    }
