"use client";

// Data provenance, read from the files themselves.
//
// The Level 2 list asks for "data provenance". The tempting version is a
// paragraph in an About box, which is a claim: it says what someone believed
// when they wrote it, and it goes stale the first time the catalogue is
// repointed. This reads /api/provenance, which reports what the server process
// actually has open right now, straight out of each file's global attributes.
// If the catalogue changes, this changes with it, and it cannot drift.

import { useEffect, useState } from "react";

import { api } from "@/lib/api/client";
import type { ProvenanceResponse } from "@/lib/api/types";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2 leading-relaxed">
      <span className="w-[74px] shrink-0 text-[color:var(--ze-text-faint)]">{k}</span>
      <span className="min-w-0 flex-1 break-words text-[color:var(--ze-text-dim)]">{v}</span>
    </div>
  );
}

export default function ProvenancePanel() {
  const [prov, setProv] = useState<ProvenanceResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api
      .provenance(ac.signal)
      .then(setProv)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErr(String(e));
      });
    return () => ac.abort();
  }, []);

  if (err) {
    return <div className="px-4 pb-3 text-[11.5px] text-[color:var(--ze-warn)]">{err}</div>;
  }
  if (!prov) {
    return (
      <div className="px-4 pb-3 text-[11.5px] text-[color:var(--ze-text-dim)]">
        reading the file headers&hellip;
      </div>
    );
  }

  return (
    <div className="ze-scroll max-h-[62vh] overflow-y-auto px-4 pb-3 text-[11px]">
      <div
        className={`mb-2.5 rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
          prov.synthetic
            ? "bg-[color:var(--ze-warn)]/12 text-[color:var(--ze-warn)]"
            : "bg-black/25 text-[color:var(--ze-text-dim)]"
        }`}
      >
        {prov.synthetic
          ? "Synthetic data. Every field below was generated, not measured."
          : "Measured and modelled data. Nothing below was generated."}
        <div className="mt-1 font-mono text-[10px] text-[color:var(--ze-text-faint)]">
          {prov.catalogId} &middot; {prov.catalogFile.split(/[\\/]/).pop()}
        </div>
      </div>

      {prov.datasets.map((d) => (
        <div key={d.role} className="mb-2.5 border-t border-[color:var(--ze-line)] pt-2">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[11.5px] font-medium text-[color:var(--ze-text)]">
              {d.role}
            </span>
            <span className="truncate font-mono text-[10px] text-[color:var(--ze-text-faint)]">
              {d.file}
            </span>
          </div>
          <div className="space-y-0.5 text-[10.5px]">
            {d.attrs.title && <Row k="title" v={d.attrs.title} />}
            {d.attrs.institution && <Row k="institution" v={d.attrs.institution} />}
            {d.attrs.source && <Row k="source" v={d.attrs.source} />}
            {d.attrs.Conventions && <Row k="conventions" v={d.attrs.Conventions} />}
            {d.attrs.references && <Row k="references" v={d.attrs.references} />}
            <Row
              k="grid"
              v={Object.entries(d.shape)
                .map(([k, v]) => `${k}=${v}`)
                .join("  ")}
            />
            <Row
              k="extent"
              v={`${d.bbox[0].toFixed(1)}, ${d.bbox[1].toFixed(1)} to ${d.bbox[2].toFixed(1)}, ${d.bbox[3].toFixed(1)}`}
            />
            {d.timeRange && (
              <Row
                k="time"
                v={`${d.timeRange[0].slice(0, 10)} to ${d.timeRange[1].slice(0, 10)} (${d.steps} steps${
                  d.stepHours ? `, ${Math.round(d.stepHours)} h apart` : ""
                })`}
              />
            )}
            <Row k="variables" v={d.variables.join(", ") || d.rawVariables.slice(0, 6).join(", ")} />
          </div>
        </div>
      ))}

      <div className="mb-2.5 border-t border-[color:var(--ze-line)] pt-2">
        <div className="mb-1 text-[11.5px] font-medium text-[color:var(--ze-text)]">
          observations
        </div>
        <div className="space-y-0.5 text-[10.5px]">
          {prov.observations.map((o) => (
            <Row
              key={o.platform}
              k={o.platform}
              v={`${o.profiles} profiles via ${o.parser}${
                o.latest ? ` · newest ${o.latest.slice(0, 10)}` : ""
              }`}
            />
          ))}
        </div>
        {/* The plugin registry, made visible. Adding a parser file adds a row
            here with no schema, endpoint or frontend change -- which is the
            claim MVP item 15 makes, shown rather than asserted. */}
        <div className="mt-1.5 text-[10px] leading-relaxed text-[color:var(--ze-text-faint)]">
          registered parsers: {prov.parsers.map((p) => p.platform).join(", ")}
        </div>
      </div>

      <div className="border-t border-[color:var(--ze-line)] pt-2 text-[10.5px] leading-relaxed text-[color:var(--ze-text-faint)]">
        {prov.disclaimer}
      </div>
    </div>
  );
}
