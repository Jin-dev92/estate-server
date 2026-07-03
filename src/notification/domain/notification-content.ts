import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';
import { ChatMessagePayload } from '../../chat/domain/chat-message';
import { NotificationType } from './notification-type.enum';

// 알림에 저장·표시할 내용. entityType/entityId는 클라이언트 네비게이션 대상.
export interface NotificationContent {
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: EntityType;
  entityId: string;
  buildingId: string | null;
}

const BODY_MAX = 50;

// 이벤트 payload만으로 결정되는 순수 매핑(DB 접근 없음). 미지원 이벤트는 null.
export function buildContent(event: DomainEvent): NotificationContent | null {
  switch (event.eventType) {
    case EventType.MessageSent: {
      const p = event.payload as ChatMessagePayload;
      return {
        type: NotificationType.MessageReceived,
        title: '새 메시지',
        body: p.content.slice(0, BODY_MAX),
        entityType: EntityType.Message,
        entityId: p.roomId,
        buildingId: null,
      };
    }
    case EventType.CommentCreated: {
      const p = event.payload as { postId: string; buildingId: string | null };
      return {
        type: NotificationType.CommentAdded,
        title: '새 댓글',
        body: '회원님의 글에 새 댓글이 달렸습니다',
        entityType: EntityType.Post,
        entityId: p.postId,
        buildingId: p.buildingId,
      };
    }
    case EventType.LikeCreated: {
      const p = event.payload as { postId: string; buildingId: string | null };
      return {
        type: NotificationType.PostLiked,
        title: '새 좋아요',
        body: '회원님의 글에 좋아요가 눌렸습니다',
        entityType: EntityType.Post,
        entityId: p.postId,
        buildingId: p.buildingId,
      };
    }
    case EventType.PostCreated: {
      const p = event.payload as { title: string; buildingId: string | null };
      return {
        type: NotificationType.PostAdded,
        title: '새 게시글',
        body: p.title,
        entityType: EntityType.Post,
        entityId: event.entityId,
        buildingId: p.buildingId,
      };
    }
    default:
      return null;
  }
}
