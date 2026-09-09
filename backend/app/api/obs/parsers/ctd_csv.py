"""CTD profiles from delimited text.

This parser satisfies two MVP requirements at once: ASCII/CSV ingestion (item
14) and a demonstration that the platform enum genuinely extends (item 15) --
"ctd" appears nowhere in the core schema, yet dropping this file in makes CTD
casts appear in the API and on the map with no other change.

Expected layout: one CSV per cast, with a small header of `# key: value` lines
and then columns. Column names are matched case-insensitively against a few
common spellings, because real CTD exports are never consistent.

    # id: CTD_001
    # lat: 13.5
    # lon: 87.2
    # time: 2023-01-15T06:00:00Z
    depth,temperature,salinity
    0,28.9,33.1
    10,28.7,33.4
"""

from __future__ import annotations

import csv
import logging
from pathlib import Path

import numpy as np

from ....core.geometry import BBox
from ....core.models import ObservationProfile, ParserCapabilities, ProfileVariable
from ..registry import REGISTRY, ProfileRef

log = logging.getLogger(__name__)

DEPTH_KEYS = ("depth", "pres", "pressure", "z", "depth_m")
COLUMN_ALIASES = {
    "temperature": ("temperature", "temp", "t", "sea_water_temperature", "temp_c"),
    "salinity": ("salinity", "psal", "sal", "s", "practical_salinity"),
    "chlorophyll": ("chlorophyll", "chl", "chla", "chl_a"),
}


def _read_header_and_rows(path: Path) -> tuple[dict[str, str], list[dict[str, str]]]:
    header: dict[str, str] = {}
    data_lines: list[str] = []
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        for line in fh:
            stripped = line.strip()
            if stripped.startswith("#"):
                body = stripped.lstrip("#").strip()
                if ":" in body:
                    k, v = body.split(":", 1)
                    header[k.strip().lower()] = v.strip()
            elif stripped:
                data_lines.append(line)
    rows = list(csv.DictReader(data_lines)) if data_lines else []
    return header, rows


def _match_column(fieldnames: list[str], aliases: tuple[str, ...]) -> str | None:
    lowered = {f.lower().strip(): f for f in fieldnames if f}
    for alias in aliases:
        if alias in lowered:
            return lowered[alias]
    return None


@REGISTRY.register
class CTDCsvParser:
    parser_id = "ctd_csv"
    platform = "ctd"

    def capabilities(self) -> ParserCapabilities:
        return ParserCapabilities(
            platform=self.platform,
            variables=sorted(COLUMN_ALIASES),
            depthRange=(0.0, 6000.0),
            hasTrajectory=False,
            qcScheme="none",
            dataModes=["R"],
            description="CTD casts from delimited text. Demonstrates the parser "
                        "registry: no core schema change was needed to add it.",
        )

    def discover(
        self, root: Path, bbox: BBox | None, t0: str | None, t1: str | None
    ) -> list[ProfileRef]:
        refs: list[ProfileRef] = []
        if not root.exists():
            return refs

        for path in sorted(list(root.glob("*.csv")) + list(root.glob("*.txt"))):
            try:
                header, _ = _read_header_and_rows(path)
                lat = float(header["lat"])
                lon = float(header["lon"])
            except (KeyError, ValueError) as exc:
                log.warning("skipping CTD file %s (missing lat/lon): %s", path.name, exc)
                continue

            if bbox is not None and not (
                bbox.west <= lon <= bbox.east and bbox.south <= lat <= bbox.north
            ):
                continue
            iso = header.get("time", "")
            if (t0 and iso and iso < t0) or (t1 and iso and iso > t1):
                continue

            refs.append(
                ProfileRef(
                    platform=self.platform,
                    id=header.get("id", path.stem),
                    lat=lat,
                    lon=lon,
                    time=iso,
                    path=path,
                    index=0,
                    data_mode="R",
                )
            )
        return refs

    def load(self, ref: ProfileRef) -> ObservationProfile:
        header, rows = _read_header_and_rows(ref.path)
        if not rows:
            raise ValueError(f"no data rows in {ref.path}")

        fieldnames = list(rows[0].keys())
        depth_col = _match_column(fieldnames, DEPTH_KEYS)
        if depth_col is None:
            raise ValueError(f"no depth column in {ref.path} (looked for {DEPTH_KEYS})")

        def _floats(col: str) -> np.ndarray:
            out = []
            for r in rows:
                try:
                    out.append(float(r[col]))
                except (TypeError, ValueError):
                    out.append(np.nan)
            return np.asarray(out, dtype=float)

        depth = _floats(depth_col)
        keep = np.isfinite(depth)

        variables: dict[str, ProfileVariable] = {}
        for canonical, aliases in COLUMN_ALIASES.items():
            col = _match_column(fieldnames, aliases)
            if col is None:
                continue
            vals = _floats(col)[keep]
            variables[canonical] = ProfileVariable(
                units=header.get(f"{canonical}_units", ""),
                values=[None if not np.isfinite(v) else float(v) for v in vals],
                # No QC scheme in plain CSV: mark present values good, absent 9.
                qc=[1 if np.isfinite(v) else 9 for v in vals],
            )

        return ObservationProfile(
            platform=self.platform,
            id=ref.id,
            lat=ref.lat,
            lon=ref.lon,
            time=ref.time,
            depth=[float(d) for d in depth[keep]],
            variables=variables,
            dataMode="R",
            source=header.get("source", f"CTD CSV {ref.path.name}"),
        )
