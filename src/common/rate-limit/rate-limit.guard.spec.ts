import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitStore } from './rate-limit.store';
import {
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_SKIP,
  RateLimitOptions,
} from './rate-limit.constants';
import { ConfigKey } from '../../config/config-keys';

const SECRET = 'test-secret';

// 메타데이터(스킵/옵션)를 키로 돌려주는 Reflector 스텁.
function reflector(meta: {
  skip?: boolean;
  options?: RateLimitOptions;
}): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === RATE_LIMIT_SKIP) return meta.skip;
      if (key === RATE_LIMIT_OPTIONS) return meta.options;
      return undefined;
    }),
  } as unknown as Reflector;
}

// 환경변수(한도) + JWT 시크릿을 돌려주는 ConfigService 스텁.
function config(): ConfigService {
  const map: Record<string, string> = {
    [ConfigKey.JwtSecret]: SECRET,
    [ConfigKey.RateLimitWindowSec]: '60',
    [ConfigKey.RateLimitUserMax]: '60',
    [ConfigKey.RateLimitIpMax]: '120',
  };
  return {
    get: (k: string) => map[k],
    getOrThrow: (k: string) => map[k],
  } as unknown as ConfigService;
}

function context(
  method: string,
  headers: Record<string, string> = {},
  ip = '1.1.1.1',
): { ctx: ExecutionContext; setHeader: jest.Mock } {
  const setHeader = jest.fn();
  const req = { method, headers, ip };
  const res = { setHeader };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { ctx, setHeader };
}

function makeGuard(
  store: Partial<RateLimitStore>,
  meta: { skip?: boolean; options?: RateLimitOptions } = {},
) {
  const jwt = new JwtService({ secret: SECRET });
  return {
    guard: new RateLimitGuard(
      reflector(meta),
      config(),
      jwt,
      store as RateLimitStore,
    ),
    jwt,
  };
}

describe('RateLimitGuard', () => {
  it('GET(읽기)은 통과하고 store를 호출하지 않는다', async () => {
    const hit = jest.fn();
    const { guard } = makeGuard({ hit });
    const { ctx } = context('GET');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hit).not.toHaveBeenCalled();
  });

  it('@SkipRateLimit이면 쓰기여도 통과한다', async () => {
    const hit = jest.fn();
    const { guard } = makeGuard({ hit }, { skip: true });
    const { ctx } = context('POST');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hit).not.toHaveBeenCalled();
  });

  it('쓰기는 IP 카운트를 검사하고 한도 내면 통과한다(미인증=IP only)', async () => {
    const hit = jest.fn().mockResolvedValue(1);
    const { guard } = makeGuard({ hit });
    const { ctx } = context('POST');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hit).toHaveBeenCalledTimes(1);
    expect((hit.mock.calls[0] as [string, number])[0]).toContain(
      'ratelimit:ip:1.1.1.1:',
    );
  });

  it('IP 한도 초과면 429(RATE_LIMIT_EXCEEDED) + Retry-After 설정', async () => {
    const hit = jest.fn().mockResolvedValue(121); // ipMax 120 초과
    const { guard } = makeGuard({ hit });
    const { ctx, setHeader } = context('POST');

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    // Retry-After는 윈도우(60초) 잔여 초 → 1..60 사이의 양의 정수
    const retryAfter = Number((setHeader.mock.calls[0] as [string, string])[1]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('@RateLimit({ ipMax: 10 }) 오버라이드 — 11이면 초과', async () => {
    const hit = jest.fn().mockResolvedValue(11);
    const { guard } = makeGuard({ hit }, { options: { ipMax: 10 } });
    const { ctx } = context('POST');

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it('유효 토큰이면 user 키도 검사한다(IP+user 2회)', async () => {
    const hit = jest.fn().mockResolvedValue(1);
    const { guard, jwt } = makeGuard({ hit });
    const token = jwt.sign({ sub: 'u1' });
    const { ctx } = context('POST', { authorization: `Bearer ${token}` });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hit).toHaveBeenCalledTimes(2);
    const keys = (hit.mock.calls as [string, number][]).map((c) => c[0]);
    expect(keys.some((k) => k.includes('ratelimit:user:u1:'))).toBe(true);
    expect(keys.some((k) => k.includes('ratelimit:ip:'))).toBe(true);
  });

  it('무효 토큰이면 거부하지 않고 IP only로 진행한다', async () => {
    const hit = jest.fn().mockResolvedValue(1);
    const { guard } = makeGuard({ hit });
    const { ctx } = context('POST', { authorization: 'Bearer bad.token' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hit).toHaveBeenCalledTimes(1);
  });

  it('user 한도만 초과해도 429(이중 제한)', async () => {
    // 호출 순서: ip(통과) → user(초과). ip는 1, user는 61 반환.
    const hit = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(61);
    const { guard, jwt } = makeGuard({ hit });
    const token = jwt.sign({ sub: 'u1' });
    const { ctx } = context('POST', { authorization: `Bearer ${token}` });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it('store가 throw하면(예: Redis 장애) 예외가 전파된다(fail-closed)', async () => {
    const hit = jest.fn().mockRejectedValue(new Error('redis down'));
    const { guard } = makeGuard({ hit });
    const { ctx } = context('POST');

    await expect(guard.canActivate(ctx)).rejects.toThrow('redis down');
  });
});
