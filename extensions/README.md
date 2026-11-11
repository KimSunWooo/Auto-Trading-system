# Market streaming & research extensions (default OFF)

Isolated from the Next.js KIS PAPER trading core. **No** Kafka/Redis/Python/gRPC dependencies are added to the root app. Research processes never receive order credentials or ledger write access.

## Quick start (fixture / local JSONL bus)

```bash
# From repo root — uses workspace tsx + existing H0STCNT0 parser
npx tsx extensions/ts/ingest/cli.ts --source fixture --once
npx tsx extensions/ts/redis/cli.ts
python3 extensions/python/ats_research/consumer.py \
  --bus-file extensions/.bus/ticker-quotes.jsonl \
  --out extensions/.bus/risk-signals.jsonl
python3 extensions/python/ats_research/optimizer.py
python3 extensions/python/ats_research/job_store.py
npx tsx extensions/ts/ai/validate-fixtures.ts
npx tsx extensions/ts/compare/harness.ts
npx tsx --test extensions/ts/ingest/producer.test.ts
```

Or: `bash extensions/scripts/smoke.sh`

## AI Agent HTTP observation (local)

Start the [AI Agent](https://github.com/KimSunWooo/Auto_Trading_AI_Agent) from its own checkout with its Python dependencies installed. Generate one fixture decision and leave the Agent running, since its fixture journal lives in memory.

```bash
# AI Agent terminal
NO_NETWORK=1 AI_DATA_MODE=FIXTURE PYTHONPATH=src python3 -m uvicorn \
  ai_investment_agent.api.app:app --host 127.0.0.1 --port 43187

# Another terminal, from the ATS repo root after npm ci
curl -fsS http://127.0.0.1:43187/analysis/evaluate \
  -H 'Content-Type: application/json' -d '{"ticker":"005930"}'

AI_AGENT_BASE_URL=http://127.0.0.1:43187 npx tsx extensions/ts/ai/observe.cli.ts \
  --fixture-now 2026-09-21T09:00:00Z
```

Repeat the pull against the same decision to see `stored: 0` and `duplicates: 1`. The one-shot CLI checks the 20 most recent decisions and writes observations under `extensions/.bus/ai-proposals/` by default, or to a directory supplied via `--out`. `HOLD` and `NO_TRADE` are stored as observations. `--fixture-now` applies only to `FIXTURE` envelopes. The CLI reports HTTP/contract failures and exits nonzero. It runs separately from the trading Worker and stores `orderEligible: false` and `autoOrderEnabled: false`.

```bash
MIRAEMAESU_TEST=1 npx tsx --test extensions/ts/ai/observe.test.ts
```

Live WS ingest is **refused** until shared AppKey hub subscription impact (limit 41) is measured (`--source live-ws` exits 2).

## Real local Kafka + Redis (explicit ON)

Adapters live under `extensions/ts/adapters/`. They refuse to run unless `EXTENSIONS_REAL_INFRA=1` (no silent file fallback).

```bash
# Start / stop (Redpanda :19092, Redis :16379)
bash extensions/scripts/infra-up.sh
bash extensions/scripts/infra-down.sh

# One-shot fixture → Kafka → Redis pipeline
cd extensions && npm install
EXTENSIONS_REAL_INFRA=1 npx tsx ts/adapters/real-pipeline.cli.ts

# Integration tests (dup / reorder / crash-before-commit / saturation / Kafka down)
EXTENSIONS_REAL_INFRA=1 npx tsx --test --test-concurrency=1 \
  extensions/ts/adapters/kafka-redis.integration.test.ts

# Trading-core regression (FakeBroker Worker path vs harness)
MIRAEMAESU_TEST=1 npx tsx --test --test-concurrency=1 \
  extensions/ts/compare/core-regression.test.ts
```

### Dedup / offset commit contract

| Item | Value |
|------|-------|
| Dedupe key | Redis `SADD ext:dedupe:{symbol}` of TRADE `eventId` |
| Dedupe TTL | **24h** (`DEDUPE_TTL_SEC`) — covers Kafka reprocess window |
| Atomicity | Lua: SISMEMBER + latest + minute OHLCV in one `EVAL` |
| Offset commit | Only **after** Redis apply succeeds |
| Crash after Redis / before commit | Redelivery hits dedupe → volume not double-counted |
| OHLCV window | Last **10 minutes**, one bar per minute start |
| PAPER orderbook | Detector stays **disabled / unverified** (TRADE-only) |

## Real local gRPC backtest (TypeScript → Python)

Pinned tools: `extensions/python/requirements-grpc.txt`  
`grpcio==1.68.1`, `grpcio-tools==1.68.1`, `protobuf==5.29.3`  
TS client: `@grpc/grpc-js@1.12.6`, `@grpc/proto-loader@0.7.13`

```bash
# Stubs (idempotent)
bash extensions/scripts/gen-proto.sh
pip3 install -r extensions/python/requirements-grpc.txt

# Server + separate worker (default 127.0.0.1:50051)
EXT_GRPC_FRESH_STORE=1 bash extensions/scripts/grpc-up.sh
npx tsx extensions/ts/grpc/cli.ts run --dataset synthetic-v0-short --key demo-1
npx tsx extensions/ts/grpc/cli.ts get --job <jobId>
bash extensions/scripts/grpc-down.sh

# Integration + FakeBroker overlap
npx tsx --test --test-concurrency=1 extensions/ts/grpc/grpc.integration.test.ts
MIRAEMAESU_TEST=1 npx tsx --test --test-concurrency=1 \
  extensions/ts/compare/grpc-overlap-regression.test.ts
```

| Rule | Behavior |
|------|----------|
| Dataset input | Catalog IDs only (`synthetic-v0`, `synthetic-v0-short`, `upload-*`) — **no path args** |
| Idempotency | Same key+input → same `jobId`; same key+different input → `ALREADY_EXISTS` |
| Durability | File job store under `extensions/.bus/jobs` |
| Compute | **Separate** `backtest_worker` process (lease + generation) |
| Caps | Queue 32 (tests use 8), RPC deadline ~5s, MA≤500, bars≤5000 |
| Lost submit response | Client retries same key → same `jobId` |
| Worker death mid-run | Lease expires → requeue (or FAIL after max attempts); stale complete rejected |
| Result notify | JobStore outbox → `outbox_publisher` (kafka-python-ng) → Kafka `backtest-results` → TS kafkajs consumer → `GetBacktestJob` |
| UploadBars | Client-stream OHLCV → temp validate → content-hash catalog; identical reupload returns same `upload-{hash12}` |

### Result notify (outbox → Kafka → TS)

```bash
bash extensions/scripts/infra-up.sh
EXT_GRPC_FRESH_STORE=1 bash extensions/scripts/grpc-up.sh   # starts publisher too
# or: PYTHONPATH=extensions/python python3 -m ats_research.outbox_publisher --store extensions/.bus/jobs

EXTENSIONS_REAL_INFRA=1 npx tsx --test --test-concurrency=1 \
  extensions/ts/grpc/notify.integration.test.ts
```

Terminal `SUCCEEDED`/`FAILED` writes an outbox row in the same JobStore transaction (stable `eventId`). Publisher ACKs Kafka then marks published. TS consumer dedupes by `eventId` and commits offsets only after observation write.

### UploadBars (stream → versioned dataset → SubmitBacktest)

```bash
EXT_GRPC_FRESH_STORE=1 bash extensions/scripts/grpc-up.sh
npx tsx extensions/ts/grpc/cli.ts upload \
  --file extensions/fixtures/ohlcv-005930-1d.jsonl --interval 1d --batch 10
npx tsx extensions/ts/grpc/cli.ts upload-run \
  --file extensions/fixtures/ohlcv-005930-1d.jsonl --interval 1d
EXTENSIONS_REAL_INFRA=1 npx tsx --test --test-concurrency=1 \
  extensions/ts/grpc/upload.integration.test.ts
```

| Rule | Behavior |
|------|----------|
| Scope | One ticker + one interval per upload |
| Streaming | Batch validate → temp `datasets/tmp/`; never hold full stream in memory |
| Register | Only after EOF + full validation → `datasets/active/` + `catalog.json` |
| Idempotent | Same normalized bars → same `content_hash` / `datasetId` (`deduped=true`) |
| Failures | Cancel / deadline / bad OHLC / limits → temp deleted; not in catalog |
| Restart | `configure_catalog` force-purges orphan temps (process-local sessions) |
| Caps | `EXT_UPLOAD_MAX_*` (chunk bars/bytes, total bars/bytes, concurrent, TTL) |
| Client backpressure | `EXT_UPLOAD_CLIENT_SEND_BUFFER` (default 3 in-flight writes) |

Python metrics are **candidate search** only. ATS execution truth remains `BacktestRunner`.

## Layout

| Path | Role |
|------|------|
| `ts/ingest` | Bounded queue + fixture producer → `ticker-quotes` |
| `ts/redis` | UI-only latest quote + 10m OHLCV (memory/file; Redis-shaped) |
| `ts/adapters` | Real Kafka (Redpanda) + Redis adapters + integration tests |
| `ts/grpc` | TypeScript TradingAnalysis client + CLI + integration tests |
| `ts/ai` | Agent fixture validation and one-shot HTTP observation |
| `ts/compare` | OFF/ON/fault harness + FakeBroker core / gRPC overlap regression |
| `python/ats_research` | Risk consumer + MA optimizer + job store + gRPC server + worker |
| `proto/trading_analysis.proto` | SubmitBacktest / GetBacktestJob / UploadBars |
| `docker-compose.yml` | Local Redpanda + Redis for extensions only |
| `docs/ARCHITECTURE.md` | Mermaid flows, caps, failure table |

## Safety invariants

- Trading core worker lock, tick, OrderManager, DB ledger: untouched
- Extension default OFF; separate processes
- `orderEligible=false`, `autoOrderEnabled=false` for all v1 AI fixtures
- REAL remains locked; PAPER fixtures only for initial verification
