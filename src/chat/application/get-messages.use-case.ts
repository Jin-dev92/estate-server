import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { ChatError } from '../chat.errors';
import { ChatMessagePayload } from '../domain/chat-message';
import {
  CHAT_ROOM_REPOSITORY,
  ChatRoomRepository,
} from '../domain/chat-room.repository';
import { MESSAGE_CACHE, MessageCache } from '../domain/message-cache';
import {
  MESSAGE_REPOSITORY,
  MessageRepository,
} from '../domain/message.repository';

export interface GetMessagesInput {
  userId: string;
  roomId: string;
  limit: number;
}

@Injectable()
export class GetMessagesUseCase {
  constructor(
    @Inject(CHAT_ROOM_REPOSITORY) private readonly rooms: ChatRoomRepository,
    @Inject(MESSAGE_CACHE) private readonly cache: MessageCache,
    @Inject(MESSAGE_REPOSITORY) private readonly messages: MessageRepository,
  ) {}

  async execute(input: GetMessagesInput): Promise<ChatMessagePayload[]> {
    const room = await this.rooms.findById(input.roomId);
    if (!room) throw new AppException(ChatError.ROOM_NOT_FOUND);
    if (!room.isParticipant(input.userId)) {
      throw new AppException(ChatError.NOT_ROOM_PARTICIPANT);
    }

    // 캐시 우선, 비었으면 DB 폴백(@@index[roomId, createdAt]).
    const cached = await this.cache.getRecent(input.roomId, input.limit);
    if (cached.length > 0) return cached;

    const rows = await this.messages.findRecent(input.roomId, input.limit);
    return rows.map((m) => ({
      roomId: m.roomId,
      messageId: m.id,
      senderId: m.senderId,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    }));
  }
}
