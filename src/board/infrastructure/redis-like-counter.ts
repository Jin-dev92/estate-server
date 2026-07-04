import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { LikeCounter, LIKE_COUNT_TTL_SEC } from '../application/like-counter';

// 게시글별 좋아요 카운터 키.
function countKey(postId: string): string {
  return `board:like:count:${postId}`;
}

// 존재할 때만 증감 + TTL 갱신. EXISTS 확인과 증감 사이에 만료가 끼지 않도록 Lua로 원자화.
// (미스 키에 그냥 INCR하면 0→1이 되어 실제 카운트를 잃는다 — 미스는 backfill 몫)
// 하한 0 보정: stale-low 키에 decrement가 겹치면 음수가 될 수 있어, 사용자에게 -1 같은
// 값이 노출되지 않도록 0으로 클램프한다(RedisNotificationCounter.decrement와 동일 패턴).
const INCRBY_IF_EXISTS = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    local v = redis.call('INCRBY', KEYS[1], ARGV[1])
    if v < 0 then redis.call('SET', KEYS[1], '0') end
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
      pipeline.set(
        countKey(postId),
        String(count),
        'EX',
        LIKE_COUNT_TTL_SEC,
        'NX',
      );
    }
    await pipeline.exec();
  }
}
