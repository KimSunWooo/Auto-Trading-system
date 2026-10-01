# PAPER 운영 읽기 전용 확인 체크리스트

`autoTrading=OFF` 유지. 브로커 주문·backfill·강제 sync·환경변수/DB 쓰기 변경 금지.

대상 계정 예시: `brokerAccountId=e3152ebd-c8f5-432f-8923-287d3163e79c`, 종목 `069500`.

## 0. 사전 조건

- [x] 배포/점검 대상 커밋 SHA — HEAD `3a81a50` (미커밋 working tree 보존)
- [ ] `autoTrading === false` — 운영 런타임 **미확인**
- [ ] 운영 `ALLOW_LIVE_TRADING` / `KIS_MODE` / REAL 플래그 — **미확인**
- [ ] 운영 자격증명 없으면 추정하지 않음

## 1–4. 운영 대조 (이번 세션)

Persistence / worker lock / KIS·JSON·DB ODNO 재조회 / 운영 interval BUY 관찰 — **전부 미실행·미확인**.

코드·단위 테스트로만 확인된 항목:

- [x] account-scoped mirror: ACTIVE 계정·ruleKey·intent 귀속, OTHER/DISABLED bootstrap 보존
- [x] KisBroker pre-submit: `DatabaseLedgerError` → `orderCash` 0
- [x] Ownership DB 게이트: FLAG + loopback + `auto_trading_test` + master key (가짜 연결 검증 포함)

## 5. 이번 세션 실측 (혼합 금지)

측정 시각 기준: 허용 경로 검증 턴. 커밋·푸시·배포·브로커 주문·운영 DB 쓰기 **미실행**.

### 격리 로컬 DB 확인

| 항목 | 값 |
|------|-----|
| datadir | `/workspace/.tmp/mysql-data` (워크스페이스 로컬) |
| bind_address | `127.0.0.1` only (포트 3307) |
| database | `auto_trading_test` |
| 프로세스 env | `DATABASE_URL` → `127.0.0.1:3307/auto_trading_test` (`.env.local` ops RDS 덮어쓰지 않음) |
| 플래그 | `RUN_PAPER_OWNERSHIP_DB_TESTS=1` (테스트 프로세스에만) |
| master key | 테스트용 고정 문자열 (운영 키 미사용) |

### 실행 결과

| 검증 | tests | pass | fail | skipped |
|------|------:|-----:|-----:|--------:|
| Ownership D1–D10 (`paper-physical-ownership.test.ts`) | 11 | **11** | 0 | **0** |
| `npm test` (동일 격리 env + 플래그) | 650 | **638** | 0 | 12 |
| `npx tsc --noEmit` | — | pass | — | — |
| `npm run build` | — | pass | — | — |

- Ownership 이전 skip 9건: **이번 실행에서 모두 실행·통과** (skipped=0).
- 남은 skip 12건: VTS/OVTS opt-in (주문·flatten 플래그 없음, 의도적 미활성).
- Production master `test:instruments-production`: **이번 턴 미재실행**.

### 의도적 미실행

- 운영 autoTrading=OFF 확인
- 운영 KIS/JSON/DB 재대조
- VTS 주문·취소·flatten
- 커밋·푸시·배포

## 6. Ownership DB 재실행 조건

1. `RUN_PAPER_OWNERSHIP_DB_TESTS=1`
2. host ∈ {`127.0.0.1`,`localhost`,`::1`}
3. database === `auto_trading_test`
4. `BROKER_CREDENTIAL_MASTER_KEY` (테스트 키)

관련: `INSTRUMENT_MASTER_PROBE_DIR=… npm run test:instruments-production`
