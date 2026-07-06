import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  NotificationCounter,
  UNREAD_COUNT_TTL_SEC,
} from '../domain/notification-counter';

// 미읽음 카운터는 `COUNT(*) WHERE readAt IS NULL`의 파생 캐시다. 진실 원천은 DB이며,
// TTL 만료·eviction으로 키가 사라져도 읽기 경로(get→null→DB COUNT→backfill)가
// 재구축하므로 유실이 영구화되지 않는다.
// 사용자별 미읽음 카운터 키.
function unreadKey(userId: string): string {
  return `notif:unread:${userId}`;
}

// 존재할 때만 +1(원자). 미스 키에 INCR하면 0→1로 실제 미읽음 수를 잃으므로 건드리지
// 않고, 재구축은 읽기 경로(backfill)의 몫으로 남긴다. TTL은 backfill만 소유한다.
const INCR_IF_EXISTS = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('INCR', KEYS[1])
  end
`;

// 존재할 때만 -1(원자). 0 하한 보정하되 SET은 KEEPTTL로 남은 만료를 보존한다
// (SET이 TTL을 날리면 drift 상한 보장이 깨지므로). DECR·보정을 한 블록으로 원자화.
const DECR_IF_EXISTS = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    local v = redis.call('DECR', KEYS[1])
    if v < 0 then redis.call('SET', KEYS[1], '0', 'KEEPTTL') end
  end
`;

@Injectable()
export class RedisNotificationCounter implements NotificationCounter {
  constructor(private readonly redis: RedisService) {}

  async increment(userId: string): Promise<void> {
    await this.redis.runScript(INCR_IF_EXISTS, [unreadKey(userId)]);
  }

  async decrement(userId: string): Promise<void> {
    await this.redis.runScript(DECR_IF_EXISTS, [unreadKey(userId)]);
  }

  async get(userId: string): Promise<number | null> {
    const v = await this.redis.get(unreadKey(userId));
    return v === null ? null : Number(v);
  }

  async backfill(userId: string, count: number): Promise<void> {
    // 미스 채움: SET NX(+TTL). 경합 중 이미 채워진(그 뒤 증감까지 반영됐을 수 있는)
    // 키는 덮지 않는다. TTL은 오직 여기서 심어 drift 상한을 건다.
    await this.redis.set(
      unreadKey(userId),
      String(count),
      'EX',
      UNREAD_COUNT_TTL_SEC,
      'NX',
    );
  }

  async reset(userId: string): Promise<void> {
    // 전건 읽음: 키를 지운다. 다음 읽기가 DB COUNT(=0)로 재구축하며 TTL을 다시 심는다.
    await this.redis.del(unreadKey(userId));
  }
}
