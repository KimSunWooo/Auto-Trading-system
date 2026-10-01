# AI contract and ATS consumer

ATS pulls proposals from Auto_Trading_AI_Agent. AI never receives KIS keys or direct order APIs.

## Contract: `ai.trade-proposal.v1`

Required fields: `proposalId`, `schemaVersion`, `dataMode`, `generatedAt`, `analysisAsOf`, `validUntil`, `modelVersion`, `featureVersion`, `policyVersion`, `market`, `ticker`, `action`.

v1 `dataMode` values: `FIXTURE` | `REPLAY` | `LIVE_OBSERVATION` | `LIVE_SHADOW`.

None of these modes are order-eligible. Renaming observation/shadow to imply live auto-order is forbidden. Producer `isOrder=true` is rejected; ATS decides eligibility.

`HOLD` / `NO_TRADE` / `TACTICAL_WAIT` / `EXIT_REVIEW` are never converted to BUY/SELL.

`rawConfidence` is not treated as a calibrated win probability. Without calibration metadata, UI copy must say “규칙 통과 기반 PAPER 실험 정책”.

## Transport

- Preferred: REST pull `GET /decisions` and `GET /decisions/{decision_id}/envelope`.
- Auth: `AI_AGENT_AUTH_TOKEN` bearer when producer supports it (do not assume).
- Timeouts, retryable vs permanent errors, and cursor/page limits are enforced in `src/ai/pull-consumer.ts`.
- Push is not implemented (avoid dual paths).

## Budget

- Base allocation `A` (ADMIN only).
- Optional overdraft: absolute cap `1.10 × A` from **unallocated** cash (not +10% per order).
- Must also pass KIS orderable cash, cash reserve ratio, and existing account/global limits (stricter wins).
- SELL only against AI-attributed qty; never other strategies’ lots.

## Activation gate

`autoOrderEnabled` defaults **false**. Admin `enable_auto_order` stays 403 until PAPER priorities 1–5 are verified.

`halt_new_ai_orders` stops new AI orders only — no flatten, no cancel of other strategies.

## State chain (when enabled later)

`proposalId → signal key → user/account/strategy → validation → intentId → brokerOrderNo → fill → position/budget`
