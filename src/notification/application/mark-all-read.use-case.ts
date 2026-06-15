import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../domain/notification.repository';
import {
  NOTIFICATION_COUNTER,
  NotificationCounter,
} from '../domain/notification-counter';

@Injectable()
export class MarkAllReadUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
  ) {}

  // 행을 읽음 처리하고 미읽음 카운터를 0으로 리셋한다.
  async execute(userId: string): Promise<void> {
    await this.repo.markAllRead(userId);
    await this.counter.reset(userId);
  }
}
