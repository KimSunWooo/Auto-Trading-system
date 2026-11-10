#!/usr/bin/env python3
"""Durable local job store for TradingAnalysis RPCs (file-backed).

SubmitBacktest is idempotent on (idempotency_key, input fingerprint).
Same key + same input → same job_id.
Same key + different input → ConflictError.
Queue has a hard cap. Workers claim with a lease generation so a stale
worker cannot overwrite a newer completion.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore


DEFAULT_QUEUE_CAP = 32
DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
DEFAULT_LEASE_MS = 30_000
DEFAULT_MAX_ATTEMPTS = 3


class ConflictError(Exception):
    """Idempotency key reused with a different request body."""


class StaleLeaseError(Exception):
    """Worker tried to complete with an outdated lease generation."""


def _canonical_fingerprint(req: Dict[str, Any]) -> str:
    candidate = req.get("candidate") or {}
    payload = {
        "dataset_id": req.get("dataset_id") or req.get("datasetId") or "",
        "candidate": {
            "candidate_id": candidate.get("candidate_id") or candidate.get("candidateId") or "",
            "strategy_kind": candidate.get("strategy_kind") or candidate.get("strategyKind") or "",
            "fast_ma": int(candidate.get("fast_ma") or candidate.get("fastMa") or 0),
            "slow_ma": int(candidate.get("slow_ma") or candidate.get("slowMa") or 0),
            "buy_pct": float(candidate.get("buy_pct") or candidate.get("buyPct") or 0),
            "stop_loss_pct": float(candidate.get("stop_loss_pct") or candidate.get("stopLossPct") or 0),
            "data_version": candidate.get("data_version") or candidate.get("dataVersion") or "",
        },
        "tags": dict(sorted((req.get("tags") or {}).items())),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class JobStore:
    def __init__(
        self,
        root: Path,
        queue_cap: int = DEFAULT_QUEUE_CAP,
        lease_ms: int = DEFAULT_LEASE_MS,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    ):
        self.root = root
        self.queue_cap = queue_cap
        self.lease_ms = lease_ms
        self.max_attempts = max_attempts
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs_dir = self.root / "jobs"
        self.jobs_dir.mkdir(exist_ok=True)
        self.index_path = self.root / "idempotency.json"
        self.lock_path = self.root / ".store.lock"
        self.notify_path = self.root / "backtest-results.jsonl"
        if not self.index_path.exists():
            self.index_path.write_text("{}", encoding="utf-8")
        if not self.lock_path.exists():
            self.lock_path.write_text("", encoding="utf-8")

    @contextmanager
    def _lock(self) -> Iterator[None]:
        fh = open(self.lock_path, "a+", encoding="utf-8")
        try:
            if fcntl is not None:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            if fcntl is not None:
                try:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
            fh.close()

    def _index(self) -> Dict[str, Dict[str, str]]:
        raw = json.loads(self.index_path.read_text(encoding="utf-8"))
        # Migrate legacy {key: job_id} → {key: {job_id, fingerprint}}
        out: Dict[str, Dict[str, str]] = {}
        for k, v in raw.items():
            if isinstance(v, str):
                out[k] = {"job_id": v, "fingerprint": ""}
            else:
                out[k] = v
        return out

    def _save_index(self, idx: Dict[str, Dict[str, str]]) -> None:
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(idx, indent=2), encoding="utf-8")
        os.replace(tmp, self.index_path)

    def _write_job(self, job: Dict[str, Any]) -> None:
        path = self.jobs_dir / f"{job['job_id']}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def _read_job(self, job_id: str) -> Dict[str, Any]:
        path = self.jobs_dir / f"{job_id}.json"
        if not path.exists():
            raise KeyError(job_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def _queued_count(self) -> int:
        n = 0
        for p in self.jobs_dir.glob("*.json"):
            try:
                if json.loads(p.read_text(encoding="utf-8")).get("status") == "QUEUED":
                    n += 1
            except (json.JSONDecodeError, OSError):
                continue
        return n

    def submit(self, req: Dict[str, Any]) -> Dict[str, Any]:
        key = req.get("idempotency_key") or req.get("idempotencyKey")
        if not key:
            raise ValueError("idempotency_key required")
        dataset_id = req.get("dataset_id") or req.get("datasetId")
        if not dataset_id:
            raise ValueError("dataset_id required")
        deadline = int(req.get("deadline_unix_ms") or req.get("deadlineUnixMs") or 0)
        now = int(time.time() * 1000)
        if deadline and deadline < now:
            raise TimeoutError("deadline exceeded before queue")
        fp = _canonical_fingerprint(req)

        with self._lock():
            idx = self._index()
            if key in idx:
                entry = idx[key]
                job_id = entry["job_id"]
                prev_fp = entry.get("fingerprint") or ""
                if prev_fp and prev_fp != fp:
                    raise ConflictError(
                        f"idempotency_conflict key={key} existing_job={job_id}"
                    )
                # Legacy empty fingerprint: bind on first conflict-safe re-submit
                if not prev_fp:
                    entry["fingerprint"] = fp
                    self._save_index(idx)
                job = self._read_job(job_id)
                return {
                    "job_id": job_id,
                    "status": job["status"],
                    "deduped": True,
                    "fingerprint": fp,
                }
            if self._queued_count() >= self.queue_cap:
                raise RuntimeError("queue_cap_exceeded")
            job_id = str(uuid.uuid4())
            job = {
                "job_id": job_id,
                "status": "QUEUED",
                "request": req,
                "fingerprint": fp,
                "created_at_unix_ms": now,
                "updated_at_unix_ms": now,
                "expires_at_unix_ms": now + DEFAULT_TTL_MS,
                "error": None,
                "metrics": None,
                "result": None,
                "attempt": 0,
                "lease_generation": 0,
                "lease_owner": None,
                "lease_until_unix_ms": 0,
            }
            self._write_job(job)
            idx[key] = {"job_id": job_id, "fingerprint": fp}
            self._save_index(idx)
            return {
                "job_id": job_id,
                "status": "QUEUED",
                "deduped": False,
                "fingerprint": fp,
            }

    def get(self, job_id: str) -> Dict[str, Any]:
        with self._lock():
            job = self._read_job(job_id)
            now = int(time.time() * 1000)
            if job["status"] in {"QUEUED", "RUNNING"} and job.get("expires_at_unix_ms", 0) < now:
                job["status"] = "EXPIRED"
                job["updated_at_unix_ms"] = now
                self._write_job(job)
            return job

    def reclaim_expired_leases(self) -> List[str]:
        """Return RUNNING jobs whose lease expired to QUEUED (or FAILED if max attempts)."""
        reclaimed: List[str] = []
        with self._lock():
            now = int(time.time() * 1000)
            for p in self.jobs_dir.glob("*.json"):
                try:
                    job = json.loads(p.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue
                if job.get("status") != "RUNNING":
                    continue
                if int(job.get("lease_until_unix_ms") or 0) >= now:
                    continue
                attempt = int(job.get("attempt") or 0)
                if attempt >= self.max_attempts:
                    job["status"] = "FAILED"
                    job["error"] = "worker_lease_exhausted"
                else:
                    job["status"] = "QUEUED"
                    job["error"] = "worker_lease_expired_requeued"
                job["lease_owner"] = None
                job["lease_until_unix_ms"] = 0
                job["updated_at_unix_ms"] = now
                self._write_job(job)
                reclaimed.append(job["job_id"])
        return reclaimed

    def claim_next(self, worker_id: str) -> Optional[Dict[str, Any]]:
        """Atomically claim the oldest QUEUED job. Returns job + lease fields."""
        self.reclaim_expired_leases()
        with self._lock():
            now = int(time.time() * 1000)
            candidates: List[Dict[str, Any]] = []
            for p in self.jobs_dir.glob("*.json"):
                try:
                    job = json.loads(p.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue
                if job.get("status") == "QUEUED" and job.get("expires_at_unix_ms", 0) >= now:
                    candidates.append(job)
            if not candidates:
                return None
            candidates.sort(key=lambda j: j.get("created_at_unix_ms", 0))
            job = candidates[0]
            job["status"] = "RUNNING"
            job["attempt"] = int(job.get("attempt") or 0) + 1
            job["lease_generation"] = int(job.get("lease_generation") or 0) + 1
            job["lease_owner"] = worker_id
            job["lease_until_unix_ms"] = now + self.lease_ms
            job["updated_at_unix_ms"] = now
            job["error"] = None
            self._write_job(job)
            return job

    def heartbeat(self, job_id: str, worker_id: str, lease_generation: int) -> None:
        with self._lock():
            job = self._read_job(job_id)
            if job.get("status") != "RUNNING":
                raise StaleLeaseError("not_running")
            if job.get("lease_owner") != worker_id or int(job.get("lease_generation") or 0) != lease_generation:
                raise StaleLeaseError("lease_mismatch")
            now = int(time.time() * 1000)
            job["lease_until_unix_ms"] = now + self.lease_ms
            job["updated_at_unix_ms"] = now
            self._write_job(job)

    def complete(
        self,
        job_id: str,
        metrics: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        *,
        worker_id: Optional[str] = None,
        lease_generation: Optional[int] = None,
        result: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        with self._lock():
            job = self._read_job(job_id)
            # Terminal states are immutable — stale workers must not overwrite.
            if job.get("status") in {"SUCCEEDED", "FAILED", "EXPIRED"}:
                raise StaleLeaseError(f"already_terminal:{job['status']}")
            if worker_id is not None or lease_generation is not None:
                if job.get("status") != "RUNNING":
                    raise StaleLeaseError("not_running")
                if worker_id is not None and job.get("lease_owner") != worker_id:
                    raise StaleLeaseError("lease_owner_mismatch")
                if lease_generation is not None and int(job.get("lease_generation") or 0) != lease_generation:
                    raise StaleLeaseError("lease_generation_mismatch")
            now = int(time.time() * 1000)
            job["status"] = "FAILED" if error else "SUCCEEDED"
            job["error"] = error
            job["metrics"] = metrics
            job["result"] = result
            job["updated_at_unix_ms"] = now
            job["lease_until_unix_ms"] = 0
            self._write_job(job)
            with self.notify_path.open("a", encoding="utf-8") as fh:
                fh.write(
                    json.dumps(
                        {
                            "job_id": job_id,
                            "status": job["status"],
                            "metrics": metrics,
                            "note": "local_file_notify; kafka_result_topic=deferred",
                        }
                    )
                    + "\n"
                )
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
    claimed = store.claim_next("demo-worker")
    assert claimed is not None
    store.complete(
        first["job_id"],
        {"total_return_pct": 1.2, "mdd_pct": 0.5, "trades": 3},
        worker_id="demo-worker",
        lease_generation=claimed["lease_generation"],
    )
    print(json.dumps({"submit": first, "dedupe": second, "get": store.get(first["job_id"])}, indent=2))


if __name__ == "__main__":
    demo()
