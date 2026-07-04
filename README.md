# estate-server — 건물주·입주자 커뮤니케이션 플랫폼

건물주와 입주자를 잇는 백엔드 플랫폼입니다.
**Prisma · Redis · Kafka** 를 한 프로젝트 안에서 의미 있게 엮어 보며, 분산·이벤트 드리븐 백엔드 설계 역량을 쌓기 위한 개인 학습 프로젝트입니다.

> **레포 구성:** 백엔드(이 레포) + 프론트엔드 `web/`(Next.js, [estate-web](https://github.com/Jin-dev92/estate-web) **git 서브모듈**). 함께 받으려면 `git clone --recurse-submodules`(또는 클론 후 `git submodule update --init --recursive`).

> **상태:** 설계 확정, 마일스톤 기반 구현 진행. 상세 설계는 [설계 스펙 문서](docs/superpowers/specs/2026-06-11-building-owner-platform-design.md)에 정리되어 있습니다.

---

## 1. 프로젝트 목적

이 프로젝트의 1차 목표는 "완성된 제품"이 아니라 **세 가지 인프라 기술의 체득**입니다.
단순 CRUD로는 만나기 어려운 **캐시 무효화·실시간 전달·이벤트 팬아웃·결과적 정합성** 같은 실무 난제를, 현실적인 도메인(건물주 ↔ 입주자) 위에서 직접 부딪혀 보며 익히는 데 초점을 맞췄습니다.

따라서 모든 설계 판단은 "최소 비용으로 빨리 출시"가 아니라 **"각 기술의 핵심 개념을 자연스럽게 연습할 수 있는가"** 를 기준으로 내렸고, 그 트레이드오프 근거를 스펙 문서에 일일이 기록했습니다.

**다루는 도메인 (요약)**
`건물주(Owner) → 건물(Building) → 호실(Unit) → 입주(Lease)` 의 4계층 모델 위에서,
- 입주자는 건물주가 발급한 **초대코드**로 호실에 연결되고,
- 같은 건물 입주자끼리 **게시판**으로 소통하며,
- 건물주 ↔ 입주자 간 **1:1 실시간 채팅**과 **알림**을 주고받습니다.

---

## 2. 기술 스택

| 구분 | 기술 | 이 프로젝트에서의 역할 |
|---|---|---|
| **언어/런타임** | TypeScript, Node.js | 타입 안전한 서버 개발 |
| **프레임워크** | NestJS | main(HTTP API + WebSocket + Kafka producer) + 컨슈머 워커 3종(독립 프로세스·consumer group, M5) |
| **데이터베이스** | PostgreSQL | 단일 RDB. 관계형 모델링·트랜잭션 |
| **ORM** | Prisma | 스키마·마이그레이션·타입 안전 쿼리 |
| **캐시/실시간** | Redis | 캐시·pub/sub·TTL·원자적 카운터·rate limit |
| **이벤트 스트리밍** | Apache Kafka (cp-kafka, KRaft) | 도메인 이벤트 발행 → 다중 컨슈머 팬아웃 |
| **실시간 통신** | WebSocket (NestJS Gateway) | 1:1 채팅·알림 푸시 |
| **아키텍처** | DDD (도메인 주도 설계) | 바운디드 컨텍스트 + 레이어드 구조 |
| **테스트/품질** | Jest, ESLint, Prettier | 단위·e2e 테스트, 정적 검사 |
| **부하테스트** | k6 | 핵심 엔드포인트 성능 baseline(p95·RPS·에러율) 측정 (M7) |
| **관측성** | Sentry | 에러 추적 + 성능 모니터링(트랜잭션) (M10) |
| **프론트엔드** | Next.js 16 (App Router), React 19, Tailwind v4 | `web/` 서브모듈([estate-web](https://github.com/Jin-dev92/estate-web)). 온보딩 등 사용자 화면 |

---

## 3. 핵심 학습 항목

각 기술을 "써봤다" 수준이 아니라, 그 기술이 **왜 그렇게 설계됐는지**를 이해하는 것을 목표로 합니다.

### Prisma — 관계형 모델링 & 마이그레이션
- 4계층(건물→호실→입주) 도메인을 1:N / N:1 관계와 조인으로 모델링
- 마이그레이션 워크플로우, 타입 안전 쿼리

### Redis — 휘발성 데이터의 다양한 용례
- 게시판 **read-through 캐시** + 쓰기 시 명시적 무효화
- 초대코드 **TTL** 만료 처리
- 인스턴스 간 메시지 중계용 **pub/sub** (멀티 인스턴스에서도 실시간 전달)
- 미읽음 카운트 **원자적 INCR**, **rate limit**

### Kafka — 이벤트 드리븐 아키텍처
- 도메인 이벤트 1건(`MessageSent` 등)을 **3개의 독립 컨슈머 그룹**(영속화·알림·감사)이 동시에 소비하는 팬아웃
- **쓰기 버퍼**: 채팅 메시지를 동기 INSERT 대신 Kafka로 흘려 스파이크 흡수
- **파티션 키**(`roomId`)로 방 내 메시지 순서 보장
- **at-least-once** 전제 하의 **멱등 소비자** 설계
- (심화) **Transactional Outbox** 패턴으로 dual-write 불일치 제거

### DDD — 도메인 중심 설계
- 도메인을 **바운디드 컨텍스트**(Auth·Property·Board·Chat·Notification·Audit)로 분리
- `interface → application → domain → infrastructure` **단방향 레이어드 구조**와 **의존성 역전**(도메인이 Prisma/Redis/Kafka를 모르게)
- **애그리거트 경계 = 트랜잭션 경계 = 정합성 경계**, 컨텍스트 간은 도메인 이벤트로 느슨하게 연결

### 보안 (설계 원칙으로 반영)
- **RBAC + 리소스 소유권 검사** 이중 인가 (역할만 보지 않고 "이 건물/방/글의 소유자인가"까지 확인)
- **백엔드 rate limit** (userId + IP 이중 제한)
- 민감정보(JWT 시크릿, DB/Kafka/Redis 접속 정보)는 서버 환경변수로만 관리

### 성능·부하테스트 (k6, M7)
- 성격이 다른 대표 엔드포인트를 [k6](https://k6.io)로 재 **성능 baseline** 확보 — 평균이 아니라 **p95/p99**(꼬리 지연)로 본다
- 합격 기준을 `thresholds`로 **코드화**(예: `p(95)<300ms`, 실패율 `<1%`) → 미달 시 k6가 exit≠0
- **smoke**(정상성) / **load**(baseline) 프로파일, think time으로 "현실적 동시 사용자" 측정
- 부하테스트의 전형적 딜레마 **"측정이 측정을 방해"** 를 직접 마주침 — rate limit이 부하를 막음

---

## 3.5 부하테스트 결과 (M7 baseline)

> 로컬 단일 머신(앱+PG+Redis+Kafka 동시 구동) 기준 — 절대치가 아니라 **상대 비교·회귀 감지**용. 실행법·전체 표·발견은 [`load/README.md`](load/README.md), 개념 정리는 [학습 노트 §8.5](docs/study/마일스톤-학습-노트.md).

| 시나리오 | 프로파일 | p95 | 에러율 | 무엇을 보나 |
|---|---|---|---|---|
| `GET /buildings/:id/posts` | load 20VU | **6.9ms** | 0% | Redis read-through 캐시 읽기 |
| `POST /buildings/:id/posts` | load 20VU | **19.6ms** | 0% | DB+Outbox 한 트랜잭션 쓰기 |
| `POST /auth/login` (순수) | smoke 1VU | **114ms** | 0% | bcrypt 검증 = CPU 바운드(읽기의 ~17배) |
| rate-limit 경계 | iter 20 | — | — | ipMax=10 → 429 관측 10회(한도 정확) |
| `POST .../posts` **stress**(풀=1) | ramping 10→600 RPS | **1734ms** | 0.23% | knee에서 DB 커넥션 풀 고갈 → P2024 35건, throughput 천장 ~95 RPS |
| `POST .../posts` **spike** | 5→300→5 RPS | **10ms** | 84%* | 급증분 429 차단 4032·통과 743·5xx 0(앱 생존), 윈도우 리셋 후 회복 |

- **bcrypt(로그인)가 가장 무겁다**(114ms vs 읽기 7ms) — 인증이 CPU 바운드라는 걸 숫자로 확인.
- **stress로 병목을 이름으로 확인(M8):** 로컬은 머신이 먼저 터지므로 DB 풀을 1로 좁혀 *앱이 먼저* 터지게 한 통제 실험 → 풀을 좁힐수록 p95가 13.6→1734ms로 폭증하고 throughput은 ~95 RPS에서 평평(천장=용량). 앱 로그에 Prisma 풀 타임아웃(P2024). 숫자는 머신 한계이지 절대 한계가 아님.
- **spike는 방어·회복 검증(M8):** 300 RPS 급증분이 429로 막히고 5xx=0(앱 생존), p95 10ms(429 거부가 값쌈). 고정 윈도우라 회복은 윈도우 리셋(≤10s) 경계에서. *84%는 의도된 방어(429)이지 실패가 아니다.*
- **login 부하는 측정 불가:** login 라우트의 `@RateLimit({ipMax:10})`이 데코레이터 하드코딩이라 env 한도 상향으로 못 푼다 → 부하 시 ~99%가 429. *우리 rate limit이 의도대로 막는다는 증거*라, 순수 속도는 smoke로 따로 쟀다.
- **캐시 과대평가 주의:** 모든 VU가 같은 building을 읽어 Redis hit이 ~100% → 위 6.9ms는 캐시 최상 시나리오다.

**실행 요약**(자세히는 `load/README.md`):
```bash
docker compose up -d && pnpm build
RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js   # 부하 측정 시 한도 상향
pnpm load:seed                  # 부하용 시드(OWNER·건물·글)
PROFILE=load pnpm load:read     # load:create / load:login / load:ratelimit
```

---

## 4. 아키텍처 한눈에

```
       ┌─────────── main 프로세스 (HTTP API · WS Gateway · Kafka producer) ───────────┐
   ──┤  interface → application → domain → infrastructure(Prisma·Redis·Kafka producer) │
       └───────────────────────────────────┬──────────────────────────────────────────┘
                                            │ 도메인 이벤트 발행
                          ┌─────────────────┼─────────────────┐  (토픽: chat/board/membership-events)
                          ▼                 ▼                 ▼
              persistence-worker   notification-worker     audit-worker     ← 독립 프로세스·독립 consumer group
              (chat-events)        (chat+board-events)     (전체 구독)
                  │                     │  └─ Redis pub/sub → main WS 푸시      │
                  ▼                     ▼                                      ▼
               Message              Notification + 미읽음 카운터(Redis)      AuditLog
```

- **실시간 전달(Redis pub/sub)** 과 **영속화(Kafka 컨슈머)** 를 분리해, 사용자 체감 지연을 낮추면서 쓰기 스파이크를 비동기로 흡수합니다.
- **M5에서 컨슈머를 워커별 프로세스로 분리**했습니다. main은 HTTP+WS+producer만 담당하고, persistence·notification·audit이 **각자 독립 consumer group**으로 같은 이벤트를 한 번씩 소비하는 **진짜 팬아웃**을 이룹니다. 워커(별도 프로세스)의 알림 푸시는 Redis 채널로 main의 WS Gateway에 브리지됩니다.

---

## 5. 주요 설계 결정·트레이드오프

이 프로젝트의 모든 설계는 "왜 그렇게 했는가"를 근거와 트레이드오프로 남겼습니다. 핵심 결정 13가지를 요약합니다. *(각 결정의 더 깊은 맥락과 대안 비교는 [설계 스펙 문서](docs/superpowers/specs/2026-06-11-building-owner-platform-design.md)에 있습니다.)*

**1. 도메인을 `건물 → 호실 → 입주` 3계층으로**
- *근거:* 호실 단위 점유·소통("특정 호실 입주자에게만 보이는 공지")을 표현할 수 있다. 2계층은 이 구분이 사라지고, 일반 Workspace 추상화는 건물주 도메인의 의미가 흐려진다.
- *트레이드오프:* 모델이 무거워지지만, 그 무게가 곧 Prisma 관계 학습 표면적이다.

**2. 입주 연결은 초대코드 방식**
- *근거:* 신청/승인 상태머신 없이 단순하고, **Redis TTL**(코드 만료) 학습을 자연스럽게 끼우며, `TenantJoined` 이벤트 소스를 하나 확보한다.
- *트레이드오프:* 코드 분실·재발급 흐름을 따로 다뤄야 하지만 단순하다.

**3. 게시판: 건물 단위 + read-through 캐시 + 쓰기 시 명시적 무효화**
- *근거:* 읽기 빈도 ≫ 쓰기인 전형적 read-heavy 영역이라 캐시 효과가 분명하고, 캐시 무효화 타이밍을 직접 다뤄본다.
- *트레이드오프:* 캐시 일관성 관리 비용 → **명시적 무효화 + 짧은 TTL 안전망**으로 둘 다 경험한다.

**4. 채팅: 실시간 전달(Redis pub/sub) ↔ 영속화(Kafka)를 분리**
- *근거:* 체감 지연을 낮추면서, 메시지마다 동기 INSERT 대신 Kafka를 **쓰기 버퍼**로 두어 폭주 스파이크를 흡수한다.
- *트레이드오프:* "전달은 됐는데 아직 DB에 없는" 짧은 윈도우가 생긴다(학습 수준 허용, 엄밀 정합성은 Outbox로 발전). 순서 보장을 위해 `roomId`를 파티션 키로 쓴다.

**5. 알림은 인앱+WS만, 외부 푸시(FCM) 제외**
- *근거:* 외부 푸시는 키 발급·구독 관리 등 외부 의존이 학습 본질(Kafka→Redis→WS 내부 흐름)을 흐린다.
- *트레이드오프:* 브라우저를 닫은 사용자에겐 실시간 도달 불가 → 상용화 시 **FCM 소비자 하나만 추가**하면 되는 구조(이벤트 드리븐의 이점).

**6. Kafka 토픽 3분할 + 다중 컨슈머 그룹 팬아웃**
- *근거:* 이벤트 1건을 persistence·notification·audit이 **독립적으로** 소비하는 팬아웃이 핵심 학습 목표다. 토픽 분리로 구독 범위·보존 정책이 명확해진다.
- *트레이드오프:* 토픽 수 관리 + at-least-once라 **멱등 소비자**(메시지 ID upsert)가 필수. 소비자는 난이도 순(audit→persistence→notification)으로 도입한다.

**7. DDD 레이어드 + 의존성 역전, 단일 하이브리드 앱으로 시작**
- *근거:* 컨텍스트=모듈 경계라 컨텍스트 간 통신이 도메인 이벤트로 자연스럽게 풀린다. 분리형(별도 worker 프로세스)은 초기 셋업·디버깅 비용이 과하다.
- *트레이드오프:* 레이어링 보일러플레이트 증가 → **레이어 두께를 컨텍스트 복잡도에 비례**시킨다(단순 CRUD는 얇게, 불변식 있는 컨텍스트는 두텁게).

**8. DB-레벨 RLS 대신 앱 계층 인가(가드)**
- *근거:* Supabase가 아니라 Prisma+Postgres 직접 사용이라 DB RLS는 비적용. **RBAC + 리소스 소유권 검사**로 동등한 보장을 구현한다.
- *트레이드오프:* 가드 누락이 곧 보안 구멍 → 설계·구현 시 "다른 건물 데이터 접근 우회 경로"를 명시적으로 점검한다.

**9. 논리삭제(soft delete): 5개 엔티티에 `deletedAt`, Lease는 제외**
- *근거:* "실수로 지운 글 복구"(데이터 복구)와 "부모 삭제 시 하위 이력 보존"(참조 무결성)이 동기. `User·Building·Unit·Post·Comment`에 nullable `deletedAt`을 두고, repository 조회에 `deletedAt: null` 필터를 캡슐화한다(도메인·유스케이스는 soft delete를 모름). `Lease`는 이미 `status(ACTIVE/ENDED)`로 "종료"라는 도메인 상태를 표현하므로 의미 중복을 피해 제외한다.
- *트레이드오프:* 물리삭제가 사라지면서 `Comment`의 DB `onDelete: Cascade`가 무의미 → **Post soft delete 시 자식 Comment를 같은 트랜잭션에서 애플리케이션 레벨로 함께 soft delete**한다.

> **알려진 이슈 / 한계** *(soft delete 도입에 따른 미해결 사항 — 위 결정 9의 후속)*
> - **`User.email @unique` 충돌:** soft delete된 유저가 이메일을 계속 점유해 같은 이메일 재가입이 막힌다. **현재 User 삭제 유스케이스가 없어** 당장은 문제되지 않으며, 향후 User 삭제를 도입할 때 복합 unique(`email + deletedAt`)나 이메일 마스킹을 검토한다.
> - **복구(restore) 미구현:** 스키마(`deletedAt`)는 복구가 가능하도록 준비하지만, 도메인 `restore()`/복구 유스케이스는 이번 범위 밖이다.
> - **조회 필터 누락 위험:** 접근 A(repository 수동 필터링)의 트레이드오프로, 새 조회 메서드를 추가할 때 `deletedAt: null`을 빠뜨릴 수 있다. 빈도가 높아지면 Prisma Client Extension(자동 필터링)으로 전환을 검토한다.

**10. M3 — Kafka 이벤트 발행 + audit-worker(부작용 없는 첫 소비자)**
- *근거:* 도메인 이벤트 4종을 `@nestjs/microservices`로 발행하고, 부작용 없는 audit-worker가 멱등 소비(`eventId @unique`)해 `AuditLog`에 적재한다. 발행 추상화는 application 직접 발행(`EventPublisher` 포트)으로 도메인이 Kafka를 모르게 한다.
- *트레이드오프:* after-commit 단순 발행이라 "DB는 썼는데 발행 직전 크래시" 시 이벤트 유실 창이 있었다(M3 시점의 의도된 한계). **Transactional Outbox(결정 13)** 로 해소했다.

**11. M4 — 채팅: 실시간 전달(WS+Redis pub/sub)과 영속화(Kafka persistence-worker) 분리**
- *근거:* WS Gateway(socket.io)가 메시지를 받아 Redis 단일 채널로 즉시 중계(멀티 인스턴스)하고 capped list에 캐시하며, Kafka `chat-events`를 쓰기 버퍼로 두어 persistence-worker가 비동기 단건 멱등 INSERT(`Message.id=messageId`)한다. DB를 기다리지 않아 체감 지연이 낮다. 순서는 `roomId`를 파티션 키로 보장한다.
- *트레이드오프:* "전달은 됐는데 DB엔 아직" 윈도우(→M6 Outbox), 단일 pub/sub 채널은 트래픽 증가 시 방별 샤딩이 후속 과제. M4 시점엔 단일 hybrid 프로세스의 한 consumer group이 토픽별 핸들러로 소비했고, 같은 이벤트를 여러 그룹이 받는 본격 팬아웃은 **M5(결정 12)** 에서 도입했다.

**12. M5 — 워커별 엔트리포인트로 컨슈머 그룹 분리 + notification-worker**
- *근거:* 이벤트 1건을 persistence·notification·audit이 **독립 consumer group**으로 각각 한 번씩 소비하는 팬아웃이 핵심 학습 목표(결정 6)다. NestJS hybrid는 `@EventPattern` 핸들러가 연결된 모든 마이크로서비스에 전역 등록되어 그룹별 분리가 어렵다 → main은 HTTP+WS+producer만 남기고, persistence/audit/notification을 **각각 별도 부트스트랩**(`src/workers/*.main.ts`, `NestFactory.create` 후 `listen()` 없이 `connectMicroservice`)으로 띄워 그룹·핸들러를 깔끔히 분리한다. notification-worker는 `MessageSent`·`CommentCreated`·`PostCreated`를 받아 수신자별 `Notification`을 멱등 적재(`@@unique[eventId,recipientId]`)하고, Redis 원자적 카운터로 미읽음을 관리하며, 접속 중 수신자에겐 Redis 채널 → main의 `/notifications` WS Gateway로 푸시한다.
- *트레이드오프:* 프로세스가 4개(main + 워커 3)로 늘어 기동·관찰 비용이 증가하지만, 실제 배포 단위(워커=독립 배포·스케일)와 1:1로 맞아 현업 전이성이 높다. 푸시는 best-effort(적재·카운터가 진실 원천), 1:N(`PostCreated`) 알림은 동기 생성이라 대량 건물은 배치/비동기화가 후속 과제. dual-write 유실은 **결정 13(Outbox)** 에서 해소했다.

**13. Transactional Outbox — 도메인 변경과 이벤트 발행을 한 트랜잭션으로**
- *근거:* 그동안 use case가 DB 쓰기(트랜잭션 1)를 커밋한 뒤 별도로 Kafka 발행을 호출해, 그 사이 크래시 시 "DB는 썼는데 이벤트 유실"(dual-write)이 가능했다. 이를 없애기 위해 **도메인 변경 + `OutboxEvent` 행 INSERT를 하나의 DB 트랜잭션**(`TransactionRunner.run(tx => { repo.create(.., tx); outbox.add(event, tx) })`)으로 커밋한다. 별도 **outbox-relay 워커**가 `setInterval` 폴링으로 PENDING을 `SELECT … FOR UPDATE SKIP LOCKED`로 잠그며 가져와 Kafka에 발행하고 PUBLISHED로 마킹한다. board·membership 4건(`PostCreated`·`CommentCreated`·`TenantJoined`·`LeaseEnded`)에 적용했다(chat은 실시간 전달이 주 경로라 제외).
- *트레이드오프:* outbox→Kafka 사이에 폴링 주기만큼 지연이 더해진다(정합성↔지연). relay 재시도·멀티 relay로 같은 이벤트가 중복 발행될 수 있으나 소비자 멱등(`eventId @unique`)이 흡수한다(**유실 없음은 주지만 중복 없음은 못 줌 = at-least-once**). 무한 재시도(DLQ/최대 횟수)·PUBLISHED 행 정리·CDC 전환은 후속 과제.

---

## 6. 개발 마일스톤

| 단계 | 내용 | 학습 포커스 |
|---|---|---|
| **M0** ✅ | docker-compose(PG·Redis·Kafka) + Prisma 스키마 + Auth(JWT) | Prisma 기초·마이그레이션 |
| **M1** ✅ | 건물/호실/입주 + 초대코드(Redis TTL) | Prisma 관계, Redis TTL |
| **M2** ✅ | 게시판 CRUD + Redis 캐싱 | 캐시 무효화 패턴 |
| **M2.5** ✅ | 전역 에러 처리 + 커스텀 예외 + 일관 에러 봉투 | ExceptionFilter, 커스텀 예외 |
| **M2.6** ✅ | Swagger(OpenAPI) 연동 + 기존 엔드포인트 문서화 | @nestjs/swagger, enum 명명 스키마 |
| **M3** ✅ | Kafka 도입 + audit-worker | producer/consumer 첫걸음 |
| **M4** ✅ | 1:1 채팅 WS + Redis pub/sub + persistence-worker | WS+Redis+Kafka 통합 |
| **M5** ✅ | notification-worker + WS 푸시 + 미읽음 카운트 (워커별 컨슈머 그룹 분리) | 다중 컨슈머 팬아웃 |
| **M6** ✅ | rate limit · 보안 점검 | 운영·보안 |
| **Outbox** ✅ | Transactional Outbox(dual-write 유실 제거) + outbox-relay 워커 | 트랜잭션 정합·SKIP LOCKED·at-least-once |
| **M7** ✅ | k6 API 부하테스트(성격별 대표 4개 + thresholds) | 성능 baseline·p95/p99·부하 도구 |
| **M8** ✅ | 부하 한계 탐색: stress/spike (로컬·DB 풀 좁힘으로 통제 실험) | k6 arrival-rate·병목(DB 풀)·용량 계획 |
| **M9** ✅ | Outbox 견고화: DLQ(FAILED 격리)·재시도 백오프 | poison message·지수 백오프·운영 견고함 |
| **M10** ✅ | Sentry 연동 — 에러 추적 + 성능 모니터링 | observability·트랜잭션/스팬·PII 스크러빙·외부 SaaS |
| **M10.5** *(예정)* | 분산 트레이싱(HTTP→Kafka→워커) | 트레이스 컨텍스트 전파·Outbox 연계 |
| **CI** 🟡 | PR 게이트(build·typecheck + Prisma drift + lint·단위 테스트) + 수동 버전 범프 + Claude 자동 PR 리뷰 | GitHub Actions·서비스 컨테이너·migrate diff·claude-code-action |
| **F1** ✅ | OAuth 소셜 로그인(카카오) | 카카오 code 교환·Account 모델·우리 JWT 발급 |
| **F2** *(추후)* | 채팅 메시지 자동 번역(외국인 입주자 대응) | 외부 API 어댑터·i18n |

> M0~M7은 1차 범위이며 각 단계가 독립적으로 동작 검증되도록 끊었습니다. 컨슈머는 난이도 순(audit → persistence → notification)으로 도입해 실패 비용을 점증시킵니다.
>
> **운영·견고함 후속(M8·M9·M10·CI)** — M0~M7로 핵심 기능·정합성·부하 baseline은 끝났고, 그 위에 운영 견고함·관측성을 얹는 후속이다. 각 항목의 배경·트레이드오프는 [학습 노트](docs/study/마일스톤-학습-노트.md)(부하 stress/spike §8.5, Outbox DLQ §8)에 정리해 두었다. 순서는 느슨하며 우선순위에 따라 조정한다.
> - **M8 (stress/spike):** ✅ 한계점·병목 탐색. 로컬 단일 머신은 "앱이 아니라 머신이 먼저 한계"라, 별도 부하 머신 대신 **DB 커넥션 풀을 1로 좁혀**(`connection_limit=1`) *앱이 먼저, 예측 지점에서* 터지게 하는 **통제 실험**으로 진행했다. closed VU로는 backpressure가 숨으니 open(arrival-rate) executor로 갔다. 결과는 §3.5.
> - **M9 (Outbox DLQ):** ✅ poison message(영원히 실패)를 `PENDING → FAILED`로 격리해 무한 재시도를 끊었다. 실패 시 지수 백오프(`base*2^n`, cap)로 재시도하다 `OUTBOX_MAX_ATTEMPTS` 초과 시 격리하고, `lastError`/`failedAt`로 사후 조사. replay(되살리기)는 후속.
> - **M10 (Sentry):** ✅ 에러 추적 + 성능 모니터링. M2.5 에러 봉투는 *사용자에게* 깔끔한 응답을 주지만 서버 내부는 로그뿐 → 5xx·미처리 예외·outbox poison을 Sentry로 보내 **풀 스택 + userId·role·path** 컨텍스트를 남긴다(4xx·예상 예외는 제외 — 단 422·400-validation은 FE/계약 버그 신호라 `SENTRY_4XX_SAMPLE_RATE`로 저샘플 캡처 옵션, 기본 off). HTTP 요청은 `tracesSampler`로 경로별 트랜잭션 계측(/docs 제외, M7 성능 측정의 운영판). DSN 없으면 no-op, `sendDefaultPii:false` + beforeSend로 PII 스크럽. *트레이드오프(관측성 ↔ 외부 의존):* 디버깅이 빨라지지만 외부 SaaS 의존·DSN 관리·PII 스크러빙이 따른다(DSN은 서버 env로만). **분산 트레이싱(HTTP→Kafka→워커)은 M10.5로 분리.**
> - **CI (통합):** M7 부하 **smoke 자동화**(Actions 서비스 컨테이너로 PG·Redis·Kafka 기동 → 시드 → smoke → threshold 실패 시 red)를 시작점으로, **추가하고 싶은 CI 항목(린트·테스트·빌드·배포 등)을 한 마일스톤으로 통합**한다 — 구현은 그 CI 작업 시점에 함께 진행하고, 여기서는 자리만 잡아 둔다.
>   - **1단계 구현 ✅:** `ci.yml`이 PR(→dev·main)에서 `nest build`(타입체크)와 Prisma 마이그레이션 drift(`migrate diff --exit-code`)를 검증한다. `version-bump.yml`(수동)은 커밋 타입으로 `package.json` 버전을 올려 dev로 PR을 연다. 부하 smoke·lint·test·CD는 후속.

---

## 7. API 레퍼런스

> API가 추가·변경되면 이 표와 PR 본문을 함께 갱신합니다(CLAUDE.md "API 문서화" 규칙). 모든 보호 엔드포인트는 `Authorization: Bearer <accessToken>` 헤더가 필요합니다.

서버 기동 후 **`/docs`**(Swagger UI)·**`/docs-json`**(OpenAPI JSON)에서 인터랙티브 API 문서를 볼 수 있습니다. 아래 표는 요약이며, 상세한 요청·응답 스키마·인증 요건·에러 봉투·enum 허용값은 Swagger에서 확인하세요.

### Auth (M0)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `POST /auth/signup` | 회원가입(기본 역할 TENANT; `role` 선택적 — OWNER·TENANT만 허용, ADMIN 불가) | 공개 |
| `POST /auth/login` | 로그인, JWT `accessToken` 발급 | 공개 |
| `POST /auth/kakao` | 카카오 로그인(code 교환) — 기존 유저 `{accessToken}`, 신규 `{onboardingToken}` | 공개 |
| `POST /auth/kakao/complete` | 카카오 신규 가입 완료(역할 선택) → `{accessToken}` | 공개(onboarding 토큰 보유) |
| `GET /auth/me` | 내 정보(id·email·role) 조회(토큰 기반, DB 미조회) | 인증 |
| `GET /auth/profile` | 프로필(id·email·name·role) 조회(DB) | 인증(본인) |
| `PATCH /auth/profile` | 프로필 이름 수정 | 인증(본인) |
| `PATCH /auth/password` | 비밀번호 변경(현재 비번 확인 + 새 비번 8자+) | 인증(본인) |

### Property (M1)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `POST /buildings` | 건물 생성 | OWNER |
| `GET /buildings` | 내 건물 목록 | OWNER |
| `POST /buildings/:buildingId/units` | 호실 생성 | OWNER(건물 소유자) |
| `POST /units/:unitId/invite-codes` | 초대코드 발급(Redis TTL 24h) | OWNER(건물 소유자) |
| `GET /invite-codes/:code/preview` | 초대코드 미리보기(코드 비소비, `{valid, buildingName?, unitName?}` 반환) | 미인증 공개 |
| `POST /invite-codes/redeem` | 초대코드 사용 → 입주(Lease 생성) | 인증 |
| `GET /me/leases` | 내 입주(Lease) 목록 | 인증 |
| `PATCH /leases/:id/end` | 계약 종료 | 인증 + 건물 OWNER |

### Board (M2)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `POST /buildings/:buildingId/posts` | 게시글 작성 | 건물 멤버 |
| `GET /buildings/:buildingId/posts` | 게시글 목록(read-through 캐시, 응답에 `likeCount`·`likedByMe` 포함) | 건물 멤버 |
| `GET /posts/:postId` | 게시글 상세 + 댓글(캐시, 응답에 `likeCount`·`likedByMe` 포함) | 건물 멤버 |
| `PATCH /posts/:postId` | 게시글 수정 | 작성자 |
| `DELETE /posts/:postId` | 게시글 삭제(204, 댓글 cascade) | 작성자 |
| `POST /posts/:postId/comments` | 댓글 작성 | 건물 멤버 |
| `POST /posts/:postId/likes` | 게시글 좋아요(멱등) | 건물 멤버 |
| `DELETE /posts/:postId/likes` | 게시글 좋아요 취소(멱등) | 건물 멤버 |

> **건물 멤버** = 건물주이거나 그 건물 호실에 ACTIVE 입주(Lease)가 있는 사용자.

> **Rate limit(M6):** 모든 쓰기 라우트는 전역 `RateLimitGuard`로 userId+IP 이중 제한(기본 user 60·IP 120/분)을 받는다. 스팸 표면이 큰 '생성' 라우트는 라우트별로 더 조인다 — `POST …/posts` = user 20·IP 30/분, `POST …/comments` = user 30·IP 60/분(`BOARD_RATE_LIMIT` 상수). 좋아요/취소는 멱등이고 연타를 허용해야 해 기본 한도를 그대로 쓴다. 초과 시 429(`RATE_LIMIT_EXCEEDED`) + `Retry-After`.

### Chat (M4)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `POST /chat/rooms` | 채팅방 생성/조회(ensure) | 인증 + 건물 OWNER 또는 본인-입주자 |
| `GET /chat/rooms` | 내 채팅방 목록 | 인증(본인이 참가자인 방) |
| `GET /chat/rooms/:id/messages` | 메시지 히스토리(최신순, 캐시 우선·DB 폴백) | 방 참가자 |
| WS `join` / `message` | 1:1 실시간 채팅(socket.io, 핸드셰이크 `auth.token` JWT) | 방 참가자 |

> 메시지 전송은 Redis pub/sub로 즉시 중계되고, Kafka `chat-events`를 거쳐 persistence-worker가 비동기로 DB에 적재합니다(설계 §4 파이프라인).

### Notification (M5)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `GET /notifications` | 내 알림 목록(최신순, `?limit=` 기본 50·최대 100, 딥링크용 `buildingId` 포함) | 인증(본인) |
| `GET /notifications/unread-count` | 미읽음 수(Redis 원자적 카운터) | 인증(본인) |
| `PATCH /notifications/read` | 전체 읽음 처리 + 카운터 리셋 | 인증(본인) |
| `PATCH /notifications/:id/read` | 단건 읽음 처리(+미읽음 카운터 감소, 멱등) | 인증(본인) |
| WS `/notifications` (`notification` 이벤트) | 실시간 알림 푸시(socket.io 네임스페이스, 핸드셰이크 `auth.token` JWT) | 본인(연결 시 `user:{userId}` 룸 자동 join) |

> notification-worker가 `MessageSent`·`CommentCreated`·`PostCreated`를 독립 consumer group으로 받아 수신자별 `Notification`을 멱등 적재(`@@unique[eventId,recipientId]`)하고, 미읽음 카운터를 INCR하며, 접속 중 수신자에겐 Redis 채널 → main `/notifications` WS로 푸시합니다. 수신자 해석: 채팅=방 상대방, 댓글=글 작성자, 게시글=건물 멤버(작성자/발신자 제외).

### 에러 응답 형식 (M2.5)

모든 4xx/5xx 에러는 전역 ExceptionFilter가 아래 봉투로 통일해 내려줍니다. **FE는 메시지 문구 대신 안정적인 `code`로 분기**합니다.

```json
{
  "statusCode": 404,
  "code": "BOARD_POST_NOT_FOUND",
  "message": "게시글을 찾을 수 없습니다.",
  "path": "/posts/abc123",
  "timestamp": "2026-06-12T08:00:00.000Z"
}
```

| code | status | 의미 |
|---|---|---|
| `AUTH_EMAIL_IN_USE` | 409 | 이미 사용 중인 이메일 |
| `AUTH_INVALID_CREDENTIALS` | 401 | 로그인 정보 불일치(이메일 존재 여부 미노출) |
| `AUTH_INSUFFICIENT_ROLE` | 403 | 역할 권한 부족 |
| `PROPERTY_BUILDING_NOT_FOUND` / `PROPERTY_UNIT_NOT_FOUND` | 404 | 건물·호실 없음 |
| `PROPERTY_NOT_BUILDING_OWNER` | 403 | 건물 소유자 아님 |
| `PROPERTY_INVALID_INVITE_CODE` | 404 | 유효하지 않거나 만료된 초대코드 |
| `BOARD_POST_NOT_FOUND` | 404 | 게시글 없음 |
| `BOARD_NOT_AUTHOR` | 403 | 글 작성자 아님 |
| `BOARD_NOT_BUILDING_MEMBER` | 403 | 건물 멤버 아님 |
| `COMMON_VALIDATION_FAILED` | 400 | 요청 검증 실패(DTO) |
| `VALIDATION_FAILED` | 422 | 도메인 불변식 위반 |
| `COMMON_UNAUTHORIZED` | 401 | 인증 필요/실패 |
| `RATE_LIMIT_EXCEEDED` | 429 | 요청이 너무 많음(userId·IP 이중 제한 초과, `Retry-After` 헤더 포함) |
| `COMMON_INTERNAL_ERROR` | 500 | 서버 오류 |

---

## 8. 실행 방법

```bash
# 0) 클론 — FE는 web/ 서브모듈이므로 함께 받기
$ git clone --recurse-submodules https://github.com/Jin-dev92/estate-server-kafka.git
#   이미 클론했다면: git submodule update --init --recursive

# 인프라(PostgreSQL·Redis·Kafka) 기동
$ docker compose up -d

# 의존성 설치 + 마이그레이션
$ pnpm install
$ pnpm exec prisma migrate deploy

# main 프로세스 (HTTP API + WebSocket + Kafka producer)
$ pnpm start:dev

# Kafka 컨슈머 워커 3종 — 각각 별도 터미널/프로세스에서 실행(독립 consumer group)
$ pnpm start:worker:persistence    # chat-events → Message 적재
$ pnpm start:worker:notification   # chat+board-events → Notification + WS 푸시
$ pnpm start:worker:audit          # 전체 구독 → AuditLog

# Outbox relay 워커 — PENDING OutboxEvent를 폴링해 Kafka로 발행(board·membership 이벤트의 발행 경로)
$ pnpm start:worker:outbox

# 운영 빌드 후에는 start:prod / start:prod:persistence|notification|audit|outbox 사용

# 테스트
$ pnpm test        # 단위 테스트
$ pnpm test:e2e    # e2e 테스트
$ pnpm test:cov    # 커버리지

# 프론트엔드(web/ = estate-web, Next.js) — 백엔드와 별개 프로세스
$ cd web && pnpm install && pnpm dev   # http://localhost:3000

# 부하테스트 (k6) — load/README.md 참고
$ pnpm load:seed   # 부하용 시드(OWNER·건물·글)
$ pnpm load:read   # GET 목록 / load:create, load:login, load:ratelimit
```

> **M5 이후 프로세스 구성:** main(HTTP+WS+producer) 1개 + 컨슈머 워커 3개. 워커는 같은 코드베이스를 다른 엔트리포인트로 띄운 별도 프로세스이며 각자 독립 consumer group으로 같은 이벤트를 한 번씩 소비합니다. 현재 main에는 비활성 `ChatPersistenceController`(microservice 미연결)가 남아 있으나 영속화는 persistence-worker가 담당합니다(후속 정리 대상).

---

## 9. 더 보기

- 📄 **[전체 설계 스펙 문서](docs/superpowers/specs/2026-06-11-building-owner-platform-design.md)** — 도메인 모델, 기능별 설계, Kafka 토픽/컨슈머, DDD 레이어 구조 등 **결정과 구조의 상세**가 정리되어 있습니다. (위 §5 설계 결정의 배경 문서)
- 🗺️ **[M0 구현 계획](docs/superpowers/plans/2026-06-12-m0-foundation-auth.md)** — 전체 로드맵 + M0(인프라·Prisma·JWT 인증)의 TDD 단계별 계획.
- 📒 **[마일스톤 학습 노트](docs/study/마일스톤-학습-노트.md)** — 마일스톤별 "왜 그렇게 했는가"·트레이드오프·스스로 점검.
- 📖 **[용어집(Glossary)](docs/study/용어집.md)** — 마일스톤 전반에 등장한 용어를 카테고리별로 한눈에(DDD·Redis·Kafka·정합성·부하테스트 등).
