import { Notification } from './notification.entity';

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

export interface NotificationRepository {
  // 멱등 저장: 신규면 영속화된 엔티티(id·createdAt 포함)를, 중복(P2002)이면 null을 반환한다.
  saveIfNew(notification: Notification): Promise<Notification | null>;
  listForUser(userId: string, limit: number): Promise<Notification[]>;
  // 수신자의 미읽음 알림을 모두 읽음 처리. 영향 행 수와 무관하게 멱등.
  markAllRead(userId: string): Promise<void>;
  // 수신자의 단건을 읽음 처리. unread→read로 실제 전이됐으면 true(멱등·소유자 검증).
  markOneRead(userId: string, id: string): Promise<boolean>;
  // 수신자의 미읽음 행 수(readAt IS NULL). 카운터 캐시 미스 시 재구축의 진실 원천.
  countUnread(userId: string): Promise<number>;
}
