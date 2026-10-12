# Review verification — worker persist / readiness / ratio allocation

Date: 2026-10-12 (review pass)  
Baseline HEAD: `8f76b69` = `origin/main`  
Dirty/untracked preserved; **no commit/push**; stash empty  
43147: not running · no `.env.local` · no process/env secrets · no linked Cursor environment · no `.env.ec2`

## Cause classification (revised)

| Class | Finding |
|-------|---------|
| **Structural defects confirmed in code** | (1) Full tick projection + overlapping interval ticks without single-flight. (2) Unbounded/weak TX cleanup before destroy-on-timeout. (3) Ready used bootstrap lock + skipped RDS in `database` mode. (4) **Coalesce overwrite** could report success after flushing a *different* snapshot than the durable Intent caller queued. (5) **Global persist generation** let account A invalidate account B. (6) **Rule-config cache** ignored mtime across worker vs route. |
| **Actual DB wait stage for a live hang** | **Not re-observed** in this environment (no credentials / DATABASE_URL / running worker). Prior “confirmed root cause” wording overstated live DB diagnosis. |
| **Hypothesis** | First-tick hang was likely persist occupying `mutateStore` under full projection + overlap; not proven with runId/tickId against live RDS here. |
| **last_engine_at null** | Mapping gap can leave null after successful persist — **not** proof of persist failure. |

## Fixes added in this review pass

1. **Durable vs coalesce queues** — `persistStateNow` / config APIs use durable FIFO + `projectMode=full`; ticks coalesce latest only. Intent caller no longer succeeds because a different tick snapshot flushed.
2. **Per-account persist generation** — scopes by `brokerAccountId`.
3. **Commit-uncertain** — timeout after commit began → `LedgerCommitUncertainError` + degraded status (blocks new orders); no success claim / blind retry.
4. **Rule-config mtime reload** — worker sees API OFF/ratio file updates.
5. **Ready** — dead PID observation marked stale; not healthy via heartbeat alone.

## Tick `projectMode` omission list

| Skipped on tick | Still written on tick |
|-----------------|------------------------|
| upsertUser, credentialRef | referenced instruments |
| upsertTradingRule | allocations, conditions, DCA |
| upsertRiskLimits | trading_account_state (OFF pin), intents, orders, executions, positions, cash/account snapshots, recon |

Config / order paths now use **full** durable projection. Rules file remains account SoT (`data/accounts/<id>/strategy-config.json`); DB rules updated on full/durable saves.

## Tests / build (this pass)

| Check | Result |
|-------|--------|
| Focused coalesce/generation/mtime/allocation | pass |
| `npx tsc --noEmit` | pass (no project errors) |
| `npm test` | **645 pass / 0 fail / 21 skip** |
| `npm run build` | pass |

### Skip inventory (21) — impact on this review

Primarily opt-in live KIS VTS / ownership / overseas probes. **Not activated** (no order tests). They do not validate local persist coalesce or readiness. Examples:

- `RUN_KIS_VTS_TESTS` / credentials missing → VTS-00x lifecycle skipped
- `RUN_KIS_VTS_ORDER_TESTS` / flatten opt-in off → order/flatten skipped
- `RUN_KIS_VTS_OVERSEAS_TESTS` → OVTS skipped
- paper physical ownership live DB checks skipped without live flag

MemoryLedger timeout tests prove **in-memory** late-commit fencing, **not** real MySQL lock/rollback semantics.

## Live observe (`:43147`)

**BLOCKED** — required env not present after checking:

- `.env.local` absent
- process environ: no `DATABASE_URL` / `KIS_*`
- no linked cloud environment
- docker-compose expects `.env.ec2` (not present); example only

Minimal names needed (values not requested): `DATABASE_URL`, `PERSISTENCE_MODE=database`, `PAPER_RUNTIME_OWNER=accounts`, `KIS_MODE=paper`, `ALLOW_LIVE_TRADING=false`, `BROKER_CREDENTIAL_MASTER_KEY`, user PAPER credentials in DB (or bootstrap `KIS_PAPER_*` for operator path).

Then: restart **only** this project's 43147 → confirm autoTrading OFF → observe readiness without `/api/state` → ≥10 min / ≥10 ticks with advancing `lastPersistCompletedAt` / tickId → broker write 0.

## Completion verdict

| Gate | Status |
|------|--------|
| Isolation / unit / full npm test + build | **PASS** |
| Live continuous DB save + readiness agreement | **NOT DONE** (env blocker) |

Do not treat isolation pass as operational verification.
