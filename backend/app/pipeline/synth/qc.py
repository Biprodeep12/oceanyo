"""Writing QC flags in the GDAC character encoding."""

from __future__ import annotations

import numpy as np


def qc_chars(flags: np.ndarray) -> np.ndarray:
    """Encode QC flags the way the GDAC actually does: single characters.

    Argo and EGO store QC as a CHARACTER array, with a blank meaning "no QC
    performed" on levels the instrument never sampled. Writing int8 instead --
    as this generator originally did -- produces files that look right and read
    right, but exercise a code path no real file ever takes. That mismatch hid
    a parser bug that killed 762 of 840 real profiles: see api/obs/qc.py.
    """
    out = np.full(flags.shape, b" ", dtype="S1")
    scored = flags > 0
    out[scored] = flags[scored].astype("S1")
    return out
