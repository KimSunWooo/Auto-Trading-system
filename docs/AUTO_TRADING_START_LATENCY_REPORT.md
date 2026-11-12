# 자동매매 시작 응답 지연 개선 보고서

검증 시각: **2026-11-12 15:30 KST (Asia/Seoul)**  
대상: 승인 AWS RDS + 본인 KIS PAPER (`****6021`) · **주문 0건**

## 확인한 병목

| 구간 | 개선 전 | 원인 |
| --- | --- | --- |
| `PATCH /api/settings` 동기 대기 | ~**149s** | Preflight + Startup Sync + 전체 장부 persist를 응답 전에 전부 |
| 시세 샘플 `inquirePrice` | ON 경로에 포함 | 시작 판정에 불필요 (주문 게이트 전용) |
| KIS auth `inquireBalance` | Sync 직전 중복 | soft auth로 캐시 토큰 재사용 |
| Startup Sync inside `mutateStore` | 장시간 락 | KIS 네트워크가 상태 변경 큐를 점유 |
| ON 저장 | worker tick ledger(~30–50s) 뒤 대기 | 전체 project와 동일 큐 |

브라우저가 “응답 없음”처럼 보이던 이유: UI가 동기 PATCH 완료만 기다림 → 서버는 실행 중이었고 RDS ON은 아직 저장 전인 경우가 많았음.

## 적용한 수정

1. **비동기 시작 API** `POST/GET /api/auto-trading/start`  
   - 즉시 `202` + `requestId`  
   - UI: `장부 대사 중` / `시작 완료` / `시작 실패` 폴링  
   - **시작 완료는 RDS `autoTrading` ON 저장 확인 후에만**
2. **시세 샘플 분리** (`includeQuoteSample: false` on ON path)
3. **soft KIS auth** — 캐시 토큰 시 잔고 재조회 생략 (Sync가 조회)
4. **Startup Sync** — KIS 호출을 store 락 밖으로 이동
5. **flags persist** — ON/OFF는 `trading_account_state` 빠른 upsert
6. **Worker tick** — tick 계산과 ledger persist 분리 (설정 변경이 tick persist에 덜 막힘)
7. **연속 클릭** — 계좌당 in-flight job 재사용
8. **취소/OFF** — generation 취소로 늦은 완료가 ON을 다시 쓰지 않음
9. **RDS live 캐시(30s)** + 대기 한도

## 개선 전후 (동일 PAPER, HTTP)

| 지표 | 개선 전 | 개선 후 (표본 4–5) |
| --- | --- | --- |
| 브라우저 첫 응답 | ~149s (동기) | **~4s** (`202` enqueue) |
| 작업 완료 p50 | ~149s | **~26s** |
| 작업 완료 p95 | ~149s | **~38s** |
| `persist_on` p50 | (전체의 일부, 수십 초) | **~2.6s** (비경합) / 경합 시 ~18s |
| 연속 클릭 | 중복 Sync | **동일 requestId 재사용** |
| 취소·OFF 후 늦은 완료 | 위험 | **ON 미저장 / 취소 유지** |

요청 ID로 단계(`session` / `rds_ping` / `kis_auth` / `startup_sync` / `persist_on`)가 job 응답 `byStage`에 기록됩니다.

## 남은 지연

- **재시작 직후·강제 재대사**: Startup Sync + KIS 조회 (~20–90s) — UI는 `장부 대사 중`으로 표시
- **Worker tick과 store 큐 경합**: 가끔 `persist_on`·enqueue가 수 초~십수 초로 늘어남
- **계정 resolve / 세션** (~4s enqueue): 추가 캐시 여지

## 안전 조건 (유지)

- 승인 RDS + 본인 PAPER만 / REAL 제외  
- RDS 미확인·대사 실패·미해결 주문 → ON·신규 주문 차단  
- Worker lock / OrderManager / Intent 선행 저장 / 종목 시세 주문 조건 유지  
- 로컬·샘플 계좌 대체 없음  
