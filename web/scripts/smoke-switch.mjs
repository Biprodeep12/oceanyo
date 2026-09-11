// Does the dataset picker actually switch the dataset, in a browser?
//
//   node web/scripts/smoke-switch.mjs [base-url]
//
// Kept OUT of `npm run smoke` on purpose: this restarts the API, and a suite
// that restarts the thing under test loses every step after it. Run it against
// a production build (`npm run build && npm start` in web/) -- the dev server's
// dynamic() chunks do not survive a hard reload here.
//
// It switches to the first available catalog that is not live, so running it
// twice switches back.

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const page = await (await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
})).newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(60_000);
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

const say = (...a) => console.log(" ", ...a);

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => document.querySelectorAll('input[type="radio"][name="variable"]').length >= 4,
  { timeout: 45_000 },
);

// 1. the section is there, listing every catalog on disk
const rows = await page.$$eval('input[type="radio"][name="catalog"]', (els) =>
  els.map((e) => ({
    label: e.getAttribute("aria-label"),
    checked: e.checked,
    disabled: e.disabled,
  })),
);
say("catalog rows:", JSON.stringify(rows, null, 1));
if (rows.length < 2) throw new Error("dataset picker did not render");
if (!rows.some((r) => r.disabled)) throw new Error("GLORYS has no data here and should be disabled");
if (!rows.some((r) => r.checked)) throw new Error("no active catalog marked");

const before = await page.evaluate(async () => (await fetch("/api/health")).json());
say("before:", before.catalogId, "synthetic:", before.synthetic);
say("SYNTHETIC badge before:", (await page.evaluate(() => document.body.innerText)).includes("SYNTHETIC"));

// 2. click the real one
const target = rows.find((r) => !r.checked && !r.disabled);
say("clicking:", target.label);
await page.click(`input[name="catalog"][aria-label="${target.label}"]`, { force: true });

// 3. the overlay must appear -- the app is genuinely unusable while the API is down
await page.waitForSelector(".ze-switch-overlay", { timeout: 10_000 });
say("overlay shown:", (await page.textContent(".ze-switch-card")).replace(/\s+/g, " ").slice(0, 90));

// 4. and the page must reload itself onto the new catalog
const t0 = Date.now();
// Poll the API rather than the page: the reload destroys the execution
// context Playwright is evaluating in, which is not a failure of the app.
let live = before.catalogId;
for (let i = 0; i < 120 && live === before.catalogId; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  live = await fetch(`${BASE}/api/health`)
    .then((r) => r.json())
    .then((h) => h.catalogId)
    .catch(() => live);
}
// A NEW page: the reload the app performs destroys the execution context this
// one is evaluating in, and Playwright's waiters do not always survive it.
// That is a limitation of the check, not of the app.
const page2 = await (await page.context().browser().newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page2.goto(BASE, { waitUntil: "domcontentloaded" });
await page2.waitForFunction(
  () => document.querySelectorAll('input[type="radio"][name="variable"]').length >= 4,
  { timeout: 60_000 },
);
const after = await page2.evaluate(async () => (await fetch("/api/health")).json());
const body = await page2.evaluate(() => document.body.innerText);
say(`switched in ${Math.round((Date.now() - t0) / 1000)}s ->`, after.catalogId, "synthetic:", after.synthetic);
say("SYNTHETIC badge after:", body.includes("SYNTHETIC"));
say("checked row after:", await page2.$$eval('input[name="catalog"]', (e) => e.filter((x) => x.checked).map((x) => x.getAttribute("aria-label"))));

if (after.catalogId === before.catalogId) throw new Error("catalog did not change");
if (after.synthetic !== body.includes("SYNTHETIC"))
  throw new Error("the SYNTHETIC badge disagrees with the catalog that is loaded");
// Fail on them. Printing errors under a PASS is how a broken page ships
// with a green check beside it.
if (errors.length) {
  say("console errors:", errors.slice(0, 5));
  throw new Error(`${errors.length} page error(s) during the switch`);
}
say("console errors: none");
await page.context().browser().close();
console.log("\nPASS");
