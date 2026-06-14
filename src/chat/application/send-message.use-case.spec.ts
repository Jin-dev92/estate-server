import { SendMessageUseCase } from './send-message.use-case';
import { ChatRoom } from '../domain/chat-room.entity';
import { ChatRoomRepository } from '../domain/chat-room.repository';
import { MessageRelay } from '../domain/message-relay';
import { MessageCache } from '../domain/message-cache';
import { ChatMessagePayload } from '../domain/chat-message';
import { EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

const ROOM = 'r1';
const OWNER = 'owner1';
const TENANT = 't1';

function deps(room: ChatRoom | null) {
  const rooms: Partial<ChatRoomRepository> = {
    findById: () => Promise.resolve(room),
  };
  const relayed: ChatMessagePayload[] = [];
  const relay: MessageRelay = {
    publish: (m) => {
      relayed.push(m);
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve(),
  };
  const cached: ChatMessagePayload[] = [];
  const cache: MessageCache = {
    push: (m) => {
      cached.push(m);
      return Promise.resolve();
    },
    getRecent: () => Promise.resolve([]),
  };
  const published: unknown[] = [];
  const events: EventPublisher = {
    publish: (e) => {
      published.push(e);
      return Promise.resolve();
    },
  };
  return { rooms, relay, cache, events, relayed, cached, published };
}

const room = ChatRoom.reconstitute({
  id: ROOM,
  buildingId: 'b1',
  ownerId: OWNER,
  tenantId: TENANT,
});

describe('SendMessageUseCase', () => {
  it('참가자가 보내면 relay·cache·Kafka에 모두 발행한다', async () => {
    const { rooms, relay, cache, events, relayed, cached, published } =
      deps(room);
    const useCase = new SendMessageUseCase(
      rooms as ChatRoomRepository,
      relay,
      cache,
      events,
    );

    const sent = await useCase.execute({
      userId: OWNER,
      roomId: ROOM,
      content: '안녕',
    });

    expect(relayed[0]).toMatchObject({
      roomId: ROOM,
      senderId: OWNER,
      content: '안녕',
      messageId: sent.messageId,
    });
    expect(cached[0]).toMatchObject({ messageId: sent.messageId });
    expect(published).toEqual([
      expect.objectContaining({
        eventType: EventType.MessageSent,
        entityType: EntityType.Message,
        entityId: ROOM,
      }),
    ]);
  });

  it('참가자가 아니면 NOT_ROOM_PARTICIPANT, 아무것도 발행 안 함', async () => {
    const { rooms, relay, cache, events, relayed, published } = deps(room);
    const useCase = new SendMessageUseCase(
      rooms as ChatRoomRepository,
      relay,
      cache,
      events,
    );

    await expect(
      useCase.execute({ userId: 'stranger', roomId: ROOM, content: 'x' }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_ROOM_PARTICIPANT' });
    expect(relayed).toEqual([]);
    expect(published).toEqual([]);
  });

  it('없는 방이면 ROOM_NOT_FOUND', async () => {
    const { rooms, relay, cache, events } = deps(null);
    const useCase = new SendMessageUseCase(
      rooms as ChatRoomRepository,
      relay,
      cache,
      events,
    );

    await expect(
      useCase.execute({ userId: OWNER, roomId: ROOM, content: 'x' }),
    ).rejects.toMatchObject({ code: 'CHAT_ROOM_NOT_FOUND' });
  });
});
