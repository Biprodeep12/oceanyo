"""Discovery endpoints: health, variables, metadata, presets, platforms."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException

from ...core.config import REPO_ROOT
from ...core.conventions import CANONICAL
from ...core.models import GriddedField, HealthResponse, ParserCapabilities, VariableSummary
from ..datastore import DataStore, get_store
from ..obs.registry import REGISTRY
from ..services import raster

router = APIRouter(prefix="/api", tags=["catalog"])


@router.get("/health", response_model=HealthResponse)
def health(store: DataStore = Depends(get_store)) -> HealthResponse:
    from ..main import STANDARDS

    return HealthResponse(
        catalogId=store.catalog.id,
        # This flag drives the persistent SYNTHETIC badge in the UI. Provenance
        # is enforced in code, not just in the README.
        synthetic=store.catalog.synthetic,
        source=store.catalog.source,
        variables=store.all_variables(),
        platforms=store.platforms(),
        standards=dict(STANDARDS),
    )


@router.get("/variables", response_model=list[VariableSummary])
def variables(store: DataStore = Depends(get_store)) -> list[VariableSummary]:
    out: list[VariableSummary] = []
    for key in store.all_variables():
        cfd = store.dataset_for(key)
        cv = CANONICAL[key]
        times = cfd.time_strings()
        dr = cfd.depth_range()
        out.append(
            VariableSummary(
                variable=key,
                standardName=cv.standard_name,
                units=cv.units,
                longName=cv.long_name,
                depthRange=(dr.top, dr.bottom),
                timeRange=(times[0], times[-1]) if times else ("", ""),
                validRange=cv.valid,
                colormap=cv.cmap,
                log=cv.log,
            )
        )
    return out


@router.get("/metadata/{variable}", response_model=GriddedField)
def metadata(variable: str, store: DataStore = Depends(get_store)) -> GriddedField:
    try:
        cfd = store.dataset_for(variable)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    cv = CANONICAL[variable]
    raw = cfd.raw_name(variable)
    times = cfd.time_strings()
    da = cfd.ds[raw]
    return GriddedField(
        variable=variable,
        standardName=cv.standard_name,
        units=cv.units,
        lat=[float(v) for v in cfd.lats],
        lon=[float(v) for v in cfd.lons],
        depth=[float(v) for v in cfd.depths],
        time=times,
        shape=tuple(int(da.sizes.get(d, 1)) for d in
                    (cfd.axes.time, cfd.axes.depth, cfd.axes.lat, cfd.axes.lon)),
        fillValue=None,
        source=cfd.source,
        synthetic=cfd.synthetic,
    )


@router.get("/presets")
def presets() -> dict:
    """Named regions. The natural-language layer and the UI resolve to these,
    so a demo lands on exactly the same block every time."""
    path = REPO_ROOT / "config" / "regions.presets.json"
    if not path.exists():
        return {"presets": []}
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


@router.get("/colormaps")
def colormaps() -> dict:
    return {"colormaps": raster.available()}


@router.get("/platforms", response_model=list[ParserCapabilities])
def platforms() -> list[ParserCapabilities]:
    """Every registered observation parser and what it can supply.

    This is the plugin architecture made visible: adding a parser file makes a
    new platform appear here, with no schema, endpoint or frontend change.
    """
    return REGISTRY.capabilities()
