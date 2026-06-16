import { RedisRateLimitStore } from './rate-limit.store';
import { RedisService } from '../../redis/redis.service';
import { FIXED_WINDOW_LUA } from './rate-limit.constants';

describe('RedisRateLimitStore', () => {
  it('hit는 고정윈도우 Lua를 key·windowSec로 실행하고 카운트를 반환한다', async () => {
    const redis = { runScript: jest.fn().mockResolvedValue(3) };
    const store = new RedisRateLimitStore(redis as unknown as RedisService);

    const count = await store.hit('ratelimit:ip:1.1.1.1:100', 60);

    expect(count).toBe(3);
    expect(redis.runScript).toHaveBeenCalledWith(
      FIXED_WINDOW_LUA,
      ['ratelimit:ip:1.1.1.1:100'],
      [60],
    );
  });
});
