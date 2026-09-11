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

from ..core.catalog import Catalog, active_path, clear_selection
from ..core.config import settings
from .services import restart
from .datastore import get_store, init_store, shutdown_store
from .routers import (
    assessment,
    bathymetry,
    catalog as catalog_router,
    chat as chat_router,
    currents,
    fields,
    instruments,
    matchup,
    observations,
    query as query_router,
    tiles,
    wcs,
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
    # active_path() is the runtime selection made from the UI if there is one,
    # and OCEANUPS_CATALOG otherwise. A stored selection that no longer opens
    # is discarded there rather than here: a past click must never be able to
    # stop the platform booting.
    # Clear any restart marker we are the result of. scripts/serve-api.mjs
    # consumes it when it restarts us, but under Docker the restart policy is
    # the supervisor and nothing else would ever remove the file.
    restart.REQUEST_FILE.unlink(missing_ok=True)

    chosen = active_path()
    cat = Catalog.load(chosen)
    log.info(
        "catalog %s (synthetic=%s) from %s%s",
        cat.id, cat.synthetic, cat.path,
        "" if cat.path == settings.catalog else "  [selected at runtime]",
    )
    try:
        store = init_store(cat)
    except Exception as exc:  # noqa: BLE001
        # A selection whose files EXIST but will not open -- truncated,
        # wrong format, unreadable -- would otherwise take the platform down
        # on every boot: the container restarts, reads the same choice, and
        # fails again, with no UI left to change it. One click must never be
        # able to do that, so a selection that cannot be opened is discarded
        # and the environment's own catalog is used instead.
        if chosen == settings.catalog:
            raise
        log.error("selected catalog %s failed to open (%s); falling back", cat.id, exc)
        clear_selection()
        cat = Catalog.load(settings.catalog)
        log.info("catalog %s (synthetic=%s) from %s", cat.id, cat.synthetic, cat.path)
        store = init_store(cat)

    # Warm the observation cache behind the API rather than in front of it.
    threading.Thread(target=store.prewarm, name="prewarm", daemon=True).start()

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
    app.include_router(instruments.router)
    app.include_router(matchup.router)
    app.include_router(assessment.router)
    app.include_router(query_router.router)
    app.include_router(chat_router.router)
    app.include_router(tiles.router)
    # WCS is ours, not xpublish's: MVP item 21 names WMS/WCS together, and no
    # xpublish plugin serves coverages.
    app.include_router(wcs.router)
    return app


app = create_app()
