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

## Layout

| Path | Role |
|------|------|
| `ts/ingest` | Bounded queue + fixture producer → `ticker-quotes` |
| `ts/redis` | UI-only latest quote + 10m OHLCV (memory/file; Redis-shaped) |
| `ts/adapters` | Real Kafka (Redpanda) + Redis adapters + integration tests |
| `ts/ai` | Agent fixture validation via core contract |
| `ts/compare` | OFF/ON/fault harness + FakeBroker core regression |
| `python/ats_research` | Risk consumer + MA optimizer + job store |
| `proto/trading_analysis.proto` | SubmitBacktest / GetBacktestJob / UploadBars |
| `docker-compose.yml` | Local Redpanda + Redis for extensions only |
| `docs/ARCHITECTURE.md` | Mermaid flows, caps, failure table |

## Safety invariants

- Trading core worker lock, tick, OrderManager, DB ledger: untouched
- Extension default OFF; separate processes
- `orderEligible=false`, `autoOrderEnabled=false` for all v1 AI fixtures
- REAL remains locked; PAPER fixtures only for initial verification
