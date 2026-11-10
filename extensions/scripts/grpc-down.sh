#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.bus/run"

kill_pidfile() {
  local f="$1"
  if [ -f "$f" ]; then
    local pid
    pid="$(cat "$f" || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.2
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  fi
}

kill_pidfile "$RUN/backtest-worker.pid"
kill_pidfile "$RUN/grpc-server.pid"
# Also sweep orphans bound to default port if leftover
pkill -f 'ats_research.grpc_server' 2>/dev/null || true
pkill -f 'ats_research.backtest_worker' 2>/dev/null || true
echo "GRPC_DOWN"
