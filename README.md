# estate-server — 건물주·입주자 커뮤니케이션 플랫폼

건물주와 입주자를 잇는 백엔드 플랫폼입니다.
**Prisma · Redis · Kafka** 를 한 프로젝트 안에서 의미 있게 엮어 보며, 분산·이벤트 드리븐 백엔드 설계 역량을 쌓기 위한 개인 학습 프로젝트입니다.

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
| **프레임워크** | NestJS (Hybrid App) | HTTP API + WebSocket + Kafka 컨슈머를 한 프로세스로 |
| **데이터베이스** | PostgreSQL | 단일 RDB. 관계형 모델링·트랜잭션 |
| **ORM** | Prisma | 스키마·마이그레이션·타입 안전 쿼리 |
| **캐시/실시간** | Redis | 캐시·pub/sub·TTL·원자적 카운터·rate limit |
| **이벤트 스트리밍** | Apache Kafka (cp-kafka, KRaft) | 도메인 이벤트 발행 → 다중 컨슈머 팬아웃 |
| **실시간 통신** | WebSocket (NestJS Gateway) | 1:1 채팅·알림 푸시 |
| **아키텍처** | DDD (도메인 주도 설계) | 바운디드 컨텍스트 + 레이어드 구조 |
| **테스트/품질** | Jest, ESLint, Prettier | 단위·e2e 테스트, 정적 검사 |

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

---

## 4. 아키텍처 한눈에

```
                ┌────────────── 단일 NestJS 하이브리드 앱 ──────────────┐
   클라이언트 ──┤  HTTP API · WebSocket Gateway        Kafka 컨슈머 3종 │
                │  (interface 레이어)                  persistence       │
                │        │                             notification      │
                │   application (유스케이스)            audit             │
                │        │                                ▲              │
                │     domain (순수 비즈니스 규칙)          │              │
                │        │                                │ 도메인 이벤트 │
                │  infrastructure ── Prisma ── PostgreSQL │              │
                │        ├──────────── Redis (캐시·pub/sub)               │
                │        └──────────── Kafka producer ────┘              │
                └───────────────────────────────────────────────────────┘
```

- **실시간 전달(Redis pub/sub)** 과 **영속화(Kafka 컨슈머)** 를 분리해, 사용자 체감 지연을 낮추면서 쓰기 스파이크를 비동기로 흡수합니다.
- DDD로 컨텍스트가 이미 모듈 경계로 끊겨 있어, 추후 특정 컨슈머/컨텍스트만 별도 프로세스로 분리하기 쉽습니다.

---

## 5. 주요 설계 결정·트레이드오프

이 프로젝트의 모든 설계는 "왜 그렇게 했는가"를 근거와 트레이드오프로 남겼습니다. 핵심 결정 9가지를 요약합니다. *(각 결정의 더 깊은 맥락과 대안 비교는 [설계 스펙 문서](docs/superpowers/specs/2026-06-11-building-owner-platform-design.md)에 있습니다.)*

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

---

## 6. 개발 마일스톤

| 단계 | 내용 | 학습 포커스 |
|---|---|---|
| **M0** ✅ | docker-compose(PG·Redis·Kafka) + Prisma 스키마 + Auth(JWT) | Prisma 기초·마이그레이션 |
| **M1** ✅ | 건물/호실/입주 + 초대코드(Redis TTL) | Prisma 관계, Redis TTL |
| **M2** ✅ | 게시판 CRUD + Redis 캐싱 | 캐시 무효화 패턴 |
| **M2.5** ✅ | 전역 에러 처리 + 커스텀 예외 + 일관 에러 봉투 | ExceptionFilter, 커스텀 예외 |
| **M2.6** ✅ | Swagger(OpenAPI) 연동 + 기존 엔드포인트 문서화 | @nestjs/swagger, enum 명명 스키마 |
| **M3** | Kafka 도입 + audit-worker | producer/consumer 첫걸음 |
| **M4** | 1:1 채팅 WS + Redis pub/sub + persistence-worker | WS+Redis+Kafka 통합 |
| **M5** | notification-worker + WS 푸시 + 미읽음 카운트 | 다중 컨슈머 팬아웃 |
| **M6** | rate limit · 보안 점검 · (선택) Outbox | 운영·보안 |
| **F1** *(추후)* | OAuth 소셜 로그인 | 외부 인증 연동 |
| **F2** *(추후)* | 채팅 메시지 자동 번역(외국인 입주자 대응) | 외부 API 어댑터·i18n |

> M0~M6은 1차 범위이며 각 단계가 독립적으로 동작 검증되도록 끊었습니다. 컨슈머는 난이도 순(audit → persistence → notification)으로 도입해 실패 비용을 점증시킵니다.

---

## 7. API 레퍼런스

> API가 추가·변경되면 이 표와 PR 본문을 함께 갱신합니다(CLAUDE.md "API 문서화" 규칙). 모든 보호 엔드포인트는 `Authorization: Bearer <accessToken>` 헤더가 필요합니다.

서버 기동 후 **`/docs`**(Swagger UI)·**`/docs-json`**(OpenAPI JSON)에서 인터랙티브 API 문서를 볼 수 있습니다. 아래 표는 요약이며, 상세한 요청·응답 스키마·인증 요건·에러 봉투·enum 허용값은 Swagger에서 확인하세요.

### Auth (M0)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `POST /auth/signup` | 회원가입(기본 역할 TENANT) | 공개 |
| `POST /auth/login` | 로그인, JWT `accessToken` 발급 | 공개 |
| `GET /auth/me` | 내 정보(id·email·role) 조회 | 인증 |

### Property (M1)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `POST /buildings` | 건물 생성 | OWNER |
| `GET /buildings` | 내 건물 목록 | OWNER |
| `POST /buildings/:buildingId/units` | 호실 생성 | OWNER(건물 소유자) |
| `POST /units/:unitId/invite-codes` | 초대코드 발급(Redis TTL 24h) | OWNER(건물 소유자) |
| `POST /invite-codes/redeem` | 초대코드 사용 → 입주(Lease 생성) | 인증 |
| `GET /me/leases` | 내 입주(Lease) 목록 | 인증 |

### Board (M2)

| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `POST /buildings/:buildingId/posts` | 게시글 작성 | 건물 멤버 |
| `GET /buildings/:buildingId/posts` | 게시글 목록(read-through 캐시) | 건물 멤버 |
| `GET /posts/:postId` | 게시글 상세 + 댓글(캐시) | 건물 멤버 |
| `PATCH /posts/:postId` | 게시글 수정 | 작성자 |
| `DELETE /posts/:postId` | 게시글 삭제(204, 댓글 cascade) | 작성자 |
| `POST /posts/:postId/comments` | 댓글 작성 | 건물 멤버 |

> **건물 멤버** = 건물주이거나 그 건물 호실에 ACTIVE 입주(Lease)가 있는 사용자.

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
| `COMMON_INTERNAL_ERROR` | 500 | 서버 오류 |

---

## 8. 실행 방법

```bash
# 의존성 설치
$ npm install

# 개발 모드 (watch)
$ npm run start:dev

# 테스트
$ npm run test        # 단위 테스트
$ npm run test:e2e    # e2e 테스트
$ npm run test:cov    # 커버리지
```

---

## 9. 더 보기

- 📄 **[전체 설계 스펙 문서](docs/superpowers/specs/2026-06-11-building-owner-platform-design.md)** — 도메인 모델, 기능별 설계, Kafka 토픽/컨슈머, DDD 레이어 구조 등 **결정과 구조의 상세**가 정리되어 있습니다. (위 §5 설계 결정의 배경 문서)
- 🗺️ **[M0 구현 계획](docs/superpowers/plans/2026-06-12-m0-foundation-auth.md)** — 전체 로드맵 + M0(인프라·Prisma·JWT 인증)의 TDD 단계별 계획.
