import { ChatPersistenceController } from './chat-persistence.controller';
import { MessageRepository } from '../domain/message.repository';
import { ChatMessagePayload } from '../domain/chat-message';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

const payload: ChatMessagePayload = {
  roomId: 'r1',
  messageId: 'm1',
  senderId: 'u1',
  content: 'hello',
  createdAt: '2026-06-15T00:00:00.000Z',
};

const event: DomainEvent<ChatMessagePayload> = {
  eventId: 'e1',
  eventType: EventType.MessageSent,
  occurredAt: '2026-06-15T00:00:00.000Z',
  actorId: 'u1',
  entityType: EntityType.Message,
  entityId: 'm1',
  payload,
};

// trace 헤더가 없는 상황을 흉내내는 가짜 KafkaContext(continueTraceFromHeaders는 폴백되어 fn만 실행됨).
const fakeCtx = {
  getMessage: () => ({ headers: {} }),
} as unknown as import('@nestjs/microservices').KafkaContext;

describe('ChatPersistenceController', () => {
  it('chat 이벤트 payload를 MessageRepository로 위임한다', async () => {
    const persisted: ChatMessagePayload[] = [];
    const messages = {
      persist: (p: ChatMessagePayload) => {
        persisted.push(p);
        return Promise.resolve();
      },
    };
    const controller = new ChatPersistenceController(
      messages as unknown as MessageRepository,
    );

    await controller.onMessageSent(event, fakeCtx);

    expect(persisted).toEqual([payload]);
  });
});
