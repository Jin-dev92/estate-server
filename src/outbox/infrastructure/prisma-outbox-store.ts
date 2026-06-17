import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainEvent } from '../../events/domain-event';
import { topicForEvent } from '../../events/event-type.enum';
import { OutboxStatus } from '../domain/outbox-status.enum';
import { OutboxRecord } from '../domain/outbox-record';
import { OutboxStore } from '../domain/outbox-store';
import { TransactionClient } from '../domain/transaction-runner';
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_CAP_MS,
} from '../application/outbox.tokens';
import { computeBackoff } from '../domain/backoff';

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
  constructor(
    @Inject(OUTBOX_MAX_ATTEMPTS) private readonly maxAttempts: number,
    @Inject(OUTBOX_BACKOFF_BASE_MS) private readonly baseMs: number,
    @Inject(OUTBOX_BACKOFF_CAP_MS) private readonly capMs: number,
  ) {}

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
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
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

  async markFailed(
    id: string,
    attempts: number,
    error: string,
    tx: TransactionClient,
  ): Promise<{ quarantined: boolean }> {
    const nextAttempts = attempts + 1;
    // 최대 도달 → FAILED로 격리(더는 폴링되지 않는다).
    if (nextAttempts >= this.maxAttempts) {
      await tx.outboxEvent.update({
        where: { id },
        data: {
          status: OutboxStatus.Failed,
          attempts: nextAttempts,
          lastError: error,
          failedAt: new Date(),
        },
      });
      return { quarantined: true };
    }
    // 아직 여유 → 지수 백오프 후 재시도(status는 PENDING 유지).
    const delayMs = computeBackoff(attempts, this.baseMs, this.capMs);
    await tx.outboxEvent.update({
      where: { id },
      data: {
        attempts: nextAttempts,
        lastError: error,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
    return { quarantined: false };
  }
}
