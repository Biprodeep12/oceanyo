"use client";

// GPU capability probe.
//
// WebGL2 guarantees MAX_3D_TEXTURE_SIZE of only 256; desktop NVIDIA reports
// 16384 while AMD on Windows commonly reports 2048. The demo machine is not
// necessarily the dev machine, so the quality tier is decided at runtime and
// shown in the UI rather than assumed.

export type QualityTier = "high" | "medium" | "slices";

export interface GpuCaps {
  webgl2: boolean;
  max3DTextureSize: number;
  maxTextureSize: number;
  renderer: string;
  tier: QualityTier;
  /** Volume request resolution this GPU can actually take. */
  volumeRes: "full" | "coarse";
  /** Ray-march steps when idle / when moving. */
  steps: { idle: number; moving: number };
}

let cached: GpuCaps | null = null;

export function probeGpu(): GpuCaps {
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;

  if (!gl) {
    cached = {
      webgl2: false,
      max3DTextureSize: 0,
      maxTextureSize: 0,
      renderer: "no WebGL2",
      tier: "slices",
      volumeRes: "coarse",
      steps: { idle: 64, moving: 32 },
    };
    return cached;
  }

  const max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
  const max2D = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  // WEBGL_debug_renderer_info is increasingly restricted, so fall back to the
  // plain RENDERER/VERSION strings, which still leak enough to spot software.
  let renderer = String(gl.getParameter(gl.RENDERER) ?? "unknown");
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  if (dbg) {
    renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? renderer);
  }

  let tier: QualityTier;
  let volumeRes: "full" | "coarse";
  let steps: { idle: number; moving: number };

  // A software rasteriser reports a generous MAX_3D_TEXTURE_SIZE but cannot
  // sustain a 256-step ray-march at full viewport size -- frames take seconds.
  // This is not hypothetical: a machine with no usable GPU driver falls back
  // here, and so does headless Chromium.
  const software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);

  if (software) {
    tier = "medium";
    volumeRes = "coarse";
    steps = { idle: 48, moving: 24 };
  } else if (max3D >= 512) {
    tier = "high";
    volumeRes = "full";
    steps = { idle: 256, moving: 64 };
  } else if (max3D >= 256) {
    tier = "medium";
    volumeRes = "coarse";
    steps = { idle: 128, moving: 48 };
  } else {
    // Below the spec floor, or no 3D texture support worth using: fall back to
    // stacked depth slices, which still reads as volumetric on screen.
    tier = "slices";
    volumeRes = "coarse";
    steps = { idle: 64, moving: 32 };
  }

  // Release the probe context rather than leaving it on the GPU.
  gl.getExtension("WEBGL_lose_context")?.loseContext();

  cached = {
    webgl2: true,
    max3DTextureSize: max3D,
    maxTextureSize: max2D,
    renderer,
    tier,
    volumeRes,
    steps,
  };
  return cached;
}
