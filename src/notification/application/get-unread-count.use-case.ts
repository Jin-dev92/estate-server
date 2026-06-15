import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_COUNTER,
  NotificationCounter,
} from '../domain/notification-counter';

@Injectable()
export class GetUnreadCountUseCase {
  constructor(
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
  ) {}

  execute(userId: string): Promise<number> {
    return this.counter.get(userId);
  }
}
