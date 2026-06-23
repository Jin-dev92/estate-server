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
    // TODO(perf): 방 수에 비례해 Redis/DB를 N회 호출한다. 방이 늘면
    // 단일 쿼리(서브쿼리/조인)로 마지막 메시지를 한 번에 가져오도록 최적화.
    // (스펙 §3 후속 항목)
    const summaries = await Promise.all(
      rooms.map(async (room) => {
        // findByParticipant는 영속화된 방만 반환하므로 id는 항상 존재한다.
        // null이면 리포지토리 계층의 버그 → 조용히 덮지 않고 즉시 드러낸다.
        if (room.id == null) {
          throw new Error(
            `참가자 방 목록에 id 없는 방이 포함됨: buildingId=${room.buildingId}`,
          );
        }
        return { room, lastMessage: await this.lastMessage(room.id) };
      }),
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
