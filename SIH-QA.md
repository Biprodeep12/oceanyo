# SIH 26067 — questions and answers

Short answers in plain words, each with a number or a file behind it.
**Say first** means: volunteer it before a judge asks.

---

## The 30-second pitch

- You see a 2D map of the Indian ocean area. You drag a box over any region.
- Press **Dive**, and that box drops down into a 3D block of ocean — the water
  column, the seafloor, and the floats and gliders at the depths they really sit at.
- Click a float and you see what it measured, next to what the model says for
  the same place, same day, same depths — with the error in numbers.
- That last part is the point. Most tools show you the model. This one shows
  you **how wrong the model is, and where**.

---

## About the data

**Q. Is this real data?**

- The default dataset is made by us, and the screen says **SYNTHETIC** at all
  times. That label comes from the data file itself, so it cannot be forgotten.
- One click in the app switches to fully real data: HYCOM model, Argo floats,
  gliders, satellite chlorophyll, real seafloor depth. **None of it needs a login.**

**Q. Then why ship fake data at all?**

- Because we add a **known error on purpose** — exactly +0.300 °C. The
  comparison panel then has a right answer to find, and it finds **+0.313 °C**.
- That single test checks the whole chain, from making the file to the final
  statistics. It caught three real mistakes while we built it.

**Q. Has it run on real data?**

- Yes. Real model against real floats in the Bay of Bengal: **5 profiles, average
  error −0.002 °C, typical error 0.65 °C**.
- **Say first:** real data found four bugs that fake data could not — a time
  limit that was printed but never applied (a 2002 float compared against a 2024
  model), a float reporting a depth deeper than the seafloor, pressure units
  read as metres, and a climate average that silently matched nothing.

**Q. Why HYCOM and not GLORYS?**

- GLORYS needs a Copernicus account. HYCOM is free and open.
- HYCOM also names its variables differently from our files, so it proves the
  app reads data by its scientific labels, not by names we hardcoded.
- GLORYS still works — one line in a config file.

---

## About the science

**Q. How do you compare model and float?**

- Take the float's position and time. Take model values near it, inside a
  distance and a time window we state on screen.
- Line the model up with the float's own depths.
- Use only measurements the quality flag calls good.
- Report the average error, the typical error, and how well the shapes match —
  including a Taylor diagram, which is the standard picture in this field.

**Q. Is your "anomaly" layer just outlier detection?**

- No. We compare against a long-term average for that place and month, so the
  normal seasonal warming is not mistaken for something unusual.

**Q. Are these marine heatwaves?**

- **No, and the app says so itself.** The official definition needs daily data
  over 30 years and a five-day run. We have monthly data, so we use a close
  approximation, call them **exceedance events**, and ship the reason with
  every result.
- On real Indian Ocean data it finds the 2023–24 warm period, peaking in
  **April 2024 at +2.1 °C across 72% of the region**.

---

## About disaster management

**Q. How does this actually help INCOIS?**

- It answers three operational questions: where can the model be trusted, where
  has nothing been measured at all, and how far off was the model where we can check.
- Coverage, gaps, accuracy, confidence and data age all come from one pass over
  the observations, so the layers can never contradict each other.

**Q. Is this a warning system?**

- **No — say it first.** It is a tool for looking at and checking ocean data.
  It supports INCOIS's existing search-and-rescue and oil-spill systems; it does
  not replace them and issues no warnings.

---

## Matching the problem statement

| Asked for | Where it is |
|---|---|
| True 3D view through depth | The water column is drawn by tracing rays through the data on the GPU |
| Isosurfaces | Built on the server, sent to the browser as a 3D mesh |
| Time animation | A timeline that plays, with the next few steps loaded in advance |
| Floats, gliders, CTD, BGC | Three readers included; a fourth takes one new file |
| Chlorophyll as a main variable | Yes, on its own grid, with its own colour scale |
| CF, OPeNDAP, OGC WMS/WCS | All four are served, and `/api/health` says which are live |
| Works anywhere, nothing to install | Runs in a normal browser |
| Extensible | New data types plug in without touching the rest |

**Q. Prove the standards work.**

- Open `/wms?...request=GetCapabilities`, `/opendap.dds`, or `/wcs?...request=GetCoverage`
  in a browser. `/api/health` reports which ones actually started.

---

## About the engineering

**Q. Will it be smooth on the day?**

- We rehearse it. `npm run rehearse` walks the demo and times every step: last
  run **14 steps, none broken, 20.1 seconds, no errors**.
- The 3D data is shrunk before sending, unpacked on a background thread, and
  loaded into the graphics card one slice per frame, so the Dive animation
  never stutters.

**Q. What actually happens when I press Dive?**

- The map first centres your box. Then the 3D block's lid is placed on exactly
  the pixels that box occupied — same image, same colours, fetched from the same
  renderer as the map — so the swap between the two views is invisible.
- The block then grows downward out of that rectangle while the camera swings
  around to look at it, with the map still visible around the edges until the
  block covers it. Pressing Back flies the same path in reverse.
- The alignment is checked by the test suite in pixels, not by eye: **0.0 px**
  across, and under 1% down (that last bit is map projection, and it lands
  inside the rectangle rather than over it).

**Q. Will it cope with bigger data?**

- The server only ever sends the box you asked for, and the browser holds one
  block at a time and frees it when you leave.

**Q. Can we point it at our own data?**

- Yes. List your files in a config file — the app works out depth, time and
  coordinates from the file's own labels.
- You can now switch datasets **inside the app**: the Dataset list shows every
  dataset, greys out the ones whose files are missing, and tells you the command
  that fetches them.

**Q. Why does switching restart the server?**

- Because the standards services (WMS, OPeNDAP) are attached to whichever file
  was open at startup. Swapping underneath them would leave them serving the old
  data — wrong answers from the part that exists to be correct. A restart takes
  about six seconds and the app reloads itself when it is ready.

**Q. Where is the AI?**

- Small on purpose. Typing a question produces a **command the app can check**,
  not an answer. The AI never touches the data and never invents a number.
- The demo works with no internet and no API key, because common phrases are
  matched by a simple lookup table first.

---

## About our choices

**Q. Why this tech stack?**

- Everything in it is free, open, and already standard in ocean science. Nothing
  here needs a licence or a vendor.
- Python because the ocean world already runs on it: the libraries that read
  NetCDF files, follow the CF rules, and publish OGC services are all Python.
  Rewriting them in another language would be weeks of work to end up worse.
- React for the interface because the app is one screen with many linked
  controls, and TypeScript catches a whole class of mistakes before they run.
- Three.js for 3D because it is the plain WebGL library the problem statement
  names, and every browser already runs it.

**Q. Why draw a flat map with a 3D block instead of a spinning globe?**

- Our data is one region, not the planet. On a flat block, depth is a straight
  axis — so slicing by depth, stretching the vertical, and cutting a section are
  all simple and fast.
- On a globe, everything below the surface is awkward, and the view curves the
  very shape a scientist wants to read straight.
- A small inset map keeps the sense of place, which is the one thing a globe
  gives you for free.

**Q. Why MapLibre instead of Google Maps or Mapbox?**

- No API key, no bill, no usage limits, and it can be run entirely inside a
  government network with no outside connection.
- We do not even use an outside map: the coastline is drawn from our own
  seafloor data, so nothing on screen depends on a server we do not control.

**Q. Why is there no database?**

- Ocean data is already stored in files built for exactly this, and every tool in
  the field reads them directly. Copying that into a database would add a moving
  part, a sync problem, and no speed.
- We open the files once when the server starts and keep them in memory. Opening
  the whole dataset takes about five seconds.

**Q. Why so little AI, when everyone else is adding it?**

- The value of this project is that its numbers are checkable. Anything an AI
  writes is not checkable, so we kept it away from every number.
- It only turns a typed sentence into a command the app could have run anyway,
  and the command is shown before it runs.

**Q. Why haven't you deployed it to a public link?**

- It is one command to run — `docker compose up` — and it comes up on any
  machine with Docker, which is what "deployed" means for this audience.
- The data is hundreds of megabytes. A public link would mean renting a server
  big enough to hold it, and paying for it for as long as the link lives.
- More to the point, INCOIS would not use a public copy. This is meant to run
  **inside their network, beside their own data**, which is also why nothing in
  it calls out to the internet.

**Q. So how would you actually deploy it at INCOIS?**

- Two containers on one internal machine. One line in the config points it at
  their model files instead of ours.
- It needs no internet, no accounts, and no outside services at run time.
- A normal server with about 8 GB of memory is enough for the region we show.

**Q. What would you do next, given more time?**

- Connect it to INCOIS's own live data server instead of downloaded files.
- Add the remaining instrument types — moorings, ship CTDs, radar — which is one
  new file each, by design.
- Automatic spotting of features like eddies and fronts, which we deliberately
  left out so the core would be solid first.

**Q. What was the hardest part?**

- Making real data work. Everything looked perfect on data we generated, and
  then real files broke it in four separate ways — old formats, quality flags
  stored as letters, gliders recorded as one long stream instead of dives, and
  depth measured in pressure rather than metres.
- All four are fixed, and our generated files now imitate the awkward real ones,
  so the same bug cannot come back unnoticed.

---

## Limits we state ourselves

- Current animation is sped up: direction and relative speed are real, the rate is not.
- The block's vertical axis follows the model's depth levels, not plain metres.
- No five-day test for heatwaves, because the data is monthly.
- Most "future" features are deliberately not built — the plan says they must
  not eat into the core.

---

## Demo-day rules (learned by rehearsing)

- **Pick region and month together.** Use **Bay of Bengal, October 2023** — it
  has three floats in the water at that time.
- **The Andaman Sea has no floats at all**, ever. Never click through it to
  reach the comparison panel; show it on purpose as a gap in coverage instead.
- **Playing the timeline moves you off the float.** Pause and step back before
  clicking one.
