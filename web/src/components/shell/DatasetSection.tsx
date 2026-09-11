"use client";

// Choosing the dataset from the UI instead of from an environment variable.
//
// The catalog was always the single swap surface -- OCEANUPS_CATALOG, one line
// in docker-compose.yml. That is fine for the person who built it and useless
// to an evaluator sitting in front of the running app, who has to take "and it
// works on real data too" on trust. This makes the claim clickable.
//
// It applies the change by RESTARTING the API, and says so. A hot swap would
// have to replace the xpublish mount, drain in-flight requests and reset every
// piece of catalog-shaped state in this tab; see backend services/restart.py.
// The wait is real work -- the model file is being opened -- so the overlay
// counts it rather than pretending to be instant.

import { useCallback, useEffect, useRef, useState } from "react";

import { MenuRow, SectionLabel } from "@/components/ui";
import { IconSparkle, IconGrid } from "@/components/ui/icons";
import { api } from "@/lib/api/client";
import type { CatalogsResponse } from "@/lib/api/types";

const POLL_MS = 1500;
/** Long enough for a container restart plus opening a 300 MB model file. */
const GIVE_UP_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function DatasetSection() {
  const [data, setData] = useState<CatalogsResponse | null>(null);
  const [switching, setSwitching] = useState<{ id: string; label: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const ac = new AbortController();
    api
      .catalogs(ac.signal)
      .then(setData)
      .catch(() => {
        /* an older API without the endpoint: the section simply stays hidden */
      });
    return () => {
      alive.current = false;
      ac.abort();
    };
  }, []);

  /**
   * Wait for the API to come back ON THE REQUESTED CATALOG.
   *
   * Not "wait for /api/health to answer": during a `--reload` restart the old
   * process is still serving for a moment, so the first successful reply can
   * be the catalog we just switched away from. Polling for the id we asked for
   * is the only check that cannot pass early.
   */
  const waitForCatalog = useCallback(async (id: string) => {
    const started = Date.now();
    while (Date.now() - started < GIVE_UP_MS) {
      await sleep(POLL_MS);
      if (!alive.current) return;
      setElapsed(Math.round((Date.now() - started) / 1000));
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok) {
          const health = await res.json();
          if (health?.catalogId === id) {
            // A full navigation, deliberately, and without the session hash:
            // the time axis, depth levels, variable list, colour ranges,
            // cached observations and any uploaded 3D texture all belong to
            // the catalog we just left. Reloading is the one reset with no
            // stale corner left in it.
            // A router.push() is exactly what must NOT happen here: it keeps
            // the React tree, and with it every value that belongs to the old
            // catalog. The rule assumes a soft navigation is always better.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            window.location.assign("/");
            return;
          }
        }
      } catch {
        /* expected: the API is down for a few seconds */
      }
    }
    setError(
      "the API did not come back on the new catalog. Check the API log -- " +
        "it may have failed to open the dataset and fallen back.",
    );
    setSwitching(null);
  }, []);

  const choose = useCallback(
    async (id: string, label: string) => {
      setError("");
      try {
        const res = await api.selectCatalog(id);
        if (!res.restarting) return; // already the live one
        setSwitching({ id, label });
        setElapsed(0);
        void waitForCatalog(id);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [waitForCatalog],
  );

  if (!data || data.catalogs.length < 2) return null;

  const canSwitch = data.restart.supported;

  return (
    <>
      <SectionLabel>Dataset</SectionLabel>
      {data.catalogs.map((c) => {
        const blocked = !c.available || (!canSwitch && !c.active);
        const why = !c.available
          ? `Not on disk: ${c.missing.slice(0, 3).join(", ")}${
              c.missing.length > 3 ? ` +${c.missing.length - 3} more` : ""
            }${c.hint ? `  ·  Run: ${c.hint}` : ""}`
          : !canSwitch && !c.active
            ? data.restart.reason
            : c.source;
        return (
          <MenuRow
            key={c.id}
            type="radio"
            name="catalog"
            label={c.label}
            icon={c.synthetic ? <IconSparkle /> : <IconGrid />}
            checked={c.active}
            disabled={blocked}
            title={why}
            onChange={() => !blocked && choose(c.id, c.label)}
            detail={
              <span className="ze-sub truncate">
                {c.available
                  ? c.synthetic
                    ? "generated here · CF-1.8, GLORYS-shaped"
                    : c.source.split(" (")[0]
                  : c.hint
                    ? `missing · ${c.hint}`
                    : "missing on disk"}
              </span>
            }
          />
        );
      })}
      {!canSwitch && (
        <p className="ze-sub px-4 pb-1 !whitespace-normal">{data.restart.reason}.</p>
      )}
      {error && (
        <div className="mx-4 mb-1">
          <p className="ze-warn-box">{error}</p>
        </div>
      )}

      {switching && (
        <div className="ze-switch-overlay" role="status" aria-live="polite">
          <div className="ze-switch-card">
            <span className="ze-switch-spinner" aria-hidden />
            <strong>Loading {switching.label}</strong>
            <span className="ze-sub !whitespace-normal">
              The API is restarting and opening the dataset. This page reloads
              itself when it is ready.
            </span>
            <span className="ze-sub font-mono">
              {elapsed}s elapsed · usually ~{data.restart.etaSeconds}s
            </span>
          </div>
        </div>
      )}
    </>
  );
}
