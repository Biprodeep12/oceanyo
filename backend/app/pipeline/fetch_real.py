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


# --------------------------------------------------------------------------
# Gliders
# --------------------------------------------------------------------------
#
# The EGO GDAC is FTP-only and organised by deployment name, not by region, so
# the trajectory index is the way in: 437 KB describing every deployment,
# against 248 MB for the profile index.
#
# Two things this turned up that the index alone will not tell you:
#
#  1. The deployment coordinates in the index are NOT trustworthy. One
#     deployment advertises 10.00 N 78.00 E -- the Bay of Bengal -- and the
#     file itself sits at 78 N 10 E, off Svalbard. The pair is transposed.
#     Candidate positions are therefore confirmed by reading the file.
#
#  2. There are no Bay of Bengal glider deployments in the GDAC at all. 131 of
#     1115 deployments fall in the wider Indian Ocean, almost all of them in
#     the Mozambique Channel. The spec warned that Indian-Ocean coverage was
#     sparse; this is how sparse.

GLIDER_ROOT_FTP = "ftp://ftp.ifremer.fr/ifremer/glider/v2"
GLIDER_TRAJ_INDEX = f"{GLIDER_ROOT_FTP}/glider_traj_index.txt"

#: Deployments run to tens of megabytes. One is enough to prove the format.
MAX_GLIDER_BYTES = 12_000_000


def glider_index(rows: int = 0) -> list[dict]:
    """Parse the EGO trajectory index into dicts."""
    import csv
    import io

    text = _get(GLIDER_TRAJ_INDEX, timeout=300).decode("utf-8", "replace")
    lines = [ln for ln in io.StringIO(text) if not ln.startswith("#")]
    out = list(csv.DictReader(lines))
    return out[:rows] if rows else out


def _float_or_none(text: str | None) -> float | None:
    try:
        return float(text)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def fetch_glider(
    outdir: Path,
    *,
    bbox: tuple[float, float, float, float] = (20.0, -45.0, 120.0, 30.0),
    want: int = 1,
    max_bytes: int = MAX_GLIDER_BYTES,
) -> tuple[list[Path], dict]:
    """Download EGO deployments whose FILE position falls inside `bbox`.

    Returns the kept paths plus a summary of what the index claimed, so the
    caller can report the difference between the two honestly.
    """
    outdir.mkdir(parents=True, exist_ok=True)
    west, south, east, north = bbox
    entries = glider_index()

    candidates: list[dict] = []
    for row in entries:
        lat = _float_or_none(row.get("deployment_start_latitude"))
        lon = _float_or_none(row.get("deployment_start_longitude"))
        if lat is None or lon is None:
            continue
        if west <= lon <= east and south <= lat <= north:
            candidates.append({**row, "_lat": lat, "_lon": lon})

    summary = {
        "deployments_in_index": len(entries),
        "candidates_in_bbox": len(candidates),
        "kept": [],
        "rejected_position": [],
        "skipped_too_large": [],
    }

    kept: list[Path] = []
    for row in candidates:
        if len(kept) >= want:
            break
        rel = row["file"]
        name = rel.rsplit("/", 1)[-1]
        dest = outdir / name
        url = f"{GLIDER_ROOT_FTP}{rel}"

        if not dest.exists():
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=300) as resp:
                    size = int(resp.headers.get("Content-Length") or 0)
                    if size and size > max_bytes:
                        summary["skipped_too_large"].append((name, size))
                        continue
                    data = resp.read(max_bytes + 1)
                if len(data) > max_bytes:
                    summary["skipped_too_large"].append((name, len(data)))
                    continue
                dest.write_bytes(data)
            except Exception as exc:
                log.warning("skip %s: %s", name, exc)
                continue

        # Confirm from the file, never from the index.
        try:
            import numpy as np

            from ..core.netcdf import open_dataset

            with open_dataset(dest, decode_times=False) as ds:
                lat = np.asarray(ds["LATITUDE"].values, dtype=float)
                lon = np.asarray(ds["LONGITUDE"].values, dtype=float)
                good = np.isfinite(lat) & np.isfinite(lon) & (np.abs(lat) <= 90)
                if not good.any():
                    raise ValueError("no usable positions")
                real = (
                    float(np.nanmin(lat[good])), float(np.nanmax(lat[good])),
                    float(np.nanmin(lon[good])), float(np.nanmax(lon[good])),
                )
        except Exception as exc:
            log.warning("skip %s: unreadable (%s)", name, exc)
            dest.unlink(missing_ok=True)
            continue

        inside = west <= real[2] <= east and south <= real[0] <= north
        if not inside:
            summary["rejected_position"].append(
                {"file": name, "index": (row["_lat"], row["_lon"]), "actual": real}
            )
            dest.unlink(missing_ok=True)
            continue

        summary["kept"].append({"file": name, "actual": real})
        kept.append(dest)
        log.info(
            "keep %s: lat %.2f..%.2f  lon %.2f..%.2f",
            name, real[0], real[1], real[2], real[3],
        )

    return kept, summary


# --------------------------------------------------------------------------
# In-situ climatology (problem statement item d)
# --------------------------------------------------------------------------
#
# The statement's "collection of in-situ data" link is missing. The nearest
# substitute that needs no account is the NOAA World Ocean Atlas, which is
# built entirely from the World Ocean Database -- i.e. it IS the collection of
# in-situ data, objectively analysed onto a grid.
#
# WOA already ships exactly what the anomaly service wants: `t_an` is the
# analysed mean and `t_sd` the standard deviation about it. Converting is a
# rename and a subset, not a computation.
#
# It is also 1 degree against a 1/12 degree model, which is precisely why the
# anomaly service interpolates the climatology onto the model grid instead of
# requiring the two to match.

WOA_ROOT = "https://www.ncei.noaa.gov/data/oceans/woa/WOA23/DATA"

#: WOA variable prefix -> the canonical name our catalog resolves.
WOA_VARIABLES = {"temperature": ("t", "thetao"), "salinity": ("s", "so")}


def woa_url(variable: str, resolution: str = "1.00", period: str = "00") -> str:
    prefix, _ = WOA_VARIABLES[variable]
    return (
        f"{WOA_ROOT}/{variable}/netcdf/decav/{resolution}/"
        f"woa23_decav_{prefix}{period}_{resolution.replace('.', '')[:2]}.nc"
    )


def build_woa_climatology(
    sources: dict[str, Path],
    out: Path,
    *,
    bbox: tuple[float, float, float, float] = (80.0, 5.0, 95.0, 22.0),
) -> Path:
    """Turn WOA23 annual fields into a climatology this platform can read.

    `sources` maps a canonical variable to its downloaded WOA file. Emits
    `<raw>_mean` / `<raw>_std` on a lat/lon/depth grid with CF attributes, the
    same shape the synthetic climatology writer produces -- so the anomaly
    endpoint consumes it with no code change at all.
    """
    import numpy as np
    import xarray as xr

    from ..core import conventions as cv
    from ..core.netcdf import open_dataset

    west, south, east, north = bbox
    data_vars: dict[str, tuple] = {}
    coords: dict[str, tuple] = {}

    for variable, path in sources.items():
        prefix, raw = WOA_VARIABLES[variable]
        with open_dataset(path, decode_times=False) as ds:
            sub = ds.sel(lat=slice(south, north), lon=slice(west, east))
            mean = sub[f"{prefix}_an"].isel(time=0)
            std = sub[f"{prefix}_sd"].isel(time=0)

            if not coords:
                coords = {
                    "longitude": ("longitude", np.asarray(sub["lon"].values, dtype="float32"),
                                  dict(cv.LON_ATTRS)),
                    "latitude": ("latitude", np.asarray(sub["lat"].values, dtype="float32"),
                                 dict(cv.LAT_ATTRS)),
                    "depth": ("depth", np.asarray(sub["depth"].values, dtype="float32"),
                              dict(cv.DEPTH_ATTRS)),
                }

            dims = ("depth", "latitude", "longitude")
            data_vars[f"{raw}_mean"] = (
                dims,
                np.asarray(mean.values, dtype="float32"),
                cv.variable_attrs(cv.CANONICAL[variable]),
            )
            data_vars[f"{raw}_std"] = (
                dims,
                np.asarray(std.values, dtype="float32"),
                {"units": cv.CANONICAL[variable].units,
                 "long_name": f"{variable} standard deviation (WOA23)"},
            )

    if not data_vars:
        raise ValueError("no WOA sources given")

    ds_out = xr.Dataset(
        data_vars,
        coords=coords,
        attrs=cv.global_attrs(
            title="WOA23 decadal-average climatology subset (real in-situ data)",
            synthetic=False,
            source=(
                "NOAA World Ocean Atlas 2023, decav 1.00 degree, "
                "https://www.ncei.noaa.gov/products/world-ocean-atlas"
            ),
        ),
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    ds_out.to_netcdf(out, engine="h5netcdf")
    ds_out.close()
    log.info("wrote %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return out
