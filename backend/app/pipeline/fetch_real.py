"""Fetch a small REAL dataset from the public GDACs, for verification.

Why this exists
---------------
The whole project is built on synthetic data, and the claim that a real swap is
a config change is only worth something if it has actually been tried. This
pulls a handful of genuine Argo profiles from the Ifremer GDAC -- preferring
the INCOIS DAC, since INCOIS is the problem owner -- so the SAME parser that
reads the synthetic files can be pointed at real ones and the data contract
re-run against them.

It downloads a few hundred kilobytes, not a reanalysis. GLORYS12 and the
Copernicus BGC product need a free account and the `copernicusmarine` toolbox;
those commands are documented in the README rather than run here, because a
credentialed download cannot be part of an offline demo.

Sources (from the problem statement):
  Argo GDAC      https://data-argo.ifremer.fr/  (ftp://ftp.ifremer.fr/ifremer/argo)
  Glider DAC     ftp://ftp.ifremer.fr/ifremer/glider/v2/
  INCOIS LAS     https://las.incois.gov.in/     (THREDDS/OPeNDAP)
  Copernicus     https://data.marine.copernicus.eu/product/GLOBAL_MULTIYEAR_PHY_001_030
"""

from __future__ import annotations

import logging
import re
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

ARGO_ROOT = "https://data-argo.ifremer.fr"
GLIDER_ROOT = "https://data-argo.ifremer.fr"  # unused; gliders live on the FTP tree
USER_AGENT = "oceanUps/0.1 (SIH 26067 student project; contact via repository)"
TIMEOUT = 60


def _get(url: str, timeout: int = TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def list_dac_floats(dac: str = "incois", limit: int = 60) -> list[str]:
    """WMO numbers held by one DAC, from the directory listing."""
    html = _get(f"{ARGO_ROOT}/dac/{dac}/").decode("utf-8", "replace")
    wmos = re.findall(r'href="(\d{7})/"', html)
    # Preserve order but drop duplicates from the listing markup.
    seen: list[str] = []
    for w in wmos:
        if w not in seen:
            seen.append(w)
        if len(seen) >= limit:
            break
    return seen


def download_float(wmo: str, dac: str, outdir: Path) -> Path | None:
    """Fetch one multi-profile file. Returns None if the DAC does not have it."""
    url = f"{ARGO_ROOT}/dac/{dac}/{wmo}/{wmo}_prof.nc"
    dest = outdir / f"{wmo}_prof.nc"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    try:
        data = _get(url)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        log.warning("skip %s: %s", wmo, exc)
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return dest


def in_bbox(path: Path, bbox: tuple[float, float, float, float]) -> tuple[bool, dict]:
    """Does this float have any profile inside (west, south, east, north)?"""
    import numpy as np

    from ..core.netcdf import open_dataset

    west, south, east, north = bbox
    # decode_times=False: Argo JULD is days since 1950 and some delayed-mode
    # files carry fill values that overflow datetime64 on decode.
    # The engine is sniffed: GDAC files are NetCDF-3 classic, which h5netcdf
    # cannot read at all.
    with open_dataset(path, decode_times=False) as ds:
        lat = np.asarray(ds["LATITUDE"].values, dtype=float)
        lon = np.asarray(ds["LONGITUDE"].values, dtype=float)
        good = np.isfinite(lat) & np.isfinite(lon) & (np.abs(lat) <= 90)
        inside = good & (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
        info = {
            "profiles": int(good.sum()),
            "inside": int(inside.sum()),
            "lat": (float(np.nanmin(lat[good])), float(np.nanmax(lat[good]))) if good.any() else None,
            "lon": (float(np.nanmin(lon[good])), float(np.nanmax(lon[good]))) if good.any() else None,
            "vars": [v for v in ("TEMP", "PSAL", "PRES", "TEMP_QC", "DATA_MODE") if v in ds],
        }
    return bool(info["inside"]), info


def fetch_argo(
    outdir: Path,
    *,
    bbox: tuple[float, float, float, float] = (80.0, 5.0, 95.0, 22.0),
    dac: str = "incois",
    want: int = 6,
    scan: int = 40,
) -> list[Path]:
    """Download floats from `dac` until `want` of them fall inside `bbox`."""
    outdir.mkdir(parents=True, exist_ok=True)
    kept: list[Path] = []
    scratch = outdir / "_scan"
    scratch.mkdir(exist_ok=True)

    for wmo in list_dac_floats(dac, limit=scan):
        if len(kept) >= want:
            break
        path = download_float(wmo, dac, scratch)
        if path is None:
            continue
        try:
            ok, info = in_bbox(path, bbox)
        except Exception as exc:
            log.warning("skip %s: unreadable (%s)", wmo, exc)
            path.unlink(missing_ok=True)
            continue
        if ok:
            final = outdir / path.name
            path.replace(final)
            kept.append(final)
            log.info(
                "keep %s: %d/%d profiles in bbox, lat %s lon %s",
                wmo, info["inside"], info["profiles"], info["lat"], info["lon"],
            )
        else:
            path.unlink(missing_ok=True)

    for leftover in scratch.glob("*"):
        leftover.unlink(missing_ok=True)
    scratch.rmdir()
    return kept
