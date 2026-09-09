"""Reproject a geodetic (plate carree) tile pyramid into Web Mercator XYZ.

Why this exists
---------------
Natural Earth II is distributed as an equirectangular image, and the obvious
way to tile it -- the way Cesium wants it -- is a **geodetic TMS** pyramid:
2^(z+1) x 2^z tiles of 256 px, y counted from the SOUTH.

MapLibre cannot use that. It wants **Web Mercator XYZ**: 2^z x 2^z tiles with y
counted from the north. Handing it geodetic tiles produces a basemap that is
wrong in two independent ways at once -- latitudes compressed by the missing
Mercator stretch, and the whole thing mirrored top to bottom -- so land sits
near the right longitude and visibly the wrong latitude. It looks like a
half-broken alignment rather than a projection error, which is what makes it
worth a script and a comment instead of a shrug.

Longitude is linear in both projections, so the reprojection is a pure VERTICAL
resample: for each output row, invert the Mercator y to a latitude and take the
source row at that latitude. No interpolation library, no GDAL, no download --
the source pyramid already on disk is enough.

    python scripts/build_basemap.py <geodetic-tms-dir> web/public/basemap

Natural Earth II is public domain; a courtesy credit is customary and the app
carries one in the map attribution.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("needs pillow and numpy: backend/.venv/Scripts/python.exe -m pip install pillow numpy")

Image.MAX_IMAGE_PIXELS = None
TILE = 256
MAX_LAT = 85.05112877980659  # the latitude Web Mercator is cut off at


def stitch_geodetic(src: Path, z: int) -> Image.Image:
    """Reassemble one geodetic TMS level into a single equirectangular image."""
    cols, rows = 2 ** (z + 1), 2**z
    out = Image.new("RGB", (cols * TILE, rows * TILE))
    for x in range(cols):
        for r in range(rows):
            # TMS counts y from the south; row 0 of the image is the north.
            tms_y = rows - 1 - r
            p = src / str(z) / str(x) / f"{tms_y}.jpg"
            if not p.exists():
                continue
            out.paste(Image.open(p).convert("RGB"), (x * TILE, r * TILE))
    return out


def to_mercator(world: Image.Image, size: int) -> Image.Image:
    """Resample an equirectangular world image onto a square Mercator one."""
    src = np.asarray(world)
    sh, sw = src.shape[:2]

    # Output row -> Mercator y in [0,1] -> latitude -> source row.
    j = (np.arange(size) + 0.5) / size
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * j))))
    rows = np.clip(((90.0 - lat) / 180.0 * sh).astype(int), 0, sh - 1)

    # Longitude is linear in both, so columns are a straight rescale.
    cols = np.clip(((np.arange(size) + 0.5) / size * sw).astype(int), 0, sw - 1)

    return Image.fromarray(src[rows][:, cols])


def cut(img: Image.Image, out: Path, z: int, quality: int) -> int:
    n = 2**z
    side = n * TILE
    level = img.resize((side, side), Image.LANCZOS) if img.size[0] != side else img
    written = 0
    for x in range(n):
        for y in range(n):
            d = out / str(z) / str(x)
            d.mkdir(parents=True, exist_ok=True)
            box = (x * TILE, y * TILE, (x + 1) * TILE, (y + 1) * TILE)
            level.crop(box).save(d / f"{y}.jpg", quality=quality, optimize=True)
            written += 1
    return written


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", type=Path, help="geodetic TMS pyramid directory")
    ap.add_argument("dest", type=Path, help="output XYZ pyramid directory")
    ap.add_argument("--max-zoom", type=int, default=4)
    ap.add_argument("--quality", type=int, default=82)
    args = ap.parse_args()

    top = args.max_zoom
    if not (args.source / str(top)).is_dir():
        sys.exit(f"no level {top} under {args.source}")

    print(f"stitching geodetic level {top} ...")
    world = stitch_geodetic(args.source, top)
    print(f"  {world.size[0]}x{world.size[1]} equirectangular")

    # Mercator is square, and cutting off at +/-85 deg is what makes it so.
    side = 2**top * TILE
    merc = to_mercator(world, side)
    print(f"  -> {side}x{side} Web Mercator (clipped at +/-{MAX_LAT:.2f} deg)")

    total = 0
    for z in range(top + 1):
        total += cut(merc, args.dest, z, args.quality)
    print(f"wrote {total} tiles to {args.dest}")


if __name__ == "__main__":
    main()
