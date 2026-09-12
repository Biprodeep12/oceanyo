"use client";

// The Level 2 assessment layers, in the layers panel.
//
// Six named questions rather than six checkboxes. They all colour the same
// grid, so only one can be on at a time; presenting them as a radio group says
// that up front instead of letting a user tick two and wonder why the second
// one did nothing.
//
// Every row is phrased as the question the layer answers. A menu that says
// "Confidence" leaves the reader to guess what is being measured; one that
// says "how much should this region's model field be trusted" does not.
//
// The whole section is absent for a model field the instruments do not
// measure -- see assessableVariables(). Every layer here is the model compared
// against something in the water, so for eastward velocity there is nothing to
// compare it to, and six questions that can only answer "unobserved" are worse
// than no questions at all.

import { useEffect, useMemo } from "react";

import { MenuRow, SectionLabel } from "@/components/ui";
import { IconGrid } from "@/components/ui/icons";
import {
  assessableVariables,
  COVERAGE_METRICS,
  coverageStyle,
} from "@/lib/geo/coverageStyle";
import type { CoverageMetric } from "@/lib/api/types";
import { useSessionStore } from "@/state/useSessionStore";

// The row labels and the questions behind them, built once.
//
// coverageStyle() derives its ramp from the data in view, so calling it per row
// per render rebuilt six MapLibre paint expressions to read two strings that
// cannot change -- with no data passed, every range falls back to its floor and
// the spec is a constant. The legend below still calls it with the real grid.
const ROWS: { metric: CoverageMetric; label: string; question: string }[] =
  COVERAGE_METRICS.map((m) => {
    const { label, question } = coverageStyle(m, null).spec;
    return { metric: m, label, question };
  });

export default function AssessmentSection() {
  const metric = useSessionStore((s) => s.coverageMetric);
  const coverage = useSessionStore((s) => s.coverage);
  const loading = useSessionStore((s) => s.loadingCoverage);
  const setMetric = useSessionStore((s) => s.setCoverageMetric);
  const variable = useSessionStore((s) => s.variable);
  const parsers = useSessionStore((s) => s.parsers);
  const platforms = useSessionStore((s) => s.health?.platforms);

  const assessable = useMemo(
    () => assessableVariables(parsers, platforms),
    [parsers, platforms],
  );
  // Until /api/platforms answers there is nothing to go on, and hiding the
  // section on an empty list would make it flicker in a moment after boot.
  const supported = assessable.size === 0 || assessable.has(variable);

  // The safety net, not the mechanism: setVariable already drops an
  // incompatible layer as the variable changes, which is what keeps the map
  // from fetching a coverage grid for a field no float measures.
  //
  // This catches the case the store cannot see -- a shared link restoring
  // `variable=u&metric=bias` runs before /api/platforms has answered, so at
  // that moment nothing knows the pair is impossible. Without this the grid
  // would stay painted with its own controls hidden, and no way to turn it off.
  useEffect(() => {
    if (!supported && metric) setMetric(null);
  }, [supported, metric, setMetric]);

  const active = metric ? coverageStyle(metric, coverage) : null;
  const sum = coverage?.summary;

  if (!supported) return null;

  return (
    <>
      <SectionLabel>Assessment</SectionLabel>
      {ROWS.map(({ metric: m, label, question }) => (
        <MenuRow
          key={m}
          type="radio"
          name="assessment"
          label={label}
          icon={<IconGrid />}
          checked={metric === m}
          // Clicking the active row turns the layer off. Without that the
          // only way back to a plain map is a seventh "None" row, which
          // reads as a layer that is not one.
          //
          // A radio group fires no change event when its selected member is
          // clicked again, which is why this silently did nothing; the fix
          // is `reselectable` on MenuRow, which catches that click. Turning
          // these into checkboxes would also work and was tried, but it
          // gives away the one thing the group is shaped to say -- six
          // independent-looking ticks, of which ticking a second silently
          // unticks the first.
          reselectable
          onChange={() => setMetric(metric === m ? null : m)}
          title={`${question}${metric === m ? " — click again to turn it off" : ""}`}
        />
      ))}

      {active && (
        <div className="px-4 pb-2 pt-1">
          <div className="mb-1.5 text-[10.5px] leading-snug text-[color:var(--ze-text-dim)]">
            {active.spec.question}
          </div>

          <div className="flex items-stretch gap-[2px]">
            {active.spec.legend.map((sw, i) => (
              <div key={i} className="flex-1">
                <div
                  className="h-2.5 w-full rounded-[1px]"
                  style={{ background: sw.color }}
                />
                <div className="mt-1 truncate text-center text-[9.5px] text-[color:var(--ze-text-faint)]">
                  {sw.label}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-1.5 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
            {active.spec.note}
          </div>

          {/* What the layer is standing on. A coverage map computed from 40
              profiles and one from 800 look identical, and the difference is
              the whole question of whether to believe it. */}
          {loading && !sum && <div className="mt-1 text-[10px]">measuring&hellip;</div>}
          {sum && (
            <div className="mt-2 space-y-0.5 border-t border-[color:var(--ze-line)] pt-1.5 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
              <div>
                {sum.observedCells} of {sum.oceanCells} ocean cells observed
                {sum.coverage !== null && ` (${Math.round(sum.coverage * 100)}%)`}
                {" · "}
                {sum.cellDeg}&deg; cells
              </div>
              <div>
                {sum.scored} of {sum.profiles} profiles matched the model
                {sum.regionalRmse !== null &&
                  ` · RMSE ${sum.regionalRmse.toFixed(3)} ${sum.units}`}
              </div>
              {!sum.maskedByBathymetry && (
                <div className="text-[color:var(--ze-warn,#e8c15a)]">
                  no bathymetry mask: land counts as unobserved ocean
                </div>
              )}
              {sum.truncated && <div>sampled from a larger index</div>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
