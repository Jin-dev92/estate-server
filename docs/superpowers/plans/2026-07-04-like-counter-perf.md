# M11 좋아요 카운터 Redis 전환 + k6 전후 측정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 좋아요 수 집계를 라이브 `COUNT(*)`에서 Redis 파생 카운터로 전환하고, k6로 전환 전/후를 같은 조건에서 측정해 수치가 달린 서사를 만든다.

**Architecture:** DB(PostLike 행)가 진실 원천, Redis 카운터(`board:like:count:{postId}`, TTL 3600s)는 파생 캐시. 쓰기는 커밋 후·전이 시에만 "존재하는 키만" 증감(Lua 원자, best-effort), 읽기는 `LikeCountReader`("카운터 우선 → 미스만 COUNT → SET NX 백필")로 단일화. 측정은 시드 볼륨(글 50 × 좋아요 0/200/2000)을 변인으로 before→구현→after 순서.

**Tech Stack:** NestJS, ioredis(RedisService = Redis 상속 + runScript), Prisma, Jest(mock 단위테스트), k6(기존 read-posts 시나리오).

**참조 스펙:** `docs/superpowers/specs/2026-07-04-like-counter-perf-design.md`

## Global Constraints

- **DB가 진실 원천, Redis는 파생 캐시.** 카운터가 틀려도 COUNT로 재구축 가능해야 한다.
- **increment/decrement는 "키가 존재할 때만"** (Lua 원자). 미스 키에 INCR하면 0→1로 실제 카운트를 잃는다. 미스 재구축은 읽기 경로(backfill) 몫.
- **backfill은 `SET ... EX 3600 NX`** — 경합에서 이미 채워진(증감 반영된) 키를 stale 값으로 덮지 않는다.
- TTL 상수 `LIKE_COUNT_TTL_SEC = 3600` — drift 자가 치유 목적(무효화 이벤트가 없어 TTL이 유일한 치유 경로).
- **쓰기 경로 카운터 갱신은 best-effort**: try/catch + `Logger.warn`, 실패해도 요청은 성공.
- `likedByMe`(hasLiked/likedPostIds)는 유저별 데이터 — **그대로 DB**, 건드리지 않는다.
- 측정의 정직성: 결과를 미리 정하지 않는다. "COUNT로 충분했다"는 결론도 그대로 기록.
- 테스트: `*.spec.ts` 동일 디렉토리, AAA, `as any` 금지(`as unknown as X` 허용), 매직값 상수화.
- 커밋: `[M11]{type}: {한글}`. **push 전 `npm run lint:check` 통과 필수**(CI가 경고 0 강제).
- 측정 작업(Task 2·7)은 로컬 인프라 필요: `docker compose up -d`(postgres·redis·kafka), k6 설치 확인됨(`/opt/homebrew/bin/k6`).

---

### Task 1: 시드 확장 (볼륨 파라미터화 + 좋아요 시드)

**Files:**
- Modify: `prisma/seed-load.ts`

**Interfaces:**
- Produces: env `SEED_POST_COUNT`(기본 5), `SEED_LIKES_PER_POST`(기본 0)로 파라미터화된 멱등 시드. liker 이메일 `load-liker-{i}@example.com`.

- [ ] **Step 1: 상수를 env 파라미터로 변경**

`prisma/seed-load.ts`에서 `const SEED_POST_COUNT = 5;`를 다음으로 교체:

```ts
// 부하 볼륨 파라미터(멱등: 이미 있으면 부족분만 채움).
const SEED_POST_COUNT = Number(process.env.SEED_POST_COUNT ?? 5);
const SEED_LIKES_PER_POST = Number(process.env.SEED_LIKES_PER_POST ?? 0);
```

- [ ] **Step 2: 좋아요 시드 블록 추가**

같은 파일, 글 생성 for 루프 끝난 뒤 `console.log(...)` 앞에 추가:

```ts
  // 좋아요 시드: 유니크(postId,userId) 제약 때문에 liker 유저가 좋아요 수만큼 필요하다.
  // 유저·좋아요 모두 createMany(skipDuplicates)로 멱등 — 볼륨을 늘려 재실행하면 부족분만 추가된다.
  if (SEED_LIKES_PER_POST > 0) {
    const likerEmails = Array.from(
      { length: SEED_LIKES_PER_POST },
      (_, i) => `load-liker-${i}@example.com`,
    );
    await prisma.user.createMany({
      data: likerEmails.map((email, i) => ({
        email,
        name: `Load Liker ${i}`,
        role: 'TENANT',
      })),
      skipDuplicates: true,
    });
    const likers = await prisma.user.findMany({
      where: { email: { in: likerEmails } },
      select: { id: true },
    });
    const posts = await prisma.post.findMany({
      where: { buildingId: building.id },
      select: { id: true },
    });
    // 글 단위 배치(글 50 × 2000이면 호출 50번 × 2000행) — 단일 초대형 INSERT 회피.
    for (const post of posts) {
      await prisma.postLike.createMany({
        data: likers.map((u) => ({ postId: post.id, userId: u.id })),
        skipDuplicates: true,
      });
    }
  }
```

- [ ] **Step 3: 출력에 볼륨 표기 추가**

`console.log`의 JSON 객체에 `likesPerPost: SEED_LIKES_PER_POST,` 필드 추가.

- [ ] **Step 4: 동작 검증(로컬 DB)**

Run:
```bash
docker compose up -d
SEED_POST_COUNT=50 SEED_LIKES_PER_POST=10 npm run load:seed
SEED_POST_COUNT=50 SEED_LIKES_PER_POST=10 npm run load:seed   # 멱등 재실행
```
Expected: 두 번째 실행도 에러 없이 동일 출력(posts: 50, likesPerPost: 10). `npx prisma studio` 없이 확인하려면:
```bash
docker compose exec postgres psql -U postgres -d estate -c 'SELECT COUNT(*) FROM "PostLike";'
```
Expected: `500` (50 글 × 10).

- [ ] **Step 5: lint + Commit**

```bash
npm run lint:check
git add prisma/seed-load.ts
git commit -m "[M11]feat: 부하 시드 볼륨 파라미터화(글 수·글당 좋아요 수, 멱등)"
```

---

### Task 2: baseline 측정 (전환 전 — 라이브 COUNT)

**Files:**
- Create: `load/results/m11-like-counter.md` (측정 기록 — before 표까지 채움)

**Interfaces:**
- Consumes: Task 1 시드. 현재 코드(라이브 COUNT 경로) — **이 태스크는 구현 태스크(3~6)보다 반드시 먼저** 실행한다.
- Produces: before 수치(볼륨 0/200/2000 각각의 p95·RPS·에러율).

- [ ] **Step 1: 인프라·앱 기동**

```bash
docker compose up -d
npm run build
RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js > /tmp/m11-app.log 2>&1 &
echo $! > /tmp/m11-app.pid
sleep 3 && curl -sf http://localhost:3000/health || tail -5 /tmp/m11-app.log
```
(health 엔드포인트가 없어 404가 나와도 앱 기동 로그로 확인하면 된다 — `Nest application successfully started`.)

- [ ] **Step 2: 볼륨별 측정 루프 (0 → 200 → 2000)**

각 볼륨 V에 대해 순서대로:
```bash
SEED_POST_COUNT=50 SEED_LIKES_PER_POST=V npm run load:seed
docker compose exec redis redis-cli FLUSHALL     # 게시글 목록 캐시가 시드 전 상태를 물고 있지 않게
PROFILE=smoke npm run load:read                  # 웜업(콘텐츠 캐시 채움) — 수치 버림
PROFILE=load npm run load:read                   # 본 측정
```
k6 출력에서 기록할 것: `http_req_duration`의 `p(95)`, `iterations`(초당), `checks` 실패율.

- [ ] **Step 3: 결과 기록 파일 생성**

Create `load/results/m11-like-counter.md`:

```markdown
# M11 — 좋아요 카운터 전환 전/후 측정

- 조건: 로컬 단일 머신(앱+PG+Redis+Kafka 동시 구동), 글 50개, `read-posts.js` PROFILE=load(20VU, think 1s), 웜업 1회 후 측정. 절대치가 아니라 **동일 조건 상대 비교**용.
- before = 라이브 `COUNT(*)`(GROUP BY IN(50)), after = Redis 카운터(미스 시 COUNT 재구축).

| 글당 좋아요 | 구현 | p95 | RPS | 에러율 |
|---|---|---|---|---|
| 0 | COUNT (before) | (기록) | (기록) | (기록) |
| 200 | COUNT (before) | (기록) | (기록) | (기록) |
| 2000 | COUNT (before) | (기록) | (기록) | (기록) |
| 0 | Redis 카운터 (after) | — | — | — |
| 200 | Redis 카운터 (after) | — | — | — |
| 2000 | Redis 카운터 (after) | — | — | — |

## 관찰 (before)
- (측정 후 기술: 볼륨 증가에 따른 p95 추이, GROUP BY 비용이 보이는지)
```
`(기록)` 자리를 실측값으로 채운다. after 행은 Task 7에서 채운다.

- [ ] **Step 4: 앱 종료 + Commit**

```bash
kill "$(cat /tmp/m11-app.pid)"
git add load/results/m11-like-counter.md
git commit -m "[M11]docs: 전환 전(라이브 COUNT) baseline 측정 기록"
```

---

### Task 3: LIKE_COUNTER 포트 + Redis 어댑터

**Files:**
- Create: `src/board/application/like-counter.ts`
- Create: `src/board/infrastructure/redis-like-counter.ts`
- Test: `src/board/infrastructure/redis-like-counter.spec.ts`
- Modify: `src/board/board.module.ts` (provider 등록)

**Interfaces:**
- Consumes: `RedisService`(`src/redis/redis.service.ts` — ioredis 상속: `mget`/`pipeline` 사용 가능, `runScript(lua, keys, args)` 제공).
- Produces:
  - `LIKE_COUNTER: symbol`, `LIKE_COUNT_TTL_SEC = 3600`
  - `interface LikeCounter`: `increment(postId): Promise<void>` / `decrement(postId): Promise<void>` / `getMany(postIds: string[]): Promise<Map<string, number>>` / `backfill(entries: Map<string, number>): Promise<void>`

- [ ] **Step 1: 포트 작성**

Create `src/board/application/like-counter.ts`:

```ts
export const LIKE_COUNTER = Symbol('LIKE_COUNTER');

// 카운터 TTL(초). 무효화 이벤트가 없는 파생 캐시라 TTL이 유일한 drift 치유 경로 —
// 쓰기마다 갱신되므로 콘텐츠 캐시(120s)보다 길게 둔다.
export const LIKE_COUNT_TTL_SEC = 3600;

// 게시글 좋아요 수의 Redis 파생 캐시. 진실 원천은 DB(PostLike 행)다.
export interface LikeCounter {
  // 키가 "존재할 때만" +1 (Lua 원자). 미스 키에 INCR하면 0→1로 실제 카운트를
  // 잃으므로 건드리지 않는다 — 재구축은 읽기 경로(backfill)의 몫.
  increment(postId: string): Promise<void>;
  // 키가 "존재할 때만" -1. 규칙은 increment와 동일.
  decrement(postId: string): Promise<void>;
  // MGET 배치 조회. 미스난 postId는 맵에서 제외된다.
  getMany(postIds: string[]): Promise<Map<string, number>>;
  // 미스 채움: SET NX(+TTL). 이미 있는 키는 덮지 않는다(경합 중 증감 반영값 보존).
  backfill(entries: Map<string, number>): Promise<void>;
}
```

- [ ] **Step 2: 실패하는 스펙 작성**

Create `src/board/infrastructure/redis-like-counter.spec.ts`:

```ts
import { RedisLikeCounter } from './redis-like-counter';
import { RedisService } from '../../redis/redis.service';
import { LIKE_COUNT_TTL_SEC } from '../application/like-counter';

const POST_ID = 'p1';
const KEY = `board:like:count:${POST_ID}`;

// RedisService는 ioredis 상속 거대 타입이라 필요한 메서드만 mock한다.
function createMockRedis() {
  const pipeline = { set: jest.fn(), exec: jest.fn() };
  pipeline.set.mockReturnValue(pipeline);
  return {
    runScript: jest.fn(),
    mget: jest.fn(),
    pipeline: jest.fn(() => pipeline),
    _pipeline: pipeline,
  };
}

describe('RedisLikeCounter', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let counter: RedisLikeCounter;

  beforeEach(() => {
    redis = createMockRedis();
    counter = new RedisLikeCounter(redis as unknown as RedisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('increment / decrement', () => {
    it('increment는 존재-시-증감 Lua를 (+1, TTL) 인자로 실행한다', async () => {
      await counter.increment(POST_ID);

      expect(redis.runScript).toHaveBeenCalledWith(
        expect.stringContaining('EXISTS'),
        [KEY],
        [1, LIKE_COUNT_TTL_SEC],
      );
    });

    it('decrement는 같은 Lua를 (-1, TTL) 인자로 실행한다', async () => {
      await counter.decrement(POST_ID);

      expect(redis.runScript).toHaveBeenCalledWith(
        expect.stringContaining('EXISTS'),
        [KEY],
        [-1, LIKE_COUNT_TTL_SEC],
      );
    });
  });

  describe('getMany', () => {
    it('빈 입력이면 쿼리 없이 빈 맵', async () => {
      const result = await counter.getMany([]);

      expect(redis.mget).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });

    it('MGET 결과를 숫자 맵으로 바꾸고 미스(null)는 제외한다', async () => {
      redis.mget.mockResolvedValue(['3', null]);

      const result = await counter.getMany(['p1', 'p2']);

      expect(redis.mget).toHaveBeenCalledWith([
        'board:like:count:p1',
        'board:like:count:p2',
      ]);
      expect(result.get('p1')).toBe(3);
      expect(result.has('p2')).toBe(false);
    });
  });

  describe('backfill', () => {
    it('빈 입력이면 파이프라인을 만들지 않는다', async () => {
      await counter.backfill(new Map());

      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('각 항목을 SET NX + TTL로 일괄 기록한다', async () => {
      await counter.backfill(
        new Map([
          ['p1', 3],
          ['p2', 0],
        ]),
      );

      expect(redis._pipeline.set).toHaveBeenCalledWith(
        'board:like:count:p1',
        '3',
        'EX',
        LIKE_COUNT_TTL_SEC,
        'NX',
      );
      expect(redis._pipeline.set).toHaveBeenCalledWith(
        'board:like:count:p2',
        '0',
        'EX',
        LIKE_COUNT_TTL_SEC,
        'NX',
      );
      expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test -- redis-like-counter`
Expected: FAIL — `Cannot find module './redis-like-counter'`.

- [ ] **Step 4: 어댑터 구현**

Create `src/board/infrastructure/redis-like-counter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { LikeCounter, LIKE_COUNT_TTL_SEC } from '../application/like-counter';

// 게시글별 좋아요 카운터 키.
function countKey(postId: string): string {
  return `board:like:count:${postId}`;
}

// 존재할 때만 증감 + TTL 갱신. EXISTS 확인과 증감 사이에 만료가 끼지 않도록 Lua로 원자화.
// (미스 키에 그냥 INCR하면 0→1이 되어 실제 카운트를 잃는다 — 미스는 backfill 몫)
const INCRBY_IF_EXISTS = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('INCRBY', KEYS[1], ARGV[1])
    redis.call('EXPIRE', KEYS[1], ARGV[2])
  end
`;

@Injectable()
export class RedisLikeCounter implements LikeCounter {
  constructor(private readonly redis: RedisService) {}

  async increment(postId: string): Promise<void> {
    await this.redis.runScript(
      INCRBY_IF_EXISTS,
      [countKey(postId)],
      [1, LIKE_COUNT_TTL_SEC],
    );
  }

  async decrement(postId: string): Promise<void> {
    await this.redis.runScript(
      INCRBY_IF_EXISTS,
      [countKey(postId)],
      [-1, LIKE_COUNT_TTL_SEC],
    );
  }

  async getMany(postIds: string[]): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    const values = await this.redis.mget(postIds.map(countKey));
    const result = new Map<string, number>();
    postIds.forEach((id, i) => {
      const v = values[i];
      if (v !== null) result.set(id, Number(v));
    });
    return result;
  }

  async backfill(entries: Map<string, number>): Promise<void> {
    if (entries.size === 0) return;
    // NX: rebuild 경합에서 이미 채워진(그 뒤 증감까지 반영됐을 수 있는) 키를 덮지 않는다.
    const pipeline = this.redis.pipeline();
    for (const [postId, count] of entries) {
      pipeline.set(countKey(postId), String(count), 'EX', LIKE_COUNT_TTL_SEC, 'NX');
    }
    await pipeline.exec();
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- redis-like-counter`
Expected: PASS (6 케이스).

- [ ] **Step 6: 모듈 등록**

`src/board/board.module.ts`:
- import 추가:
  ```ts
  import { LIKE_COUNTER } from './application/like-counter';
  import { RedisLikeCounter } from './infrastructure/redis-like-counter';
  ```
- `providers`에 추가: `{ provide: LIKE_COUNTER, useClass: RedisLikeCounter },`

> `RedisService`는 전역 `RedisModule`이 제공한다(기존 `RedisBoardCache`가 이미 같은 방식으로 주입받고 있으므로 imports 변경 불필요).

- [ ] **Step 7: 빌드 + lint + Commit**

```bash
npm run build && npm run lint:check
git add src/board/application/like-counter.ts src/board/infrastructure/redis-like-counter.ts src/board/infrastructure/redis-like-counter.spec.ts src/board/board.module.ts
git commit -m "[M11]feat: 좋아요 Redis 카운터 포트·어댑터(존재-시-증감 Lua, SET NX 백필)"
```

---

### Task 4: LikeCountReader (읽기 조합 단일 지점)

**Files:**
- Create: `src/board/application/like-count-reader.ts`
- Test: `src/board/application/like-count-reader.spec.ts`
- Modify: `src/board/board.module.ts` (provider 등록)

**Interfaces:**
- Consumes: `LIKE_COUNTER`/`LikeCounter`(Task 3), `POST_LIKE_REPOSITORY`/`PostLikeRepository.countByPosts(postIds): Promise<Map<string, number>>`(기존).
- Produces: `LikeCountReader` 클래스 — `readMany(postIds: string[]): Promise<Map<string, number>>`(요청한 모든 id 포함, 0 보정), `readOne(postId: string): Promise<number>`.

- [ ] **Step 1: 실패하는 스펙 작성**

Create `src/board/application/like-count-reader.spec.ts`:

```ts
import { LikeCountReader } from './like-count-reader';
import { LikeCounter } from './like-counter';
import { PostLikeRepository } from '../domain/post-like.repository';

function counterWith(hits: Map<string, number>) {
  const backfilled: Map<string, number>[] = [];
  const counter: LikeCounter = {
    increment: () => Promise.resolve(),
    decrement: () => Promise.resolve(),
    getMany: () => Promise.resolve(hits),
    backfill: (entries) => {
      backfilled.push(entries);
      return Promise.resolve();
    },
  };
  return { counter, backfilled };
}

function likeRepoCounting(counts: Map<string, number>) {
  const calls: string[][] = [];
  const likes: PostLikeRepository = {
    like: () => Promise.resolve(false),
    unlike: () => Promise.resolve(false),
    countByPost: () => Promise.resolve(0),
    countByPosts: (ids) => {
      calls.push(ids);
      return Promise.resolve(counts);
    },
    likedPostIds: () => Promise.resolve(new Set()),
    hasLiked: () => Promise.resolve(false),
  };
  return { likes, calls };
}

describe('LikeCountReader', () => {
  it('전량 카운터 적중이면 DB를 호출하지 않고 백필도 없다', async () => {
    const { counter, backfilled } = counterWith(
      new Map([
        ['p1', 3],
        ['p2', 5],
      ]),
    );
    const { likes, calls } = likeRepoCounting(new Map());
    const reader = new LikeCountReader(counter, likes);

    const result = await reader.readMany(['p1', 'p2']);

    expect(result.get('p1')).toBe(3);
    expect(result.get('p2')).toBe(5);
    expect(calls).toHaveLength(0);
    expect(backfilled).toHaveLength(0);
  });

  it('미스만 DB로 집계하고, 0 보정 포함해 백필한 뒤 병합해 반환한다', async () => {
    // p1은 적중, p2·p3 미스. DB엔 p2만 좋아요 존재(p3은 0개 → countByPosts 결과에 없음).
    const { counter, backfilled } = counterWith(new Map([['p1', 3]]));
    const { likes, calls } = likeRepoCounting(new Map([['p2', 7]]));
    const reader = new LikeCountReader(counter, likes);

    const result = await reader.readMany(['p1', 'p2', 'p3']);

    expect(calls).toEqual([['p2', 'p3']]); // 미스만 DB 집계
    expect(backfilled).toEqual([
      new Map([
        ['p2', 7],
        ['p3', 0], // 0도 백필해야 다음 조회가 카운터에 적중
      ]),
    ]);
    expect(result.get('p1')).toBe(3);
    expect(result.get('p2')).toBe(7);
    expect(result.get('p3')).toBe(0);
  });

  it('빈 입력이면 아무것도 호출하지 않는다', async () => {
    const { counter, backfilled } = counterWith(new Map());
    const { likes, calls } = likeRepoCounting(new Map());
    const reader = new LikeCountReader(counter, likes);

    const result = await reader.readMany([]);

    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
    expect(backfilled).toHaveLength(0);
  });

  it('readOne은 단건을 숫자로 돌려준다(미스면 재구축값)', async () => {
    const { counter } = counterWith(new Map());
    const { likes } = likeRepoCounting(new Map([['p1', 4]]));
    const reader = new LikeCountReader(counter, likes);

    await expect(reader.readOne('p1')).resolves.toBe(4);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- like-count-reader`
Expected: FAIL — `Cannot find module './like-count-reader'`.

- [ ] **Step 3: 구현**

Create `src/board/application/like-count-reader.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { LIKE_COUNTER, LikeCounter } from './like-counter';
import {
  POST_LIKE_REPOSITORY,
  PostLikeRepository,
} from '../domain/post-like.repository';

// "카운터 우선 → 미스만 DB COUNT → SET NX 백필"의 단일 지점.
// 상세·목록·좋아요/취소 응답이 모두 이 경로로 좋아요 수를 읽는다.
@Injectable()
export class LikeCountReader {
  constructor(
    @Inject(LIKE_COUNTER) private readonly counter: LikeCounter,
    @Inject(POST_LIKE_REPOSITORY) private readonly likes: PostLikeRepository,
  ) {}

  async readMany(postIds: string[]): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    const cached = await this.counter.getMany(postIds);
    const missed = postIds.filter((id) => !cached.has(id));
    if (missed.length === 0) return cached;

    // 미스만 DB 집계. countByPosts는 좋아요 0개인 글을 결과에 안 담으므로
    // 0으로 보정해 백필한다(0도 채워야 다음 조회가 카운터에 적중).
    const counted = await this.likes.countByPosts(missed);
    const rebuilt = new Map(missed.map((id) => [id, counted.get(id) ?? 0]));
    await this.counter.backfill(rebuilt);
    return new Map([...cached, ...rebuilt]);
  }

  async readOne(postId: string): Promise<number> {
    const counts = await this.readMany([postId]);
    return counts.get(postId) ?? 0;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- like-count-reader`
Expected: PASS (4 케이스).

- [ ] **Step 5: 모듈 등록**

`src/board/board.module.ts`:
- import 추가: `import { LikeCountReader } from './application/like-count-reader';`
- `providers`에 `LikeCountReader,` 추가.

- [ ] **Step 6: 빌드 + lint + Commit**

```bash
npm run build && npm run lint:check
git add src/board/application/like-count-reader.ts src/board/application/like-count-reader.spec.ts src/board/board.module.ts
git commit -m "[M11]feat: LikeCountReader — 카운터 우선·미스만 COUNT·0 보정 백필"
```

---

### Task 5: 쓰기 경로 전환 (Like/Unlike use-case)

**Files:**
- Modify: `src/board/application/like-post.use-case.ts`
- Modify: `src/board/application/unlike-post.use-case.ts`
- Test: `src/board/application/like-post.use-case.spec.ts` (갱신)
- Test: `src/board/application/unlike-post.use-case.spec.ts` (갱신)

**Interfaces:**
- Consumes: `LIKE_COUNTER`/`LikeCounter.increment·decrement`(Task 3), `LikeCountReader.readOne`(Task 4).
- Produces: 응답 형태 불변(`{ postId, liked, likeCount }`). 생성자 시그니처 변경 — like: `(posts, likes, membership, txRunner, outbox, counter, reader)`, unlike: `(posts, likes, membership, txRunner, counter, reader)`.

- [ ] **Step 1: like-post 스펙 갱신 (실패 확인용)**

`src/board/application/like-post.use-case.spec.ts` 수정:

상단 import에 추가:
```ts
import { LikeCounter } from './like-counter';
import { LikeCountReader } from './like-count-reader';
```

헬퍼 추가(기존 헬퍼들 근처):
```ts
// increment 호출 여부를 기록하는 카운터 스파이. fail=true면 항상 실패(best-effort 검증용).
function counterSpy(opts: { fail?: boolean } = {}) {
  const incremented: string[] = [];
  const counter: LikeCounter = {
    increment: (postId) => {
      if (opts.fail) return Promise.reject(new Error('redis down'));
      incremented.push(postId);
      return Promise.resolve();
    },
    decrement: () => Promise.resolve(),
    getMany: () => Promise.resolve(new Map()),
    backfill: () => Promise.resolve(),
  };
  return { counter, incremented };
}

function readerReturning(count: number): LikeCountReader {
  return {
    readOne: () => Promise.resolve(count),
    readMany: () => Promise.resolve(new Map()),
  } as unknown as LikeCountReader;
}
```

기존 모든 `new LikePostUseCase(...)` 호출에 **6·7번째 인자**로 `counterSpy().counter`(또는 케이스별 스파이)와 `readerReturning(n)`을 추가한다. 기존에 `likeRepoWith({ count })`로 제어하던 응답 카운트는 이제 `readerReturning(n)`이 담당하므로, 기존 단언 값과 일치하는 n을 넣는다(예: 첫 케이스 `readerReturning(1)`).

케이스 추가/갱신:
```ts
  it('신규 좋아요면 커밋 후 카운터를 증가시킨다', async () => {
    const { counter, incremented } = counterSpy();
    const { likes } = likeRepoWith({ newlyLiked: true, count: 1 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy([]),
      counter,
      readerReturning(1),
    );

    await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(incremented).toEqual([POST_ID]);
  });

  it('재클릭(전이 없음)이면 카운터를 건드리지 않는다', async () => {
    const { counter, incremented } = counterSpy();
    const { likes } = likeRepoWith({ newlyLiked: false, count: 1 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy([]),
      counter,
      readerReturning(1),
    );

    await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(incremented).toEqual([]);
  });

  it('카운터 증가가 실패해도 요청은 성공한다(best-effort)', async () => {
    const { counter } = counterSpy({ fail: true });
    const { likes } = likeRepoWith({ newlyLiked: true, count: 1 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy([]),
      counter,
      readerReturning(1),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).resolves.toEqual({ postId: POST_ID, liked: true, likeCount: 1 });
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- like-post.use-case`
Expected: FAIL — 생성자 인자 개수 불일치(컴파일 에러).

- [ ] **Step 3: like-post 구현 수정**

`src/board/application/like-post.use-case.ts`:

import 추가(및 `Logger`를 `@nestjs/common` import에 추가):
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { LIKE_COUNTER, LikeCounter } from './like-counter';
import { LikeCountReader } from './like-count-reader';
```

클래스에 로거·의존성 추가:
```ts
  private readonly logger = new Logger(LikePostUseCase.name);
```
생성자 파라미터 끝에:
```ts
    @Inject(LIKE_COUNTER) private readonly counter: LikeCounter,
    private readonly reader: LikeCountReader,
```

`execute`의 트랜잭션 블록과 반환부를 다음으로 교체(전이 여부를 밖으로 끌어내고, 커밋 후 카운터 갱신):
```ts
    // 좋아요 insert + outbox 적재를 한 트랜잭션으로. 신규 전이(newlyLiked)일 때만
    // 이벤트를 발행해 재클릭 스팸을 막는다(전이 판단은 DB rowCount 기반).
    let newlyLiked = false;
    await this.txRunner.run(async (tx) => {
      newlyLiked = await this.likes.like(input.postId, input.userId, tx);
      if (newlyLiked) {
        await this.outbox.add(
          {
            eventId: randomUUID(),
            eventType: EventType.LikeCreated,
            occurredAt: new Date().toISOString(),
            actorId: input.userId,
            entityType: EntityType.Post,
            entityId: input.postId,
            payload: { postId: input.postId, buildingId: post.buildingId },
          },
          tx,
        );
      }
    });

    // 카운터 갱신은 커밋 후(롤백 시 drift 방지) + best-effort(실패해도 TTL이 치유).
    if (newlyLiked) {
      try {
        await this.counter.increment(input.postId);
      } catch (err) {
        this.logger.warn(`좋아요 카운터 증가 실패(무시): ${(err as Error).message}`);
      }
    }

    // 카운터 우선 조회(미스면 COUNT 재구축) — 커밋 후 최신 수치.
    const likeCount = await this.reader.readOne(input.postId);
    return { postId: input.postId, liked: true, likeCount };
```

- [ ] **Step 4: like-post 통과 확인**

Run: `npm test -- like-post.use-case`
Expected: PASS (기존 4 + 신규 3 케이스).

- [ ] **Step 5: unlike-post 스펙 갱신**

`src/board/application/unlike-post.use-case.spec.ts` 수정:

import 추가:
```ts
import { LikeCounter } from './like-counter';
import { LikeCountReader } from './like-count-reader';
```

헬퍼 추가:
```ts
function counterSpy(opts: { fail?: boolean } = {}) {
  const decremented: string[] = [];
  const counter: LikeCounter = {
    increment: () => Promise.resolve(),
    decrement: (postId) => {
      if (opts.fail) return Promise.reject(new Error('redis down'));
      decremented.push(postId);
      return Promise.resolve();
    },
    getMany: () => Promise.resolve(new Map()),
    backfill: () => Promise.resolve(),
  };
  return { counter, decremented };
}

function readerReturning(count: number): LikeCountReader {
  return {
    readOne: () => Promise.resolve(count),
    readMany: () => Promise.resolve(new Map()),
  } as unknown as LikeCountReader;
}
```

기존 `likeRepoWith(count)` 헬퍼의 `unlike`가 항상 `true`를 반환하는데, 전이 없음 케이스를 위해 파라미터화한다:
```ts
function likeRepoWith(opts: { count: number; removed?: boolean }): {
  likes: PostLikeRepository;
  getLastTx: () => TransactionClient | undefined;
} {
  let lastTx: TransactionClient | undefined;
  const likes: PostLikeRepository = {
    like: () => Promise.resolve(false),
    unlike: (_p, _u, tx) => {
      lastTx = tx;
      return Promise.resolve(opts.removed ?? true);
    },
    countByPost: () => Promise.resolve(opts.count),
    countByPosts: () => Promise.resolve(new Map()),
    likedPostIds: () => Promise.resolve(new Set()),
    hasLiked: () => Promise.resolve(false),
  };
  return { likes, getLastTx: () => lastTx };
}
```

기존 모든 `new UnlikePostUseCase(...)` 호출에 **5·6번째 인자**(`counter`, `readerReturning(n)`)를 추가하고, 케이스 추가:
```ts
  it('실제 삭제(전이)면 커밋 후 카운터를 감소시킨다', async () => {
    const { counter, decremented } = counterSpy();
    const { likes } = likeRepoWith({ count: 0, removed: true });

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      counter,
      readerReturning(0),
    );

    await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(decremented).toEqual([POST_ID]);
  });

  it('원래 좋아요가 없었으면(전이 없음) 카운터를 건드리지 않는다', async () => {
    const { counter, decremented } = counterSpy();
    const { likes } = likeRepoWith({ count: 0, removed: false });

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      counter,
      readerReturning(0),
    );

    await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(decremented).toEqual([]);
  });

  it('카운터 감소가 실패해도 요청은 성공한다(best-effort)', async () => {
    const { counter } = counterSpy({ fail: true });
    const { likes } = likeRepoWith({ count: 0, removed: true });

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      counter,
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).resolves.toEqual({ postId: POST_ID, liked: false, likeCount: 0 });
  });
```

- [ ] **Step 6: unlike-post 구현 수정**

`src/board/application/unlike-post.use-case.ts`:

import·로거·의존성은 like-post와 동일 방식(`Logger` 추가, `LIKE_COUNTER`·`LikeCountReader` 주입 — 생성자 5·6번째).

`execute`의 트랜잭션 블록과 반환부를 교체:
```ts
    // 취소는 멱등 물리삭제(없으면 no-op). 이벤트는 발행하지 않는다.
    let removed = false;
    await this.txRunner.run(async (tx) => {
      removed = await this.likes.unlike(input.postId, input.userId, tx);
    });

    // 카운터 갱신은 커밋 후 + 실제 전이 시에만, best-effort.
    if (removed) {
      try {
        await this.counter.decrement(input.postId);
      } catch (err) {
        this.logger.warn(`좋아요 카운터 감소 실패(무시): ${(err as Error).message}`);
      }
    }

    const likeCount = await this.reader.readOne(input.postId);
    return { postId: input.postId, liked: false, likeCount };
```

- [ ] **Step 7: 통과 확인 + 전체 회귀**

Run: `npm test -- unlike-post.use-case` → PASS.
Run: `npm test` → 전 스위트 PASS.

- [ ] **Step 8: lint + Commit**

```bash
npm run lint:check
git add src/board/application/like-post.use-case.ts src/board/application/like-post.use-case.spec.ts src/board/application/unlike-post.use-case.ts src/board/application/unlike-post.use-case.spec.ts
git commit -m "[M11]feat: 좋아요/취소가 커밋 후 전이 시에만 카운터 증감(best-effort)"
```

---

### Task 6: 읽기 경로 전환 (Get/List use-case)

**Files:**
- Modify: `src/board/application/get-post.use-case.ts`
- Modify: `src/board/application/list-posts.use-case.ts`
- Test: `src/board/application/get-post.use-case.spec.ts` (갱신)
- Test: `src/board/application/list-posts.use-case.spec.ts` (갱신)

**Interfaces:**
- Consumes: `LikeCountReader.readOne·readMany`(Task 4).
- Produces: 응답 형태 불변(`PostDetailView`/`PostSummaryView`). 생성자 변경 — get: 6번째 인자 `reader`, list: 5번째 인자 `reader`. `POST_LIKE_REPOSITORY` 주입은 유지(`hasLiked`/`likedPostIds`용).

- [ ] **Step 1: get-post 스펙 갱신**

`src/board/application/get-post.use-case.spec.ts`:

import 추가: `import { LikeCountReader } from './like-count-reader';`

헬퍼 추가:
```ts
function readerReturning(count: number): LikeCountReader {
  return {
    readOne: () => Promise.resolve(count),
    readMany: () => Promise.resolve(new Map()),
  } as unknown as LikeCountReader;
}
```

기존 `likeRepoWith({ count, liked })` 헬퍼에서 count는 이제 reader가 담당 — 헬퍼는 `liked`만 남기고(`hasLiked`용) `countByPost`는 `() => Promise.resolve(0)`으로 고정해도 된다. 모든 `new GetPostUseCase(...)`에 **6번째 인자** `readerReturning(n)` 추가(기존 단언의 likeCount 값과 일치하는 n).

- [ ] **Step 2: get-post 구현 수정**

`src/board/application/get-post.use-case.ts`:
- import 추가: `import { LikeCountReader } from './like-count-reader';`
- 생성자 끝에: `private readonly reader: LikeCountReader,`
- `execute`의 병렬 조회를 교체:
```ts
    // 좋아요 수는 카운터 우선(미스 시 COUNT 재구축), likedByMe는 유저별이라 DB.
    // 서로 독립이므로 병렬 조회로 라운드트립을 줄인다.
    const [likeCount, likedByMe] = await Promise.all([
      this.reader.readOne(input.postId),
      this.likes.hasLiked(input.postId, input.userId),
    ]);
```

- [ ] **Step 3: get-post 통과 확인**

Run: `npm test -- get-post.use-case`
Expected: PASS.

- [ ] **Step 4: list-posts 스펙 갱신**

`src/board/application/list-posts.use-case.spec.ts`:

import 추가: `import { LikeCountReader } from './like-count-reader';`

헬퍼 추가:
```ts
function readerWith(counts: Map<string, number>): LikeCountReader {
  return {
    readMany: () => Promise.resolve(counts),
    readOne: () => Promise.resolve(0),
  } as unknown as LikeCountReader;
}
```

기존 `likeRepoWith({ counts, liked })` 헬퍼에서 counts는 reader가 담당 — 헬퍼는 `liked`(likedPostIds)만 유지. 모든 `new ListPostsUseCase(...)`에 **5번째 인자** `readerWith(...)` 추가(기존 단언 값과 일치).

- [ ] **Step 5: list-posts 구현 수정**

`src/board/application/list-posts.use-case.ts`:
- import 추가: `import { LikeCountReader } from './like-count-reader';`
- 생성자 끝에: `private readonly reader: LikeCountReader,`
- `execute`의 병렬 조회를 교체:
```ts
    // 좋아요 수는 카운터 우선 배치(미스만 COUNT), likedByMe는 유저별이라 DB 배치.
    const postIds = summaries.map((s) => s.id);
    const [counts, liked] = await Promise.all([
      this.reader.readMany(postIds),
      this.likes.likedPostIds(input.userId, postIds),
    ]);
```

- [ ] **Step 6: 통과 확인 + 전체 회귀 + 빌드**

Run: `npm test -- list-posts.use-case` → PASS.
Run: `npm test` → 전 스위트 PASS. `npm run build` → 에러 없음.

- [ ] **Step 7: lint + Commit**

```bash
npm run lint:check
git add src/board/application/get-post.use-case.ts src/board/application/get-post.use-case.spec.ts src/board/application/list-posts.use-case.ts src/board/application/list-posts.use-case.spec.ts
git commit -m "[M11]feat: 상세·목록 좋아요 수를 LikeCountReader(카운터 우선)로 조회"
```

---

### Task 7: after 측정 + 문서화

**Files:**
- Modify: `load/results/m11-like-counter.md` (after 행 + 결론)
- Modify: `load/README.md` (M11 결과 섹션 링크/요약 — 기존 표 형식 준수)
- Modify: `README.md` (§3.5 표에 M11 행 추가, 마일스톤 표에 M11 행 추가)
- Modify: `docs/study/마일스톤-학습-노트.md` (M11 항목)

**Interfaces:**
- Consumes: Task 1~6 전부 완료된 코드, Task 2의 before 수치.

- [ ] **Step 1: after 측정 (Task 2와 동일 절차)**

Task 2 Step 1~2와 동일하게 실행하되, 볼륨별 루프에서 `FLUSHALL` 후 **웜업 1회(smoke)** 가 카운터를 재구축하므로 본 측정(load)은 워밍된 카운터 기준이 된다(조건을 결과 문서에 명시). 볼륨 0/200/2000 각각 p95·RPS·에러율 기록 후 앱 종료.

- [ ] **Step 2: 결과 문서 완성**

`load/results/m11-like-counter.md`의 after 행을 채우고 결론 섹션 추가:

```markdown
## 결론
- (실측 기반으로 기술. 예상 골격: 볼륨이 커질수록 before p95가 상승하는지, after는 평평한지,
  역전/무차이 지점은 어디인지. 차이가 미미하면 "현 규모에선 COUNT로 충분, 원 결정 타당" 그대로 기록.)
- drift 수용 근거와 치유 경로(TTL 3600s, SET NX 백필) 요약.
```

- [ ] **Step 3: load/README.md·README·학습 노트 갱신**

- `load/README.md`: 기존 결과 표 아래에 M11 실험 요약 1~2줄 + `load/results/m11-like-counter.md` 링크 추가(기존 문서 형식을 따른다).
- `README.md` §3.5 표에 행 추가(실측값으로 치환):
  ```markdown
  | `GET .../posts` 좋아요 집계 (M11) | load 20VU, 글 50×좋아요 2000 | COUNT p95 (실측) → Redis 카운터 p95 (실측) | 0% | 파생 카운터 캐시 전후 비교 |
  ```
- `README.md` §5(개발 마일스톤) 표에 행 추가:
  ```markdown
  | **M11** ✅ | 측정 기반 성능 개선: 좋아요 카운터 Redis 전환 + k6 전후 측정 | 파생 캐시·원자 카운터·drift/TTL 치유·통제 실험 |
  ```
  (마일스톤 표 섹션 번호는 PR #84 머지 여부에 따라 §5 또는 §6 — 현재 브랜치 기준 위치를 따른다.)
- `docs/study/마일스톤-학습-노트.md`에 M11 섹션: 파생 캐시 vs 진실 원천, 존재-시-증감이 필요한 이유(0→1 함정), SET NX 백필 경합, best-effort 쓰기와 TTL 치유, before/after 수치와 해석. 기존 노트의 목차/형식을 따른다.

- [ ] **Step 4: PR #84 머지 상태 반영**

```bash
git fetch origin && git rebase origin/main
```
rebase 후 README에 「한눈에 보기」 섹션이 존재하면(=#84 머지됨) "측정 기반 접근" 불릿 끝에 M11 결과 한 줄을 덧붙인다(예: `; M11에서 좋아요 집계를 Redis 카운터로 전환해 p95 X→Y ms`). 없으면 이 단계는 건너뛰고 PR 본문에 "#84 머지 후 한 줄 추가 예정"으로 남긴다.

- [ ] **Step 5: 최종 검증 + Commit**

```bash
npm test && npm run build && npm run lint:check
git add load/results/m11-like-counter.md load/README.md README.md docs/study/마일스톤-학습-노트.md
git commit -m "[M11]docs: 전환 후 측정 결과·결론 기록 및 README·학습 노트 갱신"
```

---

## Self-Review

**1. Spec coverage:**
- §2.1 원칙(키·TTL 3600) → Task 3 ✓ / §2.2 포트·어댑터·리더·모듈 → Task 3·4 ✓
- §2.3 쓰기(커밋 후·전이 시·best-effort·reader 응답) → Task 5 ✓
- §2.4 읽기(reader 대체, likedByMe DB 유지, 폴백 없음) → Task 6 ✓
- §2.5 drift 시나리오 → 구현 규칙(존재-시-증감·SET NX)으로 반영(Task 3), 문서화는 Task 7 결론 ✓
- §3.1 시드 → Task 1 ✓ / §3.2 절차(before를 구현 전에) → Task 2가 Task 3~6 앞 ✓ / §3.3 산출물 → Task 2·7 ✓
- §4 테스트 목록 → Task 3~6 스펙 케이스와 1:1 ✓ / §5 마일스톤·커밋 → 각 커밋 메시지·Task 7 ✓

**2. Placeholder scan:** 측정값 자리는 `(기록)`/`(실측)`으로 명시된 **실측 기입 지점**(실행 전에 알 수 없는 값)이며 구현 코드에는 placeholder 없음.

**3. Type consistency:**
- `LikeCounter` 4메서드 시그니처가 포트(T3)·spy(T5)·reader 사용(T4)에서 일치.
- `LikeCountReader.readMany/readOne` 시그니처가 T4 정의·T5/T6 fake에서 일치.
- 생성자 인자 순서: like(…, outbox, counter, reader) / unlike(…, txRunner, counter, reader) / get(…, likes, reader) / list(…, likes, reader) — 각 태스크 Interfaces 블록에 명시.
