"""Argo core-profile NetCDF parser.

Reads the Argo GDAC single-float profile format. The synthetic generator emits
the same format, so this one parser serves both synthetic and real data --
which is why swapping to a real GDAC download needs no new code.

QC convention (Argo reference table 2): 1 = good, 2 = probably good, 3 = bad
but correctable, 4 = bad. Display keeps 1 and 2; quantitative comparison keeps
only 1. That policy lives in the matchup service, not here -- the parser
reports flags faithfully and does not filter.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

from ....core.geometry import BBox
from ....core.models import ObservationProfile, ParserCapabilities, ProfileVariable
from ..registry import REGISTRY, ProfileRef
from ..timeutil import juld_to_iso

log = logging.getLogger(__name__)

# Argo variable name -> our canonical key
VAR_MAP = {"TEMP": "temperature", "PSAL": "salinity"}


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


@REGISTRY.register
class ArgoNetCDFParser:
    parser_id = "argo_netcdf"
    platform = "argo"

    def capabilities(self) -> ParserCapabilities:
        return ParserCapabilities(
            platform=self.platform,
            variables=sorted(VAR_MAP.values()),
            depthRange=(0.0, 2000.0),
            hasTrajectory=False,
            qcScheme="argo",
            dataModes=["R", "A", "D"],
            description="Argo core-profile NetCDF (GDAC format). Park-and-profile "
                        "floats, 0-2000 m, ~10 day cycle.",
        )

    def discover(
        self, root: Path, bbox: BBox | None, t0: str | None, t1: str | None
    ) -> list[ProfileRef]:
        refs: list[ProfileRef] = []
        if not root.exists():
            log.warning("argo root does not exist: %s", root)
            return refs

        for path in sorted(root.glob("*.nc")):
            try:
                with xr.open_dataset(path, engine="h5netcdf") as ds:
                    wmo = _scalar_str(ds, "PLATFORM_NUMBER", path.stem)
                    mode = _scalar_str(ds, "DATA_MODE", "R") or "R"
                    lats = np.atleast_1d(ds["LATITUDE"].values)
                    lons = np.atleast_1d(ds["LONGITUDE"].values)
                    julds = np.atleast_1d(ds["JULD"].values)
            except Exception as exc:  # a corrupt file must not kill the listing
                log.warning("skipping unreadable Argo file %s: %s", path.name, exc)
                continue

            for i in range(len(julds)):
                lat, lon = float(lats[i]), float(lons[i])
                if bbox is not None and not (
                    bbox.west <= lon <= bbox.east and bbox.south <= lat <= bbox.north
                ):
                    continue
                iso = juld_to_iso(julds[i])
                if t0 and iso < t0:
                    continue
                if t1 and iso > t1:
                    continue
                refs.append(
                    ProfileRef(
                        platform=self.platform,
                        id=f"{wmo}:{i}",
                        lat=lat,
                        lon=lon,
                        time=iso,
                        path=path,
                        index=i,
                        data_mode=mode,
                    )
                )
        return refs

    def load(self, ref: ProfileRef) -> ObservationProfile:
        with xr.open_dataset(ref.path, engine="h5netcdf") as ds:
            i = ref.index
            pres = np.atleast_2d(ds["PRES"].values)[i].astype(float)
            good_depth = np.isfinite(pres)

            variables: dict[str, ProfileVariable] = {}
            for raw, canonical in VAR_MAP.items():
                if raw not in ds:
                    continue
                vals = np.atleast_2d(ds[raw].values)[i].astype(float)
                qc_name = f"{raw}_QC"
                if qc_name in ds:
                    qc = np.atleast_2d(ds[qc_name].values)[i].astype(int)
                else:
                    qc = np.where(np.isfinite(vals), 1, 9)
                keep = good_depth
                variables[canonical] = ProfileVariable(
                    units=str(ds[raw].attrs.get("units", "")),
                    values=[None if not np.isfinite(v) else float(v) for v in vals[keep]],
                    qc=[int(q) for q in qc[keep]],
                )

            mode = _scalar_str(ds, "DATA_MODE", ref.data_mode) or "R"
            return ObservationProfile(
                platform=self.platform,
                id=ref.id,
                lat=ref.lat,
                lon=ref.lon,
                time=ref.time,
                depth=[float(d) for d in pres[good_depth]],
                variables=variables,
                dataMode=mode if mode in ("R", "A", "D") else "R",
                source=str(ds.attrs.get("source", "Argo")),
            )
