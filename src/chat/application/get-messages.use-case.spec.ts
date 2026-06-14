import { GetMessagesUseCase } from './get-messages.use-case';
import { ChatRoom } from '../domain/chat-room.entity';
import { ChatRoomRepository } from '../domain/chat-room.repository';
import { MessageRepository } from '../domain/message.repository';
import { MessageCache } from '../domain/message-cache';
import { Message } from '../domain/message.entity';
import { ChatMessagePayload } from '../domain/chat-message';

const ROOM = 'r1';
const OWNER = 'owner1';
const TENANT = 't1';
const LIMIT = 50;

const room = ChatRoom.reconstitute({
  id: ROOM,
  buildingId: 'b1',
  ownerId: OWNER,
  tenantId: TENANT,
});

function payload(id: string): ChatMessagePayload {
  return {
    roomId: ROOM,
    messageId: id,
    senderId: OWNER,
    content: id,
    createdAt: '2026-06-14T00:00:00.000Z',
  };
}

function deps(opts: { cached?: ChatMessagePayload[]; db?: Message[] }) {
  const rooms: Partial<ChatRoomRepository> = {
    findById: () => Promise.resolve(room),
  };
  const cache: Partial<MessageCache> = {
    getRecent: () => Promise.resolve(opts.cached ?? []),
  };
  const messages: Partial<MessageRepository> = {
    findRecent: () => Promise.resolve(opts.db ?? []),
  };
  return { rooms, cache, messages };
}

describe('GetMessagesUseCase', () => {
  it('캐시에 있으면 캐시를 반환한다(DB 안 침)', async () => {
    const { rooms, cache, messages } = deps({ cached: [payload('m1')] });
    const dbSpy = jest.fn();
    messages.findRecent = dbSpy;
    const useCase = new GetMessagesUseCase(
      rooms as ChatRoomRepository,
      cache as MessageCache,
      messages as MessageRepository,
    );

    const result = await useCase.execute({
      userId: OWNER,
      roomId: ROOM,
      limit: LIMIT,
    });

    expect(result).toHaveLength(1);
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('캐시가 비면 DB로 폴백한다', async () => {
    const { rooms, cache, messages } = deps({
      cached: [],
      db: [
        Message.reconstitute({
          id: 'm9',
          roomId: ROOM,
          senderId: OWNER,
          content: 'old',
          createdAt: new Date('2026-06-13T00:00:00.000Z'),
        }),
      ],
    });
    const useCase = new GetMessagesUseCase(
      rooms as ChatRoomRepository,
      cache as MessageCache,
      messages as MessageRepository,
    );

    const result = await useCase.execute({
      userId: OWNER,
      roomId: ROOM,
      limit: LIMIT,
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('m9');
  });

  it('참가자가 아니면 NOT_ROOM_PARTICIPANT', async () => {
    const { rooms, cache, messages } = deps({ cached: [] });
    const useCase = new GetMessagesUseCase(
      rooms as ChatRoomRepository,
      cache as MessageCache,
      messages as MessageRepository,
    );

    await expect(
      useCase.execute({ userId: 'stranger', roomId: ROOM, limit: LIMIT }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_ROOM_PARTICIPANT' });
  });
});
