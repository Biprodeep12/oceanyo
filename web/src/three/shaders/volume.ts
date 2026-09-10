"use client";

// Ray-marched volume rendering.
//
// GLSL lives in a .ts template literal rather than a .glsl file: no
// webpack/Turbopack raw-loader configuration (the flakiest part of a Next +
// Three setup, and worse on Windows paths), and it lets MAX_STEPS be baked in
// with #define at material-construction time. That matters -- adaptive
// ray-marching wants a recompile per quality tier, not a uniform branch that
// every fragment pays for.
//
// Technique: rasterize the BACK faces of the block, then march from the camera
// through the box in local space, compositing front to back with early
// termination.

export const volumeVertexShader = /* glsl */ `
varying vec3 vLocalPos;

void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const volumeFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;

varying vec3 vLocalPos;

uniform sampler3D uVolume;      // R channel, uint8 normalized to 0..1
uniform sampler2D uColormap;    // 256x1 LUT
uniform vec3  uBoxMin;
uniform vec3  uBoxMax;
uniform float uOpacity;
uniform float uThreshold;       // transfer function: values below this stay clear
uniform vec2  uClipY;           // visible vertical slab, in local Y

// Camera position in the mesh's OBJECT space, computed on the CPU each frame.
// Three does not inject modelMatrix into fragment shaders, and inverse() is
// GLSL ES 3.0 only -- doing it here would cost a matrix inversion per fragment
// for a value that is constant across the whole draw call.
uniform vec3  uCamLocal;

// Quantization inverse: physical value = raw * uScale255 + uOffset, where raw
// is the 0..1 value WebGL produced by normalizing the uint8 texel.
uniform float uScale255;
uniform float uOffset;
// User-chosen colour range and scaling, so the colorbar editor drives the
// volume and the map tiles identically.
uniform vec2  uDisplay;   // (low, high) in physical units
uniform float uLog;       // 1.0 = log scale

// Ray/AABB slab test in local space.
vec2 intersectBox(vec3 origin, vec3 dir, vec3 boxMin, vec3 boxMax) {
  vec3 invDir = 1.0 / dir;
  vec3 t0 = (boxMin - origin) * invDir;
  vec3 t1 = (boxMax - origin) * invDir;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z),
              min(min(tmax.x, tmax.y), tmax.z));
}

void main() {
  vec3 camLocal = uCamLocal;
  vec3 dir = normalize(vLocalPos - camLocal);

  vec2 hit = intersectBox(camLocal, dir, uBoxMin, uBoxMax);
  hit.x = max(hit.x, 0.0);
  if (hit.x > hit.y) discard;

  vec3 boxSize = uBoxMax - uBoxMin;
  float dist = hit.y - hit.x;
  float stepSize = dist / float(MAX_STEPS);

  vec4 accum = vec4(0.0);
  vec3 pos = camLocal + dir * hit.x;
  vec3 stepVec = dir * stepSize;

  for (int i = 0; i < MAX_STEPS; i++) {
    // Local position -> normalized box coordinate: x east, y up, z north.
    vec3 box = (pos - uBoxMin) / boxSize;

    // ...and then to a TEXTURE coordinate, which is a different order.
    //
    // The texture is Data3DTexture(data, nx, ny, nz) with dims [depth, lat,
    // lon], so its axes are s = longitude, t = latitude, r = depth level.
    // The box axes are x = longitude, y = height, z = latitude. Passing the
    // box coordinate straight in therefore indexed the DEPTH axis with
    // latitude and the LATITUDE axis with height -- a transposed volume, which
    // the spec names as the classic bug precisely because it looks like a
    // rendering fault rather than an indexing one. It did: the water column
    // rendered as a flat wall with a thin warm lid, and the top face showed a
    // depth profile smeared across longitude.
    //
    // r is flipped because texture layer 0 is the shallowest model level while
    // box y = 1 is the sea surface.
    vec3 uvw = vec3(box.x, box.z, 1.0 - box.y);

    // Vertical clipping, so the depth slider can cut the column open.
    if (pos.y >= uClipY.x && pos.y <= uClipY.y) {
      float raw = texture(uVolume, uvw).r;

      // Raw 0 is the reserved fill value: land, or below the seabed. Skipping
      // it here is why no separate mask texture is needed.
      if (raw > 0.0031) {
        // Raw -> physical units -> position within the user's colour range.
        float value = raw * uScale255 + uOffset;
        float lo = uDisplay.x;
        float hi = uDisplay.y;
        float cn;
        if (uLog > 0.5) {
          float floorV = max(lo, 1e-4);
          cn = (log2(max(value, floorV)) - log2(floorV))
             / max(log2(max(hi, floorV * 10.0)) - log2(floorV), 1e-6);
        } else {
          cn = (value - lo) / max(hi - lo, 1e-6);
        }
        cn = clamp(cn, 0.0, 1.0);

        float t = clamp((cn - uThreshold) / max(1.0 - uThreshold, 0.001), 0.0, 1.0);
        if (t > 0.0) {
          vec3 rgb = texture(uColormap, vec2(cn, 0.5)).rgb;
          // Opacity ramps with the transfer function so weak values stay sheer.
          float alpha = t * uOpacity * (1.6 / float(MAX_STEPS)) * 40.0;
          alpha = clamp(alpha, 0.0, 1.0);
          // Front-to-back compositing.
          accum.rgb += (1.0 - accum.a) * rgb * alpha;
          accum.a   += (1.0 - accum.a) * alpha;
        }
      }
    }

    pos += stepVec;

    // Early ray termination, and bail once outside the box.
    if (accum.a >= 0.97) break;
    if (any(lessThan(pos, uBoxMin - 0.001)) || any(greaterThan(pos, uBoxMax + 0.001))) break;
  }

  if (accum.a < 0.004) discard;
  gl_FragColor = vec4(accum.rgb / max(accum.a, 0.001), accum.a);
}
`;

/** Prefix the fragment shader with the compile-time step count. */
export function volumeFragmentWithSteps(steps: number): string {
  return `#define MAX_STEPS ${Math.max(8, Math.round(steps))}\n${volumeFragmentShader}`;
}
