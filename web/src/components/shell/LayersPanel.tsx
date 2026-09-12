"use client";

// The left panel: what is drawn, in Zoom Earth's shape.
//
// ZE splits its list into LIVE MAPS and FORECAST MAPS. The SHAPE of that split
// is worth borrowing; the words are not. Nothing here is live -- Argo profiles
// surface days to months after they are taken -- and nothing here is a
// forecast: the model is an analysis (or, in the default catalog, synthetic).
// Borrowing a competitor's vocabulary would assert a provenance we do not have
// to the one audience most able to check it, so the groups are named for what
// they actually are: observations, and model fields.

import { useMemo, useState } from "react";

import AssessmentSection from "@/components/shell/AssessmentSection";
import DatasetSection from "@/components/shell/DatasetSection";
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
import { inTimeWindow, windowDaysFor } from "@/lib/geo/obsWindow";
import { shortLabel } from "@/lib/variableLabels";
import { useIsMobile } from "@/state/useMediaQuery";
import {
  currentTime,
  currentVariable,
  MAX_SECTION_POINTS,
  useSessionStore,
} from "@/state/useSessionStore";

function variableIcon(key: string) {
  if (key === "temperature") return <IconThermometer />;
  if (key === "salinity") return <IconSalinity />;
  if (key === "chlorophyll") return <IconChlorophyll />;
  return <IconCurrent />;
}

export default function LayersPanel() {
  const [open, setOpen] = useState(true);
  const mobile = useIsMobile();
  const s = useSessionStore();
  const varMeta = useSessionStore(currentVariable);

  const climatologyAvailable = (s.health?.climatology ?? []).includes(s.variable);
  const now = currentTime(s);
  const windowDays = windowDaysFor(s.times);
  const shownCount = useMemo(
    () => inTimeWindow(s.observations, now, windowDays).length,
    [s.observations, now, windowDays],
  );
  const inBlock = s.phase === "block";
  const depthMax = varMeta?.depthRange[1] ?? 2000;

  // On a phone this is a dismissable sheet opened from the rail; on a desktop
  // it is a permanent panel with its own collapse chevron. Same content, and
  // the sheet closes by tapping its title row.
  if (mobile && !s.layersOpen) return null;

  return (
    <>
      {mobile && (
        <div
          className="ze-scrim z-30"
          onClick={() => s.setLayersOpen(false)}
          aria-hidden
        />
      )}
    <div
      className={
        mobile
          ? "ze-panel ze-sheet z-40 pb-2"
          : "ze-panel w-[248px] overflow-hidden pb-2"
      }
    >
      {mobile && <span className="ze-sheet-handle" aria-hidden />}
      <button
        onClick={() => (mobile ? s.setLayersOpen(false) : setOpen((v) => !v))}
        aria-label={mobile ? "Close layers" : open ? "Collapse layers" : "Expand layers"}
        className="flex w-full items-center justify-between px-4 pt-3 pb-0.5"
      >
        <span className="ze-section-label !m-0 !p-0">
          {inBlock ? "Block" : "Layers"}
        </span>
        <span className="text-[color:var(--ze-text-dim)]">
          {open || mobile ? (
            <IconChevronDown className="h-4 w-4" />
          ) : (
            <IconChevronUp className="h-4 w-4" />
          )}
        </span>
      </button>

      {(open || mobile) && (
        <>
          {/* Which dataset, before what is drawn from it. Hidden in block mode:
              the selection, the volume and the camera all belong to the
              catalog that is loaded, so offering to replace it mid-dive is
              offering to throw away the thing being looked at. */}
          {!inBlock && <DatasetSection />}
          <SectionLabel>Observations</SectionLabel>
          <MenuRow
            label="Argo &amp; gliders"
            icon={<IconFloat />}
            checked={s.showObservations}
            onChange={() => s.toggle("showObservations")}
            title="Argo floats and gliders, coloured by model-observation error"
          />
          {/* Say how many are drawn and why, or a filtered map reads as a
              broken one -- especially against a real catalog, where most
              profiles are years away from the displayed step. */}
          {s.showObservations && s.observations.length > 0 && (
            <div className="px-4 pb-1 pt-0.5 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
              {shownCount} of {s.observations.length} within {Math.round(windowDays)} days
              of this step
              {s.observationsTotal > s.observations.length && (
                <>
                  {" "}
                  &middot; sampled from {s.observationsTotal}
                </>
              )}
            </div>
          )}

          <SectionLabel>Model fields</SectionLabel>
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
          {/* The anomaly is the model against a climatology, so it belongs
              with the model fields rather than beside the instruments. */}
          {!inBlock && climatologyAvailable && (
            <MenuRow
              label="Show anomaly"
              icon={<IconAnomaly />}
              checked={s.showAnomaly}
              onChange={() => s.toggle("showAnomaly")}
              title="Departure from the climatology, in standard deviations"
            />
          )}
          {/* Provenance sits with the data it describes. A judge should never
              have to open a panel to find out what they are looking at. */}
          {s.health?.source && (
            <div
              className="truncate px-4 pt-1 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]"
              title={s.health.source}
            >
              {s.health.source}
            </div>
          )}

          {/* Assessment layers describe the region as a whole, so they belong
              to map mode; inside a block the same questions are answered by
              the matchup panel for one instrument at a time.

              Whether the section appears at all for the CURRENT variable is
              the section's own decision -- it needs the same answer to clear a
              layer that is already painted, so the test lives in one place
              rather than being repeated by every caller. */}
          {!inBlock && <AssessmentSection />}

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
                      : s.sectionPoints.length >= MAX_SECTION_POINTS
                        ? `${MAX_SECTION_POINTS} waypoints is the limit; a further click moves the last one`
                        : "keep clicking to bend the transect, or leave it straight"}
                  {s.sectionPoints.length > 0 && (
                    <>
                      <div className="mt-1 truncate font-mono text-[10px] text-[color:var(--ze-text-dim)]">
                        {s.sectionPoints
                          .map((p) => `${p[0].toFixed(2)}, ${p[1].toFixed(2)}`)
                          .join("  to  ")}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <button
                          className="ze-btn !px-2 !py-0.5 !text-[10px]"
                          onClick={s.undoSectionPoint}
                        >
                          Undo point
                        </button>
                        <button
                          className="ze-btn !px-2 !py-0.5 !text-[10px]"
                          onClick={s.clearSection}
                        >
                          Clear
                        </button>
                      </div>
                    </>
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
    </>
  );
}
