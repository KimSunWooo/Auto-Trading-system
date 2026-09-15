# 미리매수

한국투자증권 Open API를 쓰는 국내주식 자동매매 엔진입니다. 조건매수·적립매수·퀀트 전략이 같은 `IBroker`를 호출하므로, 로컬 모의체결과 KIS 모의투자·실전 주문을 환경변수만으로 바꿉니다.

기본값은 **로컬 페이퍼 북**입니다. 앱키를 넣기 전에는 실제 주문이 나가지 않습니다.

## 아키텍처

```
전략 / 조건 / 적립 / 수동매수
        │
        ▼
     IBroker
   ┌────┴────┐
MockBroker  KisBroker
 로컬체결    KIS REST (시세·현금주문)
        │
        ▼
  OrderManager  →  전략별 예수금 버킷 (리스크 한도)
```

```
src/
  brokers/
    IBroker.ts          # getCurrentPrice / buyMarket / buyLimit / sellMarket / sellLimit
    MockBroker.ts       # 로컬 페이퍼 북
    KisBroker.ts        # 한국투자증권 Open API
    kis-client.ts       # tokenP · 현재가 · 일봉 · hashkey · 현금주문
    kis-config.ts       # BROKER / KIS_* 환경변수
  accounts/
    OrderManager.ts     # 버킷 게이트 · 정규장 인터셉터
    execution-policy.ts # ±3% 지정가 밴드 · 분할 · 고변동 시장가 금지
  risk/
    limits.ts           # 주문·일일·비중 하드 캡
    circuit.ts          # 서킷 브레이커
    RiskManager.ts      # 일일손실·20% 비중·손절·긴급정지
    reconcile.ts        # 체결내역 반영 · 잔량 취소
    balance-sync.ts     # inquire-balance vs 로컬 버킷
  backtest/
    BacktestRunner.ts   # 일봉 재생 · 수익률/MDD/승률
  strategies/
    params.ts               # 기본값 · 병합 · 검증 (UI에서도 import)
    config.ts               # data/strategy-config.json 로드/저장 · 버킷 meta 덮어쓰기
    RiskLevel1Strategy.ts   # 안정 적립
    RiskLevel5Strategy.ts   # 이평 스윙
    RiskLevel10Strategy.ts  # 변동성 추격
  engine/
    QuantEngine.ts
```

- 리스크 1–3 → 안정 적립, 4–7 → 이평 스윙, 8–10 → 변동성 추격
- 기본 배분: `Level1_Stable` 700만 / `Level10_Aggressive` 300만
- 매수는 해당 전략 `balance` 안에서만 승인된 뒤 브로커로 전달됩니다
- 종목코드·매수 주기·슬라이스·이평·K·쿨다운은 `data/strategy-config.json` (퀀트 탭에서 수정). 버킷 `meta`의 같은 키로 개별 덮어쓰기

로컬 장부(`data/paper-account.json`)는 전략 한도와 UI용입니다. KIS 모의·실전 잔고·수수료와 숫자가 다를 수 있습니다.

## 실행 (로컬 모의)

```bash
cp .env.example .env.local
npm install
npm run dev
```

브라우저: [http://127.0.0.1:43147](http://127.0.0.1:43147)

```bash
npm test
```

키 없이 실행하면 `BROKER=mock` 입니다. 관심종목 호가는 2.5초마다 움직이고, 켠 전략·조건·적립이 로컬에서 체결됩니다.

## 한국투자증권 연결

실거래(또는 KIS 모의투자)를 쓰려면 Open API 앱키와 계좌번호가 필요합니다.

### 1. 개발자센터에서 앱키 발급

1. [한국투자증권 Open API](https://apiportal.koreainvestment.com)에 로그인합니다.
2. 앱을 등록해 **앱키 / 앱시크릿**을 발급합니다. 모의투자용 키와 실전용 키는 다릅니다.
3. 모의투자는 개발자센터의 모의투자 계좌를, 실전은 실제 위탁계좌를 씁니다.
4. HTS/앱에서 해당 계좌의 국내주식 거래·Open API 사용이 가능한지 확인합니다.

### 2. 환경변수

`.env.local` 예시:

```bash
BROKER=kis
KIS_APP_KEY=발급받은앱키
KIS_APP_SECRET=발급받은앱시크릿
KIS_ACCOUNT_NO=12345678-01
KIS_MODE=demo
```

| 변수 | 설명 |
| --- | --- |
| `BROKER` | `mock` (기본) 또는 `kis` |
| `KIS_APP_KEY` / `KIS_APP_SECRET` | 개발자센터 앱키 |
| `KIS_ACCOUNT_NO` | 계좌 8자리 + 상품코드 2자리. `12345678-01` 또는 `1234567801` |
| `KIS_MODE` | `demo` 모의투자(VTS, `openapivts.koreainvestment.com:29443`) / `real` 실전 (`openapi.koreainvestment.com:9443`) |
| `KIS_LIVE_CONFIRM` | 실전 주문 잠금 해제. 값은 반드시 `I_UNDERSTAND` |

`KIS_MODE=demo` 이면 모의투자 TR(`VTTC0802U` 매수 / `VTTC0801U` 매도)로 주문을 냅니다. 시세는 `FHKST01010100`, 일봉은 `FHKST03010100`, 접근토큰은 `POST /oauth2/tokenP` 입니다.

### 3. 실전 주문

실전은 기본으로 잠겨 있습니다. 시세만 실전 Open API로 가져오고, 주문은 거절합니다.

실전 현금 주문을 열려면:

```bash
BROKER=kis
KIS_MODE=real
KIS_LIVE_CONFIRM=I_UNDERSTAND
KIS_APP_KEY=실전앱키
KIS_APP_SECRET=실전앱시크릿
KIS_ACCOUNT_NO=12345678-01
```

화면 상단 배지가 **KIS 실전**인지 확인한 뒤 전략을 켜세요. 정규장(09:00~15:20 KST) 밖 — 동시호가·시간외 — 신규 주문은 OrderManager가 원천 차단합니다. 안내 탭에서 **정규장 외 모의매매**는 로컬 페이퍼에만 적용됩니다.

주문 흐름은 항상 같습니다.

1. 서킷·일일 한도·전략 버킷을 검사합니다.
2. 로컬에 `pending` 주문을 남긴 뒤 저장합니다.
3. KIS `order-cash` (hashkey, 10초 타임아웃) 를 호출합니다.
4. `ODNO`는 접수로만 취급합니다. 로컬 장부에는 넣지 않습니다.
5. 일별 체결내역(`inquire-daily-ccld`)의 `tot_ccld_qty`만 장부에 반영합니다.
6. 미체결 잔량(`nccs_qty`)은 30초 뒤 정정취소 TR(`VTTC0803U` / `TTTC0803U`)로 취소합니다.
7. 타임아웃/네트워크 오류는 `unknown` + 서킷 오픈입니다. 미체결로 단정하고 재시도하지 않습니다.
8. 30초마다 `inquire-balance`로 증권사 예수금·보유수량을 가져와 로컬 버킷 합계·포지션과 비교합니다. 1원 초과 예수금 오차나 수량 불일치는 서킷을 엽니다. 로컬 0.015% 수수료는 허용 오차로 쓰지 않습니다.

## 안전장치 (Failsafe)

- 미확인 주문이 있으면 신규 매매 전면 차단. 상단 빨간 띠에서 수동 해제.
- 주문 1건 200만원, 일 매수 500만원, 일 30건, 종목 비중 50% 하드 캡.
- 엔진 틱은 2.5초에 1회만 실행. 브라우저 탭이 여러 개여도 주문이 배로 나가지 않습니다.
- KIS 모드는 정규장(09:00~15:20) 외 신규 주문을 내지 않습니다. 동시호가·시간외는 원천 차단입니다.
- 손절·긴급 정지는 시장가 대신 현재가 ±3% 지정가 밴드로 분할 매도합니다. 미체결 잔량은 30초 후 취소합니다.
- 에코프로비엠(247540)·에코프로·알테오젠은 시장가 주문을 지정가 밴드로 전환합니다.
- 지정가·시장가 모두 ODNO를 전량 체결로 보지 않습니다. 체결내역 수량만 장부에 넣습니다.
- 미체결 잔량은 30초 후 취소 TR로 회수합니다.
- 30초마다 KIS 잔고조회와 로컬 버킷을 비교합니다. 오차가 있으면 Halt.

## 화면

- **대시보드** — 총자산·평가손익·당일 매매·승률, 안정형/중립형/공격형 카드, 자동매매 토글
- **퀀트** — 버킷 on/off, 전략 파라미터, 백테스트, 브로커 상태
- **조건매수 / 적립매수** — 조건이 맞으면 같은 브로커로 주문
- **체결내역** — 로컬에 기록된 체결(KIS 주문번호 포함)
- **안내** — 모의/실전 설정과 계좌 초기화(로컬 장부만 지웁니다)
- 상단 **긴급 정지** — 신규 매매 중지, KIS 미체결 즉시 취소, 지정가 밴드 분할 매도, inquire-balance로 로컬 장부 덮어쓰기. 정규장 외에는 청산 주문을 내지 않습니다.
- 첫 방문 **시작 가이드** — 증권사 → 투자금 → 전략 → 백테스트 → 시작

## 전략 파라미터 API

퀀트 탭 폼이 같은 엔드포인트를 씁니다. 저장값은 `data/strategy-config.json` 입니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/strategy-config` | `{ config, defaults }` |
| `PUT` | `/api/strategy-config` | 전체 교체(빠진 필드는 기본값). 성공 시 공개 상태 JSON |
| `PATCH` | `/api/strategy-config` | 현재 파일 위에 부분 병합. 성공 시 공개 상태 JSON |

예시:

```bash
curl -X PATCH http://127.0.0.1:43147/api/strategy-config \
  -H 'Content-Type: application/json' \
  -d '{"Level1_Stable":{"intervalMs":50000}}'
```

검증 실패(이평 역전, 주기 1초 미만, 빈 유니버스 등)는 `400` 과 `{ error }` 입니다.

상품 리스크·백테스트·온보딩:

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/backtest` | `{ strategies, totalDeposit, years }` → 수익률·MDD·승률·자산곡선 |
| `POST` | `/api/onboarding` | 예산·전략 배분 저장, 선택 시 자동매매 시작 |
| `POST` | `/api/risk/kill` | 긴급 정지 |
| `PATCH` | `/api/settings` | `autoTrading`, `onboardingComplete`, `ignoreMarketHours` |

방향은 `docs/PRODUCT_PLAN.md` 를 따릅니다. Broker·Account·Strategy·QuantEngine 경계는 유지합니다.

## 주의

이 프로그램은 투자 자문이 아닙니다. 실전 키와 `KIS_LIVE_CONFIRM=I_UNDERSTAND` 를 넣는 순간 실제 주문이 나갑니다. `.env.local` 을 커밋하지 마세요.
