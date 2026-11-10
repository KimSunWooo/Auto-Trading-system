#!/usr/bin/env python3
"""Separate backtest worker process — claims QUEUED jobs and runs optimizer.

Does not share a process with the gRPC server. Lease generation prevents a
late/stale worker from overwriting a completed result after reclaim.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from . import datasets
from .job_store import JobStore, StaleLeaseError
from .optimizer import simulate, walk_forward

# Ensure uploaded datasets resolve from the same store root as JobStore.

LOG = logging.getLogger("ext.backtest_worker")

DEFAULT_POLL_MS = 250
DEFAULT_CONCURRENCY = 1  # processes claim serially inside one worker
MAX_INPUT_BARS = 5_000


def run_job(job: Dict[str, Any]) -> Dict[str, Any]:
    req = job.get("request") or {}
    dataset_id = req.get("dataset_id") or ""
    spec, closes, opens, lows = datasets.resolve_dataset(dataset_id)
    if len(closes) > MAX_INPUT_BARS:
        raise ValueError(f"input_too_large bars={len(closes)} max={MAX_INPUT_BARS}")

    cand = req.get("candidate") or {}
    fast = int(cand.get("fast_ma") or 5)
    slow = int(cand.get("slow_ma") or 20)
    buy_pct = float(cand.get("buy_pct") or 0.1)
    stop = float(cand.get("stop_loss_pct") or 0.05)
    if slow <= fast:
        slow = fast + 5

    # Point metrics for the submitted candidate on the full series.
    ret, mdd, trades = simulate(closes, opens, lows, fast, slow, buy_pct, stop)

    # Walk-forward grid for research ranking (reuses optimizer).
    ranked = walk_forward(closes, opens, lows, spec.data_version)
    holdout = [c for c in ranked if c.fold == "holdout"][:5]
    validation = {
        "folds": sorted({c.fold for c in ranked}),
        "holdout_top": [
            {
                "candidate_id": c.candidate_id,
                "fast_ma": c.fast_ma,
                "slow_ma": c.slow_ma,
                "buy_pct": c.buy_pct,
                "stop_loss_pct": c.stop_loss_pct,
                "total_return_pct": c.total_return_pct,
                "mdd_pct": c.mdd_pct,
                "trades": c.trades,
                "fold": c.fold,
            }
            for c in holdout
        ],
    }

    metrics = {
        "total_return_pct": ret,
        "mdd_pct": mdd,
        "trades": trades,
        "win_rate_pct": 0.0,
    }
    result = {
        "dataset_id": spec.dataset_id,
        "data_version": spec.data_version,
        "bars": len(closes),
        "candidate_params": {
            "fast_ma": fast,
            "slow_ma": slow,
            "buy_pct": buy_pct,
            "stop_loss_pct": stop,
            "strategy_kind": cand.get("strategy_kind") or "ma-cross",
            "candidate_id": cand.get("candidate_id") or f"ma-{fast}-{slow}",
        },
        "validation": validation,
        "metrics": metrics,
        "best_candidate": {
            "candidate_id": cand.get("candidate_id") or f"ma-{fast}-{slow}",
            "strategy_kind": cand.get("strategy_kind") or "ma-cross",
            "fast_ma": fast,
            "slow_ma": slow,
            "buy_pct": buy_pct,
            "stop_loss_pct": stop,
            "data_version": spec.data_version,
        },
        "role": "python_candidate_search",
        "ats_execution_truth": "BacktestRunner + BacktestExecutionModel",
        "auto_apply_to_strategy_config": False,
    }
    return {"metrics": metrics, "result": result}


def loop(
    store: JobStore,
    worker_id: str,
    poll_ms: int,
    max_jobs: Optional[int],
    crash_after_claim: bool,
    delay_ms: int = 0,
) -> int:
    stop = {"flag": False}

    def _stop(*_a):
        stop["flag"] = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    done = 0
    LOG.info(
        json.dumps(
            {
                "backtest_worker": True,
                "worker_id": worker_id,
                "poll_ms": poll_ms,
                "store": str(store.root),
                "max_concurrency": DEFAULT_CONCURRENCY,
            }
        )
    )
    while not stop["flag"]:
        store.reclaim_expired_leases()
        job = store.claim_next(worker_id)
        if job is None:
            time.sleep(poll_ms / 1000.0)
            continue
        job_id = job["job_id"]
        gen = int(job["lease_generation"])
        LOG.info("claimed job_id=%s generation=%s attempt=%s", job_id, gen, job.get("attempt"))
        if crash_after_claim:
            LOG.error("CRASH_AFTER_CLAIM job_id=%s", job_id)
            os._exit(99)
        try:
            store.heartbeat(job_id, worker_id, gen)
            if delay_ms > 0:
                LOG.info("delay_ms=%s job_id=%s", delay_ms, job_id)
                time.sleep(delay_ms / 1000.0)
            out = run_job(job)
            store.complete(
                job_id,
                metrics=out["metrics"],
                result=out["result"],
                worker_id=worker_id,
                lease_generation=gen,
            )
            LOG.info("succeeded job_id=%s", job_id)
        except StaleLeaseError as exc:
            LOG.warning("stale_lease job_id=%s err=%s", job_id, exc)
        except Exception as exc:  # noqa: BLE001
            try:
                store.complete(
                    job_id,
                    error=str(exc),
                    worker_id=worker_id,
                    lease_generation=gen,
                )
            except StaleLeaseError as stale:
                LOG.warning("stale_on_fail job_id=%s err=%s", job_id, stale)
            LOG.exception("failed job_id=%s", job_id)
        done += 1
        if max_jobs is not None and done >= max_jobs:
            break
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="extensions backtest worker")
    parser.add_argument(
        "--store",
        default=str(Path(__file__).resolve().parents[2] / ".bus" / "jobs"),
    )
    parser.add_argument("--worker-id", default="")
    parser.add_argument("--poll-ms", type=int, default=DEFAULT_POLL_MS)
    parser.add_argument("--lease-ms", type=int, default=30_000)
    parser.add_argument("--queue-cap", type=int, default=32)
    parser.add_argument("--max-jobs", type=int, default=0, help="0 = run forever")
    parser.add_argument(
        "--crash-after-claim",
        action="store_true",
        help="Test hook: exit 99 immediately after claiming a job",
    )
    parser.add_argument(
        "--delay-ms",
        type=int,
        default=0,
        help="Test hook: sleep after claim before compute (overlap windows)",
    )
    args = parser.parse_args(argv)
    worker_id = args.worker_id or f"worker-{uuid.uuid4().hex[:8]}"
    store_root = Path(args.store)
    # Do not wipe datasets/tmp — the gRPC server owns live upload sessions.
    datasets.configure_catalog(store_root, purge_temps="none")
    store = JobStore(store_root, queue_cap=args.queue_cap, lease_ms=args.lease_ms)
    max_jobs = args.max_jobs if args.max_jobs > 0 else None
    return loop(
        store,
        worker_id,
        args.poll_ms,
        max_jobs,
        args.crash_after_claim,
        delay_ms=args.delay_ms,
    )


if __name__ == "__main__":
    sys.exit(main())
