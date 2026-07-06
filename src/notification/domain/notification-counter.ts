export const NOTIFICATION_COUNTER = Symbol('NOTIFICATION_COUNTER');

// 미읽음 카운터 TTL(초). 진실 원천은 DB(readAt IS NULL 행 수)이고 이 캐시는 그 파생이다.
// 무효화 이벤트가 없어 TTL이 유일한 drift 상한 — 만료되면 읽기 경로가 DB COUNT로 재구축한다.
// (좋아요 카운터와 동일한 전략. 자세한 근거는 like-counter.ts 참고)
export const UNREAD_COUNT_TTL_SEC = 3600;

// 사용자별 미읽음 카운트의 Redis 파생 캐시. 진실 원천은 DB다.
export interface NotificationCounter {
  // 키가 "존재할 때만" +1(Lua 원자). 미스 키에 INCR하면 0→1로 실제 미읽음 수를 잃으므로
  // 건드리지 않고, 재구축은 읽기 경로(backfill)에 맡긴다.
  increment(userId: string): Promise<void>;
  // 키가 "존재할 때만" -1, 0 하한 보정(KEEPTTL). 규칙은 increment와 동일.
  decrement(userId: string): Promise<void>;
  // 캐시 조회. 미스면 null(0과 구분) → 호출부가 DB COUNT로 재구축하도록 신호한다.
  get(userId: string): Promise<number | null>;
  // 미스 채움: SET NX(+TTL). 경합 중 이미 채워진(증감 반영) 키는 덮지 않는다.
  backfill(userId: string, count: number): Promise<void>;
  // 전건 읽음: 키 삭제(다음 읽기가 DB COUNT로 0을 재구축, TTL 재부여).
  reset(userId: string): Promise<void>;
}
