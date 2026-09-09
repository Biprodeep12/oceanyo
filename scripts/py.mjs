#!/usr/bin/env node
// Launch the project's Python inside the backend package, from anywhere.
//
// Two things make the obvious npm script wrong, and both fail confusingly:
//
// 1. `backend/.venv/Scripts/python.exe -m ...` is not runnable by cmd.exe,
//    which npm uses on Windows. cmd reads a leading `/` as a switch, so it
//    parses the command as `backend` with a switch, and reports
//    "'backend' is not recognized as an internal or external command" --
//    a message that says nothing about slashes and sends you looking for a
//    missing venv that is right there.
//
// 2. `python -m app.pipeline.cli` puts the CURRENT directory on sys.path, and
//    from the repo root that directory does not contain `app`. It lives in
//    backend/. So even once the exe resolves, the import fails.
//
// Doing it here instead of in the script strings also makes the repo work on
// Linux and macOS, where the venv puts python in bin/ rather than Scripts/ --
// which the Docker images and the "platform-independent" requirement both
// need to be true.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = join(ROOT, "backend");

const candidates = [
  join(BACKEND, ".venv", "Scripts", "python.exe"), // Windows
  join(BACKEND, ".venv", "bin", "python3"), // POSIX
  join(BACKEND, ".venv", "bin", "python"),
];
const python = candidates.find((p) => existsSync(p));

if (!python) {
  console.error(
    "No virtualenv found under backend/.venv\n" +
      "Create one with Python 3.12 (not newer -- cartopy and numba lag):\n" +
      "  py -3.12 -m venv backend/.venv\n" +
      "  backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt",
  );
  process.exit(1);
}

const child = spawn(python, process.argv.slice(2), {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    // So `app` is importable no matter where npm was invoked from.
    PYTHONPATH: [BACKEND, process.env.PYTHONPATH].filter(Boolean).join(
      process.platform === "win32" ? ";" : ":",
    ),
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
