# 미리매수

사용자가 **직접 입력한 조건식**에 따라 한국투자증권 Open API 매매를 기계적으로 실행하는 소프트웨어 도구입니다. 종목 추천이나 투자 일임을 하지 않습니다.

기본값은 **로컬 페이퍼 북**입니다. 앱키를 넣기 전에는 실제 주문이 나가지 않습니다. 엔진은 빈 사용자 설정에서 시작합니다.

## 아키텍처

```
사용자 조건식 / 조건매수 / 적립 / 수동주문
        │
        ▼
     IBroker
   ┌────┴────┐
MockBroker  KisBroker
 로컬체결    KIS REST (시세·현금주문)
        │
        ▼
  OrderManager  →  조건식별 예수금 버킷 (리스크 한도)
```

```
src/
  brokers/
    IBroker.ts          # getCurrentPrice / buyMarket / buyLimit / sellMarket / sellLimit
    MockBroker.ts       # 로컬 페이퍼 북
    KisBroker.ts        # 한국투자증권 Open API
  accounts/
    OrderManager.ts     # 버킷 게이트 · 정규장 락 · 면책 락 · 룰 쿨다운
    execution-policy.ts # 정규장 검증 · ±3% 지정가 밴드 · 분할
  rules/
    params.ts           # UserRule · 빈 설정 · 면책 문구
    config.ts           # data/strategy-config.json 로드/저장
    RuleRunner.ts       # interval / ma-cross 조건 실행
    disclaimer.ts       # 동의 전까지 주문·엔진 잠금
    throttle.ts         # ruleId+종목 연속 실패 시 3분 쿨다운
  engine/
    QuantEngine.ts      # 사용자가 저장한 조건식만 순회
```

- 배포(B2C)에는 사전 정의된 안정형/중립형/공격형 템플릿이 없습니다. 엔진은 `{ "rules": [] }` 에서 시작합니다.
- 로컬(`localhost` / `127.0.0.1`) 또는 `NEXT_PUBLIC_ADMIN_MODE=true` 일 때만 DIY 폼에 운영자 프리셋이 보입니다. 배포 환경의 DOM에는 없습니다.
- `data/strategy-config.json` 은 `{ "rules": [] }` 로 시작합니다. 폼에서 입력한 값만 저장됩니다.
- 매수는 해당 조건식 `balance` 안에서만 승인된 뒤 브로커로 전달됩니다.
- 이용 동의 체크박스가 true가 아니면 KIS 주문과 자동 실행이 잠깁니다.
- 신규 주문은 KST 정규장(09:00~15:20)만 허용합니다. 동시호가·주말·공휴일은 거부합니다.
- 시장가 의도는 현재가 ±3% 지정가로 바꿔 내고, 같은 룰이 연속 실패/미체결이면 3분 정지합니다.
- 기본 거래 모드는 `TRADING_MODE=MOCK` 입니다. 브라우저 `/api/tick` 은 MOCK/PAPER 에서만 엔진을 돌립니다. LIVE_TEST/LIVE 엔진은 워커 + 파일 락만 실행합니다.
- Next가 죽어도 `npm run emergency:stop` 으로 신규 주문을 막고 KIS 미체결을 취소할 수 있습니다. 포지션 청산은 `npm run emergency:flatten` 입니다. 두 명령은 섞이지 않습니다.

로컬 장부(`data/paper-account.json`)는 한도와 UI용입니다. KIS 모의·실전 잔고·수수료와 숫자가 다를 수 있습니다.

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

키 없이 실행하면 `BROKER=mock` 입니다. 조건식에 넣은 종목의 호가만 움직입니다.

로컬에서 예전 프리셋을 쓰려면 `.env.local` 에 `NEXT_PUBLIC_ADMIN_MODE=true` 를 넣고 개발 서버를 재시작합니다. `localhost` 로 열면 이 변수가 없어도 관리자 프리셋이 보입니다.

## 한국투자증권 모의투자(VTS)

기본 실행은 항상 Mock입니다.

```
BROKER=mock
TRADING_MODE=MOCK
ALLOW_LIVE_TRADING=false
KIS_MODE=demo
```

VTS 검증은 `.env.local`에만 키를 넣고, **모의투자 앱키**와 `KIS_MODE=demo`만 사용합니다. 값은 Git에 넣지 않습니다. 상세 시나리오는 [docs/VTS_TEST_MANUAL.md](docs/VTS_TEST_MANUAL.md)를 따릅니다.

```
BROKER=kis
TRADING_MODE=live_test
ALLOW_LIVE_TRADING=false
KIS_MODE=demo
KIS_APP_KEY=<모의 앱키>
KIS_APP_SECRET=<모의 시크릿>
KIS_ACCOUNT_NO=<모의계좌 8자리-상품코드>
```

```bash
cp .env.example .env.local
# .env.local 에 모의투자 키만 채운 뒤
npm run dev
```

화면 상단 배지가 **KIS 모의** / `LIVE_TEST` 인지 확인합니다. `KIS_MODE=real`, `KIS_LIVE_CONFIRM`, `ALLOW_LIVE_TRADING=true` 는 VTS 단계에서 설정하지 않습니다. 실전 호스트로 주문이 나가지 않도록 코드가 `TRADING_MODE=live_test`에서 실전 주문을 거절합니다.

LIVE_TEST 한도(서버 `OrderManager.canBuy` → `checkHardLimits`): 1건 10,000원, 하루 매수 30,000원, 하루 3건. 환경변수로 이 값을 올릴 수 없습니다.

`npm test`는 실제 KIS 주문을 내지 않습니다. 읽기 전용 VTS는 `RUN_KIS_VTS_TESTS=true`, 주문은 `RUN_KIS_VTS_ORDER_TESTS=true`가 추가로 있을 때만 실행됩니다. REAL 관련 플래그가 보이면 테스트를 ABORT 합니다. VTS 장부는 `data/vts-test/<testRunId>/`에만 쌓이며 운영 `paper-account.json`과 섞이지 않습니다.

검증이 끝나면 `.env.local`을 다시 Mock 기본값으로 되돌리세요.

## 한국투자증권 실전 (이번 단계에서 사용하지 않음)

실전은 `TRADING_MODE=live` + `ALLOW_LIVE_TRADING=true` + `KIS_MODE=real` + `KIS_LIVE_CONFIRM=I_UNDERSTAND`가 **모두** 있을 때만 열립니다. VTS 시나리오가 통과하기 전에는 켜지 마세요.

## 주문 경로

1. 면책 동의·서킷·일일 한도·조건식 버킷을 검사합니다.
2. KisBroker가 현금 주문을 내고 ODNO를 접수 번호로만 저장합니다.
3. 체결내역(`inquire-daily-ccld`)의 실제 체결 수량만 장부에 반영합니다.
4. 미체결 잔량은 30초 뒤 취소합니다.

## 화면

- **대시보드** — 총자산·평가손익·당일 매매, 사용자가 만든 조건식 카드, 자동매매 시작(면책 모달)
- **매매 룰** — 종목코드·조건·1회 금액·손절/익절 직접 입력, 조건식 재생
- **조건매수 / 적립매수** — 6자리 종목코드를 직접 입력
- **체결내역** — 로컬에 기록된 체결(KIS 주문번호 포함)
- **안내** — 모의/실전 설정과 계좌 초기화(로컬 장부만 지웁니다)
- 상단 **긴급 정지**
- 첫 방문 **시작 가이드** — 증권사 → 예수금 → 매매 룰 → 면책 → 시작

## 사용자 설정 API

매매 룰 폼이 같은 엔드포인트를 씁니다. 저장값은 `data/strategy-config.json` 입니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/strategy-config` | `{ config: { rules: [] } }` |
| `PUT` | `/api/strategy-config` | `{ rules: [...] }` 전체 교체 |
| `PATCH` | `/api/strategy-config` | 한 조건식 추가/수정 |

```bash
curl -X PUT http://127.0.0.1:43147/api/strategy-config \
  -H 'Content-Type: application/json' \
  -d '{"rules":[{"ticker":"005930","kind":"interval","intervalMs":60000,"buyPct":0.1,"sliceKrw":100000,"stopLossPct":0.05,"takeProfitPct":0.03,"budget":1000000}]}'
```

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/backtest` | 저장된 조건식을 일봉에 재생 |
| `POST` | `/api/onboarding` | 예수금·조건식 저장. `autoStart` 는 `disclaimerAccepted: true` 필요 |
| `PATCH` | `/api/settings` | `autoTrading` 은 이용 동의 후에만 true |
| `POST` | `/api/risk/kill` | 긴급 정지 |

## 주의

본 서비스는 사용자가 설정한 조건에 따라 기계적으로 API 매매를 대행하는 소프트웨어 도구일 뿐이며, 종목 추천이나 투자 일임을 수행하지 않습니다. 모든 투자 판단과 매매 결과에 대한 책임은 사용자 본인에게 있습니다. 실전 키와 `KIS_LIVE_CONFIRM=I_UNDERSTAND` 를 넣는 순간 실제 주문이 나갑니다. `.env.local` 을 커밋하지 마세요.
