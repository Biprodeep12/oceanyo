import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const wait = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await page.goto(BASE, { waitUntil: "domcontentloaded" });

await wait(() => page.evaluate(() => Boolean(window.__store?.getState()?.health)));
await wait(() => page.evaluate(() => window.__store.getState().parsers.length > 0));
console.log(
  "parsers:",
  await page.evaluate(() =>
    window.__store.getState().parsers.map((p) => `${p.platform}:${p.variables}`).join(" | "),
  ),
);

// --- 1. the section is there for temperature ---
const label = page.getByText("Assessment", { exact: true });
check("Assessment section shows for temperature", (await label.count()) > 0);

// --- 2. first click turns a layer on ---
const blind = page.getByLabel("Blind spots", { exact: true });
await blind.click();
const on = await wait(() =>
  page.evaluate(() => window.__store.getState().coverageMetric === "blindSpot"),
);
check("clicking a row turns that layer on", on);
await wait(() => page.evaluate(() => (window.__store.getState().coverage?.features?.length ?? 0) > 0));

// --- 3. clicking the SAME row again turns it off ---
await blind.click();
const off = await wait(
  () => page.evaluate(() => window.__store.getState().coverageMetric === null),
  4000,
);
check("clicking the active row again deselects it", off, `metric=${await page.evaluate(() => String(window.__store.getState().coverageMetric))}`);
const hidden = await page.evaluate(() =>
  window.__map?.getLayoutProperty("assessment-fill", "visibility"),
);
check("the grid comes off the map with it", hidden === "none", `visibility=${hidden}`);

// --- 4. a different row still switches normally ---
await page.getByLabel("Model bias", { exact: true }).click();
check(
  "a different row switches the layer",
  await wait(() => page.evaluate(() => window.__store.getState().coverageMetric === "bias"), 4000),
);

// --- 5. an incompatible model field hides the whole section ---
await page.getByLabel("Eastward current", { exact: true }).click();
const gone = await wait(async () => (await page.getByText("Assessment", { exact: true }).count()) === 0, 4000);
check("Assessment is hidden for eastward current", gone);
check(
  "the layer is cleared with it",
  await wait(() => page.evaluate(() => window.__store.getState().coverageMetric === null), 4000),
);
for (const v of ["Northward current", "Chlorophyll"]) {
  await page.getByLabel(v, { exact: true }).click();
  check(
    `Assessment is hidden for ${v.toLowerCase()}`,
    await wait(async () => (await page.getByText("Assessment", { exact: true }).count()) === 0, 4000),
  );
}

// --- 6. and comes back for one the floats do measure ---
await page.getByLabel("Salinity", { exact: true }).click();
check(
  "Assessment returns for salinity",
  await wait(async () => (await page.getByText("Assessment", { exact: true }).count()) > 0, 4000),
);

await page.screenshot({ path: process.argv[3] ?? "assessment.png" });
check("no console errors", errs.length === 0, errs.slice(0, 2).join(" / "));
await browser.close();
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
