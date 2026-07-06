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

  // 행을 읽음 처리하고 미읽음 카운터를 리셋(키 삭제)한다.
  // reset은 값을 0으로 덮지 않고 키를 지우므로, markAllRead와 reset 사이에 들어온
  // 새 알림이 있어도 다음 읽기(GetUnreadCount)가 DB COUNT로 재집계해 자가 교정한다.
  // (과거의 "0으로 덮어 과소 집계" 드리프트 창은 읽기 시 DB COUNT 폴백으로 해소됨)
  async execute(userId: string): Promise<void> {
    await this.repo.markAllRead(userId);
    await this.counter.reset(userId);
  }
}
