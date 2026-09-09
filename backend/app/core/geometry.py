"""Spatial primitives and the block-local coordinate convention.

The block-space definition here is mirrored verbatim in
`web/src/lib/geo/blockSpace.ts`. Both sides must agree or isosurface meshes,
volume textures and instrument positions will not line up.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BBox:
    """Axis-aligned geographic rectangle, degrees. West/south inclusive."""

    west: float
    south: float
    east: float
    north: float

    @classmethod
    def parse(cls, raw: str) -> "BBox":
        """Parse the `bbox=w,s,e,n` query-parameter form."""
        parts = [float(p) for p in raw.split(",")]
        if len(parts) != 4:
            raise ValueError(f"bbox needs 4 comma-separated values, got {len(parts)}")
        return cls(*parts).normalized()

    def normalized(self) -> "BBox":
        """Reorder so west<east and south<north."""
        w, e = sorted((self.west, self.east))
        s, n = sorted((self.south, self.north))
        return BBox(w, s, e, n)

    def clamp_to(self, other: "BBox") -> "BBox":
        return BBox(
            max(self.west, other.west),
            max(self.south, other.south),
            min(self.east, other.east),
            min(self.north, other.north),
        )

    @property
    def width(self) -> float:
        return self.east - self.west

    @property
    def height(self) -> float:
        return self.north - self.south

    @property
    def center(self) -> tuple[float, float]:
        return ((self.west + self.east) / 2, (self.south + self.north) / 2)

    def is_empty(self) -> bool:
        return self.width <= 0 or self.height <= 0

    def as_list(self) -> list[float]:
        return [self.west, self.south, self.east, self.north]


@dataclass(frozen=True)
class DepthRange:
    """Depth interval in metres, positive DOWN (CF positive="down")."""

    top: float
    bottom: float

    @classmethod
    def parse(cls, raw: str) -> "DepthRange":
        parts = [float(p) for p in raw.split(",")]
        if len(parts) != 2:
            raise ValueError(f"depthRange needs 2 values, got {len(parts)}")
        top, bottom = sorted(parts)
        return cls(top, bottom)

    def clamp_to(self, other: "DepthRange") -> "DepthRange":
        return DepthRange(max(self.top, other.top), min(self.bottom, other.bottom))

    @property
    def thickness(self) -> float:
        return self.bottom - self.top

    def as_list(self) -> list[float]:
        return [self.top, self.bottom]


# --- block-local space ---------------------------------------------------
# x = normalized longitude   [0,1], east positive
# y = 1 - normalized depth   [0,1], Y-UP so the sea surface sits at y = 1
# z = normalized latitude    [0,1], north positive
#
# Vertical exaggeration is applied CLIENT-SIDE as scale.y. The server never
# bakes it into geometry, otherwise every exaggeration change would force a
# refetch of the isosurface mesh.


def to_block_space(
    lon: float, lat: float, depth: float, bbox: BBox, dr: DepthRange
) -> tuple[float, float, float]:
    x = (lon - bbox.west) / bbox.width if bbox.width else 0.0
    z = (lat - bbox.south) / bbox.height if bbox.height else 0.0
    y = 1.0 - ((depth - dr.top) / dr.thickness if dr.thickness else 0.0)
    return x, y, z
