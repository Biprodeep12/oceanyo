#!/usr/bin/env node
// Run the API, and bring it back when it asks to be restarted.
//
// Switching catalogs from the UI applies the change by restarting the API --
// see backend/app/api/services/restart.py for why a restart rather than a hot
// swap. In Docker `restart: unless-stopped` is that supervisor. In development
// there was none, and the two candidates both fail:
//
//   * uvicorn's --reload watcher. Tried first, and it is not reliable here:
//     WatchFiles logged "detected changes ... Reloading" and then hung with
//     the OLD process still serving, which is the worst possible failure for
//     this feature -- the UI waits for an API that never comes back, and the
//     dataset silently does not change.
//   * os.execv. Changes the PID on Windows, so whatever launched the process
//     is left supervising a PID that no longer exists.
//
// So the API exits with a distinctive code and this launcher starts it again.
// One mechanism in development and in Docker: the process exits, something
// outside it brings it back. `--reload` still runs for ordinary code edits.

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = join(ROOT, "backend");

/** Matches RESTART_EXIT_CODE in backend/app/api/services/restart.py. */
const RESTART_EXIT_CODE = 3;

/**
 * Matches REQUEST_FILE in that same module.
 *
 * The exit code alone is not enough. With `--reload` the process this script
 * spawns is uvicorn's RELOADER and the API runs in its child, so the code that
 * reaches us is the reloader's rather than the API's. The marker survives
 * either arrangement.
 */
const REQUEST_FILE = join(ROOT, ".runtime", "restart-requested");

const python = [
  join(BACKEND, ".venv", "Scripts", "python.exe"),
  join(BACKEND, ".venv", "bin", "python3"),
  join(BACKEND, ".venv", "bin", "python"),
].find((p) => existsSync(p));

if (!python) {
  console.error("No virtualenv found under backend/.venv -- see scripts/py.mjs");
  process.exit(1);
}

const args = process.argv.slice(2);
const env = {
  ...process.env,
  PYTHONPATH: [BACKEND, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(process.platform === "win32" ? ";" : ":"),
  // Tells /api/catalogs that a switch is possible: something is watching this
  // process and will start it again. Claiming that without this launcher is
  // how the picker would offer a control that kills the server.
  OCEANUPS_SUPERVISED: "1",
};

let child = null;
let stopping = false;

const start = () => {
  child = spawn(python, args, { cwd: ROOT, stdio: "inherit", env });
  child.on("exit", (code, signal) => {
    child = null;
    const asked = existsSync(REQUEST_FILE);
    if (asked) rmSync(REQUEST_FILE, { force: true });

    if (stopping) {
      process.exit(code ?? 0);
      return;
    }
    if (asked || code === RESTART_EXIT_CODE) {
      const why = asked ? "catalog change" : `exit ${code}`;
      console.log(`
[serve-api] restarting (${why})
`);
      start();
      return;
    }
    // A signal nobody here asked for: pass it on rather than swallow it, so
    // Ctrl+C in a parent shell still reads as an interrupt.
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
};

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    stopping = true;
    // Without this the loop would helpfully restart the API the user just
    // asked to stop, and Ctrl+C would appear not to work.
    child?.kill(sig);
  });
}

start();
