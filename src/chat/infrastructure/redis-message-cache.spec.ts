import {
  RedisMessageCache,
  RECENT_LIMIT,
  RECENT_TTL_SEC,
} from './redis-message-cache';
import { RedisService } from '../../redis/redis.service';
import { ChatMessagePayload } from '../domain/chat-message';

const payload: ChatMessagePayload = {
  roomId: 'r1',
  messageId: 'm1',
  senderId: 'u1',
  content: '안녕',
  createdAt: '2026-06-14T00:00:00.000Z',
};

describe('RedisMessageCache', () => {
  let redis: {
    lpush: jest.Mock;
    ltrim: jest.Mock;
    expire: jest.Mock;
    lrange: jest.Mock;
  };
  let cache: RedisMessageCache;

  beforeEach(() => {
    redis = {
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      expire: jest.fn().mockResolvedValue(1),
      lrange: jest.fn(),
    };
    cache = new RedisMessageCache(redis as unknown as RedisService);
  });
  afterEach(() => jest.clearAllMocks());

  it('LPUSH·LTRIM으로 최근 N개만 유지하고 TTL을 건다', async () => {
    await cache.push(payload);

    const key = 'chat:room:r1:recent';
    expect(redis.lpush).toHaveBeenCalledWith(key, JSON.stringify(payload));
    expect(redis.ltrim).toHaveBeenCalledWith(key, 0, RECENT_LIMIT - 1);
    expect(redis.expire).toHaveBeenCalledWith(key, RECENT_TTL_SEC);
  });

  it('getRecent는 LRANGE 결과를 파싱해 반환한다', async () => {
    redis.lrange.mockResolvedValue([JSON.stringify(payload)]);

    const result = await cache.getRecent('r1', 10);

    expect(redis.lrange).toHaveBeenCalledWith('chat:room:r1:recent', 0, 9);
    expect(result[0]).toEqual(payload);
  });
});
