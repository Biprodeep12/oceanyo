"""Dataset catalog — parses config/catalog.*.yaml.

The synthetic and real catalogs have identical structure, which is what makes
the data swap a one-environment-variable operation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .config import settings
from .geometry import BBox, DepthRange


@dataclass
class SourceRef:
    uri: Path
    engine: str = "h5netcdf"
    variables: dict[str, str] = field(default_factory=dict)  # canonical -> raw override
    variable: str | None = None  # single-variable sources (bathymetry)


@dataclass
class ObservationSource:
    platform: str
    parser: str
    uri: Path


@dataclass
class Catalog:
    id: str
    source: str
    synthetic: bool
    model: SourceRef
    bgc: SourceRef | None
    bathymetry: SourceRef | None
    climatology: SourceRef | None
    observations: list[ObservationSource]
    default_bbox: BBox
    default_depth_range: DepthRange
    default_variable: str
    path: Path

    @classmethod
    def load(cls, path: Path | None = None) -> "Catalog":
        path = Path(path) if path else settings.catalog
        with open(path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)

        def src(key: str) -> SourceRef | None:
            node = raw.get(key)
            if not node:
                return None
            return SourceRef(
                uri=settings.resolve(node["uri"]),
                engine=node.get("engine", "h5netcdf"),
                variables=node.get("variables") or {},
                variable=node.get("variable"),
            )

        d = raw.get("defaults", {})
        bbox = BBox(*d.get("bbox", [80, 5, 95, 22]))
        dr = DepthRange(*d.get("depth_range", [0, 2000]))

        return cls(
            id=raw["id"],
            source=raw["source"],
            synthetic=bool(raw.get("synthetic", False)),
            model=src("model"),
            bgc=src("bgc"),
            bathymetry=src("bathymetry"),
            climatology=src("climatology"),
            observations=[
                ObservationSource(
                    platform=o["platform"],
                    parser=o["parser"],
                    uri=settings.resolve(o["uri"]),
                )
                for o in (raw.get("observations") or [])
            ],
            default_bbox=bbox,
            default_depth_range=dr,
            default_variable=d.get("variable", "temperature"),
            path=path,
        )
