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
  await page.screenshot({ path: `${OUT}/${name}`, timeout: 90000 });
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

await step("synthetic badge present", async () => {
  await page.getByText("SYNTHETIC", { exact: true }).first().waitFor({ timeout: 10000 });
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
  // The instruments are an InstancedMesh, so there is no DOM node to target.
  // Probe a few points over the block until the profile panel opens.
  const canvas = await page.locator("canvas").last().boundingBox();
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  const candidates = [];
  for (let dx = -260; dx <= 260; dx += 26) {
    for (let dy = -180; dy <= 180; dy += 26) candidates.push([cx + dx, cy + dy]);
  }
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y);
    const opened = await page
      .getByText(/profile$/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (opened) return;
  }
  throw new Error(`no float hit after ${candidates.length} probes`);
});

await step("matchup statistics shown", async () => {
  await page.getByText("Bias", { exact: true }).waitFor({ timeout: 10000 });
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
  await page.getByLabel("Show anomaly").uncheck();
});

await step("glider tracks in the water column", async () => {
  await pickRegion("East of Sri Lanka");
  await page.getByRole("button", { name: "Dive" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("drag to orbit"), {
    timeout: 45000,
  });
  await page.waitForTimeout(4000);
  if (!requests.some((u) => u.includes("/api/profile/glider"))) {
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
  if (!(await probe("curtain sampled at the model levels", second))) {
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
  await mpage.goto(BASE, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await mpage.waitForSelector("canvas.maplibregl-canvas", { timeout: 30000 });
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
