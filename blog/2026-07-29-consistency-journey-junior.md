# 게시글 한 건은 어떻게 유실을 피하는가 — Kafka에서 Outbox와 DLQ까지

게시판과 채팅을 함께 가진 백엔드 서비스에서 비동기 처리의 정합성을 단계적으로 보강한 과정을 정리한 글입니다.
처음에는 데이터베이스 저장 뒤 메시지 브로커인 Kafka에 이벤트를 직접 발행했습니다. 이 방식은 단순하지만, 두 작업 사이에 서버가 중단되면 게시글만 남고 후속 이벤트는 사라질 수 있습니다.

## TL;DR

- Kafka 도입은 작업을 분리했지만, DB와 브로커를 따로 갱신하는 dual-write 문제를 남겼습니다.
- 게시글 작성은 DB 변경과 발행 의도를 함께 저장하는 Transactional Outbox를 적용했고, 중복에도 결과를 같게 유지하는 소비자 멱등성으로 보완했습니다.
- 재시도 단계에서는 실패할수록 간격을 늘리는 지수 백오프를 적용하고, 최대 5회 실패한 이벤트를 격리 영역인 DLQ의 `FAILED` 상태로 옮겼습니다.

## 왜 게시글 작성 뒤에 이벤트가 필요한가

한 입주자가 게시글 한 건을 작성한다고 가정합니다. HTTP 요청에 201 응답을 보내는 것만으로 작업이 모두 끝나는 것은 아닙니다. 같은 사건을 감사 로그에 기록하고, 다른 입주자에게 알림도 만들어야 합니다.

**도메인 이벤트(domain event)**는 비즈니스에서 이미 일어난 사실을 표현한 메시지입니다. 이 예시에서는 `PostCreated`가 “게시글이 작성됐다”는 사실을 나타냅니다.

모든 후속 작업을 게시글 작성 요청 안에서 동기적으로 처리하면 흐름은 이해하기 쉽습니다.

```text
1. 게시글 INSERT
2. 감사 로그 INSERT
3. 수신자별 알림 INSERT
4. HTTP 201 응답
```

그러나 감사나 알림 처리가 느려지면 게시글 작성 응답도 함께 느려집니다. 한 작업의 실패가 전체 요청의 실패로 번지는 문제도 생깁니다. 이 결합을 끊는 과정에서는 정합성 문제를 한 단계씩 마주하게 됩니다.

## 1단계: Kafka로 후속 작업 분리

**Kafka**는 생산자가 보낸 메시지를 토픽에 저장하고 소비자가 비동기로 읽게 하는 메시지 브로커입니다.

**producer**는 메시지를 발행하는 쪽이고, **consumer**는 메시지를 읽어 처리하는 쪽입니다.

첫 단계의 기본 흐름은 다음과 같습니다.

```text
1. 게시글 작성 유스케이스가 Post를 DB에 저장
2. 애플리케이션이 PostCreated를 Kafka의 board-events에 발행
3. 감사 워커가 이벤트를 소비
4. AuditLog를 DB에 저장
```

```text
게시글 작성 요청
      │
      ▼
 Post INSERT ──커밋──> Kafka board-events ──> 감사 워커 ──> AuditLog INSERT
```

Kafka를 경계로 게시글 작성과 감사 기록이 분리됩니다. 감사 처리가 느려져도 게시글 작성 경로가 같은 속도로 느려질 필요는 없습니다.

### consumer group과 팬아웃

**consumer group**은 같은 작업을 나눠 처리하는 consumer들의 묶음입니다. 같은 group 안에서는 파티션을 분담하고, 서로 다른 group은 같은 메시지를 독립적으로 받을 수 있습니다.

**팬아웃(fan-out)**은 이벤트 한 건을 서로 다른 목적의 소비자가 각각 처리하도록 분기하는 방식입니다. 이 예시에는 다음 세 group이 있습니다. **postfix**는 이름 뒤에 붙는 접미사입니다. NestJS `ServerKafka`는 설정한 이름에 기본 `-server` postfix를 붙일 수 있으므로, 설정값만 믿지 말고 브로커에 등록된 실제 이름을 확인해야 합니다. 아래 표에는 이 차이를 보여주기 위해 두 이름을 함께 적었습니다.

| 역할 | 설정한 groupId | 브로커의 실제 groupId | 구독 토픽 |
|---|---|---|---|
| 채팅 영속화 | `persistence-worker` | `persistence-worker-server` | `chat-events` |
| 감사 기록 | `audit-worker` | `audit-worker-server` | `chat-events`, `board-events`, `membership-events` |
| 알림 생성 | `notification-worker` | `notification-worker-server` | `chat-events`, `board-events` |

세 group이 존재한다고 해서 모든 이벤트를 세 group이 모두 받는 것은 아닙니다. 이 글의 `PostCreated`는 `board-events`에 실리므로 감사와 알림 group이 소비합니다. 영속화 group은 채팅 전용입니다.

## 2단계: 채팅은 전달과 영속화를 분리

채팅 경로는 같은 Kafka를 다른 목표에 사용한 변형입니다. 메시지를 받은 사용자가 즉시 화면에서 볼 수 있도록 Redis pub/sub로 전달하고, DB 저장은 Kafka 뒤의 영속화 워커가 처리합니다.

**파티션 키(partition key)**는 Kafka가 메시지를 어느 파티션에 넣을지 결정하는 값입니다. 같은 키의 메시지는 같은 파티션으로 가므로, 채팅에서는 `roomId`를 키로 사용해 같은 방 안의 순서를 유지합니다.

```text
1. WebSocket Gateway가 채팅 메시지 수신
2. Redis pub/sub로 상대방 화면에 전달
3. 최근 메시지 캐시에 저장
4. chat-events에 직접 발행
5. 영속화 워커가 Message를 DB에 저장
```

```text
채팅 메시지
   ├──> Redis pub/sub ──> 상대방 화면
   ├──> Redis 최근 메시지 캐시
   └──> Kafka chat-events ──> 영속화 워커 ──> Message INSERT
```

**결과적 정합성(eventual consistency)**은 데이터가 즉시 일치하지 않더라도 시간이 지나 같은 상태로 수렴하는 성질입니다. 이 구조에는 “화면에는 도착했지만 DB에는 아직 없는” 결과적 정합성 구간이 생깁니다. 체감 지연을 낮추기 위해 실시간 전달과 영속화를 분리한 결과입니다.

중요한 점은 **채팅이 Outbox를 거치지 않는다는 사실**입니다. 채팅 전송 유스케이스는 after-commit 직접 발행용 `publish()`를 사용합니다. 발행 실패는 기록하되 호출자에게 다시 던지지 않습니다. 따라서 직접 발행이 실패할 수 있는 유실 창도 채팅 경로에 남아 있습니다.

모든 비동기 경로를 같은 방식으로 만들지 않은 이유는 요구사항이 다르기 때문입니다. 채팅은 체감 지연을 우선했고, 게시글은 DB 변경과 후속 이벤트의 정합성을 우선했습니다.

## 3단계: 게시글의 dual-write 문제

**dual-write**는 하나의 논리적 작업이 DB와 메시지 브로커처럼 서로 다른 저장소를 각각 갱신하는 방식입니다. 두 저장소를 하나의 원자적 트랜잭션으로 묶기 어려워 중간 실패가 정합성 문제를 만듭니다.

게시글 작성의 직접 발행 방식에는 두 쓰기가 있습니다.

```text
1. PostgreSQL에 Post INSERT 후 커밋
2. Kafka에 PostCreated 발행
```

1번 뒤, 2번 전에 프로세스가 중단되면 다음 상태가 됩니다.

```text
Post: 존재
PostCreated: 없음
AuditLog: 없음
Notification: 없음
```

Kafka가 안정적이어도 이 간격은 사라지지 않습니다. 문제의 원인은 브로커의 전달 능력이 아니라, DB 커밋과 Kafka 발행이 서로 다른 원자성 경계에 있다는 점입니다.

**CDC(Change Data Capture)**는 데이터베이스 변경 로그를 읽어 변경 사항을 다른 시스템으로 전달하는 방식입니다. **폴링(polling)**은 대기 중인 데이터가 있는지 저장소를 주기적으로 조회하는 방식입니다.

| 방법 | DB와 이벤트의 원자성 | 요청 경로 지연 | 구현 복잡도 | 적용 경로 |
|---|---|---|---|---|
| after-commit 직접 발행 | 보장하지 않음 | 낮음 | 낮음 | 채팅 |
| Transactional Outbox | 같은 DB 트랜잭션으로 보장 | 폴링 지연 추가 | 중간 | 게시글·댓글·좋아요·입주·계약 종료 |
| CDC 기반 Outbox | 같은 DB 트랜잭션으로 보장 | 주기적 조회 없이 로그 기반 전달 가능 | 운영 인프라 증가 | 적용하지 않음 |

이 구현에서는 별도 CDC 인프라 대신 Outbox 테이블을 주기적으로 조회하는 폴링 방식을 선택했습니다.

## 4단계: Transactional Outbox로 원자성 경계 바꾸기

**Transactional Outbox**는 도메인 데이터 변경과 발행할 이벤트를 같은 DB 트랜잭션에 저장한 뒤, 별도 relay가 이벤트를 브로커로 전달하는 패턴입니다. **relay**는 대기 중인 Outbox 행을 읽어 Kafka로 옮기는 워커입니다.

게시글 한 건의 경로는 다음과 같이 바뀝니다.

```text
1. 트랜잭션 시작
2. Post INSERT
3. OutboxEvent INSERT(status=PENDING)
4. 두 INSERT를 함께 커밋
5. relay가 PENDING 행을 조회
6. Kafka에 PostCreated 발행
7. OutboxEvent를 PUBLISHED로 변경
```

```text
게시글 작성 요청
      │
      ▼
┌──────── 같은 PostgreSQL 트랜잭션 ────────┐
│  Post INSERT + OutboxEvent INSERT(PENDING) │
└────────────────┬───────────────────────────┘
                 │ 커밋
                 ▼
          outbox-relay 폴링
                 │
                 ▼
        Kafka board-events 발행
                 │
                 ▼
       OutboxEvent → PUBLISHED
```

게시글 작성 유스케이스의 핵심 형태는 다음과 같습니다.

```typescript
const saved = await this.txRunner.run(async (tx) => {
  const created = await this.posts.create(post, tx);
  await this.outbox.add(event, tx);
  return created;
});
```

Post 저장이나 Outbox 저장 중 하나라도 실패하면 둘 다 롤백됩니다. “게시글은 있는데 발행할 이벤트가 없다”는 상태를 DB 트랜잭션 경계 안에서 차단합니다.

### 여러 relay가 같은 행을 잡지 않게 하기

relay를 여러 개 실행하면 같은 `PENDING` 행을 동시에 읽을 수 있습니다. 이를 막기 위해 실제 조회는 트랜잭션 안에서 다음 잠금을 사용합니다.

```sql
SELECT id, "eventId", "eventType", topic, "partitionKey", payload, attempts, "traceContext"
FROM "OutboxEvent"
WHERE status = 'PENDING'
  AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
ORDER BY "createdAt" ASC
LIMIT :limit
FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE`는 선택한 행을 갱신용으로 잠급니다. `SKIP LOCKED`는 다른 트랜잭션이 이미 잠근 행을 기다리지 않고 건너뛰게 합니다. 잠금은 트랜잭션 동안 유지되므로 fetch부터 발행 결과 마킹까지 같은 트랜잭션에서 처리합니다.

## 5단계: Outbox도 중복 발행은 막지 못한다

**at-least-once**는 메시지가 최소 한 번 전달되도록 시도하되, 같은 메시지가 두 번 이상 전달될 수 있는 보장 방식입니다.

relay가 Kafka 발행에는 성공했지만 `PUBLISHED`로 표시하기 전에 중단될 수 있습니다. 재시작한 relay는 아직 `PENDING`인 같은 행을 다시 발행합니다. Outbox가 없애는 것은 이벤트 유실 창이지 중복 가능성이 아닙니다.

**멱등성(idempotency)**은 같은 작업을 여러 번 수행해도 최종 결과가 한 번 수행한 것과 같아지는 성질입니다.

이 시스템의 소비자는 데이터베이스 유니크 제약과 Prisma `P2002` 처리를 조합해 중복을 흡수합니다.

| 소비 결과 | 멱등 키 | 중복 시 처리 |
|---|---|---|
| `AuditLog` | `eventId` unique | `P2002`를 이미 처리된 이벤트로 보고 무시 |
| `Message` | 애플리케이션이 만든 `id`를 PK로 사용 | 같은 `messageId`의 `P2002`를 무시 |
| `Notification` | `[eventId, recipientId]` 복합 unique | 같은 수신자의 중복 알림이면 저장·카운터 증가·푸시를 건너뜀 |

```text
Outbox: 이벤트를 잃지 않게 함
   +
at-least-once: 중복 전달을 허용함
   +
멱등 소비자: 중복이 결과를 바꾸지 않게 함
```

## 6단계: 재시도와 DLQ로 정상 흐름 보호

초기 Outbox는 발행에 실패한 행을 `PENDING`으로 유지하고 다음 폴링에서 계속 재시도했습니다. Kafka의 짧은 장애에는 단순한 해법이지만, 영원히 성공할 수 없는 이벤트도 같은 속도로 반복 처리됩니다.

**poison message**는 스키마 불일치나 영구 오류 때문에 재시도해도 계속 실패하는 메시지입니다.

**지수 백오프(exponential backoff)**는 실패가 반복될수록 재시도 간격을 지수적으로 늘리는 전략입니다. 이 구현의 공식은 `min(baseMs × 2^attempts, capMs)`입니다.

**DLQ(Dead Letter Queue)**는 반복 실패한 메시지를 정상 처리 흐름에서 빼내 조사와 수동 처리를 기다리게 하는 격리 영역입니다. 이 구현은 별도 큐가 아니라 `OutboxEvent.status = FAILED`를 DLQ로 사용합니다.

개선한 실패 처리는 다음 순서입니다.

```text
1. Kafka 발행 실패
2. 실패 횟수 attempts + 1
3. 최대 횟수 미만이면 nextAttemptAt 계산 후 PENDING 유지
4. 최대 횟수에 도달하면 FAILED로 변경
5. relay는 PENDING만 조회하므로 FAILED 행은 자동 처리에서 제외
```

```text
PENDING
   │ 발행 성공
   ├──────────────────────────> PUBLISHED
   │
   │ 발행 실패, 최대 횟수 미만
   └──> PENDING + nextAttemptAt + lastError
              │ 백오프 뒤 재시도
              └─────────────────┐
                                │
              최대 5회 실패     ▼
                         FAILED + failedAt
```

기본 파라미터는 최대 5회, base 1초, cap 60초입니다. 첫 번째부터 네 번째 실패 뒤에는 1초, 2초, 4초, 8초를 기다립니다. 다섯 번째 실패에서는 다음 백오프를 예약하지 않고 `FAILED`로 격리합니다. 따라서 기본 최대 횟수에서는 60초 cap에 도달하지 않으며, cap은 최대 횟수를 늘렸을 때 대기 시간이 끝없이 커지는 것을 막습니다.

현재 `OutboxEvent`의 상태와 운영 관련 컬럼은 다음과 같습니다.

| 구분 | 값 또는 컬럼 | 역할 |
|---|---|---|
| 상태 | `PENDING` | 최초 발행 또는 재시도를 기다림 |
| 상태 | `PUBLISHED` | Kafka 발행을 마침 |
| 상태 | `FAILED` | 최대 실패 횟수에 도달해 격리됨 |
| 식별 | `eventId`, `eventType`, `topic`, `partitionKey` | 이벤트와 발행 목적지를 식별 |
| 본문 | `payload` | `DomainEvent` 전체 봉투 |
| 재시도 | `attempts`, `nextAttemptAt`, `lastError` | 횟수, 다음 가능 시각, 최근 원인 기록 |
| 시각 | `createdAt`, `publishedAt`, `failedAt` | 생성·발행·격리 시점 기록 |
| 추적 | `traceContext` | 지연 발행 뒤에도 원래 trace를 이어가기 위한 정보 |

격리는 자동 복구가 아닙니다. **replay**는 격리한 이벤트를 다시 처리 대기 상태로 돌리는 기능입니다. 현재 구현 범위에는 `FAILED → PENDING` replay가 없습니다. 운영자가 원인을 조사한 뒤 다시 처리하는 절차는 별도로 필요합니다.

## 실제 관측과 해석

로컬 통제 실험에서는 outbox-relay를 멈춘 상태로 게시글 작성 요청 62건을 성공시켰습니다. `PENDING` 지표는 최대 60까지 증가했고 `FAILED`는 0을 유지했습니다. relay를 다시 시작하자 약 7초 안에 `PENDING`이 0으로 줄었습니다.

이 결과는 relay가 멈춘 동안 이벤트가 DB에 대기하고, 재시작 뒤 처리되는 흐름을 보여줍니다. 다만 로컬 단일 머신에서 수행한 통제 실험이며, 프로덕션 처리량이나 복구 시간의 보장값으로 일반화할 수는 없습니다.

## 장단점과 실무 고려사항

Transactional Outbox의 장점은 DB 변경과 발행 의도를 같은 원자성 경계에 둔다는 점입니다. Kafka 장애 중에도 발행할 이벤트가 DB에 남습니다. 여러 relay의 경합은 `FOR UPDATE SKIP LOCKED`로 줄이고, 중복 발행은 소비자 멱등성으로 흡수합니다. 지수 백오프와 `FAILED` 격리는 영구 실패가 정상 흐름의 자원을 계속 차지하는 일을 제한합니다.

그 대가도 분명합니다. 폴링 주기만큼 발행 지연이 추가되고, `PUBLISHED` 행의 보존 정책이 필요합니다. relay의 DB 트랜잭션 안에 외부 Kafka 발행이 포함돼 트랜잭션이 길어질 수 있습니다. DLQ에 격리된 행을 조사하고 replay하는 운영 절차도 아직 없습니다.

채팅과 게시글의 대비는 패턴 선택의 기준을 보여줍니다. 지연을 우선한 채팅에는 직접 발행을 유지해 유실 창을 감수했고, 후속 이벤트 정합성을 우선한 게시글에는 Outbox를 적용했습니다. 실무에서는 모든 경로에 같은 패턴을 일괄 적용하기보다, 유실 비용·허용 지연·복구 절차를 함께 놓고 원자성 경계를 결정해야 합니다.

---

이 글의 예시 구현은 다음 저장소에서 확인할 수 있습니다: https://github.com/Jin-dev92/estate-server
