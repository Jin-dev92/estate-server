import { buildContent } from './notification-content';
import { NotificationType } from './notification-type.enum';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

function event(partial: Partial<DomainEvent>): DomainEvent {
  return {
    eventId: 'e1',
    eventType: EventType.PostCreated,
    occurredAt: '2026-06-15T00:00:00.000Z',
    actorId: 'author1',
    entityType: EntityType.Post,
    entityId: 'p1',
    payload: {},
    ...partial,
  };
}

describe('buildContent', () => {
  it('PostCreated → PostAdded, body는 글 제목', () => {
    const c = buildContent(
      event({
        eventType: EventType.PostCreated,
        entityId: 'p1',
        payload: {
          buildingId: 'b1',
          category: 'NOTICE',
          title: '엘리베이터 점검',
        },
      }),
    );

    expect(c).toEqual({
      type: NotificationType.PostAdded,
      title: '새 게시글',
      body: '엘리베이터 점검',
      entityType: EntityType.Post,
      entityId: 'p1',
      buildingId: 'b1',
    });
  });

  it('CommentCreated → CommentAdded, entityId는 postId', () => {
    const c = buildContent(
      event({
        eventType: EventType.CommentCreated,
        entityType: EntityType.Comment,
        entityId: 'c1',
        payload: { postId: 'p9', buildingId: 'b9' },
      }),
    );

    expect(c).toMatchObject({
      type: NotificationType.CommentAdded,
      entityType: EntityType.Post,
      entityId: 'p9',
      buildingId: 'b9',
    });
  });

  it('MessageSent → MessageReceived, body는 본문 50자, entityId는 roomId', () => {
    const long = 'a'.repeat(80);
    const c = buildContent(
      event({
        eventType: EventType.MessageSent,
        entityType: EntityType.Message,
        entityId: 'r1',
        payload: {
          roomId: 'r1',
          messageId: 'm1',
          senderId: 's1',
          content: long,
          createdAt: '2026-06-15T00:00:00.000Z',
        },
      }),
    );

    expect(c?.type).toBe(NotificationType.MessageReceived);
    expect(c?.entityId).toBe('r1');
    expect(c?.body).toHaveLength(50);
    expect(c?.buildingId).toBeNull();
  });

  it('LikeCreated → PostLiked, entityId는 postId', () => {
    const c = buildContent(
      event({
        eventType: EventType.LikeCreated,
        entityType: EntityType.Post,
        entityId: 'p7',
        payload: { postId: 'p7', buildingId: 'b7' },
      }),
    );

    expect(c).toEqual({
      type: NotificationType.PostLiked,
      title: '새 좋아요',
      body: '회원님의 글에 좋아요가 눌렸습니다',
      entityType: EntityType.Post,
      entityId: 'p7',
      buildingId: 'b7',
    });
  });

  it('지원하지 않는 이벤트는 null', () => {
    expect(
      buildContent(event({ eventType: EventType.TenantJoined })),
    ).toBeNull();
  });
});
