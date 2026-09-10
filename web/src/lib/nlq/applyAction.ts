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
import { modeActions } from "@/lib/viewport";
import { useSessionStore } from "@/state/useSessionStore";

export interface ViewAction {
  name: string;
  args: Record<string, unknown>;
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
