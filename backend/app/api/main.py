"""FastAPI application factory.

Note on CORS: there is none, deliberately. The Next.js dev server rewrites
/api, /tiles, /wms and /opendap to this process, so the browser only ever makes
same-origin requests. That keeps AbortController semantics identical in dev and
production and removes a whole category of preflight problems with binary
responses.
"""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from ..core.catalog import Catalog
from ..core.config import settings
from .datastore import get_store, init_store, shutdown_store
from .routers import (
    bathymetry,
    catalog as catalog_router,
    currents,
    fields,
    matchup,
    observations,
    tiles,
)

log = logging.getLogger(__name__)

# Updated by the background mount below and reported at /api/health.
STANDARDS: dict[str, bool] = {"wms": False, "opendap": False}


def _mount_standards(app: FastAPI) -> None:
    """Mount the OGC WMS and OPeNDAP endpoints via xpublish.

    Runs on a background thread because importing xpublish-wms pulls in
    cartopy, datashader and numba and measured 30-70 s on this machine. The API
    must be usable immediately; the standards endpoints light up shortly after.

    Wrapped in try/except per plugin: xpublish-wms is the least mature
    dependency in the stack and the platform must never fail to boot because of
    it. /api/health reports what actually came up.
    """
    try:
        store = get_store()
        if store.model is None:
            return
        import xpublish  # noqa: WPS433

        plugins = {}
        try:
            from xpublish_wms import CfWmsPlugin

            plugins["wms"] = CfWmsPlugin()
        except Exception as exc:
            log.warning("WMS plugin unavailable: %s", exc)
        try:
            from xpublish_opendap import OpenDapPlugin

            plugins["opendap"] = OpenDapPlugin()
        except Exception as exc:
            log.warning("OPeNDAP plugin unavailable: %s", exc)

        if not plugins:
            log.warning("standards endpoints degraded: no xpublish plugins loaded")
            return

        rest = xpublish.Rest({"ocean": store.model.ds}, plugins=plugins)
        app.mount("/standards", rest.app)
        STANDARDS["wms"] = "wms" in plugins
        STANDARDS["opendap"] = "opendap" in plugins
        log.info("standards mounted at /standards: %s", sorted(plugins))
    except Exception as exc:
        log.warning("standards mounting failed entirely (API unaffected): %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    cat = Catalog.load(settings.catalog)
    log.info("catalog %s (synthetic=%s) from %s", cat.id, cat.synthetic, cat.path)
    init_store(cat)

    if settings.enable_xpublish:
        threading.Thread(
            target=_mount_standards, args=(app,), name="mount-standards", daemon=True
        ).start()

    yield
    shutdown_store()


def create_app() -> FastAPI:
    app = FastAPI(
        title="oceanUps API",
        description=(
            "Interactive ocean data visualization and model-observation "
            "intelligence platform (SIH 26067)."
        ),
        version="0.1.0",
        lifespan=lifespan,
    )
    app.include_router(catalog_router.router)
    app.include_router(fields.router)
    app.include_router(bathymetry.router)
    app.include_router(currents.router)
    app.include_router(observations.router)
    app.include_router(matchup.router)
    app.include_router(tiles.router)
    return app


app = create_app()
