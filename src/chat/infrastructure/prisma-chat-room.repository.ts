import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatRoom } from '../domain/chat-room.entity';
import { ChatRoomRepository } from '../domain/chat-room.repository';

@Injectable()
export class PrismaChatRoomRepository implements ChatRoomRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string;
    buildingId: string;
    ownerId: string;
    tenantId: string;
  }): ChatRoom {
    return ChatRoom.reconstitute({
      id: row.id,
      buildingId: row.buildingId,
      ownerId: row.ownerId,
      tenantId: row.tenantId,
    });
  }

  async save(room: ChatRoom): Promise<ChatRoom> {
    const row = await this.prisma.chatRoom.create({
      data: {
        buildingId: room.buildingId,
        ownerId: room.ownerId,
        tenantId: room.tenantId,
      },
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<ChatRoom | null> {
    const row = await this.prisma.chatRoom.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByBuildingAndTenant(
    buildingId: string,
    tenantId: string,
  ): Promise<ChatRoom | null> {
    const row = await this.prisma.chatRoom.findUnique({
      where: { buildingId_tenantId: { buildingId, tenantId } },
    });
    return row ? this.toDomain(row) : null;
  }

  async findByParticipant(userId: string): Promise<ChatRoom[]> {
    const rows = await this.prisma.chatRoom.findMany({
      where: { OR: [{ ownerId: userId }, { tenantId: userId }] },
    });
    return rows.map((r) => this.toDomain(r));
  }
}
