#!/usr/bin/env python3
"""TradingAnalysis gRPC server (SubmitBacktest / GetBacktestJob / UploadBars).

Durable jobs land in JobStore. Computation runs in a *separate* worker process.
Completion writes an outbox row; `outbox_publisher` (kafka-python-ng) emits Kafka
`backtest-results`. UploadBars streams into temp storage then registers catalog.
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
from .upload_session import UploadError, UploadManager

# Generated stubs (run extensions/scripts/gen-proto.sh)
from .generated import trading_analysis_pb2 as pb2
from .generated import trading_analysis_pb2_grpc as pb2_grpc

LOG = logging.getLogger("ext.grpc_server")

DEFAULT_BIND = "127.0.0.1:50051"
DEFAULT_MAX_WORKERS = 4  # gRPC thread pool (not backtest concurrency)
DEFAULT_QUEUE_CAP = 32


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


def _abort_upload(context, err: UploadError) -> None:
    mapping = {
        "invalid_argument": grpc.StatusCode.INVALID_ARGUMENT,
        "resource_exhausted": grpc.StatusCode.RESOURCE_EXHAUSTED,
        "failed_precondition": grpc.StatusCode.FAILED_PRECONDITION,
        "deadline_exceeded": grpc.StatusCode.DEADLINE_EXCEEDED,
        "cancelled": grpc.StatusCode.CANCELLED,
    }
    context.abort(mapping.get(err.code, grpc.StatusCode.INTERNAL), f"{err.code}:{err.message}")


class TradingAnalysisServicer(pb2_grpc.TradingAnalysisServicer):
    def __init__(
        self,
        store: JobStore,
        uploads: UploadManager,
        submit_delay_ms: int = 0,
        upload_recv_delay_ms: int = 0,
    ):
        self.store = store
        self.uploads = uploads
        self.submit_delay_ms = max(0, int(submit_delay_ms))
        self.upload_recv_delay_ms = max(0, int(upload_recv_delay_ms))

    def SubmitBacktest(self, request, context):  # noqa: N802
        dataset_id = (request.dataset_id or "").strip()
        if not dataset_id:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "dataset_id required")
        try:
            datasets.get_catalog().get(dataset_id)
        except KeyError as exc:
            context.abort(grpc.StatusCode.NOT_FOUND, str(exc))
        if not (request.idempotency_key or "").strip():
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "idempotency_key required")

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
        session = None
        try:
            session = self.uploads.begin()
        except UploadError as exc:
            _abort_upload(context, exc)

        assert session is not None
        saw_eof = False
        try:
            for req in request_iterator:
                if not context.is_active():
                    raise UploadError("cancelled", "client_cancelled")
                deadline = int(req.client_deadline_unix_ms or 0)
                if deadline and int(time.time() * 1000) > deadline:
                    raise UploadError("deadline_exceeded", "client_deadline_unix_ms")

                if self.upload_recv_delay_ms > 0:
                    time.sleep(self.upload_recv_delay_ms / 1000.0)

                bars = [
                    {
                        "t_ms": int(b.t_ms),
                        "ticker": b.ticker,
                        "open": float(b.open),
                        "high": float(b.high),
                        "low": float(b.low),
                        "close": float(b.close),
                        "volume": float(b.volume),
                        "incomplete": bool(b.incomplete),
                    }
                    for b in req.bars
                ]
                wire_bytes = req.ByteSize()
                self.uploads.append_chunk(
                    session,
                    bars=bars,
                    ticker=(req.ticker or "").strip(),
                    interval=(req.interval or "").strip(),
                    client_dataset_id=(req.dataset_id or "").strip(),
                    wire_bytes=wire_bytes,
                    eof=bool(req.eof),
                )
                if req.eof:
                    saw_eof = True
                    break

            if not saw_eof:
                raise UploadError("invalid_argument", "eof_required")

            # Crash hook: after all chunks validated to temp, before catalog register.
            if os.environ.get("EXT_UPLOAD_CRASH_BEFORE_REGISTER") == "1":
                LOG.error("CRASH_BEFORE_REGISTER session=%s", session.session_id)
                os._exit(96)

            bytes_received = session.bytes_received
            spec, deduped = self.uploads.finalize(session)
            # Temp removed after successful register (or on dedupe).
            self.uploads.release(session, keep_temp=False)
            session = None
            LOG.info(
                "upload_ok dataset_id=%s version=%s bars=%s deduped=%s",
                spec.dataset_id,
                spec.data_version,
                spec.bars,
                deduped,
            )
            return pb2.UploadBarsResponse(
                dataset_id=spec.dataset_id,
                accepted_bars=spec.bars,
                bytes_received=bytes_received,
                data_version=spec.data_version,
                content_hash=spec.content_hash,
                row_count=spec.bars,
                start_t_ms=spec.start_t_ms,
                end_t_ms=spec.end_t_ms,
                deduped=deduped,
            )
        except UploadError as exc:
            self.uploads.release(session, keep_temp=False)
            _abort_upload(context, exc)
        except Exception:
            self.uploads.release(session, keep_temp=False)
            raise
        finally:
            if session is not None:
                # Ensure partial data never remains as an active catalog entry.
                self.uploads.release(session, keep_temp=False)


def serve(
    bind: str,
    store_root: Path,
    queue_cap: int,
    submit_delay_ms: int = 0,
    upload_recv_delay_ms: int = 0,
) -> None:
    store = JobStore(store_root, queue_cap=queue_cap)
    # Force-purge orphan temps from prior process death; workers must not do this
    # while a live server may be mid-upload into the same store.
    catalog = datasets.configure_catalog(store_root, purge_temps="force")
    uploads = UploadManager(catalog)
    # gRPC message size aligned with upload chunk cap (+ margin).
    max_msg = max(4 * 1024 * 1024, int(os.environ.get("EXT_UPLOAD_MAX_CHUNK_WIRE_BYTES", 512 * 1024)) * 2)
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=DEFAULT_MAX_WORKERS),
        options=[
            ("grpc.max_receive_message_length", max_msg),
            ("grpc.max_send_message_length", max_msg),
        ],
    )
    pb2_grpc.add_TradingAnalysisServicer_to_server(
        TradingAnalysisServicer(
            store,
            uploads,
            submit_delay_ms=submit_delay_ms,
            upload_recv_delay_ms=upload_recv_delay_ms,
        ),
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
                "upload_bars": "streaming_temp_then_register",
                "kafka_result_notify": "outbox_publisher(kafka-python-ng)",
                "submit_delay_ms": submit_delay_ms,
                "upload_recv_delay_ms": upload_recv_delay_ms,
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
    # Restart cleanup: drop orphan temps so they never become job inputs.
    removed = catalog.purge_stale_temps(force=True)
    LOG.info("grpc_server_stopped purged_temps=%s", removed)


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
    parser.add_argument(
        "--upload-recv-delay-ms",
        type=int,
        default=int(os.environ.get("EXT_UPLOAD_RECV_DELAY_MS") or 0),
        help="Test hook: sleep per received UploadBars chunk (backpressure/deadline)",
    )
    args = parser.parse_args(argv)
    serve(
        args.bind,
        Path(args.store),
        args.queue_cap,
        submit_delay_ms=args.submit_delay_ms,
        upload_recv_delay_ms=args.upload_recv_delay_ms,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
