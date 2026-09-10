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

import { MenuRow, SectionLabel } from "@/components/ui";
import { IconGrid } from "@/components/ui/icons";
import { COVERAGE_METRICS, coverageStyle } from "@/lib/geo/coverageStyle";
import type { CoverageMetric } from "@/lib/api/types";
import { useSessionStore } from "@/state/useSessionStore";

export default function AssessmentSection() {
  const metric = useSessionStore((s) => s.coverageMetric);
  const coverage = useSessionStore((s) => s.coverage);
  const loading = useSessionStore((s) => s.loadingCoverage);
  const setMetric = useSessionStore((s) => s.setCoverageMetric);

  const active = metric ? coverageStyle(metric, coverage) : null;
  const sum = coverage?.summary;

  return (
    <>
      <SectionLabel>Assessment</SectionLabel>
      {COVERAGE_METRICS.map((m: CoverageMetric) => {
        const spec = coverageStyle(m, null).spec;
        return (
          <MenuRow
            key={m}
            type="radio"
            name="assessment"
            label={spec.label}
            icon={<IconGrid />}
            checked={metric === m}
            // Clicking the active row turns the layer off. Without that the
            // only way back to a plain map is a seventh "None" row, which
            // reads as a layer that is not one.
            onChange={() => setMetric(metric === m ? null : m)}
            title={spec.question}
          />
        );
      })}

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
