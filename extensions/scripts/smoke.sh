#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "== ingest fixture =="
npx tsx extensions/ts/ingest/cli.ts --source fixture --once

echo "== redis/ui aggregate =="
npx tsx extensions/ts/redis/cli.ts

echo "== python risk consumer =="
python3 extensions/python/ats_research/consumer.py \
  --bus-file extensions/.bus/ticker-quotes.jsonl \
  --out extensions/.bus/risk-signals.jsonl

echo "== python optimizer =="
python3 extensions/python/ats_research/optimizer.py

echo "== job store demo =="
PYTHONPATH=extensions/python python3 -m ats_research.job_store

echo "== AI fixture validate =="
npx tsx extensions/ts/ai/validate-fixtures.ts

echo "== OFF/ON/fault compare =="
npx tsx extensions/ts/compare/harness.ts

echo "== unit tests =="
npx tsx --test --test-concurrency=1 extensions/ts/ingest/producer.test.ts

echo "SMOKE_OK"
