import { ChatRoom } from './chat-room.entity';

export const CHAT_ROOM_REPOSITORY = Symbol('CHAT_ROOM_REPOSITORY');

export interface ChatRoomRepository {
  save(room: ChatRoom): Promise<ChatRoom>;
  findById(id: string): Promise<ChatRoom | null>;
  findByBuildingAndTenant(
    buildingId: string,
    tenantId: string,
  ): Promise<ChatRoom | null>;
  findByParticipant(userId: string): Promise<ChatRoom[]>;
}
