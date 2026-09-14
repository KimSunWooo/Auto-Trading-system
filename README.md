# 미리매수

미래에셋증권 카이로스 0635 스타일 조건매수에, 전략별 서브계좌와 브로커 어댑터를 붙인 모의투자 엔진입니다.

미래에셋증권은 개인용 매매 Open API가 없습니다. 실거래 경로로 남겨 둔 것은 **한국투자증권 Open API** (`KisBroker` 골격)입니다.

## 아키텍처

```
src/
  brokers/
    IBroker.ts          # getCurrentPrice / buyMarket / buyLimit / sellMarket
    MockBroker.ts       # 로컬 페이퍼 북 체결
    KisBroker.ts        # KIS Open API 골격 (미연결)
    index.ts            # createBroker() — BROKER=mock|kis
  accounts/
    defaults.ts         # 총 예수금 1,000만 · 70/30 배분
    fills.ts            # 수수료·버킷 차감 체결
    OrderManager.ts     # 전략 잔액 게이트
    AccountBucket.ts
  strategies/
    IStrategy.ts        # execute(broker, accountBucket)
    RiskLevel1Strategy.ts   # KODEX 200 정액 적립
    RiskLevel5Strategy.ts   # 5/20 이평 스윙
    RiskLevel10Strategy.ts  # 변동성 돌파 추격
    index.ts            # StrategyFactory (리스크 1–10)
  engine/
    QuantEngine.ts      # 틱마다 활성 버킷 전략 실행
```

- 리스크 1–3 → Level1, 4–7 → Level5, 8–10 → Level10
- 기본 배분: `Level1_Stable` 700만 / `Level10_Aggressive` 300만
- 매수는 해당 전략 `balance` 안에서만 승인됩니다

`data/paper-account.json` 스키마:

```json
{
  "totalDeposit": 10000000,
  "allocations": [
    { "strategy": "Level1_Stable", "riskLevel": 1, "budget": 7000000, "balance": 7000000, "enabled": true },
    { "strategy": "Level10_Aggressive", "riskLevel": 10, "budget": 3000000, "balance": 3000000, "enabled": true }
  ]
}
```

## 실행

```bash
npm install
npm run dev
```

브라우저: [http://127.0.0.1:43147](http://127.0.0.1:43147)

```bash
npm test
```

퀀트 탭에서 버킷 on/off, 70/30 재설정, 리스크5 스윙 버킷 추가가 가능합니다. 시세가 2.5초마다 움직이면 켜 둔 전략이 조건을 보고 주문합니다.

KIS로 바꾸려면 (아직 주문은 거절됩니다):

```bash
BROKER=kis KIS_APP_KEY=... KIS_APP_SECRET=... KIS_ACCOUNT_NO=... npm run dev
```

이 프로그램은 투자 자문이 아니며 모의 시세는 실제 호가와 다릅니다.
