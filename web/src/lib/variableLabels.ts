// Menu-length names for the canonical variables.
//
// The catalog supplies CF long names ("Eastward sea water velocity"), which
// are correct and unreadable in a 240px list or a cursor bubble. The full
// standard name stays available as a tooltip wherever these are used.

export const SHORT_LABEL: Record<string, string> = {
  temperature: "Temperature",
  salinity: "Salinity",
  u: "Eastward current",
  v: "Northward current",
  chlorophyll: "Chlorophyll",
};

export function shortLabel(variable: string, fallback?: string): string {
  return SHORT_LABEL[variable] ?? fallback ?? variable;
}
