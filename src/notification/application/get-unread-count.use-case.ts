import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_COUNTER,
  NotificationCounter,
} from '../domain/notification-counter';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../domain/notification.repository';

@Injectable()
export class GetUnreadCountUseCase {
  constructor(
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
  ) {}

  // "카운터 우선 → 미스만 DB COUNT → SET NX 백필"의 단일 지점.
  // 캐시가 있으면 그대로, 없으면(TTL 만료·eviction) DB에서 재집계해 캐시를 되살린다.
  async execute(userId: string): Promise<number> {
    const cached = await this.counter.get(userId);
    if (cached !== null) return cached;

    const count = await this.repo.countUnread(userId);
    await this.counter.backfill(userId, count);
    return count;
  }
}
