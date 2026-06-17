import { PrismaOutboxStore } from './prisma-outbox-store';
import { TransactionClient } from '../domain/transaction-runner';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';
import { OutboxStatus } from '../domain/outbox-status.enum';

const event: DomainEvent = {
  eventId: 'e1',
  eventType: EventType.PostCreated,
  occurredAt: '2026-06-16T00:00:00.000Z',
  actorId: 'u1',
  entityType: EntityType.Post,
  entityId: 'p1',
  payload: { buildingId: 'b1' },
};

const MAX_ATTEMPTS = 5;
const BASE_MS = 1000;
const CAP_MS = 60000;

describe('PrismaOutboxStore', () => {
  it('add는 이벤트를 PENDING·topic 채워 tx로 INSERT한다', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { create } } as unknown as TransactionClient;
    const store = new PrismaOutboxStore(MAX_ATTEMPTS, BASE_MS, CAP_MS);

    await store.add(event, tx);

    expect(create).toHaveBeenCalledWith({
      data: {
        eventId: 'e1',
        eventType: EventType.PostCreated,
        topic: 'board-events',
        partitionKey: 'p1',
        payload: event,
        status: OutboxStatus.Pending,
      },
    });
  });

  it('markPublished는 PUBLISHED·publishedAt로 갱신한다', async () => {
    const update = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { update } } as unknown as TransactionClient;
    const store = new PrismaOutboxStore(MAX_ATTEMPTS, BASE_MS, CAP_MS);

    await store.markPublished('row1', tx);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'row1' },
      data: {
        status: OutboxStatus.Published,
        publishedAt: expect.any(Date) as Date,
      },
    });
  });

  it('markFailed는 최대 미만이면 백오프(nextAttemptAt) 후 PENDING 유지', async () => {
    const update = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { update } } as unknown as TransactionClient;
    const store = new PrismaOutboxStore(MAX_ATTEMPTS, BASE_MS, CAP_MS);

    const result = await store.markFailed('row1', 0, 'kafka down', tx);

    expect(result).toEqual({ quarantined: false });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'row1' },
      data: {
        attempts: 1,
        lastError: 'kafka down',
        nextAttemptAt: expect.any(Date) as Date,
      },
    });
  });

  it('markFailed는 최대 도달 시 FAILED로 격리한다', async () => {
    const update = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { update } } as unknown as TransactionClient;
    const store = new PrismaOutboxStore(MAX_ATTEMPTS, BASE_MS, CAP_MS);

    // attempts=4 → +1=5 == MAX_ATTEMPTS → 격리
    const result = await store.markFailed('row1', 4, 'permanent', tx);

    expect(result).toEqual({ quarantined: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'row1' },
      data: {
        status: OutboxStatus.Failed,
        attempts: 5,
        lastError: 'permanent',
        failedAt: expect.any(Date) as Date,
      },
    });
  });

  it('fetchPending는 SKIP LOCKED raw 쿼리로 행을 OutboxRecord로 매핑한다', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        id: 'row1',
        eventId: 'e1',
        eventType: 'PostCreated',
        topic: 'board-events',
        partitionKey: 'p1',
        payload: event,
        attempts: 0,
      },
    ]);
    const tx = { $queryRaw: queryRaw } as unknown as TransactionClient;
    const store = new PrismaOutboxStore(MAX_ATTEMPTS, BASE_MS, CAP_MS);

    const rows = await store.fetchPending(10, tx);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      {
        id: 'row1',
        eventId: 'e1',
        eventType: 'PostCreated',
        topic: 'board-events',
        partitionKey: 'p1',
        payload: event,
        attempts: 0,
      },
    ]);
  });
});
