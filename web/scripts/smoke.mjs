// Browser smoke test: drives the actual demo path and reports console errors.
// Run with both dev servers up:  node web/scripts/smoke.mjs
import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Relative to THIS file, not the shell's working directory, so the
// screenshots always land in web/smoke/ whether the test is run from the repo
// root or from web/ -- otherwise they scatter and escape .gitignore.
const OUT =
  process.env.SMOKE_OUT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../smoke");
mkdirSync(OUT, { recursive: true });

const errors = [];
const failedRequests = [];

const browser = await chromium.launch({
  args: [
    // Headless Chromium needs a software GL backend for WebGL to work at all.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// A full-viewport ray-march takes tens of seconds per frame on SwiftShader, and
// Playwright's actionability checks need the main thread to answer. The default
// 30 s assumes a GPU; on this renderer it fails healthy pages.
page.setDefaultTimeout(75_000);

page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
const requests = [];
const badResponses = [];
page.on("request", (r) => requests.push(r.url()));
page.on("response", (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
});
page.on("requestfailed", (r) =>
  failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`),
);

/**
 * Screenshots are diagnostics, not assertions, and this runs on SwiftShader
 * where a full-viewport ray-march takes seconds PER FRAME -- the default 30 s
 * capture timeout expires on a page that is perfectly healthy. The elapsed
 * time is printed so a genuine hang still shows up as one.
 */
const shot = async (name) => {
  const t0 = Date.now();
  await page.screenshot({ path: `${OUT}/${name}`, timeout: 180000 });
  const ms = Date.now() - t0;
  if (ms > 8000) console.log(`
      (${name} took ${(ms / 1000).toFixed(1)}s -- software renderer)`);
};

/** Presets live behind the Regions button in the right-hand rail. */
const pickRegion = async (name) => {
  await page.getByRole("button", { name: "Regions", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForTimeout(500);
};

/**
 * 127.0.0.1, not localhost -- and that is not a style choice.
 *
 * They are different ORIGINS to Next's dev server, and it will refuse the HMR
 * websocket upgrade from one it has not been told about. When it does, the
 * page still server-renders, React still loads, and then Turbopack never
 * delivers the dynamic() chunks it serves over that socket. Both canvases are
 * ssr:false, so the route suspends: no map, no variables, an empty timeline,
 * and not one error in the console.
 *
 * This suite ran green through that entire failure because it asked for
 * localhost, which was the one host that worked. A test that only exercises
 * the working address is how a dead page ships.
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3000";

/**
 * Move the timeline to a step that actually has instruments in view.
 *
 * Observations are shown only within one model step of the displayed time, so
 * whether ANY float is clickable depends on where the scrubber is. The Indian
 * Ocean catalog opens on July 2023 and the floats in it start in September, so
 * the first step legitimately has none -- and every instrument assertion after
 * it failed with "no instruments", which reads like a broken renderer and is
 * really a calendar. Find a populated step before asserting anything about
 * instruments.
 */
const seekObservations = async () => {
  const count = async () =>
    page.evaluate(() => {
      const m = /(\d+) of \d+ within/.exec(document.body.innerText);
      return m ? Number(m[1]) : 0;
    });
  if ((await count()) > 0) return true;
  const steps = await page.evaluate(() => {
    const m = /\/\s*(\d+)/.exec(document.body.innerText);
    return m ? Number(m[1]) : 1;
  });
  for (let i = 1; i < steps; i++) {
    await page.getByRole("button", { name: "Next step" }).click();
    await page.waitForTimeout(700);
    if ((await count()) > 0) return true;
  }
  return false;
};

/**
 * Click the instrument in the 3D block, at the position the scene reports.
 *
 * The old version swept a grid of blind clicks. Two problems: on a software
 * renderer a fine enough grid takes minutes, and a coarse one only works when
 * there are enough floats that something is always under the cursor -- which
 * is how a DEAD raycast passed this step for weeks. Ask the scene where the
 * instrument is, then click there; if that misses, the raycast is broken and
 * the test should say so rather than keep looking.
 */
const clickFloat = async () => {
  const pts = await page.evaluate(() => window.__floatPoints?.() ?? []);
  if (!pts.length) throw new Error("no instruments in the block to click");
  // A tight ring around each reported position. The point comes from the
  // scene, so this is not a search -- it absorbs a pixel or two of rounding
  // between three's projection and the browser's hit test, and nothing more.
  // If a capsule is not clickable within a few pixels of where the scene says
  // it is, the raycast is broken and the test should say so.
  const ring = [[0, 0], [0, -6], [6, 0], [0, 6], [-6, 0], [0, -12], [0, 12]];
  // Prefer an instrument that actually has statistics. A real float's first
  // cycle is often a near-empty deployment profile -- one of ours returns a
  // single finite level flagged bad -- and a panel of dashes is a correct
  // answer that proves nothing about the matchup.
  for (const p of pts) {
    for (const [dx, dy] of ring) {
      await page.mouse.click(p.x + dx, p.y + dy);
      // WAIT for the panel; do not just look. Opening it costs a profile fetch
      // and a matchup, so an immediate isVisible() is always false and the loop
      // races on to click somewhere else. The old grid sweep only ever passed
      // because with thirty floats a later probe's check happened to catch an
      // earlier probe's panel -- a green step that proved nothing about the
      // click it was attributed to.
      const opened = await page
        .getByText(/profile$/i)
        .first()
        .waitFor({ timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (!opened) continue;
      // Numeric stats, or keep looking. A real float's first cycle is often a
      // near-empty deployment profile -- one of ours has a single finite level,
      // flagged bad -- and a panel of dashes is a CORRECT answer that proves
      // nothing about the matchup. Asserting on it would be asserting on
      // whichever instrument happened to be nearest the camera.
      const hasStats = await page.evaluate(() =>
        /BIAS\s+[+\-]\d/i.test(document.body.innerText.replace(/\s+/g, " ")),
      );
      if (hasStats || p === pts[pts.length - 1]) return { ...p, hasStats };
    }
  }
  throw new Error(
    `raycast missed all ${pts.length} instrument(s) at their own reported positions`,
  );
};

const step = async (name, fn) => {
  process.stdout.write(`  ${name.padEnd(38)}`);
  try {
    await fn();
    console.log("ok");
  } catch (e) {
    console.log(`FAIL -- ${e.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
};

console.log("browser smoke test");

await step("load page", async () => {
  // networkidle never settles: the map keeps requesting tiles.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
});

await step("WebGL2 available", async () => {
  const info = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    return {
      max3d: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
      version: gl.getParameter(gl.VERSION),
    };
  });
  if (!info) throw new Error("no WebGL2 context");
  console.log(`\n      MAX_3D_TEXTURE_SIZE=${info.max3d}  ${info.version}`);
  process.stdout.write(" ".repeat(40));
});

await step("catalog loaded (variables listed)", async () => {
  await page.waitForFunction(
    () => document.querySelectorAll('input[type="radio"][name="variable"]').length >= 4,
    { timeout: 30000 },
  );
});

await step("provenance matches the catalog", async () => {
  // Not "SYNTHETIC is present". The badge must agree with the catalog that is
  // actually loaded, in BOTH directions: three separate places hardcoded the
  // word and cheerfully stamped it on genuine HYCOM output. Over-disclosure
  // looks like caution, so nobody checks for it -- which is exactly why the
  // assertion has to be two-sided.
  const health = await page.evaluate(async () => (await fetch("/api/health")).json());
  const body = await page.evaluate(() => document.body.innerText);
  const shown = body.includes("SYNTHETIC");
  if (health.synthetic && !shown) throw new Error("synthetic catalog, no SYNTHETIC badge");
  if (!health.synthetic && shown) {
    throw new Error(`real catalog (${health.catalogId}) still labelled SYNTHETIC`);
  }
  console.log(`
      catalog ${health.catalogId} · synthetic=${health.synthetic}`);
  process.stdout.write(" ".repeat(40));
});

await step("map canvas rendered", async () => {
  await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 20000 });
});

await step("screenshot: map mode", async () => {
  await page.waitForTimeout(3500); // let tiles settle
  await shot("01-map.png");
});

await step("pointer readout shows a value", async () => {
  const box = await page.locator("canvas.maplibregl-canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.waitForTimeout(1200);
  const bubble = await page
    .getByTestId("hover-bubble")
    .textContent()
    .catch(() => null);
  if (!bubble || !/-?\d+\.\d\d/.test(bubble)) {
    throw new Error(`no sampled value under the cursor: ${bubble ?? "no bubble"}`);
  }
  const coords = (await page.getByTestId("coords").textContent()) ?? "";
  if (!/\d+°\s\d+'\s[NS]/.test(coords)) {
    throw new Error(`no coordinate readout: ${JSON.stringify(coords)}`);
  }
  console.log(`
      cursor: ${bubble.replace(/\s+/g, " ").trim()}  @ ${coords.trim()}`);
  process.stdout.write(" ".repeat(40));
  await shot("13-pointer.png");
});

await step("shift+drag draws a region", async () => {
  // Guards a bug that nothing else here could see: the hidden 3D canvas sat on
  // top of the map with pointer-events re-enabled by its own container, so the
  // map received no mouse events at all. Everything still LOOKED right,
  // because the preset buttons bypass the map entirely.
  const box = await page.locator("canvas.maplibregl-canvas").boundingBox();
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 700, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 900, box.y + 470, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(600);
  if (await page.getByRole("button", { name: "Dive" }).isDisabled()) {
    throw new Error("Dive still disabled: the map never received the drag");
  }
});

await step("select preset region", async () => {
  // exact: there is also a "Central Bay of Bengal" preset.
  await pickRegion("Bay of Bengal");
});

await step("timeline reaches a step with instruments", async () => {
  if (!(await seekObservations())) {
    throw new Error("no timestep in this catalog has observations in view");
  }
  const t = await page.evaluate(() => document.body.innerText);
  console.log(`
      ${/\d+ of \d+ within \d+ days/.exec(t)?.[0] ?? "?"}`);
  process.stdout.write(" ".repeat(40));
});

await step("screenshot: region selected", async () => {
  await shot("02-selected.png");
});

await step("dive -> block mode", async () => {
  await page.getByRole("button", { name: "Dive" }).click();
  // Wait for the transition plus the coarse volume.
  await page.waitForFunction(
    () => document.body.innerText.includes("drag to orbit"),
    { timeout: 45000 },
  );
});

await step("screenshot: block mode", async () => {
  await page.waitForTimeout(3000);
  await shot("03-block.png");
});

await step("block canvas is drawing pixels", async () => {
  const nonEmpty = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll("canvas")];
    // The r3f canvas is the one that is not the maplibre canvas.
    const c = canvases.find((x) => !x.classList.contains("maplibregl-canvas"));
    if (!c) return { found: false };
    return { found: true, w: c.width, h: c.height };
  });
  if (!nonEmpty.found) throw new Error("no three.js canvas found");
  if (!nonEmpty.w || !nonEmpty.h) throw new Error("three.js canvas has zero size");
});

await step("click a float -> matchup panel", async () => {
  const hit = await clickFloat();
  console.log(`
      block click -> ${hit.id}`);
  process.stdout.write(" ".repeat(40));
});

await step("click a marker on the MAP opens a profile", async () => {
  // This path had NO handler at all until someone tried it: the markers were
  // drawn and coloured by model error and were completely inert. It was never
  // caught because this suite only ever clicked floats after Dive.
  await page.getByRole("button", { name: "Back to map" }).click();
  await page.waitForTimeout(1500);
  await seekObservations();
  const hit = await page.evaluate(() => {
    const m = window.__map;
    const f = m.queryRenderedFeatures({ layers: ["obs-circles"] })[0];
    if (!f) return null;
    const p = m.project(f.geometry.coordinates);
    return { x: Math.round(p.x), y: Math.round(p.y), id: f.properties.id };
  });
  if (!hit) throw new Error("no instrument markers rendered on the map");
  await page.mouse.click(hit.x, hit.y);
  await page.getByText(/profile$/i).first().waitFor({ timeout: 20000 });

  // Selecting must also SAY which one: ring, tag and a zoom that only goes in.
  const tagged = await page.evaluate(
    (id) => document.body.innerText.replace(/\s+/g, " ").includes(id),
    hit.id,
  );
  if (!tagged) throw new Error(`selection tag missing for ${hit.id}`);
  console.log(`
      map click -> ${hit.id}, tagged`);
  process.stdout.write(" ".repeat(40));
  await shot("14-map-click.png");
});

await step("re-enter the block for the remaining checks", async () => {
  await pickRegion("Bay of Bengal");
  await page.getByRole("button", { name: "Dive" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("drag to orbit"), {
    timeout: 60000,
  });
  await page.waitForTimeout(2500);
  await clickFloat();
});

await step("matchup statistics shown", async () => {
  await page.getByText("Bias", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByText("RMSE", { exact: true }).waitFor({ timeout: 5000 });
  const stats = await page.evaluate(() => document.body.innerText);
  const m = stats.match(/BIAS\s*\n?\s*([+\-0-9.]+)/i);
  console.log(`
      reported bias: ${m ? m[1] : "?"}`);
  process.stdout.write(" ".repeat(40));
  await shot("05-matchup.png");
});

await step("isosurface renders", async () => {
  await page.getByLabel("Isosurface").check();
  const ok = await page
    .waitForResponse((r) => r.url().includes("/api/isosurface") && r.status() === 200, {
      timeout: 30000,
    })
    .then(() => true)
    .catch(() => false);
  if (!ok) throw new Error("no successful isosurface response");
  await page.waitForTimeout(2500);
  await shot("06-isosurface.png");
  await page.getByLabel("Isosurface").uncheck();
});

await step("current particles advecting", async () => {
  // The velocity texture and its decode metadata must both arrive, or the
  // advection shader has nothing to sample.
  const meta = requests.filter((u) => u.includes("/api/currents") && u.includes("fmt=meta"));
  const png = requests.filter((u) => u.includes("/api/currents") && !u.includes("fmt=meta"));
  if (!meta.length || !png.length) {
    throw new Error(`currents meta=${meta.length} png=${png.length}`);
  }
  await shot("07-particles.png");
});

await step("colorbar drives tiles", async () => {
  await page.getByRole("button", { name: "Back to map" }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Edit colour scale" }).click();
  const min = page.locator("input[type=number]").first();
  const max = page.locator("input[type=number]").nth(1);
  await min.fill("24");
  await min.press("Enter");
  await max.fill("30");
  await max.press("Enter");
  await page.waitForTimeout(2500);
  const scoped = requests.filter((u) => u.includes("vmin=24") && u.includes("vmax=30"));
  if (!scoped.length) throw new Error("no tiles requested with the edited range");
  await shot("09-colorbar.png");
});

await step("anomaly layer vs climatology", async () => {
  // Map mode. The toggle only exists for variables the catalog has a
  // climatology for, so its absence is itself a failure worth catching.
  await page.getByLabel("Show anomaly").check();
  const ok = await page
    .waitForResponse((r) => r.url().includes("/tiles/anomaly/") && r.status() === 200, {
      timeout: 30000,
    })
    .then(() => true)
    .catch(() => false);
  if (!ok) throw new Error("no successful anomaly tile response");
  await page.waitForTimeout(2000);
  await shot("10-anomaly.png");

  // The toggle outlives the variable. Switching to one the catalog has no
  // climatology for must stop the layer silently, not keep requesting tiles
  // that correctly 404.
  await page.getByLabel("Chlorophyll", { exact: true }).check();
  await page.waitForTimeout(2500);
  const stray = requests.filter((u) => u.includes("/tiles/anomaly/chlorophyll"));
  if (stray.length) throw new Error(`${stray.length} anomaly tiles without a climatology`);

  await page.getByLabel("Temperature", { exact: true }).check();
  await page.waitForTimeout(600);
  await page.waitForTimeout(3000); // the basin-wide anomaly render blocks the thread
  await page.getByLabel("Show anomaly").uncheck();
});

await step("glider tracks in the water column", async () => {
  // Where the gliders are is a property of the CATALOG, not a constant. The
  // synthetic one puts them in the Bay of Bengal; the real GDAC has not one
  // Bay of Bengal deployment in it, and the basin catalog's gliders are in the
  // Mozambique Channel. A hardcoded preset asserted the synthetic layout and
  // reported real data as a failure.
  const g = await page.evaluate(async () => {
    const r = await fetch("/api/observations?limit=4000&platform=glider");
    const j = await r.json();
    const f = j.features?.[0];
    return f ? { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : null;
  });
  if (!g) {
    console.log("\n      no gliders in this catalog; skipped");
    process.stdout.write(" ".repeat(40));
    return;
  }
  await page.evaluate(
    ({ lon, lat }) => {
      const st = window.__store?.getState?.();
      if (st) st.setSelection([lon - 2, lat - 2, lon + 2, lat + 2]);
    },
    g,
  );
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Dive" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("drag to orbit"), {
    timeout: 90000,
  });
  await page.waitForTimeout(5000);
  if (!requests.some((u) => u.includes("/api/profile/glider"))) {
    // Before calling this a failure, check whether any glider is
    // CONTEMPORANEOUS with any model step. The Indian Ocean catalogue's only
    // deployment ran in September 2025 and its model ends in June 2024, so the
    // time filter correctly draws nothing -- and reporting that as "gliders are
    // broken" sends the next person to read GliderTracks.tsx for an afternoon.
    const overlap = await page.evaluate(async () => {
      const [obs, meta] = await Promise.all([
        fetch("/api/observations?limit=5000&platform=glider").then((r) => r.json()),
        fetch("/api/metadata/temperature").then((r) => r.json()),
      ]);
      const times = (obs.features ?? []).map((f) => Date.parse(f.properties.time));
      const steps = (meta.time ?? []).map((t) => Date.parse(t));
      if (!times.length || !steps.length) return null;
      const near = times.some((t) => steps.some((s) => Math.abs(s - t) < 60 * 864e5));
      return {
        near,
        obs: [new Date(Math.min(...times)), new Date(Math.max(...times))],
        model: [new Date(Math.min(...steps)), new Date(Math.max(...steps))],
      };
    });
    if (overlap && !overlap.near) {
      console.log(
        `\n      gliders are outside the model record ` +
          `(${overlap.obs[0].toISOString().slice(0, 7)}..${overlap.obs[1].toISOString().slice(0, 7)}` +
          ` vs ${overlap.model[0].toISOString().slice(0, 7)}..${overlap.model[1].toISOString().slice(0, 7)});` +
          ` nothing to draw -- skipped`,
      );
      process.stdout.write(" ".repeat(40));
      return;
    }
    throw new Error("no glider trajectory fetched");
  }
  await shot("11-gliders.png");
});

await step("cross-section curtain", async () => {
  await page.getByLabel("Cross-section").check();
  const canvas = await page.locator("canvas").last().boundingBox();
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;

  // The pick plane is the top face of the block, so its screen position
  // depends on the camera. Probe until the panel confirms each point landed.
  const probe = async (want, offsets) => {
    for (const [dx, dy] of offsets) {
      await page.mouse.click(cx + dx, cy + dy);
      await page.waitForTimeout(150);
      const text = await page.evaluate(() => document.body.innerText);
      if (text.includes(want)) return true;
    }
    return false;
  };

  const first = [];
  for (let dx = -220; dx <= 60; dx += 40) {
    for (let dy = -170; dy <= -30; dy += 35) first.push([dx, dy]);
  }
  if (!(await probe("click the second point", first))) {
    throw new Error("first section point never registered");
  }

  const second = [];
  for (let dx = 60; dx <= 260; dx += 40) {
    for (let dy = -120; dy <= 40; dy += 35) second.push([dx, dy]);
  }
  // Two acceptable strings, because the transect became a polyline: with two
  // points down the panel now invites more of them rather than declaring the
  // section finished. Asserting on prose is brittle -- but the alternative
  // here is asserting on the store, which would stop testing that the USER can
  // see the section was placed.
  if (
    !(await probe("keep clicking to bend the transect", second)) &&
    !(await probe("curtain sampled at the model levels", second))
  ) {
    throw new Error("second section point never registered");
  }

  // Both the level table (JSON) and the pixels (PNG) must arrive.
  await page.waitForTimeout(3000);
  const json = requests.filter(
    (u) => u.includes("/api/section") && !u.includes("fmt=png"),
  );
  const png = requests.filter((u) => u.includes("/api/section") && u.includes("fmt=png"));
  if (!json.length || !png.length) {
    throw new Error(`section json=${json.length} png=${png.length}`);
  }
  await shot("12-section.png");
});

await step("back to map", async () => {
  await page.getByRole("button", { name: "Back to map" }).click();
  await page.waitForTimeout(1200);
  await shot("04-back.png");
});


// ---------------------------------------------------------------- mobile
//
// A phone is not a narrow desktop: the panels become sheets, the layer list
// moves behind a rail button, and shift+drag -- the only way to select a
// region with a mouse -- cannot exist at all. That last one is why this
// section is here rather than being eyeballed once: tap-to-draw is the only
// path to the 3D block on a touch device, so if it breaks the app is a
// read-only map and nothing in the desktop run would notice.

console.log("\nmobile (Pixel 7)");

const mctx = await browser.newContext({ ...devices["Pixel 7"] });
const mpage = await mctx.newPage();
mpage.setDefaultTimeout(75_000);
const mErrors = [];
mpage.on("console", (m) => m.type() === "error" && mErrors.push(m.text()));
mpage.on("pageerror", (e) => mErrors.push(`PAGEERROR: ${e.message}`));

const mstep = async (name, fn) => {
  process.stdout.write(`  ${name.padEnd(38)}`);
  try {
    await fn();
    console.log("ok");
  } catch (e) {
    console.log(`FAIL -- ${e.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
};

await mstep("load on a phone viewport", async () => {
  await mpage.waitForTimeout(2000);
  await mpage.goto(BASE, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await mpage.waitForSelector("canvas.maplibregl-canvas", { timeout: 90000 });
  await mpage.waitForTimeout(4000);
  const size = mpage.viewportSize();
  if (size.width > 500) throw new Error(`not a phone viewport: ${size.width}px`);
  await mpage.screenshot({ path: `${OUT}/m1-map.png`, timeout: 90000 });
});

await mstep("no horizontal overflow", async () => {
  // A single overflowing panel makes the whole map pannable sideways and the
  // layout unusable; it is the classic responsive regression.
  const over = await mpage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (over > 1) throw new Error(`page scrolls ${over}px horizontally`);
});

await mstep("layers open as a sheet", async () => {
  await mpage.getByRole("button", { name: "Layers", exact: true }).click();
  await mpage.waitForTimeout(500);
  await mpage.getByLabel("Temperature", { exact: true }).waitFor({ timeout: 10000 });
  await mpage.screenshot({ path: `${OUT}/m2-layers.png`, timeout: 90000 });
  await mpage.getByRole("button", { name: "Close layers" }).click();
  await mpage.waitForTimeout(400);
});

await mstep("tap two corners -> region", async () => {
  await mpage.getByRole("button", { name: "Draw region", exact: true }).click();
  const box = await mpage.locator("canvas.maplibregl-canvas").boundingBox();
  await mpage.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.35);
  await mpage.waitForTimeout(400);
  const hint = await mpage.evaluate(() => document.body.innerText);
  if (!/opposite corner/.test(hint)) throw new Error("first corner did not register");
  await mpage.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.62);
  await mpage.waitForTimeout(700);
  if (await mpage.getByRole("button", { name: "Dive" }).isDisabled()) {
    throw new Error("Dive still disabled after tapping two corners");
  }
  await mpage.screenshot({ path: `${OUT}/m3-region.png`, timeout: 90000 });
});

await mstep("dive works on a phone", async () => {
  await mpage.getByRole("button", { name: "Dive" }).click();
  await mpage.waitForFunction(
    () => document.body.innerText.includes("drag to orbit"),
    { timeout: 60000 },
  );
  await mpage.waitForTimeout(2500);
  await mpage.screenshot({ path: `${OUT}/m4-block.png`, timeout: 90000 });
});

console.log("mobile console errors:", mErrors.length);
for (const e of mErrors.slice(0, 6)) console.log("   -", e.slice(0, 200));
if (mErrors.length) process.exitCode = 1;

console.log("\nconsole errors:", errors.length);
for (const e of errors.slice(0, 12)) console.log("   -", e.slice(0, 220));
console.log("non-2xx responses:", badResponses.length);
for (const b of badResponses.slice(0, 8)) console.log("   -", b.slice(0, 220));
console.log("failed requests:", failedRequests.length);
for (const r of failedRequests.slice(0, 8)) console.log("   -", r.slice(0, 220));

await browser.close();
