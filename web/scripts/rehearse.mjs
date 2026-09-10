// The section 9 demo, walked start to finish in one session.
//
// This is NOT another feature test -- smoke.mjs already checks that each piece
// works, and it reloads, re-enters the block and re-opens panels freely to do
// so. What has never been verified is the thing an evaluator actually sees:
// the narrative in order, continuously, with no reload, and whether each beat
// arrives fast enough to keep a room's attention.
//
// So this reports TIME rather than pass/fail, against the targets section 5.1
// commits to:
//
//     first pixels of the block   < 400 ms
//     full-resolution volume      < 2.5 s
//     sustained while orbiting    30+ fps
//
// One honest caveat, printed in the output rather than buried here: headless
// Chromium renders through SwiftShader, on the CPU. Frame rates below are a
// floor, not a measurement of the demo machine -- a real GPU is one to two
// orders of magnitude faster at ray-marching. Fetch, decode and API timings
// are hardware-independent and can be read at face value.
//
//   SMOKE_BASE=http://127.0.0.1:3100 node scripts/rehearse.mjs

import { chromium } from "playwright";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3100";
const beats = [];
let failed = 0;

const store = (page, fn, arg) => page.evaluate(fn, arg);

async function until(page, fn, timeout = 90000, every = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return Date.now() - t0;
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

async function beat(name, fn, target) {
  const t0 = Date.now();
  let note = "";
  let ok = true;
  try {
    note = (await fn()) ?? "";
  } catch (e) {
    ok = false;
    note = String(e.message ?? e).slice(0, 120);
  }
  const ms = Date.now() - t0;
  if (!ok) failed++;
  beats.push({ name, ms, note, target, ok });
  const flag = !ok ? "  !!" : target && ms > target ? "  (over target)" : "";
  console.log(
    `${String(ms).padStart(6)} ms  ${name}${note ? `  -- ${note}` : ""}${flag}`,
  );
}

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|ResizeObserver/i.test(m.text())) {
      errors.push(m.text());
    }
  });
  const bad = [];
  page.on("response", (r) => {
    if (r.status() >= 400 && !/favicon/.test(r.url())) bad.push(`${r.status()} ${r.url()}`);
  });

  console.log(`Rehearsing the section 9 demo against ${BASE}`);
  console.log("Headless Chromium renders on the CPU (SwiftShader); frame rates");
  console.log("below are a floor, not the demo machine. Timings are real.\n");

  // --- 1. open the Indian EEZ map ---
  await beat("open the map", async () => {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    const t = await until(page, () => Boolean(window.__store?.getState()?.health));
    if (t === null) throw new Error("catalog never loaded");
    const src = await store(page, () => window.__store.getState().health.source);
    return src.slice(0, 52);
  }, 6000);

  await beat("basemap and field tiles painted", async () => {
    const t = await until(page, () => Boolean(window.__map?.isStyleLoaded?.()));
    if (t === null) throw new Error("map style never loaded");
    return "";
  }, 8000);

  // --- 2. pick a variable and a time ---
  await beat("pick a variable and a time", async () => {
    await page.getByRole("radio", { name: /temperature/i }).first().click();
    // A step where instruments actually exist, so the float click later has a
    // target. Choosing it here is what the presenter would do, not a fix-up.
    const idx = await store(page, () => {
      const st = window.__store.getState();
      const days = 45;
      let best = 0;
      let bestN = -1;
      st.times.forEach((t, i) => {
        const tt = Date.parse(t);
        const n = st.observations.filter(
          (f) => Math.abs(Date.parse(f.properties.time) - tt) < days * 864e5,
        ).length;
        if (n > bestN) {
          bestN = n;
          best = i;
        }
      });
      window.__store.getState().setTimeIndex(best);
      return { best, bestN };
    });
    return `step ${idx.best + 1}, ${idx.bestN} instruments in window`;
  }, 5000);

  // --- 3. drag a rectangle over the Bay of Bengal ---
  await beat("drag a region over the Bay of Bengal", async () => {
    const ok = await store(page, () => {
      const st = window.__store.getState();
      const p = st.presets.find((x) => /bengal/i.test(x.id) || /bengal/i.test(x.label));
      if (p) {
        st.applyPreset(p);
        return p.label;
      }
      st.setSelection([85, 10, 92, 18]);
      return "85-92E, 10-18N";
    });
    return String(ok);
  }, 3000);

  // --- 4/5. Dive: WOW moment 1 ---
  const dive = { firstPixels: null, full: null };
  await beat("WOW 1: press Dive, block appears", async () => {
    await page.getByRole("button", { name: "Dive" }).click();
    // "First pixels" is the frame and seabed, which is the extruding phase --
    // the animation IS the loading indicator, per 5.1.
    dive.firstPixels = await until(
      page,
      () => ["extruding", "holding", "block"].includes(window.__store.getState().phase),
      20000,
    );
    if (dive.firstPixels === null) throw new Error("never left map mode");
    // Measured at 100 ms polling granularity, and the extrude begins on the
    // click frame, so a number in the tens of ms means "the animation started
    // immediately" rather than a precise paint time. That is the property 5.1
    // actually asks for: no spinner, the extrude IS the loading indicator.
    return `left map mode in ${dive.firstPixels} ms`;
  }, 4000);

  await beat("water column resolves (stage 1)", async () => {
    dive.full = await until(
      page,
      () => window.__store.getState().phase === "block",
      120000,
    );
    if (dive.full === null) throw new Error("volume never arrived");
    // From the click, not from the end of the extrude: the previous beat
    // returns as soon as the phase changes, which happens on the click frame.
    return `${((dive.firstPixels + dive.full) / 1000).toFixed(1)} s from pressing Dive`;
  }, 8000);

  // --- 6. rotate, scrub depth, look at the seabed ---
  await beat("orbit the block", async () => {
    const box = await page.locator("canvas").last().boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(cx + i * 14, cy - i * 3);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    const fps = await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            n++;
            if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
            else res(Math.round((n * 1000) / (performance.now() - t0)));
          };
          requestAnimationFrame(tick);
        }),
    );
    return `${fps} fps while idle (CPU renderer)`;
  });

  await beat("scrub the depth slider through the thermocline", async () => {
    for (const d of [0, 50, 120, 300, 800]) {
      await store(page, (v) => window.__store.getState().setDepth(v), d);
      await page.waitForTimeout(160);
    }
    return "0 -> 800 m";
  }, 4000);

  // --- 7. WOW moment 3: the 4D timeline ---
  await beat("WOW 3: play the timeline", async () => {
    const before = await store(page, () => window.__store.getState().timeIndex);
    await store(page, () => {
      const st = window.__store.getState();
      if (!st.playing) st.toggle("playing");
    });
    await page.waitForTimeout(4000);
    const after = await store(page, () => window.__store.getState().timeIndex);
    await store(page, () => {
      const st = window.__store.getState();
      if (st.playing) st.toggle("playing");
    });
    const moved = (after - before + 100) % 100;
    if (moved === 0) throw new Error("the timeline did not advance");
    const buffered = await store(page, () => window.__store.getState().bufferedTimes.length);
    return `advanced ${moved} steps in 4 s, ${buffered} buffered`;
  });

  // --- 8/9. click a float in the water column ---
  await beat("click an Argo float in the block", async () => {
    // __floatPoints is a FUNCTION returning page-absolute positions, not an
    // array of canvas-relative ones. Adding the canvas offset to them clicks
    // empty water, and a `.length` on the function is its arity, which is 0
    // and reads as "no floats".
    const pts = await store(page, () => window.__floatPoints?.() ?? []);
    if (!pts.length) throw new Error("no instruments drawn in the block");

    // Prefer an instrument that yields statistics. A real float's first cycle
    // is often a near-empty deployment profile -- one of ours has a single
    // finite level, flagged bad -- and a panel of dashes is a correct answer
    // that would make WOW moment 2 land on nothing.
    let picked = null;
    for (const pt of pts.slice(0, 6)) {
      await page.mouse.click(pt.x, pt.y);
      const t = await until(
        page,
        () => Boolean(window.__store.getState().selectedProfile),
        12000,
      );
      if (t === null) continue;
      const info = await store(page, () => {
        const st = window.__store.getState();
        return {
          id: `${st.selectedProfile.platform} ${st.selectedProfile.id}`,
          n: st.matchup?.n ?? 0,
        };
      });
      picked = { ...info, t };
      if (info.n > 0) break;
    }
    if (!picked) throw new Error("clicking an instrument opened nothing");
    return `${picked.id} in ${picked.t} ms, ${picked.n} levels matched`;
  }, 5000);

  await beat("its temperature profile is drawn", async () => {
    const n = await store(page, () => {
      const m = window.__store.getState().matchup;
      return m ? m.obsDepths.length : 0;
    });
    if (!n) throw new Error("the profile carried no usable levels");
    return `${n} levels`;
  });

  // --- 10. WOW moment 2: model vs reality ---
  await beat("WOW 2: model vs observation", async () => {
    const m = await store(page, () => {
      const x = window.__store.getState().matchup;
      return x && { bias: x.bias, rmse: x.rmse, n: x.n, r: x.radiusKm, w: x.windowHours };
    });
    if (!m) throw new Error("no matchup for this profile");
    if (m.n === 0) {
      // Not a failure of the app -- but it IS a failure of the demo, and the
      // presenter needs to know before the room does.
      throw new Error(
        "0 levels matched: this float has no model within the colocation window",
      );
    }
    return `bias ${m.bias.toFixed(3)}, RMSE ${m.rmse.toFixed(3)} over ${m.n} levels ` +
      `(${Math.round(m.r)} km / ${Math.round(m.w / 24)} d)`;
  }, 3000);

  await beat("the error is mapped spatially", async () => {
    const scored = await store(page, () => {
      const e = window.__store.getState().errorById;
      return Object.keys(e).length;
    });
    if (!scored) throw new Error("no instruments carry an error colour");
    return `${scored} instruments coloured by |bias|`;
  });

  // --- 11. the optional beat ---
  await beat("optional: anomaly vs climatology", async () => {
    const has = await store(page, () => {
      const st = window.__store.getState();
      return (st.health?.climatology ?? []).includes(st.variable);
    });
    if (!has) return "no climatology for this variable -- skip this beat";
    await store(page, () => {
      const st = window.__store.getState();
      if (!st.showAnomaly) st.toggle("showAnomaly");
    });
    await page.waitForTimeout(600);
    await store(page, () => {
      const st = window.__store.getState();
      if (st.showAnomaly) st.toggle("showAnomaly");
    });
    return "available";
  });

  // --- 12. back to map ---
  await beat("back to map", async () => {
    await page.getByRole("button", { name: "Back to map" }).click();
    const t = await until(page, () => window.__store.getState().phase === "map", 20000);
    if (t === null) throw new Error("never returned to map mode");
    const kept = await store(page, () => Boolean(window.__store.getState().selection));
    return `${t} ms, selection ${kept ? "kept" : "LOST"}`;
  }, 3000);

  // --- what the run says about itself ---
  console.log("");
  const total = beats.reduce((a, b) => a + b.ms, 0);
  console.log(`${beats.length} beats, ${failed} broken, ${(total / 1000).toFixed(1)} s end to end`);
  console.log(`console errors: ${errors.length}   failed requests: ${bad.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  ! ${e.slice(0, 140)}`);
  for (const b of bad.slice(0, 5)) console.log(`  ! ${b.slice(0, 140)}`);

  const over = beats.filter((b) => b.ok && b.target && b.ms > b.target);
  if (over.length) {
    console.log("\nSlower than the section 5.1 target:");
    for (const b of over) console.log(`  ${b.name}: ${b.ms} ms (target ${b.target} ms)`);
  }

  await browser.close();
  process.exit(failed || errors.length || bad.length ? 1 : 0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
