# 미리매수 ATS — 로컬 실사용 준비

로컬 PC에서 서버·Worker를 띄워 **본인 KIS PAPER** 계좌로 자동매매 ON/OFF·체결 확인을 하는 절차입니다.  
공개 배포·다중 고객·AI Agent는 범위 밖입니다. **REAL 주문은 LOCKED**입니다.

## 실행·종료

```bash
# 준비 (최초 1회)
cp .env.example .env.local   # 아래 환경변수 이름만 채움 — 값/비밀은 커밋·채팅에 넣지 않음
npm ci

# 실행 (앱 + account Worker)
npm run dev                  # http://127.0.0.1:43147

# 종료
# 터미널에서 Ctrl+C
```

선택 점검:

```bash
npm run db:check             # 승인 RDS 연결 (읽기)
curl -s http://127.0.0.1:43147/api/runtime/database
curl -s http://127.0.0.1:43147/api/health/ready
```

`PERSISTENCE_MODE=database`일 때 거래 장부 SoT는 **승인 AWS RDS**입니다. 로컬/샘플 JSON 장부로 대체하지 않습니다.

## 필요한 환경변수 이름 (값 출력 금지)

| 이름 | 용도 |
| --- | --- |
| `PERSISTENCE_MODE` | `database` (필수) |
| `DATABASE_URL` 또는 `AWS_RDS_*` + `DATABASE_USER_NAME` / `DATABASE_PASSWORD` | 승인 RDS |
| `BROKER_CREDENTIAL_MASTER_KEY` | PAPER 자격증명 복호화 |
| `PAPER_RUNTIME_OWNER` | `accounts` |
| `BROKER` / `TRADING_MODE` / `KIS_MODE` | `kis` / `live_test` / `paper` |
| `ALLOW_LIVE_TRADING` | `false` (REAL 잠금) |
| `APP_ORIGIN` | 로컬이면 `http://127.0.0.1:43147` |

사용자 PAPER AppKey·시크릿은 **마이페이지**에서 계좌에 등록합니다. 요청이 전역 `KIS_PAPER_*`로 대체되지 않습니다.

## 브라우저 경로 (일상 흐름)

1. `http://127.0.0.1:43147/login` — 로그인  
2. `http://127.0.0.1:43147/mypage` — 본인 PAPER 연결·검증  
3. `http://127.0.0.1:43147/` — 대시보드 (Startup Sync·대사·자동매매 ON/OFF)  
4. `http://127.0.0.1:43147/?tab=orders` — 체결내역  
5. `http://127.0.0.1:43147/reports/trades` — 거래 리포트  

대시보드·체결내역 모두 **거래 리포트** 링크가 있습니다.  
리포트는 **거래 없음** / **종료 거래 없음(체결만 있음)** / **RDS 조회 실패**를 구분합니다.

막힌 단계는 화면의 runtime 배지·시작 job 메시지·`orderBlockReason`·리포트 오류 문구로 확인합니다. RDS 미확인이면 시작 job이 `RDS_UNVERIFIED`에서 멈추고 ON을 쓰지 않습니다.

## OFF가 ON으로 되돌아가던 문제

- **원인:** Intent/틱/전체 `projectAppState`가 오래된 `settings.autoTrading=true` 스냅샷으로 RDS OFF를 덮어씀.  
- **수정:** 실행 플래그는 `persistUserExecutionSettingsFlags`만 갱신. project는 커밋된 RDS 플래그를 보존.  
- **추가:** 자동 주문은 Intent 저장 후, PAPER REST 대기열 통과·KIS HTTP 직전에 RDS를 다시 읽고 OFF/조회실패/타 Intent 미해결이면 전송하지 않고 Intent에 중단 사유를 남김. 자기 Intent는 제외.

## 첫 장중 자동 주문 확인 절차 (본인 PAPER)

운영 비밀·주문 버튼은 이 문서/에이전트가 대신 누르지 않습니다. **본인이** 정규장에:

1. 자동매매 **OFF**인지 대시보드·RDS(`auto_trading_enabled`)로 확인  
2. Startup Sync·대사가 정상인지 확인 (`Recon` / 미확인 주문 없음)  
3. 자동매매 **ON** → Worker가 전략을 평가할 때까지 대기  
4. 신호·접수 시 아래로 **한 줄 추적**을 기록:

| 단계 | 확인 위치 |
| --- | --- |
| IntentId | 체결내역 / 장부 intents |
| KIS ODNO | 주문 ack / KIS 일별주문 |
| 체결 | 체결내역 + KIS `inquire-daily-ccld` |
| RDS 장부 | executions / trades |
| 화면 | 대시보드·체결·리포트 |

5. 테스트 후 반드시 **OFF**  
6. 신호 없음·미체결이면 실제 도달한 단계까지만 기록 (예: Intent만 있고 ODNO 없음)

## 격리 테스트 (주문 0건 · 가짜 브로커)

```bash
MIRAEMAESU_TEST=1 npx tsx --test --test-concurrency=1 \
  src/db/execution-flags-project.test.ts \
  src/brokers/kis-broker-submit-authority.test.ts \
  src/runtime/execution-authority.test.ts \
  src/runtime/auto-trading-start-recovery.test.ts \
  src/brokers/kis-broker-db-gate.test.ts
```

## 미검증 / 후속

- 장중 본인 PAPER **실주문** 수명주기 (Intent→ODNO→체결→RDS→화면)는 사용자 확인  
- 공개 호스팅·팀 다중 계좌·AI Agent 연동  
- REAL 해제  
- 로그인 세션이 필요한 HTTP p50 재측정은 로컬에서 로그인 후 `/tmp/measure-dashboard.mjs` 패턴으로 반복
