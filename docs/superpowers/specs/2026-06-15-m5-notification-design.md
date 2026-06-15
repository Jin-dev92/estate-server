# M5: notification-worker + 다중 컨슈머 그룹 팬아웃 — 설계 스펙

> **상위 설계:** [building-owner-platform-design](2026-06-11-building-owner-platform-design.md) §3.3(알림), §4(팬아웃), §6(마일스톤 M5)
> **선행:** M3(Kafka 도입·audit-worker), M4(채팅·persistence-worker·Redis pub/sub)

## 1. 목표

도메인 이벤트 1건을 **3개의 독립 컨슈머 그룹**(persistence · notification · audit)이 각각 한 번씩 소비하는 **진짜 팬아웃**을 완성한다. 이를 위해 기존 단일 hybrid 프로세스(groupId `audit-worker` 하나에 persistence·audit 핸들러가 얹힌 구조)를 **워커별 엔트리포인트로 분리**하고, 신규 **notification-worker**가 이벤트를 받아 `Notification`을 적재하고 접속 중인 수신자에게 WS로 푸시하며 Redis 원자적 카운터로 미읽음 수를 관리한다.

**성공 기준**
- `chat-events`/`board-events` 발행 1건이 persistence·notification·audit **세 그룹에 각각 독립적으로** 소비된다(같은 이벤트를 그룹별로 한 번씩).
- `MessageSent`·`CommentCreated`·`PostCreated` 발생 시 수신자별 `Notification` 행이 생성되고, 접속 중이면 `/notifications` WS로 실시간 푸시된다.
- 미읽음 수가 Redis 원자적 카운터로 증가하고, 전체 읽음 처리 시 0으로 리셋된다.
- Kafka at-least-once로 같은 이벤트가 중복 소비돼도 알림 행·카운터가 중복되지 않는다(멱등).

## 2. 비범위 (YAGNI)

- **멤버십 이벤트 알림**(TenantJoined/LeaseEnded) — 이번 범위 제외.
- **단건 읽음 처리**(`PATCH /notifications/:id/read`) — 전체 읽음만 둔다.
- **외부 푸시**(FCM/Web Push) — 인앱 + WS로 충분(상위 설계 §8.2).
- **알림 환경설정/필터·페이지네이션 커서** — 단순 최신순 목록으로 충분.

---

## 3. 아키텍처

### 3.1 프로세스 토폴로지

```
main.ts                                   HTTP API + WebSocket(gateway) + Kafka producer  (consumer 없음)
src/workers/persistence-worker.main.ts    groupId: persistence-worker   ← chat-events                  → Message
src/workers/audit-worker.main.ts          groupId: audit-worker         ← chat+board+membership(전체)  → AuditLog
src/workers/notification-worker.main.ts   groupId: notification-worker  ← chat-events + board-events   → Notification
```

- 각 워커는 `NestFactory.createMicroservice<MicroserviceOptions>`(Kafka transport, `consumer.groupId` 1개)로 부팅하고 **자기 워커 모듈만** 임포트한다 → `@EventPattern` 핸들러가 그룹 간 중복 등록되지 않는다(NestJS hybrid의 핸들러 전역 등록 한계 회피).
- **토픽 사전생성**: 각 엔트리포인트가 부팅 시 `KafkaTopicInitializer.ensureTopics()`를 `startAllMicroservices()`/`listen()` 전에 await한다. `ensureTopics()`는 `listTopics()` 차집합만 생성하므로 멱등 — 여러 프로세스가 동시에 호출해도 안전하다(이미 존재 시 스킵, race로 동시 생성돼도 kafkajs가 "already exists"를 흡수).
- **기존 교정**: 현재 persistence 핸들러(`ChatPersistenceController`)와 audit 핸들러가 같은 `audit-worker` 그룹에 있다. persistence를 독립 그룹 `persistence-worker`로 분리하고, audit-worker는 스펙대로 **전체 3토픽**(chat 포함)을 구독하도록 chat-events 핸들러를 추가한다.

### 3.2 실행/스크립트

docker-compose는 인프라(postgres·redis·kafka)만 띄우고 앱은 로컬에서 구동한다. 워커는 각자 별도 Node 프로세스다.

`package.json` 스크립트 추가:
```jsonc
"start:worker:persistence":  "nest start --entryFile workers/persistence-worker.main",
"start:worker:audit":        "nest start --entryFile workers/audit-worker.main",
"start:worker:notification": "nest start --entryFile workers/notification-worker.main",
// 운영 빌드 후
"start:prod:persistence":    "node dist/workers/persistence-worker.main",
"start:prod:audit":          "node dist/workers/audit-worker.main",
"start:prod:notification":   "node dist/workers/notification-worker.main"
```
dev에서는 터미널 4개(main + 워커 3개) 또는 `--watch`로 구동한다.

### 3.3 워커 부트스트랩 공통 형태

```ts
// src/workers/<name>-worker.main.ts (예시 — 실제 코드는 구현 계획서)
async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(<WorkerModule>, {
    transport: Transport.KAFKA,
    options: {
      client: { brokers: <ConfigKey.KafkaBrokers split ','> },
      consumer: { groupId: '<groupId>' },
    },
  });
  await app.get(KafkaTopicInitializer).ensureTopics(); // consumer 구독 전 토픽 보장
  await app.listen();
}
```

각 `<WorkerModule>`은 ConfigModule(global) + PrismaModule + (필요 시 RedisModule) + 해당 도메인 워커 모듈을 임포트한다. `KafkaTopicInitializer`는 `KafkaModule`(또는 별도 export)에서 제공한다.

---

## 4. 알림 도메인 (`src/notification/`)

기존 DDD 레이어 컨벤션을 그대로 따른다.

```
src/notification/
  domain/
    notification.entity.ts          # Notification 도메인 엔티티(create/reconstitute)
    notification-type.enum.ts       # NotificationType const enum
    notification.repository.ts      # NOTIFICATION_REPOSITORY 포트
    notification-counter.ts         # NOTIFICATION_COUNTER 포트
    notification-relay.ts           # NOTIFICATION_RELAY 포트(WS 푸시용 pub/sub)
    recipient-resolver.ts           # RECIPIENT_RESOLVER 포트
  application/
    handle-event.use-case.ts        # 이벤트 → 수신자 해석 → N건 적재(멱등) → INCR → push
    list-notifications.use-case.ts  # 내 알림 목록(최신순)
    get-unread-count.use-case.ts    # 미읽음 수
    mark-all-read.use-case.ts       # 전체 읽음 + 카운터 reset
  infrastructure/
    prisma-notification.repository.ts
    redis-notification-counter.ts
    redis-notification-relay.ts
    prisma-recipient-resolver.ts
  interface/
    notification-worker.controller.ts  # @EventPattern chat-events + board-events → handle-event
    notification.controller.ts          # HTTP 읽기/읽음 API (main 프로세스)
    notification.gateway.ts             # WS namespace '/notifications' (main 프로세스)
    dto/...
  notification.module.ts                # HTTP/WS + 읽기 유스케이스 (AppModule이 임포트)
  notification-worker.module.ts         # worker controller + handle-event + resolver (워커 엔트리포인트가 임포트)
```

공유 프로바이더(repository·counter·relay·NotificationType)는 양쪽 모듈이 함께 쓰므로 중복 없이 구성한다(워커 모듈은 HTTP/WS 컨트롤러를 포함하지 않고, HTTP 모듈은 worker 컨트롤러를 포함하지 않는다).

### 4.1 데이터 모델 (Prisma)

```prisma
model Notification {
  id          String    @id @default(cuid())
  recipientId String
  type        String    // NotificationType 값
  title       String
  body        String?
  entityType  String    // EntityType 값(Post/Comment/Message)
  entityId    String
  eventId     String    // 원천 도메인 이벤트 id(멱등 키 일부)
  readAt      DateTime?
  createdAt   DateTime  @default(now())

  @@unique([eventId, recipientId])  // 같은 이벤트→같은 수신자 중복 방지(멱등)
  @@index([recipientId, readAt])    // 목록·미읽음 조회
}
```

`NotificationType` (const enum): `MessageReceived` · `CommentAdded` · `PostAdded`.

---

## 5. 수신자 해석 & 멱등 소비

`RECIPIENT_RESOLVER.resolve(event: DomainEvent): Promise<string[]>` — 이벤트 타입별로 수신자 userId 목록을 반환한다(Prisma 읽기).

| 이벤트 | 해석 | 제외 |
|---|---|---|
| `MessageSent` | `payload.roomId`로 ChatRoom 조회 → `[ownerId, tenantId]` | `payload.senderId` |
| `CommentCreated` | `payload.postId`로 Post 조회 → `[authorId]` | `event.actorId`(댓글 작성자) |
| `PostCreated` | `payload.buildingId`로 멤버 집합: `building.ownerId` + ACTIVE 리스 입주자(`Lease.status=ACTIVE && unit.buildingId=…`의 `tenantId`) | `event.actorId`(글 작성자) |

- 대상 엔티티가 없거나(예: 방·글 삭제) 수신자가 0명이면 알림을 만들지 않는다.

**멱등 처리(at-least-once 대응)** — `handle-event` 유스케이스:
1. 수신자 목록을 해석한다.
2. 수신자별로 `Notification` 행 insert를 시도한다.
   - 성공 → 그 수신자에 한해 **카운터 INCR + relay.push** 수행.
   - Prisma `P2002`(unique 위반) → 이미 처리된 수신자 → **스킵**(카운터 증가·push 없음).
3. `@@unique([eventId, recipientId])`가 중복 소비 시 카운터 이중 증가를 차단한다.

---

## 6. WS 푸시 · 미읽음 카운터 · API

### 6.1 WS 푸시 (프로세스 간 브리지)

워커(별도 프로세스)는 소켓에 직접 emit할 수 없으므로 Redis pub/sub로 main의 gateway에 브리지한다(채팅과 동일 패턴).

- **채널 `notifications`**: 워커가 알림 1건당 `relay.publish({ recipientId, notification })`.
- **NotificationGateway** (`@WebSocketGateway({ namespace: 'notifications', cors: true })`, main 프로세스):
  - 핸드셰이크 `auth.token` JWT 검증(ChatGateway와 동일 방식), 검증 후 소켓을 `user:{userId}` 룸에 join.
  - `onModuleInit`에서 Redis `notifications` 채널 구독 → 수신 시 `server.to('user:'+recipientId).emit('notification', payload)`.
  - 수신자 미접속이면 자연스럽게 no-op(행·카운터는 DB/Redis에 남아 다음 접속 시 조회).
- 채팅과 namespace를 분리(`/notifications`)해 핸들러 간섭을 막고 관심사를 분리한다.

### 6.2 미읽음 카운터 (Redis 원자적)

- 키 `notif:unread:{userId}`.
- 새 알림 행 insert 성공 시 `INCR`.
- 전체 읽음 처리 시 `DEL`(= 0).
- 조회는 `GET`(없으면 0).

### 6.3 HTTP API (main, 모두 인증 필요·본인 한정)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `GET /notifications` | 내 알림 목록(최신순) | 인증(본인) |
| `GET /notifications/unread-count` | 미읽음 수(Redis 카운터) | 인증(본인) |
| `PATCH /notifications/read` | 전체 읽음 — 내 미읽음 행 `readAt`=now + 카운터 reset | 인증(본인) |

- 목록 조회는 카운터를 리셋하지 않는다(클라이언트가 명시적으로 `PATCH /notifications/read` 호출).
- Swagger 데코레이터(`@ApiTags`/`@ApiOperation`/`@ApiResponse` + `@ApiBearerAuth`)와 4xx `ErrorResponseDto` 표기는 프로젝트 규칙대로 단다.

---

## 7. 이벤트/토픽 매핑 (변경 없음 + 구독 확장)

기존 발행 측(M3/M4)은 그대로 사용한다. 구독만 다음과 같이 구성한다.

| 컨슈머 그룹 | 구독 토픽 | 산출 |
|---|---|---|
| persistence-worker | chat-events | `Message` INSERT(멱등) |
| notification-worker | chat-events, board-events | `Notification` 적재 + WS 푸시 |
| audit-worker | chat-events, board-events, membership-events | `AuditLog` 적재(멱등) |

`KAFKA_TOPIC_SPECS`/토픽 목록 변경 없음(이미 3토픽 사전생성).

---

## 8. 에러 처리

- 워커 컨슈머는 멱등 설계이므로 처리 실패 시 예외를 던져 Kafka 재시도에 맡길 수 있으나, **부분 성공(N 수신자 중 일부 적재 후 실패)** 시 재소비가 이미 적재된 수신자는 `P2002`로 스킵하므로 안전하다.
- `relay.publish`(WS 브리지)는 부가 기능이라 실패가 적재를 막지 않도록 처리 흐름에서 분리한다(적재·카운터가 진실 원천, push는 best-effort).
- HTTP API의 4xx는 M2.5 에러 봉투(`ErrorResponseDto`) 계약을 따른다.

## 9. 테스트

- **단위**
  - `recipient-resolver`: 이벤트 3종 각각의 수신자 해석(작성자/발신자 제외, 멤버 집합, 대상 없음 케이스).
  - `handle-event`: N 수신자 팬아웃, 멱등(P2002 → 카운터 미증가·push 없음), 수신자 0명 → no-op.
  - `notification-counter`: INCR/GET/DEL.
  - `list/get-unread-count/mark-all-read` 유스케이스.
  - `notification.gateway`: 핸드셰이크 인증·user 룸 join, relay 수신 → emit.
- **회귀**: persistence/audit 워커는 동작 보존(그룹만 분리, audit는 chat 구독 추가분 핸들러 테스트).

## 10. 알려진 한계 / 후속

- **이벤트 유실(dual-write)**: after-commit 발행 한계 → M6 Transactional Outbox.
- **단일 pub/sub 채널**: 트래픽 증가 시 사용자별/샤드 채널 분리는 후속 과제.
- **PostCreated 1:N 팬아웃**: 멤버 수가 큰 건물에서 알림 N건 생성 비용 — 현재 동기 생성. 대량 건물은 배치/비동기화가 후속 과제.
