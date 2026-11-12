# 자동매매 시작 장부 대사 수정 보고서

검증 시각: **2026-11-12 13:45 KST (Asia/Seoul)**  
대상: 로그인 사용자 본인 KIS PAPER (`****6021` / `e3152ebd-…`) + 승인 AWS RDS  
실제 주문 제출: **0건**

## 적용 커밋

`a1cd789` — Fix PAPER auto-trading start recon gates on approved RDS

## 최초 실패 단계와 원인

| 단계 | 상태(수정 전) | 원인 |
| --- | --- | --- |
| RDS 미확인 | 통과 | `PERSISTENCE_MODE=database`, host `*.rds.amazonaws.com`, ping/스키마 OK |
| KIS 조회 실패 | 통과 | 자격증명 복호화·inquireBalance READY |
| 대사 미완료 | 부분 | Startup Sync가 과거 `HEALTHY`라 최신 불일치를 재실행하지 않음 |
| 실제 불일치 | **최초 실질 차단** | `005930` 로컬 3주 / KIS 2주 → `safety.reconciliation=mismatch` |
| 미해결 주문 | 통과 | unknown 0 |
| (부가) | stale RISK | 회로 `유효하지 않은 AppKey`가 KIS READY 이후에도 시작을 가로막음 |

과거 `kisBalance.matched=true`가 `safety.reconciliation=mismatch`를 OR로 덮어쓰던 경로를 제거했습니다.

## 대사 결과 (수정 후)

- Startup Sync 강제 재실행 → 포지션을 KIS에 맞춤 (`005930×2`, `069500×11`)
- `reconciliation=synced`, `matched=true`, circuit halt 해제
- Preflight `readyForPaperAutoTrading=true`, `firstFailureStage=null`
- `/api/runtime/database`: connected + persistenceMode=database  
- `/api/health/ready`: rds=ok, realLocked=true (전체 ready는 타 계좌 stale worker로 not_ready일 수 있음)

## ON 저장 및 Worker 평가

1. 이용 동의 + Preflight 통과 후 `autoTrading=true` 저장 확인
2. `QuantEngine.run` 전략 평가 경로 진입 확인 (정규장 외면 주문 없이 스킵 메시지)
3. 검증 후 `autoTrading=false`로 되돌림 — **주문 0건**

## 차단 경로 확인

| 조건 | firstFailureStage / 결과 |
| --- | --- |
| RDS ping 실패(시뮬) | `RDS_UNVERIFIED` → ON 거부 |
| 장부 불일치(시뮬) | `RECON_MISMATCH` → ON 거부 |
| 미해결 주문(시뮬) | `UNRESOLVED_ORDERS` → ON 거부 |
| 로컬 MySQL DSN | 신규 주문 게이트 차단 |
| 운용 중 RDS persist 실패 | 기존 `DatabaseLedgerError`로 POST 전 중단 |

## 시작 vs 주문 조건

- **시작(ON)**: RDS 승인·PAPER 소유·자격증명·KIS auth·Startup Sync·최신 대사·Worker lock·필수 리스크
- **주문**: 정규장, 신선한 종목 시세, 전략 신호, 예산/한도, Intent 선행 저장 등 기존 게이트 유지  
- 시세 샘플 `NOT_READY`는 ON을 막지 않음 (주문 경로에서만 차단)
- 로그인/계좌 연결만으로 autoTrading을 켜지 않음
- REAL은 시작·거래 대상에서 제외, 기존 REAL 주문 잠금 유지
