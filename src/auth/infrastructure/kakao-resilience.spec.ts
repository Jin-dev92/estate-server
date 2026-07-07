import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import {
  KakaoResilience,
  parseEnvNumber,
  validateResilienceConfig,
  ResilienceConfig,
} from './kakao-resilience';
import { KakaoApiError } from './kakao-api.error';

// 서킷 상태 콜백은 Sentry로 알림을 보낸다 — 코드베이스 관례대로 모듈 자동 모킹.
jest.mock('@sentry/nestjs');

const FALLBACK = 3000;

// 검증용 유효한 설정 팩토리(기본값과 동일). overrides로 특정 필드만 비튼다.
function validConfig(overrides?: Partial<ResilienceConfig>): ResilienceConfig {
  return {
    timeoutMs: 3000,
    retryMaxAttempts: 3,
    breakerThreshold: 5,
    breakerHalfOpenMs: 10_000,
    bulkheadConcurrent: 10,
    bulkheadQueue: 20,
    ...overrides,
  };
}

// env 미설정(기본값) ConfigService stub. overrides로 특정 키만 주입.
function stubConfig(overrides?: Record<string, string>): ConfigService {
  return {
    get: (key: string) => overrides?.[key],
  } as unknown as ConfigService;
}

describe('KakaoResilience', () => {
  it('tokenPolicy·profilePolicy를 노출하고 성공 결과를 그대로 반환한다', async () => {
    const r = new KakaoResilience(stubConfig());

    const result = await r.tokenPolicy.execute(() => Promise.resolve('ok'));

    expect(result).toBe('ok');
  });

  it('profilePolicy는 일시 오류(5xx) 후 성공하면 재시도로 복구한다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    const result = await r.profilePolicy.execute(() => {
      calls += 1;
      if (calls === 1)
        return Promise.reject(new KakaoApiError('프로필 조회', 500));
      return Promise.resolve('recovered');
    });

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('profilePolicy도 4xx는 재시도하지 않는다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    await expect(
      r.profilePolicy.execute(() => {
        calls += 1;
        return Promise.reject(new KakaoApiError('프로필 조회', 401));
      }),
    ).rejects.toThrow('카카오 프로필 조회 실패: 401');

    expect(calls).toBe(1);
  });

  it('tokenPolicy는 일시 오류(5xx)라도 재시도하지 않는다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    await expect(
      r.tokenPolicy.execute(() => {
        calls += 1;
        return Promise.reject(new KakaoApiError('토큰 교환', 500));
      }),
    ).rejects.toThrow('카카오 토큰 교환 실패: 500');

    expect(calls).toBe(1);
  });
});

describe('parseEnvNumber', () => {
  describe('유효한 숫자 문자열', () => {
    it('숫자로 변환한다', () => {
      expect(parseEnvNumber('5000', FALLBACK)).toBe(5000);
    });

    it('"0"은 정상값으로 보존한다(예: 벌크헤드 큐 0)', () => {
      expect(parseEnvNumber('0', FALLBACK)).toBe(0);
    });
  });

  describe('폴백 대상', () => {
    it('미설정(undefined)은 fallback', () => {
      expect(parseEnvNumber(undefined, FALLBACK)).toBe(FALLBACK);
    });

    it('빈 문자열은 fallback(Number("")=0 함정 방지)', () => {
      expect(parseEnvNumber('', FALLBACK)).toBe(FALLBACK);
    });

    it('공백 문자열은 fallback', () => {
      expect(parseEnvNumber('   ', FALLBACK)).toBe(FALLBACK);
    });

    it('비숫자 문자열("abc")은 fallback(NaN 전달 방지)', () => {
      expect(parseEnvNumber('abc', FALLBACK)).toBe(FALLBACK);
    });
  });
});

describe('validateResilienceConfig', () => {
  it('기본값은 경고 없이 통과한다(threshold 5 ≥ 재시도+1)', () => {
    expect(validateResilienceConfig('kakao', validConfig())).toEqual([]);
  });

  describe('breaker 임계 × 재시도 배수 자문(throw 아님, 경고)', () => {
    it('breakerThreshold < retryMaxAttempts+1 이면 경고를 반환한다', () => {
      const warnings = validateResilienceConfig(
        'kakao',
        validConfig({ breakerThreshold: 3, retryMaxAttempts: 3 }),
      );

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('breakerThreshold');
    });

    it('bulkheadQueue=0은 정상값이라 통과한다', () => {
      expect(() =>
        validateResilienceConfig('kakao', validConfig({ bulkheadQueue: 0 })),
      ).not.toThrow();
    });
  });

  describe('잘못된 값은 throw(기동 fail-fast)', () => {
    it('timeoutMs가 1 미만이면 throw', () => {
      expect(() =>
        validateResilienceConfig('kakao', validConfig({ timeoutMs: 0 })),
      ).toThrow();
    });

    it('breakerThreshold가 1 미만이면 throw', () => {
      expect(() =>
        validateResilienceConfig('kakao', validConfig({ breakerThreshold: 0 })),
      ).toThrow();
    });

    it('bulkheadConcurrent가 1 미만이면 throw', () => {
      expect(() =>
        validateResilienceConfig(
          'kakao',
          validConfig({ bulkheadConcurrent: 0 }),
        ),
      ).toThrow();
    });

    it('카운트성 필드에 소수가 오면 throw(retryMaxAttempts=2.5)', () => {
      expect(() =>
        validateResilienceConfig(
          'kakao',
          validConfig({ retryMaxAttempts: 2.5 }),
        ),
      ).toThrow();
    });
  });
});

describe('KakaoResilience 서킷 상태 콜백', () => {
  afterEach(() => jest.restoreAllMocks());

  it('위험한 설정 조합(임계 < 재시도+1)이면 생성 시 경고를 로깅+Sentry로 알린다', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    // 임계 2 < 재시도(기본 3)+1=4 → 자문 경고.
    new KakaoResilience(stubConfig({ KAKAO_BREAKER_THRESHOLD: '2' }));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('breakerThreshold'),
    );
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('breakerThreshold'),
      'warning',
    );
  });

  it('연속 실패로 회로가 열리면 onBreak가 로깅+Sentry로 알린다', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    // 임계 1 → 첫 실패에 open.
    const r = new KakaoResilience(stubConfig({ KAKAO_BREAKER_THRESHOLD: '1' }));

    await expect(
      r.tokenPolicy.execute(() =>
        Promise.reject(new KakaoApiError('토큰 교환', 500)),
      ),
    ).rejects.toThrow();

    // onBreak: 로깅(circuit OPEN 문구) + Sentry.captureMessage.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('circuit OPEN'));
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'kakao circuit OPEN',
      'warning',
    );
  });

  it('회로가 열린 뒤 half-open에서 성공하면 onReset가 복구를 로깅한다', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    // 임계 1·half-open 30ms.
    const r = new KakaoResilience(
      stubConfig({
        KAKAO_BREAKER_THRESHOLD: '1',
        KAKAO_BREAKER_HALF_OPEN_MS: '30',
      }),
    );

    // 1) 실패로 회로 open.
    await expect(
      r.tokenPolicy.execute(() =>
        Promise.reject(new KakaoApiError('토큰 교환', 500)),
      ),
    ).rejects.toThrow();
    // 2) half-open 시간 경과 대기(30ms + 여유).
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 3) 성공 실행 → half-open 탐침 성공 → onReset.
    await r.tokenPolicy.execute(() => Promise.resolve('ok'));

    expect(log).toHaveBeenCalledWith('카카오 circuit CLOSED — 복구');
  });
});
