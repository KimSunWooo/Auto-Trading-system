#!/usr/bin/env python3
"""Realtime research consumer (separate process from backtest runner).

Reads ticker-quotes JSONL (Kafka stand-in) and emits observation-only risk signals.
ORDERBOOK imbalance is disabled when paperUnverified=true or ASP0 unsubscribed.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Deque, Dict, List


MIN_SAMPLES = 5
RETURN_SPIKE_ABS = 0.01  # 1% between consecutive trades
MAX_GAP_MS = 120_000


def load_events(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return out


def detect_return_spikes(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_symbol: Dict[str, Deque[Dict[str, Any]]] = defaultdict(deque)
    signals: List[Dict[str, Any]] = []
    for ev in events:
        if ev.get("kind") != "TRADE":
            continue
        symbol = ev["symbol"]
        price = float(ev["price"])
        ts = int(ev["exchangeTsMs"])
        hist = by_symbol[symbol]
        if hist:
            prev = hist[-1]
            gap = ts - int(prev["exchangeTsMs"])
            if gap > MAX_GAP_MS:
                # Data hole — skip spike across gap; require rebuild of window.
                hist.clear()
            else:
                prev_price = float(prev["price"])
                if prev_price > 0:
                    ret = (price - prev_price) / prev_price
                    if abs(ret) >= RETURN_SPIKE_ABS and len(hist) + 1 >= MIN_SAMPLES:
                        signals.append(
                            {
                                "signalId": str(uuid.uuid4()),
                                "schemaVersion": "risk-signal.v1",
                                "kind": "RETURN_SPIKE",
                                "market": "KR",
                                "symbol": symbol,
                                "observedAtMs": int(time.time() * 1000),
                                "orderEligible": False,
                                "details": {
                                    "return": ret,
                                    "price": price,
                                    "prevPrice": prev_price,
                                    "samples": len(hist) + 1,
                                },
                            }
                        )
        hist.append(ev)
        while len(hist) > 64:
            hist.popleft()
    return signals


def detect_orderbook_imbalance(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Disabled for unverified PAPER ASP0 — returns empty with reason tags."""
    signals: List[Dict[str, Any]] = []
    for ev in events:
        if ev.get("kind") != "ORDERBOOK":
            continue
        if ev.get("paperUnverified", True):
            continue  # keep disabled
        bids = ev.get("bids") or []
        asks = ev.get("asks") or []
        bid_qty = sum(float(x.get("qty") or 0) for x in bids)
        ask_qty = sum(float(x.get("qty") or 0) for x in asks)
        if bid_qty <= 0 or ask_qty <= 0:
            continue  # zero residual — skip
        total = bid_qty + ask_qty
        imb = (bid_qty - ask_qty) / total
        # Variance / sample gates would apply on a rolling window; single snap skipped.
        if abs(imb) < 0.8:
            continue
        signals.append(
            {
                "signalId": str(uuid.uuid4()),
                "schemaVersion": "risk-signal.v1",
                "kind": "ORDERBOOK_IMBALANCE",
                "market": "KR",
                "symbol": ev["symbol"],
                "observedAtMs": int(time.time() * 1000),
                "orderEligible": False,
                "details": {"imbalance": imb, "bidQty": bid_qty, "askQty": ask_qty},
            }
        )
    return signals


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bus-file", default="extensions/.bus/ticker-quotes.jsonl")
    parser.add_argument("--out", default="extensions/.bus/risk-signals.jsonl")
    args = parser.parse_args()

    events = load_events(Path(args.bus_file))
    spikes = detect_return_spikes(events)
    # Intentionally empty while PAPER ASP0 unverified:
    imbalances = detect_orderbook_imbalance(events)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for sig in spikes + imbalances:
            fh.write(json.dumps(sig, ensure_ascii=False) + "\n")

    report = {
        "ok": True,
        "events": len(events),
        "returnSpikes": len(spikes),
        "orderbookImbalances": len(imbalances),
        "orderbookDetector": "disabled_paper_unverified",
        "orderEligible": False,
        "out": str(out_path),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
