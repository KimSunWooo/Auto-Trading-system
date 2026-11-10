# Market streaming & research extensions (default OFF)

Isolated from the Next.js KIS PAPER trading core. **No** Kafka/Redis/Python/gRPC dependencies are added to the root app. Research processes never receive order credentials or ledger write access.

## Quick start (fixture / local bus)

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

## Layout

| Path | Role |
|------|------|
| `ts/ingest` | Bounded queue + fixture producer → `ticker-quotes` |
| `ts/redis` | UI-only latest quote + 10m OHLCV (memory/file; Redis-shaped) |
| `ts/ai` | Agent fixture validation via core contract |
| `ts/compare` | OFF/ON/fault comparison harness |
| `python/ats_research` | Risk consumer + MA optimizer + job store |
| `proto/trading_analysis.proto` | SubmitBacktest / GetBacktestJob / UploadBars |
| `docs/ARCHITECTURE.md` | Mermaid flows, caps, failure table |

## Safety invariants

- Trading core worker lock, tick, OrderManager, DB ledger: untouched
- Extension default OFF; separate processes
- `orderEligible=false`, `autoOrderEnabled=false` for all v1 AI fixtures
- REAL remains locked; PAPER fixtures only for initial verification
