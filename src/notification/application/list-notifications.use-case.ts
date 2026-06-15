import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../domain/notification.repository';
import { Notification } from '../domain/notification.entity';

@Injectable()
export class ListNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
  ) {}

  execute(userId: string, limit: number): Promise<Notification[]> {
    return this.repo.listForUser(userId, limit);
  }
}
