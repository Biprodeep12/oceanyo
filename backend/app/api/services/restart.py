"""Applying a catalog change by restarting, rather than swapping in place.

**Why a restart.** A hot swap would have to do three things this does not:
replace the xpublish mount (mounted once at startup against `store.model.ds`,
and a Starlette Mount is not designed to be swapped -- so WMS and OPeNDAP would
go on serving the OLD dataset, a wrong answer on the one surface whose whole
job is standards compliance), drain in-flight requests before `ds.close()` runs
under them, and reset every piece of frontend state that is catalog-shaped.
A restart gets all three right by construction. It costs a wait, which the UI
shows, and the wait is honest: it is the dataset opening.

Everything else was already safe. `init_store`/`shutdown_store` exist; the
assessment cache keys on `store.catalog.id`; the glider cache keys on
`(path, mtime)`; profiles and NetCDF handles die with the store.

**How.** The process exits with a distinctive code and something outside it
starts it again: `restart: unless-stopped` under Docker, scripts/serve-api.mjs
in development. When nothing is watching, the endpoint refuses rather than
killing the server.

Two mechanisms were tried and rejected. uvicorn's --reload watcher, triggered
by touching a file: WatchFiles logged "detected changes ... Reloading" and then
hung with the old process still serving -- the UI waits for an API that never
comes back and the dataset silently does not change, which is worse than not
offering the control. And os.execv, which changes the PID on Windows, leaving
whatever launched the process supervising a PID that no longer exists.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
import time

from ...core.config import settings

log = logging.getLogger(__name__)

#: Exit code for a restart we asked for, so it reads as deliberate in
#: `docker compose logs` rather than as a crash. scripts/serve-api.mjs matches
#: on this number; keep the two in step.
RESTART_EXIT_CODE = 3

#: Written just before exiting. scripts/serve-api.mjs restarts on this OR on
#: the exit code, because which of the two reaches it depends on whether
#: uvicorn was started with --reload.
REQUEST_FILE = settings.runtime_dir / "restart-requested"


def mode() -> str:
    """Whether this process has a supervisor that would restart it.

    Declared, never guessed. Being inside a container was the obvious signal
    and it is the wrong one: `docker run` with no restart policy is also a
    container, and there this would offer a button that kills the API with
    nothing to bring it back. docker-compose.yml sets OCEANUPS_SUPERVISED
    beside the `restart:` line that makes it true, and scripts/serve-api.mjs
    sets it because it IS the supervisor.
    """
    configured = (settings.restart_mode or "auto").strip().lower()
    if configured in {"exit", "off"}:
        return configured
    return "exit" if settings.supervised else "off"


def capability() -> dict:
    """What the UI needs to know before it offers the control."""
    m = mode()
    return {
        "mode": m,
        "supported": m != "off",
        "reason": {
            "exit": "the API will restart itself and reload this page",
            "off": (
                "nothing would restart this process: start the API with "
                "`npm run dev:api` or under docker compose -- or set "
                "OCEANUPS_CATALOG yourself and restart it"
            ),
        }[m],
        # A hint for the progress UI, not a promise. Opening the model and
        # indexing the observations is the bulk of it: measured 4.7 s for the
        # synthetic catalog, and a container restart adds its own overhead.
        "etaSeconds": 30,
    }


def request_restart(delay: float = 0.5) -> str:
    """Restart shortly, so the HTTP response goes out first.

    The delay is not cosmetic: the client needs the response to know what to
    poll for. Without it the socket dies with the process and the browser sees
    a network error, which looks identical to the feature being broken.
    """
    m = mode()
    if m == "off":
        raise RuntimeError(capability()["reason"])

    def run() -> None:
        time.sleep(delay)
        # Say so on disk before dying. An exit code does not survive every
        # process tree -- see below -- but a file does, and the launcher
        # restarts on either signal.
        try:
            REQUEST_FILE.parent.mkdir(parents=True, exist_ok=True)
            REQUEST_FILE.write_text("restart", encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            log.warning("could not write the restart marker (%s): %s", REQUEST_FILE, exc)

        # Under `uvicorn --reload` THIS process is the reloader's child. It
        # does not own the listening socket, and its parent does not watch it:
        # killing only ourselves leaves the reloader holding the port with
        # nothing behind it, and the launcher -- whose child is the reloader,
        # not us -- never sees an exit at all. The API would simply be gone.
        # Verified the wrong way round first: the switch was tested without
        # --reload, which is the one arrangement where exiting alone works.
        if "--reload" in sys.argv:
            try:
                log.info("asking the uvicorn reloader (pid %d) to stop", os.getppid())
                os.kill(os.getppid(), signal.SIGTERM)
            except Exception as exc:  # noqa: BLE001
                log.warning("could not stop the reloader: %s", exc)

        log.info("exiting with %d so the supervisor restarts us", RESTART_EXIT_CODE)
        # _exit, not sys.exit: this is a daemon thread, and SystemExit raised
        # here would be swallowed and the process would stay up on the old
        # catalog while the UI waited for a restart that never came.
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except Exception:  # noqa: BLE001
                pass
        os._exit(RESTART_EXIT_CODE)

    threading.Thread(target=run, name="restart", daemon=True).start()
    return m
