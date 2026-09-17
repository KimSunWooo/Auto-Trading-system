# 미리매수

사용자가 **직접 입력한 조건식**에 따라 한국투자증권 Open API 매매를 기계적으로 실행하는 소프트웨어 도구입니다. 종목 추천이나 투자 일임을 하지 않습니다.

기본값은 **로컬 페이퍼 북**입니다. 앱키를 넣기 전에는 실제 주문이 나가지 않습니다. 엔진은 빈 사용자 설정에서 시작합니다.

## 현재 진행

| 단계 | 결과 |
| --- | --- |
| Gate 1 (거래 코어 정적 분석) | PASS |
| Gate 2 (VTS 장부 격리 · 테스트 하네스) | CONDITIONAL PASS |
| Gate 2.5 (변경 범위 감사) | PASS |
| VTS-A (국내 PAPER 읽기 전용) | PASS |
| Domestic VTS-B2 (BUY → ODNO → Fill → JSON → RDS → Recon) | PASS (이전 검증, ODNO `0000022105` / 005930×1 보존) |
| Domestic PAPER Live Soak | 구현 완료. Worker+lock. 단발 timeout ≠ AUTO STOP |
| PAPER operational policy | max qty 11 / day 20 / position 50. Test harness는 1주·1 BUY 유지 |
| 해외주식 UI / 시세 / 외화잔고 / Adapter | 구현. 실제 PAPER 주문은 opt-in |
| Overseas VTS-A | `npm run vts:overseas-a` (기본 npm test skip) |
| Overseas VTS-B preflight | Quote/Balance/Orderable PASS 가능. 실제 BUY는 미국 정규장+opt-in |
| Overseas VTS-B2 actual BUY | READY / NOT EXECUTED (시장 CLOSED 또는 opt-in 없음) |
| EC2 PAPER deployment artifacts | Dockerfile / compose / health / docs 준비. 실제 EC2 provisioning 없음 |
| RDS MySQL mirror | JSON authority. `PERSISTENCE_MODE=mirror`. database SOT 없음 |
| Gate 3 / REAL | LOCKED |

로컬 검증은 변경 후 `npm test` / `npx tsc --noEmit` / `npm run build` / `npm run db:check` 로 다시 측정한다. README의 과거 pass 수를 그대로 믿지 마세요.

유지 중인 안전장치:

- `npm test`는 실제 KIS 주문을 내지 않습니다.
- REAL(`KIS_MODE=real`, `ALLOW_LIVE_TRADING=true`, `KIS_LIVE_CONFIRM`)은 꺼 둡니다.
- 주문 opt-in(`RUN_KIS_VTS_ORDER_TESTS`, `RUN_KIS_VTS_FLATTEN_TEST`, `RUN_KIS_VTS_OVERSEAS_ORDER_TESTS`)은 기본 꺼짐.
- timeout → UNKNOWN, 맹목 재시도 없음, ODNO exact mapping, recon 실패 시 신규 주문 차단.
- RDS 실패 → Broker retry 없음. Worker lock 없으면 주문 금지.

## 아키텍처

```
사용자 조건식 / 조건매수 / 적립 / 수동주문
        │
        ▼
     IBroker
   ┌────┴────┐
MockBroker  KisBroker
 로컬체결    KIS REST
               ├─ DomesticTrading (시세·잔고·주문)
               └─ OverseasTradingAdapter (미국 시세·외화잔고·주문 게이트)

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

## RDS MySQL mirror (optional)

기본값은 `PERSISTENCE_MODE=json` 입니다. JSON 장부가 runtime authority이고, RDS는 아직 source of truth가 아닙니다.

```bash
# 읽기 전용 점검. 비밀번호를 출력하지 않습니다.
npm run db:check

# 로컬 MySQL 8 (기존 앱 compose를 바꾸지 않습니다)
docker compose -f docker-compose.db.yml up -d
```

`PERSISTENCE_MODE=mirror` 일 때만 JSON 저장 성공 뒤에 RDS로 projection 합니다. DB 실패는 `DB_MIRROR_DEGRADED`만 기록하고 주문을 재시도하지 않습니다.

문서: `docs/DATABASE_ARCHITECTURE.md`, `docs/RDS_OPERATIONS.md`.


## 한국투자증권 모의투자(VTS)

기본 실행은 항상 Mock입니다.

```
BROKER=mock
TRADING_MODE=MOCK
ALLOW_LIVE_TRADING=false
KIS_MODE=paper
```

VTS 검증은 `.env.local`에만 키를 넣고, **모의투자 `KIS_PAPER_*`** 와 `KIS_MODE=paper`(또는 `demo`)만 사용합니다. 값은 Git에 넣지 않습니다. 실전 `KIS_REAL_*` 는 있어도 모의 모드에서 읽히지 않습니다.

VTS-A(읽기 전용)용 `.env.local` 예. 앱키·시크릿·계좌는 직접 채우세요. 채팅이나 README에 실제 값을 적지 마세요.

```
BROKER=kis
TRADING_MODE=live_test
ALLOW_LIVE_TRADING=false
KIS_MODE=paper
RUN_KIS_VTS_TESTS=true
KIS_PAPER_ACCOUNT_NO=
KIS_PAPER_APP_KEY=
KIS_PAPER_APP_SECRET=
```

`KIS_PAPER_ACCOUNT_NO`는 8자리 계좌 + 2자리 상품코드입니다. 예: `12345678-01`.

넣지 마세요: `KIS_MODE=real`, `ALLOW_LIVE_TRADING=true`, `KIS_LIVE_CONFIRM`, `RUN_KIS_VTS_ORDER_TESTS=true`, `RUN_KIS_VTS_FLATTEN_TEST=true`.

키가 없으면 VTS-A는 API를 호출하지 않고 FAIL합니다. 키가 있으면 인증 → 시세 → 잔고 → 포지션 → 미체결 → 체결 → 초기 recon만 조회합니다. 매수·매도·취소는 VTS-A에서 하지 않습니다.

```bash
cp .env.example .env.local
# .env.local 에 모의투자 키만 채운 뒤
npm run dev
```

화면 상단 배지가 **KIS 모의** / `LIVE_TEST` 인지 확인합니다. `TRADING_MODE=live_test`에서는 실전 호스트 주문을 거절합니다.

PAPER(`TRADING_MODE=live_test` + `KIS_MODE=paper|demo` + `BROKER=kis`, REAL 플래그 없음) operational 한도:

- 1회 최대 `PAPER_MAX_QTY_PER_ORDER` (기본 11주)
- 일일 브로커 submit `PAPER_MAX_BROKER_SUBMITS_PER_DAY` (기본 20)
- 종목별 포지션 `PAPER_MAX_POSITION_QTY_PER_SYMBOL` (기본 50)
- 동일 intent 1회, 동일 종목 미체결 BUY 금지, UNKNOWN/recon 게이트 유지
- VTS 단발 하네스(`PAPER_POLICY_MODE=test` 또는 `RUN_KIS_VTS_ORDER_TESTS`)만 예전 1주/1 BUY 제한

REAL 및 PAPER가 아닌 LIVE_TEST 한도(`OrderManager.canBuy` → `checkHardLimits`): 1건 10,000원, 하루 매수 30,000원, 하루 3건. 환경변수로 이 값을 올릴 수 없습니다. PAPER 정책은 REAL에 적용되지 않습니다.

`npm test`는 실제 KIS 주문을 내지 않습니다. 읽기 전용 VTS는 `RUN_KIS_VTS_TESTS=true`, 주문은 `RUN_KIS_VTS_ORDER_TESTS=true`가 추가로 있을 때만 실행됩니다. REAL 관련 플래그가 보이면 테스트를 ABORT 합니다. VTS 장부는 `data/vts-test/<testRunId>/`에만 쌓이며 운영 `paper-account.json`과 섞이지 않습니다.

테스트 계층: Layer A 기존 단위 테스트, Layer B FakeKis 실패 주입(`src/runtime/vts-failure-injection.test.ts`), Layer C 실VTS(`src/runtime/vts-lifecycle.test.ts`, 기본 SKIP).

검증이 끝나면 `.env.local`을 다시 Mock 기본값으로 되돌리세요.

## 한국투자증권 실전 (이번 단계에서 사용하지 않음)

실전은 `TRADING_MODE=live` + `ALLOW_LIVE_TRADING=true` + `KIS_MODE=real` + `KIS_REAL_*` + `KIS_LIVE_CONFIRM=I_UNDERSTAND`가 **모두** 있을 때만 열립니다. VTS 시나리오가 통과하기 전에는 켜지 마세요.

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
| `GET` | `/api/overseas/search` | 미국 종목 검색/시드 · 읽기 전용 |
| `GET` | `/api/overseas/quote` | 해외 현재가 HHDFS00000300 |
| `GET` | `/api/overseas/account` | 외화잔고 · 환율 · 매수가능 · 미체결/체결 |

해외 주문 버튼은 UI에서 비활성화입니다. 실제 해외 PAPER 주문은 `RUN_KIS_VTS_OVERSEAS_ORDER_TESTS` 가 있을 때만 코드 경로가 열리며, 이번 작업에서는 설정하지 않습니다.

국내 PAPER 장중 제한 운용은 기존 Worker 경로만 사용합니다.

```bash
TRADING_MODE=live_test KIS_MODE=demo BROKER=kis PERSISTENCE_MODE=mirror ALLOW_LIVE_TRADING=false npm run soak:preflight
npm run soak:report
```

Ready=NO 이면 자동매매를 시작하지 않습니다. 시세 실패 시 주문하지 않으며, 강제 시그널은 만들지 않습니다.

## EC2 PAPER 배포 준비

실제 EC2 provisioning은 별도 단계입니다. 아티팩트만 포함합니다.

```bash
docker build -t mirae-autobuy-paper:local .
docker compose -f docker-compose.paper.yml config
# 문서: docs/EC2_PAPER_DEPLOYMENT.md
# 헬스: GET /api/health/live · /api/health/ready · npm run ec2:health
```

단일 레플리카만. `data/` 는 EBS bind mount. REAL 플래그 금지.

## 주의

본 서비스는 사용자가 설정한 조건에 따라 기계적으로 API 매매를 대행하는 소프트웨어 도구일 뿐이며, 종목 추천이나 투자 일임을 수행하지 않습니다. 모든 투자 판단과 매매 결과에 대한 책임은 사용자 본인에게 있습니다. 실전 키와 `KIS_LIVE_CONFIRM=I_UNDERSTAND` 를 넣는 순간 실제 주문이 나갑니다. `.env.local` 을 커밋하지 마세요.
