import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainEvent } from '../../events/domain-event';
import { buildContent } from '../domain/notification-content';
import { Notification } from '../domain/notification.entity';
import {
  RECIPIENT_RESOLVER,
  RecipientResolver,
} from '../domain/recipient-resolver';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../domain/notification.repository';
import {
  NOTIFICATION_COUNTER,
  NotificationCounter,
} from '../domain/notification-counter';
import {
  NOTIFICATION_RELAY,
  NotificationRelay,
} from '../domain/notification-relay';

// 컨슈머가 받은 도메인 이벤트 1건을 수신자별 알림으로 팬아웃한다.
// 멱등: saveIfNew가 신규 행을 반환할 때만 카운터 증가·푸시한다(중복 소비 안전).
@Injectable()
export class HandleEventUseCase {
  private readonly logger = new Logger(HandleEventUseCase.name);

  constructor(
    @Inject(RECIPIENT_RESOLVER) private readonly resolver: RecipientResolver,
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repo: NotificationRepository,
    @Inject(NOTIFICATION_COUNTER) private readonly counter: NotificationCounter,
    @Inject(NOTIFICATION_RELAY) private readonly relay: NotificationRelay,
  ) {}

  async execute(event: DomainEvent): Promise<void> {
    const content = buildContent(event);
    if (!content) return; // 알림 대상 아닌 이벤트

    const recipients = await this.resolver.resolve(event);
    for (const recipientId of recipients) {
      const created = await this.repo.saveIfNew(
        Notification.create({
          recipientId,
          type: content.type,
          title: content.title,
          body: content.body,
          entityType: content.entityType,
          entityId: content.entityId,
          eventId: event.eventId,
        }),
      );
      if (!created) continue; // 이미 처리된 수신자 → 카운터·푸시 스킵

      await this.counter.increment(recipientId);
      // 푸시는 best-effort: 실패해도 적재·카운터(진실 원천)를 막지 않는다.
      try {
        await this.relay.publish({
          recipientId,
          notification: {
            id: created.id!,
            type: content.type,
            title: content.title,
            body: content.body,
            entityType: content.entityType,
            entityId: content.entityId,
            createdAt: (created.createdAt ?? new Date()).toISOString(),
          },
        });
      } catch (err) {
        this.logger.warn(`알림 푸시 실패: ${(err as Error).message}`);
      }
    }
  }
}
