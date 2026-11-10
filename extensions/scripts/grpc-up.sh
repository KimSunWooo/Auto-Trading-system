#!/usr/bin/env bash
# Start TradingAnalysis gRPC server + backtest worker (extensions only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
cd "$REPO"

STORE="${EXT_JOB_STORE:-$ROOT/.bus/jobs}"
BIND="${EXT_GRPC_ADDR:-127.0.0.1:50051}"
mkdir -p "$STORE" "$ROOT/.bus/run"
export PYTHONPATH="$ROOT/python${PYTHONPATH:+:$PYTHONPATH}"

# Ensure stubs exist
if [ ! -f "$ROOT/python/ats_research/generated/trading_analysis_pb2_grpc.py" ]; then
  bash "$ROOT/scripts/gen-proto.sh"
fi

# Fresh store optional
if [ "${EXT_GRPC_FRESH_STORE:-0}" = "1" ]; then
  rm -rf "$STORE"
  mkdir -p "$STORE"
fi

echo "Starting gRPC server on $BIND store=$STORE"
python3 -m ats_research.grpc_server --bind "$BIND" --store "$STORE" \
  >"$ROOT/.bus/run/grpc-server.log" 2>&1 &
echo $! >"$ROOT/.bus/run/grpc-server.pid"

WORKER_ID="${EXT_WORKER_ID:-worker-local-1}"
python3 -m ats_research.backtest_worker --store "$STORE" --worker-id "$WORKER_ID" \
  >"$ROOT/.bus/run/backtest-worker.log" 2>&1 &
echo $! >"$ROOT/.bus/run/backtest-worker.pid"

BROKERS="${EXT_KAFKA_BROKERS:-127.0.0.1:19092}"
if [ "${EXT_OUTBOX_PUBLISHER:-1}" = "1" ]; then
  python3 -m ats_research.outbox_publisher --store "$STORE" --brokers "$BROKERS" \
    >"$ROOT/.bus/run/outbox-publisher.log" 2>&1 &
  echo $! >"$ROOT/.bus/run/outbox-publisher.pid"
fi

# Wait for port
for i in $(seq 1 40); do
  if python3 - <<PY
import socket
host, port = "$BIND".split(":")
s = socket.socket()
s.settimeout(0.3)
try:
    s.connect((host, int(port)))
    print("up")
except Exception:
    raise SystemExit(1)
finally:
    s.close()
PY
  then
    echo "GRPC_UP bind=$BIND store=$STORE"
    exit 0
  fi
  sleep 0.25
done
echo "GRPC_TIMEOUT" >&2
tail -n 40 "$ROOT/.bus/run/grpc-server.log" >&2 || true
exit 1
