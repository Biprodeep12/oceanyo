"""JULD handling shared by the Argo and glider parsers.

Argo and EGO files store time as JULD with `units = "days since 1950-01-01"`.
xarray decodes that into datetime64 automatically when the attributes are
present, and leaves it as a raw float when they are not (or when decoding is
disabled). Both forms occur in the wild, so both are handled here rather than
in each parser.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

JULD_EPOCH = pd.Timestamp("1950-01-01")
ISO_FMT = "%Y-%m-%dT%H:%M:%SZ"


def juld_to_iso(value) -> str:
    """Convert one JULD entry -- decoded datetime64 or raw day offset -- to ISO."""
    if isinstance(value, (np.datetime64, pd.Timestamp)):
        return pd.Timestamp(value).strftime(ISO_FMT)
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, (int, float)) and np.isfinite(value):
        return (JULD_EPOCH + pd.Timedelta(days=float(value))).strftime(ISO_FMT)
    # Anything else (str, NaT) -- let pandas try, and fail loudly if it cannot.
    return pd.Timestamp(value).strftime(ISO_FMT)
