// Browser smoke test: drives the actual demo path and reports console errors.
// Run with both dev servers up:  node web/scripts/smoke.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.env.SMOKE_OUT ?? "./smoke";
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
page.on("requestfailed", (r) =>
  failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`),
);

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
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded", timeout: 60000 });
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
    () => document.querySelectorAll("select option").length >= 4,
    { timeout: 30000 },
  );
});

await step("synthetic badge present", async () => {
  await page.getByText("Synthetic data").first().waitFor({ timeout: 10000 });
});

await step("map canvas rendered", async () => {
  await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 20000 });
});

await step("screenshot: map mode", async () => {
  await page.waitForTimeout(3500); // let tiles settle
  await page.screenshot({ path: `${OUT}/01-map.png` });
});

await step("select preset region", async () => {
  // exact: there is also a "Central Bay of Bengal" preset.
  await page.getByRole("button", { name: "Bay of Bengal", exact: true }).click();
  await page.waitForTimeout(600);
});

await step("screenshot: region selected", async () => {
  await page.screenshot({ path: `${OUT}/02-selected.png` });
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
  await page.screenshot({ path: `${OUT}/03-block.png` });
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

await step("back to map", async () => {
  await page.getByRole("button", { name: "Back to map" }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/04-back.png` });
});

console.log("\nconsole errors:", errors.length);
for (const e of errors.slice(0, 12)) console.log("   -", e.slice(0, 220));
console.log("failed requests:", failedRequests.length);
for (const r of failedRequests.slice(0, 8)) console.log("   -", r.slice(0, 220));

await browser.close();
