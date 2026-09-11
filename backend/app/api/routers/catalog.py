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
from ..services import nlq
from ..services.anomaly import available_variables

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
        nlq=nlq.available(),
        climatology=(
            available_variables(store.model, store.climatology) if store.model else []
        ),
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
                # What the data spans, as opposed to what would be physically
                # valid. The colour bar defaults to this; the slider still
                # ranges over validRange so a user can widen it.
                dataRange=cfd.data_range(key),
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
    """Named regions, filtered to the model actually loaded.

    The presets file is shared by every catalog, so it necessarily lists
    regions some of them do not cover: the Mozambique Channel is nowhere near
    `catalog.hycom.yaml`'s Bay of Bengal box, and selecting it there yields an
    empty block with no explanation. Offering a region the model cannot answer
    is worse than offering fewer regions -- and this list feeds the region
    picker, the command palette AND the assistant's tool schema, so filtering
    once here fixes all three.
    """
    path = REPO_ROOT / "config" / "regions.presets.json"
    if not path.exists():
        return {"presets": []}
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)

    cfd = get_store().model
    if cfd is None:
        return raw

    box = cfd.bbox()
    west, south, east, north = box.west, box.south, box.east, box.north
    kept, dropped = [], []
    for item in raw.get("presets", []):
        w, s_, e, n = item["bbox"]
        if w >= east or e <= west or s_ >= north or n <= south:
            dropped.append(item["id"])
            continue
        kept.append(item)
    return {"presets": kept, "outsideModel": dropped}


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
