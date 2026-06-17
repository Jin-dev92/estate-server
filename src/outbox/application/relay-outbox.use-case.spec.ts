import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
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

jest.mock('@sentry/nestjs');

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
  const failed: Array<{ id: string; attempts: number; error: string }> = [];
  const store: OutboxStore = {
    add: () => Promise.resolve(),
    fetchPending: () => Promise.resolve(pending),
    markPublished: (id) => {
      published.push(id);
      return Promise.resolve();
    },
    markFailed: (id, attempts, error) => {
      failed.push({ id, attempts, error });
      return Promise.resolve({ quarantined: false });
    },
  };
  return { runner, store, published, failed };
}

describe('RelayOutboxUseCase', () => {
  afterEach(() => jest.clearAllMocks());

  it('PENDING을 emit하고 성공 시 markPublished한다', async () => {
    const { runner, store, published } = deps([record('1'), record('2')]);
    const emitted: DomainEvent[] = [];
    // relay는 publishOrThrow를 호출한다(실패 시 throw → markFailed로 분기되도록).
    const publisher: EventPublisher = {
      publish: () => Promise.resolve(),
      publishOrThrow: (e) => {
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
    // publishOrThrow: evt-1은 reject → relay가 catch해 markFailed, evt-2는 resolve → markPublished.
    const publisher: EventPublisher = {
      publish: () => Promise.resolve(),
      publishOrThrow: (e) =>
        e.eventId === 'evt-1'
          ? Promise.reject(new Error('kafka down'))
          : Promise.resolve(),
    };
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const useCase = new RelayOutboxUseCase(runner, store, publisher, BATCH);

    await useCase.execute();

    expect(failed).toEqual([{ id: '1', attempts: 0, error: 'kafka down' }]);
    expect(published).toEqual(['2']);
    // 격리(ERROR)와 대칭: 백오프 재시도 분기는 WARN 로그를 남긴다.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('markFailed가 격리(quarantined)면 ERROR 로그를 남긴다', async () => {
    const { runner, published } = deps([record('1')]);
    const store: OutboxStore = {
      add: () => Promise.resolve(),
      fetchPending: () => Promise.resolve([record('1')]),
      markPublished: () => Promise.resolve(),
      markFailed: () => Promise.resolve({ quarantined: true }),
    };
    const publisher: EventPublisher = {
      publish: () => Promise.resolve(),
      publishOrThrow: () => Promise.reject(new Error('permanent')),
    };
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const useCase = new RelayOutboxUseCase(runner, store, publisher, BATCH);

    await useCase.execute();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('FAILED 격리');
    errorSpy.mockRestore();
    expect(published).toEqual([]);
    // poison 격리는 Sentry로도 보낸다(일시 실패는 안 보냄).
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('PENDING이 없으면 아무것도 발행하지 않는다', async () => {
    const { runner, store, published, failed } = deps([]);
    const publisher: EventPublisher = {
      publish: () => Promise.resolve(),
      publishOrThrow: () => Promise.resolve(),
    };
    const useCase = new RelayOutboxUseCase(runner, store, publisher, BATCH);

    await useCase.execute();

    expect(published).toEqual([]);
    expect(failed).toEqual([]);
  });
});
