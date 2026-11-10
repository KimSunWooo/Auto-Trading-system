#!/usr/bin/env python3
"""TradingAnalysis gRPC server (SubmitBacktest / GetBacktestJob).

Durable jobs land in JobStore. Computation runs in a *separate* worker process
(`backtest_worker.py`). Completion writes an outbox row; a separate publisher
process emits Kafka `backtest-results`. UploadBars remains deferred.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
from concurrent import futures
from pathlib import Path
from typing import Any, Dict

import grpc

from . import datasets
from .job_store import ConflictError, JobStore

# Generated stubs (run extensions/scripts/gen-proto.sh)
from .generated import trading_analysis_pb2 as pb2
from .generated import trading_analysis_pb2_grpc as pb2_grpc

LOG = logging.getLogger("ext.grpc_server")

DEFAULT_BIND = "127.0.0.1:50051"
DEFAULT_MAX_WORKERS = 4  # gRPC thread pool (not backtest concurrency)
DEFAULT_QUEUE_CAP = 32
RPC_DEADLINE_SOFT_MS = 5_000


def _candidate_to_dict(c: pb2.BacktestCandidate) -> Dict[str, Any]:
    return {
        "candidate_id": c.candidate_id,
        "strategy_kind": c.strategy_kind or "ma-cross",
        "fast_ma": int(c.fast_ma),
        "slow_ma": int(c.slow_ma),
        "buy_pct": float(c.buy_pct),
        "stop_loss_pct": float(c.stop_loss_pct),
        "data_version": c.data_version,
    }


def _dict_to_candidate(d: Dict[str, Any] | None) -> pb2.BacktestCandidate:
    d = d or {}
    return pb2.BacktestCandidate(
        candidate_id=str(d.get("candidate_id") or ""),
        strategy_kind=str(d.get("strategy_kind") or "ma-cross"),
        fast_ma=int(d.get("fast_ma") or 0),
        slow_ma=int(d.get("slow_ma") or 0),
        buy_pct=float(d.get("buy_pct") or 0),
        stop_loss_pct=float(d.get("stop_loss_pct") or 0),
        data_version=str(d.get("data_version") or ""),
    )


def _dict_to_metrics(d: Dict[str, Any] | None) -> pb2.BacktestMetrics:
    d = d or {}
    return pb2.BacktestMetrics(
        total_return_pct=float(d.get("total_return_pct") or 0),
        mdd_pct=float(d.get("mdd_pct") or 0),
        trades=int(d.get("trades") or 0),
        win_rate_pct=float(d.get("win_rate_pct") or 0),
    )


class TradingAnalysisServicer(pb2_grpc.TradingAnalysisServicer):
    def __init__(self, store: JobStore, submit_delay_ms: int = 0):
        self.store = store
        self.submit_delay_ms = max(0, int(submit_delay_ms))

    def SubmitBacktest(self, request, context):  # noqa: N802
        dataset_id = (request.dataset_id or "").strip()
        if not dataset_id:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "dataset_id required")
        if dataset_id not in datasets.DATASETS:
            context.abort(
                grpc.StatusCode.NOT_FOUND,
                f"unknown_dataset_id:{dataset_id}; allowed={datasets.list_dataset_ids()}",
            )
        if not (request.idempotency_key or "").strip():
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "idempotency_key required")

        # Soft size / shape guards (no arbitrary paths).
        cand = request.candidate
        if cand.fast_ma < 0 or cand.slow_ma < 0 or cand.slow_ma > 500 or cand.fast_ma > 500:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "ma_out_of_range")
        if cand.buy_pct < 0 or cand.buy_pct > 1 or cand.stop_loss_pct < 0 or cand.stop_loss_pct > 1:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "pct_out_of_range")

        req = {
            "idempotency_key": request.idempotency_key.strip(),
            "dataset_id": dataset_id,
            "candidate": _candidate_to_dict(cand),
            "deadline_unix_ms": int(request.deadline_unix_ms or 0),
            "tags": dict(request.tags),
        }
        try:
            out = self.store.submit(req)
        except ConflictError as exc:
            context.abort(grpc.StatusCode.ALREADY_EXISTS, str(exc))
        except TimeoutError as exc:
            context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, str(exc))
        except RuntimeError as exc:
            if "queue_cap_exceeded" in str(exc):
                context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, str(exc))
            context.abort(grpc.StatusCode.INTERNAL, str(exc))
        except ValueError as exc:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))

        # Test hook: JobStore already committed; delay before first RPC response.
        if self.submit_delay_ms > 0:
            LOG.info(
                "submit_delay_ms=%s job_id=%s (after JobStore commit)",
                self.submit_delay_ms,
                out["job_id"],
            )
            time.sleep(self.submit_delay_ms / 1000.0)

        LOG.info("submit job_id=%s deduped=%s", out["job_id"], out.get("deduped"))
        return pb2.SubmitBacktestResponse(job_id=out["job_id"], status=out["status"])

    def GetBacktestJob(self, request, context):  # noqa: N802
        job_id = (request.job_id or "").strip()
        if not job_id:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "job_id required")
        try:
            job = self.store.get(job_id)
        except KeyError:
            context.abort(grpc.StatusCode.NOT_FOUND, f"unknown_job_id:{job_id}")

        req = job.get("request") or {}
        candidate = req.get("candidate") or {}
        # Prefer completed result candidate enrichment when present.
        result = job.get("result") or {}
        if result.get("best_candidate"):
            candidate = {**candidate, **result["best_candidate"]}

        metrics = job.get("metrics") or {}
        if result.get("metrics"):
            metrics = result["metrics"]

        return pb2.GetBacktestJobResponse(
            job_id=job["job_id"],
            status=job["status"],
            error=job.get("error") or "",
            candidate=_dict_to_candidate(candidate),
            metrics=_dict_to_metrics(metrics),
            result_topic_offset=str(job.get("result_topic_offset") or ""),
            updated_at_unix_ms=int(job.get("updated_at_unix_ms") or 0),
        )

    def UploadBars(self, request_iterator, context):  # noqa: N802
        # Follow-up: streaming upload not in this slice.
        context.abort(
            grpc.StatusCode.UNIMPLEMENTED,
            "UploadBars deferred; use versioned dataset_id from catalog",
        )


def serve(bind: str, store_root: Path, queue_cap: int, submit_delay_ms: int = 0) -> None:
    store = JobStore(store_root, queue_cap=queue_cap)
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=DEFAULT_MAX_WORKERS),
        options=[
            ("grpc.max_receive_message_length", 4 * 1024 * 1024),
            ("grpc.max_send_message_length", 4 * 1024 * 1024),
        ],
    )
    pb2_grpc.add_TradingAnalysisServicer_to_server(
        TradingAnalysisServicer(store, submit_delay_ms=submit_delay_ms),
        server,
    )
    server.add_insecure_port(bind)
    server.start()
    LOG.info(
        json.dumps(
            {
                "grpc_server": True,
                "bind": bind,
                "store": str(store_root),
                "queue_cap": queue_cap,
                "datasets": datasets.list_dataset_ids(),
                "upload_bars": "deferred",
                "kafka_result_notify": "outbox_publisher",
                "submit_delay_ms": submit_delay_ms,
            }
        )
    )

    stop = {"flag": False}

    def _stop(*_args):
        stop["flag"] = True
        server.stop(grace=2)

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    while not stop["flag"]:
        time.sleep(0.2)
    LOG.info("grpc_server_stopped")


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="extensions TradingAnalysis gRPC server")
    parser.add_argument("--bind", default=DEFAULT_BIND)
    parser.add_argument(
        "--store",
        default=str(Path(__file__).resolve().parents[2] / ".bus" / "jobs"),
    )
    parser.add_argument("--queue-cap", type=int, default=DEFAULT_QUEUE_CAP)
    parser.add_argument(
        "--submit-delay-ms",
        type=int,
        default=int(os.environ.get("EXT_SUBMIT_DELAY_MS") or 0),
        help="Test hook: sleep after JobStore commit before SubmitBacktest response",
    )
    args = parser.parse_args(argv)
    serve(args.bind, Path(args.store), args.queue_cap, submit_delay_ms=args.submit_delay_ms)
    return 0


if __name__ == "__main__":
    sys.exit(main())
