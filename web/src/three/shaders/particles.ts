"use client";

// GPU particle advection, in the lineage of mapbox/webgl-wind and
// earth.nullschool.
//
// Particle positions live in a floating-point texture that is ping-ponged
// between two render targets: the update pass reads the previous texture and
// writes the next one, so no position ever touches the CPU. Each texel holds
// (x, y, prevX, prevY) in normalized block coordinates, which lets the draw
// pass render a short streak from the previous position to the current one --
// the streak IS the trail, with no accumulation buffer to manage.
//
// The velocity field is the RG-encoded PNG from /api/currents: R carries u and
// G carries v, each scaled into 0..1 against the min/max in the response, and
// alpha is 0 over land and below the seabed.

export const quadVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const particleUpdateShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uPositions;   // RG = position, BA = previous position
uniform sampler2D uVelocity;    // RG-encoded u/v, A = 0 over land
uniform vec2  uURange;          // (uMin, uMax) in m/s
uniform vec2  uVRange;          // (vMin, vMax) in m/s
uniform vec2  uMetres;          // bbox extent in metres (x, y)
uniform float uDt;              // seconds since last frame
uniform float uSpeed;           // playback exaggeration -- see note below
uniform float uDropRate;        // fraction respawned per frame
uniform float uSeed;

// Cheap hash; good enough for respawn scatter.
float rand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec4 state = texture2D(uPositions, vUv);
  vec2 pos = state.xy;

  vec4 vel = texture2D(uVelocity, pos);

  // Decode to m/s. Alpha 0 means land or below the seabed.
  vec2 ms = vec2(
    mix(uURange.x, uURange.y, vel.r),
    mix(uVRange.x, uVRange.y, vel.g)
  );
  bool onLand = vel.a < 0.5;

  // m/s -> fraction of the block per second. A basin is hundreds of km across,
  // so at true rate a 1 m/s current crosses ~0.5% of the block per hour and
  // nothing appears to move. uSpeed is an explicit, labelled time compression
  // for visualisation -- the direction and relative magnitude are the model's,
  // the playback rate is not.
  vec2 step = ms / uMetres * uSpeed * uDt;

  vec2 next = pos + step;

  // Respawn: a fixed drop rate stops particles piling into convergence zones
  // and slow corners, which is what makes a flow field read as static.
  float speed = length(ms);
  float dropRate = uDropRate + smoothstep(0.0, 0.6, 1.0 - speed / 1.2) * uDropRate;
  float r = rand(vUv + uSeed);

  bool outside = next.x < 0.0 || next.x > 1.0 || next.y < 0.0 || next.y > 1.0;
  bool drop = r < dropRate;

  if (onLand || outside || drop) {
    vec2 fresh = vec2(rand(vUv + uSeed + 0.13), rand(vUv + uSeed + 0.71));
    // prev == pos on respawn, so the streak has zero length and the particle
    // does not draw a line across the whole block on its first frame.
    gl_FragColor = vec4(fresh, fresh);
  } else {
    gl_FragColor = vec4(next, pos);
  }
}
`;

export const particleDrawVertexShader = /* glsl */ `
precision highp float;

attribute vec2 aRef;      // texel to read this particle from
attribute float aEnd;     // 0 = previous position, 1 = current position

uniform sampler2D uPositions;
uniform sampler2D uVelocity;
uniform vec2  uURange;
uniform vec2  uVRange;
uniform vec3  uSize;      // block world size
uniform float uPlaneY;    // world Y of the depth level being shown
uniform float uStreak;    // streak length as a fraction of the block
uniform float uMaxSpeed;  // m/s that maps to a full-length streak

varying float vSpeedN;
varying float vEnd;

void main() {
  vec4 state = texture2D(uPositions, aRef);
  vec2 head = state.xy;

  vec4 vel = texture2D(uVelocity, head);
  vec2 ms = vec2(
    mix(uURange.x, uURange.y, vel.r),
    mix(uVRange.x, uVRange.y, vel.g)
  );
  float speed = length(ms);
  vSpeedN = clamp(speed / uMaxSpeed, 0.0, 1.0);
  vEnd = aEnd;

  // The tail is derived from the VELOCITY, not from the previous position.
  //
  // One frame of true advection across a basin several hundred km wide moves a
  // particle by a few hundredths of a percent of the block -- far below one
  // pixel, so position-to-position streaks are invisible no matter how the
  // advection is tuned. Deriving the tail from the local velocity decouples
  // streak length from frame timing and makes the streak itself informative:
  // it points along the flow and its length scales with current speed.
  vec2 dir = speed > 1e-6 ? normalize(ms) : vec2(0.0);
  vec2 tail = head - dir * uStreak * vSpeedN;

  vec2 p = mix(tail, head, aEnd);

  // Normalized block coords -> centred world position, on the depth plane.
  vec3 world = vec3((p.x - 0.5) * uSize.x, uPlaneY, (p.y - 0.5) * uSize.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

export const particleDrawFragmentShader = /* glsl */ `
precision highp float;

varying float vSpeedN;
varying float vEnd;

uniform vec3 uSlowColor;
uniform vec3 uFastColor;
uniform float uOpacity;

void main() {
  vec3 rgb = mix(uSlowColor, uFastColor, vSpeedN);
  // Fade toward the tail so each streak reads as a direction of travel.
  float alpha = uOpacity * mix(0.05, 1.0, vEnd) * (0.35 + 0.65 * vSpeedN);
  gl_FragColor = vec4(rgb, alpha);
}
`;
