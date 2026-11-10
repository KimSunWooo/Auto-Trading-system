"""Backtest completion result-event schema (Kafka notify payload)."""

from __future__ import annotations

import hashlib
from typing import Any, Dict

SCHEMA_VERSION = "backtest-result.v1"
BACKTEST_RESULTS_TOPIC = "backtest-results"


def make_event_id(job_id: str, status: str) -> str:
    """Stable id for one terminal completion — republish keeps the same eventId."""
    raw = f"{SCHEMA_VERSION}|{job_id}|{status}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]
    return f"{SCHEMA_VERSION}:{job_id}:{status}:{digest}"


def build_result_event(
    *,
    job_id: str,
    status: str,
    completed_at_unix_ms: int,
) -> Dict[str, Any]:
    if status not in {"SUCCEEDED", "FAILED"}:
        raise ValueError(f"notify_status_not_terminal:{status}")
    event_id = make_event_id(job_id, status)
    return {
        "eventId": event_id,
        "jobId": job_id,
        "schemaVersion": SCHEMA_VERSION,
        "status": status,
        "completedAtUnixMs": completed_at_unix_ms,
        "partitionKey": job_id,
    }
