"""Decoding Argo-style QC flags, whichever way a file stores them."""

from __future__ import annotations

import numpy as np


def decode_qc(raw, n: int) -> list[int]:
    """Argo QC flags, whatever the file encodes them as.

    Real GDAC files store QC as a CHARACTER array, so xarray hands back an
    object array mixing `bytes` (b"1", b"4") with `nan` wherever the character
    is blank -- and blank is common, because it means "no QC performed" on
    levels the float never sampled. `.astype(int)` on that raises
    "cannot convert float NaN to integer" and takes the whole profile with it:
    762 of 840 real profiles failed to load before this existed.

    Blank maps to 0, which is Argo reference table 2 for "no QC performed" --
    not to 1, which would silently promote unchecked levels into the
    quantitative statistics.
    """
    out: list[int] = []
    values = list(raw) if raw is not None else []
    for k in range(n):
        q = values[k] if k < len(values) else None
        out.append(_qc_one(q))
    return out


def _qc_one(q) -> int:
    if isinstance(q, bytes):
        q = q.decode("ascii", "ignore")
    if isinstance(q, str):
        q = q.strip()
        return int(q) if q.isdigit() else 0
    if q is None:
        return 0
    try:
        f = float(q)
    except (TypeError, ValueError):
        return 0
    return 0 if not np.isfinite(f) else int(f)
