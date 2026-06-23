import { Inject, Injectable } from '@nestjs/common';
import { ChatRoom } from '../domain/chat-room.entity';
import {
  CHAT_ROOM_REPOSITORY,
  ChatRoomRepository,
} from '../domain/chat-room.repository';
import { MESSAGE_CACHE, MessageCache } from '../domain/message-cache';
import {
  MESSAGE_REPOSITORY,
  MessageRepository,
} from '../domain/message.repository';
import { ChatMessagePayload } from '../domain/chat-message';

export interface RoomSummary {
  room: ChatRoom;
  lastMessage: ChatMessagePayload | null;
}

@Injectable()
export class ListRoomsUseCase {
  constructor(
    @Inject(CHAT_ROOM_REPOSITORY) private readonly rooms: ChatRoomRepository,
    @Inject(MESSAGE_CACHE) private readonly cache: MessageCache,
    @Inject(MESSAGE_REPOSITORY) private readonly messages: MessageRepository,
  ) {}

  // 본인이 참가자(owner 또는 tenant)인 방 목록 + 마지막 메시지(최근순).
  async execute(userId: string): Promise<RoomSummary[]> {
    const rooms = await this.rooms.findByParticipant(userId);
    const summaries = await Promise.all(
      rooms.map(async (room) => ({
        room,
        lastMessage: room.id != null ? await this.lastMessage(room.id) : null,
      })),
    );
    // 마지막 메시지 시각 내림차순(없는 방은 뒤로).
    return summaries.sort((a, b) => {
      const at = a.lastMessage?.createdAt ?? '';
      const bt = b.lastMessage?.createdAt ?? '';
      return bt.localeCompare(at);
    });
  }

  // 캐시 우선, 비었으면 DB 폴백(get-messages와 동일 전략).
  private async lastMessage(
    roomId: string,
  ): Promise<ChatMessagePayload | null> {
    const cached = await this.cache.getRecent(roomId, 1);
    if (cached.length > 0) return cached[0];
    const rows = await this.messages.findRecent(roomId, 1);
    if (rows.length === 0) return null;
    const m = rows[0];
    return {
      roomId: m.roomId,
      messageId: m.id,
      senderId: m.senderId,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
