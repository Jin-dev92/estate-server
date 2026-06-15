import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { NotificationCounter } from '../domain/notification-counter';

// 미읽음 카운터는 `COUNT(*) WHERE readAt IS NULL`의 비정규화 캐시다.
// 따라서 이 키가 든 Redis는 eviction이 없는(영속/별도 논리 DB) 인스턴스여야 한다.
// LRU 등으로 키가 사라지면 미읽음 수가 0으로 유실된다(행은 남음). 정합성 회복은
// 후속 과제: 읽기 시 DB COUNT 폴백 또는 주기적 재동기화.
// 사용자별 미읽음 카운터 키.
function unreadKey(userId: string): string {
  return `notif:unread:${userId}`;
}

@Injectable()
export class RedisNotificationCounter implements NotificationCounter {
  constructor(private readonly redis: RedisService) {}

  async increment(userId: string): Promise<void> {
    // 원자적 증가. 동시 알림에도 카운트 유실 없음.
    await this.redis.incr(unreadKey(userId));
  }

  async get(userId: string): Promise<number> {
    const v = await this.redis.get(unreadKey(userId));
    return v ? Number(v) : 0;
  }

  async reset(userId: string): Promise<void> {
    await this.redis.del(unreadKey(userId));
  }
}
