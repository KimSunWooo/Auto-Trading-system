# Worker persist · readiness · ratio allocation

## Scope

Domestic PAPER, single-server. autoTrading stays OFF for live observation.
JSON is not the trading-ledger source of truth when `PERSISTENCE_MODE=database`.

## Persist stall (8f76b69 baseline) — classification

**Structural defects in code** (confirmed by review): unbounded/weak TX cleanup,
full projection every tick, overlapping interval ticks, bootstrap-lock readiness,
coalesce overwrite of durable Intent snapshots, global generation across accounts,
rule-config cache ignoring mtime.

**Live DB wait stage** for a specific hang was **not re-observed** without
credentials/DATABASE_URL. Do not equate structural defects with a measured RDS wait.

`lastEngineAt` null ≠ persist failure (mapping gap possible after successful write).

## Fixes

| Area | Change |
|------|--------|
| `src/db/ledger-tx.ts` | Acquire/TX timeouts; **per-account** generation; typed errors |
| `src/db/mysql-ledger.ts` | Bounded acquire; timeout/stale **destroy**; commit-begun timeout → uncertain |
| `src/db/projector.ts` | `projectMode=tick`; account rules from context; `lastEngineAt`; OFF pin |
| `src/runtime/trading-state-store.ts` | **Durable FIFO** vs coalesce-latest; order/config = full durable |
| `src/runtime/rule-config-store.ts` | Reload on file mtime (worker sees API OFF/ratio) |
| `lib/account-engine-loop.ts` | Per-account in-flight gate + lock heartbeat during long persist |
| `app/api/health/ready/route.ts` | Account progress + RDS; dead PID = stale; no KIS/tick |

## Ratio allocation

- **allocationPct**: share of *distributable* PAPER **orderable cash** (`ord_psbl_cash`).
- **buyPct**: share of *that strategy’s buyable cash* for one signal (unchanged meaning).
- **sliceKrw**: optional KRW cap after buyPct.
- Shared math: `src/rules/allocation-ratio.ts` (UI preview, API, RuleRunner).
- Legacy fixed `budget` kept as `budgetMode: legacy_fixed`; convert via strategy-config PATCH `action=convert_legacy_to_ratio` (does not toggle autoTrading).
- AllocationEngine.patch/rebalance: no cash mint, no `positions: []`.

## Config source of truth

Account path: `data/accounts/<id>/strategy-config.json` via `RuleConfigStore` (mtime-aware).
API: durable DB project (full) first, then strategy file commit + version bump.
On file commit failure after DB success: error (partial state must be reconciled — do not invent ON).

## Observation (constraints)

- Only restart local `:43147` after verified code.
- No real ON / buy / sell / cancel.
- Ready must not trigger ticks.
- Report readiness vs tick/persist timestamps, not heartbeat alone.
- See `docs/VERIFICATION_WORKER_ALLOCATION_REVIEW_2026-10-12.md` for review pass evidence.
