# M9 — Outbox 견고화: DLQ(FAILED 격리) · 재시도 백오프 (설계 스펙)

> 작성일: 2026-06-17
> 선행: [Transactional Outbox 설계](2026-06-11-building-owner-platform-design.md) (결정 13), 현재 구현 `src/outbox/`
> 상위 설계: [건물주 플랫폼 설계 스펙](2026-06-11-building-owner-platform-design.md)

---

## 1. 목적과 범위

Transactional Outbox(완료)는 dual-write 유실을 없앴지만, **발행 실패 처리가 미성숙**하다.
현재 `markFailed`는 `attempts`만 +1 하고 status를 PENDING으로 유지해 **매 폴링 틱(기본 1초)마다 무한 재시도**한다. 그 결과:

- **poison message**(스키마 불일치 등으로 영원히 실패하는 행)가 PENDING에 영구히 남아 매 틱 Kafka 호출·로그를 낭비한다.
- 백오프가 없어 일시 장애에도 1초 간격으로 두드린다(부하·로그 폭주).

M9은 이를 **DLQ 패턴**으로 견고화한다:

1. **재시도 백오프** — 실패 시 즉시 재시도하지 않고 **지수적으로 간격을 늘린다**(상한 cap).
2. **FAILED 격리** — **최대 재시도 횟수** 초과 시 `PENDING → FAILED`로 옮겨 정상 흐름에서 빼낸다(DLQ). FAILED 행은 DB에 남아 사람이 사후 조사한다.

### 범위에서 명시적으로 제외 (YAGNI)
- **replay/requeue**(FAILED → PENDING 되살리기): 후속 과제. M9은 **격리까지만**.
- replay용 운영 스크립트·API 엔드포인트: 제외.
- 메트릭·대시보드·외부 알림: 관측성은 M10(Sentry) 범위. M9은 **로깅 + DB 컬럼** 최소 수준.

### 성공 기준
- poison message가 **MAX_ATTEMPTS 도달 시 FAILED로 격리**되어 더는 폴링되지 않는다(무한 재시도 종료).
- 일시 실패는 **지수 백오프**(예: 1→2→4→8→16s, cap 60s)로 재시도되고, 백오프 대기 중인 행은 폴링에서 제외된다.
- 한 행의 실패·격리가 배치의 다른 행 발행을 막지 않는다(기존 per-row 격리 유지).

---

## 2. 데이터 모델 (스키마 + 마이그레이션)

`OutboxEvent`에 백오프·격리 필드를 추가한다. **Prisma 마이그레이션 동반**(스키마 변경 = 코드 변경, CLAUDE.md DB 룰).

```prisma
model OutboxEvent {
  id           String    @id @default(cuid())
  eventId      String    @unique
  eventType    String
  topic        String
  partitionKey String
  payload      Json
  status        String   @default("PENDING") // PENDING | PUBLISHED | FAILED  ← FAILED 추가
  createdAt     DateTime @default(now())
  publishedAt   DateTime?
  attempts      Int      @default(0)
  nextAttemptAt DateTime? // 다음 재시도 가능 시각(백오프). NULL=즉시 가능(최초 미시도)
  lastError     String?   // 마지막 실패 사유(왜 poison인지 — DLQ 사후 조사용)
  failedAt      DateTime? // FAILED로 격리된 시각

  @@index([status, nextAttemptAt]) // 폴링 조회용(기존 [status, createdAt] 대체)
}
```

- **추가 컬럼 3개:** `nextAttemptAt`(TIMESTAMP NULL), `lastError`(TEXT NULL), `failedAt`(TIMESTAMP NULL). 셋 다 nullable → 기존 행은 전부 NULL이 되어 하위 호환(backfill 불필요).
- **`status`:** 타입/구조 변경 없이 허용값에 `'FAILED'`만 추가(현재 PENDING/PUBLISHED → +FAILED).
- **인덱스 교체:** `@@index([status, createdAt])` → `@@index([status, nextAttemptAt])` (새 조회 조건에 맞춤).
- **`OutboxStatus` enum:** `Failed = 'FAILED'` 추가.
- **하위 호환:** 기존 PENDING 행은 `nextAttemptAt IS NULL`이라 "즉시 폴링 대상"으로 취급(아래 §3 조회 조건).
- **마이그레이션 네이밍:** `add_outbox_dlq_backoff`(snake_case 동사형).
- **롤백 플랜:** 컬럼 추가형이라 보상은 `DROP COLUMN nextAttemptAt, lastError, failedAt` + 인덱스 `[status, nextAttemptAt]` → `[status, createdAt]` 원복. PR에 롤백 SQL 첨부.

---

## 3. relay 로직 (백오프 · 격리)

### 3.1 조회 — `fetchPending` (백오프 대기 행 제외)

```sql
SELECT id, "eventId", "eventType", topic, "partitionKey", payload, attempts
FROM "OutboxEvent"
WHERE status = 'PENDING'
  AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())   -- 백오프 대기 중이면 제외
ORDER BY "createdAt" ASC
LIMIT $1
FOR UPDATE SKIP LOCKED
```

→ `nextAttemptAt > now`인 행(백오프 대기 중)은 폴링에서 빠진다 → 즉시 무한 재시도 종료. `createdAt ASC` 정렬은 유지(오래된 것 우선).

### 3.2 실패 처리 — `markFailed` 시그니처 확장

도메인 인터페이스를 `markFailed(id, attempts, error, tx)`로 확장한다(현재 사유를 안 받음). store가 백오프/격리를 결정:

```
attempts' = attempts + 1
if attempts' >= MAX_ATTEMPTS:
    status = 'FAILED', failedAt = now, lastError = error, attempts = attempts'   // 격리
else:
    delay = computeBackoff(attempts, BASE_MS, CAP_MS)
    nextAttemptAt = now + delay, lastError = error, attempts = attempts'          // 백오프 후 재시도
```

> 주의: `delay`는 **현재 attempts**(증가 전, 즉 0-base)로 계산해 첫 실패의 대기가 `BASE_MS`가 되게 한다(`2^0=1`).

### 3.3 백오프 계산 — 순수 함수

```
computeBackoff(attempts, baseMs, capMs) = min(baseMs * 2^attempts, capMs)
```

- 순수 함수로 분리(infra store가 호출) → 단위 테스트 용이. 예: base=1000, cap=60000 → 1s, 2s, 4s, 8s, 16s, (이후 cap).
- jitter는 범위 밖(테스트 재현성 우선, 트레이드오프는 학습 노트에 기록).

### 3.4 use-case — `RelayOutboxUseCase.execute`

- `catch`에서 `markFailed(row.id, tx)` → `markFailed(row.id, row.attempts, err.message, tx)`로 변경(store가 백오프/격리 결정).
- 배치 내 per-row try/catch 구조 유지(한 행 실패가 배치를 막지 않음).
- **격리 시 ERROR 로그**(eventId·attempts·lastError로 "poison 격리"를 명확히), 일반 재시도는 기존처럼 WARN. (use-case가 store로부터 격리 여부를 알 수 있어야 한다 — `markFailed`가 격리 여부를 반환하거나, store가 직접 ERROR 로깅. **store는 인프라라 도메인 로깅을 피하고, `markFailed`가 `{ quarantined: boolean }`을 반환해 use-case가 로그를 남기는 쪽으로 한다.**)

---

## 4. Config (하드코딩 금지 — ConfigKey + .env.example)

| ConfigKey | env | 기본값 | 의미 |
|---|---|---|---|
| `OutboxMaxAttempts` | `OUTBOX_MAX_ATTEMPTS` | `5` | 이 횟수 도달 시 FAILED 격리 |
| `OutboxBackoffBaseMs` | `OUTBOX_BACKOFF_BASE_MS` | `1000` | 지수 백오프 기준(1s) |
| `OutboxBackoffCapMs` | `OUTBOX_BACKOFF_CAP_MS` | `60000` | 백오프 상한(60s) |

- 기존 `OUTBOX_BATCH_SIZE`/`OUTBOX_POLL_MS` 토큰 패턴과 동일하게 DI 토큰으로 주입(`OutboxModule`에서 `ConfigService`로 제공).
- 기본값 5/1s/60s → 재시도 간격 1→2→4→8→16s 후 5회째 FAILED(약 30초 내 격리).

---

## 5. 관측 (최소 — 로깅 + 컬럼)

- **재시도 예정:** 기존처럼 `WARN`(eventId·다음 시각·사유).
- **FAILED 격리:** `ERROR` 로그 — eventId·attempts·lastError. "poison이 격리됐다"가 로그에서 즉시 보이게.
- `lastError`/`failedAt` 컬럼이 사후 조사(DLQ)의 근거.
- 별도 메트릭·대시보드·외부 알림은 범위 밖(M10 Sentry와 중복).

---

## 6. 테스트 (TDD)

- **`computeBackoff` 순수 함수 단위 테스트:** `attempts=0 → base`, 지수 증가(1·2·4·8·16×base), cap 초과 시 cap 고정.
- **`RelayOutboxUseCase` spec(mock store/publisher):**
  - 발행 성공 → `markPublished` 호출.
  - 발행 실패(attempts < max) → `markFailed(id, attempts, error, tx)` 호출(인자 전달 확인), WARN 로그.
  - 발행 실패 + store가 `{ quarantined: true }` 반환 → ERROR 로그(격리).
  - 배치 내 한 행 실패가 다음 행 발행을 막지 않음.
- **`PrismaOutboxStore` spec:**
  - `fetchPending`이 `nextAttemptAt > now`인 행을 제외하고 `IS NULL`/`<= now`만 가져온다.
  - `markFailed`가 attempts < max에서 `nextAttemptAt = now + computeBackoff(...)`를 기록(status PENDING 유지).
  - `markFailed`가 attempts+1 == max에서 `status=FAILED`·`failedAt`·`lastError` 기록, `{ quarantined: true }` 반환.
  - (기존 `prisma-outbox-store.spec.ts` 패턴 따름)
- **poison 재현:** publisher mock이 항상 throw → 같은 행이 max까지 누적 후 FAILED 되는 흐름을 use-case 레벨에서 검증(실제 무한 루프 없이 반복 호출로).

---

## 7. 문서 산출물

- **README:** 마일스톤 표 `M9 ✅`, "운영·견고함 후속" 문단의 M9 설명을 완료로 갱신. §5 설계 결정에 "14. M9 — Outbox DLQ·백오프" 추가(또는 결정 13에 후속으로 덧붙임).
- **학습 노트:** Outbox 섹션(§8 부근)에 M9 추가 — 지수 백오프·DLQ 격리·at-least-once와의 관계(여전히 유실 없음/중복 가능, 단 poison은 격리). 마일스톤 표에 M9 행.
- **PR:** 스펙·계획 md 링크 첨부 + **롤백 SQL** 첨부.

---

## 8. 단계별 검증

| 단계 | 산출물 | 검증 기준 |
|---|---|---|
| 1 | 스키마 + 마이그레이션 | `prisma migrate dev --name add_outbox_dlq_backoff`로 컬럼 3개·인덱스 교체, 기존 행 NULL 호환 |
| 2 | `OutboxStatus.Failed` + `computeBackoff` | enum 추가, 순수 함수 단위 테스트 green |
| 3 | `OutboxStore.markFailed` 시그니처 확장 + Prisma 구현 | 백오프/격리 분기, store spec green |
| 4 | `fetchPending` 조회 조건 | nextAttemptAt 필터, store spec green |
| 5 | use-case 배선 + 로깅 | WARN/ERROR 분기, use-case spec green |
| 6 | config 3종 | ConfigKey·.env.example 등록, DI 주입 |
| 7 | 문서 | README·학습 노트·롤백 SQL |

---

## 9. 트레이드오프 메모 (학습 포인트)

- **무한 재시도 ↔ 격리:** 무한 재시도는 "언젠가 성공"을 노리지만 poison엔 영원한 낭비. 격리는 정상 흐름을 지키되 **사람의 개입(사후 조사·replay)** 을 전제로 한다.
- **즉시 재시도 ↔ 지수 백오프:** 즉시는 일시 장애 복구가 빠르지만 지속 장애엔 폭주. 지수 백오프는 부하를 지수적으로 줄이되 **복구가 느려질 수 있다**(cap으로 상한).
- **at-least-once는 그대로:** 백오프·격리는 "유실 없음"을 바꾸지 않는다. relay 재시도·멀티 relay로 **중복 발행은 여전히 가능**(소비자 멱등이 흡수). 격리는 "무한 실패 행"만 빼낼 뿐.
- **nextAttemptAt 컬럼(push) ↔ 계산(pull):** 명시 컬럼은 DB 단일 출처라 재시작·멀티 relay에 안전하고 인덱스가 명확. 계산 방식은 컬럼이 없지만 쿼리가 복잡.
- **replay 제외(YAGNI):** 격리만으로 "무한 재시도 종료"라는 핵심 가치는 달성. 되살리기는 빈도가 생길 때 후속.
