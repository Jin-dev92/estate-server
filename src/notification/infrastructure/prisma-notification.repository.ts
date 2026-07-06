import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EntityType } from '../../events/event-type.enum';
import { NotificationRepository } from '../domain/notification.repository';
import { Notification } from '../domain/notification.entity';
import { NotificationType } from '../domain/notification-type.enum';

type NotificationRow = {
  id: string;
  recipientId: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string;
  entityId: string;
  buildingId: string | null;
  eventId: string;
  readAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async saveIfNew(notification: Notification): Promise<Notification | null> {
    try {
      const row = await this.prisma.notification.create({
        data: {
          recipientId: notification.recipientId,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          entityType: notification.entityType,
          entityId: notification.entityId,
          buildingId: notification.buildingId,
          eventId: notification.eventId,
        },
      });
      return this.toEntity(row);
    } catch (err) {
      // at-least-once 중복: (eventId, recipientId) 유니크 위반(P2002) → 이미 처리됨.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return null;
      }
      throw err;
    }
  }

  async listForUser(userId: string, limit: number): Promise<Notification[]> {
    const rows = await this.prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.toEntity(r));
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markOneRead(userId: string, id: string): Promise<boolean> {
    const res = await this.prisma.notification.updateMany({
      where: { id, recipientId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return res.count === 1;
  }

  async countUnread(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientId: userId, readAt: null },
    });
  }

  private toEntity(row: NotificationRow): Notification {
    return Notification.reconstitute({
      id: row.id,
      recipientId: row.recipientId,
      type: row.type as NotificationType,
      title: row.title,
      body: row.body,
      entityType: row.entityType as EntityType,
      entityId: row.entityId,
      buildingId: row.buildingId,
      eventId: row.eventId,
      readAt: row.readAt,
      createdAt: row.createdAt,
    });
  }
}
