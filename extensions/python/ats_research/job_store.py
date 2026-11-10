#!/usr/bin/env python3
"""Durable-enough local job store for TradingAnalysis RPCs (file-backed).

SubmitBacktest is idempotent on idempotency_key. Queue has a hard cap.
Results are appended to a notify topic file for async consumers.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional


DEFAULT_QUEUE_CAP = 32
DEFAULT_TTL_MS = 24 * 60 * 60 * 1000


class JobStore:
    def __init__(self, root: Path, queue_cap: int = DEFAULT_QUEUE_CAP):
        self.root = root
        self.queue_cap = queue_cap
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs_dir = self.root / "jobs"
        self.jobs_dir.mkdir(exist_ok=True)
        self.index_path = self.root / "idempotency.json"
        self.notify_path = self.root / "backtest-results.jsonl"
        if not self.index_path.exists():
            self.index_path.write_text("{}", encoding="utf-8")

    def _index(self) -> Dict[str, str]:
        return json.loads(self.index_path.read_text(encoding="utf-8"))

    def _save_index(self, idx: Dict[str, str]) -> None:
        self.index_path.write_text(json.dumps(idx, indent=2), encoding="utf-8")

    def _queued_count(self) -> int:
        return sum(1 for p in self.jobs_dir.glob("*.json") if json.loads(p.read_text()).get("status") == "QUEUED")

    def submit(self, req: Dict[str, Any]) -> Dict[str, Any]:
        key = req.get("idempotency_key") or req.get("idempotencyKey")
        if not key:
            raise ValueError("idempotency_key required")
        deadline = int(req.get("deadline_unix_ms") or req.get("deadlineUnixMs") or 0)
        now = int(time.time() * 1000)
        if deadline and deadline < now:
            raise TimeoutError("deadline exceeded before queue")
        idx = self._index()
        if key in idx:
            job_id = idx[key]
            return {"job_id": job_id, "status": self.get(job_id)["status"], "deduped": True}
        if self._queued_count() >= self.queue_cap:
            raise RuntimeError("queue_cap_exceeded")
        job_id = str(uuid.uuid4())
        job = {
            "job_id": job_id,
            "status": "QUEUED",
            "request": req,
            "created_at_unix_ms": now,
            "updated_at_unix_ms": now,
            "expires_at_unix_ms": now + DEFAULT_TTL_MS,
            "error": None,
            "metrics": None,
        }
        (self.jobs_dir / f"{job_id}.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        idx[key] = job_id
        self._save_index(idx)
        return {"job_id": job_id, "status": "QUEUED", "deduped": False}

    def get(self, job_id: str) -> Dict[str, Any]:
        path = self.jobs_dir / f"{job_id}.json"
        if not path.exists():
            raise KeyError(job_id)
        job = json.loads(path.read_text(encoding="utf-8"))
        now = int(time.time() * 1000)
        if job["status"] in {"QUEUED", "RUNNING"} and job.get("expires_at_unix_ms", 0) < now:
            job["status"] = "EXPIRED"
            job["updated_at_unix_ms"] = now
            path.write_text(json.dumps(job, indent=2), encoding="utf-8")
        return job

    def complete(self, job_id: str, metrics: Dict[str, Any], error: Optional[str] = None) -> Dict[str, Any]:
        job = self.get(job_id)
        job["status"] = "FAILED" if error else "SUCCEEDED"
        job["error"] = error
        job["metrics"] = metrics
        job["updated_at_unix_ms"] = int(time.time() * 1000)
        (self.jobs_dir / f"{job_id}.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
        with self.notify_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"job_id": job_id, "status": job["status"], "metrics": metrics}) + "\n")
        return job


def demo() -> None:
    store = JobStore(Path("extensions/.bus/jobs"))
    first = store.submit(
        {
            "idempotency_key": "demo-1",
            "dataset_id": "synthetic-v0",
            "candidate": {"candidate_id": "ma-5-20", "fast_ma": 5, "slow_ma": 20},
        }
    )
    second = store.submit(
        {
            "idempotency_key": "demo-1",
            "dataset_id": "synthetic-v0",
            "candidate": {"candidate_id": "ma-5-20", "fast_ma": 5, "slow_ma": 20},
        }
    )
    store.complete(first["job_id"], {"total_return_pct": 1.2, "mdd_pct": 0.5, "trades": 3})
    print(json.dumps({"submit": first, "dedupe": second, "get": store.get(first["job_id"])}, indent=2))


if __name__ == "__main__":
    demo()
