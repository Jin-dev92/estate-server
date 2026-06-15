import { HandleEventUseCase } from './handle-event.use-case';
import { RecipientResolver } from '../domain/recipient-resolver';
import { NotificationRepository } from '../domain/notification.repository';
import { NotificationCounter } from '../domain/notification-counter';
import {
  NotificationRelay,
  NotificationPushPayload,
} from '../domain/notification-relay';
import { Notification } from '../domain/notification.entity';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

const POST_EVENT: DomainEvent = {
  eventId: 'e1',
  eventType: EventType.PostCreated,
  occurredAt: '2026-06-15T00:00:00.000Z',
  actorId: 'author1',
  entityType: EntityType.Post,
  entityId: 'p1',
  payload: { buildingId: 'b1', category: 'NOTICE', title: '공지' },
};

// saveIfNew가 입력 엔티티를 그대로 영속본처럼 반환하도록 흉내낸다(id 부여).
function persisted(n: Notification, id: string): Notification {
  return Notification.reconstitute({
    id,
    recipientId: n.recipientId,
    type: n.type,
    title: n.title,
    body: n.body,
    entityType: n.entityType,
    entityId: n.entityId,
    eventId: n.eventId,
    readAt: null,
    createdAt: new Date('2026-06-15T00:00:00.000Z'),
  });
}

function deps(recipients: string[]) {
  const resolver: RecipientResolver = {
    resolve: () => Promise.resolve(recipients),
  };
  const saved: Notification[] = [];
  const repo: NotificationRepository = {
    saveIfNew: (n) => {
      saved.push(n);
      return Promise.resolve(persisted(n, `n${saved.length}`));
    },
    listForUser: () => Promise.resolve([]),
    markAllRead: () => Promise.resolve(),
  };
  const incremented: string[] = [];
  const counter: NotificationCounter = {
    increment: (u) => {
      incremented.push(u);
      return Promise.resolve();
    },
    get: () => Promise.resolve(0),
    reset: () => Promise.resolve(),
  };
  const pushed: NotificationPushPayload[] = [];
  const relay: NotificationRelay = {
    publish: (p) => {
      pushed.push(p);
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve(),
  };
  return { resolver, repo, counter, relay, saved, incremented, pushed };
}

describe('HandleEventUseCase', () => {
  it('수신자별로 적재·INCR·push한다(팬아웃)', async () => {
    const { resolver, repo, counter, relay, saved, incremented, pushed } = deps(
      ['owner1', 'tenantB'],
    );
    const useCase = new HandleEventUseCase(resolver, repo, counter, relay);

    await useCase.execute(POST_EVENT);

    expect(saved.map((n) => n.recipientId)).toEqual(['owner1', 'tenantB']);
    expect(incremented).toEqual(['owner1', 'tenantB']);
    expect(pushed.map((p) => p.recipientId)).toEqual(['owner1', 'tenantB']);
    expect(pushed[0].notification.id).toBe('n1');
  });

  it('중복(saveIfNew=null)이면 INCR·push를 건너뛴다(멱등)', async () => {
    const { resolver, counter, relay, incremented, pushed } = deps(['owner1']);
    const repo: NotificationRepository = {
      saveIfNew: () => Promise.resolve(null),
      listForUser: () => Promise.resolve([]),
      markAllRead: () => Promise.resolve(),
    };
    const useCase = new HandleEventUseCase(resolver, repo, counter, relay);

    await useCase.execute(POST_EVENT);

    expect(incremented).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('지원하지 않는 이벤트는 아무 것도 하지 않는다', async () => {
    const { resolver, repo, counter, relay, saved } = deps(['owner1']);
    const useCase = new HandleEventUseCase(resolver, repo, counter, relay);

    await useCase.execute({ ...POST_EVENT, eventType: EventType.TenantJoined });

    expect(saved).toEqual([]);
  });

  it('수신자가 없으면 no-op', async () => {
    const { resolver, repo, counter, relay, saved } = deps([]);
    const useCase = new HandleEventUseCase(resolver, repo, counter, relay);

    await useCase.execute(POST_EVENT);

    expect(saved).toEqual([]);
  });

  it('푸시(relay.publish)가 실패해도 throw하지 않고 적재·INCR은 유지된다(best-effort)', async () => {
    const { resolver, repo, counter, incremented } = deps(['owner1']);
    const failingRelay: NotificationRelay = {
      publish: () => Promise.reject(new Error('redis down')),
      subscribe: () => Promise.resolve(),
    };
    const useCase = new HandleEventUseCase(
      resolver,
      repo,
      counter,
      failingRelay,
    );

    await expect(useCase.execute(POST_EVENT)).resolves.toBeUndefined();
    expect(incremented).toEqual(['owner1']);
  });
});
