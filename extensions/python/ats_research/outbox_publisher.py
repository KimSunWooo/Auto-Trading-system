#!/usr/bin/env python3
"""Publish pending JobStore outbox rows to Kafka *after* broker ACK marking.

Kafka network I/O is intentionally outside the JobStore complete() transaction.
Caps: batch size, publish timeout, retry backoff.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from kafka import KafkaProducer
from kafka.errors import KafkaError

from .job_store import JobStore
from .result_events import BACKTEST_RESULTS_TOPIC

LOG = logging.getLogger("ext.outbox_publisher")

DEFAULT_BATCH = 16
DEFAULT_POLL_MS = 200
DEFAULT_TIMEOUT_MS = 5_000
DEFAULT_MAX_RETRIES = 5
DEFAULT_BACKOFF_MS = 250
DEFAULT_MAX_BACKOFF_MS = 5_000


class OutboxPublisher:
    def __init__(
        self,
        store: JobStore,
        *,
        brokers: List[str],
        topic: str = BACKTEST_RESULTS_TOPIC,
        batch_size: int = DEFAULT_BATCH,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        backoff_ms: int = DEFAULT_BACKOFF_MS,
        max_backoff_ms: int = DEFAULT_MAX_BACKOFF_MS,
        crash_after_ack: bool = False,
    ):
        self.store = store
        self.brokers = brokers
        self.topic = topic
        self.batch_size = max(1, min(batch_size, 64))
        self.timeout_ms = timeout_ms
        self.max_retries = max_retries
        self.backoff_ms = backoff_ms
        self.max_backoff_ms = max_backoff_ms
        self.crash_after_ack = crash_after_ack
        self._producer: Optional[KafkaProducer] = None

    def connect(self) -> None:
        self._producer = KafkaProducer(
            bootstrap_servers=self.brokers,
            acks="all",
            retries=0,  # we retry at outbox level
            request_timeout_ms=self.timeout_ms,
            max_block_ms=self.timeout_ms,
            linger_ms=5,
            value_serializer=lambda v: json.dumps(v, separators=(",", ":")).encode("utf-8"),
            key_serializer=lambda v: v.encode("utf-8") if v is not None else None,
            client_id="ext-outbox-publisher",
        )

    def close(self) -> None:
        if self._producer is not None:
            try:
                self._producer.flush(timeout=self.timeout_ms / 1000.0)
            except Exception:  # noqa: BLE001
                pass
            self._producer.close()
            self._producer = None

    def publish_once(self) -> Dict[str, Any]:
        stats = self.store.outbox_stats()
        pending = self.store.list_pending_outbox()[: self.batch_size]
        published = 0
        errors = 0
        if not pending:
            return {"published": 0, "errors": 0, **stats}

        if self._producer is None:
            self.connect()
        assert self._producer is not None

        for row in pending:
            outbox_id = row["outbox_id"]
            event = row["event"]
            attempt = 0
            last_err = ""
            while attempt < self.max_retries:
                attempt += 1
                self.store.record_outbox_publish_attempt(outbox_id)
                try:
                    future = self._producer.send(
                        self.topic,
                        key=event["partitionKey"],
                        value=event,
                        headers=[
                            ("eventId", event["eventId"].encode("utf-8")),
                            ("jobId", event["jobId"].encode("utf-8")),
                            ("schemaVersion", event["schemaVersion"].encode("utf-8")),
                        ],
                    )
                    meta = future.get(timeout=self.timeout_ms / 1000.0)
                    # Broker ACK received — crash hook BEFORE marking published.
                    if self.crash_after_ack:
                        LOG.error(
                            "CRASH_AFTER_ACK outbox_id=%s event_id=%s offset=%s",
                            outbox_id,
                            event["eventId"],
                            meta.offset,
                        )
                        os._exit(97)
                    self.store.mark_outbox_published(
                        outbox_id,
                        kafka_topic=meta.topic,
                        kafka_partition=meta.partition,
                        kafka_offset=meta.offset,
                    )
                    published += 1
                    last_err = ""
                    break
                except Exception as exc:  # noqa: BLE001
                    last_err = str(exc)
                    LOG.warning(
                        "publish_fail outbox_id=%s attempt=%s err=%s",
                        outbox_id,
                        attempt,
                        last_err,
                    )
                    delay = min(self.max_backoff_ms, self.backoff_ms * (2 ** (attempt - 1)))
                    time.sleep(delay / 1000.0)
            if last_err:
                self.store.record_outbox_publish_attempt(outbox_id, error=last_err)
                errors += 1

        return {"published": published, "errors": errors, **self.store.outbox_stats()}

    def loop(self, poll_ms: int, max_cycles: Optional[int] = None) -> int:
        stop = {"flag": False}

        def _stop(*_a):
            stop["flag"] = True

        signal.signal(signal.SIGINT, _stop)
        signal.signal(signal.SIGTERM, _stop)
        self.connect()
        LOG.info(
            json.dumps(
                {
                    "outbox_publisher": True,
                    "brokers": self.brokers,
                    "topic": self.topic,
                    "batch_size": self.batch_size,
                    "timeout_ms": self.timeout_ms,
                    "max_retries": self.max_retries,
                    "store": str(self.store.root),
                }
            )
        )
        cycles = 0
        while not stop["flag"]:
            result = self.publish_once()
            if result["published"] or result["errors"] or result["pending_count"]:
                LOG.info("publish_cycle %s", json.dumps(result))
            cycles += 1
            if max_cycles is not None and cycles >= max_cycles:
                break
            time.sleep(poll_ms / 1000.0)
        self.close()
        return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="extensions outbox → Kafka publisher")
    parser.add_argument(
        "--store",
        default=str(Path(__file__).resolve().parents[2] / ".bus" / "jobs"),
    )
    parser.add_argument("--brokers", default=os.environ.get("EXT_KAFKA_BROKERS", "127.0.0.1:19092"))
    parser.add_argument("--topic", default=BACKTEST_RESULTS_TOPIC)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    parser.add_argument("--poll-ms", type=int, default=DEFAULT_POLL_MS)
    parser.add_argument("--max-cycles", type=int, default=0, help="0 = forever")
    parser.add_argument(
        "--crash-after-ack",
        action="store_true",
        help="Test hook: exit 97 after broker ACK before mark_outbox_published",
    )
    args = parser.parse_args(argv)
    store = JobStore(Path(args.store))
    pub = OutboxPublisher(
        store,
        brokers=[b.strip() for b in args.brokers.split(",") if b.strip()],
        topic=args.topic,
        batch_size=args.batch_size,
        timeout_ms=args.timeout_ms,
        max_retries=args.max_retries,
        crash_after_ack=args.crash_after_ack,
    )
    max_cycles = args.max_cycles if args.max_cycles > 0 else None
    try:
        return pub.loop(args.poll_ms, max_cycles=max_cycles)
    finally:
        pub.close()


if __name__ == "__main__":
    sys.exit(main())
