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

describe('PrismaOutboxStore', () => {
  it('add는 이벤트를 PENDING·topic 채워 tx로 INSERT한다', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { create } } as unknown as TransactionClient;
    const store = new PrismaOutboxStore();

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
    const store = new PrismaOutboxStore();

    await store.markPublished('row1', tx);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'row1' },
      data: {
        status: OutboxStatus.Published,
        publishedAt: expect.any(Date) as Date,
      },
    });
  });

  it('markFailed는 attempts만 증가시킨다(status 유지)', async () => {
    const update = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { update } } as unknown as TransactionClient;
    const store = new PrismaOutboxStore();

    await store.markFailed('row1', tx);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'row1' },
      data: { attempts: { increment: 1 } },
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
    const store = new PrismaOutboxStore();

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
