import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainEvent } from '../../events/domain-event';
import { topicForEvent } from '../../events/event-type.enum';
import { OutboxStatus } from '../domain/outbox-status.enum';
import { OutboxRecord } from '../domain/outbox-record';
import { OutboxStore } from '../domain/outbox-store';
import { TransactionClient } from '../domain/transaction-runner';

// fetchPending이 raw 쿼리로 받는 행 형태.
interface OutboxRow {
  id: string;
  eventId: string;
  eventType: string;
  topic: string;
  partitionKey: string;
  payload: DomainEvent;
  attempts: number;
}

@Injectable()
export class PrismaOutboxStore implements OutboxStore {
  async add(event: DomainEvent, tx: TransactionClient): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        eventId: event.eventId,
        eventType: event.eventType,
        topic: topicForEvent(event.eventType),
        partitionKey: event.entityId,
        payload: event as unknown as Prisma.InputJsonValue,
        status: OutboxStatus.Pending,
      },
    });
  }

  // PENDING을 createdAt 순으로 limit개 잠그며 가져온다.
  // FOR UPDATE SKIP LOCKED: 다른 relay가 같은 행을 동시에 잡지 못한다(잠금은 tx 동안 유효).
  async fetchPending(
    limit: number,
    tx: TransactionClient,
  ): Promise<OutboxRecord[]> {
    const rows = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
      SELECT id, "eventId", "eventType", topic, "partitionKey", payload, attempts
      FROM "OutboxEvent"
      WHERE status = ${OutboxStatus.Pending}
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    return rows.map((r) => ({
      id: r.id,
      eventId: r.eventId,
      eventType: r.eventType,
      topic: r.topic,
      partitionKey: r.partitionKey,
      payload: r.payload,
      attempts: r.attempts,
    }));
  }

  async markPublished(id: string, tx: TransactionClient): Promise<void> {
    await tx.outboxEvent.update({
      where: { id },
      data: { status: OutboxStatus.Published, publishedAt: new Date() },
    });
  }

  async markFailed(id: string, tx: TransactionClient): Promise<void> {
    // status는 PENDING 유지 → 다음 폴링에 재시도. attempts만 증가(관측).
    await tx.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }
}
