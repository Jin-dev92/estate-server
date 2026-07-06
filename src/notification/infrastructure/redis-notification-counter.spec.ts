import { RedisNotificationCounter } from './redis-notification-counter';
import { RedisService } from '../../redis/redis.service';
import { UNREAD_COUNT_TTL_SEC } from '../domain/notification-counter';

const USER_ID = 'u1';
const KEY = `notif:unread:${USER_ID}`;

describe('RedisNotificationCounter', () => {
  let redis: {
    runScript: jest.Mock;
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };
  let counter: RedisNotificationCounter;

  beforeEach(() => {
    redis = {
      runScript: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };
    counter = new RedisNotificationCounter(redis as unknown as RedisService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('increment / decrement', () => {
    it('increment는 존재-시-증가 Lua를 사용자 키로 실행한다', async () => {
      await counter.increment(USER_ID);

      expect(redis.runScript).toHaveBeenCalledWith(
        expect.stringContaining('INCR'),
        [KEY],
      );
      const [lua] = redis.runScript.mock.calls[0] as [string];
      expect(lua).toContain('EXISTS'); // 미스 키엔 증가하지 않음
    });

    it('decrement는 0 하한 보정(KEEPTTL)을 포함한 존재-시-감소 Lua를 실행한다', async () => {
      await counter.decrement(USER_ID);

      const [lua, keys] = redis.runScript.mock.calls[0] as [string, string[]];
      expect(keys).toEqual([KEY]);
      expect(lua).toContain('DECR');
      expect(lua).toContain('v < 0');
      expect(lua).toContain('KEEPTTL'); // 0 보정 SET이 TTL을 날리지 않도록
    });
  });

  describe('get', () => {
    it('값이 있으면 숫자로 반환한다', async () => {
      redis.get.mockResolvedValue('5');

      await expect(counter.get(USER_ID)).resolves.toBe(5);
    });

    it('키가 없으면 null(미스 신호)을 반환한다', async () => {
      redis.get.mockResolvedValue(null);

      await expect(counter.get(USER_ID)).resolves.toBeNull();
    });
  });

  describe('backfill', () => {
    it('SET NX + TTL로 미스를 채운다', async () => {
      await counter.backfill(USER_ID, 3);

      expect(redis.set).toHaveBeenCalledWith(
        KEY,
        '3',
        'EX',
        UNREAD_COUNT_TTL_SEC,
        'NX',
      );
    });
  });

  describe('reset', () => {
    it('키를 DEL한다', async () => {
      redis.del.mockResolvedValue(1);

      await counter.reset(USER_ID);

      expect(redis.del).toHaveBeenCalledWith(KEY);
    });
  });
});
