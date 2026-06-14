import { Inject, Injectable } from '@nestjs/common';
import { ChatRoom } from '../domain/chat-room.entity';
import {
  CHAT_ROOM_REPOSITORY,
  ChatRoomRepository,
} from '../domain/chat-room.repository';

@Injectable()
export class ListRoomsUseCase {
  constructor(
    @Inject(CHAT_ROOM_REPOSITORY) private readonly rooms: ChatRoomRepository,
  ) {}

  // 본인이 참가자(owner 또는 tenant)인 방 목록.
  execute(userId: string): Promise<ChatRoom[]> {
    return this.rooms.findByParticipant(userId);
  }
}
