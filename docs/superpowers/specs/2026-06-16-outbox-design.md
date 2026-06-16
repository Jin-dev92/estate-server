# Transactional Outbox — 설계 스펙

> **상위 설계:** [building-owner-platform-design](2026-06-11-building-owner-platform-design.md) §4(발전 방향: Outbox), §5
> **선행:** M3(Kafka 이벤트 발행·EventPublisher 포트), M5(워커 프로세스 분리 패턴), M2.7(soft delete)
> **동기:** M3~M5 내내 "dual-write 이벤트 유실"로 미뤄온 숙제를 정면으로 해소한다.

## 1. 목표

도메인 변경과 도메인 이벤트 발행 사이의 **dual-write 불일치(이벤트 유실 창)** 를 제거한다. 현재는 use case가 `repo.create()`(트랜잭션 1)를 커밋한 뒤 별도로 `events.publish()`(Kafka)를 호출하므로, 그 사이에 크래시가 나면 "DB에는 썼지만 이벤트는 발행되지 않는" 유실이 발생한다.

**해법:** 도메인 변경과 **outbox 행 INSERT를 같은 DB 트랜잭션**으로 원자적으로 커밋하고, 별도 **outbox-relay 워커**가 outbox를 폴링해 Kafka로 발행한다.

**성공 기준**
- board·membership 4개 발행 지점(`PostCreated`·`CommentCreated`·`TenantJoined`·`LeaseEnded`)에서 도메인 변경과 outbox INSERT가 **하나의 트랜잭션**으로 커밋된다 → "DB는 썼는데 이벤트 없음"이 구조적으로 불가능.
- outbox-relay 워커가 PENDING 행을 폴링해 Kafka로 발행하고 PUBLISHED로 마킹한다.
- 여러 relay 인스턴스가 동시에 돌아도 같은 행을 중복 발행하지 않는다(`FOR UPDATE SKIP LOCKED`).
- relay 재시도/멀티 인스턴스로 같은 이벤트가 중복 발행돼도 소비자 멱등(`eventId @unique`)이 흡수한다(at-least-once).
- 관련 로직이 단위 테스트로 검증된다.

## 2. 비범위 (YAGNI)

- **chat(`MessageSent`) 적용 제외** — 채팅은 Redis 실시간 전달이 주 경로이고 Kafka는 영속화 버퍼다. Outbox를 끼우면 "즉시 전달" 흐름과 충돌하고 지연이 늘어난다. board·membership만 적용.
- **DLQ / 최대 재시도** — 1차는 `attempts`만 증가시키며 영구 재시도(폴링이 다음 틱에 다시 집음). 실패 격리(DLQ·최대 횟수 후 FAILED 상태)는 후속 과제.
- **CDC(Debezium 등) 기반 relay** — 폴링 방식으로 충분. 로그 테일링은 범위 밖.
- **outbox 행 보존 정책(아카이빙/삭제 배치)** — PUBLISHED 행은 남겨 감사·디버깅에 쓰고, 정리 배치는 후속.

---

## 3. 데이터 흐름

```
[쓰기 트랜잭션]  use case가 txRunner.run(tx => { ... }):
    1. repo.create(entity, tx)     ← 도메인 변경 (tx 클라이언트로)
    2. outbox.add(event, tx)       ← OutboxEvent INSERT(PENDING) (같은 tx)
   → 한 번의 commit으로 원자적 — 유실 창 제거
   (캐시 무효화 등 비-DB 작업은 트랜잭션 밖에서 수행)

[outbox-relay 워커]  setInterval 폴링:
    SELECT ... WHERE status='PENDING' ORDER BY createdAt
      FOR UPDATE SKIP LOCKED LIMIT <batch>     ← 멀티 relay 중복 방지
    각 행:
      Kafka emit(topic, { key: partitionKey, value: payload })
      성공 → status=PUBLISHED, publishedAt=now
      실패 → attempts += 1 (status 유지 → 다음 폴링에 재시도)
```

---

## 4. 데이터 모델 (Prisma)

```prisma
model OutboxEvent {
  id           String    @id @default(cuid())
  eventId      String    @unique // DomainEvent.eventId — 소비자 멱등 키와 동일
  eventType    String
  topic        String // 발행 대상 토픽(적재 시 고정)
  partitionKey String // = entityId, 파티션 순서 보장
  payload      Json // DomainEvent 전체 봉투
  status       String    @default("PENDING") // OutboxStatus: PENDING | PUBLISHED
  createdAt    DateTime  @default(now())
  publishedAt  DateTime?
  attempts     Int       @default(0) // 발행 시도 횟수(관측·디버깅)

  @@index([status, createdAt]) // 폴링 대상 조회
}
```

- `OutboxStatus` const enum(`PENDING`/`PUBLISHED`)으로 매직스트링 제거.
- `payload`는 `DomainEvent` 전체 봉투를 그대로 저장 → relay가 추가 가공 없이 emit.
- `topic`을 행에 고정해, 발행 시점에 매핑을 다시 계산하지 않는다(적재 시점의 매핑이 진실).

---

## 5. 트랜잭션 전파 (tx 명시)

새 포트 2개 + 기존 repository 시그니처 확장.

### 5.1 TransactionRunner 포트
```
TRANSACTION_RUNNER (Symbol)
interface TransactionRunner {
  run<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>;
}
```
- Prisma 구현: `prisma.$transaction(fn)`(interactive transaction).
- `TransactionClient`는 `Prisma.TransactionClient` 타입(트랜잭션 범위 클라이언트).

### 5.2 OutboxStore 포트
```
OUTBOX_STORE (Symbol)
interface OutboxStore {
  add(event: DomainEvent, tx: TransactionClient): Promise<void>;   // 트랜잭션 안 INSERT
  fetchPending(limit: number): Promise<OutboxRecord[]>;            // FOR UPDATE SKIP LOCKED
  markPublished(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;                          // attempts += 1
}
```
- `add`는 호출자가 넘긴 `tx`로 INSERT → 도메인 변경과 같은 트랜잭션.
- `fetchPending`/`markPublished`/`markFailed`는 relay 워커가 사용(자체 트랜잭션).

### 5.3 repository 확장
영향 repository에 **선택적 tx 인자**를 추가한다(기존 호출부 무변경):
- `PostRepository.create(post, tx?)`
- `CommentRepository.create(comment, tx?)`
- `LeaseRepository.update(lease, tx?)` (end-lease)
- invite redeem의 Lease 생성 경로(`LeaseRepository.create` 또는 해당 메서드, tx?)

구현은 `tx ? tx.post.create(...) : this.prisma.post.create(...)` 형태. tx가 없으면 기존 동작과 동일.

### 5.4 use case 변경 (4건)
`create-post`·`create-comment`·`redeem-invite-code`·`end-lease`:
- 기존: `await repo.create(entity)` → `await events.publish(event)`.
- 변경: `await txRunner.run(async (tx) => { const saved = await repo.create(entity, tx); await outbox.add(buildEvent(saved), tx); return saved; })`.
- `EVENT_PUBLISHER` 주입 제거. 캐시 무효화(`cache.invalidate*`)는 트랜잭션 커밋 **후** 수행(DB 외 작업).
- 이벤트 봉투 생성 로직(eventId·occurredAt·payload)은 그대로 유지하되 outbox.add로 전달.

> **`EVENT_PUBLISHER`의 새 위치:** use case에서 더는 쓰지 않는다. `KafkaEventPublisher`와 `TOPIC_BY_EVENT` 매핑은 **outbox-relay 워커 전용**으로 남는다. outbox 적재 시 `topic` 컬럼을 채워야 하므로, 토픽 매핑 함수(`topicFor(eventType)`)를 outbox.add 내부(또는 공유 헬퍼)에서 호출한다.

---

## 6. outbox-relay 워커

- 위치: `src/workers/outbox-relay.main.ts`(M5 워커 패턴: `NestFactory.create(OutboxModule)` 후 `listen()` 없이 폴링 루프 시작). HTTP 포트 미바인딩.
- 폴링: 단순 `setInterval`. 주기 env `OUTBOX_POLL_MS`(기본 1000ms), 배치 크기 env `OUTBOX_BATCH_SIZE`(기본 100).
- 1틱 로직(`RelayOutboxUseCase.execute()`):
  1. `outbox.fetchPending(batch)` — raw SQL `SELECT ... FOR UPDATE SKIP LOCKED`로 PENDING을 잠그며 조회.
  2. 각 행을 `EVENT_PUBLISHER.publish` 경로로 Kafka emit(`key=partitionKey`).
  3. 성공 → `markPublished(id)`, 실패 → `markFailed(id)`(attempts++).
- **동시성:** `FOR UPDATE SKIP LOCKED`로 여러 relay가 동시에 돌아도 같은 행을 잡지 않는다. 단일 워커로 운영하더라도 안전 장치로 둔다.
- **Kafka 미설정/장애:** emit 실패는 `markFailed`로 흡수 → 다음 폴링에 재시도(영구). relay 자체 크래시 시에도 PENDING은 DB에 남아 다음 기동에 처리.

> **SKIP LOCKED 구현 메모:** Prisma는 `FOR UPDATE SKIP LOCKED`를 쿼리 빌더로 직접 지원하지 않으므로 `prisma.$queryRaw`로 raw SQL을 쓴다. 조회→발행→마킹을 위해 `fetchPending`은 트랜잭션 안에서 `SELECT ... FOR UPDATE SKIP LOCKED`로 잠그고, 같은 트랜잭션에서 처리하거나 잠근 id를 즉시 `PUBLISHED` 직전 상태로 마킹하는 방식 중, **본 설계는 "fetch는 잠금 조회 + 발행 성공 후 별도 update"** 로 단순화한다(단일 relay 가정에서 충분, 멀티 relay에서도 SKIP LOCKED가 동시 집기를 막는다).

---

## 7. 정합성 보장 요약

| 속성 | 보장 방법 |
|---|---|
| **유실 없음** | 도메인 변경 + outbox INSERT가 한 트랜잭션 → "DB만 쓰임" 불가 |
| **중복 허용·무해** | relay 재시도/멀티 relay로 중복 발행 가능 → 소비자 멱등(`eventId @unique`)이 흡수(at-least-once) |
| **순서** | `partitionKey = entityId` → 같은 엔티티 이벤트의 파티션 내 순서 보존(기존과 동일) |
| **동시 relay 안전** | `FOR UPDATE SKIP LOCKED` |

---

## 8. 에러 처리

- **트랜잭션 롤백:** `txRunner.run` 내부에서 repo.create 또는 outbox.add가 throw하면 전체 롤백 → 도메인 변경도 outbox도 남지 않음(정합 유지). use case는 예외를 그대로 전파(기존 에러 봉투 계약).
- **relay emit 실패:** `markFailed`(attempts++)로 status는 PENDING 유지 → 다음 폴링 재시도. 무한 재시도(1차 범위; DLQ는 후속).
- **relay 루프 예외:** 1틱에서 예외가 나도 다음 `setInterval` 틱이 계속 돌도록 try/catch로 루프를 보호(한 배치 실패가 워커를 죽이지 않음).

## 9. 테스트

- **단위**
  - `RelayOutboxUseCase`: PENDING 배치 → emit → markPublished, emit 실패 시 markFailed(attempts++)·status 유지, 빈 배치 no-op.
  - `PrismaOutboxStore`: `add`가 넘겨받은 tx로 INSERT, `markPublished`/`markFailed` 동작(mock PrismaService).
  - 변경된 4 use case: `txRunner.run` 안에서 repo.create와 outbox.add가 **둘 다** 호출되고, Kafka(`EVENT_PUBLISHER`)를 **직접 발행하지 않음**을 검증. 캐시 무효화는 트랜잭션 후 호출.
- **회귀:** 기존 소비자(audit/notification/persistence) 테스트 무변경 통과.
- **스모크(수동):** 글 작성 → `OutboxEvent` PENDING 1행 확인 → outbox-relay 기동 → PUBLISHED 전환 + audit/notification이 이벤트 소비 확인.

## 10. 파일 구조

```
prisma/schema.prisma                              OutboxEvent 모델
src/outbox/domain/outbox-event.ts                 OutboxRecord 타입 + OutboxStatus enum
src/outbox/domain/outbox-store.ts                 OUTBOX_STORE 포트
src/outbox/domain/transaction-runner.ts           TRANSACTION_RUNNER 포트 + TransactionClient 타입
src/outbox/infrastructure/prisma-outbox-store.ts  add/fetchPending(SKIP LOCKED)/markPublished/markFailed
src/outbox/infrastructure/prisma-transaction-runner.ts  prisma.$transaction 위임
src/outbox/application/relay-outbox.use-case.ts    폴링 1틱 로직
src/outbox/outbox.module.ts                        store·runner·EVENT_PUBLISHER(워커용) 배선
src/workers/outbox-relay.main.ts                   폴링 루프 엔트리포인트
수정:
  src/board/application/create-post.use-case.ts        outbox 적재 전환
  src/board/application/create-comment.use-case.ts     outbox 적재 전환
  src/property/application/redeem-invite-code.use-case.ts  outbox 적재 전환
  src/property/application/end-lease.use-case.ts       outbox 적재 전환
  src/board/infrastructure/prisma-post.repository.ts   tx? 인자
  src/board/infrastructure/prisma-comment.repository.ts tx? 인자
  src/property/infrastructure/prisma-lease.repository.ts tx? 인자(update·create)
  src/board/board.module.ts·property.module.ts         OutboxModule/포트 주입
  src/config/config-keys.ts·.env.example               OUTBOX_POLL_MS·OUTBOX_BATCH_SIZE
  package.json                                         start:worker:outbox / start:prod:outbox
  README.md·docs/study/마일스톤-학습-노트.md            Outbox 설명·학습 포인트
```

## 11. 알려진 한계 / 후속

- **무한 재시도:** 영구 실패 이벤트가 매 폴링마다 재시도됨 → 최대 횟수 후 FAILED/DLQ 격리는 후속.
- **폴링 지연:** outbox→Kafka 사이에 최대 `OUTBOX_POLL_MS`의 지연 추가(정합성↔지연 트레이드오프). CDC로 줄일 수 있으나 범위 밖.
- **PUBLISHED 행 누적:** 정리 배치(보존 기간 후 삭제/아카이브)는 후속.
- **chat 미적용:** 실시간 전달 특성상 제외(§2).
