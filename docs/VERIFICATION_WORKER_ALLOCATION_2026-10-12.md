# Verification report — worker persist + ratio allocation

Date: 2026-10-12  
Baseline HEAD at start: `8f76b69` (clean, equal to `origin/main`)  
Working tree: local uncommitted fixes preserved (no reset/stash/overwrite; **no commit/push** per task constraints)

## 1. Confirmed persist stall cause

At `8f76b69`, worker ticks could stall after the first successful REST quote refresh because:

1. Full ledger projection competed with nested/overlapping interval ticks on the same `mutateStore` queue.
2. Pool acquire / TX waits lacked hard cleanup that prevents late commit after caller timeout.
3. Ready probes treated bootstrap lock heartbeat as healthy and skipped RDS checks in `database` mode.

`lastEngineAt` null alone was **not** used as proof of persist failure (mapping gap existed separately).

## 2. Fixes applied (files)

| File | Why |
|------|-----|
| `src/db/ledger-tx.ts` | Timeouts, generation gate, typed errors |
| `src/db/mysql-ledger.ts` | Bounded acquire; timeout/stale → destroy (no late commit) |
| `src/db/persist.ts` / `projector.ts` / `rows.ts` / `status.ts` | tick projectMode, lastEngineAt write, OFF pin, account ruleConfig |
| `src/runtime/trading-state-store.ts` | Persist coalesce + progress stages |
| `src/runtime/worker-progress.ts` | Account observation snapshot (not ledger SoT) |
| `lib/account-engine-loop.ts` | Per-account single-flight + lock HB during persist |
| `app/api/health/ready/route.ts` | Account progress + database RDS; no KIS/tick |
| `src/rules/allocation-ratio.ts` | Shared orderable-ratio math |
| `src/accounts/index.ts` | No cash mint; rebalance keeps positions |
| `src/rules/config.ts` / `params.ts` | Sync + budgetMode/allocationPct |
| `app/api/strategy-config/route.ts` / `allocations/route.ts` | Versioned save; ledger then file commit |
| `src/rules/RuleRunner.ts` / `execution-budget.ts` | Shared plan; no force-1-share |
| `components/rule-builder.tsx` / `rules-panel.tsx` | Ratio UI; draft reset only on success |
| `docs/WORKER_PERSIST_AND_ALLOCATION.md` | Recovery / ops notes |

## 3. Allocation invariants verified (unit)

- PATCH budget 50만 on 10만 cash → rejected; no cash inflation
- Rebalance preserves positions + avgPrice
- Orderable 100만→60만 @ 30% → 30만→18만 computed
- Ratio sync does not invent cash / wipe positions
- Allocation pct sum >100% rejected
- null/stale orderable not treated as 0 for buys
- planBuyAmountKrw does not force 1 share

## 4. Automated results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | Pass (pre-existing `LayoutProps` only if present; our paths clean) |
| `npm test` | **642 pass / 0 fail / 21 skip** |
| `npm run build` | (see build log) |

## 5. Live local observe (`:43147`)

**BLOCKED** — no `.env.local` / KIS PAPER credentials / DATABASE_URL in this environment.

Cannot restart 43147 against real PAPER or observe ≥10 ticks / ≥10 minutes on shared RDS without inventing secrets.

When credentials are available:

1. Confirm autoTrading OFF for target PAPER account
2. Restart **only** this project's `:43147`
3. Probe `/api/health/ready` (must not advance ticks)
4. Watch worker-progress stages / lastPersistCompletedAt for ≥10 completed ticks
5. Confirm broker write path not invoked (OFF + observation-only)

## 6. Remaining blockers / not done

- Shared RDS schema changes: none applied (none required for this slice)
- EC2 deploy / restart: not performed
- Live PAPER soak observation: blocked by missing local secrets
- REAL / overseas / AI / Kafka-MSA: out of scope
