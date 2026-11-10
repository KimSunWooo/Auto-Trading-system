"""Configurable caps for UploadBars streaming."""

from __future__ import annotations

import os


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


# Per-chunk and stream caps (overridable via env).
MAX_BARS_PER_CHUNK = _int("EXT_UPLOAD_MAX_BARS_PER_CHUNK", 500)
MAX_TOTAL_BARS = _int("EXT_UPLOAD_MAX_TOTAL_BARS", 50_000)
MAX_TOTAL_BYTES = _int("EXT_UPLOAD_MAX_TOTAL_BYTES", 8 * 1024 * 1024)
MAX_CONCURRENT_UPLOADS = _int("EXT_UPLOAD_MAX_CONCURRENT", 2)
MAX_CHUNK_WIRE_BYTES = _int("EXT_UPLOAD_MAX_CHUNK_WIRE_BYTES", 512 * 1024)
TEMP_TTL_MS = _int("EXT_UPLOAD_TEMP_TTL_MS", 60 * 60 * 1000)  # 1h orphan cleanup
CLIENT_SEND_BUFFER = _int("EXT_UPLOAD_CLIENT_SEND_BUFFER", 3)

# Acceptable bar interval labels.
ALLOWED_INTERVALS = frozenset({"1m", "5m", "15m", "1h", "1d"})
