import { RedisNotificationRelay } from './redis-notification-relay';
import { RedisService } from '../../redis/redis.service';
import { NotificationPushPayload } from '../domain/notification-relay';

const payload: NotificationPushPayload = {
  recipientId: 'u1',
  notification: {
    id: 'n1',
    type: 'PostAdded',
    title: '새 게시글',
    body: '제목',
    entityType: 'Post',
    entityId: 'p1',
    buildingId: 'b1',
    createdAt: '2026-06-15T00:00:00.000Z',
  },
};

describe('RedisNotificationRelay', () => {
  it('publish는 notifications 채널에 JSON을 발행한다', async () => {
    const redis = { publish: jest.fn() };
    const relay = new RedisNotificationRelay(redis as unknown as RedisService);

    await relay.publish(payload);

    expect(redis.publish).toHaveBeenCalledWith(
      'notifications',
      JSON.stringify(payload),
    );
  });

  it('subscribe는 전용 연결에서 수신 메시지를 파싱해 핸들러로 전달한다', async () => {
    const handlers: Record<string, (ch: string, raw: string) => void> = {};
    const sub = {
      subscribe: jest.fn(),
      on: jest.fn((evt: string, cb: (ch: string, raw: string) => void) => {
        handlers[evt] = cb;
      }),
    };
    const redis = { duplicate: jest.fn().mockReturnValue(sub) };
    const relay = new RedisNotificationRelay(redis as unknown as RedisService);

    const received: NotificationPushPayload[] = [];
    await relay.subscribe((p) => received.push(p));
    handlers['message']('notifications', JSON.stringify(payload));

    expect(sub.subscribe).toHaveBeenCalledWith('notifications');
    expect(received).toEqual([payload]);
  });
});
