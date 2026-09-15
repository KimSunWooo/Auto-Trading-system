# KIS VTS 검증 매뉴얼

이 문서는 **한국투자증권 모의투자(VTS)** 에서 주문 생명주기를 확인하기 위한 절차입니다. 실전(`KIS_MODE=real`) 주문은 포함하지 않습니다.

기본 개발 실행은 항상 Mock입니다.

```
BROKER=mock
TRADING_MODE=MOCK
ALLOW_LIVE_TRADING=false
```

---

## 코드 경로 (실제 파일)

```
시세        KisBroker.getQuote / MockBroker.getQuote
            lib/engine.ts refreshLiveQuotes
전략        evaluateConditions, evaluateDca, QuantEngine.run
시그널      src/rules/RuleRunner.ts makeSignalId
            lib/engine.ts 조건/DCA intent
리스크      OrderManager.canBuy / canSell
            src/risk/limits.ts checkHardLimits
            src/risk/RiskManager.ts checkBuy, checkDailyLoss, enforceStops
Intent      src/runtime/intents.ts upsertIntent
멱등        KisBroker.existingIntentFill, OrderManager.begin
주문        src/accounts/OrderManager.ts begin
브로커      src/brokers/IBroker.ts
            src/brokers/MockBroker.ts
            src/brokers/KisBroker.ts placeBuy/placeSell
KIS         src/brokers/kis-client.ts orderCash, inquireDailyCcld, inquireOpenOrders
체결        src/accounts/fills.ts bookReportedFill (ODNO only)
포지션/계좌  applyFill, src/risk/balance-sync.ts syncKisBalance
대조        src/risk/reconcile.ts settleOpenOrders
            src/runtime/recovery.ts recoverExternalOrders
저장        src/persistence/json-state-repository.ts
            src/runtime/atomic-file.ts
워커        instrumentation.ts → lib/engine-loop.ts startEngineLoop
            lib/engine.ts tickState
            src/runtime/worker-lock.ts
킬스위치    scripts/emergency-stop.ts  RiskManager.emergencyStop
            scripts/emergency-flatten.ts RiskManager.emergencyFlatten
대시보드    components/runtime-status.tsx, src/runtime/status.ts
```

워커 락은 **같은 머신, 같은 `data/` 파일시스템**만 보호합니다. VTS 로컬 1프로세스에는 충분합니다. Redis 분산 락은 이번 단계에서 추가하지 않습니다.

부분체결 로컬 표현: `OrderStatus`에 `PARTIALLY_FILLED`는 없습니다. 부모 주문은 `pending` + `filledQty` < `orderedQty`, 체결분은 child `filled`입니다.

---

## Mock → VTS 전환

1. `.env.local`은 Git에 커밋하지 않습니다 (`.gitignore`의 `.env*`).
2. [한국투자증권 Open API](https://apiportal.koreainvestment.com)에서 **모의투자 앱키**를 발급합니다. 실전 키를 넣지 마세요.
3. `.env.local` 예시 (값은 직접 입력):

```
BROKER=kis
TRADING_MODE=live_test
ALLOW_LIVE_TRADING=false
KIS_MODE=demo
KIS_APP_KEY=
KIS_APP_SECRET=
KIS_ACCOUNT_NO=
```

4. 넣지 말 것: `KIS_MODE=real`, `KIS_LIVE_CONFIRM`, `ALLOW_LIVE_TRADING=true`
5. `npm run dev` 후 대시보드 배지: `LIVE_TEST`, Broker connected, Market open(정규장), Recon synced
6. 검증이 끝나면 `.env.local`을 Mock 기본값으로 되돌립니다.

LIVE_TEST 서버 한도: 1건 10,000원, 하루 매수 30,000원, 하루 3건. 환경변수로 상향할 수 없습니다.

---

## 공통 사전조건

- 정규장 09:00–15:20 KST
- 면책 동의 + 자동매매 ON (해당 테스트에 필요할 때)
- 예수금 버킷에 LIVE_TEST 한도 안의 현금
- 종목은 1주 가격이 10,000원 이하인 종목을 고르세요. 삼성전자 1주는 한도를 초과합니다.
- HTS/KIS 모의 계좌 화면을 함께 엽니다.

확인 위치:

- 대시보드 상단: 주문 가능/차단, `LIVE_TEST`, RUNNING/BLOCKED/STOPPED, Worker, Broker, Risk, Recon
- 체결내역 패널: 로컬 `brokerOrderNo`(ODNO)
- `data/paper-account.json`: intents, orders, positions, safety
- KIS 모의 HTS: 주문/체결/잔고

---

## VTS-001 정상 매수

**목적:** 지정가 밴드 매수 1건이 ODNO·체결·포지션·잔고로 연결되는가.

**사전조건:** 공통. 1주 notional ≤ 10,000원.

**실행방법:** 조건매수 또는 수동 매수 1주. 워커 틱을 기다립니다. `/api/tick`은 LIVE_TEST에서 주문을 만들지 않습니다.

**예상결과:** KIS 접수 1건. 로컬 pending → ccld 반영 시 filled. 포지션 +1주. 예수금 감소.

**실제 확인방법:** 로컬 `orders[].brokerOrderNo` = HTS ODNO. `filledQty` = HTS 체결수량. fuzzy 매칭(종목+수량만)이 없어야 합니다.

**PASS:** 주문 1건, ODNO 일치, 체결 후 포지션/잔고가 HTS와 같은 방향.

**FAIL:** 주문 2건, ODNO 없음인데 filled, 로컬만 체결.

---

## VTS-002 정상 매도

**목적:** 보유 1주를 밴드 지정가로 매도.

**사전조건:** VTS-001 포지션 1주.

**실행방법:** 수동 매도 1주 또는 손절이 아닌 매도 경로.

**예상결과:** 매도 접수 1건. 체결 후 포지션 0.

**실제 확인방법:** HTS 매도 ODNO = 로컬. 잔고 증가.

**PASS:** 매도 1건, 포지션 0, 재매수 없음.

**FAIL:** 시장가 원주문, 중복 매도, 포지션 잔량 불일치.

---

## VTS-003 부분 체결

**목적:** 일부만 체결되면 잔량은 pending으로 남고 포지션은 체결수량만 반영.

**사전조건:** 지정가가 체결되기 어려운 가격이거나 수량이 나뉘는 상황. VTS에서 재현 안 되면 MOCK `MOCK_BROKER_MODE=partial`로 로컬 확인 후 VTS는 NOT VERIFIED.

**실행방법:** 주문 후 HTS에서 일부 체결을 확인. 워커 틱.

**예상결과:** 부모 `pending`, `filledQty` = 체결분, child filled. 잔량 미체결. 30초 후 취소 시도.

**실제 확인방법:** `data/paper-account.json`의 filledQty vs HTS tot_ccld_qty. ODNO 동일.

**PASS:** 포지션 = 체결수량. 잔량을 filled로 올리지 않음.

**FAIL:** 전량 filled로 확정, 미체결 수량을 포지션에 가산.

---

## VTS-004 주문 취소

**목적:** 취소 요청만으로 `cancelled`가 되면 안 된다. nccs에서 ODNO가 사라진 뒤에 확정.

**사전조건:** 미체결 지정가.

**실행방법:** 미체결이 30초 넘도록 두거나 `emergency:stop`. HTS에서 취소 접수/잔량 확인.

**예상결과:** 취소 API 후 미체결 조회 성공 + ODNO 없음 → 로컬 cancelled. 조회 실패 → UNKNOWN, 신규 주문 차단.

**실제 확인방법:** 로컬 status vs HTS 미체결 목록.

**PASS:** HTS에 남아 있으면 로컬 pending. 사라지면 cancelled. 조회 실패면 unknown.

**FAIL:** 취소 HTTP 성공만으로 cancelled.

---

## VTS-005 주문 timeout

**목적:** 접수됐을 수 있는 timeout을 실패로 보고 재주문하지 않는다.

**사전조건:** LIVE_TEST. 네트워크 지연을 만들기 어려우면 로컬 단위테스트(이미 있음) + VTS에서는 가능하면 프록시 timeout.

**실행방법:** 주문 직후 응답이 끊기면 워커를 계속 둡니다. 같은 시그널이 다시 나와도 신규 `orderCash`가 없어야 합니다.

**예상결과:** 로컬 `unknown`. `tradingBlocked`. HTS에 주문이 있으면 recover가 ODNO를 연결. 추가 주문 없음.

**PASS:** KIS 주문 ≤ 1. 로컬이 재전송하지 않음.

**FAIL:** timeout 후 두 번째 주문.

---

## VTS-006 중복 Signal

**목적:** 동일 intentId가 두 번 들어와도 Broker 주문 1회.

**사전조건:** 조건매수 watching 또는 같은 interval 버킷.

**실행방법:** 조건을 만족시킨 채 여러 틱 대기.

**예상결과:** `intents` 1, `orders` 부모 1, HTS 1.

**PASS:** ODNO 1개.

**FAIL:** 틱마다 새 주문.

---

## VTS-007 중복 Worker

**목적:** 같은 `data/`에서 워커 2개가 같은 주문을 내지 않는다.

**사전조건:** VTS `.env.local`.

**실행방법:** `npm run dev` 한 개만 두고, 다른 터미널에서 같은 프로젝트로 `next start` 또는 두 번째 `npm run dev`(포트만 다르게) 시도. lock 파일 `data/trading-worker.lock` 확인.

**예상결과:** 한쪽만 lock 보유. 다른 쪽 로그 `worker lock 미획득`. 주문은 lock 보유 프로세스만.

**PASS:** HTS 주문이 시그널 수와 같음 (중복 없음).

**FAIL:** 두 프로세스가 각각 주문.

참고: 다른 머신/디스크면 락이 공유되지 않습니다. VTS는 한 머신에서만 돌리세요.

---

## VTS-008 Quote API 실패

**목적:** 시세 실패 시 로컬/Mock 시세로 매수하지 않는다.

**실행방법:** 앱키를 잠깐 잘못 넣거나 방화벽으로 시세 URL만 차단한 뒤 틱.

**예상결과:** `market_data_unavailable`, 주문 차단, `source: seed/mock` 가격으로 `orderCash` 없음.

**PASS:** HTS에 신규 주문 없음.

**FAIL:** 로컬 호가로 매수.

---

## VTS-009 Balance API 실패

**목적:** 잔고 조회 실패 시 전략 매수 없음.

**실행방법:** 잔고 TR만 실패하도록 만들 수 없으면, 단위테스트 6번으로 대체하고 VTS는 앱 키 권한/장애 시 관찰.

**예상결과:** `broker_unavailable`, `liveReady=false`, 신규 주문 없음.

**PASS:** 차단 배지 + HTS 주문 0.

**FAIL:** 잔고 모르는데 매수.

---

## VTS-010 Open Order 조회 실패

**목적:** 미체결을 모르면 신규 주문을 막는다.

**실행방법:** nccs 실패를 재현. 못 하면 단위테스트 8.

**예상결과:** `reconciliation_unavailable`.

**PASS:** 신규 주문 0.

**FAIL:** 미체결 조회 실패 후에도 매수.

---

## VTS-011 Execution 조회 실패

**목적:** 체결 조회 실패 시 filled/rejected로 확정하지 않는다.

**실행방법:** 미체결 주문이 있는 상태에서 ccld 실패. 또는 단위테스트 7.

**예상결과:** pending/unknown 유지. 포지션 임의 증가 없음. 신규 주문 차단.

**PASS:** 로컬이 FILLED로 바뀌지 않음.

**FAIL:** 조회 실패를 거절/전량체결로 처리.

---

## VTS-012 Process Crash 후 복구

**목적:** 접수 후 프로세스 사망 시 재주문하지 않고 기존 주문을 찾는다.

**실행방법:** 주문 직후 `Ctrl+C`로 Next를 죽입니다. 재시작. 대시보드/HTS 비교.

**예상결과:** 로컬 pending(ODNO 있음) 또는 recover `RECOVERED_ORDER`. 같은 intent 재전송 없음. unknown이면 신규 차단.

**PASS:** HTS 주문 수 불변. 로컬이 그 ODNO를 가짐.

**FAIL:** 재시작 후 같은 시그널로 추가 주문.

---

## VTS-013 JSON/Persistence 장애

**목적:** `paper-account.json` 손상 시 초기화하지 않고 정지.

**실행방법:** 서버를 끄고 파일을 `{` 만 남깁니다. 서버 시작.

**예상결과:** `safety.kind=store_corrupt`, persistable false, 자동매매 꺼짐, 주문 차단. 빈 계좌로 리셋되지 않음.

**PASS:** 초기 예수금으로 돌아가지 않음.

**FAIL:** `createInitialState`로 거래 재개.

복구: 백업 `paper-account.json.bak`가 있으면 수동으로 되돌립니다. 둘 다 깨지면 매매를 재개하지 마세요.

---

## VTS-014 Stop Loss 후 재진입

**목적:** 손절 당일/같은 틱 재매수 없음.

**사전조건:** 평균가 대비 -5% 이하 포지션. LIVE_TEST 한도 안에서 소량.

**실행방법:** 손절 체결 후 같은 날 매수 시그널이 나와도 대기.

**예상결과:** `closedByStop`, `blockedBuys`. 매수 거부.

**PASS:** 손절 매도만. 같은 날 재매수 없음.

**FAIL:** 손절 직후 재매수 루프.

---

## VTS-015 Risk Limit 초과

**목적:** 1건 10,000원 / 하루 30,000원 / 3건이 Broker 직전에 막힌다.

**실행방법:** 10,000원 초과 1주 매수. 이어서 한도 안 3건 후 4번째.

**예상결과:** `checkHardLimits` 메시지. `orderCash` 없음. UI만의 제한이 아님.

**PASS:** HTS에 한도 초과 주문 없음.

**FAIL:** 한도 넘는 접수가 KIS에 존재.

---

## VTS-016 Emergency Stop

**목적:** 신규 차단 + 미체결 취소. 포지션은 건드리지 않음.

**실행방법:** Next가 켜져 있든 꺼져 있든:

```bash
npm run emergency:stop
```

**예상결과:** `autoTrading=false`, `safety.kind=emergency_stop`, 미체결 취소 시도, `killReport.flattened=0`. 대시보드 STOPPED, 주문 차단. 워커 루프는 남을 수 있으나 주문은 안 남.

**PASS:** 이후 신규 매수 거부. 포지션 수량은 그대로.

**FAIL:** 포지션이 청산됨(그건 flatten). 신규 매수가 나감.

---

## VTS-017 Emergency Flatten

**목적:** 보유 포지션 매도. stop과 섞지 않음.

**실행방법:**

```bash
npm run emergency:flatten
```

Next가 죽어 있어도 CLI는 Node만으로 동작해야 합니다.

**예상결과:** 청산 주문. 가능하면 포지션 0. 신규 매수는 끔.

**PASS:** HTS에 매도 주문. 매수 없음.

**FAIL:** 워커 락 때문에 매도가 전부 거절되거나, stop과 동일하게 미체결만 취소하고 포지션이 남음.

---

## VTS-018 Reconciliation

**목적:** KIS에만 있는 주문은 편입, 로컬에만 있는 ODNO는 unknown. 자동 재주문 없음.

**실행방법:** HTS에서 수동 1주 주문 후 앱 틱. 또는 로컬 ODNO를 조작하지 말고 불일치 관찰.

**예상결과:** `RECOVERED_ORDER` 또는 unknown+차단. Recon synced/mismatch/unavailable 배지.

**PASS:** 외부 주문을 로컬이 따라가고 추가 주문 없음.

**FAIL:** 외부 주문을 무시하고 같은 종목을 다시 매수.

---

## VTS-019 장 시작/장 종료

**목적:** 09:00 전·15:20 이후 신규 주문 거부. 정규장만 허용.

**실행방법:** 장 외 시간에 매수. 정규장에 1주.

**예상결과:** `sessionBlockReason` 메시지. KIS 주문 없음.

**PASS:** 장 외 HTS 신규 0.

**FAIL:** 동시호가/시간외에 주문 접수.

---

## VTS-020 재시작 후 중복 주문 여부

**목적:** VTS-012의 중복 주문 특화. 이미 체결된 intent를 다시 내지 않음.

**실행방법:** 체결 완료된 뒤 프로세스 재시작. 같은 조건이 여전히 true여도 대기.

**예상결과:** 조건 상태 filled/paused면 재발화 없음. 같은 intentId면 기존 주문 반환.

**PASS:** HTS 주문 수 증가 없음.

**FAIL:** 재시작 후 동일 조건으로 추가 매수.

---

## 권장 실행 순서

1. Mock에서 `npm test` 통과 확인 (VTS 키 없이)
2. `.env.local`을 VTS로 전환, 배지 확인
3. VTS-019 (장중인지)
4. VTS-015 (한도, 비싼 종목으로 차단부터)
5. VTS-001 → 002
6. VTS-006, 020
7. VTS-003, 004 (가능하면)
8. VTS-008~011 (장애 재현 가능 범위)
9. VTS-012, 013, 007
10. VTS-014
11. VTS-016, 017, 018
12. Mock 기본값으로 복귀

timeout(VTS-005)과 부분체결(VTS-003)은 VTS에서 재현이 안 되면 **NOT VERIFIED**로 남기고 REAL로 넘어가지 마세요.
