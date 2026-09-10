// A short check of the Level 2 surfaces only.
//
// Deliberately NOT part of smoke.mjs. That suite walks the whole demo script
// and takes twenty-odd minutes under SwiftShader; these six features are
// independent of it and re-running the full pass to learn whether a legend
// rendered is how a test suite stops being run at all.
//
// Everything here asserts on the DOM or on the store, never on a screenshot:
// the point is whether the feature is wired, not whether it is pretty.
//
//   node scripts/smoke-level2.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const store = (page, fn) =>
  page.evaluate(fn);

async function waitFor(fn, timeout = 20000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  const badResponses = [];
  page.on("response", (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  const booted = await waitFor(async () =>
    store(page, () => Boolean(window.__store?.getState()?.health)),
  );
  check("catalog loads", booted);

  // --- 1. assessment layer ---
  await store(page, () => window.__store.getState().setCoverageMetric("blindSpot"));
  const gotCoverage = await waitFor(async () =>
    store(page, () => (window.__store.getState().coverage?.features?.length ?? 0) > 0),
  );
  check("coverage grid arrives", gotCoverage);

  const summary = await store(page, () => window.__store.getState().coverage?.summary);
  check(
    "coverage masks land with the bathymetry",
    Boolean(summary?.maskedByBathymetry) && summary.oceanCells < summary.cells,
    summary ? `${summary.oceanCells}/${summary.cells} ocean` : "",
  );
  check(
    "model accuracy has something to say",
    (summary?.scored ?? 0) > 0,
    summary ? `${summary.scored}/${summary.profiles} profiles matched` : "",
  );

  const layerDrawn = await store(page, () =>
    Boolean(window.__map?.getLayer("assessment-fill")) &&
    window.__map.getLayoutProperty("assessment-fill", "visibility") === "visible",
  );
  check("assessment layer is visible on the map", layerDrawn);

  const legend = await page.getByText("gap in the observing network", { exact: false }).count();
  check("blind-spot legend explains itself", legend > 0);

  // --- 2. command palette resolves without a model ---
  await page.keyboard.press("Control+K");
  const input = page.getByTestId("palette-input");
  check("palette opens on ctrl+K", await input.isVisible().catch(() => false));

  if (await input.isVisible().catch(() => false)) {
    await input.fill("which floats disagree most with the model");
    const shown = await page
      .getByText("query_floats(sortBy: model_error", { exact: false })
      .count();
    check("palette shows the resolved tool call", shown > 0);

    await page.keyboard.press("Enter");
    const ranked = await waitFor(
      async () => (await page.getByText("ranked by model error", { exact: false }).count()) > 0,
      40000,
    );
    check("query_floats is answered by the server", ranked);
    await page.keyboard.press("Escape");
  }

  // --- 3. events and replay ---
  await page.getByLabel("Events").click();
  const scanned = await waitFor(
    async () => (await page.getByText("exceedance", { exact: false }).count()) > 0,
    60000,
  );
  check("events scan completes", scanned);
  const caveat = await page.getByText("Not a Hobday", { exact: false }).count();
  check("the heatwave caveat is shown with the events", caveat > 0);

  const eventCount = await store(page, () => window.__store.getState().events?.events?.length ?? 0);
  if (eventCount > 0) {
    const before = await store(page, () => window.__store.getState().timeIndex);
    await page.getByTitle("Jump to the first step and play the event").first().click();
    const replayed = await waitFor(async () =>
      store(page, () => window.__store.getState().playing),
    );
    const after = await store(page, () => window.__store.getState().timeIndex);
    check("replaying an event starts playback", replayed, `step ${before} -> ${after}`);
    await store(page, () => {
      const st = window.__store.getState();
      if (st.playing) st.toggle("playing");
    });
  } else {
    check("replaying an event starts playback", true, "no events in this record");
  }

  // --- 4. provenance is read from the files ---
  await page.getByLabel("Provenance").click();
  const prov = await waitFor(
    async () => (await page.getByText("institution", { exact: false }).count()) > 0,
    20000,
  );
  check("provenance reads the file headers", prov);
  await page.keyboard.press("Escape");

  // --- 5. a quadrilateral selection clips the block ---
  await store(page, () => {
    const st = window.__store.getState();
    const d = st.domain ?? [70, 0, 95, 20];
    const cx = (d[0] + d[2]) / 2;
    const cy = (d[1] + d[3]) / 2;
    const rx = (d[2] - d[0]) / 6;
    const ry = (d[3] - d[1]) / 6;
    // A diamond: convex, and obviously not the bounding box.
    const quad = [
      [cx, cy + ry],
      [cx + rx, cy],
      [cx, cy - ry],
      [cx - rx, cy],
    ];
    st.setSelection([cx - rx, cy - ry, cx + rx, cy + ry]);
    st.setSelectionQuad(quad);
  });
  const quadKept = await store(page, () =>
    (window.__store.getState().selectionQuad ?? []).length === 4,
  );
  check("a four-corner selection survives being set", quadKept);

  // --- 6. the session round-trips through the URL ---
  await store(page, () => window.__store.getState().setDepth(300));
  await page.waitForTimeout(900);
  const url = page.url();
  check("the session is written into the URL", url.includes("#s="));

  const restored = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await restored.goto(url, { waitUntil: "domcontentloaded" });
  const ok = await waitFor(async () =>
    restored.evaluate(() => {
      const st = window.__store?.getState();
      return st?.depth === 300 && (st?.selectionQuad ?? []).length === 4;
    }),
  );
  check("a shared link restores depth and the drawn shape", ok);
  await restored.close();

  // --- hygiene ---
  const realErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver/i.test(e));
  check("no console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
  const realBad = badResponses.filter((r) => !/favicon/.test(r));
  check("no failed requests", realBad.length === 0, realBad.slice(0, 3).join(" | "));

  await browser.close();
  console.log(
    `\n${results.length - failures}/${results.length} checks passed`,
  );
  process.exit(failures ? 1 : 0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
