# 건물주 플랫폼 설계 스펙

> 작성일: 2026-06-11 · 상태: 설계 확정 (구현 계획 미착수)
> 성격: 개인 학습 프로젝트 (Kafka · Redis · Prisma 숙련 목적), 향후 상용화 가능성 열어둠
> 설계 결정의 **근거·트레이드오프 요약**은 [README의 "주요 설계 결정" 섹션](../../../README.md#5-주요-설계-결정트레이드오프)에 정리했다. 이 문서는 **결정과 구조 자체**에 집중하고, 더 깊은 맥락은 README를 함께 본다.

---

## 0. 이 문서의 목적

건물주와 입주자를 잇는 커뮤니케이션 플랫폼을 만든다. 단, 1차 목표는 제품이 아니라 **세 가지 인프라 기술의 체득**이다: Prisma(ORM/마이그레이션), Redis(캐시·pub/sub·TTL·rate limit), Kafka(이벤트 스트리밍·팬아웃). 따라서 설계 판단의 우선순위는 "최소 비용으로 빠르게 출시"가 아니라 **"각 기술의 핵심 개념을 자연스럽게 연습할 수 있는가"** 에 둔다. 이 기준이 아래 모든 트레이드오프 결정의 배경이다.

**아키텍처/스택 전제**
- **아키텍처: DDD(도메인 주도 설계)** 의 레이어드 구조를 따른다 — 상세는 5절.
- **데이터베이스: PostgreSQL** (Prisma를 통해 접근). 단일 RDB로 시작한다.

---

## 1. 기술-역할 매핑

| 기술 | 담당 영역 | 왜 여기서 쓰는가 |
|---|---|---|
| **Prisma** | Postgres 스키마, 마이그레이션, 전 영속화 | 관계형 모델링·마이그레이션 워크플로우 학습. 타입 안전 쿼리. |
| **Redis** | 게시판·채팅 캐시, WS 실시간 pub/sub, 초대코드 TTL, rate limit, 미읽음 카운트 | 캐시 무효화·휘발성 데이터·원자적 카운터·채널 fan-out 등 Redis의 대표 용례를 한 프로젝트에서 모두 경험. |
| **Kafka** | 도메인 이벤트 발행 → 소비자 3종(영속화·알림·감사) 팬아웃, 채팅 쓰기 버퍼 | "이벤트 1건을 여러 소비자가 독립 소비"하는 이벤트 드리븐 아키텍처의 핵심을 연습. |

---

## 2. 도메인 모델

핵심 골격: `Owner → Building → Unit → Lease(Tenant)`. 입주자는 **건물주가 발급한 초대코드**로 호실에 연결된다.

```
User        (id, email, passwordHash, name, role: OWNER|TENANT|ADMIN)
Building    (id, ownerId→User, name, address)
Unit        (id, buildingId→Building, name(호수), floor)
Lease       (id, unitId→Unit, tenantId→User, status: ACTIVE|ENDED, start/endDate)
InviteCode  (id, code, unitId→Unit, issuedBy→User, expiresAt, usedAt, usedById)
Post        (id, buildingId→Building, authorId→User, category, title, content)
Comment     (id, postId→Post, authorId→User, content)
ChatRoom    (id, buildingId, participantAId, participantBId)
Message     (id, roomId→ChatRoom, senderId→User, content, readAt)
Notification(id, userId→User, type, payload(JSON), readAt)
AuditLog    (id, eventType, actorId, entityType, entityId, payload(JSON))
```

### 핵심 결정 (근거·트레이드오프 요약은 [README](../../../README.md#5-주요-설계-결정트레이드오프) 참고)

- **건물→호실→입주 3계층** — 호실 단위 점유·소통("특정 호실에만 보이는 공지")을 표현하기 위해. 2계층/Workspace 추상화 대비.
- **입주 연결은 초대코드** — 신청/승인 상태머신 없이 단순하고 Redis TTL(코드 만료) 학습을 끼움. 코드 사용 시 `TenantJoined` 이벤트 발행.
- **게시판은 건물 단위 스코프** — "같은 건물 입주자 소통" 시나리오에 맞고 캐시 키 설계(`board:building:{id}`)가 깔끔.

---

## 3. 기능별 설계

### 3.1 게시판
건물 단위로 글·댓글 작성. 목록/상세는 Redis **read-through 캐시**, 쓰기 시 해당 키 무효화(+짧은 TTL 안전망). 글 작성 시 `PostCreated` 이벤트 발행(→ 같은 건물 멤버 알림 + 감사로그).

### 3.2 1:1 채팅 (WebSocket)
건물주 ↔ 특정 입주자 간 1:1. NestJS WebSocket Gateway 사용. 메시지 처리 흐름:

```
클라 →(WS)→ Gateway
   1) 인증 + 방 참여 권한 검증, 메시지 ID 생성
   2) Redis pub/sub 즉시 발행 → 상대 instance Gateway가 실시간 전달   (DB를 기다리지 않음)
   3) Redis 최근 메시지 리스트에 push (capped list, 캐시)
   4) Kafka `chat-events` 토픽에 MessageSent 발행                      (영속화·알림·감사는 비동기)
```

- **핵심 설계 의도:** 실시간 전달(Redis pub/sub, 낮은 지연)과 영속화(Kafka 비동기 흡수)를 **분리**한다. 메시지마다 동기 INSERT 대신 Kafka를 **쓰기 버퍼**로 둔다. Redis pub/sub는 멀티 인스턴스 간 메시지 중계로 어느 인스턴스에 붙어 있든 전달을 보장한다.
- **순서 보장(설계 제약):** Kafka는 파티션 내 순서만 보장하므로, 같은 방 메시지가 순서대로 영속화되려면 `roomId`를 파티션 키로 쓴다.

> **번역 범위 메모:** 입주자 중 외국인이 있을 수 있어 **메시지 자동 번역**을 염두에 둔다. 단 1차 범위 밖이며 **추후 개발**로 분리한다(8절 참고).

### 3.3 알림
notification-worker(Kafka 소비자)가 이벤트를 받아 `Notification` 행 생성. 수신자가 **접속 중이면** Redis pub/sub → WS로 즉시 푸시, **미접속이면** 미읽음 카운트(Redis 원자적 INCR) 증가 후 다음 접속 시 조회. 외부 푸시(FCM/Web Push)는 1차 범위 밖(8.2절).

---

## 4. Kafka 토픽 & 소비자 (팬아웃 핵심)

```
토픽
  chat-events        : MessageSent
  board-events       : PostCreated, CommentCreated
  membership-events  : TenantJoined, LeaseEnded

소비자 그룹 (각각 독립 컨슈머 그룹 → 같은 이벤트를 중복 없이 그룹별로 한 번씩 소비)
  persistence-worker : chat-events 구독        → Message 배치 INSERT (쓰기 버퍼)
  notification-worker: chat/board/membership   → Notification 생성 + WS 푸시
  audit-worker       : 전체 구독               → AuditLog 적재
```

- **소비자 도입 순서(중요):** 부작용 없는 **audit-worker를 먼저** 붙여 producer/consumer 왕복을 익힌 뒤, persistence(쓰기) → notification(부작용 있는 쓰기) 순으로 난이도를 올린다.
- **메시지 브로커 선택:** **Apache Kafka(Confluent `cp-kafka` 이미지, KRaft 모드)** 로 확정. 학습·현업 전이성(파티션·ISR·컨슈머 그룹 등 브로커 동작과 설정이 MSK/Confluent에 1:1로 적용)과 생태계(Connect·Schema Registry)를 우선했다. Kafka 호환 재구현체 Redpanda는 더 가볍지만 "진짜 Kafka"가 아니라 제외. KRaft 덕분에 ZooKeeper 없이 단일 컨테이너로 띄운다(단일 노드라 복제 계수·ISR=1).
- **멱등 소비 필수(설계 제약):** Kafka는 at-least-once라 중복 소비가 가능하므로 소비자는 메시지 ID 기준 upsert·중복 방지 키 등으로 **멱등하게** 설계한다.

### 발전 방향 (선택, 여유 시)
**Transactional Outbox 패턴** — DB 트랜잭션 안에서 도메인 변경과 `outbox` 행을 함께 커밋하고, relay가 outbox를 읽어 Kafka에 발행. "DB엔 썼는데 이벤트 발행은 실패"하는 dual-write 불일치를 제거한다. 실무 가치가 가장 높은 주제라 2차 목표로 명시해 둔다.

---

## 5. 아키텍처 (DDD) · 서비스 토폴로지 · 모듈 구조

아키텍처는 **DDD 레이어드 구조**를 따른다. 프로세스는 **단일 NestJS 하이브리드 앱**(HTTP API + WebSocket + Kafka 컨슈머가 같은 프로세스)으로 시작한다. 이 둘은 직교한다 — DDD는 코드를 어떻게 계층화하는가, 하이브리드 앱은 어떤 프로세스로 띄우는가의 문제다.

### 5.1 바운디드 컨텍스트

도메인을 다음 컨텍스트로 가른다. 각 컨텍스트가 하나의 NestJS 모듈 묶음이 된다.

```
Auth        : User, 인증, 역할(RBAC)
Property        : Building, Unit, Lease, InviteCode   (건물·호실·입주·초대)
Board           : Post, Comment
Chat            : ChatRoom, Message
Notification    : Notification
Audit           : AuditLog
```

- **컨텍스트 경계 = Kafka 토픽 경계.** 토픽(`board-events`·`chat-events`·`membership-events`)이 컨텍스트와 1:1 대응해, 컨텍스트 간 통신 다수가 도메인 이벤트로 풀린다(DDD+이벤트 드리븐의 이점).
- 용어는 ubiquitous language로 고정한다(입주=Lease, 호실=Unit). 코드·이벤트·문서가 같은 단어를 쓴다.

### 5.2 레이어 구조 (컨텍스트 내부)

각 바운디드 컨텍스트는 4개 레이어로 나눈다. 의존 방향은 **바깥 → 안쪽(도메인)** 단방향이며, 도메인은 인프라를 모른다.

```
interface/      컨트롤러, WebSocket Gateway, DTO            (HTTP·WS 진입점)
application/    유스케이스(애플리케이션 서비스), 커맨드/쿼리   (흐름 조율, 트랜잭션 경계)
domain/         엔티티·값객체·애그리거트, 도메인 이벤트,       (순수 비즈니스 규칙, 의존 0)
                리포지토리 인터페이스, 도메인 서비스
infrastructure/ Prisma 리포지토리 구현, Redis·Kafka 어댑터    (기술 세부)
```

- **핵심 규칙: 의존성 역전.** `domain/`은 `RepositoryInterface`만 정의하고, 실제 Prisma 구현은 `infrastructure/`에 둔 뒤 DI로 주입한다. 덕분에 **도메인 로직이 Prisma·Redis·Kafka에 묶이지 않고**, 테스트 시 인메모리 가짜 리포지토리로 대체할 수 있다.
- **애그리거트 경계 = 트랜잭션 경계 = 정합성 경계.** 예: `ChatRoom`은 메시지 영속화 단위를 묶는 애그리거트 루트. 한 유스케이스가 여러 애그리거트를 바꿔야 하면 그 사이는 **도메인 이벤트(→ Kafka)** 로 느슨하게 잇는다(즉시 강한 정합성 대신 결과적 정합성). 이는 3.2의 "실시간 전달 ↔ 비동기 영속화 분리"와 정확히 같은 원리다.
- **도메인 이벤트 ↔ Kafka 매핑:** 도메인 계층에서 `MessageSent`, `PostCreated`, `TenantJoined` 같은 도메인 이벤트를 발생시키고, application 레이어가 이를 Kafka producer(infrastructure)로 발행한다. 4절의 토픽/소비자는 이 도메인 이벤트의 외부 전파 채널이다.

### 5.3 프로세스 토폴로지

```
단일 하이브리드 앱 (1 프로세스)
  ├─ HTTP/WS interface (API + Chat Gateway)
  └─ Kafka 컨슈머 (persistence / notification / audit)   ← @nestjs/microservices hybrid
공유 인프라: PrismaModule · RedisModule · KafkaModule(producer)
```

- **단일 하이브리드 앱으로 시작** — 분리형(별도 worker 프로세스)은 초기 셋업·디버깅 비용이 과하다. DDD로 컨텍스트가 이미 모듈 경계로 끊겨 있어, 나중에 컨슈머/특정 컨텍스트만 별도 프로세스로 떼어내기 쉽다.
- **레이어 두께 = 컨텍스트 복잡도(핵심 원칙).** Board처럼 규칙 없는 CRUD는 레이어를 얇게(application이 리포지토리 직접 호출), Chat·Property처럼 불변식·상태전이가 있는 컨텍스트는 도메인 레이어를 두텁게 — 보일러플레이트 과임을 피한다.

---

## 6. 보안 원칙 (전역 CLAUDE.md 준수)

- **RBAC 필수.** OWNER/TENANT/ADMIN 역할 가드 + **리소스 소유권 검사**(이 유저가 이 건물·방·글에 접근 권한이 있는가)를 항상 함께 건다. 역할만 보고 리소스 소유를 안 보면 "다른 건물 데이터에 접근하는 우회 경로"가 열린다 — 설계·구현 시 이 우회 경로를 명시적으로 점검한다.
- **Rate limit은 백엔드에서.** 프론트 제한만으로는 무의미. Redis 기반 **userId + IP 이중 제한**을 글 작성·메시지 전송 등 쓰기 엔드포인트에 적용한다. 채팅·게시판은 스팸·요금 폭탄의 직접 통로이므로 우선 적용 대상.
- **민감정보는 서버 환경변수로.** JWT 시크릿, DB·Kafka·Redis 접속 정보를 클라이언트 노출 prefix에 절대 두지 않는다.
- **RLS 비고:** 본 프로젝트는 Supabase가 아니라 Prisma+Postgres 직접 사용이라 DB-레벨 RLS는 적용 대상이 아니다. 대신 **앱 계층 인가(가드)로 동등한 보장**을 구현하며, 그만큼 가드 누락이 곧 보안 구멍이 됨을 유념한다.

---

## 7. 개발 마일스톤

| 단계 | 내용 | 검증 기준 | 학습 포커스 |
|---|---|---|---|
| **M0** | docker-compose(Postgres·Redis·Kafka(cp-kafka, KRaft)) + Prisma 초기 스키마 + Auth(JWT) | 회원가입/로그인 동작, 마이그레이션 적용됨 | Prisma 기초, 마이그레이션 |
| **M1** | Building/Unit/Lease + 초대코드(Redis TTL) | 건물주가 코드 발급→입주자 가입 시 호실 자동 연결 | Prisma 관계, Redis TTL |
| **M2** | 게시판 CRUD + Redis 캐싱 | 목록/상세 캐시 hit, 쓰기 시 무효화 확인 | 캐시 무효화 패턴 |
| **M3** | Kafka 도입 — 이벤트 발행 + **audit-worker** | 이벤트 발행이 AuditLog로 적재됨 | producer/consumer 첫걸음 |
| **M4** | 1:1 채팅 WS + Redis pub/sub 실시간 + **persistence-worker** | 실시간 전달 + 메시지 비동기 영속화 확인 | WS+Redis+Kafka 통합 |
| **M5** | **notification-worker** + WS 푸시 + 미읽음 카운트 | 이벤트 1건이 3개 컨슈머에 팬아웃됨 | 다중 컨슈머 그룹 |
| **M6** | rate limit, 보안 점검, (선택) 부하 테스트 / Outbox | 쓰기 엔드포인트 이중 제한 동작 | 운영·보안 |
| **F1** *(추후)* | OAuth 소셜 로그인 — Auth 컨텍스트에 `AuthProvider` 매핑 추가 | 구글 등 OAuth 로그인→기존 `User` 연결, 자체 인증과 병행 | 외부 인증 연동 (8.1절) |
| **F2** *(추후)* | 채팅 메시지 자동 번역 — Chat 컨텍스트에 번역 어댑터(외부 API) | 수신자 선호 언어로 메시지 번역 표시, 키는 서버 환경변수 | 외부 API 어댑터·i18n (8.1절) |

M0~M6은 1차 범위이며 독립적으로 동작 검증이 가능하도록 끊었다. 컨슈머는 난이도 순(audit→persistence→notification)으로 도입해 실패 비용을 점증시킨다. **F1·F2는 추후 개발 단계**로, 1차 완료 후 기존 컨텍스트에 모듈/어댑터를 더하는 형태로 진행한다(상세 확장 경로는 8.1절).

> **인증 범위 메모(M0):** 1차는 JWT 자체 인증(이메일/비밀번호)만 구현하고, **OAuth 소셜 로그인은 추후(F1)** 로 분리한다(8.1절).

---

## 8. 명시적으로 범위에서 뺀 것 (YAGNI)

### 8.1 추후 개발 예정 (1차 제외, 후속 추가 의도 있음)

- **OAuth 소셜 로그인** — 1차는 JWT 자체 인증(이메일/비밀번호)만. 구글 등 OAuth 프로바이더 연동은 추후 개발. **확장 경로:** Auth 컨텍스트에 `AuthProvider`(provider, providerUserId) 매핑을 추가하고 기존 `User`에 연결하는 형태. 자체 인증 흐름을 건드리지 않고 인증 수단만 더한다.
- **채팅 메시지 자동 번역** — 외국인 입주자 대응. 1차는 원문 그대로만. **확장 경로:** Chat 컨텍스트에 번역 어댑터(외부 번역 API)를 infrastructure 레이어로 두고, 수신자 선호 언어에 맞춰 표시 시점 또는 영속화 시점에 번역문을 덧붙인다. 외부 API 키는 서버 환경변수로만(6절 보안 원칙 준수).

### 8.2 범위 밖 (현재로선 도입 계획 없음)

- 외부 푸시(FCM/Web Push) — 인앱+WS로 충분, 상용화 시 소비자 추가
- 결제·구독 — 학습 범위 밖
- 입주 신청/승인 상태머신 — 초대코드로 대체
- 별도 worker 프로세스 분리 — 단일 하이브리드 앱으로 시작
- 그룹 채팅 — 1:1만

이들은 모두 "이벤트 소비자/모듈을 추가"하는 형태로 후속 확장 가능하도록 경계를 잡아 두었다.
