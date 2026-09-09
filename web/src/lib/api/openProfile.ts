// Open an instrument's profile and its matchup, from anywhere.
//
// This lived inline in the 3D scene, which meant clicking a float worked in
// block mode and did nothing at all on the map -- the markers were drawn,
// styled by model error, and inert. The smoke test never caught it because its
// "click a float" step runs after Dive, so it only ever exercised the block.
//
// One function, two callers, so the two views cannot drift apart.

import { api } from "@/lib/api/client";
import { useSessionStore } from "@/state/useSessionStore";

export async function openProfile(platform: string, id: string): Promise<void> {
  const st = useSessionStore.getState();
  const variable = st.variable;
  st.setLoadingProfile(true);
  try {
    const [profile, match] = await Promise.all([
      api.profile(platform, id),
      // A profile with no model in window is normal against a real catalog and
      // must still open: the measured profile is worth seeing on its own.
      api.matchup({ platform, id, variable }).catch(() => null),
    ]);
    useSessionStore.getState().setSelectedProfile(profile);
    useSessionStore.getState().setMatchup(match);
  } catch {
    useSessionStore.getState().setSelectedProfile(null);
    useSessionStore.getState().setMatchup(null);
  } finally {
    useSessionStore.getState().setLoadingProfile(false);
  }
}
