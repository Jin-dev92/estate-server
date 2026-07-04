# M11 — 측정 기반 성능 개선: 좋아요 카운터 Redis 전환 설계

- 작성일: 2026-07-04
- 배경: 채용 관점 개선 로드맵 ②(순서: README 서사 → **성능 개선 스토리** → 분산 트레이싱 → 라이브 데모 → Testcontainers)
- 참조: `docs/superpowers/specs/2026-07-03-post-like-design.md` §7.3(라이브 COUNT 채택 + 대규모 전환 탈출구), `load/README.md`(M7 baseline), README §3.5

## 1. 목표 / 스토리 프레이밍

M2 좋아요 설계에서 우리는 "현 규모에선 라이브 `COUNT(*)`"를 선택하고, 대규모 전환 탈출구(Redis 카운터/비정규화)를 §7.3에 남겼다. M11은 그 탈출구를 **측정과 함께 실제로 걷는 통제 실험**이다(M8과 같은 방법론).

**산출물은 "수치가 달린 서사"다**: 좋아요 볼륨을 시드로 키워 집계 비용이 보이는 조건을 만들고 → baseline 측정 → Redis 카운터 전환 → 동일 조건 재측정 → 문서화.

**정직한 결론 허용**: 결과를 미리 정하지 않는다. "볼륨 X까지는 COUNT로 충분(원 결정이 옳았음을 수치로 확인), X부터 카운터가 역전" 같은 결론도 그 자체로 가치 있는 스토리다. 개선 폭이 안 보이면 그렇게 기록한다.

## 2. Redis 카운터 설계

### 2.1 원칙
- **진실 원천은 DB(PostLike 행) 유지. Redis는 파생 캐시다.** 카운터가 틀려도(drift) DB에서 언제든 재구축 가능해야 한다.
- 키: `board:like:count:{postId}`. 키 빌더·prefix 상수는 어댑터 파일 내부에 둔다(기존 `redis-board-cache`·`redis-notification-counter` 컨벤션 — 중앙 RedisKey enum 없음).
- **TTL 부여**(drift 상한 보장): 만료되면 다음 조회가 COUNT로 재구축한다. 값은 **3600s**로 확정(상수로 명시). **TTL은 backfill이 최초로 심고, 이후 증감(INCR/DECR)은 TTL을 갱신하지 않는다.** 그래야 활성 글도 "마지막 재구축 + TTL" 시점에 반드시 만료되어, drift 최대 지속 시간이 TTL로 상한(hard ceiling)이 걸린다. (증감마다 EXPIRE로 TTL을 슬라이딩하면 인기 글은 영원히 만료되지 않아, best-effort 증감이 조용히 실패했을 때 drift가 무기한 남는다 — 그래서 슬라이딩을 배제한다.) `redis-board-cache`의 안전망 TTL(120s)보다 긴 이유: 카운터 TTL은 무효화 이벤트가 없어 재구축 주기 그 자체이므로, 활성 글의 주기적 COUNT 부담과 drift 상한 사이 균형점으로 길게 잡는다.

### 2.2 포트 / 어댑터
- 새 포트 `LIKE_COUNTER` (`src/board/application/like-counter.ts`):
  ```
  increment(postId): Promise<void>      // 키가 "존재할 때만" +1 (Lua 원자, TTL 미갱신)
  decrement(postId): Promise<void>      // 키가 "존재할 때만" -1 (Lua 원자, 음수는 0 KEEPTTL 보정)
  getMany(postIds): Promise<Map<postId, number>>   // MGET. 미스는 맵에서 제외
  backfill(entries: Map<postId, number>): Promise<void>  // SET NX EX(TTL) 일괄 — TTL의 유일한 소유자
  ```
- **increment/decrement가 "존재할 때만"인 이유(핵심)**: 만료된(미스) 키에 그냥 INCR하면 0→1이 되어 실제 카운트(예: 500)를 잃는다. 미스는 건드리지 않고 다음 읽기의 COUNT 재구축(backfill)에 맡긴다. EXISTS 확인과 증감 사이에 만료가 끼지 않도록 Lua로 원자화한다.
- **backfill이 SET NX인 이유**: 동시 rebuild 경합에서 이미 채워진 뒤 INCR까지 반영된 키를 stale COUNT로 덮어쓰지 않기 위해서다(먼저 쓴 쪽이 이기고, 이후 증감은 그 위에 누적).
- Redis 어댑터 `src/board/infrastructure/redis-like-counter.ts` — `RedisService` 주입, `redis-notification-counter` 패턴 미러.
- **조합 헬퍼 `LikeCountReader`** (`src/board/application/like-count-reader.ts`, 일반 `@Injectable` 클래스): "카운터 우선 → 미스만 `countByPosts` → 0 보정 포함 backfill → 병합"의 단일 지점. `readMany(postIds)`·`readOne(postId)` 제공. 상세·목록·좋아요/취소 응답이 모두 이 경로로 읽는다. (countByPosts는 좋아요 0개 글을 결과에 안 담으므로 0을 명시 백필해야 다음 조회가 적중한다.)
- `board.module.ts`에 `{ provide: LIKE_COUNTER, useClass: RedisLikeCounter }` + `LikeCountReader` 등록.

### 2.3 쓰기 경로 (Like/Unlike use-case)
- **트랜잭션 커밋 후**, **전이 bool이 true일 때만** `increment`/`decrement`.
  - 커밋 전 갱신은 롤백 시 drift → 커밋 후가 맞다. 알림 미읽음 카운터(saveIfNew 성공 시에만 increment)와 동일한 기존 패턴.
  - 카운터 갱신은 best-effort: 실패해도 요청을 실패시키지 않는다(try/catch + warn 로그 — 알림 relay.publish와 동일 스탠스). 실패분은 TTL 치유.
- 응답 `likeCount`는 §2.4와 동일한 "카운터 우선, 미스 시 COUNT 폴백+백필" 헬퍼로 조회해 반환한다. 기존의 무조건 `countByPost` 직접 호출은 이 헬퍼 호출로 대체된다.

### 2.4 읽기 경로 (Get/List use-case)
- Get/List use-case는 기존 `countByPost`/`countByPosts` 직접 호출을 `LikeCountReader.readOne`/`readMany`(§2.2) 호출로 대체한다. 리더 내부가 "카운터 우선 → 미스만 DB → 백필"을 수행.
- `likedByMe`(hasLiked/likedPostIds)는 유저별 데이터라 **그대로 DB**.
- 읽기 경로의 Redis 장애 처리는 기존 `BoardCache`와 동일 스탠스(별도 폴백 없음) — 캐시 계층 전반의 일관성 유지, 개별 폴백은 YAGNI.

### 2.5 drift 시나리오 (명시적 수용)
| 시나리오 | 결과 | 치유 |
|---|---|---|
| 커밋 후 increment 직전 크래시/Redis 장애 | 카운터 1 작음 | TTL 만료 → COUNT 재구축 |
| 카운터 미스 상태에서 좋아요(증감 스킵) | 반영 안 됨 | 다음 읽기의 COUNT 재구축이 정확값 포함(커밋이 먼저라 행은 이미 존재) |
| 동시 rebuild 경합(둘 다 미스→COUNT→SET NX) | 먼저 쓴 쪽 승리 | 둘 다 COUNT 기반이라 어느 쪽이든 근사 정확, 이후 증감은 그 위에 누적 |
| rebuild의 COUNT와 SET NX 사이에 증감 발생 | 순간 ±1 | TTL 치유. 좋아요 UI에서 무해(M2 §7.5와 동일 수용) |

> **TTL 상한 보장 (활성 글 포함) — 설계 결정:** 위 표의 "TTL 치유"가 활성 글에도 성립하려면 TTL이 만료돼야 한다. 그래서 **증감(INCR/DECR)은 TTL을 갱신하지 않고, TTL은 backfill이 최초 재구축 때만 심는다.** 결과적으로 어떤 글이든 "마지막 재구축 + TTL(3600s)" 시점에 반드시 만료되어 다음 읽기가 COUNT로 재구축한다 — **drift 최대 지속 시간이 TTL로 상한**이 걸린다(활성/비활성 무관). 만약 증감마다 `EXPIRE`로 TTL을 슬라이딩했다면, 인기 글은 영원히 만료되지 않아 best-effort 증감이 조용히 실패(현재 `Logger.warn`)했을 때 그 글의 drift가 무기한 남았을 것이다. 비용은 활성 글의 시간당 1회 COUNT 재구축(인덱스 조회·목록은 배치라 무의미한 수준). *남은 후속(별건): best-effort 실패를 Sentry/메트릭으로 가시화하면 상한 이전에도 탐지 가능 — 관측성 마일스톤으로 미룸.* (PR #85 리뷰 게이트 지적 반영)

- **반대로 했다면(비정규화 컬럼)**: 트랜잭션 정합은 쉬우나 인기 글 핫로우 락 경합·재집계 배치가 필요 — M2 §7.3 논의 유지.

## 3. 측정 계획

### 3.1 시드 확장 (`prisma/seed-load.ts`)
- 기존 멱등 upsert 패턴 유지. 파라미터화: `SEED_POST_COUNT`(기본 5 → env로 50), `SEED_LIKES_PER_POST`(env, 예: 0 / 200 / 2000).
- 좋아요는 유니크 제약(postId,userId) 때문에 **liker 유저를 벌크 생성**(`createMany skipDuplicates`) 후 `postLike.createMany(skipDuplicates)`로 멱등 시드.
- 측정 전 Redis 카운터 키 초기화 절차(FLUSHDB 또는 키 패턴 삭제)를 load/README에 명시 — cold/warm 구분 측정.

### 3.2 시나리오·절차
- 시나리오: 기존 `load/scenarios/read-posts.js`(목록 = GROUP BY IN(N) 경로) 재사용. 동일 프로파일(load 20VU)로 before/after.
- 변인: 좋아요 볼륨(글 50개 × 좋아요 0/200/2000) × 구현(COUNT vs Redis 카운터). 그 외 조건 고정(M7과 동일한 로컬 단일 머신 주의사항 명시).
- before 측정은 **전환 커밋 이전 코드**로 실행(브랜치에서 구현 전 측정 → 커밋 → 구현 → 재측정 순서로 진행하면 체크아웃 왕복 불필요).

### 3.3 산출물
- `load/README.md`: before/after 표(p95·RPS·에러율) + 실험 조건 + 결론.
- README §3.5 표에 M11 행 추가, 「한눈에 보기」의 "측정 기반 접근" 줄에 결과 한 줄 반영 — **PR #84(README 개편) 머지 이후 rebase해서 반영**(의존성).
- `docs/study/마일스톤-학습-노트.md`에 M11 항목(Redis 원자 카운터·파생 캐시·drift/TTL 치유·통제 실험) 추가.

## 4. 테스트

- `redis-like-counter.spec.ts`: RedisService mock — increment/decrement가 "존재 시에만 증감" Lua를 올바른 인자(±1, TTL)로 실행, getMany가 MGET 미스 제외, backfill이 SET NX+TTL, 빈 입력 가드.
- `like-count-reader.spec.ts`: 전량 히트→DB 미호출·백필 없음 / 부분 미스→미스만 countByPosts·0 보정 포함 backfill·병합 반환 / 빈 입력.
- `like-post`/`unlike-post` use-case spec 갱신: 전이 true→increment/decrement 호출, 전이 false(재클릭·미존재 취소)→호출 안 함, 카운터 실패해도 요청 성공(best-effort), 응답 likeCount는 reader 경유.
- `get-post`/`list-posts` use-case spec 갱신: countByPost(s) 직접 호출 대신 reader 사용.
- 기존 217+ 테스트 회귀 없음, lint:check·build 통과.

## 5. 마일스톤·커밋

- 마일스톤 표에 **M11 — 측정 기반 성능 개선(좋아요 카운터 Redis 전환 + k6 전후 측정)** 추가.
- 커밋 티켓 `[M11]`.

## 6. 범위 밖

- WS 실시간 카운트 동기화, 좋아요 외 집계의 캐시화, Redis 클러스터/샤딩, likedByMe 캐시화.
