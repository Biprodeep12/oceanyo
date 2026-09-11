"use client";

// Executing a view action, from wherever it came.
//
// The palette had this inline in its own `run`, which was fine while the
// palette was the only thing producing tool calls. The assistant produces them
// too, and two copies of "what set_time means" would drift the first time one
// of them gained a case -- with the failure showing up as the assistant moving
// the display differently from the search box.
//
// Actions arrive already validated by the server against the live catalogue,
// so this only has to apply them.

import { openProfile } from "@/lib/api/openProfile";
import type { RegionPreset } from "@/lib/api/types";
import { shortLabel } from "@/lib/variableLabels";
import { modeActions } from "@/lib/viewport";
import { useSessionStore } from "@/state/useSessionStore";

export interface ViewAction {
  name: string;
  args: Record<string, unknown>;
}

/** What each assessment layer is, in the words the layers panel uses. */
const LAYER_NAMES: Record<string, string> = {
  count: "observation coverage",
  blindSpot: "blind spots",
  rmse: "model accuracy",
  bias: "model bias",
  confidence: "confidence",
  ageDays: "data freshness",
  anomaly: "the climatology anomaly",
};

/**
 * One applied action, in words rather than as a call.
 *
 * The assistant lists what it moved, and `set_time(2024-06-15T00:00:00)` is
 * the identifier of the thing that happened rather than the thing itself. The
 * literal call is still worth keeping within reach -- the caller puts it in
 * the row's tooltip -- but the display moving on its own is alarming enough
 * that the first reading of it should be a sentence.
 */
export function describeAction(a: ViewAction, presets: RegionPreset[] = []): string {
  const args = a.args ?? {};
  switch (a.name) {
    case "select_preset": {
      const id = String(args.region ?? "");
      return `Moved to ${presets.find((p) => p.id === id)?.label ?? id}`;
    }
    case "select_region": {
      const b = Array.isArray(args.bbox) ? (args.bbox as number[]) : [];
      return b.length === 4
        ? `Selected ${b.map((v) => Number(v).toFixed(1)).join(", ")}`
        : "Selected a region";
    }
    case "set_variable":
      return `Switched to ${shortLabel(String(args.variable ?? "")).toLowerCase()}`;
    case "set_depth":
      return `Went to ${args.depth} m`;
    case "set_time":
      return `Jumped to ${String(args.time ?? "").slice(0, 10)}`;
    case "set_layer": {
      const layer = String(args.layer ?? "");
      return layer === "none"
        ? "Cleared the assessment layer"
        : `Showed ${LAYER_NAMES[layer] ?? layer}`;
    }
    case "dive":
      // Named explicitly. This is the one action that changes what the whole
      // screen IS, and "moved the display" does not warn anyone that the map
      // they were reading is about to become a block.
      return "Dived into the 3D block";
    case "focus_platform":
      return `Opened ${args.id}`;
    default:
      return a.name;
  }
}

export function applyAction(action: ViewAction): void {
  const st = useSessionStore.getState();
  const a = action.args ?? {};

  switch (action.name) {
    case "select_preset": {
      const p = st.presets.find((x) => x.id === a.region);
      if (p) st.applyPreset(p);
      break;
    }
    case "select_region": {
      const bbox = a.bbox as [number, number, number, number] | undefined;
      if (bbox?.length === 4) st.setSelection(bbox);
      const dr = a.depthRange as [number, number] | undefined;
      if (dr?.length === 2) st.setDepthRange(dr);
      break;
    }
    case "set_variable":
      if (typeof a.variable === "string") st.setVariable(a.variable);
      break;
    case "set_depth":
      if (typeof a.depth === "number") st.setDepth(a.depth);
      break;
    case "set_time": {
      // The server only ever returns a timestep this catalogue contains, so a
      // miss here means the two have drifted -- do nothing rather than jump
      // somewhere arbitrary.
      const i = st.times.indexOf(String(a.time));
      if (i >= 0) st.setTimeIndex(i);
      break;
    }
    case "set_layer": {
      const layer = String(a.layer);
      if (layer === "anomaly") {
        if (!st.showAnomaly) st.toggle("showAnomaly");
      } else if (layer === "none") {
        st.setCoverageMetric(null);
      } else {
        st.setCoverageMetric(layer as never);
      }
      break;
    }
    case "dive":
      modeActions.dive();
      break;
    case "focus_platform": {
      const id = String(a.id);
      const cand = st.observations
        .filter((f) => f.properties.id.split(":")[0] === id)
        .sort((x, y) => (x.properties.time < y.properties.time ? 1 : -1))[0];
      if (cand) void openProfile(cand.properties.platform, cand.properties.id);
      break;
    }
  }
}
