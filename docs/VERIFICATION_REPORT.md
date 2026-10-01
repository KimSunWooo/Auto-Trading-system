# Verification report — PAPER account / routing / DB ledger / AI foundation

Date: 2026-10-01 (UTC). Secrets omitted.

## 1. Problems found (root cause)

| Issue | Root cause |
| --- | --- |
| Login redirected to `/mypage` | Hard-coded `window.location.href = "/mypage"` in login page |
| Home forced mypage when disconnected | `AccountNotConnectedError` → `redirect("/mypage")` |
| Decrypt failure looked like generic 500 | `createAccountRuntimeScope` threw raw crypto errors |
| Account worker spam on bad master key | Resolve failed every tick without backoff |
| Trading ledger SOT was JSON+best-effort mirror | `PERSISTENCE_MODE=database` previously unimplemented |
| AI auto-order risk before 1–5 ready | Needed explicit disabled consumer + budget helpers |

## 2. Changed files (why)

- `app/login/page.tsx` — post-auth → `/`
- `app/page.tsx` — disconnected dashboard; kick non-blocking sync
- `components/disconnected-dashboard.tsx` — authenticated empty state + mypage CTA
- `src/runtime/account-connection-types.ts` + `resolve-trading-runtime.ts` — credential/selection issue codes
- `lib/account-engine-loop.ts` — `kickAccountStartupSync` + credential backoff
- `src/db/config.ts`, `persist.ts`, `reconstitute-state.ts`, `mirror.ts`, `status.ts`, ledger list APIs — DB-first ledger
- `src/runtime/trading-state-store.ts` — DB authority save/load path
- `src/brokers/KisBroker.ts` — pre-submit DB fail = 0 orders; post-submit DB fail = UNKNOWN no resubmit
- `src/ai/*`, `app/api/admin/ai/route.ts`, `docs/AI_CONTRACT.md`, `docs/DATABASE_ARCHITECTURE.md`, `.env.example`

User change preserved: `src/db/config.ts` no longer falls back to `DATABASE_PASSOWORD` for passwords.

## 3. Login routing + account refresh

- Login/register success → `/` (verified in code).
- Unauthenticated `/` → `/login`.
- Disconnected authenticated user stays on `/` with status + 계좌 설정 CTA (no mypage force redirect).
- Connected path calls `kickAccountStartupSync` without awaiting KIS on the login request.

## 4. User ↔ PAPER account binding

- Still uses `selectOwnedPaperAccount` (no arbitrary ACTIVE pick; no bootstrap fallback).
- Decrypt/master-key failures → `CREDENTIAL_DECRYPT_FAILED` / `CREDENTIAL_MISSING` UI, not “connected”.
- **Ops blocker in this environment:** account worker resolve fails with AES-GCM auth error for existing ciphertext (master key mismatch vs RDS payload). Rebind CLI exists (`npm run credentials:rebind-paper`) but APPLY not run (operator confirm required).

## 5. PAPER block conditions

- Kept: single-account worker lock, intent idempotency, fingerprint, startup sync, UNKNOWN, quote freshness, REAL lock.
- Removed needless UX block: mypage redirect that prevented seeing dashboard while connecting.
- Operational PAPER still has **no** daily order-count cap (`PAPER_ORDER_POLICY.maxBrokerSubmitsPerDay=null`).
- `PAPER_RUNTIME_OWNER=accounts` in `.env.local` / `.env.example` (restart required to change owner).

## 6. JSON → DB scope

- Implemented `PERSISTENCE_MODE=database`: DB required for ledger persist; JSON optional cache; reconstitute from DB if JSON missing.
- Remaining JSON uses: strategy-config, fixtures/VTS, optional state cache, non-ledger settings.
- Import tool: existing `npm run db:import-legacy` (idempotent projection).

## 7. DB failure / UNKNOWN / restart recovery

- Pre-submit DB failure → gate reject (0 broker posts).
- Post-submit DB failure → UNKNOWN, no resubmit.
- Reconstitute unit test covers MemoryLedger → AppState intents/orders without JSON.
- Live RDS transaction recovery under `database` mode: code path present; full live order proof blocked by credential decrypt (see §4/§11).

## 8. Server worker vs browser

- `instrumentation.ts` starts account workers when `PAPER_RUNTIME_OWNER=accounts`.
- Ticks do not require browser polling/session.
- Verified process logs account-worker activity while hitting `/login` only.
- Browser close does not stop the Node worker (same process as Next server).

## 9. AI consumer / contract

- Validator + pull consumer + budget policy + admin stub implemented.
- Auto-order **disabled**; `enable_auto_order` returns 403.
- Live AI Agent connection: **not claimed** (no `AI_AGENT_BASE_URL` required for this slice; contract tests only).

## 10. Tests run

| Command | Result |
| --- | --- |
| `npx tsx --test src/runtime/auth-gate.test.ts` | PASS |
| `npx tsx --test src/ai/ai-foundation.test.ts` | PASS (after fingerprint fix) |
| `npm run db:check` | PASS (objects=39, ADOPTED) |
| Full `npm test` | Not fully re-run this iteration (targeted suite preferred while iterating) |
| `npm run lint` / `npm run build` | Pending / run if time |

## 11. Live KIS PAPER

| Step | Result |
| --- | --- |
| Read-only balance | Blocked — credential decrypt failure for ACTIVE account |
| Min buy/sell/cancel | Not executed (A/B + credential gate) |
| DB write of live fill | Not executed |

Required minimum input: matching `BROKER_CREDENTIAL_MASTER_KEY` **or** operator `RECOVERY_APPLY` rebind with confirm token; then market open + fresh quotes for min order.

## 12. Ops apply checklist

1. Set `PERSISTENCE_MODE=database` (example updated).
2. Ensure `DATABASE_URL` + `BROKER_CREDENTIAL_MASTER_KEY` match RDS ciphertext.
3. `PAPER_RUNTIME_OWNER=accounts` then **restart** Next process.
4. Optional: `npm run db:import-legacy` before cutting over.
5. Do **not** enable AI auto-order yet.

## 13. Remaining blockers

- Live PAPER credential decrypt mismatch in this VM.
- AI producer auth/pagination unknown until Agent reachable.
- Full regression suite + build not completed in this pass.
- No remote push (per task instruction).
