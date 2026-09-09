"use client";

// The left panel: what is drawn, in Zoom Earth's shape.
//
// ZE splits its list into LIVE MAPS (things observed) and FORECAST MAPS
// (things modelled), which happens to be exactly the distinction this project
// exists to make visible -- so the same split is used here, with the block
// layers appearing as a third group once there is a block to put them in.

import { useState } from "react";

import { MenuRow, SectionLabel, Slider } from "@/components/ui";
import {
  IconAnomaly,
  IconChevronDown,
  IconChevronUp,
  IconChlorophyll,
  IconCurrent,
  IconFloat,
  IconIsosurface,
  IconPlane,
  IconSalinity,
  IconSection,
  IconThermometer,
  IconVolume,
} from "@/components/ui/icons";
import { shortLabel } from "@/lib/variableLabels";
import { currentVariable, useSessionStore } from "@/state/useSessionStore";

function variableIcon(key: string) {
  if (key === "temperature") return <IconThermometer />;
  if (key === "salinity") return <IconSalinity />;
  if (key === "chlorophyll") return <IconChlorophyll />;
  return <IconCurrent />;
}

export default function LayersPanel() {
  const [open, setOpen] = useState(true);
  const s = useSessionStore();
  const varMeta = useSessionStore(currentVariable);

  const climatologyAvailable = (s.health?.climatology ?? []).includes(s.variable);
  const inBlock = s.phase === "block";
  const depthMax = varMeta?.depthRange[1] ?? 2000;

  return (
    <div className="ze-panel w-[248px] overflow-hidden pb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Collapse layers" : "Expand layers"}
        className="flex w-full items-center justify-between px-4 pt-3 pb-0.5"
      >
        <span className="ze-section-label !m-0 !p-0">
          {inBlock ? "Block" : "Live maps"}
        </span>
        <span className="text-[color:var(--ze-text-dim)]">
          {open ? (
            <IconChevronUp className="h-4 w-4" />
          ) : (
            <IconChevronDown className="h-4 w-4" />
          )}
        </span>
      </button>

      {open && (
        <>
          <div className="mt-1">
            <MenuRow
              label="Observations"
              icon={<IconFloat />}
              checked={s.showObservations}
              onChange={() => s.toggle("showObservations")}
              title="Argo floats and gliders, coloured by model-observation error"
            />
            {!inBlock && climatologyAvailable && (
              <MenuRow
                label="Show anomaly"
                icon={<IconAnomaly />}
                checked={s.showAnomaly}
                onChange={() => s.toggle("showAnomaly")}
                title="Departure from the eddy-free climatology, in standard deviations"
              />
            )}
          </div>

          <SectionLabel>Forecast maps</SectionLabel>
          {s.variables.map((v) => (
            <MenuRow
              key={v.variable}
              type="radio"
              name="variable"
              label={shortLabel(v.variable, v.longName)}
              icon={variableIcon(v.variable)}
              checked={s.variable === v.variable}
              onChange={() => s.setVariable(v.variable)}
              title={`${v.longName} (${v.standardName}) in ${v.units}`}
            />
          ))}

          <SectionLabel>Depth</SectionLabel>
          <Slider
            label="below sea surface"
            value={s.depth}
            min={0}
            max={Math.round(depthMax)}
            step={10}
            onChange={s.setDepth}
            format={(v) => `${v} m`}
          />

          {inBlock && (
            <>
              <SectionLabel>Block layers</SectionLabel>
              <MenuRow
                label="Volume"
                icon={<IconVolume />}
                checked={s.showVolume}
                onChange={() => s.toggle("showVolume")}
              />
              <MenuRow
                label="Depth plane"
                icon={<IconPlane />}
                checked={s.showSlice}
                onChange={() => s.toggle("showSlice")}
              />
              <MenuRow
                label="Currents"
                icon={<IconCurrent />}
                checked={s.showParticles}
                onChange={() => s.toggle("showParticles")}
                title="Direction and relative speed are the model's; playback is time-compressed"
              />
              <MenuRow
                label="Cross-section"
                icon={<IconSection />}
                checked={s.showSection}
                onChange={() => s.toggle("showSection")}
              />
              {s.showSection && (
                <div className="px-4 pb-1 pt-0.5 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
                  {s.sectionPoints.length === 0
                    ? "click a point on the sea surface"
                    : s.sectionPoints.length === 1
                      ? "click the second point"
                      : "curtain sampled at the model levels"}
                  {s.sectionPoints.length > 0 && (
                    <div className="mt-1 flex items-center gap-2">
                      <span className="truncate font-mono text-[10px] text-[color:var(--ze-text-dim)]">
                        {s.sectionPoints
                          .map((p) => `${p[0].toFixed(2)}, ${p[1].toFixed(2)}`)
                          .join("  to  ")}
                      </span>
                      <button className="ze-btn !px-2 !py-0.5 !text-[10px]" onClick={s.clearSection}>
                        Clear points
                      </button>
                    </div>
                  )}
                </div>
              )}
              <MenuRow
                label="Isosurface"
                icon={<IconIsosurface />}
                checked={s.showIsosurface}
                onChange={() => s.toggle("showIsosurface")}
              />
              {s.showIsosurface && varMeta && (
                <Slider
                  label={`iso level (${varMeta.units})`}
                  value={s.isoLevel}
                  min={Math.round(varMeta.validRange[0])}
                  max={Math.round(varMeta.validRange[1])}
                  step={0.5}
                  onChange={s.setIsoLevel}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
