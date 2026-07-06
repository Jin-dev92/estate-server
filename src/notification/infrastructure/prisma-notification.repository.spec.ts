import { Prisma } from '@prisma/client';
import { PrismaNotificationRepository } from './prisma-notification.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { Notification } from '../domain/notification.entity';
import { NotificationType } from '../domain/notification-type.enum';
import { EntityType } from '../../events/event-type.enum';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

const newNotification = Notification.create({
  recipientId: 'u1',
  type: NotificationType.PostAdded,
  title: '새 게시글',
  body: '제목',
  entityType: EntityType.Post,
  entityId: 'p1',
  eventId: 'e1',
});

describe('PrismaNotificationRepository', () => {
  let prisma: {
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let repo: PrismaNotificationRepository;

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
    };
    repo = new PrismaNotificationRepository(prisma as unknown as PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('saveIfNew: 신규면 영속 엔티티(id·createdAt)를 반환한다', async () => {
    const created = new Date('2026-06-15T00:00:00.000Z');
    prisma.notification.create.mockResolvedValue({
      id: 'n1',
      recipientId: 'u1',
      type: 'PostAdded',
      title: '새 게시글',
      body: '제목',
      entityType: 'Post',
      entityId: 'p1',
      eventId: 'e1',
      readAt: null,
      createdAt: created,
    });

    const saved = await repo.saveIfNew(newNotification);

    expect(saved?.id).toBe('n1');
    expect(saved?.createdAt).toBe(created);
  });

  it('saveIfNew: 중복(P2002)이면 null', async () => {
    prisma.notification.create.mockRejectedValue(p2002());

    await expect(repo.saveIfNew(newNotification)).resolves.toBeNull();
  });

  it('saveIfNew: 그 외 에러는 다시 던진다', async () => {
    prisma.notification.create.mockRejectedValue(new Error('db down'));

    await expect(repo.saveIfNew(newNotification)).rejects.toThrow('db down');
  });

  it('markAllRead: 미읽음 행만 readAt 갱신', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });

    await repo.markAllRead('u1');

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { recipientId: 'u1', readAt: null },
      data: { readAt: expect.any(Date) as Date },
    });
  });

  it('countUnread: 미읽음 행 수를 집계한다', async () => {
    prisma.notification.count.mockResolvedValue(4);

    await expect(repo.countUnread('u1')).resolves.toBe(4);
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { recipientId: 'u1', readAt: null },
    });
  });
});
