import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { LikeCounter, LIKE_COUNT_TTL_SEC } from '../application/like-counter';

// 게시글별 좋아요 카운터 키.
function countKey(postId: string): string {
  return `board:like:count:${postId}`;
}

// 존재할 때만 증감(원자). EXISTS 확인과 증감 사이에 만료가 끼지 않도록 Lua로 묶는다.
// (미스 키에 그냥 INCR하면 0→1이 되어 실제 카운트를 잃는다 — 미스 재구축은 backfill 몫)
//
// TTL은 여기서 "갱신하지 않는다". TTL은 오직 backfill이 최초로 심는다 → 증감이 잦은
// 활성 글도 마지막 재구축 후 LIKE_COUNT_TTL_SEC가 지나면 반드시 만료되고, 다음 읽기가
// COUNT로 재구축한다. 즉 drift 최대 지속 시간이 TTL로 상한(hard ceiling)이 걸린다.
// (매 증감마다 EXPIRE로 TTL을 슬라이딩하면 인기 글은 영원히 만료되지 않아, best-effort
//  증감이 조용히 실패했을 때 그 글의 drift가 무기한 남는다 — 그래서 슬라이딩을 뺐다.)
//
// 하한 0 보정: stale-low 키에 decrement가 겹치면 음수가 될 수 있어 사용자에게 -1이
// 노출되지 않도록 0으로 클램프한다. 단 SET은 TTL을 날리므로 KEEPTTL로 남은 만료를
// 보존한다(상한 보장을 깨지 않기 위해). INCRBY 자체는 TTL을 건드리지 않는다.
const INCRBY_IF_EXISTS = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    local v = redis.call('INCRBY', KEYS[1], ARGV[1])
    if v < 0 then redis.call('SET', KEYS[1], '0', 'KEEPTTL') end
  end
`;

@Injectable()
export class RedisLikeCounter implements LikeCounter {
  constructor(private readonly redis: RedisService) {}

  async increment(postId: string): Promise<void> {
    // TTL 인자 없음 — 증감은 TTL을 갱신하지 않는다(backfill만 소유, 상한 보장).
    await this.redis.runScript(INCRBY_IF_EXISTS, [countKey(postId)], [1]);
  }

  async decrement(postId: string): Promise<void> {
    await this.redis.runScript(INCRBY_IF_EXISTS, [countKey(postId)], [-1]);
  }

  async getMany(postIds: string[]): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    // Cluster 전환 대비: 서로 다른 postId 키는 슬롯이 흩어져 MGET이 CROSSSLOT 에러를 낸다.
    // 키별 GET을 파이프라인으로 묶으면 standalone·Cluster 모두 안전하다(ioredis가
    // Cluster에선 노드별로 명령을 분배). 왕복 1회로 묶는 이점도 그대로 유지된다.
    const pipeline = this.redis.pipeline();
    postIds.forEach((id) => pipeline.get(countKey(id)));
    const rows = await pipeline.exec();
    const result = new Map<string, number>();
    postIds.forEach((id, i) => {
      // exec 결과는 [error, value] 튜플의 배열. 에러 슬롯은 미스로 간주해 건너뛴다.
      const [err, value] = rows?.[i] ?? [null, null];
      if (!err && value !== null && value !== undefined) {
        result.set(id, Number(value));
      }
    });
    return result;
  }

  async remove(postId: string): Promise<void> {
    await this.redis.del(countKey(postId));
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
