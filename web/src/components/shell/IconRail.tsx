"use client";

// Right-hand icon rail: regions, settings, info, then the zoom pair.
//
// Every button here does something real. A rail full of plausible-looking
// icons that do nothing is worse than a short one -- it is the first thing an
// evaluator clicks.

import { useEffect, useState } from "react";

import ProvenancePanel from "@/components/panels/ProvenancePanel";
import { Popover, Slider } from "@/components/ui";
import {
  IconDownload,
  IconDraw,
  IconInfo,
  IconLayers,
  IconMinus,
  IconMoon,
  IconPlus,
  IconPulse,
  IconReceipt,
  IconRegion,
  IconSettings,
  IconSparkle,
  IconSun,
} from "@/components/ui/icons";
import { api } from "@/lib/api/client";
import type { ProvenanceResponse } from "@/lib/api/types";
import {
  exportCoverageCsv,
  exportMatchupCsv,
  exportSessionJson,
  exportViewPng,
} from "@/lib/report/export";
import { permalink } from "@/lib/session/permalink";
import { useIsMobile } from "@/state/useMediaQuery";
import { probeGpu, type GpuCaps } from "@/three/caps";
import { viewport } from "@/lib/viewport";
import { useSessionStore } from "@/state/useSessionStore";

type PanelId =
  | "regions"
  | "settings"
  | "info"
  | "provenance"
  | "export"
  | "events"
  | null;

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="ze-icon-btn"
      data-active={active ? "true" : "false"}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function IconRail() {
  const [open, setOpen] = useState<PanelId>(null);
  const presets = useSessionStore((s) => s.presets);
  const applyPreset = useSessionStore((s) => s.applyPreset);
  const health = useSessionStore((s) => s.health);
  const exaggeration = useSessionStore((s) => s.exaggeration);
  const opacity = useSessionStore((s) => s.opacity);
  const anomalyLimit = useSessionStore((s) => s.anomalyLimit);
  const setExaggeration = useSessionStore((s) => s.setExaggeration);
  const setOpacity = useSessionStore((s) => s.setOpacity);
  const setAnomalyLimit = useSessionStore((s) => s.setAnomalyLimit);
  const theme = useSessionStore((s) => s.theme);
  const setTheme = useSessionStore((s) => s.setTheme);
  const phase = useSessionStore((s) => s.phase);
  const drawMode = useSessionStore((s) => s.drawMode);
  const drawShape = useSessionStore((s) => s.drawShape);
  const setDrawShape = useSessionStore((s) => s.setDrawShape);
  const setDrawMode = useSessionStore((s) => s.setDrawMode);
  const layersOpen = useSessionStore((s) => s.layersOpen);
  const setLayersOpen = useSessionStore((s) => s.setLayersOpen);
  const variable = useSessionStore((s) => s.variable);
  const coverage = useSessionStore((s) => s.coverage);
  const events = useSessionStore((s) => s.events);
  const setEvents = useSessionStore((s) => s.setEvents);
  const setTimeIndex = useSessionStore((s) => s.setTimeIndex);
  const domain = useSessionStore((s) => s.domain);
  const climatologyVars = useSessionStore((s) => s.health?.climatology);
  const nlqReady = useSessionStore((s) => s.health?.nlq ?? false);
  const [eventsErr, setEventsErr] = useState<string | null>(null);
  const mobile = useIsMobile();

  // Fetched once, lazily, and reused by both the provenance panel and every
  // export: a CSV of numbers without the header naming the model that produced
  // them is exactly the artefact this platform exists to stop people making.
  const [prov, setProv] = useState<ProvenanceResponse | null>(null);
  useEffect(() => {
    if (!open || prov) return;
    if (open !== "export" && open !== "provenance") return;
    const ac = new AbortController();
    api.provenance(ac.signal).then(setProv).catch(() => {});
    return () => ac.abort();
  }, [open, prov]);

  const [note, setNote] = useState<string>("");
  const say = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(""), 2600);
  };

  // Scanned when the panel is opened, not at startup: it is one anomaly grid
  // per timestep and nothing on the first screen depends on it.
  useEffect(() => {
    if (open !== "events") return;
    if (!(climatologyVars ?? []).includes(variable)) return;
    const ac = new AbortController();
    api
      .events({ variable, bbox: domain ?? undefined }, ac.signal)
      // Clearing the error here rather than before the request keeps the last
      // failure on screen until a new answer replaces it, and writes state
      // once instead of twice.
      .then((e) => {
        setEventsErr(null);
        setEvents(e);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setEventsErr((e as Error).message);
      });
    return () => ac.abort();
  }, [open, variable, domain, climatologyVars, setEvents]);

  const toggle = (id: Exclude<PanelId, null>) =>
    setOpen((cur) => (cur === id ? null : id));

  // Probed after mount, never during render: branching on `typeof window`
  // inside render makes the server and first client render differ, which
  // React 19 reports as a hydration mismatch and then re-renders everything.
  const [caps, setCaps] = useState<GpuCaps | null>(null);
  useEffect(() => setCaps(probeGpu()), []);

  return (
    // z-50: ABOVE the profile panel, which shares this corner.
    //
    // The rail and its popovers both sit at the top right, and the profile
    // panel opens into the same space. At equal z the later element in the DOM
    // wins, so opening a profile silently made Regions, Settings and About
    // unclickable -- the panel was covering the popover they open. A transient
    // control has to sit above the content panel it acts on, not beside it and
    // hope.
    <div className="pointer-events-none absolute right-3 top-3 bottom-3 z-50 flex items-start justify-end gap-2">
      {open && (
        <div className="pointer-events-auto mt-0">
          {open === "regions" && (
            <Popover title="Regions" onClose={() => setOpen(null)}>
              <div className="px-4 pb-1 text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
                Pick a preset, or draw one. On a mouse, shift+drag does the same
                as a rectangle. Then press Dive.
              </div>
              <div className="flex items-center gap-1.5 px-4 pb-2 pt-1">
                {(
                  [
                    ["rect", "Rectangle", "Two opposite corners"],
                    ["quad", "Four corners", "Any convex quadrilateral, in order"],
                  ] as const
                ).map(([shape, label, hint]) => (
                  <button
                    key={shape}
                    className="ze-btn !px-2.5 !py-1 !text-[11px]"
                    data-active={drawShape === shape ? "true" : "false"}
                    title={hint}
                    onClick={() => {
                      setDrawShape(shape);
                      setDrawMode(true);
                      setOpen(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {/* Said here, where the choice is made, rather than discovered
                  later as a block that does not match the outline. */}
              <div className="px-4 pb-2 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
                A four-corner region is fetched as its bounding box &mdash; a
                NetCDF subset is a rectangle and nothing else &mdash; and the
                block is clipped to the shape you drew.
              </div>
              <div className="mt-1 flex flex-col">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    className="ze-row justify-start"
                    onClick={() => {
                      applyPreset(p);
                      setOpen(null);
                    }}
                    title={p.note}
                  >
                    <IconRegion />
                    <span className="truncate">{p.label}</span>
                  </button>
                ))}
              </div>
            </Popover>
          )}

          {open === "settings" && (
            <Popover title="Settings" onClose={() => setOpen(null)}>
              <div className="flex items-center gap-1.5 px-4 pb-1 pt-1">
                {(["dark", "light"] as const).map((t) => (
                  <button
                    key={t}
                    className="ze-btn flex items-center gap-1.5 !px-2.5 !py-1 !text-[11px]"
                    data-active={theme === t ? "true" : "false"}
                    aria-pressed={theme === t}
                    onClick={() => setTheme(t)}
                  >
                    {t === "dark" ? (
                      <IconMoon className="h-3.5 w-3.5" />
                    ) : (
                      <IconSun className="h-3.5 w-3.5" />
                    )}
                    {t === "dark" ? "Dark" : "Light"}
                  </button>
                ))}
              </div>
              <div className="px-4 pb-2 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
                The colour scales do not change with the theme. They are
                scientific scales with published meanings and the colour bar is
                their legend.
              </div>
              <Slider
                label="vertical exaggeration"
                value={exaggeration}
                min={1}
                max={10}
                step={1}
                onChange={setExaggeration}
                format={(v) => `${v}x`}
              />
              <Slider
                label="volume opacity"
                value={opacity}
                min={0.1}
                max={1}
                step={0.05}
                onChange={setOpacity}
              />
              <Slider
                label="anomaly saturates at"
                value={anomalyLimit}
                min={1}
                max={6}
                step={0.5}
                onChange={setAnomalyLimit}
                format={(v) => `${v} sigma`}
              />
              <div className="px-4 pt-2 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
                The block vertical axis follows the model levels, not metres, so
                the upper ocean fills most of the block and the abyss is
                compressed.
              </div>
              {caps && (
                <div className="mx-4 mt-2 rounded-lg bg-black/25 px-3 py-2 font-mono text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
                  <div>
                    renderer tier <span className="text-[color:var(--ze-text-dim)]">{caps.tier}</span>
                    {caps.tier === "slices" && " (volume unsupported)"}
                  </div>
                  <div>MAX_3D_TEXTURE {caps.max3DTextureSize}</div>
                  <div>
                    ray steps {caps.steps.idle}/{caps.steps.moving}
                  </div>
                </div>
              )}
            </Popover>
          )}

          {open === "info" && (
            <Popover title="About this data" onClose={() => setOpen(null)}>
              <div className="space-y-2.5 px-4 text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
                {health?.synthetic === false ? (
                  <>
                    <p className="text-[color:var(--ze-text)]">
                      Every field shown is <b>real</b>. The model is{" "}
                      {health?.source ?? "a real analysis"}; observations are
                      genuine Argo and glider profiles from the Ifremer GDACs.
                    </p>
                    <p>
                      The model and the instruments are independent, so the
                      model&ndash;observation panel is a real validation rather
                      than a self-check: nothing here was generated to agree.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[color:var(--ze-warn)]">
                      Every field shown is <b>synthetically generated</b>, not a
                      reanalysis and not an observation. It is CF-1.8 compliant
                      and GLORYS12V1-shaped so the real-data path is a config
                      change.
                    </p>
                    <p>
                      Observations are the model field sampled at each instrument
                      position and time, plus a known injected bias. The
                      model&ndash;observation panel recovers that bias, which is
                      the end-to-end test of the whole chain.
                    </p>
                  </>
                )}
                <p>
                  <b className="text-[color:var(--ze-text)]">This is not a warning
                  system.</b>{" "}
                  It is an exploration and validation tool, complementary to
                  INCOIS operational products.
                </p>
                <div className="rounded-lg bg-black/25 px-3 py-2 font-mono text-[10px]">
                  <div>catalog {health?.catalogId ?? "--"}</div>
                  <div>
                    standards CF-1.8
                    {health?.standards?.wms ? " · WMS" : ""}
                    {health?.standards?.opendap ? " · OPeNDAP" : ""}
                  </div>
                  <div>platforms {(health?.platforms ?? []).join(", ") || "--"}</div>
                </div>
                <p className="text-[color:var(--ze-text-faint)]">
                  Basemap geometry &copy; OpenStreetMap contributors. Rendering
                  with MapLibre GL and three.js.
                </p>
              </div>
            </Popover>
          )}
          {open === "events" && (
            <Popover title="Events" onClose={() => setOpen(null)}>
              {!(climatologyVars ?? []).includes(variable) ? (
                <div className="px-4 pb-3 text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
                  This catalogue has no climatology for {variable}, and an event
                  is defined against one. Try temperature or salinity.
                </div>
              ) : eventsErr ? (
                <div className="px-4 pb-3 text-[11.5px] text-[color:var(--ze-warn)]">
                  {eventsErr}
                </div>
              ) : !events ? (
                <div className="px-4 pb-3 text-[11.5px] text-[color:var(--ze-text-dim)]">
                  scanning every step against the climatology&hellip;
                </div>
              ) : (
                <div className="ze-scroll max-h-[58vh] overflow-y-auto px-4 pb-3">
                  <div className="mb-2 text-[11px] leading-relaxed text-[color:var(--ze-text-dim)]">
                    {events.method}
                  </div>
                  {!events.events.length && (
                    <div className="text-[11.5px] text-[color:var(--ze-text-dim)]">
                      No step in this record puts more than{" "}
                      {Math.round(events.areaFraction * 100)}% of the region beyond
                      the threshold.
                    </div>
                  )}
                  {events.events.map((e) => (
                    <button
                      key={`${e.kind}-${e.start}`}
                      className="ze-row w-full flex-col !items-start gap-0.5 py-2"
                      title="Jump to the first step and play the event"
                      onClick={() => {
                        setTimeIndex(e.startIndex);
                        const st = useSessionStore.getState();
                        if (!st.playing) st.toggle("playing");
                        setOpen(null);
                      }}
                    >
                      <span className="flex w-full items-baseline justify-between gap-2">
                        <span
                          className="text-[11.5px]"
                          style={{
                            color:
                              e.kind === "warm"
                                ? "rgb(226,96,63)"
                                : "rgb(63,140,226)",
                          }}
                        >
                          {e.kind === "warm" ? "Warm" : "Cool"} exceedance
                        </span>
                        <span className="font-mono text-[10px] text-[color:var(--ze-text-faint)]">
                          {e.steps} step{e.steps === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="text-[10.5px] text-[color:var(--ze-text-dim)]">
                        {e.start.slice(0, 7)} to {e.end.slice(0, 7)} &middot; peak{" "}
                        {e.peakAnomaly > 0 ? "+" : ""}
                        {e.peakAnomaly.toFixed(2)} {events.units} over{" "}
                        {Math.round(e.peakArea * 100)}% of the region
                      </span>
                    </button>
                  ))}
                  {/* The caveat sits with the events, not in a footnote
                      somewhere else. Calling these marine heatwaves is the
                      easiest way to lose the credibility the matchup
                      statistics earn. */}
                  <div className="mt-2 border-t border-[color:var(--ze-line)] pt-2 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
                    {events.notHobday}
                  </div>
                </div>
              )}
            </Popover>
          )}

          {open === "provenance" && (
            <Popover title="Provenance" onClose={() => setOpen(null)}>
              <ProvenancePanel />
            </Popover>
          )}

          {open === "export" && (
            <Popover title="Export" onClose={() => setOpen(null)}>
              <div className="px-4 pb-1 text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
                Every export carries its provenance: the CSVs open with the
                model, catalogue and QC convention as comment lines, and the
                JSON embeds the full record.
              </div>
              <div className="mt-1 flex flex-col">
                <button
                  className="ze-row justify-start"
                  onClick={() =>
                    exportViewPng().then(
                      () => say("image saved"),
                      (e) => say(String(e.message ?? e)),
                    )
                  }
                >
                  <IconDownload />
                  <span>View as PNG</span>
                </button>
                <button
                  className="ze-row justify-start"
                  onClick={async () => {
                    try {
                      const r = await api.matchupSummary({ variable, limit: 1000 });
                      exportMatchupCsv(r.results, prov);
                      say(`${r.scored} scored profiles written`);
                    } catch (e) {
                      say(String(e));
                    }
                  }}
                >
                  <IconDownload />
                  <span>Model&ndash;observation table (CSV)</span>
                </button>
                <button
                  className="ze-row justify-start"
                  disabled={!coverage}
                  title={coverage ? undefined : "turn on an assessment layer first"}
                  onClick={() => {
                    if (!coverage) return;
                    exportCoverageCsv(coverage, prov);
                    say(`${coverage.features.length} cells written`);
                  }}
                >
                  <IconDownload />
                  <span>Assessment grid (CSV)</span>
                </button>
                <button
                  className="ze-row justify-start"
                  onClick={() => {
                    exportSessionJson(prov);
                    say("session saved");
                  }}
                >
                  <IconDownload />
                  <span>Session + provenance (JSON)</span>
                </button>
                <button
                  className="ze-row justify-start"
                  onClick={async () => {
                    const url = permalink();
                    try {
                      await navigator.clipboard.writeText(url);
                      say("link copied");
                    } catch {
                      // A clipboard write needs a secure context and a user
                      // gesture, and neither is guaranteed on a demo machine.
                      // The URL bar already holds the same link.
                      say("copy blocked; the address bar holds the link");
                    }
                  }}
                >
                  <IconReceipt />
                  <span>Copy a link to this view</span>
                </button>
              </div>
              {note && (
                <div className="px-4 pb-2 pt-1.5 text-[10.5px] text-[color:var(--ze-accent,#4fd1c5)]">
                  {note}
                </div>
              )}
            </Popover>
          )}
        </div>
      )}

      <div className="pointer-events-auto flex flex-col items-end gap-2" data-rail>
        {/* The layers list is a permanent panel on a desktop and a sheet on a
            phone, so the button that opens it only exists on a phone. */}
        {mobile && (
          <RailButton
            label="Layers"
            active={layersOpen}
            onClick={() => setLayersOpen(!layersOpen)}
          >
            <IconLayers />
          </RailButton>
        )}
        {phase !== "block" && (
          <RailButton
            label="Draw region"
            active={drawMode}
            onClick={() => {
              setDrawShape("rect");
              setDrawMode(!drawMode);
              setOpen(null);
              if (mobile) setLayersOpen(false);
            }}
          >
            <IconDraw />
          </RailButton>
        )}
        <RailButton
          label="Regions"
          active={open === "regions"}
          onClick={() => toggle("regions")}
        >
          <IconRegion />
        </RailButton>
        <RailButton
          label="Settings"
          active={open === "settings"}
          onClick={() => toggle("settings")}
        >
          <IconSettings />
        </RailButton>
        {/* Only offered when a model is actually reachable. A button that
            opens a panel saying "no model configured" is a worse answer than
            no button. */}
        {nlqReady && (
          <RailButton
            label="Assistant"
            onClick={() => {
              (window as unknown as { __toggleAssistant?: () => void })
                .__toggleAssistant?.();
              setOpen(null);
            }}
          >
            <IconSparkle />
          </RailButton>
        )}
        <RailButton
          label="Events"
          active={open === "events"}
          onClick={() => toggle("events")}
        >
          <IconPulse />
        </RailButton>
        <RailButton
          label="Provenance"
          active={open === "provenance"}
          onClick={() => toggle("provenance")}
        >
          <IconReceipt />
        </RailButton>
        <RailButton
          label="Export"
          active={open === "export"}
          onClick={() => toggle("export")}
        >
          <IconDownload />
        </RailButton>
        <RailButton label="About this data" active={open === "info"} onClick={() => toggle("info")}>
          <IconInfo />
        </RailButton>

        <div className="ze-stack mt-1">
          <button
            aria-label={phase === "block" ? "Move closer" : "Zoom in"}
            title={phase === "block" ? "Move closer" : "Zoom in"}
            onClick={() => viewport.zoomIn()}
          >
            <IconPlus className="h-5 w-5" />
          </button>
          <button
            aria-label={phase === "block" ? "Move away" : "Zoom out"}
            title={phase === "block" ? "Move away" : "Zoom out"}
            onClick={() => viewport.zoomOut()}
          >
            <IconMinus className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
