# FE-M3 게시판 (건물 단위) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 또는 executing-plans. 체크박스(`- [ ]`) 사용.

**Goal:** 같은 건물 구성원이 글을 보고 쓰는 **건물 단위 게시판**을 구현한다 — 글 목록 · 상세(+댓글) · 글 작성 · 댓글 작성.

**Architecture:** App Router. 게시판은 **건물 스코프**(`/buildings/:buildingId/posts`)다. 진입점 `/board`가 사용자 컨텍스트로 건물을 해석한다(TENANT=내 lease의 buildingId, OWNER=내 건물). 읽기=서버 컴포넌트(httpOnly 토큰), 쓰기(글·댓글)=Route Handler 프록시. 폼=react-hook-form+zod, 라우트/카테고리=상수, API=lib/api 도메인 모듈(`board`).

**Tech Stack:** Next.js 16(App Router, RSC) · React 19 · TS · Tailwind v4 · RHF+zod · Vitest+RTL.

**근거:** README §7 Board(M2). 백엔드 엔드포인트: `GET/POST /buildings/:id/posts`, `GET /posts/:id`(+댓글), `POST /posts/:id/comments`. 게시글: `{category(NOTICE|FREE), title, content}`(create-post.dto), 댓글: `{content}`.

## 선행 백엔드 (필수) — /me/leases 에 buildingId
TENANT가 게시판에 들어가려면 자기 **건물 id**가 필요한데 `/me/leases`는 현재 `{id, unitId, status}`만 준다. **`buildingId`를 응답에 추가**해야 한다(lease→unit→buildingId). 이는 이미 작성된 `2026-06-22-lease-names-backend.md`(이름 보강) 작업에 **`buildingId` 필드를 함께 포함**시키면 된다(`ListMyLeasesUseCase`가 이미 unit을 조회하므로 `unit.buildingId`를 그대로 넣음). 미구현 시 TENANT 진입은 빈 상태로 degrade, OWNER 게시판은 정상 동작.

## 스코프 (YAGNI)
- 포함: 건물 게시판 목록, 글 상세 + 댓글 목록, 글 작성(카테고리 NOTICE/FREE), 댓글 작성.
- 제외: 글 수정/삭제(작성자 전용, 후속), 캐시/페이지네이션·실시간(후속).

---

## 파일 구조 (estate-web `web/`)
```
lib/api/board.ts      # (신규) listPosts/getPost/createPost/createComment + 타입
lib/api/index.ts      # 배럴에 board 추가
lib/constants.ts      # PAGE_ROUTES.board(buildingId)/boardPost(b,p) + POST_CATEGORY
lib/schemas.ts        # postSchema, commentSchema
app/api/buildings/[id]/posts/route.ts   # POST 글 작성 프록시
app/api/posts/[id]/comments/route.ts    # POST 댓글 작성 프록시
app/(app)/board/page.tsx                # 진입: 건물 컨텍스트 해석 → 리다이렉트/선택
app/(app)/board/[buildingId]/page.tsx   # 글 목록 + 작성 폼
app/(app)/board/[buildingId]/[postId]/page.tsx  # 상세 + 댓글 + 댓글 폼
components/board/{post-form,comment-form,post-list-item}.tsx
```
> 컨벤션 필수: 매직스트링 금지(PAGE_ROUTES/POST_CATEGORY/API_ROUTES), 카피=MESSAGES, 폼=RHF+zod, API 도메인 분리. (estate-web CLAUDE.md)

---

## Task 1: 상수·스키마·board API 모듈

**Files:** Modify `lib/constants.ts`·`lib/schemas.ts`·`lib/api/index.ts`; Create `lib/api/board.ts`

- [ ] **Step 1:** `lib/constants.ts`:
  - `PAGE_ROUTES`에 `board: (b: string) => \`/board/${b}\``, `boardPost: (b: string, p: string) => \`/board/${b}/${p}\``, `boardHome: "/board"` 추가.
  - `API_ROUTES`에 `buildingPosts: (id) => \`/api/buildings/${id}/posts\``, `postComments: (id) => \`/api/posts/${id}/comments\`` 추가.
  - `POST_CATEGORY = { NOTICE: "NOTICE", FREE: "FREE" } as const; export type PostCategory = (typeof POST_CATEGORY)[keyof typeof POST_CATEGORY];`
- [ ] **Step 2:** `lib/schemas.ts`:
```typescript
export const postSchema = z.object({
  category: z.enum([POST_CATEGORY.NOTICE, POST_CATEGORY.FREE]).default(POST_CATEGORY.FREE),
  title: z.string().min(1, MESSAGES.form.invalidInput),
  content: z.string().min(1, MESSAGES.form.invalidInput),
});
export type PostInput = z.infer<typeof postSchema>;
export const commentSchema = z.object({ content: z.string().min(1, MESSAGES.form.invalidInput) });
export type CommentInput = z.infer<typeof commentSchema>;
```
- [ ] **Step 3:** `lib/api/board.ts`(타입은 Swagger로 정확히 확인해 맞춤):
```typescript
import { call, authGet } from "./client";
import type { PostCategory } from "../constants";
export type Post = { id: string; category: PostCategory; title: string; authorId: string; createdAt?: string };
export type Comment = { id: string; authorId: string; content: string; createdAt?: string };
export type PostDetail = Post & { content: string; comments: Comment[] };

export const backendListPosts = (t: string, buildingId: string) =>
  authGet<Post[]>(`/buildings/${buildingId}/posts`, t);
export const backendGetPost = (t: string, postId: string) =>
  authGet<PostDetail>(`/posts/${postId}`, t);
export const backendCreatePost = (t: string, buildingId: string, body: { category?: PostCategory; title: string; content: string }) =>
  call<Post>(`/buildings/${buildingId}/posts`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: JSON.stringify(body) }, {});
export const backendCreateComment = (t: string, postId: string, content: string) =>
  call<Comment>(`/posts/${postId}/comments`, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: JSON.stringify({ content }) }, {});
```
배럴에 `export * from "./board";` 추가.
- [ ] **Step 4:** `npm run build`. **커밋** `feat: 게시판 상수·스키마·board API 모듈`

---

## Task 2: 쓰기 Route Handler (글·댓글)

**Files:** Create `app/api/buildings/[id]/posts/route.ts`, `app/api/posts/[id]/comments/route.ts`

- [ ] **Step 1:** 공통 패턴(토큰 읽어 백엔드 프록시, 401 가드, 에러 status+message). 글: body `{category?,title,content}` → `backendCreatePost(token, id, body)`. 댓글: body `{content}` → `backendCreateComment(token, id, content)`. (FE-M2의 Route Handler들과 동일 패턴, `params` await.)
- [ ] **Step 2:** `npm run build`. **커밋** `feat: 글/댓글 쓰기 Route Handler`

---

## Task 3: /board 진입 — 건물 컨텍스트 해석

**Files:** Create `app/(app)/board/page.tsx`

- [ ] **Step 1:** 서버 컴포넌트. `getToken()` 가드. `backendMe(token)`로 role 판단:
  - **TENANT**: `backendMyLeases(token)`에서 ACTIVE lease의 `buildingId`(선행 보강 필요) → 있으면 `redirect(PAGE_ROUTES.board(buildingId))`. 없으면 "연결된 건물이 없어요" EmptyState.
  - **OWNER**: `backendMyBuildings(token)` → 1개면 redirect, 여러 개면 건물 선택 리스트(각 `Link href={PAGE_ROUTES.board(b.id)}`), 0개면 "건물을 먼저 등록하세요".
- [ ] **Step 2:** `npm run build`. **커밋** `feat: /board 진입(건물 컨텍스트 해석)`

---

## Task 4: 글 목록 + 작성

**Files:** Create `app/(app)/board/[buildingId]/page.tsx`, `components/board/{post-list-item,post-form}.tsx`

- [ ] **Step 1:** 서버 컴포넌트 목록 — `params` await로 buildingId, 가드, `backendListPosts(token, buildingId)` → `Card`+`<PostListItem>`(각 `Link href={PAGE_ROUTES.boardPost(buildingId, p.id)}`, 카테고리 Chip(NOTICE=warning/FREE=neutral), 제목, 작성시각). 빈 상태 EmptyState. 상단 `<PostForm buildingId={buildingId}/>`.
- [ ] **Step 2:** `post-form.tsx`(클라이언트, RHF+zod `postSchema`): 카테고리 select(POST_CATEGORY) + 제목 Field + 내용 textarea → `fetch(API_ROUTES.buildingPosts(buildingId), POST)` → 성공 `router.refresh()`, 실패 `setError("root", MESSAGES...)`. (FE-M2 form 패턴.)
- [ ] **Step 3:** `npm run build`. **커밋** `feat: 게시판 글 목록 + 작성`

---

## Task 5: 글 상세 + 댓글

**Files:** Create `app/(app)/board/[buildingId]/[postId]/page.tsx`, `components/board/comment-form.tsx`

- [ ] **Step 1:** 서버 컴포넌트 상세 — `params` await(buildingId, postId), 가드, `backendGetPost(token, postId)` → 제목·카테고리 Chip·내용, 댓글 목록(`ListRow` 또는 단순 리스트), 하단 `<CommentForm postId={postId}/>`. 404면 "글을 찾을 수 없어요".
- [ ] **Step 2:** `comment-form.tsx`(RHF+zod `commentSchema`) → `fetch(API_ROUTES.postComments(postId), POST)` → 성공 `router.refresh()`.
- [ ] **Step 3:** `npm run build`. **커밋** `feat: 게시판 글 상세 + 댓글 작성`

---

## Task 6: 마무리
- [ ] `cd web && npm run lint && npm test && npm run build` 통과.
- [ ] 컨벤션 자가 점검(리뷰가 반복 지적): **`/board`·`/api/...` 라우트 리터럴 직접 사용 0**(PAGE_ROUTES/API_ROUTES), **에러 카피는 MESSAGES**, 카테고리 리터럴 없음(POST_CATEGORY), 폼 RHF+zod, board API는 `lib/api/board.ts`.
- [ ] (수동, 백엔드+docker) OWNER/TENANT 각각 게시판 진입 → 글 작성 → 상세 → 댓글.
- [ ] 대시보드 빠른액션 "공지·게시판"이 `PAGE_ROUTES.boardHome`(`/board`)로 연결되는지 확인(필요 시 갱신).
- [ ] push + PR(estate-web). 머지 후 부모 서브모듈 포인터 갱신.

## 성공 기준
- 건물 멤버가 건물 게시판 목록·상세(+댓글)를 보고, 글·댓글을 작성. 카테고리(NOTICE/FREE) 표시.
- 쓰기 Route Handler 경유(토큰 클라 미노출), 폼 RHF+zod, 라우트/카테고리/카피 리터럴 없음(상수/MESSAGES), board API 도메인 모듈.
- TENANT는 lease.buildingId(선행)로 진입, 미보강 시 빈 상태 degrade. OWNER는 건물 선택으로 진입.
