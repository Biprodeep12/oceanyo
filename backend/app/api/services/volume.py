"""Volume quantization and the binary wire format.

Wire format -- a single length-prefixed body:

    [uint32 LE headerLen][utf8 JSON VolumeHeader][raw volume bytes]

One round trip, no need to expose custom headers to the browser, no header size
limit, and the Web Worker parses the header without a second fetch.

Two decisions are load-bearing:

1. Raw 0 is RESERVED for fill/land; valid data occupies 1..(2^bits - 1). WebGL
   normalizes uint8 to 0..1 on upload, so the shader discards `texel == 0.0`
   with no separate mask texture. Without this, land renders as ice-cold water.

2. vmin/vmax come from the DATASET-WIDE data range, never the per-request
   subset. Otherwise the colour mapping shifts whenever the user moves the
   depth slider or scrubs time, and the volume appears to flicker.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Literal

import numpy as np

from ...core.cf_adapter import CFDataset
from ...core.geometry import BBox, DepthRange
from ...core.models import VolumeHeader

# Stage 1 of the progressive reveal (arrives ~300 ms, ~131 KB) and stage 2
# (~2 s, a few MB). See spec section 5.1.
RESOLUTIONS: dict[str, tuple[int, int, int]] = {
    "coarse": (32, 64, 64),
    "full": (64, 256, 256),
}


@dataclass
class Quantized:
    raw: bytes
    scale: float
    offset: float
    fill_raw: int
    dtype: str


def quantize(
    data: np.ndarray,
    *,
    dtype: Literal["uint8", "uint16"] = "uint8",
    vmin: float,
    vmax: float,
) -> Quantized:
    """Map float32 -> unsigned ints, reserving raw 0 for fill.

        value = raw * scale + offset      (for raw >= 1)
    """
    levels = 256 if dtype == "uint8" else 65536
    usable = levels - 1  # raw 0 is reserved

    if vmax - vmin < 1e-12:
        vmax = vmin + 1e-12
    scale = (vmax - vmin) / (usable - 1)
    offset = vmin - scale  # so raw == 1 maps exactly to vmin

    finite = np.isfinite(data)
    out = np.zeros(data.shape, dtype=np.uint8 if dtype == "uint8" else np.uint16)
    if finite.any():
        scaled = (data[finite] - offset) / scale
        out[finite] = np.clip(np.round(scaled), 1, usable).astype(out.dtype)

    return Quantized(
        raw=out.tobytes(order="C"),
        scale=float(scale),
        offset=float(offset),
        fill_raw=0,
        dtype=dtype,
    )


def dequantize(raw: np.ndarray, scale: float, offset: float) -> np.ndarray:
    """Inverse of `quantize`, used by tests and the contract check."""
    out = raw.astype(np.float64) * scale + offset
    return np.where(raw == 0, np.nan, out)


def pack(header: VolumeHeader, body: bytes) -> bytes:
    """Assemble the length-prefixed binary response."""
    head = header.model_dump_json().encode("utf-8")
    return struct.pack("<I", len(head)) + head + body


def unpack(buf: bytes) -> tuple[dict, bytes]:
    """Inverse of `pack`. Mirrors the Web Worker's parsing logic exactly."""
    (head_len,) = struct.unpack("<I", buf[:4])
    header = json.loads(buf[4 : 4 + head_len].decode("utf-8"))
    return header, buf[4 + head_len :]


def build_volume(
    cfd: CFDataset,
    *,
    variable: str,
    time: str | None,
    bbox: BBox,
    depth_range: DepthRange,
    resolution: Literal["coarse", "full"] = "coarse",
    dtype: Literal["uint8", "uint16"] = "uint8",
) -> bytes:
    """Produce the complete binary body for GET /api/volume."""
    if resolution not in RESOLUTIONS:
        raise ValueError(f"resolution must be one of {list(RESOLUTIONS)}")

    values, coords = cfd.select(
        variable,
        bbox=bbox,
        time=time,
        depth_range=depth_range,
        max_shape=RESOLUTIONS[resolution],
    )

    meta = cfd.meta(variable)
    # Dataset-wide, deliberately not per-subset -- but the DATA range rather
    # than the validity range. Quantising temperature over -2..36 degC spent
    # most of the 255 levels on water that does not exist in this catalogue and
    # squeezed the entire deep ocean into the darkest few colours.
    vmin, vmax = cfd.data_range(variable)
    q = quantize(values, dtype=dtype, vmin=vmin, vmax=vmax)

    snapped = cfd.nearest_time(time)
    header = VolumeHeader(
        dtype=q.dtype,
        scale=q.scale,
        offset=q.offset,
        fillRaw=q.fill_raw,
        dims=(values.shape[0], values.shape[1], values.shape[2]),  # depth, lat, lon
        bbox=(
            float(coords["lon"][0]), float(coords["lat"][0]),
            float(coords["lon"][-1]), float(coords["lat"][-1]),
        ),
        depthRange=(float(coords["depth"][0]), float(coords["depth"][-1])),
        depths=[float(d) for d in coords["depth"]],
        resolution=resolution,
        variable=variable,
        time=str(snapped) if snapped is not None else "",
        vmin=float(vmin),
        vmax=float(vmax),
    )
    return pack(header, q.raw)
