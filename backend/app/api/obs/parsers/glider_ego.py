"""EGO glider NetCDF parser.

Real EGO GDAC files are a **time series**, not a stack of profiles. One file
per deployment carries a single `TIME` dimension -- 66,000 samples for a
two-week deployment, 707,000 for a long one -- with `PHASE` marking what the
glider was doing at each instant (EGO reference table 9: 1 = descent,
4 = ascent). Profiles are something you *derive* from that by cutting the
series at the inflexions.

The synthetic generator writes the profile-shaped variant, `(N_PROF,
N_LEVELS)`, which some processed EGO products also use. Both are handled here,
because assuming either one is how a parser ends up reading only its own
files: pointed at a real GDAC deployment, the profile-shaped path treated all
66,000 samples as a single profile and reported one dive from the surface to
1000 m and back.

Unlike an Argo float, a glider has a meaningful trajectory, so this parser
populates `ObservationProfile.trajectory` -- which block mode draws as a curve
through the water column.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import xarray as xr

from ....core.geometry import BBox
from ....core.models import ObservationProfile, ParserCapabilities, ProfileVariable
from ....core.netcdf import cached_dataset
from ..qc import decode_qc
from ..registry import REGISTRY, ProfileRef
from ..timeutil import epoch_to_iso, juld_to_iso

log = logging.getLogger(__name__)

VAR_MAP = {"TEMP": "temperature", "PSAL": "salinity"}

# EGO reference table 9. Only the two phases that describe a profile.
PHASE_DESCENT = 1
PHASE_ASCENT = 4

#: A dive shorter or shallower than this is a wiggle at the surface, not a
#: profile worth comparing against a model.
MIN_SAMPLES = 25
MIN_SPAN_DBAR = 25.0

#: A single dive can carry thousands of samples at 1 Hz. The model has 40
#: levels; several hundred is already more than any comparison needs, and the
#: whole series would otherwise cross the wire.
MAX_LEVELS = 400
MAX_TRACK_POINTS = 400


def _scalar_str(ds: xr.Dataset, name: str, default: str = "") -> str:
    if name not in ds:
        return default
    v = ds[name].values
    try:
        item = v.item() if getattr(v, "size", 1) == 1 else v[0]
    except (ValueError, IndexError):
        return default
    if isinstance(item, bytes):
        return item.decode("utf-8", "ignore").strip()
    return str(item).strip()


def _is_timeseries(ds: xr.Dataset) -> bool:
    """True for the real GDAC layout: PRES varying along TIME alone."""
    if "PRES" not in ds:
        return False
    return ds["PRES"].ndim == 1 and "TIME" in ds["PRES"].dims


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Contiguous [start, stop) spans where `mask` is True."""
    if mask.size == 0 or not mask.any():
        return []
    edges = np.flatnonzero(np.diff(mask.astype(np.int8)))
    starts = [0] if mask[0] else []
    stops: list[int] = []
    for e in edges:
        if mask[e + 1]:
            starts.append(int(e) + 1)
        else:
            stops.append(int(e) + 1)
    if mask[-1]:
        stops.append(int(mask.size))
    return list(zip(starts, stops))


def _segments(pres: np.ndarray, phase: np.ndarray | None) -> list[tuple[int, int, str]]:
    """Cut a deployment time series into dives and climbs.

    Uses PHASE when the file provides it: that is the format's own answer, and
    it already accounts for surface drift, inflexions and grounding. Falls back
    to monotonic runs of pressure -- which is what PHASE encodes anyway -- for
    files that omit it.
    """
    found: list[tuple[int, int, str]] = []

    if phase is not None:
        for code, direction in ((PHASE_DESCENT, "descent"), (PHASE_ASCENT, "ascent")):
            for a, b in _runs(phase == code):
                found.append((a, b, direction))
    else:
        filled = np.where(np.isfinite(pres), pres, np.nan)
        delta = np.diff(filled)
        delta = np.where(np.isfinite(delta), delta, 0.0)
        # Smoothed over a few samples so sensor jitter around a constant depth
        # does not split one dive into hundreds of fragments.
        window = 9
        smooth = np.convolve(delta, np.ones(window) / window, mode="same")
        for a, b in _runs(smooth > 0):
            found.append((a, b + 1, "descent"))
        for a, b in _runs(smooth < 0):
            found.append((a, b + 1, "ascent"))

    kept: list[tuple[int, int, str]] = []
    for a, b, direction in found:
        if b - a < MIN_SAMPLES:
            continue
        window_pres = pres[a:b]
        finite = window_pres[np.isfinite(window_pres)]
        if finite.size < MIN_SAMPLES or float(finite.max() - finite.min()) < MIN_SPAN_DBAR:
            continue
        kept.append((a, b, direction))
    kept.sort(key=lambda s: s[0])
    return kept


def _fill_positions(values: np.ndarray) -> np.ndarray:
    """Interpolate across the gaps between GPS fixes.

    A glider is only positioned at the surface, so LATITUDE and LONGITUDE are
    mostly fill between dives. Interpolating gives every sample a position that
    is at least honest about being between two fixes.
    """
    good = np.isfinite(values)
    if not good.any():
        return values
    idx = np.arange(len(values))
    return np.interp(idx, idx[good], values[good])


class _Deployment:
    """One opened EGO time-series file, segmented into profiles."""

    __slots__ = ("code", "mode", "segments", "lat", "lon", "time_iso", "source")

    def __init__(self, ds: xr.Dataset, path: Path) -> None:
        self.code = (
            _scalar_str(ds, "PLATFORM_CODE")
            or str(ds.attrs.get("platform_code", ""))
            or path.stem
        )
        self.mode = _scalar_str(ds, "DATA_MODE", "R") or "R"
        self.source = str(ds.attrs.get("source", ds.attrs.get("title", "EGO glider")))

        pres = np.asarray(ds["PRES"].values, dtype=float)
        phase = np.asarray(ds["PHASE"].values, dtype=float) if "PHASE" in ds else None
        self.segments = _segments(pres, phase)
        self.lat = _fill_positions(np.asarray(ds["LATITUDE"].values, dtype=float))
        self.lon = _fill_positions(np.asarray(ds["LONGITUDE"].values, dtype=float))

        time_var = "TIME" if "TIME" in ds else ("JULD" if "JULD" in ds else None)
        units = str(ds[time_var].attrs.get("units", "")) if time_var else ""
        raw = np.asarray(ds[time_var].values) if time_var else np.zeros(len(pres))
        # Only segment start times are ever needed, and decoding 700k
        # timestamps costs more than the rest of the parse combined.
        self.time_iso = {a: epoch_to_iso(raw[a], units) for a, _, _ in self.segments}


#: Segmenting a 700k-sample deployment is not free, and discover() and load()
#: both need it. Keyed on (path, mtime) so an updated file is re-read.
_cache: dict[tuple[str, float], _Deployment] = {}


def _deployment(path: Path, ds: xr.Dataset) -> _Deployment:
    key = (str(path), path.stat().st_mtime)
    hit = _cache.get(key)
    if hit is None:
        hit = _Deployment(ds, path)
        _cache.clear()  # these hold whole deployments; one at a time is enough
        _cache[key] = hit
    return hit


@REGISTRY.register
class GliderEGOParser:
    parser_id = "glider_ego"
    platform = "glider"

    def capabilities(self) -> ParserCapabilities:
        return ParserCapabilities(
            platform=self.platform,
            variables=sorted(VAR_MAP.values()),
            depthRange=(0.0, 1000.0),
            hasTrajectory=True,
            qcScheme="argo",
            dataModes=["R", "A", "D"],
            description="EGO glider NetCDF. Reads the real GDAC time-series "
                        "layout, cutting dives and climbs at the PHASE "
                        "inflexions, and the profile-shaped variant.",
        )

    # -- discovery --------------------------------------------------------
    def discover(
        self, root: Path, bbox: BBox | None, t0: str | None, t1: str | None
    ) -> list[ProfileRef]:
        refs: list[ProfileRef] = []
        if not root.exists():
            log.warning("glider root does not exist: %s", root)
            return refs

        for path in sorted(root.glob("*.nc")):
            try:
                with cached_dataset(path) as ds:
                    if _is_timeseries(ds):
                        refs.extend(self._discover_timeseries(ds, path, bbox, t0, t1))
                    else:
                        refs.extend(self._discover_profiles(ds, path, bbox, t0, t1))
            except Exception as exc:
                log.warning("skipping unreadable glider file %s: %s", path.name, exc)
        return refs

    def _discover_timeseries(
        self,
        ds: xr.Dataset,
        path: Path,
        bbox: BBox | None,
        t0: str | None,
        t1: str | None,
    ) -> list[ProfileRef]:
        dep = _deployment(path, ds)
        refs: list[ProfileRef] = []
        for n, (a, b, _direction) in enumerate(dep.segments):
            lat = float(np.nanmedian(dep.lat[a:b]))
            lon = float(np.nanmedian(dep.lon[a:b]))
            if not (np.isfinite(lat) and np.isfinite(lon)):
                continue
            if bbox is not None and not (
                bbox.west <= lon <= bbox.east and bbox.south <= lat <= bbox.north
            ):
                continue
            iso = dep.time_iso.get(a, "")
            if (t0 and iso < t0) or (t1 and iso > t1):
                continue
            refs.append(
                ProfileRef(
                    platform=self.platform,
                    id=f"{dep.code}:{n}",
                    lat=lat,
                    lon=lon,
                    time=iso,
                    path=path,
                    index=n,
                    data_mode=dep.mode,
                )
            )
        return refs

    def _discover_profiles(
        self,
        ds: xr.Dataset,
        path: Path,
        bbox: BBox | None,
        t0: str | None,
        t1: str | None,
    ) -> list[ProfileRef]:
        code = _scalar_str(ds, "PLATFORM_CODE", path.stem)
        mode = _scalar_str(ds, "DATA_MODE", "R") or "R"
        lats = np.atleast_1d(ds["LATITUDE"].values)
        lons = np.atleast_1d(ds["LONGITUDE"].values)
        julds = np.atleast_1d(ds["JULD"].values)

        refs: list[ProfileRef] = []
        for i in range(len(julds)):
            lat, lon = float(lats[i]), float(lons[i])
            if bbox is not None and not (
                bbox.west <= lon <= bbox.east and bbox.south <= lat <= bbox.north
            ):
                continue
            iso = juld_to_iso(julds[i])
            if (t0 and iso < t0) or (t1 and iso > t1):
                continue
            refs.append(
                ProfileRef(
                    platform=self.platform,
                    id=f"{code}:{i}",
                    lat=lat,
                    lon=lon,
                    time=iso,
                    path=path,
                    index=i,
                    data_mode=mode,
                )
            )
        return refs

    # -- loading ----------------------------------------------------------
    def load(self, ref: ProfileRef) -> ObservationProfile:
        with cached_dataset(ref.path) as ds:
            if _is_timeseries(ds):
                return self._load_timeseries(ds, ref)
            return self._load_profile(ds, ref)

    def _load_timeseries(self, ds: xr.Dataset, ref: ProfileRef) -> ObservationProfile:
        dep = _deployment(ref.path, ds)
        a, b, _direction = dep.segments[ref.index]

        pres = np.asarray(ds["PRES"].values[a:b], dtype=float)
        keep = np.isfinite(pres) & (pres >= 0)
        # A climb runs deep to shallow. Every consumer -- the matchup
        # interpolation, the profile chart, the 3D column -- assumes depth
        # ascends, so sort here rather than leaving it to each of them.
        order = np.argsort(pres[keep], kind="stable")
        stride = max(1, int(np.ceil(order.size / MAX_LEVELS)))
        order = order[::stride]

        variables: dict[str, ProfileVariable] = {}
        for raw, canonical in VAR_MAP.items():
            if raw not in ds:
                continue
            vals = np.asarray(ds[raw].values[a:b], dtype=float)[keep][order]
            qc_name = f"{raw}_QC"
            if qc_name in ds:
                flags = decode_qc(
                    np.asarray(ds[qc_name].values[a:b])[keep][order], len(vals)
                )
            else:
                flags = [1 if np.isfinite(v) else 9 for v in vals]
            variables[canonical] = ProfileVariable(
                units=str(ds[raw].attrs.get("units", "")),
                values=[None if not np.isfinite(v) else float(v) for v in vals],
                qc=flags,
            )

        time_var = "TIME" if "TIME" in ds else "JULD"
        units = str(ds[time_var].attrs.get("units", ""))
        raw_time = np.asarray(ds[time_var].values)
        # The flight path is one point per dive, not one per sample: 66,000
        # positions would be a megabyte of JSON to draw a line nobody can see
        # the detail of.
        step = max(1, len(dep.segments) // MAX_TRACK_POINTS)
        trajectory = [
            {
                "lat": float(dep.lat[s]),
                "lon": float(dep.lon[s]),
                "time": epoch_to_iso(raw_time[s], units),
            }
            for s, _, _ in dep.segments[::step]
            if np.isfinite(dep.lat[s]) and np.isfinite(dep.lon[s])
        ]

        return ObservationProfile(
            platform=self.platform,
            id=ref.id,
            lat=ref.lat,
            lon=ref.lon,
            time=ref.time,
            depth=[float(d) for d in pres[keep][order]],
            variables=variables,
            trajectory=trajectory,
            dataMode=dep.mode if dep.mode in ("R", "A", "D") else "R",
            source=dep.source,
        )

    def _load_profile(self, ds: xr.Dataset, ref: ProfileRef) -> ObservationProfile:
        i = ref.index
        pres = np.atleast_2d(ds["PRES"].values)[i].astype(float)
        keep = np.isfinite(pres)

        variables: dict[str, ProfileVariable] = {}
        for raw, canonical in VAR_MAP.items():
            if raw not in ds:
                continue
            vals = np.atleast_2d(ds[raw].values)[i].astype(float)
            qc_name = f"{raw}_QC"
            # EGO stores QC as characters, exactly as Argo does, so the same
            # tolerant decode applies -- see obs/qc.py.
            if qc_name in ds:
                flags = decode_qc(np.atleast_2d(ds[qc_name].values)[i], len(vals))
            else:
                flags = [1 if np.isfinite(v) else 9 for v in vals]
            variables[canonical] = ProfileVariable(
                units=str(ds[raw].attrs.get("units", "")),
                values=[None if not np.isfinite(v) else float(v) for v in vals[keep]],
                qc=[f for f, k in zip(flags, keep) if k],
            )

        # The whole deployment track, so block mode can draw the flight path.
        lats = np.atleast_1d(ds["LATITUDE"].values)
        lons = np.atleast_1d(ds["LONGITUDE"].values)
        julds = np.atleast_1d(ds["JULD"].values)
        trajectory = [
            {"lat": float(la), "lon": float(lo), "time": juld_to_iso(j)}
            for la, lo, j in zip(lats, lons, julds)
        ]

        mode = _scalar_str(ds, "DATA_MODE", ref.data_mode) or "R"
        return ObservationProfile(
            platform=self.platform,
            id=ref.id,
            lat=ref.lat,
            lon=ref.lon,
            time=ref.time,
            depth=[float(d) for d in pres[keep]],
            variables=variables,
            trajectory=trajectory,
            dataMode=mode if mode in ("R", "A", "D") else "R",
            source=str(ds.attrs.get("source", "EGO glider")),
        )
