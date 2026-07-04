import { RedisLikeCounter } from './redis-like-counter';
import { RedisService } from '../../redis/redis.service';
import { LIKE_COUNT_TTL_SEC } from '../application/like-counter';

const POST_ID = 'p1';
const KEY = `board:like:count:${POST_ID}`;

// RedisService는 ioredis 상속 거대 타입이라 필요한 메서드만 mock한다.
function createMockRedis() {
  const pipeline = { set: jest.fn(), exec: jest.fn() };
  pipeline.set.mockReturnValue(pipeline);
  return {
    runScript: jest.fn(),
    mget: jest.fn(),
    pipeline: jest.fn(() => pipeline),
    _pipeline: pipeline,
  };
}

describe('RedisLikeCounter', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let counter: RedisLikeCounter;

  beforeEach(() => {
    redis = createMockRedis();
    counter = new RedisLikeCounter(redis as unknown as RedisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('increment / decrement', () => {
    it('increment는 존재-시-증감 Lua를 (+1, TTL) 인자로 실행한다', async () => {
      await counter.increment(POST_ID);

      expect(redis.runScript).toHaveBeenCalledWith(
        expect.stringContaining('EXISTS'),
        [KEY],
        [1, LIKE_COUNT_TTL_SEC],
      );
    });

    it('decrement는 같은 Lua를 (-1, TTL) 인자로 실행한다', async () => {
      await counter.decrement(POST_ID);

      expect(redis.runScript).toHaveBeenCalledWith(
        expect.stringContaining('EXISTS'),
        [KEY],
        [-1, LIKE_COUNT_TTL_SEC],
      );
    });

    it('증감 Lua는 음수 방지 하한(0) 보정을 포함한다', async () => {
      // 서버측 Lua라 단위테스트에선 실행 대신 스크립트에 하한 가드가 있는지 확인한다.
      await counter.decrement(POST_ID);

      const [lua] = redis.runScript.mock.calls[0] as [string];
      expect(lua).toContain('v < 0');
    });
  });

  describe('getMany', () => {
    it('빈 입력이면 쿼리 없이 빈 맵', async () => {
      const result = await counter.getMany([]);

      expect(redis.mget).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });

    it('MGET 결과를 숫자 맵으로 바꾸고 미스(null)는 제외한다', async () => {
      redis.mget.mockResolvedValue(['3', null]);

      const result = await counter.getMany(['p1', 'p2']);

      expect(redis.mget).toHaveBeenCalledWith([
        'board:like:count:p1',
        'board:like:count:p2',
      ]);
      expect(result.get('p1')).toBe(3);
      expect(result.has('p2')).toBe(false);
    });
  });

  describe('backfill', () => {
    it('빈 입력이면 파이프라인을 만들지 않는다', async () => {
      await counter.backfill(new Map());

      expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('각 항목을 SET NX + TTL로 일괄 기록한다', async () => {
      await counter.backfill(
        new Map([
          ['p1', 3],
          ['p2', 0],
        ]),
      );

      expect(redis._pipeline.set).toHaveBeenCalledWith(
        'board:like:count:p1',
        '3',
        'EX',
        LIKE_COUNT_TTL_SEC,
        'NX',
      );
      expect(redis._pipeline.set).toHaveBeenCalledWith(
        'board:like:count:p2',
        '0',
        'EX',
        LIKE_COUNT_TTL_SEC,
        'NX',
      );
      expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    });
  });
});
