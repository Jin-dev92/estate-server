import { RelayOutboxUseCase } from './relay-outbox.use-case';
import { OutboxStore } from '../domain/outbox-store';
import {
  TransactionRunner,
  TransactionClient,
} from '../domain/transaction-runner';
import { OutboxRecord } from '../domain/outbox-record';
import { EventPublisher } from '../../events/event-publisher';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

const TX = {} as TransactionClient;

function record(id: string): OutboxRecord {
  const payload: DomainEvent = {
    eventId: `evt-${id}`,
    eventType: EventType.PostCreated,
    occurredAt: '2026-06-16T00:00:00.000Z',
    actorId: 'u1',
    entityType: EntityType.Post,
    entityId: 'p1',
    payload: {},
  };
  return {
    id,
    eventId: `evt-${id}`,
    eventType: 'PostCreated',
    topic: 'board-events',
    partitionKey: 'p1',
    payload,
    attempts: 0,
  };
}

const BATCH = 100;

function deps(pending: OutboxRecord[]) {
  const runner: TransactionRunner = {
    run: (fn) => fn(TX),
  };
  const published: string[] = [];
  const failed: string[] = [];
  const store: OutboxStore = {
    add: () => Promise.resolve(),
    fetchPending: () => Promise.resolve(pending),
    markPublished: (id) => {
      published.push(id);
      return Promise.resolve();
    },
    markFailed: (id) => {
      failed.push(id);
      return Promise.resolve();
    },
  };
  return { runner, store, published, failed };
}

describe('RelayOutboxUseCase', () => {
  it('PENDING을 emit하고 성공 시 markPublished한다', async () => {
    const { runner, store, published } = deps([record('1'), record('2')]);
    const emitted: DomainEvent[] = [];
    const publisher: EventPublisher = {
      publish: (e) => {
        emitted.push(e);
        return Promise.resolve();
      },
    };
    const useCase = new RelayOutboxUseCase(runner, store, publisher, BATCH);

    await useCase.execute();

    expect(emitted).toHaveLength(2);
    expect(published).toEqual(['1', '2']);
  });

  it('emit 실패 행은 markFailed(다음 폴링 재시도), 나머지는 계속 처리', async () => {
    const { runner, store, published, failed } = deps([
      record('1'),
      record('2'),
    ]);
    const publisher: EventPublisher = {
      publish: (e) =>
        e.eventId === 'evt-1'
          ? Promise.reject(new Error('kafka down'))
          : Promise.resolve(),
    };
    const useCase = new RelayOutboxUseCase(runner, store, publisher, BATCH);

    await useCase.execute();

    expect(failed).toEqual(['1']);
    expect(published).toEqual(['2']);
  });

  it('PENDING이 없으면 아무것도 발행하지 않는다', async () => {
    const { runner, store, published, failed } = deps([]);
    const publisher: EventPublisher = { publish: () => Promise.resolve() };
    const useCase = new RelayOutboxUseCase(runner, store, publisher, BATCH);

    await useCase.execute();

    expect(published).toEqual([]);
    expect(failed).toEqual([]);
  });
});
