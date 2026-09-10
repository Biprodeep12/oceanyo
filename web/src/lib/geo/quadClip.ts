"use client";

// Turning a four-corner selection into something the block can honour.
//
// The Level 2 list asks for arbitrary-quadrilateral selection. The tempting
// reading is "teach the server to slice a polygon", which is a large change to
// every field, volume, section and matchup path in exchange for a shape the
// data does not have -- a NetCDF subset is a rectangle in index space and
// nothing else. So the server keeps receiving the quad's bounding box, exactly
// as before, and the quad is applied where it can be applied exactly: as four
// vertical clipping planes in the renderer.
//
// That is not a compromise hidden in a comment. It is the correct division:
// the extra water is fetched (it is contiguous in the file and free to read),
// and it is not shown. The alternative -- a server-side mask -- would send the
// same bytes with holes in them.

import * as THREE from "three";

import type { BBox } from "@/lib/api/types";
import { toBlockSpace, toWorld, type BlockFrame } from "@/lib/geo/blockSpace";

/** Signed area in the XZ plane; positive means counter-clockwise seen from +Y. */
function signedArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % pts.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** The quad's corners as world-space (x, z) at the block's centre height. */
export function quadWorldXZ(
  quad: [number, number][],
  bbox: BBox,
  depthRange: [number, number],
  frame: BlockFrame,
): [number, number][] {
  return quad.map((p) => {
    const [nx, , nz] = toBlockSpace(p[0], p[1], depthRange[0], bbox, depthRange);
    const [wx, , wz] = toWorld([nx, 0.5, nz], frame);
    return [wx, wz] as [number, number];
  });
}

/**
 * Four vertical planes whose intersection is the quad.
 *
 * `THREE.Plane` keeps the half-space where `normal . p + constant >= 0`, and
 * clipping DISCARDS everything else, so each normal must point INTO the shape.
 * Which side that is depends on the winding of the corners, and a user placing
 * four corners will wind them either way without thinking about it -- so the
 * winding is measured and the normals flipped to match, rather than assumed.
 *
 * A concave or self-crossing quad has no such intersection: four half-spaces
 * can only ever describe a convex region, and forcing one would clip away
 * parts of the selection the user drew. Callers get null and fall back to the
 * bounding box, which is what the server sent anyway.
 */
export function quadClipPlanes(
  quad: [number, number][],
  bbox: BBox,
  depthRange: [number, number],
  frame: BlockFrame,
): THREE.Plane[] | null {
  if (quad.length !== 4) return null;
  const pts = quadWorldXZ(quad, bbox, depthRange, frame);
  const area = signedArea(pts);
  if (Math.abs(area) < 1e-9) return null;
  const ccw = area > 0;

  // Convexity: every cross product of consecutive edges must share a sign.
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross === 0) continue;
    if (cross > 0 !== ccw) return null;
  }

  const planes: THREE.Plane[] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % 4];
    const ex = bx - ax;
    const ez = bz - az;
    const len = Math.hypot(ex, ez);
    if (len < 1e-9) return null;
    // Left normal of the edge in XZ, flipped for clockwise winding so it
    // always points inward.
    let nx = -ez / len;
    let nz = ex / len;
    if (!ccw) {
      nx = -nx;
      nz = -nz;
    }
    const normal = new THREE.Vector3(nx, 0, nz);
    planes.push(new THREE.Plane(normal, -(normal.x * ax + normal.z * az)));
  }
  return planes;
}

/**
 * Line-segment endpoints for a prism with the quad as its footprint.
 *
 * The cuboid outline is wrong once the block is clipped: eight of its twelve
 * edges lie outside the shape and would either be cut into floating stubs or
 * drawn around water that is no longer there. This replaces it.
 *
 * The corners are pulled a hair towards the centroid first. Clipping here is
 * GLOBAL -- `renderer.clippingPlanes` applies to every material and there is no
 * opting out of it, unlike the per-material planes that local clipping
 * enables. So an outline drawn exactly on the boundary is a coin toss per
 * fragment, and the frame would flicker and drop edges at grazing angles.
 * Half a percent inward is invisible and unambiguous. The alternative -- local
 * clipping, with the plane array threaded through every mesh in the block --
 * trades a sub-pixel offset for six places to forget.
 */
const OUTLINE_INSET = 0.005;

export function quadPrismPositions(
  quad: [number, number][],
  bbox: BBox,
  depthRange: [number, number],
  frame: BlockFrame,
): Float32Array {
  const raw = quadWorldXZ(quad, bbox, depthRange, frame);
  const cx = raw.reduce((a, p) => a + p[0], 0) / raw.length;
  const cz = raw.reduce((a, p) => a + p[1], 0) / raw.length;
  const pts = raw.map(
    ([x, z]) =>
      [
        x + (cx - x) * OUTLINE_INSET,
        z + (cz - z) * OUTLINE_INSET,
      ] as [number, number],
  );
  const halfY = frame.size[1] / 2;
  const seg: number[] = [];
  const push = (a: number[], b: number[]) => seg.push(...a, ...b);
  for (let i = 0; i < 4; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % 4];
    push([ax, halfY, az], [bx, halfY, bz]); // top face
    push([ax, -halfY, az], [bx, -halfY, bz]); // bottom face
    push([ax, halfY, az], [ax, -halfY, az]); // vertical
  }
  return new Float32Array(seg);
}
