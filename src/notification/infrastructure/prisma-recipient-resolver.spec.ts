import { PrismaRecipientResolver } from './prisma-recipient-resolver';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

describe('PrismaRecipientResolver', () => {
  let prisma: {
    chatRoom: { findUnique: jest.Mock };
    post: { findFirst: jest.Mock };
    building: { findUnique: jest.Mock };
    lease: { findMany: jest.Mock };
  };
  let resolver: PrismaRecipientResolver;

  beforeEach(() => {
    prisma = {
      chatRoom: { findUnique: jest.fn() },
      post: { findFirst: jest.fn() },
      building: { findUnique: jest.fn() },
      lease: { findMany: jest.fn() },
    };
    resolver = new PrismaRecipientResolver(prisma as unknown as PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('MessageSent: 방 참가자 중 발신자를 제외', async () => {
    prisma.chatRoom.findUnique.mockResolvedValue({
      ownerId: 'owner1',
      tenantId: 'tenant1',
    });
    const event: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.MessageSent,
      occurredAt: '2026-06-15T00:00:00.000Z',
      actorId: 'tenant1',
      entityType: EntityType.Message,
      entityId: 'r1',
      payload: {
        roomId: 'r1',
        messageId: 'm1',
        senderId: 'tenant1',
        content: 'hi',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    };

    await expect(resolver.resolve(event)).resolves.toEqual(['owner1']);
  });

  it('CommentCreated: 글 작성자에게, 단 본인 댓글이면 제외', async () => {
    prisma.post.findFirst.mockResolvedValue({ authorId: 'author1' });
    const base: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.CommentCreated,
      occurredAt: '2026-06-15T00:00:00.000Z',
      actorId: 'commenter1',
      entityType: EntityType.Comment,
      entityId: 'c1',
      payload: { postId: 'p1' },
    };

    await expect(resolver.resolve(base)).resolves.toEqual(['author1']);
    await expect(
      resolver.resolve({ ...base, actorId: 'author1' }),
    ).resolves.toEqual([]);
  });

  it('PostCreated: 건물주 + ACTIVE 입주자, 작성자 제외, 중복 제거', async () => {
    prisma.building.findUnique.mockResolvedValue({ ownerId: 'owner1' });
    prisma.lease.findMany.mockResolvedValue([
      { tenantId: 'tenantA' },
      { tenantId: 'tenantB' },
      { tenantId: 'owner1' },
    ]);
    const event: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.PostCreated,
      occurredAt: '2026-06-15T00:00:00.000Z',
      actorId: 'tenantA',
      entityType: EntityType.Post,
      entityId: 'p1',
      payload: { buildingId: 'b1', category: 'NOTICE', title: 't' },
    };

    const result = await resolver.resolve(event);

    expect(result.sort()).toEqual(['owner1', 'tenantB']);
  });

  it('LikeCreated: 글 작성자에게, 단 본인 좋아요면 제외', async () => {
    prisma.post.findFirst.mockResolvedValue({ authorId: 'author1' });
    const base: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.LikeCreated,
      occurredAt: '2026-07-03T00:00:00.000Z',
      actorId: 'liker1',
      entityType: EntityType.Post,
      entityId: 'p1',
      payload: { postId: 'p1', buildingId: 'b1' },
    };

    await expect(resolver.resolve(base)).resolves.toEqual(['author1']);
    await expect(
      resolver.resolve({ ...base, actorId: 'author1' }),
    ).resolves.toEqual([]);
  });

  it('대상이 없으면 빈 배열', async () => {
    prisma.chatRoom.findUnique.mockResolvedValue(null);
    const event: DomainEvent = {
      eventId: 'e1',
      eventType: EventType.MessageSent,
      occurredAt: '2026-06-15T00:00:00.000Z',
      actorId: 's1',
      entityType: EntityType.Message,
      entityId: 'r1',
      payload: {
        roomId: 'r1',
        messageId: 'm1',
        senderId: 's1',
        content: 'x',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    };

    await expect(resolver.resolve(event)).resolves.toEqual([]);
  });
});
