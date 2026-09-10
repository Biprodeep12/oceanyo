"""CFDataset - a name-agnostic, orientation-normalized view of any CF dataset.

Everything downstream of this module sees the same shape regardless of whether
the bytes came from the synthetic generator or from GLORYS12. That is the whole
point: `select()` is the single place where axis order, axis direction and the
`positive="down"` convention are settled.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import cf_xarray  # noqa: F401  -- registers the .cf accessor
import numpy as np
import pandas as pd
import xarray as xr

from .conventions import CANONICAL, CanonicalVar, resolve
from .geometry import BBox, DepthRange
from .netcdf import open_dataset

log = logging.getLogger(__name__)



def snap_bbox_to_grid(box: BBox, lons: np.ndarray, lats: np.ndarray) -> BBox:
    """Widen a bbox until it certainly contains at least one grid cell.

    `.sel(slice(a, b))` returns an EMPTY array when no coordinate falls between
    a and b, and a box smaller than one cell frequently does not. Everything
    downstream then works on a zero-length axis: `lons[0]` raises IndexError,
    `nanmean` over an empty slice is NaN, the quantizer divides by a zero range.
    The result is a 500 from four separate endpoints.

    This is not a hypothetical. Dragging a selection rectangle emits a request
    on every mouse move, and the first few are a few pixels across -- far below
    a 2 arc-minute bathymetry cell, or a 0.48 degree model cell. So the very
    first thing a user does produces the degenerate case.

    Asking for less than one cell is a reasonable thing to do; the honest answer
    is the cell you are pointing at, not an error.
    """
    west, east = box.west, box.east
    south, north = box.south, box.north
    if lons.size > 1:
        step = float(np.median(np.abs(np.diff(lons))))
        if step > 0 and (east - west) < step:
            mid = 0.5 * (west + east)
            west, east = mid - step * 0.55, mid + step * 0.55
    if lats.size > 1:
        step = float(np.median(np.abs(np.diff(lats))))
        if step > 0 and (north - south) < step:
            mid = 0.5 * (south + north)
            south, north = mid - step * 0.55, mid + step * 0.55
    return BBox(west, south, east, north)

@dataclass(frozen=True)
class Axes:
    """Resolved coordinate variable names for one dataset."""

    lon: str
    lat: str
    depth: str | None
    time: str | None
    positive_down: bool = True


def _find_axis(ds: xr.Dataset, cf_key: str, fallbacks: tuple[str, ...]) -> str | None:
    """Resolve one coordinate: cf-xarray first, then common raw names."""
    try:
        found = ds.cf[cf_key]
        name = found.name
        if name in ds.variables or name in ds.coords:
            return str(name)
    except (KeyError, ValueError, AttributeError):
        pass
    for cand in fallbacks:
        if cand in ds.coords or cand in ds.variables:
            return cand
    return None


def detect_axes(ds: xr.Dataset) -> Axes:
    lon = _find_axis(ds, "longitude", ("longitude", "lon", "x", "nav_lon"))
    lat = _find_axis(ds, "latitude", ("latitude", "lat", "y", "nav_lat"))
    depth = _find_axis(ds, "vertical", ("depth", "deptht", "lev", "z", "elevation"))
    time = _find_axis(ds, "time", ("time", "time_counter", "t"))

    if lon is None or lat is None:
        raise ValueError(
            "could not detect longitude/latitude axes; dataset is not CF-compliant "
            f"(coords: {list(ds.coords)})"
        )

    positive_down = True
    if depth is not None:
        pos = str(ds[depth].attrs.get("positive", "")).lower()
        if pos == "up":
            positive_down = False
        elif pos != "down":
            # No explicit attribute. Infer: oceanographic depth axes are almost
            # always non-negative and increasing downward.
            vals = np.asarray(ds[depth].values, dtype=float)
            positive_down = bool(np.nanmin(vals) >= -1e-6)
            log.warning(
                "depth axis %r lacks a positive= attribute; inferred positive_down=%s",
                depth,
                positive_down,
            )
    return Axes(lon=lon, lat=lat, depth=depth, time=time, positive_down=positive_down)


class CFDataset:
    """Opened dataset plus its resolved axes and canonical variable mapping."""

    def __init__(
        self,
        ds: xr.Dataset,
        *,
        source: str,
        synthetic: bool,
        var_map: dict[str, str] | None = None,
        uri: str = "",
    ) -> None:
        self.ds = ds
        self.source = source
        self.synthetic = synthetic
        self.uri = uri
        self.axes = detect_axes(ds)
        self._explicit = dict(var_map or {})
        self._resolved: dict[str, str] = {}
        self._resolve_variables()

    # -- construction ----------------------------------------------------
    @classmethod
    def open(
        cls,
        uri: str | Path,
        *,
        source: str,
        synthetic: bool,
        var_map: dict[str, str] | None = None,
        engine: str | None = None,
        load: bool = True,
    ) -> "CFDataset":
        """Open a NetCDF file.

        The engine is sniffed from the file's magic bytes unless the catalog
        forces one. h5netcdf is preferred where both work: the netcdf4 engine's
        HDF5 file locking throws opaque errors on Windows when uvicorn --reload
        spawns a second process while the first still holds the handle. But it
        cannot read NetCDF-3 classic at all, which is what the real Argo GDAC
        serves -- so the choice has to be made per file, not per project.
        """
        path = Path(uri)
        if not path.exists():
            raise FileNotFoundError(f"dataset not found: {path}  (run: npm run synth)")
        ds = open_dataset(path, engine=engine)
        if load:
            # The whole synthetic dataset fits in RAM and there is exactly one
            # concurrent user, so an eager load beats lazy chunked reads here.
            ds = ds.load()
        return cls(ds, source=source, synthetic=synthetic, var_map=var_map, uri=str(path))

    # -- variable resolution ---------------------------------------------
    def _resolve_variables(self) -> None:
        """Map canonical keys -> raw variable names.

        Order: explicit override -> standard_name -> raw/GLORYS name. The
        winning path is logged so provenance stays auditable.
        """
        for key, cv in CANONICAL.items():
            if key in self._explicit:
                raw = self._explicit[key]
                if raw in self.ds.data_vars:
                    self._resolved[key] = raw
                    log.debug("resolved %s -> %s (explicit)", key, raw)
                continue
            hit = None
            for name, da in self.ds.data_vars.items():
                sn = str(da.attrs.get("standard_name", ""))
                if sn and (sn == cv.standard_name or sn in cv.aliases):
                    hit = str(name)
                    break
            if hit is None and cv.glorys_name in self.ds.data_vars:
                hit = cv.glorys_name
            if hit is not None:
                self._resolved[key] = hit
                log.debug("resolved %s -> %s", key, hit)
        #: canonical -> (vmin, vmax), computed once. See data_range().
        self._range_cache: dict[str, tuple[float, float]] = {}

    def canonical_vars(self) -> list[str]:
        return list(self._resolved)

    def raw_name(self, canonical: str) -> str:
        if canonical not in self._resolved:
            raise KeyError(f"variable {canonical!r} not present in {self.uri}")
        return self._resolved[canonical]

    def meta(self, canonical: str) -> CanonicalVar:
        cv = resolve(canonical)
        if cv is None:
            raise KeyError(f"unknown canonical variable {canonical!r}")
        return cv

    # -- axis helpers -----------------------------------------------------
    @property
    def lons(self) -> np.ndarray:
        return np.asarray(self.ds[self.axes.lon].values, dtype=float)

    @property
    def lats(self) -> np.ndarray:
        return np.asarray(self.ds[self.axes.lat].values, dtype=float)

    @property
    def depths(self) -> np.ndarray:
        if self.axes.depth is None:
            return np.array([0.0])
        d = np.asarray(self.ds[self.axes.depth].values, dtype=float)
        return d if self.axes.positive_down else -d

    @property
    def times(self) -> np.ndarray:
        if self.axes.time is None:
            return np.array([])
        return self.ds[self.axes.time].values

    def time_strings(self) -> list[str]:
        if self.axes.time is None:
            return []
        return [pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ") for t in self.times]

    def nearest_time(self, iso: str | None):
        """Snap a requested timestamp to the nearest available step."""
        if self.axes.time is None:
            return None
        times = pd.to_datetime(self.times)
        if iso is None:
            return times[0]
        target = pd.Timestamp(iso)
        if target.tzinfo is not None:
            target = target.tz_convert(None)
        idx = int(np.argmin(np.abs(times.values - np.datetime64(target))))
        return times[idx]

    def step_hours(self) -> float | None:
        """Median spacing between timesteps, in hours.

        Callers that colocate in time need this: a 24 h window is right for a
        daily model and rejects every observation against a monthly one, where
        the nearest step can legitimately be a fortnight away.
        """
        t = self.times
        if t is None or len(t) < 2:
            return None
        vals = pd.to_datetime(t).values.astype("datetime64[s]").astype("int64")
        gaps = np.diff(np.sort(vals))
        gaps = gaps[gaps > 0]
        if gaps.size == 0:
            return None
        return float(np.median(gaps)) / 3600.0

    def data_range(self, canonical: str) -> tuple[float, float]:
        """The range this variable ACTUALLY spans, dataset-wide, cached.

        Not the same thing as the validity range, and the difference is
        visible: temperature is valid from -2 to 36 degC, and this Indian Ocean
        subset spans 3.7 to 34.8. Colouring the volume over the validity range
        squeezed the entire deep ocean -- everything below the thermocline --
        into the bottom sixth of the ramp, so a block that should show a
        thermocline showed a flat purple wall with an orange lid.

        Still DATASET-WIDE rather than per-request, which was the original and
        correct reason for not using subset statistics: a range that follows
        the current slice makes the colours shift every time the depth slider
        or the timeline moves, and the volume appears to flicker between
        frames. This keeps that property and fixes the range.

        Percentiles rather than min/max: one bad cell at 40 degC would undo the
        whole point, and 0.5/99.5 is far enough into the tails to keep genuine
        extremes.
        """
        hit = self._range_cache.get(canonical)
        if hit is not None:
            return hit

        raw = self.raw_name(canonical)
        da = self.ds[raw]
        # Decimate hard. A range needs a distribution, not every cell: this is
        # a few thousand samples spread over the whole grid, which lands within
        # a few hundredths of the exact percentile and costs milliseconds.
        step = {d: max(1, size // 24) for d, size in da.sizes.items()}
        sampled = da.isel({d: slice(None, None, k) for d, k in step.items()})
        values = np.asarray(sampled.values, dtype="float64").ravel()
        finite = values[np.isfinite(values)]

        cv = CANONICAL.get(canonical)
        fallback = cv.valid if cv else (0.0, 1.0)
        if finite.size < 16:
            out = (float(fallback[0]), float(fallback[1]))
        else:
            lo = float(np.percentile(finite, 0.5))
            hi = float(np.percentile(finite, 99.5))
            if not (hi > lo):
                out = (float(fallback[0]), float(fallback[1]))
            else:
                # Clamp into the validity range: a corrupt cell can drag a
                # percentile somewhere physically impossible, and the colour
                # bar is read as a statement about the ocean.
                out = (
                    max(float(fallback[0]), lo),
                    min(float(fallback[1]), hi),
                )
        self._range_cache[canonical] = out
        log.info("%s data range %.2f..%.2f (valid %.1f..%.1f)",
                 canonical, out[0], out[1], fallback[0], fallback[1])
        return out

    def bbox(self) -> BBox:
        return BBox(
            float(self.lons.min()),
            float(self.lats.min()),
            float(self.lons.max()),
            float(self.lats.max()),
        )

    def depth_range(self) -> DepthRange:
        d = self.depths
        return DepthRange(float(d.min()), float(d.max()))

    # -- the orientation contract ----------------------------------------
    def select(
        self,
        canonical: str,
        *,
        bbox: BBox | None = None,
        time: str | None = None,
        depth: float | None = None,
        depth_range: DepthRange | None = None,
        max_shape: tuple[int, int, int] | None = None,
    ) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        """Return (values, coords) with dims ALWAYS ordered (depth, lat, lon).

        depth ascends downward, lat ascends north, lon ascends east. If `depth`
        is given, the depth dimension is retained with length 1 so callers never
        have to branch on dimensionality.

        This ordering is held end to end -- a transposed volume looks like a
        rendering fault rather than an indexing one, so it is settled here once.
        """
        raw = self.raw_name(canonical)
        da = self.ds[raw]
        ax = self.axes

        # --- time ---
        if ax.time is not None and ax.time in da.dims:
            da = da.sel({ax.time: self.nearest_time(time)}, method="nearest")

        # --- horizontal subset (slice bounds must follow axis direction) ---
        if bbox is not None:
            # Never let a sub-gridscale request select nothing.
            bbox = snap_bbox_to_grid(bbox, self.lons, self.lats)
            lon_asc = bool(self.lons[0] <= self.lons[-1])
            lat_asc = bool(self.lats[0] <= self.lats[-1])
            lon_sl = slice(bbox.west, bbox.east) if lon_asc else slice(bbox.east, bbox.west)
            lat_sl = slice(bbox.south, bbox.north) if lat_asc else slice(bbox.north, bbox.south)
            da = da.sel({ax.lon: lon_sl, ax.lat: lat_sl})

        # --- vertical subset ---
        depth_dim = ax.depth
        if depth_dim is not None and depth_dim in da.dims:
            if depth is not None:
                da = da.sel({depth_dim: depth}, method="nearest")
                da = da.expand_dims(depth_dim)
            elif depth_range is not None:
                d_asc = bool(self.depths[0] <= self.depths[-1])
                sl = (
                    slice(depth_range.top, depth_range.bottom)
                    if d_asc
                    else slice(depth_range.bottom, depth_range.top)
                )
                da = da.sel({depth_dim: sl})
        elif depth_dim is None or depth_dim not in da.dims:
            depth_dim = "depth"
            if depth_dim not in da.dims:
                da = da.expand_dims(depth_dim)

        # --- canonical dim order ---
        dim_order = [d for d in (depth_dim, ax.lat, ax.lon) if d in da.dims]
        da = da.transpose(*dim_order)

        # --- force ascending axes ---
        for name in dim_order:
            if name not in da.coords:
                continue
            vals = np.asarray(da[name].values, dtype=float)
            if vals.size > 1 and vals[0] > vals[-1]:
                da = da.isel({name: slice(None, None, -1)})

        # --- decimate to the LOD budget (strided, not interpolated: ~20x
        #     faster and visually identical at these ratios) ---
        if max_shape is not None:
            steps = {}
            for name, cap in zip(dim_order, max_shape):
                n = da.sizes[name]
                if cap > 0 and n > cap:
                    steps[name] = slice(None, None, int(np.ceil(n / cap)))
            if steps:
                da = da.isel(steps)

        values = np.asarray(da.values, dtype=np.float32)
        if values.ndim == 2:
            values = values[np.newaxis, ...]

        coords: dict[str, np.ndarray] = {
            "lon": np.asarray(da[ax.lon].values, dtype=float),
            "lat": np.asarray(da[ax.lat].values, dtype=float),
        }
        if depth_dim in da.coords:
            dv = np.asarray(da[depth_dim].values, dtype=float)
            coords["depth"] = dv if ax.positive_down else -dv
        else:
            coords["depth"] = np.array([0.0])

        return values, coords

    # -- arbitrary track sampling ----------------------------------------
    def sample_track(
        self,
        canonical: str,
        lons: np.ndarray,
        lats: np.ndarray,
        *,
        time: str | None = None,
        depth_range: DepthRange | None = None,
        max_levels: int | None = None,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Bilinearly sample one variable along an arbitrary horizontal track.

        Returns (values, depths) with values shaped (depth, n_points) and depth
        ascending downward -- the same vertical orientation `select` guarantees,
        so a vertical section drops straight into block space with no extra
        flipping.

        Interpolation rather than nearest neighbour: a section is read as a
        continuous curtain, and nearest sampling turns a smooth thermocline
        into a staircase at the grid resolution. NaN propagates, so the section
        stops at the seabed by itself.
        """
        raw = self.raw_name(canonical)
        da = self.ds[raw]
        ax = self.axes

        if ax.time is not None and ax.time in da.dims:
            da = da.sel({ax.time: self.nearest_time(time)}, method="nearest")

        depth_dim = ax.depth if (ax.depth and ax.depth in da.dims) else None
        if depth_dim is not None:
            if depth_range is not None:
                d_asc = bool(self.depths[0] <= self.depths[-1])
                sl = (
                    slice(depth_range.top, depth_range.bottom)
                    if d_asc
                    else slice(depth_range.bottom, depth_range.top)
                )
                da = da.sel({depth_dim: sl})
            n = da.sizes[depth_dim]
            if max_levels and n > max_levels:
                da = da.isel({depth_dim: slice(None, None, int(np.ceil(n / max_levels)))})

        # scipy's interpolator requires ascending coordinates; a descending
        # latitude axis (common in real products) otherwise returns all-NaN
        # with no error at all.
        sort_by = [c for c in (ax.lat, ax.lon) if c in da.coords]
        if sort_by:
            da = da.sortby(sort_by)

        # Two DataArrays sharing a dimension makes this POINTWISE interpolation
        # along the track, not an outer product over the two axes.
        track = da.interp(
            {
                ax.lon: xr.DataArray(np.asarray(lons, dtype=float), dims="s"),
                ax.lat: xr.DataArray(np.asarray(lats, dtype=float), dims="s"),
            },
            method="linear",
        )

        if depth_dim is None:
            return np.asarray(track.values, dtype=np.float32)[np.newaxis, :], np.array([0.0])

        track = track.transpose(depth_dim, "s")
        dv = np.asarray(track[depth_dim].values, dtype=float)
        if not ax.positive_down:
            dv = -dv
        order = np.argsort(dv)
        return np.asarray(track.values, dtype=np.float32)[order], dv[order]
