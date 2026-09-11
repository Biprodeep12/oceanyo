"use client";

// The dive: what the map hands to the 3D scene, and the camera that catches it.
//
// The old transition was a 500 ms opacity crossfade between two canvases that
// had never agreed on where anything was. The rectangle vanished and a block
// appeared somewhere else, which reads as two screens rather than one move.
//
// This makes the swap geometric. The map first frames the selection, then
// reports the exact pixels its rectangle occupies. The 3D camera is then
// placed so the block's TOP FACE projects onto those same pixels -- so at the
// instant of the swap the two images coincide, and the block can be grown
// downward from a shape the viewer is already looking at.
//
// Two things make that possible at all, and both are worth stating:
//
//  * The map is held at bearing 0 and pitch 0 while framing, so a lon/lat box
//    projects to an axis-aligned screen rectangle in Web Mercator.
//  * The block's horizontal aspect is built with the same cos(latitude)
//    correction Mercator applies, so the rectangle and the face have the same
//    shape and ONE camera distance satisfies both axes.

import type { BBox } from "@/lib/api/types";

/** Where the selection sits on screen once the map has framed it. */
export interface DiveHandoff {
  /** CSS pixels, top-left origin, axis-aligned. */
  rect: { x: number; y: number; w: number; h: number };
  viewport: { w: number; h: number };
  bbox: BBox;
}

// --- the map side -----------------------------------------------------------

export type MapFramer = (bbox: BBox) => Promise<DiveHandoff | null>;

let framer: MapFramer | null = null;

export function registerMapFramer(fn: MapFramer): void {
  framer = fn;
}
export function releaseMapFramer(fn: MapFramer): void {
  if (framer === fn) framer = null;
}

/**
 * Ask the map to centre the selection and report where it landed.
 *
 * Resolves null when there is no map to ask -- a permalink that opens straight
 * into the block, or a test driving the store directly. The scene then falls
 * back to its fitted camera, which is exactly the old behaviour.
 */
export async function frameSelection(bbox: BBox): Promise<DiveHandoff | null> {
  if (!framer) return null;
  try {
    return await framer(bbox);
  } catch {
    return null;
  }
}

// --- the handoff itself -----------------------------------------------------

let current: DiveHandoff | null = null;

export const diveHandoff = {
  get: () => current,
  set: (h: DiveHandoff | null) => {
    current = h;
    // Published for the browser test, which asserts that the block's lid lands
    // on this rectangle. See `__diveAlignment` in BlockScene.
    if (typeof window !== "undefined") {
      (window as unknown as { __diveHandoff?: DiveHandoff | null }).__diveHandoff = h;
    }
  },
  clear: () => {
    current = null;
  },
};

// --- the camera that catches it ---------------------------------------------

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  /** Which world direction points up on screen. */
  up: [number, number, number];
}

/**
 * The pose whose image of the block's top face is the map's rectangle.
 *
 * `faceWidth`/`faceDepth` are the face's world size (x = east-west,
 * z = north-south) and `faceY` its height, which is the top of the block.
 *
 * The scene is mirrored so that world -Z is north (see BlockScene), which is
 * what lets a straight-down camera show east to the right AND north upward --
 * the two things a map does and a raw east/north/up frame cannot do at once.
 */
export function handoffPose(
  h: DiveHandoff,
  faceWidth: number,
  faceDepth: number,
  faceY: number,
  fovDeg: number,
): CameraPose {
  const halfFov = Math.tan((fovDeg * Math.PI) / 360);
  const H = Math.max(h.viewport.h, 1);

  // Pixels per world unit is H / (2 D tan(f/2)) on BOTH axes -- horizontally
  // the wider field of view and the wider viewport cancel exactly -- so the
  // two distances below differ only when the aspects disagree, and the larger
  // one is the one that keeps the face inside its rectangle.
  const dv = (faceDepth * H) / (2 * Math.max(h.rect.h, 1) * halfFov);
  const dh = (faceWidth * H) / (2 * Math.max(h.rect.w, 1) * halfFov);
  const D = Math.max(dv, dh);

  // Offset the camera so the face lands where the rectangle actually is,
  // rather than assuming the map centred it. Moving the camera one way moves
  // the image the other, hence the negatives.
  const worldPerPx = (2 * D * halfFov) / H;
  const dx = h.rect.x + h.rect.w / 2 - h.viewport.w / 2;
  const dy = h.rect.y + h.rect.h / 2 - h.viewport.h / 2;
  const cx = -dx * worldPerPx;
  const cz = -dy * worldPerPx;

  return {
    position: [cx, faceY + D, cz],
    target: [cx, faceY, cz],
    // North is world -Z after the mirror, and north is up on a map.
    up: [0, 0, -1],
  };
}

/** How long the map takes to centre the selection before the swap. */
export const FRAME_MS = 650;

/**
 * Padding held around the selection while framing, in CSS pixels.
 *
 * Symmetric on purpose: the rectangle ends up in the middle of the window
 * rather than the middle of the free space between the panels. The block that
 * replaces it is centred too, so anything else would move the thing the eye is
 * tracking at the exact moment the renderers change.
 */
export const FRAME_PADDING = 96;
export const FRAME_PADDING_MOBILE = 40;
