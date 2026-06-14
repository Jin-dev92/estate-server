import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MessageRepository } from '../domain/message.repository';
import { ChatMessagePayload } from '../domain/chat-message';
import { Message } from '../domain/message.entity';

@Injectable()
export class PrismaMessageRepository implements MessageRepository {
  private readonly logger = new Logger(PrismaMessageRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async persist(payload: ChatMessagePayload): Promise<void> {
    try {
      await this.prisma.message.create({
        data: {
          id: payload.messageId,
          roomId: payload.roomId,
          senderId: payload.senderId,
          content: payload.content,
          createdAt: new Date(payload.createdAt),
        },
      });
    } catch (err) {
      // at-least-once 중복: 같은 messageId(P2002)는 이미 적재됨 → 무시. 그 외는 재시도 유도.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.warn(`중복 메시지 무시: ${payload.messageId}`);
        return;
      }
      throw err;
    }
  }

  async findRecent(roomId: string, limit: number): Promise<Message[]> {
    const rows = await this.prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) =>
      Message.reconstitute({ id: r.id, roomId: r.roomId, senderId: r.senderId, content: r.content, createdAt: r.createdAt }),
    );
  }
}
