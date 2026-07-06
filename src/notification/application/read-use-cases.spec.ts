import { ListNotificationsUseCase } from './list-notifications.use-case';
import { GetUnreadCountUseCase } from './get-unread-count.use-case';
import { MarkAllReadUseCase } from './mark-all-read.use-case';
import { NotificationRepository } from '../domain/notification.repository';
import { NotificationCounter } from '../domain/notification-counter';
import { Notification } from '../domain/notification.entity';
import { NotificationType } from '../domain/notification-type.enum';
import { EntityType } from '../../events/event-type.enum';

const sample = Notification.reconstitute({
  id: 'n1',
  recipientId: 'u1',
  type: NotificationType.PostAdded,
  title: '새 게시글',
  body: '제목',
  entityType: EntityType.Post,
  entityId: 'p1',
  eventId: 'e1',
  readAt: null,
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
});

describe('알림 읽기 유스케이스', () => {
  it('ListNotifications: repo.listForUser 결과를 반환', async () => {
    const calls: Array<[string, number]> = [];
    const repo: Partial<NotificationRepository> = {
      listForUser: (u, n) => {
        calls.push([u, n]);
        return Promise.resolve([sample]);
      },
    };
    const useCase = new ListNotificationsUseCase(
      repo as NotificationRepository,
    );

    const result = await useCase.execute('u1', 20);

    expect(result).toEqual([sample]);
    expect(calls).toEqual([['u1', 20]]);
  });

  it('GetUnreadCount: 캐시 적중이면 카운터 값을 그대로 반환(DB 미조회)', async () => {
    const counted: string[] = [];
    const counter: Partial<NotificationCounter> = {
      get: () => Promise.resolve(7),
    };
    const repo: Partial<NotificationRepository> = {
      countUnread: (u) => {
        counted.push(u);
        return Promise.resolve(0);
      },
    };
    const useCase = new GetUnreadCountUseCase(
      counter as NotificationCounter,
      repo as NotificationRepository,
    );

    await expect(useCase.execute('u1')).resolves.toBe(7);
    expect(counted).toEqual([]); // 캐시 적중 시 DB COUNT 안 함
  });

  it('GetUnreadCount: 캐시 미스(null)면 DB COUNT로 재집계 후 백필', async () => {
    const backfilled: Array<[string, number]> = [];
    const counter: Partial<NotificationCounter> = {
      get: () => Promise.resolve(null),
      backfill: (u, c) => {
        backfilled.push([u, c]);
        return Promise.resolve();
      },
    };
    const repo: Partial<NotificationRepository> = {
      countUnread: () => Promise.resolve(4),
    };
    const useCase = new GetUnreadCountUseCase(
      counter as NotificationCounter,
      repo as NotificationRepository,
    );

    await expect(useCase.execute('u1')).resolves.toBe(4);
    expect(backfilled).toEqual([['u1', 4]]);
  });

  it('MarkAllRead: 행 읽음 + 카운터 reset', async () => {
    const marked: string[] = [];
    const reset: string[] = [];
    const repo: Partial<NotificationRepository> = {
      markAllRead: (u) => {
        marked.push(u);
        return Promise.resolve();
      },
    };
    const counter: Partial<NotificationCounter> = {
      reset: (u) => {
        reset.push(u);
        return Promise.resolve();
      },
    };
    const useCase = new MarkAllReadUseCase(
      repo as NotificationRepository,
      counter as NotificationCounter,
    );

    await useCase.execute('u1');

    expect(marked).toEqual(['u1']);
    expect(reset).toEqual(['u1']);
  });
});
