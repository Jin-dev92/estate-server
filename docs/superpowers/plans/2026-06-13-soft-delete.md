# 논리삭제(soft delete) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User/Building/Unit/Post/Comment 5개 엔티티를 물리삭제 대신 `deletedAt` 논리삭제로 전환하고, 모든 조회가 삭제된 row를 제외하도록 한다.

**Architecture:** Prisma 스키마에 nullable `deletedAt`을 추가하고, soft delete의 모든 책임을 repository 레이어에 캡슐화한다(도메인·유스케이스·repository 인터페이스는 불변). Post 삭제 시 자식 Comment를 같은 트랜잭션에서 함께 soft delete한다.

**Tech Stack:** NestJS · Prisma · PostgreSQL · Jest

> 설계 근거·트레이드오프: [2026-06-13-soft-delete-design.md](../specs/2026-06-13-soft-delete-design.md) · [README §5 결정 9](../../../README.md)

---

## 사전 메모 (구현자 필독)

- **`findUnique` → `findFirst` 전환:** Prisma `findUnique`는 `where`에 unique 필드만 받는다. `deletedAt: null`(비-unique) 조건을 추가하려면 `findFirst`로 바꿔야 한다. 해당 메서드: `Post.findById`, `Building.findById`, `Unit.findById`, `User.findByEmail`.
- **테스트 범위(확정):** 핵심 동작인 **Post cascade soft delete**만 repository 단위 테스트(PrismaService mock)로 검증하고, `DeletePostUseCase`에 회귀 테스트를 추가한다. 나머지 4개 repository는 조회 필터만 추가하고 별도 테스트는 만들지 않는다(컴파일 + 기존 테스트 통과로 검증).
- **DB mock 캐스팅:** 이 프로젝트엔 repository 단위 테스트가 없어 새로 도입한다. `PrismaService`는 거대한 생성 타입이라 부분 mock을 `as unknown as PrismaService`로 주입한다. CLAUDE.md의 `as any` 금지는 지키되(`as unknown as T`는 허용), **테스트 한정**임을 주석으로 남긴다.
- **마이그레이션은 실행 중인 PostgreSQL이 필요하다.** `docker compose up -d`로 DB를 띄운 뒤 진행한다.

---

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `prisma/schema.prisma` | DB 스키마 | 5개 모델 `deletedAt` + 인덱스, `Comment` Cascade 제거 |
| `src/board/infrastructure/prisma-post.repository.ts` | Post 영속성 | 조회 필터 + cascade soft delete |
| `src/board/infrastructure/prisma-post.repository.spec.ts` | Post repo 테스트 | **신규** (cascade 검증) |
| `src/board/application/delete-post.use-case.spec.ts` | 삭제 유스케이스 테스트 | **신규** (회귀) |
| `src/board/infrastructure/prisma-comment.repository.ts` | Comment 영속성 | 조회 필터 |
| `src/auth/infrastructure/prisma-user.repository.ts` | User 영속성 | 조회 필터 |
| `src/property/infrastructure/prisma-building.repository.ts` | Building 영속성 | 조회 필터 |
| `src/property/infrastructure/prisma-unit.repository.ts` | Unit 영속성 | 조회 필터 |

---

## Task 1: Prisma 스키마에 deletedAt 추가 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: DB 컨테이너 기동**

Run: `docker compose up -d`
Expected: PostgreSQL 컨테이너가 healthy 상태로 뜬다.

- [ ] **Step 2: `User` 모델에 `deletedAt` + 인덱스 추가**

`model User` 블록을 아래로 수정한다(기존 필드는 유지, `deletedAt`과 `@@index`만 추가):

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  name         String
  role         Role     @default(TENANT)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  deletedAt    DateTime?

  buildings Building[]
  leases    Lease[]
  posts     Post[]
  comments  Comment[]

  @@index([deletedAt])
}
```

- [ ] **Step 3: `Building` 모델에 `deletedAt` 추가**

```prisma
model Building {
  id        String   @id @default(cuid())
  ownerId   String
  owner     User     @relation(fields: [ownerId], references: [id])
  name      String
  address   String
  createdAt DateTime @default(now())
  deletedAt DateTime?

  units Unit[]
  posts Post[]
}
```

- [ ] **Step 4: `Unit` 모델에 `deletedAt` 추가**

```prisma
model Unit {
  id         String   @id @default(cuid())
  buildingId String
  building   Building @relation(fields: [buildingId], references: [id])
  name       String
  floor      Int
  createdAt  DateTime @default(now())
  deletedAt  DateTime?

  leases Lease[]
}
```

- [ ] **Step 5: `Post` 모델에 `deletedAt` + 복합 인덱스 추가**

```prisma
model Post {
  id         String       @id @default(cuid())
  buildingId String
  building   Building     @relation(fields: [buildingId], references: [id])
  authorId   String
  author     User         @relation(fields: [authorId], references: [id])
  category   PostCategory @default(FREE)
  title      String
  content    String
  createdAt  DateTime     @default(now())
  updatedAt  DateTime     @updatedAt
  deletedAt  DateTime?

  comments Comment[]

  @@index([buildingId, deletedAt])
}
```

- [ ] **Step 6: `Comment` 모델에 `deletedAt` 추가 + `onDelete: Cascade` 제거**

물리삭제가 사라지므로 DB cascade는 무의미하다. `onDelete: Cascade`를 제거한다.

```prisma
model Comment {
  id        String   @id @default(cuid())
  postId    String
  post      Post     @relation(fields: [postId], references: [id])
  authorId  String
  author    User     @relation(fields: [authorId], references: [id])
  content   String
  createdAt DateTime @default(now())
  deletedAt DateTime?
}
```

> `Lease` 모델은 변경하지 않는다.

- [ ] **Step 7: 마이그레이션 생성 + 적용**

Run: `npx prisma migrate dev --name add_soft_delete`
Expected: `prisma/migrations/<timestamp>_add_soft_delete/` 생성, "Your database is now in sync" 출력, Prisma Client 자동 재생성.

- [ ] **Step 8: 스키마 유효성 확인**

Run: `npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "[M2.7]feat: 5개 엔티티에 deletedAt 컬럼 추가 + Comment Cascade 제거

User/Building/Unit/Post/Comment에 논리삭제용 deletedAt(nullable) 추가.
Post는 (buildingId, deletedAt) 복합 인덱스, User는 deletedAt 인덱스.
물리삭제 폐지로 Comment의 onDelete:Cascade 제거. Lease는 무변경.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: PostRepository — 조회 필터 + cascade soft delete (TDD)

**Files:**
- Create: `src/board/infrastructure/prisma-post.repository.spec.ts`
- Modify: `src/board/infrastructure/prisma-post.repository.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/board/infrastructure/prisma-post.repository.spec.ts` 생성:

```ts
import { PrismaPostRepository } from './prisma-post.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const AUTHOR_ID = 'author';

// PrismaService는 거대 생성 타입이라 필요한 모델 메서드만 mock한다.
// (테스트 한정) as unknown as PrismaService 로 주입한다 — as any 금지 규칙 준수.
function createMockPrisma() {
  return {
    post: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    comment: {
      updateMany: jest.fn(),
    },
    // 전달된 작업 배열을 그대로 실행해주는 단순 트랜잭션 mock
    $transaction: jest.fn((ops: unknown[]) =>
      Promise.all(ops as Promise<unknown>[]),
    ),
  };
}

function rowOf(post: Partial<{ id: string }> = {}) {
  return {
    id: POST_ID,
    buildingId: BUILDING_ID,
    authorId: AUTHOR_ID,
    category: PostCategory.FREE,
    title: '제목',
    content: '본문',
    ...post,
  };
}

describe('PrismaPostRepository', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let repo: PrismaPostRepository;

  beforeEach(() => {
    prisma = createMockPrisma();
    repo = new PrismaPostRepository(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findById', () => {
    it('deletedAt이 null인 글만 findFirst로 조회한다', async () => {
      prisma.post.findFirst.mockResolvedValue(rowOf());

      const found = await repo.findById(POST_ID);

      expect(prisma.post.findFirst).toHaveBeenCalledWith({
        where: { id: POST_ID, deletedAt: null },
      });
      expect(found).toBeInstanceOf(Post);
    });
  });

  describe('findByBuilding', () => {
    it('deletedAt이 null인 글만 조회한다', async () => {
      prisma.post.findMany.mockResolvedValue([rowOf()]);

      await repo.findByBuilding(BUILDING_ID);

      expect(prisma.post.findMany).toHaveBeenCalledWith({
        where: { buildingId: BUILDING_ID, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('delete', () => {
    it('Post와 살아있는 Comment를 한 트랜잭션에서 soft delete한다', async () => {
      await repo.delete(POST_ID);

      expect(prisma.comment.updateMany).toHaveBeenCalledWith({
        where: { postId: POST_ID, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: POST_ID },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/board/infrastructure/prisma-post.repository.spec.ts -v`
Expected: FAIL — `findById`가 `findUnique`(deletedAt 필터 없음)를 호출하고, `delete`가 `prisma.post.delete`를 호출해 `comment.updateMany`/`post.update` 기대가 어긋난다.

- [ ] **Step 3: repository 구현 수정**

`src/board/infrastructure/prisma-post.repository.ts`의 `findById`, `findByBuilding`, `delete`를 아래로 교체한다(`toDomain`/`create`/`update`는 유지):

```ts
  async findById(id: string): Promise<Post | null> {
    // deletedAt: null 조건을 붙이려면 unique 전용 findUnique 대신 findFirst를 쓴다.
    const row = await this.prisma.post.findFirst({
      where: { id, deletedAt: null },
    });
    return row ? this.toDomain(row) : null;
  }

  async findByBuilding(buildingId: string): Promise<Post[]> {
    const rows = await this.prisma.post.findMany({
      where: { buildingId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async delete(id: string): Promise<void> {
    // 물리삭제 대신 논리삭제. Post와 그에 속한 살아있는 Comment를
    // 같은 트랜잭션에서 함께 soft delete해 원자성을 보장한다.
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.comment.updateMany({
        where: { postId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.post.update({
        where: { id },
        data: { deletedAt: now },
      }),
    ]);
  }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/board/infrastructure/prisma-post.repository.spec.ts -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/board/infrastructure/prisma-post.repository.ts src/board/infrastructure/prisma-post.repository.spec.ts
git commit -m "[M2.7]feat: Post 조회 deletedAt 필터 + cascade 논리삭제

findById/findByBuilding에 deletedAt: null 필터 추가(findUnique→findFirst).
delete를 물리삭제에서 Post+하위 Comment 트랜잭션 soft delete로 전환.
PrismaService mock 기반 repository 단위 테스트 신규 추가.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: DeletePostUseCase 회귀 테스트 추가

`DeletePostUseCase`는 코드 변경이 없지만(삭제 동작은 repository 내부로 캡슐화) 현재 spec이 없다. 권한 검사·캐시 무효화·삭제 호출을 고정하는 회귀 테스트를 추가한다.

**Files:**
- Create: `src/board/application/delete-post.use-case.spec.ts`

- [ ] **Step 1: 테스트 작성** (기존 `update-post.use-case.spec.ts`의 mock 패턴을 따른다)

```ts
import { DeletePostUseCase } from './delete-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache } from './board-cache';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const AUTHOR_ID = 'author';

const ownedPost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: AUTHOR_ID,
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

// 삭제 호출을 기록하는 mock repository
function postRepoWith(post: Post | null) {
  const deleted: string[] = [];
  const repo: PostRepository = {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(post),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: (id) => {
      deleted.push(id);
      return Promise.resolve();
    },
  };
  return { repo, deleted };
}

class SpyCache implements BoardCache {
  public invalidatedDetail: string | null = null;
  public invalidatedList: string | null = null;
  getList() {
    return Promise.resolve(null);
  }
  setList() {
    return Promise.resolve();
  }
  getDetail() {
    return Promise.resolve(null);
  }
  setDetail() {
    return Promise.resolve();
  }
  invalidateList(buildingId: string) {
    this.invalidatedList = buildingId;
    return Promise.resolve();
  }
  invalidateDetail(postId: string) {
    this.invalidatedDetail = postId;
    return Promise.resolve();
  }
}

describe('DeletePostUseCase', () => {
  it('작성자가 삭제하면 repository.delete 호출 후 상세·목록 캐시를 무효화한다', async () => {
    const { repo, deleted } = postRepoWith(ownedPost);
    const cache = new SpyCache();
    const useCase = new DeletePostUseCase(repo, cache);

    await useCase.execute({ userId: AUTHOR_ID, postId: POST_ID });

    expect(deleted).toEqual([POST_ID]);
    expect(cache.invalidatedDetail).toBe(POST_ID);
    expect(cache.invalidatedList).toBe(BUILDING_ID);
  });

  it('작성자가 아니면 BOARD_NOT_AUTHOR로 거부하고 삭제하지 않는다', async () => {
    const { repo, deleted } = postRepoWith(ownedPost);
    const useCase = new DeletePostUseCase(repo, new SpyCache());

    await expect(
      useCase.execute({ userId: 'other', postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_AUTHOR' });
    expect(deleted).toEqual([]);
  });

  it('없는 글이면 BOARD_POST_NOT_FOUND', async () => {
    const { repo } = postRepoWith(null);
    const useCase = new DeletePostUseCase(repo, new SpyCache());

    await expect(
      useCase.execute({ userId: AUTHOR_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });
});
```

- [ ] **Step 2: 테스트 통과 확인**

Run: `npx jest src/board/application/delete-post.use-case.spec.ts -v`
Expected: PASS (3 tests). 에러 코드 문자열(`BOARD_NOT_AUTHOR`/`BOARD_POST_NOT_FOUND`)은 `src/board/board.errors.ts`와 일치해야 한다 — 불일치 시 실제 코드값으로 맞춘다.

- [ ] **Step 3: Commit**

```bash
git add src/board/application/delete-post.use-case.spec.ts
git commit -m "[M2.7]test: DeletePostUseCase 회귀 테스트 추가

작성자 삭제→캐시 무효화, 비작성자 거부, 없는 글 처리 검증.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 나머지 repository 조회 deletedAt 필터

Comment/User/Building/Unit의 조회 메서드에 `deletedAt: null`을 추가한다. 별도 테스트는 만들지 않으며, 컴파일 + 전체 테스트 통과로 검증한다.

**Files:**
- Modify: `src/board/infrastructure/prisma-comment.repository.ts`
- Modify: `src/auth/infrastructure/prisma-user.repository.ts`
- Modify: `src/property/infrastructure/prisma-building.repository.ts`
- Modify: `src/property/infrastructure/prisma-unit.repository.ts`

- [ ] **Step 1: Comment.findByPost 필터 추가**

`prisma-comment.repository.ts`의 `findByPost` 내 `where`를 수정:

```ts
    const rows = await this.prisma.comment.findMany({
      where: { postId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
```

- [ ] **Step 2: User.findByEmail 필터 추가 (findUnique→findFirst)**

`prisma-user.repository.ts`의 `findByEmail` 첫 줄을 수정:

```ts
    // deletedAt: null 조건을 붙이려면 findUnique 대신 findFirst를 쓴다.
    const row = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
    });
```

> `save()`의 P2002(unique email 충돌) 처리는 그대로 둔다. soft delete된 유저가 이메일을 점유하는 문제는 [알려진 이슈](../specs/2026-06-13-soft-delete-design.md#5-알려진-이슈--한계)로 기록돼 있으며 이번 범위 밖이다.

- [ ] **Step 3: Building 필터 추가 (findById findUnique→findFirst, findByOwner)**

`prisma-building.repository.ts`:

```ts
  async findById(id: string): Promise<Building | null> {
    const row = await this.prisma.building.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) return null;
    return Building.reconstitute({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      address: row.address,
    });
  }

  async findByOwner(ownerId: string): Promise<Building[]> {
    const rows = await this.prisma.building.findMany({
      where: { ownerId, deletedAt: null },
    });
    return rows.map((row) =>
      Building.reconstitute({
        id: row.id,
        ownerId: row.ownerId,
        name: row.name,
        address: row.address,
      }),
    );
  }
```

- [ ] **Step 4: Unit.findById 필터 추가 (findUnique→findFirst)**

`prisma-unit.repository.ts`의 `findById` 첫 줄을 수정:

```ts
    const row = await this.prisma.unit.findFirst({
      where: { id, deletedAt: null },
    });
```

- [ ] **Step 5: 타입 체크 + 전체 테스트**

Run: `npx tsc --noEmit && npx jest`
Expected: 컴파일 에러 없음, 전체 테스트 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/board/infrastructure/prisma-comment.repository.ts src/auth/infrastructure/prisma-user.repository.ts src/property/infrastructure/prisma-building.repository.ts src/property/infrastructure/prisma-unit.repository.ts
git commit -m "[M2.7]feat: Comment/User/Building/Unit 조회에 deletedAt 필터 추가

논리삭제된 row를 모든 조회에서 제외. findUnique는 비-unique 조건을
받지 못하므로 findById/findByEmail을 findFirst로 전환.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 최종 검증

- [ ] **Step 1: 전체 테스트 + 린트 + 빌드**

Run: `npx jest && npx eslint . && npm run build`
Expected: 전부 통과.

- [ ] **Step 2: 성공 기준 대조** ([스펙 §6](../specs/2026-06-13-soft-delete-design.md#6-성공-기준))

- 5개 모델 `deletedAt` + 마이그레이션, Lease 무변경 ✓
- Comment `onDelete: Cascade` 제거 ✓
- 모든 repository 조회가 `deletedAt: null` 필터 ✓
- Post 삭제 시 Post·Comment 한 트랜잭션 soft delete ✓
- 도메인·유스케이스·repository 인터페이스 시그니처 불변 ✓
- 기존 테스트 통과 + Post cascade 테스트 추가 ✓

---

## Self-Review (작성자 점검 완료)

- **스펙 커버리지:** §2 범위 5개(Task 1·2·4) · Lease 제외(Task 1에서 미변경 명시) · §3 접근 A(Task 2·4) · §3 cascade(Task 2) · §4 findUnique→findFirst(사전 메모·Task 2·4) — 모두 태스크에 매핑됨.
- **플레이스홀더:** 없음(모든 코드 블록 완전 기재).
- **타입 일관성:** `delete(id): Promise<void>` 인터페이스 불변, `PostRepository` 5개 메서드 시그니처 유지, mock 메서드명(`findFirst`/`findMany`/`update`/`updateMany`/`$transaction`)이 구현과 일치.
- **알려진 이슈:** `User.email @unique` 충돌은 Task 4 Step 2에서 범위 밖임을 명시.
