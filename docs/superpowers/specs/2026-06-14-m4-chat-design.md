# M4 — 1:1 채팅(WebSocket) + Redis pub/sub + persistence-worker 설계 스펙

> 작성일: 2026-06-14 · 상태: 설계 확정(구현 계획 미착수)
> 성격: 실시간 전달(WS + Redis pub/sub)과 비동기 영속화(Kafka persistence-worker)를 분리한 채팅 파이프라인.
> 선행: M3(Kafka + audit-worker) 머지. 브랜치: `dev`에서 `feat/m4-chat` 분기.
> 관련: [전체 설계 스펙 §3.2](2026-06-11-building-owner-platform-design.md) · [M3 스펙](2026-06-14-m3-kafka-audit-design.md) · [README §6 마일스톤 M4](../../../README.md)

---

## 0. 목적

건물주 ↔ 특정 입주자 간 **1:1 실시간 채팅**을 구현한다. 핵심 학습 목표는 **WebSocket + Redis pub/sub + Kafka의 통합**, 그리고 "실시간 전달"과 "영속화"를 분리하는 설계다.

- **실시간 전달:** WS Gateway가 메시지를 받아 Redis pub/sub로 즉시 중계 → DB를 기다리지 않아 체감 지연이 낮다. Redis pub/sub가 멀티 인스턴스 간 중계를 담당해, 상대가 어느 인스턴스에 붙어 있든 전달된다.
- **비동기 영속화:** 메시지마다 동기 INSERT 대신 Kafka `chat-events`를 **쓰기 버퍼**로 두고, persistence-worker가 비동기로 단건 멱등 INSERT한다. 같은 방 메시지의 순서는 `roomId`를 파티션 키로 써서 보장한다.

---

## 1. 현황 & 문제

- 채팅 관련 코드·모델(`ChatRoom`/`Message`)·WebSocket 게이트웨이가 **전무**하다.
- M3에서 Kafka 인프라(`KafkaModule`, `EventPublisher`, `KafkaTopicInitializer`로 토픽 사전 생성, `@EventPattern` consumer 패턴)와 audit-worker가 갖춰졌다. M4는 이를 재사용한다.
- Redis는 캐시·초대코드 TTL에 쓰이고 있으나(`RedisService`), **pub/sub는 아직 사용 안 함** — M4에서 처음 도입한다.
- 인증은 HTTP `JwtAuthGuard`만 있고 **WebSocket용 인증은 없다**.

---

## 2. 설계 결정 (트레이드오프)

1. **파이프라인 4단계 전부 구현.** WS Gateway → Redis pub/sub 실시간 중계 → Redis 최근메시지 캐시(capped list) → Kafka `chat-events` → persistence-worker DB 적재. M4 학습 목표(WS+Redis+Kafka 통합)를 온전히 커버한다.

2. **WebSocket: socket.io (`@nestjs/websockets` 기본).** 로컬 room·ack·재연결이 채팅에 편리하고 자료가 풍부하다. **단 `socket.io-redis-adapter`는 쓰지 않고** Redis pub/sub를 직접 브리지한다 — 인스턴스 간 중계를 직접 구현하는 것이 M4 학습의 핵심이기 때문.

3. **Redis pub/sub: 단일 채널 `chat:messages`.** 모든 인스턴스가 이 채널 하나를 구독하고, 수신 payload의 `roomId`로 자기 인스턴스 로컬 room에 emit한다.
   - *근거:* 방별 채널은 인스턴스가 "자기 소켓이 있는 방만" 동적 구독·해지해야 해 복잡하다. 단일 채널은 모두가 모든 메시지를 받아 `roomId`로 필터링만 하면 돼 단순하다(학습 환경 인스턴스 수에 충분).
   - *트레이드오프:* 인스턴스 수·트래픽이 커지면 비효율 → 방별/샤드 채널 분리가 후속 최적화.
   - 송신 인스턴스도 자기 구독으로 받아 emit하므로 **전송 경로가 pub/sub 하나로 일관**(직접 emit과 중복 없음).

4. **영속화: 단건 멱등 INSERT (배치 아님).** persistence-worker가 `chat-events`를 단건 소비해 `Message`를 INSERT한다. `Message.id = messageId(uuid)`를 PK 겸 멱등 키로 써서 중복(P2002)을 무시한다(M3 audit-worker와 동일 패턴).
   - *근거:* "Kafka를 쓰기 버퍼로 두어 동기 INSERT를 분리"하는 핵심 의도는 단건으로도 달성된다. 배치(개수/시간 기반 flush)는 복잡도가 커 보류(후속 최적화).

5. **채팅방: 독립 `ChatRoom` 엔티티.** `(buildingId, ownerId, tenantId)`, `(buildingId, tenantId)` unique → 건물당 건물주↔입주자 1:1 방 하나. lease 상태와 독립이라 입주 종료 후에도 대화 이력이 유지된다.

6. **audit-worker는 `chat-events`를 구독하지 않음.** 채팅 메시지는 양이 많고 "도메인 변경 이벤트"가 아니라 데이터다. AuditLog 대상에서 제외하고 영속화는 persistence-worker가 담당한다. M3 audit-worker는 board/membership만 유지.

7. **Gateway는 얇게, 로직은 유스케이스.** `ChatGateway`는 인증·라우팅(transport)만 맡고, 메시지 처리 로직은 `SendMessageUseCase`에 둔다. 핵심 흐름을 Gateway 없이 단위 테스트할 수 있다.

---

## 3. 데이터 모델 (신규)

```prisma
model ChatRoom {
  id         String    @id @default(cuid())
  buildingId String
  ownerId    String    // 건물주
  tenantId   String    // 입주자
  createdAt  DateTime  @default(now())
  messages   Message[]
  @@unique([buildingId, tenantId]) // 건물당 건물주↔입주자 1:1 방
}

model Message {
  id        String   @id            // = 앱이 생성한 messageId(uuid). PK 겸 멱등 키
  roomId    String
  room      ChatRoom @relation(fields: [roomId], references: [id])
  senderId  String
  content   String
  createdAt DateTime @default(now())
  @@index([roomId, createdAt])      // 히스토리 조회(최신순)
}
```
- 마이그레이션: `prisma migrate dev --name add_chat`.
- `Message.id`는 DB 기본값(`cuid`)이 아니라 **앱이 생성한 uuid**를 그대로 넣는다(발행 측 messageId와 영속화 측 PK가 동일해야 멱등).

---

## 4. 메시지 전송 흐름 (WS Gateway → 4단계)

클라가 `message {roomId, content}`를 보내면 `SendMessageUseCase`가:
```
1) socket.userId가 그 방 참가자(ownerId/tenantId 중 하나)인지 검증
   + messageId(uuid)·occurredAt 생성
2) MessageRelay.publish → Redis 단일 채널 'chat:messages' (payload: {roomId, messageId, senderId, content, createdAt})
3) MessageCache.push → Redis capped list 'chat:room:{roomId}:recent' (LPUSH + LTRIM 0 N-1)
4) EventPublisher.publish → Kafka 'chat-events' MessageSent (파티션 키 = roomId)
```
- **DB INSERT를 기다리지 않는다.** 영속화는 4)를 거쳐 persistence-worker가 비동기 수행.
- 발행 실패(Kafka)는 M3 `KafkaEventPublisher`가 내부에서 삼킨다(after-commit 한계 → M6 Outbox).

### 4.1 Redis pub/sub 중계 (인스턴스 간)
- 모든 인스턴스가 부팅 시 `chat:messages`를 **1회 구독**(연결마다가 아님).
- 수신 시 payload의 `roomId`로 `server.to(roomId).emit('message', payload)` → 그 인스턴스에서 해당 room에 `join`한 소켓들에 전달.
- 송신 인스턴스도 자기 구독으로 받아 emit하므로 경로가 일관된다.

### 4.2 Redis 최근메시지 캐시
- 키 `chat:room:{roomId}:recent`, `LPUSH` 후 `LTRIM 0 N-1`로 최근 N개 유지(capped list).
- 히스토리 조회는 이 캐시를 우선 사용하고, 더 과거는 DB로 폴백.

---

## 5. WebSocket 인증 & 방 참여

- **인증:** socket.io 핸드셰이크의 `auth.token`(JWT)을 `WsJwtGuard`/`handleConnection`에서 검증(기존 JWT 검증 로직 재사용). 성공 시 `socket.data.userId` 저장, 실패 시 즉시 `disconnect`.
- **방 참여:** 클라 `join {roomId}` → 그 방 참가자인지 검증 → `socket.join(roomId)`(로컬 room). 비참가자는 거부.
- **WS 에러:** 인증 실패는 disconnect, 권한 없는 참여/전송은 에러 이벤트로 응답(연결 유지).

---

## 6. HTTP API (방·히스토리)

모두 `JwtAuthGuard` 보호. Swagger 데코레이터 필수(README 표 + 데코레이터 병행).

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `POST /chat/rooms` | 방 생성/ensure(`{buildingId, tenantId}`) | 호출자가 그 건물 OWNER **또는** 그 건물 ACTIVE 입주자 |
| `GET /chat/rooms` | 내 방 목록(본인이 참가자인 방) | 인증 |
| `GET /chat/rooms/:id/messages` | 메시지 히스토리(최신순, `limit`/커서) | 방 참가자 |

- **방 생성(ensure):** 입주자는 본인이 그 `buildingId`에 ACTIVE `Lease`가 있어야, 건물주는 그 건물 소유자여야 한다. `(buildingId, tenantId)`가 없으면 생성, 있으면 기존 방 반환.
- **히스토리:** Redis `recent` 캐시 우선, 더 과거 요청 시 DB(`@@index([roomId, createdAt])`)로 폴백.

---

## 7. Kafka / 이벤트 통합 (M3 인프라 재사용)

- `EventType.MessageSent`, `EntityType.Message`, `KafkaTopic.ChatEvents`(`'chat-events'`) 추가.
- `KAFKA_TOPIC_SPECS`에 `chat-events`(파티션 3, 복제 1) 추가 → `KafkaTopicInitializer`가 부팅 시 자동 생성.
- 발행은 M3 `EventPublisher` 재사용. `MessageSent`의 `entityId = roomId`라 파티션 키가 `roomId`가 되어 방 내 순서가 보장된다(`TOPIC_BY_EVENT`에 `MessageSent→ChatEvents` 매핑 추가).
- **persistence-worker:** `@EventPattern(KafkaTopic.ChatEvents)`(consumer group `persistence-worker`) → `MessageRepository.persist`(멱등: `Message.id = messageId`, 중복 P2002 무시).

---

## 8. 모듈 구조 (`src/chat/`)

DDD 레이어 + 기존 패턴 준수:
- **domain:** `ChatRoom`/`Message` 엔티티, `ChatRoomRepository`/`MessageRepository` 포트, `MessageRelay`(pub/sub)·`MessageCache`(recent) 포트
- **application:** `SendMessageUseCase`(§4), `EnsureRoomUseCase`, `ListRoomsUseCase`, `GetMessagesUseCase`
- **infrastructure:** `PrismaChatRoomRepository`/`PrismaMessageRepository`, `RedisMessageRelay`(pub/sub), `RedisMessageCache`(LPUSH/LTRIM), persistence consumer
- **interface:** `ChatGateway`(WS, transport only), `ChatController`(HTTP), `WsJwtGuard`

> `ChatGateway`는 인증·라우팅만, 비즈니스 로직은 유스케이스에 둔다.

---

## 9. 에러 처리 & 테스트

### 에러 처리
- Kafka 발행 실패: `KafkaEventPublisher` 내부 삼킴(M3).
- persistence 중복(P2002): 무시(멱등). 그 외 예외: throw해 Kafka 재시도.
- WS: 인증 실패 disconnect, 권한 위반은 에러 이벤트.

### 테스트 (단위, mock)
- `SendMessageUseCase`: relay·cache·events 호출 검증 + 비참가자 거부.
- `EnsureRoomUseCase`: 입주자/건물주 권한, ensure 멱등(기존 방 반환).
- `GetMessagesUseCase`: 캐시 우선 → DB 폴백.
- persistence consumer: 정상 적재 + 중복 P2002 무시.
- `RedisMessageCache`: LPUSH+LTRIM 호출, `RedisMessageRelay`: publish/subscribe 경로.
- Gateway·실제 Redis pub/sub·Kafka 왕복: 수동 e2e.

---

## 10. 성공 기준

- [ ] `ChatRoom`/`Message` 모델 + 마이그레이션.
- [ ] socket.io `ChatGateway`: 핸드셰이크 JWT 인증, `join` 권한 검증, `message` 수신.
- [ ] 메시지 전송 시 Redis pub/sub 중계 + capped list 캐시 + Kafka `chat-events` 발행(4단계).
- [ ] 다른 인스턴스(혹은 다른 소켓)에서 같은 방 메시지를 실시간 수신.
- [ ] persistence-worker가 `chat-events`를 소비해 `Message`를 멱등 INSERT(중복 무시).
- [ ] `POST/GET /chat/rooms`, `GET /chat/rooms/:id/messages` 동작(권한·캐시/DB 폴백).
- [ ] 단위테스트 통과(유스케이스·persistence 멱등·캐시), 기존 테스트 무회귀.

---

## 11. 범위 밖 (명시)

- **notification-worker / 미읽음 카운트** → M5.
- **메시지 자동 번역** → 추후(F2).
- **배치 INSERT·방별 pub/sub 채널 샤딩** → 후속 최적화.
- **이벤트 유실 방지(Outbox)** → M6.
- 메시지 수정/삭제, 읽음 표시, 타이핑 인디케이터, 파일 첨부 → 1차 범위 밖.
