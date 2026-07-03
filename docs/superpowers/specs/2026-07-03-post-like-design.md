# 게시글 좋아요 시스템 설계

- 작성일: 2026-07-03
- 대상 레포: `estate-server` / `board` 모듈
- 참조: `docs/superpowers/specs/2026-06-15-m5-notification-design.md`(이벤트→알림 팬아웃), `docs/superpowers/specs/2026-06-16-outbox-design.md`(도메인 변경+outbox 트랜잭션)

## 1. 배경 / 목표

건물 게시판(`board`)의 게시글에 **좋아요/취소** 기능을 추가한다. 게시글 작성자는 좋아요를 받으면 알림을 받고, 조회 시 좋아요 수와 "내가 눌렀는지"를 확인할 수 있다. 기존 컨벤션(헥사고날, 멤버십 인가, outbox 트랜잭션, Redis 캐시, 이벤트→알림)에 그대로 얹는다.

## 2. 핵심 결정 요약

| 항목 | 결정 |
|---|---|
| 대상 | 게시글(Post)만 (댓글 제외) |
| 엔드포인트 | `POST`/`DELETE` 분리, **멱등** |
| 알림 | `LikeCreated` 이벤트 → 작성자 알림. 자기 좋아요는 recipient-resolver가 제외 |
| 노출 | 상세 + 목록 응답에 `likeCount` + `likedByMe` |
| 자기 좋아요 | 허용, 자기 알림만 생략 |
| 카운트 | 비정규화 카운터 없이 `COUNT(*)` 라이브 조회 |

## 3. 데이터 모델 (`prisma/schema.prisma`)

```prisma
model PostLike {
  id        String   @id @default(cuid())
  postId    String
  post      Post     @relation(fields: [postId], references: [id])
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  createdAt DateTime @default(now())

  @@unique([postId, userId]) // 한 사용자당 한 게시글에 한 번만 (멱등·동시성의 근거)
}
```

- `Post`에 `likes PostLike[]`, `User`에 `postLikes PostLike[]` 관계 추가.
- **소프트 삭제 없음**: 좋아요 취소는 물리 삭제(row delete). 유니크 제약이 재-좋아요를 자연스럽게 허용.
- **별도 인덱스 없음(의도적)**: `@@unique([postId, userId])`가 만드는 복합 B-tree의 선두가 `postId`이므로, leftmost-prefix 규칙에 따라 `postId` 단독 조회(`countByPost`/`countByPosts`)와 `(postId,userId)` 조회가 모두 이 하나로 커버된다. `@@index([postId])`는 중복이라 두지 않는다. 훗날 `userId` 단독 조회(예: 유저의 좋아요 히스토리)가 생기면 그때 `@@index([userId])`를 추가한다.

## 4. 도메인 포트 (`board/domain/post-like.repository.ts`)

```
POST_LIKE_REPOSITORY (Symbol)

like(postId, userId, tx?)       : Promise<boolean>  // 신규 생성 true / 이미 있음 false
unlike(postId, userId, tx?)     : Promise<boolean>  // 삭제됨 true / 없었음 false
countByPost(postId)             : Promise<number>
countByPosts(postIds)           : Promise<Map<string, number>>  // 목록 배치(N+1 회피)
likedPostIds(userId, postIds)   : Promise<Set<string>>          // 목록 배치(likedByMe)
hasLiked(postId, userId)        : Promise<boolean>              // 상세용
```

핵심: `like`/`unlike`가 **상태 전이 여부(bool)** 를 반환한다. 이 bool은 앱의 사전 조회가 아니라 **DB 영향 행 수(rowCount)** 에서 나온다(§7 참조). 신규 전이일 때만 이벤트를 발행해 재클릭 스팸을 막는다.

Prisma 구현:
- `like()`: `createMany({ data: [{ postId, userId }], skipDuplicates: true })` → `{ count }`, `count === 1` 이면 신규.
- `unlike()`: `deleteMany({ where: { postId, userId } })` → `{ count }`, `count === 1` 이면 삭제됨.
- `countByPosts`: `groupBy(['postId'], { where: { postId: { in } }, _count: true })`.
- `likedPostIds`: `findMany({ where: { userId, postId: { in } }, select: { postId } })`.

## 5. 유스케이스 (`board/application/`)

### `LikePostUseCase`
1. `posts.findById` → 없으면 `BOARD_POST_NOT_FOUND`.
2. `membership.isMember` → 아니면 `BOARD_NOT_BUILDING_MEMBER`.
3. `txRunner.run`:
   - `newlyLiked = await likes.like(postId, userId, tx)`
   - `newlyLiked` 이면 `outbox.add(LikeCreated, { postId, buildingId }, actorId=userId, tx)`.
4. 커밋 후 `likeCount = await likes.countByPost(postId)`.
5. 반환 `{ postId, liked: true, likeCount }`.

### `UnlikePostUseCase`
1~2. 위와 동일한 존재·멤버십 검증.
3. `txRunner.run`: `await likes.unlike(postId, userId, tx)` (**이벤트 없음** — 취소는 알림하지 않음).
4. `likeCount = await likes.countByPost(postId)`.
5. 반환 `{ postId, liked: false, likeCount }`.

**캐시 무효화 없음**: 좋아요 정보는 공유 캐시에 담지 않으므로(§6) `PostDetail`/목록 캐시를 건드리지 않는다.

## 6. 응답 노출 & 캐시 전략

`likeCount`(게시글마다 변동)와 `likedByMe`(유저마다 다름)는 **공유 캐시(`PostDetail`/목록)에 넣지 않는다.**
- 넣으면 좋아요마다 캐시를 무효화해 캐시가 무의미해지고, `likedByMe`는 애초에 공유 불가.
- **전략**: 캐시는 지금처럼 정적 콘텐츠(본문·댓글)만 유지. `GetPostUseCase`·`ListPostsUseCase`가 캐시된 본문을 읽은 뒤 `PostLikeRepository`에서 좋아요 정보를 **라이브 조회해 응답에 병합**한다. 인덱스 조회라 저렴하고, 목록은 배치 메서드(`countByPosts`/`likedPostIds`)로 N+1을 회피.
- 응답 추가 필드: 상세·목록 각각 `likeCount: number`, `likedByMe: boolean`.
- `board-cache.ts`의 `PostDetail`/`PostSummary` 인터페이스는 **변경하지 않는다**(캐시 마이그레이션 불필요). 좋아요 필드는 use-case가 응답 조립 시 덧붙인다.

## 7. 동시성 처리

좋아요는 연타되는 액션이라 동시성이 실제 문제다. 계층별 방어:

### 7.1 1차 방어선 = DB 유니크 제약 (앱 레벨 검사 아님)
"한 유저당 한 좋아요"의 진실 원천은 앱의 `hasLiked` 조회가 아니라 `@@unique([postId, userId])` 제약이다. 앱에서 `if (hasLiked) skip else insert` 로 짜면 TOCTOU 레이스(두 요청이 동시에 `false`를 읽고 둘 다 insert)가 발생한다. 그래서 **읽기 없는 원자적 한 문장**으로 구현한다:

- `like`: `INSERT ... ON CONFLICT (postId, userId) DO NOTHING` (Prisma `createMany skipDuplicates`) → rowCount
- `unlike`: `DELETE WHERE postId=? AND userId=?` → rowCount

유니크 인덱스가 동시 insert를 직렬화하므로, 더블클릭 중 정확히 하나만 `count=1`을 받는다.

### 7.2 이벤트/알림 중복 방지
`like()`의 전이 bool(`count === 1`)이 이벤트 발행 조건이다. 더블클릭 → 하나만 발행, 다른 하나는 no-op → **알림 1건**. insert와 `outbox.add`는 같은 트랜잭션이라 "insert됐는데 이벤트 유실" 창이 없다.

### 7.3 카운트: `COUNT(*)` 라이브 (비정규화 카운터 미사용)
- **채택**: 저장 카운터 없이 읽을 때 `COUNT(*) WHERE postId=?`. 저장 숫자가 없으니 **드리프트가 원천 불가** — lost update 문제가 사라진다. `(postId, userId)` 유니크 복합 인덱스의 선두 prefix로 처리돼 저렴(§3).
- **반대로 했다면(`Post.likeCount` 컬럼)**: `UPDATE SET likeCount = likeCount + 1`은 원자적 증감 자체는 안전하나, 두 진실 원천(행 수 vs 카운터)이 생겨 재시도·부분 실패 시 어긋날 수 있고, insert가 skip됐을 때 카운터를 올리지 않는 분기 처리가 필요하다.
- **트레이드오프**: COUNT는 정확성·단순함 대신 읽기 비용을 낸다. 현재 규모(건물 멤버 단위)에선 COUNT가 유리. 글 하나가 수만 좋아요 규모가 되면 Redis 카운터/비정규화 컬럼으로 전환하는 **탈출구**를 남겨둔다.

### 7.4 격리 수준
Postgres 기본 READ COMMITTED로 충분. `ON CONFLICT DO NOTHING`·`deleteMany`는 유니크 인덱스가 동시 쓰기를 직렬화하므로 SERIALIZABLE·명시적 락(`SELECT FOR UPDATE`)이 불필요.

### 7.5 수용하는 비결정성
- 응답 `likeCount`는 커밋 직후 스냅샷이라 동시에 다른 사람이 누르면 순간 ±1 다를 수 있다. **최종 일관성**은 보장(다음 조회 시 정확)되고 좋아요 UI에서 무해하므로 수용.
- HTTP 멱등: `POST`/`DELETE` 반복 호출은 항상 같은 최종 상태.

## 8. 이벤트/알림 배선 (`CommentCreated` 미러링)

- `events/event-type.enum.ts`:
  - `EventType.LikeCreated = 'LikeCreated'`, `TOPIC_BY_EVENT`에 `KafkaTopic.BoardEvents` 매핑.
  - entityType은 기존 `EntityType.Post` 재사용, entityId = postId.
- outbox 페이로드: `{ postId, buildingId }` (CommentCreated와 동형), `actorId = likerId`.
- `notification/domain/notification-type.enum.ts`: `NotificationType.PostLiked = 'PostLiked'`.
- `notification/domain/notification-content.ts`: `case LikeCreated` → title '새 좋아요', body '회원님의 글에 좋아요가 눌렸습니다', entityType `Post`, entityId postId, buildingId.
- `notification/infrastructure/prisma-recipient-resolver.ts`: `case LikeCreated` → `forComment`와 동일 로직(작성자 반환, `actorId === authorId`면 `[]`). **자기 좋아요 알림 생략이 여기서 처리됨.**

## 9. 엔드포인트 (`board/interface/board.controller.ts`)

| 메서드/경로 | 기능 | 인가 | 성공 응답 |
|---|---|---|---|
| `POST /posts/:postId/likes` | 좋아요(멱등) | 건물 멤버 | `201` `{ postId, liked: true, likeCount }` |
| `DELETE /posts/:postId/likes` | 좋아요 취소(멱등) | 건물 멤버 | `200` `{ postId, liked: false, likeCount }` |

- 4xx: `404 BOARD_POST_NOT_FOUND`, `403 BOARD_NOT_BUILDING_MEMBER` (기존 에러 재사용, 신규 에러 없음).
- Swagger: `@ApiOperation` + 성공 `@ApiResponse` + 4xx `@ApiResponse({ type: ErrorResponseDto })`, `@ApiParam(postId)`. 클래스 레벨 `@ApiBearerAuth`·`@UseGuards(JwtAuthGuard)` 그대로 적용.
- 상세/목록 응답 변경(§6): `GET /posts/:postId`, `GET /buildings/:buildingId/posts` 응답에 `likeCount`, `likedByMe` 추가 → Swagger 응답 예시·README 표 갱신.

## 10. 모듈 배선 (`board/board.module.ts`)

- `POST_LIKE_REPOSITORY` → `PrismaPostLikeRepository` provider 등록.
- `LikePostUseCase`, `UnlikePostUseCase` provider 등록 + 컨트롤러 주입.
- `GetPostUseCase`·`ListPostsUseCase`에 `POST_LIKE_REPOSITORY` 주입 추가.

## 11. 테스트

- **유스케이스 단위**(`like-post`, `unlike-post`): 신규 좋아요→이벤트 발행 / 재-좋아요(`like`가 false)→이벤트 미발행 / 취소→이벤트 없음 / 비멤버 403 / 없는 글 404 / 자기 좋아요 허용(유스케이스는 막지 않음).
- **리포지토리 통합**(`prisma-post-like.repository.spec`): 유니크 제약 멱등성(중복 insert→count 0), `countByPosts`·`likedPostIds` 배치 정확성.
- **조회 유스케이스**: `GetPost`/`ListPosts`가 `likeCount`·`likedByMe`를 응답에 병합(캐시 히트 시에도).
- **알림 매핑**: `notification-content` `LikeCreated`→PostLiked, `recipient-resolver` `LikeCreated`에서 `actorId===authorId`면 수신자 제외.

## 12. 알려진 한계

- **취소 후 재-좋아요**는 새 `LikeCreated`(새 eventId)를 발행해 알림이 다시 갈 수 있다. 재클릭(이미 좋아요 상태)은 no-op이라 스팸 없음. 초기 버전에서는 수용하고, 추후 쿨다운/집계 알림으로 개선 여지.
- 대규모 좋아요 시 `COUNT(*)` 비용 → §7.3의 탈출구(Redis 카운터/비정규화)로 전환.
