"""Server-side isosurface extraction, returned as binary glTF.

Isosurfacing belongs on the server. THREE.MarchingCubes targets metaballs and
implicit surfaces, not arbitrary scalar fields, and marching a real volume in
single-threaded JavaScript is not viable at these sizes.

The GLB is written by hand with numpy and struct rather than adding a glTF
library: it is a fixed, minimal layout (POSITION + NORMAL + indices, one mesh,
one primitive) and this keeps a dependency out of the tree.
"""

from __future__ import annotations

import json
import logging
import struct

import numpy as np
from skimage import measure

from ...core.cf_adapter import CFDataset
from ...core.geometry import BBox, DepthRange

log = logging.getLogger(__name__)

MAX_SHAPE = (64, 256, 256)
MAX_VERTICES = 250_000


def _pad4(b: bytes, fill: bytes = b"\x00") -> bytes:
    """glTF requires 4-byte alignment for every chunk."""
    rem = len(b) % 4
    return b if rem == 0 else b + fill * (4 - rem)


def _build_glb(positions: np.ndarray, normals: np.ndarray, indices: np.ndarray) -> bytes:
    positions = np.ascontiguousarray(positions, dtype=np.float32)
    normals = np.ascontiguousarray(normals, dtype=np.float32)
    indices = np.ascontiguousarray(indices, dtype=np.uint32)

    pos_b = positions.tobytes()
    nrm_b = normals.tobytes()
    idx_b = indices.tobytes()

    pos_off = 0
    nrm_off = pos_off + len(pos_b)
    idx_off = nrm_off + len(nrm_b)
    buffer = pos_b + nrm_b + idx_b

    gltf = {
        "asset": {"version": "2.0", "generator": "oceanUps isosurface"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{
            "primitives": [{
                "attributes": {"POSITION": 0, "NORMAL": 1},
                "indices": 2,
                "mode": 4,  # TRIANGLES
            }]
        }],
        "buffers": [{"byteLength": len(buffer)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": pos_off, "byteLength": len(pos_b), "target": 34962},
            {"buffer": 0, "byteOffset": nrm_off, "byteLength": len(nrm_b), "target": 34962},
            {"buffer": 0, "byteOffset": idx_off, "byteLength": len(idx_b), "target": 34963},
        ],
        "accessors": [
            {
                "bufferView": 0, "componentType": 5126, "count": len(positions),
                "type": "VEC3",
                "min": positions.min(axis=0).tolist() if len(positions) else [0, 0, 0],
                "max": positions.max(axis=0).tolist() if len(positions) else [0, 0, 0],
            },
            {"bufferView": 1, "componentType": 5126, "count": len(normals), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5125, "count": len(indices), "type": "SCALAR"},
        ],
    }

    json_chunk = _pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    bin_chunk = _pad4(buffer)

    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)  # magic "glTF", version 2
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A)  # "JSON"
    out += json_chunk
    out += struct.pack("<II", len(bin_chunk), 0x004E4942)  # "BIN"
    out += bin_chunk
    return bytes(out)


def extract_isosurface(
    cfd: CFDataset,
    *,
    variable: str,
    level: float,
    time: str | None,
    bbox: BBox,
    depth_range: DepthRange,
    step_size: int = 1,
    max_vertices: int = MAX_VERTICES,
) -> bytes:
    values, coords = cfd.select(
        variable, bbox=bbox, time=time, depth_range=depth_range, max_shape=MAX_SHAPE
    )
    if min(values.shape) < 2:
        raise ValueError(
            f"volume too small to isosurface: shape {values.shape}; widen the selection"
        )

    lo, hi = float(np.nanmin(values)), float(np.nanmax(values))
    if not (lo < level < hi):
        raise ValueError(
            f"level {level} is outside the data range [{lo:.3f}, {hi:.3f}] for this selection"
        )

    # Fill land/NaN far from the level so marching cubes does not manufacture a
    # surface along the seabed boundary.
    filled = np.where(np.isfinite(values), values, lo - 1000.0).astype(np.float32)

    verts = faces = normals = None
    for attempt in range(6):
        try:
            verts, faces, normals, _ = measure.marching_cubes(
                filled, level=level, step_size=step_size, allow_degenerate=False
            )
        except (ValueError, RuntimeError) as exc:
            raise ValueError(f"marching cubes failed: {exc}") from exc
        if len(verts) <= max_vertices:
            break
        step_size += 1  # decimate and retry
        log.info("isosurface too dense (%d verts); step_size -> %d", len(verts), step_size)

    if verts is None or len(verts) == 0:
        raise ValueError(f"no isosurface found at level {level}")

    # Map (depth_index, lat_index, lon_index) into block-local space:
    #   x = normalized lon, y = 1 - normalized depth (Y-up), z = normalized lat.
    # Mirrors core.geometry.to_block_space, and the client applies vertical
    # exaggeration as scale.y so geometry never has to be refetched for it.
    nz, ny, nx = values.shape
    zi, yi, xi = verts[:, 0], verts[:, 1], verts[:, 2]
    positions = np.empty((len(verts), 3), dtype=np.float32)
    positions[:, 0] = xi / max(nx - 1, 1)
    positions[:, 1] = 1.0 - (zi / max(nz - 1, 1))
    positions[:, 2] = yi / max(ny - 1, 1)

    nrm = np.empty_like(positions)
    nrm[:, 0] = normals[:, 2]
    nrm[:, 1] = -normals[:, 0]
    nrm[:, 2] = normals[:, 1]
    lengths = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = nrm / np.where(lengths < 1e-9, 1.0, lengths)

    log.info(
        "isosurface %s=%g -> %d verts, %d faces (step_size=%d)",
        variable, level, len(positions), len(faces), step_size,
    )
    return _build_glb(positions, nrm, faces.astype(np.uint32).ravel())
