import { AuditWorkerController } from './audit-worker.controller';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

const event: DomainEvent = {
  eventId: 'e1',
  eventType: EventType.CommentCreated,
  occurredAt: '2026-06-15T00:00:00.000Z',
  actorId: 'u1',
  entityType: EntityType.Comment,
  entityId: 'c1',
  payload: { postId: 'p1' },
};

// trace 헤더가 없는 상황을 흉내내는 가짜 KafkaContext(continueTraceFromHeaders는 폴백되어 fn만 실행됨).
const fakeCtx = {
  getMessage: () => ({ headers: {} }),
} as unknown as import('@nestjs/microservices').KafkaContext;

describe('AuditWorkerController', () => {
  it('chat·board·membership 이벤트를 AuditLogRepository로 위임한다', async () => {
    const recorded: DomainEvent[] = [];
    const audit = {
      record: (e: DomainEvent) => {
        recorded.push(e);
        return Promise.resolve();
      },
    };
    const controller = new AuditWorkerController(audit);

    await controller.onChatEvent(event, fakeCtx);
    await controller.onBoardEvent(event, fakeCtx);
    await controller.onMembershipEvent(event, fakeCtx);

    expect(recorded).toHaveLength(3);
  });
});
