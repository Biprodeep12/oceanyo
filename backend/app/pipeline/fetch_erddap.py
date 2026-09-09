"""Fetch the two REAL datasets HYCOM does not carry: chlorophyll and bathymetry.

Both come from NOAA ERDDAP, which is the least ceremonious data server in
oceanography: a griddap URL *is* the subset request, it returns real NetCDF,
and it needs no account, no token and no client library.

    chlorophyll   nesdisVHNnoaaSNPPnoaa20chlaGapfilledDaily
                  VIIRS SNPP + NOAA-20, DINEOF gap-filled, ~1/12 deg, daily,
                  2018-05-30 to present.
                  Gap-filled matters more than it sounds: raw ocean colour over
                  the Bay of Bengal in January is mostly cloud, and a
                  chlorophyll layer that is 70% holes reads as a broken
                  renderer rather than as missing data.

    bathymetry    ETOPO_2022_v1_15s
                  NOAA NCEI ETOPO 2022, 15 arc-second -- the same resolution
                  class as the GEBCO_2024 grid the spec names, and reachable
                  without the GEBCO download form. Elevation is metres,
                  negative below sea level: the same sign convention GEBCO
                  uses, so `services/bathymetry` needs no special case.

GLORYS12 is physics-only and carries no biogeochemistry, which is precisely why
the spec warns that chlorophyll needs its own product on its own grid. That is
still true here, so the chlorophyll file stays a separate dataset with its own
axes rather than being regridded onto the model.
"""

from __future__ import annotations

import logging
import time as _time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

ERDDAP = "https://coastwatch.pfeg.noaa.gov/erddap/griddap"
CHL_DATASET = "nesdisVHNnoaaSNPPnoaa20chlaGapfilledDaily"
BATHY_DATASET = "ETOPO_2022_v1_15s"
USER_AGENT = "oceanUps/0.1 (SIH 26067 student project; contact via repository)"


def _get(url: str, dest: Path, *, retries: int = 3, timeout: int = 600) -> Path:
    part = dest.with_suffix(dest.suffix + ".part")
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            t0 = _time.time()
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
            if body[:4] != b"\x89HDF" and body[:3] != b"CDF":
                raise OSError(f"not NetCDF ({len(body)} B): {body[:300]!r}")
            part.write_bytes(body)
            part.replace(dest)
            log.info(
                "    %s  %.1f MB in %.0fs",
                dest.name,
                len(body) / 1e6,
                _time.time() - t0,
            )
            return dest
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            last = exc
            log.warning("    attempt %d/%d failed: %s", attempt, retries, exc)
            if attempt < retries:
                _time.sleep(4 * attempt)
    part.unlink(missing_ok=True)
    raise RuntimeError(f"ERDDAP download failed: {last}")


def _range(lo: float, hi: float, stride: int, descending: bool) -> str:
    """One griddap axis constraint.

    griddap wants the constraint written in the axis's OWN stored direction,
    not smallest-first. Latitude is stored north-to-south in most satellite
    products and south-to-north in most model output, and getting it backwards
    returns an error rather than an empty result -- so the caller has to know,
    and `_fetch_either_way` finds out by trying.
    """
    a, b = (hi, lo) if descending else (lo, hi)
    return f"[({a}):{stride}:({b})]" if stride != 1 else f"[({a}):({b})]"


def _fetch_either_way(build: object, dest: Path) -> Path:
    """Try the axis ascending, then descending. One of the two is right."""
    from typing import Callable, cast

    make = cast("Callable[[bool], str]", build)
    try:
        return _get(make(False), dest, retries=1)
    except RuntimeError:
        log.info("    latitude is stored descending; retrying")
        return _get(make(True), dest)


def fetch_chlorophyll(
    outdir: Path,
    *,
    bbox: tuple[float, float, float, float] = (80.0, 5.0, 95.0, 22.0),
    start: str = "2024-01-01",
    end: str = "2024-01-30",
    dataset: str = CHL_DATASET,
) -> Path:
    """Daily gap-filled satellite chlorophyll over the bbox, as NetCDF."""
    outdir.mkdir(parents=True, exist_ok=True)
    west, south, east, north = bbox
    dest = outdir / f"chl_{start}_{end}.nc"
    if dest.exists() and dest.stat().st_size > 0:
        log.info("    %s  cached", dest.name)
        return dest

    def build(desc: bool) -> str:
        sel = (
            f"chlor_a[({start}):({end})][(0.0):(0.0)]"
            f"{_range(south, north, 1, desc)}{_range(west, east, 1, False)}"
        )
        return f"{ERDDAP}/{dataset}.nc?{urllib.parse.quote(sel, safe='[]():,.-')}"

    return _fetch_either_way(build, dest)


def fetch_bathymetry(
    outdir: Path,
    *,
    bbox: tuple[float, float, float, float] = (80.0, 5.0, 95.0, 22.0),
    stride: int = 2,
    dataset: str = BATHY_DATASET,
) -> Path:
    """ETOPO 2022 elevation over the bbox. stride=2 gives 30 arc-second."""
    outdir.mkdir(parents=True, exist_ok=True)
    west, south, east, north = bbox
    dest = outdir / f"etopo2022_{stride*15}s_bob.nc"
    if dest.exists() and dest.stat().st_size > 0:
        log.info("    %s  cached", dest.name)
        return dest

    def build(desc: bool) -> str:
        sel = f"z{_range(south, north, stride, desc)}{_range(west, east, stride, False)}"
        return f"{ERDDAP}/{dataset}.nc?{urllib.parse.quote(sel, safe='[]():,.-')}"

    return _fetch_either_way(build, dest)


def repair_cf(path: Path) -> Path:
    """Fill in the CF attributes ERDDAP leaves off, in place.

    ERDDAP is CF-aware but not CF-complete: it writes `standard_name` and
    `units` faithfully and then omits `axis` on the coordinates, which is one
    of the three things `cf-xarray` looks at. Everything downstream trusts
    CFDataset, and CFDataset trusts these, so they get written rather than
    hoped for.
    """
    from ..core.conventions import CF_CONVENTIONS
    from ..core.netcdf import open_dataset

    # ERDDAP serves griddap `.nc` as NetCDF-3 CLASSIC, which h5netcdf cannot
    # read at all -- the same trap the Argo GDAC set. Sniff the engine.
    ds = open_dataset(path)
    ds.load()
    ds.close()

    for name, axis, sn, units in (
        ("latitude", "Y", "latitude", "degrees_north"),
        ("longitude", "X", "longitude", "degrees_east"),
        ("time", "T", "time", None),
    ):
        if name in ds.coords or name in ds.variables:
            ds[name].attrs.setdefault("axis", axis)
            ds[name].attrs.setdefault("standard_name", sn)
            if units and "units" not in ds[name].attrs:
                ds[name].attrs["units"] = units

    # A singleton `altitude` of 0 m is ERDDAP bookkeeping for a surface
    # product. Left in place, cf-xarray reports it as the vertical axis and the
    # field looks like a one-level 3D volume instead of a surface map.
    if "altitude" in ds.dims and ds.sizes.get("altitude", 0) == 1:
        ds = ds.squeeze("altitude", drop=True)

    if "chlor_a" in ds:
        ds["chlor_a"].attrs.setdefault(
            "standard_name", "mass_concentration_of_chlorophyll_a_in_sea_water"
        )
        ds["chlor_a"].attrs.setdefault("units", "mg m-3")
    if "z" in ds:
        ds["z"].attrs.setdefault("standard_name", "height_above_mean_sea_level")
        ds["z"].attrs.setdefault("units", "m")
        ds["z"].attrs.setdefault("positive", "up")

    ds.attrs.setdefault("Conventions", CF_CONVENTIONS)
    ds.attrs["synthetic"] = "false"

    tmp = path.with_suffix(".fixed.nc")
    ds.to_netcdf(tmp, engine="h5netcdf")
    ds.close()
    tmp.replace(path)
    return path
