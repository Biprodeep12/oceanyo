import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const OUT = process.argv[3] ?? "assistant.png";
const wait = async (fn, ms) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await wait(() => page.evaluate(() => Boolean(window.__store?.getState()?.health)), 20000);

// A region, so "this region" and a dive both mean something.
await page.evaluate(() => {
  const st = window.__store.getState();
  const p = st.presets.find((x) => x.id === "central_bob") ?? st.presets[0];
  st.applyPreset(p);
  st.setAssistantOpen(true);
});

const input = page.getByTestId("assistant-input");
await input.waitFor({ state: "visible", timeout: 8000 });
await input.fill("How well observed is this region? Then dive into it.");
await page.keyboard.press("Enter");

// The live progress list, while it runs.
let liveSeen = "";
await wait(async () => {
  const t = await page.locator(".ze-side-panel li").allInnerTexts().catch(() => []);
  if (t.length) liveSeen = t.join(" | ");
  return false;
}, 12000);
console.log("live progress seen:", liveSeen || "(none captured)");

const answered = await wait(
  async () => (await page.locator(".ze-reading").count()) > 0,
  150000,
);
console.log("readings rendered:", answered);

await page.screenshot({ path: OUT });

const dump = await page.evaluate(() => {
  const out = { readings: [], chips: [], rawVisible: 0 };
  for (const el of document.querySelectorAll(".ze-reading")) {
    out.readings.push(el.innerText.replace(/\n+/g, " \n "));
    if (el.querySelector("pre")) out.rawVisible++;
  }
  for (const el of document.querySelectorAll(".ze-tool-chip")) out.chips.push(el.innerText);
  return out;
});
console.log("\n--- action chips ---");
for (const c of dump.chips) console.log("  " + c);
console.log("\n--- readings (JSON blocks open on load: " + dump.rawVisible + ") ---");
for (const r of dump.readings) console.log("  " + r.slice(0, 700));

// The toggle reveals the raw JSON.
const toggle = page.getByRole("button", { name: "show data" }).first();
if (await toggle.count()) {
  await toggle.click();
  const pres = await page.locator(".ze-reading pre").count();
  console.log("\nafter 'show data': " + pres + " raw JSON block(s) visible");
  console.log("button now reads: " + (await page.getByRole("button", { name: "hide data" }).count()) + " 'hide data'");
}
console.log("\nconsole errors: " + (errs.length ? errs.slice(0, 3).join(" / ") : "none"));
await browser.close();
