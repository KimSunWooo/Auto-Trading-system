"""Streaming UploadBars session: validate batch-by-batch into temp, then register."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .dataset_catalog import DatasetCatalog, DatasetSpec
from .upload_limits import (
    ALLOWED_INTERVALS,
    MAX_BARS_PER_CHUNK,
    MAX_CHUNK_WIRE_BYTES,
    MAX_CONCURRENT_UPLOADS,
    MAX_TOTAL_BARS,
    MAX_TOTAL_BYTES,
)


class UploadError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class UploadLimits:
    max_bars_per_chunk: int = MAX_BARS_PER_CHUNK
    max_total_bars: int = MAX_TOTAL_BARS
    max_total_bytes: int = MAX_TOTAL_BYTES
    max_concurrent: int = MAX_CONCURRENT_UPLOADS
    max_chunk_wire_bytes: int = MAX_CHUNK_WIRE_BYTES


@dataclass
class UploadSession:
    session_id: str
    temp_dir: Path
    bars_path: Path
    meta_path: Path
    ticker: str = ""
    interval: str = ""
    client_dataset_id: str = ""
    accepted_bars: int = 0
    bytes_received: int = 0
    last_t_ms: int = -1
    start_t_ms: int = 0
    end_t_ms: int = 0
    hasher: Any = field(default_factory=lambda: hashlib.sha256())
    closed: bool = False
    created_at_unix_ms: int = 0

    def write_meta(self) -> None:
        payload = {
            "session_id": self.session_id,
            "ticker": self.ticker,
            "interval": self.interval,
            "client_dataset_id": self.client_dataset_id,
            "accepted_bars": self.accepted_bars,
            "bytes_received": self.bytes_received,
            "last_t_ms": self.last_t_ms,
            "start_t_ms": self.start_t_ms,
            "end_t_ms": self.end_t_ms,
            "created_at_unix_ms": self.created_at_unix_ms,
            "closed": self.closed,
        }
        tmp = self.meta_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(tmp, self.meta_path)


class UploadManager:
    """Limits concurrent uploads; never exposes temp sessions as catalog entries."""

    def __init__(self, catalog: DatasetCatalog, limits: Optional[UploadLimits] = None):
        self.catalog = catalog
        self.limits = limits or UploadLimits()
        self._lock = threading.Lock()
        self._active = 0
        self.catalog.purge_stale_temps()

    def begin(self) -> UploadSession:
        with self._lock:
            if self._active >= self.limits.max_concurrent:
                raise UploadError("resource_exhausted", "max_concurrent_uploads")
            self._active += 1
        session_id = uuid.uuid4().hex
        temp_dir = self.catalog.temp_dir / session_id
        temp_dir.mkdir(parents=True, exist_ok=True)
        session = UploadSession(
            session_id=session_id,
            temp_dir=temp_dir,
            bars_path=temp_dir / "bars.jsonl",
            meta_path=temp_dir / "session.json",
            created_at_unix_ms=int(time.time() * 1000),
        )
        session.bars_path.write_text("", encoding="utf-8")
        session.write_meta()
        return session

    def release(self, session: Optional[UploadSession], *, keep_temp: bool = False) -> None:
        with self._lock:
            self._active = max(0, self._active - 1)
        if session and not keep_temp:
            shutil.rmtree(session.temp_dir, ignore_errors=True)

    def append_chunk(
        self,
        session: UploadSession,
        *,
        bars: List[Dict[str, Any]],
        ticker: str,
        interval: str,
        client_dataset_id: str,
        wire_bytes: int,
        eof: bool,
    ) -> None:
        if session.closed:
            raise UploadError("failed_precondition", "session_already_closed")
        if wire_bytes > self.limits.max_chunk_wire_bytes:
            raise UploadError("resource_exhausted", "chunk_wire_bytes_exceeded")
        if len(bars) > self.limits.max_bars_per_chunk:
            raise UploadError("invalid_argument", "bars_per_chunk_exceeded")

        if not session.ticker:
            if not ticker:
                # Fall back to first bar ticker
                if bars and bars[0].get("ticker"):
                    ticker = str(bars[0]["ticker"])
                else:
                    raise UploadError("invalid_argument", "ticker_required")
            if not interval:
                raise UploadError("invalid_argument", "interval_required")
            if interval not in ALLOWED_INTERVALS:
                raise UploadError("invalid_argument", f"interval_not_allowed:{interval}")
            session.ticker = ticker
            session.interval = interval
            session.client_dataset_id = (client_dataset_id or "").strip()
        else:
            if ticker and ticker != session.ticker:
                raise UploadError("invalid_argument", "multi_ticker_forbidden")
            if interval and interval != session.interval:
                raise UploadError("invalid_argument", "multi_interval_forbidden")

        if session.accepted_bars + len(bars) > self.limits.max_total_bars:
            raise UploadError("resource_exhausted", "total_bars_exceeded")
        if session.bytes_received + wire_bytes > self.limits.max_total_bytes:
            raise UploadError("resource_exhausted", "total_bytes_exceeded")

        lines: List[str] = []
        for raw in bars:
            bar = self._normalize_and_validate(raw, session.ticker)
            t_ms = int(bar["t_ms"])
            if session.last_t_ms >= 0:
                if t_ms == session.last_t_ms:
                    raise UploadError("invalid_argument", "duplicate_timestamp")
                if t_ms < session.last_t_ms:
                    raise UploadError("invalid_argument", "bars_out_of_order")
            if session.accepted_bars == 0 and not lines:
                session.start_t_ms = t_ms
            session.last_t_ms = t_ms
            session.end_t_ms = t_ms
            line = json.dumps(bar, separators=(",", ":"), sort_keys=True)
            lines.append(line)
            session.hasher.update(line.encode("utf-8"))
            session.hasher.update(b"\n")

        if lines:
            with session.bars_path.open("a", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
            session.accepted_bars += len(lines)
            session.bytes_received += wire_bytes
            session.write_meta()

        if eof:
            session.closed = True
            session.write_meta()

    def finalize(self, session: UploadSession) -> Tuple[DatasetSpec, bool]:
        if not session.closed:
            raise UploadError("failed_precondition", "eof_required")
        if session.accepted_bars < 1:
            raise UploadError("invalid_argument", "empty_upload")

        content_hash = session.hasher.hexdigest()
        existing = self.catalog.find_by_hash(content_hash)
        if existing is not None:
            # Identical content — return existing active dataset; drop temp.
            return existing, True

        dataset_id = f"upload-{content_hash[:12]}"
        data_version = f"{dataset_id}@1"
        spec = DatasetSpec(
            dataset_id=dataset_id,
            data_version=data_version,
            description=f"Uploaded {session.ticker} {session.interval}",
            bars=session.accepted_bars,
            source="upload",
            ticker=session.ticker,
            interval=session.interval,
            content_hash=content_hash,
            start_t_ms=session.start_t_ms,
            end_t_ms=session.end_t_ms,
            path="",
        )
        registered = self.catalog.register_upload(spec, session.bars_path)
        return registered, False

    @staticmethod
    def _normalize_and_validate(raw: Dict[str, Any], expected_ticker: str) -> Dict[str, Any]:
        try:
            t_ms = int(raw.get("t_ms") if "t_ms" in raw else raw.get("tMs"))
            opener = float(raw.get("open"))
            high = float(raw.get("high"))
            low = float(raw.get("low"))
            close = float(raw.get("close"))
            volume = float(raw.get("volume"))
            ticker = str(raw.get("ticker") or expected_ticker)
            incomplete = bool(raw.get("incomplete", False))
        except (TypeError, ValueError) as exc:
            raise UploadError("invalid_argument", f"bar_parse_error:{exc}") from exc

        if ticker != expected_ticker:
            raise UploadError("invalid_argument", "multi_ticker_forbidden")
        if t_ms <= 0:
            raise UploadError("invalid_argument", "invalid_timestamp")
        if opener <= 0 or high <= 0 or low <= 0 or close <= 0:
            raise UploadError("invalid_argument", "non_positive_price")
        if volume < 0:
            raise UploadError("invalid_argument", "negative_volume")
        if high < max(opener, close) or low > min(opener, close):
            raise UploadError("invalid_argument", "ohlc_range_invalid")
        if low > high:
            raise UploadError("invalid_argument", "low_gt_high")

        return {
            "t_ms": t_ms,
            "ticker": ticker,
            "open": opener,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
            "incomplete": incomplete,
        }
