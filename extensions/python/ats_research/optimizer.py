#!/usr/bin/env python3
"""Offline MA-cross candidate search (research process).

Assumptions (explicit):
- Fee 0.015% round-trip + 5bp slippage each side (PAPER research defaults).
- buy_pct / stop_loss_pct are ratios (0.10 = 10%).
- Entries fill next bar open; stop uses gap-through (low breaches stop → fill at low).
- Walk-forward folds + held-out tail. Does NOT write ATS strategy config.

Python selects candidates; ATS execution truth remains BacktestRunner /
BacktestExecutionModel (daily candle replay). Gaps vs ATS are reported.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Sequence, Tuple


FEE_RT = 0.00015
SLIP_BP = 0.0005


@dataclass
class Candidate:
    candidate_id: str
    fast_ma: int
    slow_ma: int
    buy_pct: float
    stop_loss_pct: float
    data_version: str
    total_return_pct: float
    mdd_pct: float
    trades: int
    fold: str


def sma(values: Sequence[float], n: int) -> List[float | None]:
    out: List[float | None] = [None] * len(values)
    if n <= 0:
        return out
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= n:
            s -= values[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def simulate(
    closes: Sequence[float],
    opens: Sequence[float],
    lows: Sequence[float],
    fast: int,
    slow: int,
    buy_pct: float,
    stop_pct: float,
) -> Tuple[float, float, int]:
    """Return total_return_pct, mdd_pct, trades on unit cash."""
    if slow <= fast or len(closes) < slow + 2:
        return 0.0, 0.0, 0
    f = sma(closes, fast)
    s = sma(closes, slow)
    cash = 1.0
    qty = 0.0
    entry = 0.0
    equity_peak = 1.0
    mdd = 0.0
    trades = 0

    for i in range(1, len(closes)):
        # signal on close[i-1] → fill open[i]
        if f[i - 1] is None or s[i - 1] is None or f[i - 2] is None or s[i - 2] is None:
            mark = cash + qty * closes[i]
            equity_peak = max(equity_peak, mark)
            mdd = max(mdd, (equity_peak - mark) / equity_peak if equity_peak else 0.0)
            continue
        cross_up = f[i - 2] <= s[i - 2] and f[i - 1] > s[i - 1]
        cross_dn = f[i - 2] >= s[i - 2] and f[i - 1] < s[i - 1]
        px = opens[i] * (1 + SLIP_BP)
        if qty == 0 and cross_up and cash > 0:
            notional = cash * buy_pct
            if notional > 0:
                qty = (notional * (1 - FEE_RT / 2)) / px
                cash -= notional
                entry = px
                trades += 1
        elif qty > 0:
            stop = entry * (1 - stop_pct)
            if lows[i] <= stop:
                fill = min(opens[i], lows[i]) * (1 - SLIP_BP)
                cash += qty * fill * (1 - FEE_RT / 2)
                qty = 0.0
                trades += 1
            elif cross_dn:
                fill = opens[i] * (1 - SLIP_BP)
                cash += qty * fill * (1 - FEE_RT / 2)
                qty = 0.0
                trades += 1
        mark = cash + qty * closes[i]
        equity_peak = max(equity_peak, mark)
        mdd = max(mdd, (equity_peak - mark) / equity_peak if equity_peak else 0.0)

    if qty > 0:
        cash += qty * closes[-1] * (1 - FEE_RT / 2 - SLIP_BP)
        qty = 0.0
    total_return = (cash - 1.0) * 100.0
    return total_return, mdd * 100.0, trades


def walk_forward(
    closes: Sequence[float],
    opens: Sequence[float],
    lows: Sequence[float],
    data_version: str,
) -> List[Candidate]:
    n = len(closes)
    holdout = max(20, n // 5)
    train_end = n - holdout
    folds = [
        ("wf-1", 0, train_end // 2, train_end // 2, train_end),
        ("holdout", 0, train_end, train_end, n),
    ]
    grid = []
    for fast in (3, 5):
        for slow in (10, 20):
            if slow <= fast:
                continue
            for buy_pct in (0.1, 0.25):
                for stop in (0.03, 0.05):
                    grid.append((fast, slow, buy_pct, stop))

    results: List[Candidate] = []
    for fold_name, _a, _b, te0, te1 in folds:
        segment_c = closes[te0:te1]
        segment_o = opens[te0:te1]
        segment_l = lows[te0:te1]
        for fast, slow, buy_pct, stop in grid:
            ret, mdd, trades = simulate(segment_c, segment_o, segment_l, fast, slow, buy_pct, stop)
            results.append(
                Candidate(
                    candidate_id=f"ma-{fast}-{slow}-b{buy_pct}-s{stop}-{fold_name}",
                    fast_ma=fast,
                    slow_ma=slow,
                    buy_pct=buy_pct,
                    stop_loss_pct=stop,
                    data_version=data_version,
                    total_return_pct=ret,
                    mdd_pct=mdd,
                    trades=trades,
                    fold=fold_name,
                )
            )
    results.sort(key=lambda c: (c.fold != "holdout", -c.total_return_pct, c.mdd_pct))
    return results


def synthetic_series(n: int = 120) -> Tuple[List[float], List[float], List[float]]:
    closes = []
    opens = []
    lows = []
    px = 70_000.0
    for i in range(n):
        o = px
        px = px * (1.0 + 0.002 * math.sin(i / 5.0) + (0.001 if i % 17 == 0 else 0.0))
        c = px
        low = min(o, c) * 0.995
        opens.append(o)
        closes.append(c)
        lows.append(low)
    return closes, opens, lows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-version", default="synthetic-v0")
    parser.add_argument("--out", default="extensions/.bus/backtest-candidates.json")
    args = parser.parse_args()

    closes, opens, lows = synthetic_series()
    cands = walk_forward(closes, opens, lows, args.data_version)
    top = cands[:10]
    payload = {
        "ok": True,
        "dataVersion": args.data_version,
        "assumptions": {
            "feeRoundTrip": FEE_RT,
            "slippageEachSide": SLIP_BP,
            "fill": "next_bar_open",
            "stop": "gap_through_low",
            "units": "ratios",
        },
        "atsExecutionTruth": "BacktestRunner + BacktestExecutionModel (daily candles)",
        "gapsVsAts": [
            "Python uses synthetic intraday-like series here; ATS BacktestRunner defaults to generateDailyCandles unless candles[] provided",
            "ATS session rails / OrderManager gates are not simulated in this optimizer",
            "To offline-replay top candidates in ATS: export Candle[] JSON and call BacktestRunner.run({ candles, allocations })",
        ],
        "autoApplyToStrategyConfig": False,
        "candidates": [asdict(c) for c in top],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "candidates": len(top), "out": str(out)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
