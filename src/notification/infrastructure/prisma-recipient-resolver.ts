import { Injectable } from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEvent } from '../../events/domain-event';
import { EventType } from '../../events/event-type.enum';
import { ChatMessagePayload } from '../../chat/domain/chat-message';
import { RecipientResolver } from '../domain/recipient-resolver';

@Injectable()
export class PrismaRecipientResolver implements RecipientResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(event: DomainEvent): Promise<string[]> {
    switch (event.eventType) {
      case EventType.MessageSent:
        return this.forMessage(event.payload as ChatMessagePayload);
      case EventType.CommentCreated:
        return this.forPostAuthor(
          event.payload as { postId: string },
          event.actorId,
        );
      case EventType.PostCreated:
        return this.forPost(
          event.payload as { buildingId: string },
          event.actorId,
        );
      case EventType.LikeCreated:
        return this.forPostAuthor(
          event.payload as { postId: string },
          event.actorId,
        );
      default:
        return [];
    }
  }

  // 방 참가자(owner·tenant) 중 발신자 제외.
  private async forMessage(payload: ChatMessagePayload): Promise<string[]> {
    const room = await this.prisma.chatRoom.findUnique({
      where: { id: payload.roomId },
      select: { ownerId: true, tenantId: true },
    });
    if (!room) return [];
    return [room.ownerId, room.tenantId].filter(
      (id) => id !== payload.senderId,
    );
  }

  // 글 작성자에게. 단 본인 행위(댓글·좋아요)면 제외. 삭제된 글은 무시.
  // CommentCreated·LikeCreated가 공유(작성자 반환 + 행위자 제외 로직 동일).
  private async forPostAuthor(
    payload: { postId: string },
    actorId: string | null,
  ): Promise<string[]> {
    const post = await this.prisma.post.findFirst({
      where: { id: payload.postId, deletedAt: null },
      select: { authorId: true },
    });
    if (!post) return [];
    return post.authorId === actorId ? [] : [post.authorId];
  }

  // 건물주 + ACTIVE 리스 입주자. 작성자 제외, 중복 제거.
  private async forPost(
    payload: { buildingId: string },
    actorId: string | null,
  ): Promise<string[]> {
    const building = await this.prisma.building.findUnique({
      where: { id: payload.buildingId },
      select: { ownerId: true },
    });
    if (!building) return [];
    const leases = await this.prisma.lease.findMany({
      where: {
        status: $Enums.LeaseStatus.ACTIVE,
        unit: { buildingId: payload.buildingId },
      },
      select: { tenantId: true },
    });
    const members = new Set<string>([
      building.ownerId,
      ...leases.map((l) => l.tenantId),
    ]);
    if (actorId) members.delete(actorId);
    return [...members];
  }
}
