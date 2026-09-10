"""POST /api/query -- a phrase in, validated tool calls out.

Server-side because an API key cannot live in a browser bundle, and because
this is where the model's output gets checked against what the catalogue can
actually do. The frontend executes whatever comes back, so this is the boundary
that has to be trustworthy: see `services/nlq.py` for the rules.

The context the model is given is assembled here from the live datastore rather
than passed in by the client. A client-supplied vocabulary would be one more
thing to spoof, and it would let the two sides disagree about which regions and
variables exist.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ...core.conventions import CANONICAL
from ..datastore import DataStore, get_store
from ..services import nlq

router = APIRouter(prefix="/api", tags=["query"])


class QueryRequest(BaseModel):
    query: str = Field(..., max_length=400)


def _context(store: DataStore) -> dict:
    variables = store.all_variables()
    times: list[str] = []
    depth_range = [0.0, 2000.0]
    if variables:
        cfd = store.dataset_for(variables[0])
        times = cfd.time_strings()
        dr = cfd.depth_range()
        depth_range = [float(dr.top), float(dr.bottom)]

    import json

    from ...core.config import REPO_ROOT

    presets: list[str] = []
    path = REPO_ROOT / "config" / "regions.presets.json"
    if path.exists():
        with open(path, "r", encoding="utf-8") as fh:
            presets = [p["id"] for p in (json.load(fh).get("presets") or [])]

    # Instrument names, not the 992 profile ids: a float is what someone names,
    # and ninety cycles of it would crowd out the rest of the vocabulary.
    instruments = sorted({r.id.split(":", 1)[0] for r in store.observation_refs()})

    return {
        "variables": variables,
        "presets": presets,
        "times": times,
        "depthRange": depth_range,
        "instruments": instruments,
        "units": {v: CANONICAL[v].units for v in variables if v in CANONICAL},
    }


@router.post("/query")
def query(req: QueryRequest, store: DataStore = Depends(get_store)):
    """Interpret a phrase as tool calls against this catalogue.

    Returns an empty `tools` list rather than an error when no model is
    configured or the call fails -- the client has already resolved what it
    could locally, and a 500 here would turn an optional enhancement into a
    broken search box.
    """
    result = nlq.interpret(req.query, _context(store))
    result["config"] = nlq.configured()
    return result


@router.get("/query/status")
def query_status():
    """Whether the layer can reach a model, without spending a call to find out."""
    cfg = nlq.configured()
    return {
        "available": nlq.available(),
        # The key itself is never returned, only whether one is set.
        "baseUrl": cfg["baseUrl"],
        "model": cfg["model"],
        "enabled": cfg["enabled"],
        "note": (
            "Phrases are resolved locally first; the model is only asked about "
            "what the lookup table could not parse. It emits tool calls only -- "
            "every result is computed by this API."
        ),
    }
