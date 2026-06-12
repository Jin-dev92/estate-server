# M2 — 게시판(Board) CRUD + Redis read-through 캐시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **문서 규칙:** 이 계획은 예시 구현·테스트 코드를 싣지 않는다. 각 단계는 "무엇을 만들고 무엇을 검증하는지"와 핵심 시그니처를 산문으로 기술하고, 실제 코드는 구현 단계에서 작성한다. 실행/검증/커밋용 셸 명령만 코드 블록으로 남긴다.

**Goal:** 같은 건물 멤버끼리 쓰는 건물 단위 게시판(글·댓글 CRUD)을 만들고, 목록/상세를 **Redis read-through 캐시**로 읽되 쓰기(작성·수정·삭제·댓글) 시 해당 키를 **명시적으로 무효화**한다. 핵심 학습은 **캐시 무효화 패턴**이다.

**Architecture:** M0~M1의 DDD 레이어드를 그대로 따른다. Board는 스펙 5.3 "규칙 없는 CRUD는 얇게" 원칙에 맞춰 도메인을 가볍게 두고, **캐시·멤버십은 application 포트**로 둔다(도메인 리포지토리와 구분). `PostCreated` 이벤트 발행은 Kafka 도입(M3) 전이라 M2에서는 다루지 않는다.

**Tech Stack:** NestJS 11, TypeScript, Prisma + PostgreSQL, ioredis(RedisService), class-validator, Jest.

**선행:** M1 완료(머지) 상태. `RedisService`, `JwtAuthGuard`·`CurrentUser`·`TokenPayload`, Property(Building·Unit·Lease) 스키마가 존재한다고 가정한다.

---

## 핵심 설계 결정 (M2 한정)

- **건물 단위 스코프 + 멤버십 인가.** 글 읽기/작성/댓글은 해당 건물의 **멤버**(건물주 `Building.ownerId == userId` 또는 그 건물 호실에 **ACTIVE Lease**를 가진 입주자)만 가능하다. 멤버십 검사는 `MembershipChecker` 포트로 추상화하고 infrastructure에서 Prisma로 조회한다(스펙 6절: 앱 계층 인가).
- **글 수정/삭제는 작성자만.** `Post.isAuthoredBy(userId)`로 검사(리소스 소유권). 모더레이션(건물주가 남의 글 삭제)은 범위 밖.
- **read-through 캐시 + 명시적 무효화 + 짧은 TTL 안전망.** 목록 키 `board:list:{buildingId}`(글 요약 배열), 상세 키 `board:detail:{postId}`(본문 + 댓글). 읽기: hit이면 반환, miss면 DB 조회 후 `SET … EX(120s)`. 쓰기: 작성→목록 무효화, 수정/삭제→상세+목록, 댓글→상세. TTL은 무효화 누락 대비 안전망.
- **캐시는 도메인 엔티티가 아니라 읽기모델 DTO를 저장한다.** 직렬화가 단순하고 응답 형태와 1:1.
- **category는 enum(NOTICE|FREE), 역할 게이팅은 범위 밖.** M2는 멤버면 누구나 작성 가능. 캐시에 집중.
- **분산 환경 + Lua 기반 마련.** 멀티 인스턴스를 전제로, *여러 Redis 명령을 원자로 묶어야 하는* 연산은 서버측 Lua로 처리한다. 단, 게시판 캐시의 read-through **stale-set 레이스**(reader가 DB 읽는 사이 writer가 무효화 → reader가 옛 값 SET)는 `GET → (DB 조회) → SET` 사이에 DB 조회가 끼어 **단일 Lua로 막을 수 없으므로 짧은 TTL 안전망으로 수용**한다. Lua의 실제 적용처는 진짜 원자성이 필요한 곳(M5 카운터·M6 레이트리밋)이며, M2에서는 `RedisService`에 **스크립트 실행 기반(runScript)만** 마련한다(Task 11). 초대코드(M1)는 이미 `GETDEL`로 원자적이라 Lua 불필요.

---

## M2 파일 구조

```
src/board/domain/post-category.enum.ts                  Create  NOTICE|FREE
src/board/domain/post.entity.ts                         Create  Post 엔티티(+isAuthoredBy, edit)
src/board/domain/comment.entity.ts                      Create  Comment 엔티티
src/board/domain/post.repository.ts                     Create  인터페이스 + DI 토큰
src/board/domain/comment.repository.ts                  Create  인터페이스 + DI 토큰
src/board/application/board-cache.ts                    Create  캐시 포트 + 읽기모델 DTO + 토큰
src/board/application/membership.ts                     Create  멤버십 포트 + 토큰
src/board/application/create-post.use-case.ts           Create  멤버십 + 목록 무효화
src/board/application/list-posts.use-case.ts            Create  read-through 캐시
src/board/application/get-post.use-case.ts              Create  상세 캐시(+댓글)
src/board/application/update-post.use-case.ts           Create  작성자 + 상세·목록 무효화
src/board/application/delete-post.use-case.ts           Create  작성자 + 상세·목록 무효화
src/board/application/create-comment.use-case.ts        Create  멤버십 + 상세 무효화
src/board/infrastructure/prisma-post.repository.ts      Create
src/board/infrastructure/prisma-comment.repository.ts   Create
src/board/infrastructure/redis-board-cache.ts           Create  read-through 직렬화 + 무효화
src/board/infrastructure/prisma-membership.checker.ts   Create  owner | ACTIVE 입주자
src/board/interface/dto/create-post.dto.ts              Create
src/board/interface/dto/update-post.dto.ts              Create
src/board/interface/dto/create-comment.dto.ts           Create
src/board/interface/board.controller.ts                 Create  /buildings/:id/posts · /posts/:id · /comments
src/board/board.module.ts                               Create  컨텍스트 모듈 조립
src/redis/redis.service.ts                              Modify  Lua 스크립트 실행(runScript) [Task 11]
prisma/schema.prisma                                    Modify  Post/Comment + PostCategory + 역관계
src/app.module.ts                                       Modify  BoardModule 등록
test/board.e2e-spec.ts                                  Create  CRUD + 캐시 hit/무효화 + 멤버십/작성자
test/redis-script.e2e-spec.ts                           Create  runScript Lua 원자 실행 통합 테스트 [Task 11]
```

> **레이어 메모:** 리포지토리 인터페이스는 `domain/`(M0~M1과 동일), **캐시·멤버십 포트는 `application/`**에 둔다 — 둘 다 도메인 개념이 아니라 애플리케이션 협력자(인프라 추상화)이기 때문. 구현 바인딩은 `board.module.ts`에서.

---

## Task 1: Prisma 스키마 (Post/Comment + PostCategory) + 마이그레이션

**Files:** Modify `prisma/schema.prisma`.

- [ ] **Step 1: 모델·enum 추가 + 역관계**

- 기존 `User`에 역관계 `posts Post[]`·`comments Comment[]`, 기존 `Building`에 `posts Post[]` 추가.
- `PostCategory` enum: NOTICE·FREE.
- `Post`: `id`(cuid), `buildingId` + `building @relation`, `authorId` + `author @relation`(User), `category PostCategory @default(FREE)`, `title`, `content`, `createdAt`, `updatedAt`, `comments Comment[]`.
- `Comment`: `id`(cuid), `postId` + `post @relation(onDelete: Cascade)`, `authorId` + `author @relation`(User), `content`, `createdAt`. **`onDelete: Cascade`** 로 글 삭제 시 댓글 자동 삭제.

- [ ] **Step 2: 마이그레이션 생성·적용**

```bash
npx prisma migrate dev --name add_board
```
Expected: `prisma/migrations/<ts>_add_board/` 생성, "in sync", 클라이언트 재생성(`prisma.post`·`prisma.comment` 사용 가능).

- [ ] **Step 3: 컴파일 확인** — `npx tsc --noEmit` → 에러 없음.

- [ ] **Step 4: Commit**

```bash
git add prisma
git commit -m "[M2]feat: Post/Comment 스키마 및 마이그레이션 추가"
```

---

## Task 2: Board 도메인 레이어 (엔티티 + 리포지토리 인터페이스)

도메인은 순수 TS만 사용한다(NestJS·Prisma·ioredis import 금지).

**Files:** Create `post-category.enum.ts`, `post.entity.ts`, `comment.entity.ts`, `post.repository.ts`, `comment.repository.ts` (모두 `src/board/domain/`), Test `post.entity.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — Post 불변식**

검증: ① `Post.create({buildingId, authorId, title, content})`로 만들면 `id`는 null, 기본 `category`는 FREE, `isAuthoredBy(authorId)` true·타인 false. ② 제목이 비면 `'title is required'` 예외. ③ `reconstitute(...).edit({title, content})`는 제목·본문이 바뀐 **새 Post**를 반환하고 `id`는 유지.

- [ ] **Step 2: 테스트 실패 확인** — `npx jest src/board/domain/post.entity.spec.ts` → FAIL.

- [ ] **Step 3: `post-category.enum.ts`** — 문자열 enum NOTICE·FREE.

- [ ] **Step 4: `post.entity.ts`** — private 생성자, 정적 `create({buildingId, authorId, category?, title, content})`(필수값 비면 예외, id=null, category 기본 FREE), `reconstitute(props)`, 인스턴스 `edit({title, content})`(검증 후 새 Post 반환, id 보존·불변), `isAuthoredBy(userId): boolean`, 게터 `id`(`string|null`)·`buildingId`·`authorId`·`category`·`title`·`content`.

- [ ] **Step 5: `comment.entity.ts`** — `create({postId, authorId, content})`(비면 예외), `reconstitute`, 게터 `id`·`postId`·`authorId`·`content`.

- [ ] **Step 6: 테스트 통과 확인** — 동일 Run → PASS (3 passed).

- [ ] **Step 7: 리포지토리 인터페이스**

- `post.repository.ts`: `POST_REPOSITORY` + `PostRepository { create(post): Promise<Post>; findById(id): Promise<Post|null>; findByBuilding(buildingId): Promise<Post[]>; update(post): Promise<Post>; delete(id): Promise<void> }`.
- `comment.repository.ts`: `COMMENT_REPOSITORY` + `CommentRepository { create(comment): Promise<Comment>; findByPost(postId): Promise<Comment[]> }`.

- [ ] **Step 8: Commit**

```bash
git add src/board/domain
git commit -m "[M2]feat: Board 도메인 레이어 추가 (Post/Comment 엔티티 및 리포지토리 인터페이스)"
```

---

## Task 3: 애플리케이션 포트 (BoardCache + 읽기모델, MembershipChecker)

**Files:** Create `src/board/application/board-cache.ts`, `membership.ts`.

- [ ] **Step 1: `board-cache.ts`** — `BOARD_CACHE` 토큰 + 읽기모델 DTO + 캐시 포트.
  - `PostSummary { id, category, title, authorId }`
  - `CommentView { id, authorId, content }`
  - `PostDetail { id, buildingId, category, title, content, authorId, comments: CommentView[] }`
  - `BoardCache { getList(buildingId): Promise<PostSummary[]|null>; setList(buildingId, posts): Promise<void>; getDetail(postId): Promise<PostDetail|null>; setDetail(postId, detail): Promise<void>; invalidateList(buildingId): Promise<void>; invalidateDetail(postId): Promise<void> }`

- [ ] **Step 2: `membership.ts`** — `MEMBERSHIP_CHECKER` 토큰 + `MembershipChecker { isMember(userId, buildingId): Promise<boolean> }`(건물주 또는 ACTIVE 입주자면 true).

- [ ] **Step 3: Commit**

```bash
git add src/board/application/board-cache.ts src/board/application/membership.ts
git commit -m "[M2]feat: Board 캐시·멤버십 포트(읽기모델 DTO 포함) 추가"
```

---

## Task 4: 인프라 레이어 (Prisma 리포지토리 + Redis 캐시 + 멤버십 체커)

**Files:** Create `prisma-post.repository.ts`, `prisma-comment.repository.ts`, `redis-board-cache.ts`, `prisma-membership.checker.ts` (모두 `src/board/infrastructure/`).

> 인프라 구현은 실제 DB/Redis가 필요하므로 단위 spec 없이 **Task 10 e2e로 검증**. 단위는 Task 5~8 인메모리 가짜로 커버.

- [ ] **Step 1~3: Prisma 리포지토리 3종**
  - Post: `@Injectable() PrismaPostRepository`, `PrismaService` 주입, 행↔도메인 `toDomain` 매퍼. create/findById/`findByBuilding`(orderBy createdAt **desc**)/update(`{title, content}`만)/delete. row.category는 `as PostCategory`.
  - Comment: create / `findByPost`(orderBy createdAt **asc**).

- [ ] **Step 4: `redis-board-cache.ts`** — `@Injectable() RedisBoardCache`, `RedisService` 주입, TTL 상수 120s, 키 `board:list:{buildingId}`·`board:detail:{postId}`. get* = `redis.get` + `JSON.parse` 또는 null; set* = `redis.set(key, JSON.stringify, 'EX', 120)`; invalidate* = `redis.del`.

> **분산 메모:** 멀티 인스턴스에서 read-through **stale-set 레이스**가 가능하나(DB 조회가 GET/SET 사이에 끼어 단일 Lua로 못 막음) **TTL(120s) 안전망으로 수용**. 무효화(`DEL`)는 이미 원자적. 진짜 원자 연산용 Lua 기반은 Task 11.

- [ ] **Step 5: `prisma-membership.checker.ts`** — `isMember(userId, buildingId)`: `building.findFirst({ id: buildingId, ownerId: userId })`가 있으면 true, 아니면 `lease.findFirst({ tenantId: userId, status: 'ACTIVE', unit: { buildingId } })` 존재 여부 반환(Prisma 관계 필터 `unit: { buildingId }` 사용).

- [ ] **Step 6: 컴파일 확인 후 Commit**

```bash
npx tsc --noEmit
git add src/board/infrastructure
git commit -m "[M2]feat: Board 인프라 레이어 추가 (Prisma 리포지토리, Redis 캐시, 멤버십 체커)"
```

---

## Task 5: CreatePost + ListPosts 유스케이스 (멤버십 + read-through 캐시)

**Files:** Create `create-post.use-case.ts`, `list-posts.use-case.ts`, Test `list-posts.use-case.spec.ts`.

- [ ] **Step 1: `create-post.use-case.ts`** — `@Inject` POST_REPOSITORY·BOARD_CACHE·MEMBERSHIP_CHECKER. `execute({userId, buildingId, category?, title, content})`: `isMember` 아니면 `ForbiddenException('not a building member')`, 통과 시 `Post.create(authorId=userId)` → `posts.create` → **`cache.invalidateList(buildingId)`** → 반환.

- [ ] **Step 2: 실패 테스트 작성 — ListPosts read-through**

가짜 repo·`FakeCache`(setList 호출 추적)·멤버십으로 검증: ① 캐시 miss면 repo 조회 + `setList` 1회 + 결과 반환. ② 캐시 hit이면 `findByBuilding` **미호출**(spy)하고 캐시 값 반환. ③ 비멤버 `ForbiddenException`. (가짜는 `Promise.resolve` 반환.)

- [ ] **Step 3: 테스트 실패 확인** — `npx jest src/board/application/list-posts.use-case.spec.ts` → FAIL.

- [ ] **Step 4: `list-posts.use-case.ts`** — `execute({userId, buildingId})`: 멤버십 게이트(캐시/DB 접근 전) → `cache.getList`; hit이면 반환 → miss면 `posts.findByBuilding` → `PostSummary{id, category, title, authorId}` 매핑 → `cache.setList` → 반환.

- [ ] **Step 5: 테스트 통과 확인** — 동일 Run → PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add src/board/application/create-post.use-case.ts src/board/application/list-posts.use-case.ts src/board/application/list-posts.use-case.spec.ts
git commit -m "[M2]feat: CreatePost/ListPosts 유스케이스 추가 (멤버십, read-through 캐시)"
```

---

## Task 6: GetPost 유스케이스 (상세 캐시 + 댓글)

**Files:** Create `get-post.use-case.ts`, Test `get-post.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성**

검증: ① 캐시 miss면 글+댓글을 모아 `PostDetail`을 만들고 `setDetail` 호출. ② 없는 글이면 `NotFoundException`. ③ 멤버가 아니면 `ForbiddenException`. ④ **캐시 hit이어도 멤버가 아니면 `ForbiddenException`**(보안 핵심 — 캐시 히트 경로의 인가).

- [ ] **Step 2: 테스트 실패 확인** — `npx jest src/board/application/get-post.use-case.spec.ts` → FAIL.

- [ ] **Step 3: `get-post.use-case.ts`** — `@Inject` POST_REPOSITORY·COMMENT_REPOSITORY·BOARD_CACHE·MEMBERSHIP_CHECKER. `execute({userId, postId})`: `cache.getDetail`; hit이면 **`cached.buildingId`로 `authorize`** 후 반환 → miss면 `findById`(없으면 `NotFoundException('post not found')`) → `authorize(post.buildingId)` → `comments.findByPost` → `PostDetail` 구성(comments → `{id, authorId, content}`) → `setDetail` → 반환. private `authorize(userId, buildingId)`: `isMember` 아니면 `ForbiddenException`.

- [ ] **Step 4: 테스트 통과 확인** — 동일 Run → PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add src/board/application/get-post.use-case.ts src/board/application/get-post.use-case.spec.ts
git commit -m "[M2]feat: GetPost 유스케이스 추가 (상세 캐시 + 댓글)"
```

---

## Task 7: UpdatePost + DeletePost 유스케이스 (작성자 + 무효화)

**Files:** Create `update-post.use-case.ts`, `delete-post.use-case.ts`, Test `update-post.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — UpdatePost**

`SpyCache`(invalidatedDetail/invalidatedList 추적)로 검증: ① 작성자가 수정하면 저장하고 **상세·목록 캐시 둘 다 무효화**. ② 작성자가 아니면 `ForbiddenException`. ③ 없는 글이면 `NotFoundException`.

- [ ] **Step 2: 테스트 실패 확인** — `npx jest src/board/application/update-post.use-case.spec.ts` → FAIL.

- [ ] **Step 3: `update-post.use-case.ts`** — `execute({userId, postId, title, content})`: `findById`(없으면 404) → `!isAuthoredBy(userId)`면 `ForbiddenException('not the author')` → `posts.update(post.edit({title, content}))` → `invalidateDetail(postId)` + `invalidateList(post.buildingId)` → 반환.

- [ ] **Step 4: 테스트 통과 확인** — 동일 Run → PASS (3 passed).

- [ ] **Step 5: `delete-post.use-case.ts`** — `execute({userId, postId})`: `findById`(404) → 작성자 검사(403) → `posts.delete(postId)` → `invalidateDetail` + `invalidateList(post.buildingId)`. 반환 void.

- [ ] **Step 6: Commit**

```bash
git add src/board/application/update-post.use-case.ts src/board/application/delete-post.use-case.ts src/board/application/update-post.use-case.spec.ts
git commit -m "[M2]feat: UpdatePost/DeletePost 유스케이스 추가 (작성자 검사 + 캐시 무효화)"
```

---

## Task 8: CreateComment 유스케이스 (멤버십 + 상세 무효화)

**Files:** Create `create-comment.use-case.ts`, Test `create-comment.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성** — 검증: ① 멤버가 댓글을 달면 저장하고 **상세 캐시 무효화**. ② 없는 글이면 `NotFoundException`. ③ 멤버가 아니면 `ForbiddenException`.

- [ ] **Step 2: 테스트 실패 확인** — `npx jest src/board/application/create-comment.use-case.spec.ts` → FAIL.

- [ ] **Step 3: `create-comment.use-case.ts`** — `execute({userId, postId, content})`: `posts.findById`(없으면 404) → `isMember(userId, post.buildingId)` 아니면 403 → `Comment.create(authorId=userId)` → `comments.create` → `cache.invalidateDetail(postId)` → 반환.

- [ ] **Step 4: 테스트 통과 확인** — 동일 Run → PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/board/application/create-comment.use-case.ts src/board/application/create-comment.use-case.spec.ts
git commit -m "[M2]feat: CreateComment 유스케이스 추가 (멤버십 + 상세 캐시 무효화)"
```

---

## Task 9: 인터페이스 레이어 (DTO·컨트롤러) + 모듈 조립

**Files:** Create `dto/create-post.dto.ts`, `dto/update-post.dto.ts`, `dto/create-comment.dto.ts`, `board.controller.ts` (모두 `src/board/interface/`), `src/board/board.module.ts`. Modify `src/app.module.ts`.

- [ ] **Step 1: DTO 3종** — `CreatePostDto`(`@IsOptional @IsEnum(PostCategory) category?`, `@IsNotEmpty title`·`content`), `UpdatePostDto`(`@IsNotEmpty title`·`content`), `CreateCommentDto`(`@IsNotEmpty content`).

- [ ] **Step 2: `board.controller.ts`** — `@Controller()` + 클래스 레벨 `@UseGuards(JwtAuthGuard)`(전 라우트 인증). `@CurrentUser()`로 `user.sub`. 라우트:
  - `POST /buildings/:buildingId/posts` → `{id, buildingId, category, title}`
  - `GET /buildings/:buildingId/posts` → PostSummary[]
  - `GET /posts/:postId` → PostDetail
  - `PATCH /posts/:postId` → `{id, title, content}`
  - `DELETE /posts/:postId` (`@HttpCode(204)`) → void
  - `POST /posts/:postId/comments` → `{id, postId, content}`
  멤버십/작성자 검사는 유스케이스 내부에서.

- [ ] **Step 3: `board.module.ts`** — `controllers: [BoardController]`, `providers`: 6 유스케이스 + 토큰 바인딩(`POST_REPOSITORY`→`PrismaPostRepository`, `COMMENT_REPOSITORY`→`PrismaCommentRepository`, `BOARD_CACHE`→`RedisBoardCache`, `MEMBERSHIP_CHECKER`→`PrismaMembershipChecker`). (Prisma/Redis는 전역 모듈이라 별도 import 불필요. JwtAuthGuard는 클래스 참조.)

- [ ] **Step 4: `src/app.module.ts`** — imports에 `BoardModule` 추가(기존 모듈 유지).

- [ ] **Step 5: 빌드 + 전체 단위 테스트** — `npx tsc --noEmit && npx jest` → 컴파일 에러 없음, M0~M2 단위 전부 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/board/interface src/board/board.module.ts src/app.module.ts
git commit -m "[M2]feat: Board 인터페이스 레이어(컨트롤러, DTO) 및 모듈 조립"
```

---

## Task 10: e2e — CRUD + 캐시 hit/무효화 + 멤버십/작성자

**Files:** Create `test/board.e2e-spec.ts`.

> **선행:** `docker compose up -d`로 Postgres·Redis 기동 + 마이그레이션 적용. 캐시 검증은 `app.get(RedisService)`로 키 존재(`exists`)를 직접 확인.

- [ ] **Step 1: 실패 e2e 작성**

`beforeAll`: owner/tenant/outsider signup, owner를 OWNER 승격, 셋 다 login. M1 흐름으로 건물·호실·초대코드 생성 후 tenant가 redeem(멤버 자격 확보). 검증 케이스:
1. **목록 캐시 set/무효화:** 멤버가 글 작성 → 목록 GET(200) → `redis.exists('board:list:{buildingId}')`==1 → 새 글 작성 후 ==0.
2. **상세 캐시 set/무효화:** 글 작성 → 상세 GET → `redis.exists('board:detail:{postId}')`==1 → 댓글 작성 후 ==0 → 재조회 시 댓글 1개 포함.
3. **멤버십:** outsider 목록 조회·작성 → 403.
4. **작성자:** 작성자 아닌 멤버(owner)가 PATCH → 403, 작성자(tenant) PATCH → 200(title 반영).

`afterAll`: FK 순서(Comment → Post → Lease → Unit → Building → User)로 정리. supertest는 `getHttpServer() as App`, `res.body as {...}` 캐스팅.

- [ ] **Step 2: 인프라 확인 후 e2e 실행**

```bash
docker compose up -d
npx jest --config ./test/jest-e2e.json
```
Expected: auth·property·board e2e 전부 통과.

- [ ] **Step 3: Commit**

```bash
git add test/board.e2e-spec.ts
git commit -m "[M2]test: Board e2e 추가 (CRUD, 캐시 set/무효화, 멤버십/작성자 인가)"
```

---

## Task 11: RedisService Lua 스크립트 실행 지원 (분산 원자 연산 기반)

> 게시판 캐시(Task 4)의 stale-set 레이스는 단일 스크립트로 못 막으므로 TTL로 수용한다. 대신 *여러 Redis 명령을 원자로 묶어야 하는* 진짜 원자 연산(M5 카운터·M6 레이트리밋)을 위해 `RedisService`에 Lua 실행 기반을 마련한다. **M2에서 이를 소비하는 기능은 없다(의도적 기반).** EVALSHA로 실행하고 스크립트 캐시가 비워진 경우(`NOSCRIPT`, 페일오버·`SCRIPT FLUSH`) EVAL로 재적재.

**Files:** Modify `src/redis/redis.service.ts`, Test `test/redis-script.e2e-spec.ts`(실제 Redis 통합 — e2e 설정. 단위 `npx jest`는 외부 의존 없이 유지).

- [ ] **Step 1: 실패 통합 테스트** — `RedisService`를 직접 생성해 원자 `INCR + 최초 1회 EXPIRE` Lua를 두 번 실행: 첫 호출 1, 둘째 2, `ttl > 0` 검증.

- [ ] **Step 2: 실패 확인**

```bash
docker compose up -d
npx jest --config ./test/jest-e2e.json test/redis-script.e2e-spec.ts
```
Expected: FAIL(`runScript is not a function`).

- [ ] **Step 3: `redis.service.ts`에 `runScript<T>(lua, keys: string[], args=(string|number)[])` 추가** — 기존 동작(생성자·error 리스너·onModuleDestroy) 유지하고, lua→SHA 캐시 Map + `runScript` 추가: 캐시된 SHA 없으면 `script('LOAD', lua)`로 적재, `evalsha(sha, keys.length, ...keys, ...args)` 실행, 에러 메시지에 `NOSCRIPT` 포함 시 캐시 삭제 후 `eval(...)` 폴백. 결과 `as T`.

- [ ] **Step 4: 통과 확인** — `npx jest --config ./test/jest-e2e.json test/redis-script.e2e-spec.ts` → PASS(1). `npx tsc --noEmit`도 통과.

- [ ] **Step 5: Commit**

```bash
git add src/redis/redis.service.ts test/redis-script.e2e-spec.ts
git commit -m "[M2]feat: RedisService에 Lua 스크립트 실행(runScript) 지원 추가 (분산 원자 연산 기반)"
```

---

## Task 12: M2 마무리 검증 & README 상태 갱신

**Files:** Modify `README.md`.

- [ ] **Step 1: 전체 검증**

```bash
npm run lint && npx jest && npx jest --config ./test/jest-e2e.json
```
Expected: lint 0 errors, 모든 단위·e2e PASS.

- [ ] **Step 2: 수동 캐시 확인(선택)** — 멤버 토큰으로 글 작성 → 목록 GET → `docker compose exec redis redis-cli exists board:list:<buildingId>`==1 → 새 글 작성 후 ==0.

- [ ] **Step 3: README M2 행에 ✅ 표기.**

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "[M2]docs: 마일스톤 표에 M2 완료 표기"
```

---

## M2 완료 기준 (Definition of Done)

- [ ] `prisma migrate dev`로 `Post`·`Comment` + 관계 생성(댓글은 글 삭제 시 cascade)
- [ ] 멤버가 글 작성/목록/상세/수정/삭제 + 댓글 작성 가능
- [ ] 목록·상세가 **read-through 캐시**되고 TTL 안전망이 걸림
- [ ] **쓰기 시 무효화**: 작성→목록, 수정/삭제→상세+목록, 댓글→상세 키 `DEL` (e2e `redis exists`로 검증)
- [ ] **멤버십 인가**: 비멤버 읽기/작성 403 / **작성자 인가**: 작성자 아닌 사용자의 수정·삭제 403
- [ ] `RedisService.runScript`(EVALSHA + NOSCRIPT 폴백) 추가 + 통합 테스트 통과 — 분산 원자 연산 기반(M5/M6 소비 예정)
- [ ] 단위(엔티티·유스케이스: read-through hit/miss, 무효화 spy) + e2e 전부 통과, lint 0 errors
- [ ] 도메인/애플리케이션 레이어가 Prisma·ioredis를 직접 import 하지 않음(의존성 역전 유지)

---

## Self-Review 결과

- **스펙 커버리지:** M2 스펙("게시판 CRUD + Redis 캐싱", 검증="목록/상세 캐시 hit, 쓰기 시 무효화", 학습="캐시 무효화 패턴") → Task 1(스키마), Task 4·5·6(read-through), Task 5·7·8(무효화), Task 10(캐시 hit/무효화 e2e)로 전부 커버. 스펙 3.1(건물 단위·read-through·쓰기 무효화·TTL), 5.3(Board 얇은 레이어), 6절(앱 계층 인가) 반영.
- **분산/Lua 결정:** read-through stale-set 레이스는 단일 Lua로 못 막아 TTL로 수용(과설계 회피), 진짜 원자 연산용 `runScript` 기반만 Task 11에서 마련, 실제 Lua 스크립트는 M5·M6에서. M2 기능은 미소비.
- **범위 밖(의도적):** `PostCreated`/`CommentCreated` 이벤트(M3), category 역할 게이팅(추후), rate limit(M6), 모더레이션(추후).
- **타입 일관성:** 캐시 포트 메서드·읽기모델(`PostSummary`/`PostDetail`/`CommentView`)이 정의·구현·유스케이스·테스트에서 동일. 리포지토리/포트 토큰이 정의 ↔ 모듈 바인딩 ↔ 주입에서 일치. `Post.edit`/`isAuthoredBy` 시그니처 일관.
