// Which observations belong to the timestep on screen.
//
// The map used to draw every profile the catalog holds, all at once. Against
// synthetic data that was harmless -- the generator samples its floats from the
// model's own 30 daily steps, so every profile was contemporaneous with every
// frame. Against the real GDAC it is not: the same view showed 992 profiles
// spanning 2002 to 2026 while the timeline read 1 January 2024, which invites
// exactly the question a demo cannot afford ("are these current?") and answers
// it wrongly.
//
// The window is ONE ARGO CYCLE rather than a round number. A core float parks
// at 1000 m and surfaces every ten days, so +/- 10 days is the interval over
// which each active float in the region contributes about one profile: wide
// enough that the map is never empty, narrow enough that what is drawn is
// genuinely contemporaneous with the field under it. Anything outside it has no
// model to be compared against and is simply not shown.

export const OBS_WINDOW_DAYS = 10;

const DAY_MS = 86_400_000;

/**
 * The window to use for a given timeline: one Argo cycle, or half a model
 * step, whichever is wider.
 *
 * Ten days is right for a daily or 3-daily model. Against MONTHLY means it
 * covers two thirds of the interval each step stands for, so a third of every
 * month's observations are invisible at every step and no step shows them --
 * they fall in the gaps. Half the spacing is the width at which each step owns
 * exactly the observations for which it is the nearest step.
 */
export function windowDaysFor(times: string[]): number {
  if (times.length < 2) return OBS_WINDOW_DAYS;
  const ms = times.map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
  if (ms.length < 2) return OBS_WINDOW_DAYS;
  const gaps = [];
  for (let i = 1; i < ms.length; i++) if (ms[i] > ms[i - 1]) gaps.push(ms[i] - ms[i - 1]);
  if (!gaps.length) return OBS_WINDOW_DAYS;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.max(OBS_WINDOW_DAYS, median / DAY_MS / 2);
}

export interface TimedFeature {
  properties: { time?: string | null };
}

/** True when `iso` lies within `days` of `centre`. Undefined centre = show all. */
export function withinWindow(
  iso: string | null | undefined,
  centre: string | undefined,
  days: number = OBS_WINDOW_DAYS,
): boolean {
  if (!centre) return true;
  if (!iso) return false;
  const t = Date.parse(iso);
  const c = Date.parse(centre);
  if (!Number.isFinite(t) || !Number.isFinite(c)) return true;
  return Math.abs(t - c) <= days * DAY_MS;
}

/** Filter a feature list to the window around the displayed timestep. */
export function inTimeWindow<T extends TimedFeature>(
  features: T[],
  centre: string | undefined,
  days: number = OBS_WINDOW_DAYS,
): T[] {
  if (!centre) return features;
  return features.filter((f) => withinWindow(f.properties.time, centre, days));
}
