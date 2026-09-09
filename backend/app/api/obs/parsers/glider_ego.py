"""EGO glider NetCDF parser (format version 1.5).

One file per deployment, stored as a time series with descent and ascent split
into two profiles. Unlike Argo floats, a glider has a meaningful trajectory, so
this parser populates `ObservationProfile.trajectory` -- which block mode draws
as a curve through the water column.
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
            description="EGO glider NetCDF v1.5. Sawtooth deployments, "
                        "descent/ascent split into two profiles.",
        )

    def discover(
        self, root: Path, bbox: BBox | None, t0: str | None, t1: str | None
    ) -> list[ProfileRef]:
        refs: list[ProfileRef] = []
        if not root.exists():
            log.warning("glider root does not exist: %s", root)
            return refs

        for path in sorted(root.glob("*.nc")):
            try:
                with xr.open_dataset(path, engine="h5netcdf") as ds:
                    code = _scalar_str(ds, "PLATFORM_CODE", path.stem)
                    mode = _scalar_str(ds, "DATA_MODE", "R") or "R"
                    lats = np.atleast_1d(ds["LATITUDE"].values)
                    lons = np.atleast_1d(ds["LONGITUDE"].values)
                    julds = np.atleast_1d(ds["JULD"].values)
            except Exception as exc:
                log.warning("skipping unreadable glider file %s: %s", path.name, exc)
                continue

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

    def load(self, ref: ProfileRef) -> ObservationProfile:
        with xr.open_dataset(ref.path, engine="h5netcdf") as ds:
            i = ref.index
            pres = np.atleast_2d(ds["PRES"].values)[i].astype(float)
            keep = np.isfinite(pres)

            variables: dict[str, ProfileVariable] = {}
            for raw, canonical in VAR_MAP.items():
                if raw not in ds:
                    continue
                vals = np.atleast_2d(ds[raw].values)[i].astype(float)
                qc_name = f"{raw}_QC"
                qc = (
                    np.atleast_2d(ds[qc_name].values)[i].astype(int)
                    if qc_name in ds
                    else np.where(np.isfinite(vals), 1, 9)
                )
                variables[canonical] = ProfileVariable(
                    units=str(ds[raw].attrs.get("units", "")),
                    values=[None if not np.isfinite(v) else float(v) for v in vals[keep]],
                    qc=[int(q) for q in qc[keep]],
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
