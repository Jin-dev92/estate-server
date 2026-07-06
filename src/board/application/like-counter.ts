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
  // 글 삭제 시 파생 카운터 키를 제거한다(orphan 방지). TTL로도 자가 소멸하나,
  // Mutation(Delete) 시 관련 캐시 키를 함께 무효화하는 컨벤션을 지킨다.
  remove(postId: string): Promise<void>;
}
