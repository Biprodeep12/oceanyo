"use client";

// Effective colour settings for a variable: user override if present, else the
// variable's own defaults.
//
// This is a hook rather than a plain selector on purpose. A selector like
// `useSessionStore((s) => displayFor(s, s.variable))` builds a NEW object on
// every call, so zustand's reference equality check never matches, every store
// read schedules a re-render, and React tears the page down with "Maximum
// update depth exceeded". Selecting stable primitives and memoizing here is
// the fix -- the override values themselves are stable references held by the
// store, so the memo only recomputes when something really changed.

import { useMemo } from "react";
import { useSessionStore } from "./useSessionStore";

export interface DisplaySettings {
  range: [number, number];
  log: boolean;
  colormap: string;
  /** true when the user has overridden the variable defaults */
  customised: boolean;
}

export function useDisplaySettings(variableOverride?: string): DisplaySettings {
  const activeVariable = useSessionStore((s) => s.variable);
  const variable = variableOverride ?? activeVariable;

  const meta = useSessionStore((s) => s.variables.find((v) => v.variable === variable));
  const rangeOverride = useSessionStore((s) => s.colorRange[variable]);
  const logOverride = useSessionStore((s) => s.logScale[variable]);
  const cmapOverride = useSessionStore((s) => s.colormapOverride[variable]);

  return useMemo(() => {
    // Default to what the data SPANS, not to what would be physically valid.
    // Temperature is valid from -2 to 36 degC and this catalogue spans 3.7 to
    // 34.8; colouring over the validity range put every level below the
    // thermocline into the darkest sixth of the ramp, so a block that should
    // show structure showed a flat wall. validRange still bounds the slider,
    // so widening it is one drag away.
    const range: [number, number] =
      rangeOverride ??
      (meta?.dataRange as [number, number]) ??
      (meta?.validRange as [number, number]) ??
      [0, 1];
    return {
      range,
      log: logOverride ?? meta?.log ?? false,
      colormap: cmapOverride ?? meta?.colormap ?? "thermal",
      customised:
        rangeOverride !== undefined ||
        logOverride !== undefined ||
        cmapOverride !== undefined,
    };
  }, [meta, rangeOverride, logOverride, cmapOverride]);
}
