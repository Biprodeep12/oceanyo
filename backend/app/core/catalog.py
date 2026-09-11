"""Dataset catalog — parses config/catalog.*.yaml.

The synthetic and real catalogs have identical structure, which is what makes
the data swap a one-environment-variable operation.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .config import settings
from .geometry import BBox, DepthRange

log = logging.getLogger(__name__)


@dataclass
class SourceRef:
    uri: Path
    #: None means sniff the engine from the file's magic bytes. Real GDAC
    #: products are NetCDF-3 classic, which h5netcdf cannot read at all,
    #: so a project-wide default is wrong for half the sources.
    engine: str | None = None
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
                engine=node.get("engine"),
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


# ---------------------------------------------------------------------------
# Discovery and runtime selection
# ---------------------------------------------------------------------------
#
# The catalog path stays the single swap surface; this adds a second way to
# set it. OCEANUPS_CATALOG is the default, a runtime selection file overrides
# it, and the API restarts to apply the change -- see api/services/restart.py
# for why a restart rather than a hot swap.
#
# The selection file lives outside config/ and data/ on purpose: docker-compose
# bind-mounts BOTH of those read-only, so neither can hold state the running
# container writes. .runtime/ is in the container's own writable layer, which
# survives `docker restart` (the same container comes back) but not a rebuild.


@dataclass
class CatalogInfo:
    """One catalog on disk, and whether its data is actually present."""

    id: str
    label: str
    path: Path
    source: str
    synthetic: bool
    #: False when the model file is missing. Every other source is optional --
    #: the datastore already opens those in a try/except and carries on.
    available: bool
    #: Every referenced file that is not on disk, repo-relative.
    missing: list[str]
    #: What to run to get the missing files, from the catalog's own `fetch:`.
    hint: str


def _rel(p: Path) -> str:
    try:
        return str(p.relative_to(settings.resolve(".")).as_posix())
    except ValueError:
        return str(p)


def _missing_uris(raw: dict) -> tuple[list[str], bool]:
    """Which of a catalog's sources are absent, and is the model one of them?"""
    missing: list[str] = []
    model_missing = False
    for key in ("model", "bgc", "bathymetry", "climatology"):
        node = raw.get(key)
        if not node or not node.get("uri"):
            continue
        path = settings.resolve(node["uri"])
        if not path.exists():
            missing.append(_rel(path))
            if key == "model":
                model_missing = True
    for obs in raw.get("observations") or []:
        path = settings.resolve(obs["uri"])
        # An empty observation directory is as absent as a missing one: the
        # parser registry would index zero profiles and the matchup panel --
        # the differentiator -- would have nothing to open.
        if not path.exists() or (path.is_dir() and not any(path.iterdir())):
            missing.append(_rel(path))
    return missing, model_missing


def discover() -> list[CatalogInfo]:
    """Every config/catalog.*.yaml, with its data presence checked.

    A catalog whose YAML does not parse is skipped rather than raised: one
    broken file must not take down the picker that offers the other three.
    """
    out: list[CatalogInfo] = []
    for path in sorted((settings.resolve("config")).glob("catalog.*.yaml")):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                raw = yaml.safe_load(fh) or {}
            missing, model_missing = _missing_uris(raw)
            out.append(
                CatalogInfo(
                    id=str(raw["id"]),
                    label=str(raw.get("label") or raw["id"]),
                    path=path,
                    source=str(raw.get("source", "")),
                    synthetic=bool(raw.get("synthetic", False)),
                    available=not model_missing,
                    missing=missing,
                    hint=str(raw.get("fetch", "")),
                )
            )
        except Exception as exc:  # noqa: BLE001 - one bad file, not no picker
            log.warning("catalog %s is unreadable and was skipped: %s", path.name, exc)
    return out


def find(catalog_id: str) -> CatalogInfo | None:
    return next((c for c in discover() if c.id == catalog_id), None)


def _selection_file() -> Path:
    return settings.runtime_dir / "catalog.json"


def write_selection(info: CatalogInfo) -> None:
    """Persist the chosen catalog so the restarted process picks it up."""
    path = _selection_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": info.id,
        "path": str(info.path),
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    log.info("catalog selection written: %s -> %s", info.id, path)


def clear_selection() -> None:
    _selection_file().unlink(missing_ok=True)


def active_path() -> Path:
    """The catalog this process should open.

    Order: a runtime selection, then OCEANUPS_CATALOG. The selection is
    re-validated on every boot and discarded if it names a catalog that no
    longer exists or whose data has since been deleted -- a stored choice must
    never be able to stop the platform starting, which is the failure mode that
    would make this feature worse than editing an environment variable.
    """
    path = _selection_file()
    if not path.exists():
        return settings.catalog
    try:
        with open(path, "r", encoding="utf-8") as fh:
            chosen = str(json.load(fh)["id"])
    except Exception as exc:  # noqa: BLE001
        log.warning("ignoring unreadable catalog selection (%s): %s", path, exc)
        return settings.catalog

    info = find(chosen)
    if info is None:
        log.warning("selected catalog %r no longer exists; using the default", chosen)
        return settings.catalog
    if not info.available:
        log.warning(
            "selected catalog %r is missing %s; using the default",
            chosen, ", ".join(info.missing) or "its model file",
        )
        return settings.catalog
    return info.path
