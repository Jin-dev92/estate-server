import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/redis/redis.service';

describe('RedisService.runScript (integration)', () => {
  let redis: RedisService;
  const key = `test:script:${Date.now()}`;

  beforeAll(() => {
    redis = new RedisService(
      new ConfigService({
        REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      }),
    );
  });

  afterAll(async () => {
    await redis.del(key);
    await redis.quit();
  });

  it('Lua 스크립트를 원자 실행한다 (INCR + 최초 1회만 EXPIRE)', async () => {
    const lua = `
      local n = redis.call('INCR', KEYS[1])
      if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      return n
    `;

    const first = await redis.runScript<number>(lua, [key], [60]);
    const second = await redis.runScript<number>(lua, [key], [60]);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });
});
