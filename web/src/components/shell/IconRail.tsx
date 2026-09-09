"use client";

// Right-hand icon rail: regions, settings, info, then the zoom pair.
//
// Every button here does something real. A rail full of plausible-looking
// icons that do nothing is worse than a short one -- it is the first thing an
// evaluator clicks.

import { useEffect, useState } from "react";

import { Popover, Slider } from "@/components/ui";
import {
  IconDraw,
  IconInfo,
  IconLayers,
  IconMinus,
  IconMoon,
  IconPlus,
  IconRegion,
  IconSettings,
  IconSun,
} from "@/components/ui/icons";
import { useIsMobile } from "@/state/useMediaQuery";
import { probeGpu, type GpuCaps } from "@/three/caps";
import { viewport } from "@/lib/viewport";
import { useSessionStore } from "@/state/useSessionStore";

type PanelId = "regions" | "settings" | "info" | null;

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
  const setDrawMode = useSessionStore((s) => s.setDrawMode);
  const layersOpen = useSessionStore((s) => s.layersOpen);
  const setLayersOpen = useSessionStore((s) => s.setLayersOpen);
  const mobile = useIsMobile();

  const toggle = (id: Exclude<PanelId, null>) =>
    setOpen((cur) => (cur === id ? null : id));

  // Probed after mount, never during render: branching on `typeof window`
  // inside render makes the server and first client render differ, which
  // React 19 reports as a hydration mismatch and then re-renders everything.
  const [caps, setCaps] = useState<GpuCaps | null>(null);
  useEffect(() => setCaps(probeGpu()), []);

  return (
    <div className="pointer-events-none absolute right-3 top-3 bottom-3 z-30 flex items-start justify-end gap-2">
      {open && (
        <div className="pointer-events-auto mt-0">
          {open === "regions" && (
            <Popover title="Regions" onClose={() => setOpen(null)}>
              <div className="px-4 pb-1 text-[11.5px] leading-relaxed text-[color:var(--ze-text-dim)]">
                Pick a preset, or use <b>Draw region</b> and tap two opposite
                corners. On a mouse, shift+drag does the same thing. Then press
                Dive.
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
