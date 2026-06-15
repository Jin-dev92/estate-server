import { Notification } from './notification.entity';
import { NotificationType } from './notification-type.enum';
import { EntityType } from '../../events/event-type.enum';

describe('Notification', () => {
  it('create는 readAt=null로 미읽음 상태를 만든다', () => {
    const n = Notification.create({
      recipientId: 'u1',
      type: NotificationType.PostAdded,
      title: '새 게시글',
      body: '공지 제목',
      entityType: EntityType.Post,
      entityId: 'p1',
      eventId: 'e1',
    });

    expect(n.recipientId).toBe('u1');
    expect(n.type).toBe(NotificationType.PostAdded);
    expect(n.readAt).toBeNull();
    expect(n.id).toBeUndefined();
  });

  it('reconstitute는 영속 상태(id·createdAt 포함)를 복원한다', () => {
    const created = new Date('2026-06-15T00:00:00.000Z');
    const n = Notification.reconstitute({
      id: 'n1',
      recipientId: 'u1',
      type: NotificationType.CommentAdded,
      title: '새 댓글',
      body: null,
      entityType: EntityType.Post,
      entityId: 'p1',
      eventId: 'e1',
      readAt: null,
      createdAt: created,
    });

    expect(n.id).toBe('n1');
    expect(n.createdAt).toBe(created);
    expect(n.body).toBeNull();
  });
});
