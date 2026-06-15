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
  // 주의(드리프트 창): 행 DB와 Redis 카운터는 서로 다른 저장소이며 워커가 그 사이에
  // 새 알림을 적재(INCR)할 수 있다. markAllRead와 reset 사이에 들어온 알림은
  // 카운터가 0으로 덮여 미읽음으로 안 잡힐 수 있다(과소 집계). 학습 범위에서 허용하며,
  // 엄밀 정합성은 읽기 시 DB COUNT 폴백/주기적 재동기화로 보강 가능(후속 과제).
  async execute(userId: string): Promise<void> {
    await this.repo.markAllRead(userId);
    await this.counter.reset(userId);
  }
}
