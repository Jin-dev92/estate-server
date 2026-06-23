import { ListRoomsUseCase } from './list-rooms.use-case';
import { ChatRoom } from '../domain/chat-room.entity';
import { ChatRoomRepository } from '../domain/chat-room.repository';
import { MessageCache } from '../domain/message-cache';
import { MessageRepository } from '../domain/message.repository';
import { ChatMessagePayload } from '../domain/chat-message';
import { Message } from '../domain/message.entity';

const OWNER = 'owner1';
function room(id: string, tenantId: string) {
  return ChatRoom.reconstitute({
    id,
    buildingId: 'b1',
    ownerId: OWNER,
    tenantId,
  });
}
function payload(roomId: string, createdAt: string): ChatMessagePayload {
  return {
    roomId,
    messageId: `m-${roomId}`,
    senderId: OWNER,
    content: `c-${roomId}`,
    createdAt,
  };
}

function build(opts: {
  rooms: ChatRoom[];
  cacheByRoom?: Record<string, ChatMessagePayload[]>;
  dbByRoom?: Record<string, Message[]>;
}) {
  const rooms: Partial<ChatRoomRepository> = {
    findByParticipant: () => Promise.resolve(opts.rooms),
  };
  const cache: Partial<MessageCache> = {
    getRecent: (roomId: string) =>
      Promise.resolve(opts.cacheByRoom?.[roomId] ?? []),
  };
  const messages: Partial<MessageRepository> = {
    findRecent: (roomId: string) =>
      Promise.resolve(opts.dbByRoom?.[roomId] ?? []),
  };
  return new ListRoomsUseCase(
    rooms as ChatRoomRepository,
    cache as MessageCache,
    messages as MessageRepository,
  );
}

describe('ListRoomsUseCase', () => {
  it('각 방의 마지막 메시지를 붙인다', async () => {
    const useCase = build({
      rooms: [room('r1', 't1')],
      cacheByRoom: { r1: [payload('r1', '2026-06-20T00:00:00.000Z')] },
    });
    const result = await useCase.execute(OWNER);
    expect(result[0].room.id).toBe('r1');
    expect(result[0].lastMessage?.content).toBe('c-r1');
  });

  it('마지막 메시지 시각 내림차순으로 정렬한다(없는 방은 뒤)', async () => {
    const useCase = build({
      rooms: [room('old', 't1'), room('none', 't2'), room('new', 't3')],
      cacheByRoom: {
        old: [payload('old', '2026-06-10T00:00:00.000Z')],
        new: [payload('new', '2026-06-22T00:00:00.000Z')],
      },
    });
    const result = await useCase.execute(OWNER);
    expect(result.map((r) => r.room.id)).toEqual(['new', 'old', 'none']);
    expect(result[2].lastMessage).toBeNull();
  });

  it('캐시가 비면 DB로 폴백해 마지막 메시지를 만든다', async () => {
    const useCase = build({
      rooms: [room('r1', 't1')],
      dbByRoom: {
        r1: [
          Message.reconstitute({
            id: 'm-db',
            roomId: 'r1',
            senderId: OWNER,
            content: 'from-db',
            createdAt: new Date('2026-06-21T00:00:00.000Z'),
          }),
        ],
      },
    });
    const result = await useCase.execute(OWNER);
    expect(result[0].lastMessage?.messageId).toBe('m-db');
    expect(result[0].lastMessage?.content).toBe('from-db');
  });
});
